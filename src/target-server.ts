import type { ProxyTarget } from './types';
import { startTargetSpan, endTargetSpan } from './telemetry';
import { logRequest, captureRequestBody, captureResponseBody, headersToRecord } from './request-log';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TargetServer {
    target: ProxyTarget;
    server: ReturnType<typeof Bun.serve>;
    activeRequests: number;
    isShuttingDown: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────────

const servers = new Map<string, TargetServer>();

// ─── Request Forwarding ─────────────────────────────────────────────────────

/**
 * Shared forwarding logic used by all target servers.
 * Handles: auth check, URL construction, body capture, telemetry, logging.
 */
async function handleTargetForward(
    req: Request,
    target: ProxyTarget,
    ts: TargetServer,
): Promise<Response> {
    const startTime = performance.now();
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();
    const url = new URL(req.url);

    // Auth check (per-target token)
    if (target.authToken) {
        const providedToken = req.headers.get('X-Forward-Token') || url.searchParams.get('token');
        if (providedToken !== target.authToken) {
            console.warn(`❌ [${target.name}] Unauthorized ${req.method} ${url.pathname} from ${req.headers.get('X-Forwarded-For') || 'unknown'}`);
            return jsonResponse(401, {
                error: 'Unauthorized',
                message: 'Valid X-Forward-Token header or ?token=xxx query parameter is required',
            });
        }
        url.searchParams.delete('token');
    }

    const pathWithQuery = url.pathname + url.search;

    // Construct target URL
    let targetUrl: string;
    if (target.forwardPath) {
        targetUrl = target.targetUrl + pathWithQuery;
    } else {
        targetUrl = target.targetUrl;
        if (!url.searchParams.has('original_url')) {
            const separator = target.targetUrl.includes('?') ? '&' : '?';
            targetUrl += `${separator}original_url=${encodeURIComponent(pathWithQuery)}`;
        }
    }

    // Prepare headers
    const forwardHeaders = new Headers();
    req.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'host') {
            forwardHeaders.set(key, value);
        }
    });
    forwardHeaders.delete('X-Forward-Token');
    forwardHeaders.set('X-Request-ID', requestId);
    if (!target.forwardPath) {
        forwardHeaders.set('X-Original-URL', pathWithQuery);
    }

    // Capture request body
    const reqCapture = await captureRequestBody(req);

    // Start telemetry span
    const otelSpan = startTargetSpan({
        method: req.method,
        path: pathWithQuery,
        targetUrl,
        requestId,
        targetName: target.name,
    });

    const forwardBody = reqCapture.body && req.method !== 'GET' && req.method !== 'HEAD'
        ? reqCapture.body : undefined;

    let targetResponse: Response;

    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip') || 'unknown';

    try {
        targetResponse = await fetch(targetUrl, {
            method: req.method,
            headers: forwardHeaders,
            body: forwardBody,
        });
    } catch (fetchError) {
        const durationMs = performance.now() - startTime;
        console.error(`❌ [${target.name}] Failed to connect (${durationMs.toFixed(2)}ms):`, fetchError);

        endTargetSpan(otelSpan, 502, durationMs,
            fetchError instanceof Error ? fetchError : new Error(String(fetchError)),
            target.name);

        logRequest({
            requestId,
            type: 'target',
            targetName: target.name,
            method: req.method,
            path: pathWithQuery,
            targetUrl,
            clientIp,
            reqHeaders: headersToRecord(forwardHeaders),
            reqBody: reqCapture.body,
            reqBodySize: reqCapture.size,
            resStatus: 502,
            resStatusText: 'Bad Gateway',
            durationMs,
            error: fetchError instanceof Error ? fetchError.message : String(fetchError),
        });

        return jsonResponse(502, {
            error: 'Failed to connect to target server',
            message: fetchError instanceof Error ? fetchError.message : 'Unknown error',
            target: targetUrl,
        });
    }

    // Capture response
    const resCapture = await captureResponseBody(targetResponse);
    const responseHeaders = new Headers();
    for (const [key, value] of (targetResponse.headers as any)) {
        const lower = key.toLowerCase();
        if (lower === 'content-encoding' || lower === 'content-length') continue;
        if (lower === 'set-cookie') {
            const rewritten = value
                .replace(/;\s*domain=[^;]*/gi, '')
                .replace(/;\s*samesite=none/gi, '; SameSite=Lax');
            responseHeaders.append('set-cookie', rewritten);
            continue;
        }
        responseHeaders.set(key, value);
    }
    responseHeaders.set('Connection', 'close');
    responseHeaders.set('X-Request-ID', requestId);

    const durationMs = performance.now() - startTime;
    const statusEmoji = targetResponse.status < 400 ? '✅' : '⚠️';
    console.log(
        `${statusEmoji} [${target.name}] ${req.method} ${pathWithQuery} → ${targetResponse.status} ${targetResponse.statusText} (${durationMs.toFixed(2)}ms)`
    );

    endTargetSpan(otelSpan, targetResponse.status, durationMs, undefined, target.name);

    logRequest({
        requestId,
        type: 'target',
        targetName: target.name,
        method: req.method,
        path: pathWithQuery,
        targetUrl,
        clientIp,
        reqHeaders: headersToRecord(forwardHeaders),
        reqBody: reqCapture.body,
        reqBodySize: reqCapture.size,
        resStatus: targetResponse.status,
        resStatusText: targetResponse.statusText,
        resHeaders: headersToRecord(responseHeaders),
        resBody: resCapture.body,
        resBodySize: resCapture.size,
        durationMs,
    });

    return new Response(targetResponse.body, {
        status: targetResponse.status,
        statusText: targetResponse.statusText,
        headers: responseHeaders,
    });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ─── Server Lifecycle ───────────────────────────────────────────────────────

