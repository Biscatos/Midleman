import { Database } from 'bun:sqlite';
import { createHmac } from 'crypto';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import type { AuthUser, ProxyUser } from '../core/types';

// ─── Database ────────────────────────────────────────────────────────────────

let db: Database | null = null;
let sessionMaxAge = 86400;

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT NOT NULL,
    totp_secret TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS proxy_users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password     TEXT NOT NULL,
    totp_secret  TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxy_user_profiles (
    user_id      INTEGER NOT NULL REFERENCES proxy_users(id) ON DELETE CASCADE,
    profile_name TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (user_id, profile_name)
);

CREATE INDEX IF NOT EXISTS idx_proxy_user_profiles_profile ON proxy_user_profiles(profile_name);
CREATE INDEX IF NOT EXISTS idx_proxy_user_profiles_user ON proxy_user_profiles(user_id);
`;

export function initAuth(dataDir: string, maxAge: number = 86400): void {
    sessionMaxAge = maxAge;
    const dbPath = resolve(dataDir, 'auth.db');
    try {
        mkdirSync(dataDir, { recursive: true });
        db = new Database(dbPath, { create: true });
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA foreign_keys = ON');

        // Migrate old proxy_users table (had profile_name column, no totp fields)
        try {
            const info = db.prepare("PRAGMA table_info(proxy_users)").all() as any[];
            const cols = info.map((c: any) => c.name);
            if (cols.includes('profile_name') && !cols.includes('totp_secret')) {
                console.log('🔄 Migrating proxy_users table to new schema...');
                db.exec('DROP TABLE IF EXISTS proxy_users');
            }
        } catch {}

        db.exec(CREATE_TABLES);
        cleanExpiredSessions();
        setInterval(cleanExpiredSessions, 60 * 60 * 1000);
        const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any)?.c || 0;
        console.log(`🔐 Auth: ${userCount} user(s) registered`);
    } catch (err) {
        console.error('❌ Failed to initialize auth database:', err);
        db = null;
    }
}

export function shutdownAuth(): void {
    if (db) { db.close(); db = null; }
}

// ─── User Management ─────────────────────────────────────────────────────────

export function hasUsers(): boolean {
    if (!db) return false;
    const row = db.prepare('SELECT COUNT(*) as c FROM users').get() as any;
    return (row?.c || 0) > 0;
}

export async function createUser(username: string, password: string, totpSecret: string): Promise<AuthUser> {
    if (!db) throw new Error('Auth not initialized');
    const hash = await Bun.password.hash(password, 'bcrypt');
    const stmt = db.prepare('INSERT INTO users (username, password, totp_secret) VALUES ($u, $p, $t)');
    stmt.run({ $u: username, $p: hash, $t: totpSecret });
    const row = db.prepare('SELECT id, username, created_at FROM users WHERE username = $u').get({ $u: username }) as any;
    return { id: row.id, username: row.username, createdAt: row.created_at };
}

export async function verifyCredentials(username: string, password: string): Promise<{ user: AuthUser; totpSecret: string } | null> {
    if (!db) return null;
    const row = db.prepare('SELECT id, username, password, totp_secret, created_at FROM users WHERE username = $u').get({ $u: username }) as any;
    if (!row) return null;
    const valid = await Bun.password.verify(password, row.password);
    if (!valid) return null;
    return {
        user: { id: row.id, username: row.username, createdAt: row.created_at },
        totpSecret: row.totp_secret,
    };
}

// ─── TOTP (RFC 6238) ────────────────────────────────────────────────────────

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Uint8Array): string {
    let bits = 0, value = 0, result = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            result += BASE32_CHARS[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) result += BASE32_CHARS[(value << (5 - bits)) & 31];
    return result;
}

function base32Decode(encoded: string): Buffer {
    let bits = 0, value = 0;
    const bytes: number[] = [];
    for (const ch of encoded.toUpperCase()) {
        const idx = BASE32_CHARS.indexOf(ch);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function generateHotp(secret: Buffer, counter: bigint): string {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(counter);
    const hmac = createHmac('sha1', secret).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1_000_000;
    return code.toString().padStart(6, '0');
}

export function generateTotpSecret(username: string): { secret: string; otpauthUrl: string } {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const secret = base32Encode(bytes);
    const otpauthUrl = `otpauth://totp/Midleman:${encodeURIComponent(username)}?secret=${secret}&issuer=Midleman&digits=6&period=30`;
    return { secret, otpauthUrl };
}

