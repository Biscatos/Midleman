import type { WebhookDistributor, WebhookRetryConfig } from '../core/types';
import { logRequest, headersToRecord } from '../telemetry/request-log';
import { isIpAllowed } from '../core/ip-filter';
import { loadPersistedDlq, persistDlq, type StoredFailedFanout } from '../core/store';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookServer {
    webhook: WebhookDistributor;
    server: ReturnType<typeof Bun.serve>;
    activeRequests: number;
    isShuttingDown: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────────

const servers = new Map<string, WebhookServer>();

// ─── Dead Letter Queue ──────────────────────────────────────────────────────

const DLQ_MAX_SIZE = 500;

export interface FailedFanout {
    id: string;
    webhookName: string;
    requestId: string;
    targetUrl: string;
    method: string;
    headers: Record<string, string>;
    body: ArrayBuffer | string | null;
    bodyPreview: string | null;
    bodySize: number;
    path: string;
    clientIp: string;
    retryConfig: import('../core/types').WebhookRetryConfig | undefined;
    lastError: string;
    totalAttempts: number;
    failedAt: number; // Unix ms
    retrying: boolean;
}

// ─── DLQ helpers ────────────────────────────────────────────────────────────

function serializeDlqEntry(e: FailedFanout): StoredFailedFanout {
    let body: string | null = null;
    let bodyEncoding: StoredFailedFanout['bodyEncoding'] = 'none';
    if (e.body instanceof ArrayBuffer) {
        body = Buffer.from(e.body).toString('base64');
        bodyEncoding = 'base64';
    } else if (typeof e.body === 'string') {
        body = e.body;
        bodyEncoding = 'text';
    }
    const { retrying: _r, ...rest } = e;
    return { ...rest, body, bodyEncoding };
}

function deserializeDlqEntry(s: StoredFailedFanout): FailedFanout {
    let body: ArrayBuffer | string | null = null;
    if (s.bodyEncoding === 'base64' && s.body !== null) {
        body = Buffer.from(s.body, 'base64').buffer as ArrayBuffer;
    } else if (s.bodyEncoding === 'text') {
        body = s.body;
    }
    return { ...s, body, retryConfig: s.retryConfig as WebhookRetryConfig | undefined, retrying: false };
}

// Load from disk on startup
const deadLetterQueue: FailedFanout[] = loadPersistedDlq().map(deserializeDlqEntry);

// Immediate synchronous flush (used for new failures and shutdown)
export function flushDlqSync(): void {
    if (_dlqFlushTimer) { clearTimeout(_dlqFlushTimer); _dlqFlushTimer = null; }
    persistDlq(deadLetterQueue.map(serializeDlqEntry));
}

// Debounced flush — for non-critical updates (dismiss, retry metadata)
let _dlqFlushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDlqFlush(): void {
    if (_dlqFlushTimer) clearTimeout(_dlqFlushTimer);
    _dlqFlushTimer = setTimeout(() => {
        persistDlq(deadLetterQueue.map(serializeDlqEntry));
        _dlqFlushTimer = null;
    }, 500);
}

export function getDeadLetterQueue(): FailedFanout[] {
    return deadLetterQueue;
}

export function dismissFailedFanout(id: string): boolean {
    const idx = deadLetterQueue.findIndex(e => e.id === id);
    if (idx === -1) return false;
    deadLetterQueue.splice(idx, 1);
    scheduleDlqFlush();
    return true;
}

export async function retryFailedFanout(id: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    const entry = deadLetterQueue.find(e => e.id === id);
    if (!entry) return { ok: false, error: 'Not found' };
    if (entry.retrying) return { ok: false, error: 'Already retrying' };

    entry.retrying = true;
    try {
        const headers = new Headers(entry.headers);
        const body = entry.body ?? undefined;
        const { res } = await fetchWithRetry(
            entry.targetUrl,
            { method: entry.method, headers, body },
            entry.retryConfig,
            `DLQ:${entry.webhookName} → ${entry.targetUrl}`,
        );

        if (res.status >= 200 && res.status < 300) {
            dismissFailedFanout(id);
            console.log(`✅ [DLQ] Delivered ${entry.targetUrl} (${res.status}) — removed from queue`);
            return { ok: true, status: res.status };
        }

        entry.lastError = `HTTP ${res.status}`;
        entry.failedAt = Date.now();
        entry.retrying = false;
        scheduleDlqFlush();
        return { ok: false, status: res.status, error: entry.lastError };
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        entry.lastError = errorMsg;
        entry.failedAt = Date.now();
        entry.retrying = false;
        scheduleDlqFlush();
        return { ok: false, error: errorMsg };
    }
}

export async function retryAllFailedFanouts(webhookName?: string): Promise<{ retried: number; succeeded: number; failed: number }> {
    const targets = webhookName
        ? deadLetterQueue.filter(e => e.webhookName === webhookName && !e.retrying)
        : deadLetterQueue.filter(e => !e.retrying);

    const results = await Promise.all(targets.map(e => retryFailedFanout(e.id)));
    const succeeded = results.filter(r => r.ok).length;
    return { retried: targets.length, succeeded, failed: targets.length - succeeded };
}

function enqueueFailedFanout(entry: Omit<FailedFanout, 'id' | 'failedAt' | 'retrying'>) {
    if (deadLetterQueue.length >= DLQ_MAX_SIZE) {
        deadLetterQueue.shift(); // drop oldest
    }
    deadLetterQueue.push({ ...entry, id: crypto.randomUUID(), failedAt: Date.now(), retrying: false });
    flushDlqSync(); // write immediately — a crash right after a failure must not lose the entry
}

// ─── Retry Helper ───────────────────────────────────────────────────────────

const DEFAULT_RETRY_ON = [429, 502, 503, 504];

async function fetchWithRetry(
    url: string,
    init: RequestInit,
    retry: WebhookRetryConfig | undefined,
    label: string,
): Promise<{ res: Response; resText: string | null; attempts: number }> {
    const maxRetries = retry?.maxRetries ?? 0;
    const baseDelay = retry?.retryDelayMs ?? 1000;
    const retryOn = retry?.retryOn ?? DEFAULT_RETRY_ON;
    const backoff = retry?.backoff ?? 'exponential';
    const retryUntilSuccess = retry?.retryUntilSuccess ?? false;

    function shouldRetry(status: number): boolean {
        if (retryUntilSuccess) return status < 200 || status >= 300;
        return retryOn.includes(status);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = backoff === 'exponential'
                ? baseDelay * Math.pow(2, attempt - 1)
                : baseDelay;
            console.warn(`🔁 [${label}] Retry ${attempt}/${maxRetries} in ${delay}ms…`);
            await Bun.sleep(delay);
        }

        try {
            const res = await fetch(url, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);
            // Cap fanout response capture at 4KB for logging — skip for large/unknown-size responses.
            const resContentLength = parseInt(res.headers.get('content-length') || '-1', 10);
            const resText = resContentLength < 0 || resContentLength <= 4096
                ? await res.text().catch(() => null)
                : `[response not captured: ${resContentLength} bytes]`;

            if (attempt < maxRetries && shouldRetry(res.status)) {
                console.warn(`🔁 [${label}] Got ${res.status}${retryUntilSuccess ? ' (retryUntilSuccess)' : ''}, will retry (${attempt + 1}/${maxRetries})`);
                lastError = new Error(`HTTP ${res.status}`);
                continue;
            }

            if (retryUntilSuccess && (res.status < 200 || res.status >= 300)) {
                // Exhausted all retries without a 2xx — log as critical
                console.error(`🚨 [${label}] All ${maxRetries + 1} attempt(s) failed — last status: ${res.status}`);
            }

            return { res, resText, attempts: attempt + 1 };
        } catch (err) {
            lastError = err;
            if (attempt >= maxRetries) throw err;
        }
    }

    throw lastError;
}

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

    if (!isIpAllowed(clientIp, webhook.allowedIps)) {
        console.warn(`🚫 [webhook:${webhook.name}]: blocked IP ${clientIp}`);
        return jsonResponse(401, { error: 'Unauthorized', message: 'Your IP address is not allowed.' });
    }

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

        // Resolve effective retry config: per-destination overrides distributor-level default
        const effectiveRetry = (typeof target !== 'string' && target.retry)
            ? target.retry
            : webhook.retry;

        try {
            const { res, resText, attempts } = await fetchWithRetry(
                tUrl,
                { method: tMethod, headers: tHeaders, body: tBody },
                effectiveRetry,
                `webhook:${webhook.name} → ${tUrl}`,
            );

            const fetchDuration = performance.now() - fetchStart;
            if (attempts > 1) {
                console.log(`✅ [webhook:${webhook.name}] Delivered to ${tUrl} after ${attempts} attempt(s)`);
            }

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
            console.error(`❌ [webhook:${webhook.name}] Action to ${tUrl} failed (all attempts exhausted):`, errorMsg);

            enqueueFailedFanout({
                webhookName: webhook.name,
                requestId,
                targetUrl: tUrl,
                method: tMethod,
                headers: headersToRecord(tHeaders),
                body: tBody ?? null,
                bodyPreview: tBodyStringPreview,
                bodySize: tBodySize,
                path: url.pathname + url.search,
                clientIp,
                retryConfig: effectiveRetry,
                lastError: errorMsg,
                totalAttempts: (effectiveRetry?.maxRetries ?? 0) + 1,
            });

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
        idleTimeout: 0,
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,

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
