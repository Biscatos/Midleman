import type { WebhookDistributor } from '../core/types';
import { logRequest, headersToRecord } from '../telemetry/request-log';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookServer {
    webhook: WebhookDistributor;
    server: ReturnType<typeof Bun.serve>;
    activeRequests: number;
    isShuttingDown: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────────

const servers = new Map<string, WebhookServer>();

// ─── Request Fan-out Logic ──────────────────────────────────────────────────

async function handleWebhookFanout(
    req: Request,
    webhook: WebhookDistributor,
    ws: WebhookServer,
): Promise<Response> {
    const startTime = performance.now();
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();
    const url = new URL(req.url);

    // Meta (Facebook) Webhook Verification Handshake
    if (req.method === 'GET' && url.searchParams.get('hub.mode') === 'subscribe') {
        const verifyToken = url.searchParams.get('hub.verify_token');
        if (webhook.authToken && verifyToken !== webhook.authToken) {
             console.warn(`❌ [webhook:${webhook.name}] Meta Verification failed: Invalid hub.verify_token`);
             return new Response('Invalid verify_token', { status: 403 });
        }
        const challenge = url.searchParams.get('hub.challenge');
        console.log(`✅ [webhook:${webhook.name}] Answered Meta Webhook Verification challenge`);
        return new Response(challenge || '', { status: 200 });
    }

    // Auth check (per-webhook token)
    if (webhook.authToken) {
        const providedToken = req.headers.get('X-Forward-Token') || url.searchParams.get('token') || url.searchParams.get('hub.verify_token');
        if (providedToken !== webhook.authToken) {
            console.warn(`❌ [webhook:${webhook.name}] Unauthorized ${req.method} from ${req.headers.get('X-Forwarded-For') || 'unknown'}`);
            return jsonResponse(401, {
                error: 'Unauthorized',
                message: 'Valid X-Forward-Token header or ?token=xxx query parameter is required',
            });
        }
    }

    // Read the body fully into memory once, so we can dispatch it N times
    // (We only support methods that can carry bodies, but fetch allows body for POST/PUT/PATCH/DELETE)
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let bodyBuffer: ArrayBuffer | undefined = undefined;
    let bodyStringPreview: string | null = null;
    
    if (hasBody) {
        try {
            bodyBuffer = await req.arrayBuffer();
            // Store a text preview for the logs (up to 64KB, which is safe to decode)
            if (bodyBuffer.byteLength < 64 * 1024) {
                const decoder = new TextDecoder('utf-8');
                bodyStringPreview = decoder.decode(bodyBuffer);
            } else {
                bodyStringPreview = `[large body: ${bodyBuffer.byteLength} bytes]`;
            }
        } catch (err) {
            console.error(`❌ [webhook:${webhook.name}] Failed to read request body:`, err);
            return jsonResponse(400, { error: 'Bad Request', message: 'Failed to read request body' });
        }
    }

    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';

    // Prepare headers (strip Midleman auth, set request ID)
    const forwardHeaders = new Headers();
    req.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'host') {
            forwardHeaders.set(key, value);
        }
    });
    forwardHeaders.delete('X-Forward-Token');
    forwardHeaders.set('X-Request-ID', requestId);

    // Attempt to parse incoming JSON for interpolations
    let payloadObj: any = null;
    if (bodyStringPreview && (req.headers.get('content-type')?.includes('application/json'))) {
        try { payloadObj = JSON.parse(bodyStringPreview); } catch {}
    }

    function renderTemplate(template: string, data: any): string {
        if (!data) return template;
        return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, path) => {
            let val = data;
            for (const k of path.split('.')) {
                if (val === undefined || val === null) break;
                val = val[k];
            }
            if (val === undefined || val === null) return '';
            return typeof val === 'object' ? JSON.stringify(val) : String(val);
        });
    }

    // Fire-and-forget background execution
    Promise.allSettled(webhook.targets.map(async (target) => {
        const fetchStart = performance.now();
        
        let tUrl: string;
        let tMethod = req.method;
        let tHeaders = new Headers(forwardHeaders);
        let tBody: ArrayBuffer | string | undefined = bodyBuffer;
        let tBodySize = bodyBuffer?.byteLength || 0;
        let tBodyStringPreview = bodyStringPreview;

        if (typeof target === 'string') {
            tUrl = target;
        } else {
            tUrl = renderTemplate(target.url, payloadObj);
            
            if (!target.forwardHeaders) {
                tHeaders = new Headers();
            }

            if (target.method) tMethod = target.method;
            if (target.customHeaders) {
                for (const [k, v] of Object.entries(target.customHeaders)) {
                    // Only render templates if it's dynamic
                    tHeaders.set(k, renderTemplate(v, payloadObj));
                }
            }
            if (target.bodyTemplate) {
                tBody = renderTemplate(target.bodyTemplate, payloadObj);
                tBodyStringPreview = tBody;
                tBodySize = new TextEncoder().encode(tBody).byteLength;
                tHeaders.set('content-type', 'application/json');
            }
        }

        try {
            const res = await fetch(tUrl, {
                method: tMethod,
                headers: tHeaders,
                body: tBody,
            });

            const fetchDuration = performance.now() - fetchStart;
            const resText = await res.text().catch(() => null);

            logRequest({
                requestId,
                type: 'webhook-fanout',
                targetName: webhook.name,
                method: tMethod,
                path: url.pathname + url.search,
                targetUrl: tUrl,
                clientIp,
                reqHeaders: headersToRecord(tHeaders),
                reqBody: tBodyStringPreview,
                reqBodySize: tBodySize,
                resStatus: res.status,
                resStatusText: res.statusText,
                resHeaders: headersToRecord(res.headers as unknown as Headers),
                resBody: resText,
                resBodySize: resText?.length || 0,
                durationMs: fetchDuration,
            });

        } catch (err) {
            const fetchDuration = performance.now() - fetchStart;
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`❌ [webhook:${webhook.name}] Action to ${tUrl} failed:`, errorMsg);
            
            logRequest({
                requestId,
                type: 'webhook-fanout',
                targetName: webhook.name,
                method: tMethod,
                path: url.pathname + url.search,
                targetUrl: tUrl,
                clientIp,
                reqHeaders: headersToRecord(tHeaders),
                reqBody: tBodyStringPreview,
                reqBodySize: tBodySize,
                resStatus: 502,
                resStatusText: 'Bad Gateway',
                durationMs: fetchDuration,
                error: errorMsg,
            });
        }
    }));

    // Return immediate 202 Accepted to the caller
    const processingMs = performance.now() - startTime;
    console.log(`📡 [webhook:${webhook.name}] 202 Accepted fan-out to ${webhook.targets.length} targets (${processingMs.toFixed(2)}ms) - ${requestId}`);

    const resJson = {
        status: 'Accepted',
        message: 'Webhook payload accepted and is being fanned out.',
        targetsCount: webhook.targets.length,
        requestId,
    };

    const resPayload = JSON.stringify(resJson);

    logRequest({
        requestId,
        type: 'webhook',
        targetName: webhook.name,
        method: req.method,
        path: url.pathname + url.search,
        targetUrl: 'self',
        clientIp,
        reqHeaders: headersToRecord(req.headers),
        reqBody: bodyStringPreview,
        reqBodySize: bodyBuffer?.byteLength || 0,
        resStatus: 202,
        resStatusText: 'Accepted',
        resHeaders: { 'Content-Type': 'application/json' },
        resBody: resPayload,
        resBodySize: resPayload.length,
        durationMs: processingMs,
    });

    return new Response(resPayload, {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
    });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ─── Server Lifecycle ───────────────────────────────────────────────────────