export function verifyTotp(secret: string, code: string): boolean {
    const key = base32Decode(secret);
    const now = BigInt(Math.floor(Date.now() / 1000 / 30));
    // Accept ±1 window (90s total)
    for (let i = -1n; i <= 1n; i++) {
        if (generateHotp(key, now + i) === code.trim()) return true;
    }
    return false;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export function createSession(userId: number, ip: string, userAgent: string): string {
    if (!db) throw new Error('Auth not initialized');
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + sessionMaxAge * 1000).toISOString();
    db.prepare('INSERT INTO sessions (id, user_id, expires_at, ip_address, user_agent) VALUES ($id, $uid, $exp, $ip, $ua)')
        .run({ $id: id, $uid: userId, $exp: expiresAt, $ip: ip, $ua: userAgent });
    return id;
}

export function validateSession(sessionId: string): { user: AuthUser } | null {
    if (!db || !sessionId) return null;
    const row = db.prepare(`
        SELECT s.id, s.expires_at, u.id as user_id, u.username, u.created_at
        FROM sessions s JOIN users u ON s.user_id = u.id
        WHERE s.id = $id
    `).get({ $id: sessionId }) as any;
    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
        db.prepare('DELETE FROM sessions WHERE id = $id').run({ $id: sessionId });
        return null;
    }
    return { user: { id: row.user_id, username: row.username, createdAt: row.created_at } };
}

export function destroySession(sessionId: string): void {
    if (!db || !sessionId) return;
    db.prepare('DELETE FROM sessions WHERE id = $id').run({ $id: sessionId });
}

function cleanExpiredSessions(): void {
    if (!db) return;
    try {
        const now = new Date().toISOString();
        db.prepare('DELETE FROM sessions WHERE expires_at < $now').run({ $now: now });
    } catch {}
}

// ─── Login Challenge Tokens ──────────────────────────────────────────────────

const loginChallenges = new Map<string, { userId: number; username: string; totpSecret: string; expiresAt: number }>();
const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

export function createLoginChallenge(userId: number, username: string, totpSecret: string): string {
    const token = crypto.randomUUID();
    loginChallenges.set(token, { userId, username, totpSecret, expiresAt: Date.now() + CHALLENGE_TTL });
    return token;
}

export function consumeLoginChallenge(token: string): { userId: number; username: string; totpSecret: string } | null {
    const entry = loginChallenges.get(token);
    if (!entry) return null;
    loginChallenges.delete(token);
    if (entry.expiresAt < Date.now()) return null;
    return { userId: entry.userId, username: entry.username, totpSecret: entry.totpSecret };
}

// Cleanup expired challenges
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of loginChallenges) {
        if (v.expiresAt < now) loginChallenges.delete(k);
    }
}, 60 * 1000);

// ─── Rate Limiter ────────────────────────────────────────────────────────────

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt < now) {
        attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return true;
    }
    entry.count++;
    return entry.count <= MAX_ATTEMPTS;
}

// Cleanup old entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attempts) {
        if (entry.resetAt < now) attempts.delete(ip);
    }
}, 5 * 60 * 1000);

// ─── Global Proxy User Management ──────────────────────────────────────────

