/**
 * GoContact audio session manager.
 *
 * Audio files in GoContact are behind a session-authenticated endpoint.
 * The login flow is completely separate from the Bearer-token API:
 *
 *   1. POST /fs/php/action_user.php  (form, SHA-512 hashed password)  → Set-Cookie
 *   2. POST /index.php               (form, portableagent=true)        → updates session
 *   3. GET  /{recordAddress}                                           → audio bytes
 *
 * Bun's fetch has no cookie jar, so we capture Set-Cookie from step 1,
 * carry it through step 2, and send it on every audio request.
 *
 * One session is kept per (baseUrl, username). On a 401/403 we re-authenticate.
 */

import { createHash } from 'crypto';
import { log } from '../core/logger';

interface AudioSession {
    cookie: string;         // raw Cookie header value
    createdAt: number;      // unix ms
    inflight: Promise<string> | null;
}

const SESSION_TTL_MS = 30 * 60_000;  // 30 minutes (generous re-auth margin)
const sessions = new Map<string, AudioSession>();
const FETCH_TIMEOUT_MS = 30_000;

function sessionKey(baseUrl: string, username: string): string {
    return `${baseUrl}|${username}`;
}

function base(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function hashSha512(password: string): string {
    return createHash('sha512').update(password).digest('hex');
}

async function authenticate(baseUrl: string, username: string, password: string): Promise<string> {
    const origin = base(baseUrl);

    // Step 1: login
    const loginBody = new URLSearchParams({
        action: 'loginUser',
        username,
        password: hashSha512(password),
    });
    const loginRes = await fetch(`${origin}/fs/php/action_user.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginBody.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
        tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
    } as RequestInit);

    const setCookies = loginRes.headers.getSetCookie?.() ?? extractSetCookies(loginRes.headers);
    if (!setCookies.length) {
        const body = await loginRes.text().catch(() => '');
        throw new Error(`GoContact audio login failed (no cookies): HTTP ${loginRes.status} ${body.slice(0, 200)}`);
    }
    const cookie = setCookies.map(c => c.split(';')[0]).join('; ');

    // Step 2: activate portable agent (extends session)
    const agentBody = new URLSearchParams({ portableagent: 'true' });
    await fetch(`${origin}/index.php`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookie,
        },
        body: agentBody.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
        tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
    } as RequestInit);

    log.info(`[reports/audio] session established for ${username}@${origin}`);
    return cookie;
}

/** Returns a valid (possibly cached) cookie string for the given credentials. */
async function getSession(baseUrl: string, username: string, password: string): Promise<string> {
    const key = sessionKey(baseUrl, username);
    const existing = sessions.get(key);

    if (existing) {
        if (existing.inflight) return existing.inflight;
        if (Date.now() - existing.createdAt < SESSION_TTL_MS) return existing.cookie;
    }

    const entry: AudioSession = { cookie: '', createdAt: 0, inflight: null };
    sessions.set(key, entry);

    const p = authenticate(baseUrl, username, password).then(cookie => {
        entry.cookie = cookie;
        entry.createdAt = Date.now();
        entry.inflight = null;
        return cookie;
    }).catch(err => {
        entry.inflight = null;
        throw err;
    });
    entry.inflight = p;
    return p;
}

function invalidateSession(baseUrl: string, username: string): void {
    sessions.delete(sessionKey(baseUrl, username));
}

/**
 * Stream an audio file from GoContact directly to the caller.
 * Returns a Response suitable for passing through to the end consumer.
 *
 * `recordPath` must be a relative path starting with "/" (e.g. "/recordings/...").
 * It is validated against the configured baseUrl to prevent open-proxy abuse.
 */
export async function streamAudio(
    baseUrl: string,
    username: string,
    password: string,
    recordPath: string,
): Promise<Response> {
    // Sanitize: must be a relative path, no scheme injection
    if (!recordPath.startsWith('/') || /^\/\/|:\/\//.test(recordPath)) {
        return new Response('Invalid audio path', { status: 400 });
    }
    if (recordPath.includes('..')) {
        return new Response('Invalid audio path', { status: 400 });
    }

    const origin = base(baseUrl);
    const url = `${origin}${recordPath}`;

    const cookie = await getSession(baseUrl, username, password);

    const upstream = await fetch(url, {
        method: 'GET',
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(60_000),
        tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
    } as RequestInit);

    if (upstream.status === 401 || upstream.status === 403) {
        // Session expired — re-auth once and retry
        invalidateSession(baseUrl, username);
        const freshCookie = await getSession(baseUrl, username, password);
        const retry = await fetch(url, {
            method: 'GET',
            headers: { Cookie: freshCookie },
            signal: AbortSignal.timeout(60_000),
            tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
        } as RequestInit);
        return proxyAudioResponse(retry);
    }

    return proxyAudioResponse(upstream);
}

function proxyAudioResponse(upstream: Response): Response {
    if (!upstream.ok) {
        return new Response(`Upstream error: HTTP ${upstream.status}`, { status: upstream.status });
    }
    // Pass the body as a stream — never buffer in Midleman
    const headers = new Headers();
    const ct = upstream.headers.get('content-type');
    const cl = upstream.headers.get('content-length');
    const cd = upstream.headers.get('content-disposition');
    const ar = upstream.headers.get('accept-ranges');
    if (ct) headers.set('content-type', ct);
    if (cl) headers.set('content-length', cl);
    if (cd) headers.set('content-disposition', cd);
    if (ar) headers.set('accept-ranges', ar);
    headers.set('cache-control', 'private, max-age=3600');

    return new Response(upstream.body, { status: 200, headers });
}

// Bun 1.x exposes getSetCookie() — fallback for environments without it
function extractSetCookies(headers: Headers): string[] {
    const result: string[] = [];
    // @ts-ignore
    if (typeof headers.getAll === 'function') {
        try { return (headers as any).getAll('set-cookie'); } catch { /* ignore */ }
    }
    const raw = headers.get('set-cookie');
    if (raw) result.push(raw);
    return result;
}