/**
 * Start a Bun.serve() instance for a named target.
 */
export function startTarget(target: ProxyTarget): TargetServer {
    const ts: TargetServer = {
        target,
        server: null!,
        activeRequests: 0,
        isShuttingDown: false,
    };

    const server = Bun.serve({
        port: target.port, // 0 = OS auto-assigns a free port
        idleTimeout: 255,

        async fetch(req: Request): Promise<Response> {
            if (ts.isShuttingDown) {
                return jsonResponse(503, { error: 'Service Unavailable', message: 'Server is shutting down' });
            }

            ts.activeRequests++;
            try {
                return await handleTargetForward(req, target, ts);
            } catch (error) {
                console.error(`❌ [${target.name}] Error:`, error);
                return jsonResponse(500, {
                    error: 'Internal Server Error',
                    message: error instanceof Error ? error.message : 'Unknown error',
                });
            } finally {
                ts.activeRequests--;
            }
        },

        error(error) {
            console.error(`[${target.name}] Server error:`, error);
            return jsonResponse(500, { error: 'Internal Server Error', message: 'An unexpected error occurred' });
        },
    });

    ts.server = server;
    servers.set(target.name, ts);

    console.log(`🎯 Target "${target.name}" on :${server.port} → ${target.targetUrl}`);

    return ts;
}

/**
 * Stop a specific target server gracefully.
 */
export async function stopTarget(name: string): Promise<void> {
    const ts = servers.get(name);
    if (!ts) return;

    ts.isShuttingDown = true;

    // Wait for active requests (max 10s)
    const maxWait = 10_000;
    const start = Date.now();
    while (ts.activeRequests > 0 && Date.now() - start < maxWait) {
        await Bun.sleep(200);
    }

    ts.server.stop();
    servers.delete(name);
    console.log(`🛑 Target "${name}" stopped`);
}

/**
 * Stop all target servers gracefully.
 */
export async function stopAllTargets(): Promise<void> {
    const names = Array.from(servers.keys());
    await Promise.all(names.map(name => stopTarget(name)));
}

/**
 * Restart a target with new config.
 */
export async function restartTarget(target: ProxyTarget): Promise<TargetServer> {
    await stopTarget(target.name);
    return startTarget(target);
}

/**
 * Get all running target servers (for status display).
 */
export function getTargetServers(): Map<string, TargetServer> {
    return servers;
}

/**
 * Get status info for all targets.
 */
export function getTargetStatus(): { name: string; port: number; targetUrl: string; active: number; running: boolean; hasAuth: boolean; forwardPath: boolean }[] {
    return Array.from(servers.values()).map(ts => ({
        name: ts.target.name,
        port: ts.server.port ?? ts.target.port,       // actual OS-assigned port
        targetUrl: ts.target.targetUrl,
        active: ts.activeRequests,
        running: !ts.isShuttingDown,
        hasAuth: !!ts.target.authToken,
        forwardPath: ts.target.forwardPath,
    }));
}
