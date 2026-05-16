// Nginx Proxy Manager (NPM) integration settings storage.
//
// Persists connection settings to data/npm.json. The password is encrypted at
// rest using AES-256-GCM with a key derived from the JWT RSA private key, same
// pattern as src/core/smtp.ts and src/auth/ldap.ts.
//
// Settings are optional: when not configured (or `enabled=false`), the
// integration is a no-op and Midleman behaves exactly as before.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export interface NpmSettings {
    enabled: boolean;
    url: string;            // e.g. "http://app:81"
    email: string;
    /** Encrypted (v1:iv:tag:ct). Empty string when not set. */
    passwordEnc: string;
    /** Public host/IP that NPM uses as forward_host in proxy_pass. */
    midlemanPublicHost: string;
    /** JWT cached from /api/tokens. Empty when not yet authenticated. */
    tokenCache?: string;
    /** Unix ms when the cached token expires. */
    tokenExpires?: number;
    lastCheckAt?: number;
    lastError?: string;
}

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const NPM_FILE = resolve(DATA_DIR, 'npm.json');

let encKey: Buffer | null = null;
let cachedSettings: NpmSettings | null = null;

function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function deriveEncKey(dataDir: string): Buffer {
    const keyPath = resolve(dataDir, 'jwt-key.pem');
    if (!existsSync(keyPath)) {
        throw new Error('NPM: jwt-key.pem not found — initJwt() must run before initNpm()');
    }
    const pem = readFileSync(keyPath, 'utf-8');
    return createHash('sha256').update('midleman:npm:password:v1\n').update(pem).digest();
}

