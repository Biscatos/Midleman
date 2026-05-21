// Nginx Proxy Manager REST API client.
//
// Thin wrapper over fetch() that handles:
//  - Token login (POST /api/tokens) + caching in npm-settings
//  - Auto-refresh on 401 (single retry)
//  - Backoff retry on 502/503/504
//
// All methods throw NpmError on non-2xx; callers decide whether to swallow or
// surface to the user. The client is lazy-instantiated and never imported at
// module load time when the integration is disabled.

import {
    getNpmSettings,
    decryptNpmPassword,
    updateTokenCache,
    recordCheck,
    isNpmEnabled,
} from '../core/npm-settings.js';
import type {
    NpmTokenResponse,
    NpmProxyHost,
    NpmProxyHostPayload,
    NpmCertificate,
    NpmCertificatePayload,
    NpmHealth,
} from './types.js';

export class NpmError extends Error {
    constructor(message: string, public status: number, public body?: string) {
        super(message);
        this.name = 'NpmError';
    }
}

const TOKEN_REFRESH_SLACK_MS = 60_000; // refresh 60s before expiry

interface CredentialOverride {
    url: string;
    email: string;
    password: string;
}

async function postJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
        body: JSON.stringify(body),
        ...(init?.signal ? { signal: init.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new NpmError(`NPM POST ${url} → ${res.status}`, res.status, text);
    return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function loginRaw(url: string, email: string, password: string, signal?: AbortSignal): Promise<NpmTokenResponse> {
    return postJson<NpmTokenResponse>(
        `${url}/api/tokens`,
        { identity: email, secret: password },
        { signal },
    );
}

async function ensureToken(): Promise<{ url: string; token: string }> {
    const s = getNpmSettings();
    if (!s || !s.url || !s.email || !s.passwordEnc) {
        throw new NpmError('NPM not configured', 0);
    }
    const now = Date.now();
    if (s.tokenCache && s.tokenExpires && s.tokenExpires - TOKEN_REFRESH_SLACK_MS > now) {
        return { url: s.url, token: s.tokenCache };
    }
    const password = decryptNpmPassword(s.passwordEnc);
    const tok = await loginRaw(s.url, s.email, password);
    const expiresMs = Date.parse(tok.expires);
    updateTokenCache(tok.token, isNaN(expiresMs) ? now + 60 * 60 * 1000 : expiresMs);
    return { url: s.url, token: tok.token };
}

async function authedFormRequest<T>(method: string, path: string, form: FormData, attempt = 0): Promise<T> {
    const { url, token } = await ensureToken();
    const res = await fetch(`${url}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${token}` },
        body: form,
    });
    const text = await res.text();
    if (res.status === 401 && attempt === 0) {
        updateTokenCache('', 0);
        return authedFormRequest<T>(method, path, form, attempt + 1);
    }
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < 2) {
        const wait = 500 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, wait));
        return authedFormRequest<T>(method, path, form, attempt + 1);
    }
    if (!res.ok) throw new NpmError(`NPM ${method} ${path} → ${res.status}`, res.status, text);
    return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function authedBinaryRequest(method: string, path: string, attempt = 0): Promise<{ data: ArrayBuffer; contentType: string; filename?: string }> {
    const { url, token } = await ensureToken();
    const res = await fetch(`${url}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.status === 401 && attempt === 0) {
        updateTokenCache('', 0);
        return authedBinaryRequest(method, path, attempt + 1);
    }
    if (!res.ok) {
        const text = await res.text();
        throw new NpmError(`NPM ${method} ${path} → ${res.status}`, res.status, text);
    }
    const data = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    const filename = m ? decodeURIComponent(m[1]) : undefined;
    return { data, contentType, filename };
}

async function authedRequest<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const { url, token } = await ensureToken();
    const res = await fetch(`${url}${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();

    // 401 → refresh token once
    if (res.status === 401 && attempt === 0) {
        updateTokenCache('', 0);
        return authedRequest<T>(method, path, body, attempt + 1);
    }
    // 5xx transient → exponential backoff (up to 3 attempts total)
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < 2) {
        const wait = 500 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, wait));
        return authedRequest<T>(method, path, body, attempt + 1);
    }
    if (!res.ok) throw new NpmError(`NPM ${method} ${path} → ${res.status}`, res.status, text);
    return text ? (JSON.parse(text) as T) : (undefined as T);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Lightweight health check. Returns version if reachable. */
export async function ping(override?: CredentialOverride): Promise<NpmHealth> {
    const url = override?.url ?? getNpmSettings()?.url;
    if (!url) throw new NpmError('NPM URL not set', 0);
    const res = await fetch(`${url}/api/`);
    if (!res.ok) throw new NpmError(`NPM ping → ${res.status}`, res.status);
    const data = (await res.json()) as NpmHealth;
    return data;
}

