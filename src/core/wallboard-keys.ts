// Wallboard share keys: a read-only link the helpdesk can put on a screen
// without a Midleman login. The key is a random token shown once; only its
// sha256 is stored. Optional expiry and source-IP allowlist, revocable at any
// time, last use recorded. Grants exactly one thing: GET /wallboard/data.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { ipInCidrs } from './ssrf-guard';

export interface WallboardKey {
    id: string;
    name: string;
    tokenHash: string;
    createdAt: number;
    createdBy?: string;
    expiresAt: number | null;
    allowedCidrs?: string[];
    lastUsedAt: number | null;
    lastUsedIp?: string;
}

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const FILE = resolve(DATA_DIR, 'wallboard-keys.json');
let keys: WallboardKey[] | null = null;

function load(): WallboardKey[] {
    if (keys) return keys;
    try { keys = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf-8')) : []; if (!Array.isArray(keys)) keys = []; }
    catch { keys = []; }
    return keys!;
}
function persist(): void {
    try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(load(), null, 2), 'utf-8'); }
    catch (e) { console.warn('⚠️  Could not persist wallboard keys:', e instanceof Error ? e.message : e); }
}
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Shape for the admin UI (no hash). */
export function listWallboardKeys(): Omit<WallboardKey, 'tokenHash'>[] {
    return load().map(({ tokenHash: _h, ...k }) => k);
}

export function createWallboardKey(input: { name: string; expiresAt: number | null; allowedCidrs?: string[]; createdBy?: string }): { key: string; record: Omit<WallboardKey, 'tokenHash'> } {
    const key = 'mmwb_' + randomBytes(32).toString('base64url');
    const record: WallboardKey = {
        id: randomBytes(6).toString('hex'), name: input.name.trim().slice(0, 80) || 'Wallboard',
        tokenHash: hash(key), createdAt: Date.now(), createdBy: input.createdBy,
        expiresAt: input.expiresAt, allowedCidrs: input.allowedCidrs?.length ? input.allowedCidrs : undefined, lastUsedAt: null,
    };
    load().push(record); persist();
    const { tokenHash: _h, ...pub } = record;
    return { key, record: pub };
}

export function revokeWallboardKey(id: string): boolean {
    const list = load(); const i = list.findIndex(k => k.id === id);
    if (i < 0) return false;
    list.splice(i, 1); persist(); return true;
}

let lastTouchPersist = 0;
/** The key record when `token` is valid for this client, else null. */
export function verifyWallboardKey(token: string | undefined | null, ip: string): WallboardKey | null {
    if (!token || token.length > 256) return null;
    const h = Buffer.from(hash(token), 'hex');
    for (const k of load()) {
        const kh = Buffer.from(k.tokenHash, 'hex');
        if (kh.length !== h.length || !timingSafeEqual(kh, h)) continue;
        if (k.expiresAt && Date.now() > k.expiresAt) return null;
        if (k.allowedCidrs?.length && !ipInCidrs(ip.replace(/^::ffff:/, ''), k.allowedCidrs)) return null;
        k.lastUsedAt = Date.now(); k.lastUsedIp = ip;
        if (Date.now() - lastTouchPersist > 60_000) { lastTouchPersist = Date.now(); persist(); } // a screen polls every 10 s; don't rewrite the file each time
        return k;
    }
    return null;
}