export async function createProxyUser(username: string, password: string): Promise<ProxyUser> {
    if (!db) throw new Error('Auth not initialized');
    const hash = await Bun.password.hash(password, 'bcrypt');
    db.prepare('INSERT INTO proxy_users (username, password) VALUES ($u, $p)')
        .run({ $u: username, $p: hash });
    const row = db.prepare('SELECT id, username, totp_enabled, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
    return { id: row.id, username: row.username, totpEnabled: !!row.totp_enabled, createdAt: row.created_at };
}

export function listAllProxyUsers(): ProxyUser[] {
    if (!db) return [];
    const rows = db.prepare('SELECT id, username, totp_enabled, created_at FROM proxy_users ORDER BY username').all() as any[];
    return rows.map(r => ({ id: r.id, username: r.username, totpEnabled: !!r.totp_enabled, createdAt: r.created_at }));
}

export function getProxyUser(id: number): ProxyUser | null {
    if (!db) return null;
    const row = db.prepare('SELECT id, username, totp_enabled, created_at FROM proxy_users WHERE id = $id').get({ $id: id }) as any;
    if (!row) return null;
    return { id: row.id, username: row.username, totpEnabled: !!row.totp_enabled, createdAt: row.created_at };
}

export function deleteProxyUser(id: number): boolean {
    if (!db) return false;
    const result = db.prepare('DELETE FROM proxy_users WHERE id = $id').run({ $id: id });
    return result.changes > 0;
}

export async function updateProxyUserPassword(id: number, newPassword: string): Promise<boolean> {
    if (!db) return false;
    const hash = await Bun.password.hash(newPassword, 'bcrypt');
    const result = db.prepare("UPDATE proxy_users SET password = $p, updated_at = datetime('now') WHERE id = $id")
        .run({ $p: hash, $id: id });
    return result.changes > 0;
}

/** Verify proxy user credentials. Returns user + totpSecret (for TOTP step) or null. */
export async function verifyProxyUserCredentials(username: string, password: string): Promise<{ user: ProxyUser; totpSecret: string | null } | null> {
    if (!db) return null;
    const row = db.prepare('SELECT id, username, password, totp_secret, totp_enabled, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
    if (!row) return null;
    const valid = await Bun.password.verify(password, row.password);
    if (!valid) return null;
    return {
        user: { id: row.id, username: row.username, totpEnabled: !!row.totp_enabled, createdAt: row.created_at },
        totpSecret: row.totp_secret || null,
    };
}

/** Check if a proxy user has access to a specific profile. */
export function proxyUserHasProfile(userId: number, profileName: string): boolean {
    if (!db) return false;
    const row = db.prepare('SELECT 1 FROM proxy_user_profiles WHERE user_id = $uid AND profile_name = $pn')
        .get({ $uid: userId, $pn: profileName.toLowerCase() }) as any;
    return !!row;
}

// ─── Proxy User ↔ Profile Association ───────────────────────────────────────

export function assignProxyUserToProfile(userId: number, profileName: string): boolean {
    if (!db) return false;
    try {
        db.prepare('INSERT OR IGNORE INTO proxy_user_profiles (user_id, profile_name) VALUES ($uid, $pn)')
            .run({ $uid: userId, $pn: profileName.toLowerCase() });
        return true;
    } catch { return false; }
}

export function removeProxyUserFromProfile(userId: number, profileName: string): boolean {
    if (!db) return false;
    const result = db.prepare('DELETE FROM proxy_user_profiles WHERE user_id = $uid AND profile_name = $pn')
        .run({ $uid: userId, $pn: profileName.toLowerCase() });
    return result.changes > 0;
}

export function listProxyUsersForProfile(profileName: string): ProxyUser[] {
    if (!db) return [];
    const rows = db.prepare(`
        SELECT pu.id, pu.username, pu.totp_enabled, pu.created_at
        FROM proxy_users pu
        JOIN proxy_user_profiles pup ON pu.id = pup.user_id
        WHERE pup.profile_name = $pn
        ORDER BY pu.username
    `).all({ $pn: profileName.toLowerCase() }) as any[];
    return rows.map(r => ({ id: r.id, username: r.username, totpEnabled: !!r.totp_enabled, createdAt: r.created_at }));
}

export function listProfilesForProxyUser(userId: number): string[] {
    if (!db) return [];
    const rows = db.prepare('SELECT profile_name FROM proxy_user_profiles WHERE user_id = $uid ORDER BY profile_name')
        .all({ $uid: userId }) as any[];
    return rows.map(r => r.profile_name);
}

export function removeAllProfileAssociations(profileName: string): number {
    if (!db) return 0;
    const result = db.prepare('DELETE FROM proxy_user_profiles WHERE profile_name = $pn').run({ $pn: profileName.toLowerCase() });
    return result.changes;
}

// ─── Proxy User TOTP Setup ─────────────────────────────────────────────────

export function setupProxyUserTotp(userId: number, totpSecret: string): boolean {
    if (!db) return false;
    const result = db.prepare("UPDATE proxy_users SET totp_secret = $t, totp_enabled = 1, updated_at = datetime('now') WHERE id = $id")
        .run({ $t: totpSecret, $id: userId });
    return result.changes > 0;
}

export function disableProxyUserTotp(userId: number): boolean {
    if (!db) return false;
    const result = db.prepare("UPDATE proxy_users SET totp_secret = NULL, totp_enabled = 0, updated_at = datetime('now') WHERE id = $id")
        .run({ $id: userId });
    return result.changes > 0;
}

export function getProxyUserTotpSecret(userId: number): string | null {
    if (!db) return null;
    const row = db.prepare('SELECT totp_secret FROM proxy_users WHERE id = $id').get({ $id: userId }) as any;
    return row?.totp_secret || null;
}

// ─── Proxy Login Challenge Tokens ───────────────────────────────────────────
// After credentials are verified, we issue a short-lived challenge token.
// The client must then either verify TOTP or set up TOTP before getting the JWT.

const proxyLoginChallenges = new Map<string, { userId: number; username: string; totpSecret: string | null; totpEnabled: boolean; profileName: string; expiresAt: number }>();

export function createProxyLoginChallenge(userId: number, username: string, totpSecret: string | null, totpEnabled: boolean, profileName: string): string {
    const token = crypto.randomUUID();
    proxyLoginChallenges.set(token, { userId, username, totpSecret, totpEnabled, profileName, expiresAt: Date.now() + CHALLENGE_TTL });
    return token;
}

export function consumeProxyLoginChallenge(token: string): { userId: number; username: string; totpSecret: string | null; totpEnabled: boolean; profileName: string } | null {
    const entry = proxyLoginChallenges.get(token);
    if (!entry) return null;
    proxyLoginChallenges.delete(token);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
}

/** Peek at challenge without consuming (for TOTP setup step). */
export function peekProxyLoginChallenge(token: string): { userId: number; username: string; totpSecret: string | null; totpEnabled: boolean; profileName: string } | null {
    const entry = proxyLoginChallenges.get(token);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry;
}

// Cleanup proxy challenges
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of proxyLoginChallenges) {
        if (v.expiresAt < now) proxyLoginChallenges.delete(k);
    }
}, 60 * 1000);