export function startWebhookServer(webhook: WebhookDistributor): WebhookServer {
    const ws: WebhookServer = {
        webhook,
        server: null!,
        activeRequests: 0,
        isShuttingDown: false,
    };

    const server = Bun.serve({
        port: webhook.port, // 0 = OS auto-assigns
        idleTimeout: 255,

        async fetch(req: Request): Promise<Response> {
            if (ws.isShuttingDown) {
                return jsonResponse(503, { error: 'Service Unavailable', message: 'Server is shutting down' });
            }

            ws.activeRequests++;
            try {
                return await handleWebhookFanout(req, webhook, ws);
            } catch (error) {
                console.error(`❌ [webhook:${webhook.name}] Error:`, error);
                return jsonResponse(500, {
                    error: 'Internal Server Error',
                    message: error instanceof Error ? error.message : 'Unknown error',
                });
            } finally {
                ws.activeRequests--;
            }
        },

        error(error) {
            console.error(`[webhook:${webhook.name}] Server error:`, error);
            return jsonResponse(500, { error: 'Internal Server Error', message: 'An unexpected error occurred' });
        },
    });

    ws.server = server;
    servers.set(webhook.name, ws);

    console.log(`📡 Webhook "${webhook.name}" on :${server.port} fanning out to ${webhook.targets.length} targets`);

    return ws;
}

export async function stopWebhookServer(name: string, graceful: boolean = true): Promise<void> {
    const ws = servers.get(name);
    if (!ws) return;

    ws.isShuttingDown = true;

    if (graceful) {
        // Wait for active bounds
        const maxWait = 5000;
        const start = Date.now();
        while (ws.activeRequests > 0 && Date.now() - start < maxWait) {
            await Bun.sleep(200);
        }
    }

    ws.server.stop();
    servers.delete(name);
    console.log(`🛑 Webhook "${name}" stopped${graceful ? ' gracefully' : ' immediately'}`);
}

export async function stopAllWebhooks(): Promise<void> {
    const names = Array.from(servers.keys());
    await Promise.all(names.map(name => stopWebhookServer(name)));
}

export async function restartWebhook(webhook: WebhookDistributor): Promise<WebhookServer> {
    // For restart, we stop immediately to minimize downtime on the port
    await stopWebhookServer(webhook.name, false);
    return startWebhookServer(webhook);
}

export function getWebhookServers(): Map<string, WebhookServer> {
    return servers;
}

export function getWebhookStatus(): { name: string; port: number; targets: any[]; active: number; running: boolean; hasAuth: boolean }[] {
    return Array.from(servers.values()).map(ws => ({
        name: ws.webhook.name,
        port: ws.server.port ?? ws.webhook.port,
        targets: ws.webhook.targets,
        active: ws.activeRequests,
        running: !ws.isShuttingDown,
        hasAuth: !!ws.webhook.authToken,
    }));
}