function encryptPassword(plaintext: string): string {
    if (!plaintext) return '';
    if (!encKey) throw new Error('NPM not initialized');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptNpmPassword(encoded: string): string {
    if (!encoded) return '';
    if (!encKey) throw new Error('NPM not initialized');
    const parts = encoded.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('NPM: malformed password_enc');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

export function initNpmSettings(dataDir: string): void {
    encKey = deriveEncKey(dataDir);
    try {
        if (existsSync(NPM_FILE)) {
            const raw = readFileSync(NPM_FILE, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<NpmSettings>;
            cachedSettings = {
                enabled: !!parsed.enabled,
                url: parsed.url || '',
                email: parsed.email || '',
                passwordEnc: parsed.passwordEnc || '',
                midlemanPublicHost: normalizeMidlemanPublicHost(parsed.midlemanPublicHost || process.env.MIDLEMAN_PUBLIC_HOST || 'midleman') || 'midleman',
                tokenCache: parsed.tokenCache,
                tokenExpires: parsed.tokenExpires,
                lastCheckAt: parsed.lastCheckAt,
                lastError: parsed.lastError,
            };
        }
    } catch (err) {
        console.warn('⚠️  Could not load npm.json:', err instanceof Error ? err.message : err);
        cachedSettings = null;
    }
    // Env-var bootstrap: if NPM_API_URL is set and no settings file yet, seed disabled state with URL.
    if (!cachedSettings && process.env.NPM_API_URL) {
        cachedSettings = {
            enabled: false,
            url: process.env.NPM_API_URL,
            email: process.env.NPM_EMAIL || '',
            passwordEnc: '',
            midlemanPublicHost: normalizeMidlemanPublicHost(process.env.MIDLEMAN_PUBLIC_HOST || 'midleman') || 'midleman',
        };
    }
}

export function getNpmSettings(): NpmSettings | null {
    return cachedSettings;
}

export function isNpmEnabled(): boolean {
    return !!cachedSettings && !!cachedSettings.enabled && !!cachedSettings.url && !!cachedSettings.email;
}

export interface NpmSettingsInput {
    enabled?: boolean;
    url?: string;
    email?: string;
    /** Plaintext. Pass empty string to clear, undefined to keep existing. */
    password?: string;
    midlemanPublicHost?: string;
}

export function validateNpmInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';
    const i = input as Record<string, unknown>;
    if (i.url !== undefined) {
        if (typeof i.url !== 'string') return '"url" must be a string';
        try { new URL(i.url as string); } catch { return '"url" must be a valid URL'; }
    }
    if (i.email !== undefined && typeof i.email !== 'string') return '"email" must be a string';
    if (i.password !== undefined && typeof i.password !== 'string') return '"password" must be a string';
    if (i.enabled !== undefined && typeof i.enabled !== 'boolean') return '"enabled" must be a boolean';
    if (i.midlemanPublicHost !== undefined && typeof i.midlemanPublicHost !== 'string') return '"midlemanPublicHost" must be a string';
    return null;
}

/**
 * Normalize a midlemanPublicHost value so NPM can use it as `forward_host`.
 * Strips any scheme (http://, https://), trailing slash, port suffix, and path.
 * Empty input → empty output (caller decides the default).
 */
export function normalizeMidlemanPublicHost(raw: string): string {
    let s = String(raw || '').trim();
    if (!s) return '';
    // Strip scheme
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    // Strip anything after a path/query/fragment
    s = s.split('/')[0].split('?')[0].split('#')[0];
    // Strip port suffix — IPv6 ([::1]:3000) and plain (host:3000)
    if (s.startsWith('[')) {
        const close = s.indexOf(']');
        if (close > 0) s = s.slice(0, close + 1); // keep [::1]
    } else {
        s = s.split(':')[0];
    }
    return s;
}

function persist(): void {
    if (!cachedSettings) return;
    ensureDataDir();
    writeFileSync(NPM_FILE, JSON.stringify(cachedSettings, null, 2), 'utf-8');
}

export function saveNpmSettings(input: NpmSettingsInput): NpmSettings {
    const existing = cachedSettings;
    let passwordEnc = existing?.passwordEnc || '';
    if (input.password !== undefined) {
        passwordEnc = input.password ? encryptPassword(input.password) : '';
    }
    const next: NpmSettings = {
        enabled: input.enabled ?? existing?.enabled ?? false,
        url: (input.url ?? existing?.url ?? '').trim().replace(/\/$/, ''),
        email: (input.email ?? existing?.email ?? '').trim(),
        passwordEnc,
        midlemanPublicHost: normalizeMidlemanPublicHost(input.midlemanPublicHost ?? existing?.midlemanPublicHost ?? process.env.MIDLEMAN_PUBLIC_HOST ?? 'midleman') || 'midleman',
        // Invalidate the token cache whenever any credential/url changes — easiest correctness wins.
        tokenCache: undefined,
        tokenExpires: undefined,
        lastCheckAt: existing?.lastCheckAt,
        lastError: existing?.lastError,
    };
    cachedSettings = next;
    persist();
    return next;
}

export function updateTokenCache(token: string, expiresAtMs: number): void {
    if (!cachedSettings) return;
    cachedSettings.tokenCache = token;
    cachedSettings.tokenExpires = expiresAtMs;
    persist();
}

export function recordCheck(error?: string): void {
    if (!cachedSettings) return;
    cachedSettings.lastCheckAt = Date.now();
    cachedSettings.lastError = error;
    persist();
}

export function deleteNpmSettings(): void {
    cachedSettings = null;
    try {
        if (existsSync(NPM_FILE)) writeFileSync(NPM_FILE, JSON.stringify({}, null, 2), 'utf-8');
    } catch {}
}

/** Public-safe view (no password material, no token). */
export function publicNpmSettings(s: NpmSettings | null): Record<string, unknown> | null {
    if (!s) return null;
    return {
        enabled: !!s.enabled,
        url: s.url,
        email: s.email,
        hasPassword: !!s.passwordEnc,
        midlemanPublicHost: s.midlemanPublicHost,
        tokenValid: !!s.tokenCache && !!s.tokenExpires && s.tokenExpires > Date.now(),
        lastCheckAt: s.lastCheckAt,
        lastError: s.lastError,
    };
}