// ─── JWT (HS256) for Proxy User Auth ────────────────────────────────────────

let jwtSecret: string = '';
let jwtMaxAge: number = 86400; // 24h default

export function initJwt(secret?: string, maxAge?: number): void {
    // Generate a random secret if none provided (persists only for server lifetime)
    jwtSecret = secret || base32Encode(crypto.getRandomValues(new Uint8Array(32)));
    if (maxAge) jwtMaxAge = maxAge;
}

function base64UrlEncode(data: Uint8Array | string): string {
    const str = typeof data === 'string' ? data : Buffer.from(data).toString('base64');
    return (typeof data === 'string' ? Buffer.from(data).toString('base64') : str)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
    const padded = str + '='.repeat((4 - str.length % 4) % 4);
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

export function signJwt(payload: Record<string, unknown>): string {
    const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const exp = Math.floor(Date.now() / 1000) + jwtMaxAge;
    const body = base64UrlEncode(JSON.stringify({ ...payload, exp, iat: Math.floor(Date.now() / 1000) }));
    const signature = base64UrlEncode(
        createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest()
    );
    return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string): Record<string, unknown> | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [header, body, signature] = parts;
        const expectedSig = base64UrlEncode(
            createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest()
        );
        if (signature !== expectedSig) return null;
        const payload = JSON.parse(base64UrlDecode(body));
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

export function getJwtMaxAge(): number {
    return jwtMaxAge;
}

// ─── Cookie Helpers ──────────────────────────────────────────────────────────

export function parseCookies(req: Request): Record<string, string> {
    const result: Record<string, string> = {};
    const header = req.headers.get('cookie') || '';
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) result[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
    }
    return result;
}

export function sessionCookie(sessionId: string, cookieName: string, maxAge: number): string {
    return `${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(cookieName: string): string {
    return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
