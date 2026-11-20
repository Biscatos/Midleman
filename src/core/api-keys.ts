// Shared API keys: one key per partner, each listing the proxies / webhooks it
// opens. A resource accepts any number of them next to its own legacy key, so
// onboarding a partner never replaces a key already in production. The key is
// shown once; only its sha256 is stored (same model as wallboard-keys.ts).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createHash, randomBytes } from 'crypto';

export type ApiKeyKind = 'proxy' | 'webhook';
/** "proxy:<name>" or "webhook:<name>" — exact resources only, no wildcards. */
export type ApiKeyScope = `${ApiKeyKind}:${string}`;

export interface ApiKey {
    id: string;
    name: string;
    tokenHash: string;
    /** First characters of the key, to tell keys apart in the list. */
    prefix: string;
    scopes: ApiKeyScope[];
    createdAt: number;
    createdBy?: string;
    lastUsedAt: number | null;
}
export type PublicApiKey = Omit<ApiKey, 'tokenHash'>;

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const FILE = resolve(DATA_DIR, 'api-keys.json');
let keys: ApiKey[] | null = null;

function load(): ApiKey[] {
    if (keys) return keys;
    try { keys = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf-8')) : []; if (!Array.isArray(keys)) keys = []; }
    catch { keys = []; }
    return keys!;
}
function persist(): void {
    try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(load(), null, 2), 'utf-8'); }
    catch (e) { console.warn('⚠️  Could not persist API keys:', e instanceof Error ? e.message : e); }
}
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const pub = ({ tokenHash: _h, ...k }: ApiKey): PublicApiKey => k;

/** Keeps well-formed, de-duplicated scopes; null when any entry is malformed. */
export function parseScopes(input: unknown): ApiKeyScope[] | null {
    if (!Array.isArray(input)) return null;
    const out = new Set<ApiKeyScope>();
    for (const s of input) {
        if (typeof s !== 'string' || !/^(proxy|webhook):\S(.{0,118}\S)?$/.test(s)) return null;
        out.add(s as ApiKeyScope);
    }
    return [...out];
}

export function listApiKeys(): PublicApiKey[] { return load().map(pub); }

export function createApiKey(input: { name: string; scopes: ApiKeyScope[]; createdBy?: string }): { key: string; record: PublicApiKey } {
    const key = 'mmk_' + randomBytes(32).toString('base64url');
    const record: ApiKey = {
        id: randomBytes(6).toString('hex'), name: input.name.trim().slice(0, 80),
        tokenHash: hash(key), prefix: key.slice(0, 10), scopes: input.scopes,
        createdAt: Date.now(), createdBy: input.createdBy, lastUsedAt: null,
    };
    load().push(record); persist();
    return { key, record: pub(record) };
}

/** Changes what an existing key opens — the key itself stays the same. */
export function updateApiKey(id: string, patch: { name?: string; scopes?: ApiKeyScope[] }): PublicApiKey | null {
    const k = load().find(x => x.id === id);
    if (!k) return null;
    if (patch.name?.trim()) k.name = patch.name.trim().slice(0, 80);
    if (patch.scopes) k.scopes = patch.scopes;
    persist();
    return pub(k);
}

export function revokeApiKey(id: string): boolean {
    const list = load(); const i = list.findIndex(k => k.id === id);
    if (i < 0) return false;
    list.splice(i, 1); persist(); return true;
}

/** True when at least one shared key is assigned to this resource. */
export function apiKeyCovers(kind: ApiKeyKind, name: string): boolean {
    const scope = `${kind}:${name}`;
    return load().some(k => k.scopes.includes(scope as ApiKeyScope));
}

let lastTouchPersist = 0;
/** True when `token` is a shared key assigned to this resource. */
export function apiKeyAllows(token: string | undefined | null, kind: ApiKeyKind, name: string): boolean {
    if (!token || token.length > 256 || !token.startsWith('mmk_')) return false;
    // Comparing sha256 digests of a 256-bit random key leaks nothing useful through timing.
    const h = hash(token);
    const k = load().find(x => x.tokenHash === h);
    if (!k || !k.scopes.includes(`${kind}:${name}` as ApiKeyScope)) return false;
    k.lastUsedAt = Date.now();
    if (Date.now() - lastTouchPersist > 60_000) { lastTouchPersist = Date.now(); persist(); } // browsers send the cookie on every asset
    return true;
}
