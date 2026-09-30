// Manual re-send of a logged proxy request (Request Log → "Resend").
//
// Rebuilds the upstream call from the stored row: method, target URL, the
// captured body and the non-secret headers. Anything the log redacted
// (Authorization, cookies, secret query params) is dropped and the profile's
// own upstream auth is re-applied, so the replay carries the credential the
// proxy would use today — never a "[redacted]" placeholder.

import type { ProxyProfile } from '../core/types';
import { getRequestLogDetail, logRequest, headersToRecord, captureResponseBody, type RequestLogDetail } from '../telemetry/request-log';

const REPLAY_TIMEOUT_MS = 30_000;

/** Headers that describe the original hop, not the request — never replayed. */
const HOP_HEADERS = new Set([
    'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
    'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-scheme', 'x-forwarded-host',
    'x-real-ip', 'x-request-id', 'x-mid-api-key', 'x-forward-token', 'expect',
]);

export interface ReplayResult {
    ok: boolean;
    status?: number;
    statusText?: string;
    durationMs: number;
    requestId: string;
    error?: string;
}

export class ReplayError extends Error {
    constructor(message: string, public readonly httpStatus: number = 400) { super(message); }
}

function bodyIsReplayable(d: RequestLogDetail): string | null {
    if (d.method === 'GET' || d.method === 'HEAD') return null;
    const b = d.reqBody;
    if (b == null || b === '') {
        if ((d.reqBodySize || 0) > 0) return 'The request body was not captured in the log, so it cannot be re-sent.';
        return null;
    }
    if (b.startsWith('[binary:')) return 'Binary request bodies are not captured, so this request cannot be re-sent.';
    if (b.startsWith('[request body not captured')) return 'The request body exceeded the capture limit, so it cannot be re-sent.';
    if (/\n\.\.\. \[truncated at \d+KB\]$/.test(b)) return 'The captured body is truncated; re-sending it would deliver a corrupt payload.';
    return null;
}

export async function replayProxyRequest(logId: number, profiles: ProxyProfile[]): Promise<ReplayResult> {
    const d = getRequestLogDetail(logId);
    if (!d) throw new ReplayError('Request log entry not found', 404);
    if (d.type !== 'proxy' && d.type !== 'target') throw new ReplayError('Only proxy requests can be re-sent from here. Use the DLQ for webhook deliveries.');
    if (!d.profileName) throw new ReplayError('This entry has no profile attached.');

    const profile = profiles.find(p => p.name === d.profileName);
    if (!profile) throw new ReplayError(`Profile "${d.profileName}" no longer exists.`, 404);

    if (d.targetUrl.includes('=[redacted]')) {
        throw new ReplayError('The target URL contained a secret query parameter that was redacted in the log; re-send it manually.');
    }
    const bodyProblem = bodyIsReplayable(d);
    if (bodyProblem) throw new ReplayError(bodyProblem);

    // Make sure the stored URL still belongs to this profile's upstream — the
    // profile may have been re-pointed since, and we never want the dashboard
    // to become a generic "fetch any URL" endpoint.
    let target: URL;
    try { target = new URL(d.targetUrl); } catch { throw new ReplayError('Stored target URL is not valid.'); }
    let upstream: URL;
    try { upstream = new URL(profile.targetUrl); } catch { throw new ReplayError('Profile target URL is not valid.'); }
    if (target.origin !== upstream.origin) {
        throw new ReplayError(`Stored target (${target.origin}) no longer matches the profile upstream (${upstream.origin}).`);
    }

    // Rebuild headers: keep everything that is neither hop-specific nor redacted.
    const headers = new Headers();
    let stored: Record<string, string> = {};
    try { stored = JSON.parse(d.reqHeaders || '{}'); } catch {}
    for (const [k, v] of Object.entries(stored)) {
        const lower = k.toLowerCase();
        if (HOP_HEADERS.has(lower)) continue;
        if (v === '[redacted]') continue;
        headers.set(k, v);
    }
    const rawPort = profile.targetUrl.match(/^https?:\/\/[^/:]+:(\d+)/)?.[1];
    headers.set('host', rawPort ? `${upstream.hostname}:${rawPort}` : upstream.hostname);
    if (profile.authHeader && profile.apiKey) {
        headers.set(profile.authHeader, profile.authPrefix ? `${profile.authPrefix} ${profile.apiKey}` : profile.apiKey);
    }
    const requestId = crypto.randomUUID();
    headers.set('X-Request-ID', requestId);
    headers.set('X-Midleman-Replay-Of', d.requestId);

    const body = d.method === 'GET' || d.method === 'HEAD' ? undefined : (d.reqBody ?? undefined);
    const started = performance.now();
    let res: Response;
    try {
        res = await fetch(target.href, {
            method: d.method,
            headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
            // @ts-ignore — Bun-specific TLS option (mirrors proxy.ts)
            tls: { rejectUnauthorized: !profile.allowSelfSignedTls && process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
        });
    } catch (err) {
        const durationMs = performance.now() - started;
        const error = err instanceof Error ? err.message : String(err);
        logRequest({
            requestId, type: 'proxy', profileName: profile.name, method: d.method, path: d.path, targetUrl: target.href,
            clientIp: 'replay', reqHeaders: headersToRecord(headers), reqBody: body ?? null, reqBodySize: body?.length || 0,
            resStatus: 502, resStatusText: 'Bad Gateway', durationMs, error: `replay: ${error}`,
        });
        return { ok: false, durationMs, requestId, error };
    }
    const durationMs = performance.now() - started;
    const resCapture = await captureResponseBody(res);
    logRequest({
        requestId, type: 'proxy', profileName: profile.name, method: d.method, path: d.path, targetUrl: target.href,
        clientIp: 'replay', reqHeaders: headersToRecord(headers), reqBody: body ?? null, reqBodySize: body?.length || 0,
        resStatus: res.status, resStatusText: res.statusText, resHeaders: headersToRecord(res.headers),
        resBody: resCapture.body, resBodySize: resCapture.size, durationMs,
    });
    // Drain so the socket is released.
    try { await res.arrayBuffer(); } catch {}
    return { ok: res.status < 400, status: res.status, statusText: res.statusText, durationMs, requestId };
}