/** Test credentials by performing a login round-trip. Does not update cache. */
export async function testConnection(override?: CredentialOverride): Promise<{ ok: true; version?: string }> {
    try {
        let url: string, email: string, password: string;
        if (override) {
            ({ url, email, password } = override);
        } else {
            const s = getNpmSettings();
            if (!s || !s.url || !s.email || !s.passwordEnc) throw new NpmError('NPM not configured', 0);
            url = s.url;
            email = s.email;
            password = decryptNpmPassword(s.passwordEnc);
        }
        const tok = await loginRaw(url, email, password);
        const expiresMs = Date.parse(tok.expires);
        if (!override) {
            updateTokenCache(tok.token, isNaN(expiresMs) ? Date.now() + 60 * 60 * 1000 : expiresMs);
        }
        const health = await ping(override);
        recordCheck();
        return { ok: true, version: health.version };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordCheck(msg);
        throw err;
    }
}

export async function listProxyHosts(): Promise<NpmProxyHost[]> {
    return authedRequest<NpmProxyHost[]>('GET', '/api/nginx/proxy-hosts');
}

export async function getProxyHost(id: number): Promise<NpmProxyHost> {
    return authedRequest<NpmProxyHost>('GET', `/api/nginx/proxy-hosts/${id}`);
}

export async function createProxyHost(payload: NpmProxyHostPayload): Promise<NpmProxyHost> {
    return authedRequest<NpmProxyHost>('POST', '/api/nginx/proxy-hosts', payload);
}

export async function updateProxyHost(id: number, payload: Partial<NpmProxyHostPayload>): Promise<NpmProxyHost> {
    return authedRequest<NpmProxyHost>('PUT', `/api/nginx/proxy-hosts/${id}`, payload);
}

export async function deleteProxyHost(id: number): Promise<void> {
    await authedRequest<unknown>('DELETE', `/api/nginx/proxy-hosts/${id}`);
}

export async function enableProxyHost(id: number): Promise<void> {
    await authedRequest<unknown>('POST', `/api/nginx/proxy-hosts/${id}/enable`);
}

export async function disableProxyHost(id: number): Promise<void> {
    await authedRequest<unknown>('POST', `/api/nginx/proxy-hosts/${id}/disable`);
}

export async function listCertificates(): Promise<NpmCertificate[]> {
    return authedRequest<NpmCertificate[]>('GET', '/api/nginx/certificates');
}

export async function getCertificate(id: number): Promise<NpmCertificate> {
    return authedRequest<NpmCertificate>('GET', `/api/nginx/certificates/${id}`);
}

export async function createLetsEncryptCert(payload: NpmCertificatePayload): Promise<NpmCertificate> {
    return authedRequest<NpmCertificate>('POST', '/api/nginx/certificates', payload);
}

export async function deleteCertificate(id: number): Promise<void> {
    await authedRequest<unknown>('DELETE', `/api/nginx/certificates/${id}`);
}

export async function renewCertificate(id: number): Promise<NpmCertificate> {
    return authedRequest<NpmCertificate>('POST', `/api/nginx/certificates/${id}/renew`);
}

export async function createOtherCertificate(niceName: string): Promise<NpmCertificate> {
    return authedRequest<NpmCertificate>('POST', '/api/nginx/certificates', {
        provider: 'other',
        nice_name: niceName,
    });
}

export async function uploadCertificateFiles(
    id: number,
    files: { certificate: File | Blob; certificate_key: File | Blob; intermediate_certificate?: File | Blob },
): Promise<NpmCertificate> {
    const form = new FormData();
    form.append('certificate', files.certificate);
    form.append('certificate_key', files.certificate_key);
    if (files.intermediate_certificate) form.append('intermediate_certificate', files.intermediate_certificate);
    return authedFormRequest<NpmCertificate>('POST', `/api/nginx/certificates/${id}/upload`, form);
}

export async function validateCertificateFiles(
    files: { certificate: File | Blob; certificate_key: File | Blob; intermediate_certificate?: File | Blob },
): Promise<unknown> {
    const form = new FormData();
    form.append('certificate', files.certificate);
    form.append('certificate_key', files.certificate_key);
    if (files.intermediate_certificate) form.append('intermediate_certificate', files.intermediate_certificate);
    return authedFormRequest<unknown>('POST', '/api/nginx/certificates/validate', form);
}

export async function downloadCertificate(id: number): Promise<{ data: ArrayBuffer; contentType: string; filename?: string }> {
    return authedBinaryRequest('GET', `/api/nginx/certificates/${id}/download`);
}

/** Throws if NPM is not enabled — call before any mutating method to short-circuit. */
export function assertEnabled(): void {
    if (!isNpmEnabled()) throw new NpmError('NPM integration disabled', 0);
}
