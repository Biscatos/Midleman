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
    full_name    TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
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

CREATE TABLE IF NOT EXISTS invite_tokens (
    token        TEXT PRIMARY KEY,
    note         TEXT NOT NULL DEFAULT '',
    profiles     TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    invited_name TEXT NOT NULL DEFAULT '',
    expires_at   TEXT NOT NULL,
    used_at      TEXT,
    used_by      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
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
            } else {
                // Add full_name and email columns if missing (additive migration)
                if (!cols.includes('full_name')) {
                    db.exec("ALTER TABLE proxy_users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
                    console.log('🔄 Migrated proxy_users: added full_name column');
                }
                if (!cols.includes('email')) {
                    db.exec("ALTER TABLE proxy_users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
                    console.log('🔄 Migrated proxy_users: added email column');
                }
            }
        } catch {}

        // Migrate invite_tokens: add email/invited_name if missing
        try {
            const info = db.prepare("PRAGMA table_info(invite_tokens)").all() as any[];
            if (info.length > 0) {
                const cols = info.map((c: any) => c.name);
                if (!cols.includes('email')) {
                    db.exec("ALTER TABLE invite_tokens ADD COLUMN email TEXT NOT NULL DEFAULT ''");
                    console.log('🔄 Migrated invite_tokens: added email column');
                }
                if (!cols.includes('invited_name')) {
                    db.exec("ALTER TABLE invite_tokens ADD COLUMN invited_name TEXT NOT NULL DEFAULT ''");
                    console.log('🔄 Migrated invite_tokens: added invited_name column');
                }
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
    // Accept current + 1 forward window only (clock skew tolerance, no replay of past codes)
    for (let i = 0n; i <= 1n; i++) {
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
const MAX_CHALLENGES = 5_000;

export function createLoginChallenge(userId: number, username: string, totpSecret: string): string {
    if (loginChallenges.size >= MAX_CHALLENGES) {
        const oldest = loginChallenges.keys().next().value;
        if (oldest) loginChallenges.delete(oldest);
    }
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
const MAX_RATE_LIMIT_ENTRIES = 10_000; // prevent unbounded growth under distributed attacks

export function checkRateLimit(key: string): boolean {
    const now = Date.now();
    if (attempts.size >= MAX_RATE_LIMIT_ENTRIES) {
        const oldest = attempts.keys().next().value;
        if (oldest) attempts.delete(oldest);
    }
    const entry = attempts.get(key);
    if (!entry || entry.resetAt < now) {
        attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return true;
    }
    entry.count++;
    return entry.count <= MAX_ATTEMPTS;
}

// Cleanup old entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attempts) {
        if (entry.resetAt < now) attempts.delete(key);
    }
}, 5 * 60 * 1000);

// ─── Global Proxy User Management ──────────────────────────────────────────

function rowToProxyUser(r: any): ProxyUser {
    return { id: r.id, username: r.username, fullName: r.full_name || '', email: r.email || '', totpEnabled: !!r.totp_enabled, createdAt: r.created_at };
}

export async function createProxyUser(username: string, password: string, fullName = '', email = ''): Promise<ProxyUser> {
    if (!db) throw new Error('Auth not initialized');
    const hash = await Bun.password.hash(password, 'bcrypt');
    db.prepare('INSERT INTO proxy_users (username, full_name, email, password) VALUES ($u, $fn, $em, $p)')
        .run({ $u: username, $fn: fullName.trim(), $em: email.trim().toLowerCase(), $p: hash });
    const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
    return rowToProxyUser(row);
}

export function listAllProxyUsers(): ProxyUser[] {
    if (!db) return [];
    const rows = db.prepare('SELECT id, username, full_name, email, totp_enabled, created_at FROM proxy_users ORDER BY username').all() as any[];
    return rows.map(rowToProxyUser);
}

export function getProxyUser(id: number): ProxyUser | null {
    if (!db) return null;
    const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, created_at FROM proxy_users WHERE id = $id').get({ $id: id }) as any;
    return row ? rowToProxyUser(row) : null;
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

/** Find an existing proxy user by email or username (case-insensitive). */
export function findProxyUserByEmailOrUsername(email: string, username: string): ProxyUser | null {
    if (!db) return null;
    if (email) {
        const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, created_at FROM proxy_users WHERE email = $e AND email != \'\'').get({ $e: email.toLowerCase() }) as any;
        if (row) return rowToProxyUser(row);
    }
    if (username) {
        const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
        if (row) return rowToProxyUser(row);
    }
    return null;
}

export function updateProxyUserInfo(id: number, fullName: string, email: string): boolean {
    if (!db) return false;
    const result = db.prepare("UPDATE proxy_users SET full_name = $fn, email = $em, updated_at = datetime('now') WHERE id = $id")
        .run({ $fn: fullName.trim(), $em: email.trim().toLowerCase(), $id: id });
    return result.changes > 0;
}

/** Verify proxy user credentials by username OR email. Returns user + totpSecret or null. */
export async function verifyProxyUserCredentials(login: string, password: string): Promise<{ user: ProxyUser; totpSecret: string | null } | null> {
    if (!db) return null;
    // Try username first, then email
    let row = db.prepare('SELECT id, username, full_name, email, password, totp_secret, totp_enabled, created_at FROM proxy_users WHERE username = $u').get({ $u: login }) as any;
    if (!row && login.includes('@')) {
        row = db.prepare('SELECT id, username, full_name, email, password, totp_secret, totp_enabled, created_at FROM proxy_users WHERE email = $e').get({ $e: login.toLowerCase() }) as any;
    }
    if (!row) return null;
    const valid = await Bun.password.verify(password, row.password);
    if (!valid) return null;
    return {
        user: rowToProxyUser(row),
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
        SELECT pu.id, pu.username, pu.full_name, pu.email, pu.totp_enabled, pu.created_at
        FROM proxy_users pu
        JOIN proxy_user_profiles pup ON pu.id = pup.user_id
        WHERE pup.profile_name = $pn
        ORDER BY pu.username
    `).all({ $pn: profileName.toLowerCase() }) as any[];
    return rows.map(rowToProxyUser);
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
    if (proxyLoginChallenges.size >= MAX_CHALLENGES) {
        const oldest = proxyLoginChallenges.keys().next().value;
        if (oldest) proxyLoginChallenges.delete(oldest);
    }
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
    if (!secret) {
        console.warn('⚠️  JWT_SECRET not set — generating a random secret. All proxy sessions will be invalidated on restart. Set JWT_SECRET env var for persistence.');
        jwtSecret = base32Encode(crypto.getRandomValues(new Uint8Array(32)));
    } else {
        jwtSecret = secret;
    }
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

// ─── Invite Tokens ───────────────────────────────────────────────────────────

export interface InviteToken {
    token: string;
    note: string;
    profileName: string;
    email: string;
    invitedName: string;
    expiresAt: string;
    usedAt: string | null;
    usedBy: string | null;
    createdAt: string;
}

function rowToInvite(row: any): InviteToken {
    return {
        token: row.token,
        note: row.note,
        profileName: row.profiles || '',
        email: row.email || '',
        invitedName: row.invited_name || '',
        expiresAt: row.expires_at,
        usedAt: row.used_at || null,
        usedBy: row.used_by || null,
        createdAt: row.created_at,
    };
}

export function createInviteToken(profileName: string, email: string, invitedName: string, note: string, expiresInHours: number): InviteToken {
    if (!db) throw new Error('Auth not initialized');
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000).toISOString();
    db.prepare('INSERT INTO invite_tokens (token, note, profiles, email, invited_name, expires_at) VALUES ($t, $n, $p, $em, $in, $e)')
        .run({ $t: token, $n: note, $p: profileName.toLowerCase(), $em: email.trim().toLowerCase(), $in: invitedName.trim(), $e: expiresAt });
    return { token, note, profileName: profileName.toLowerCase(), email: email.trim().toLowerCase(), invitedName: invitedName.trim(), expiresAt, usedAt: null, usedBy: null, createdAt: new Date().toISOString() };
}

export function getInviteToken(token: string): InviteToken | null {
    if (!db) return null;
    const row = db.prepare('SELECT * FROM invite_tokens WHERE token = $t').get({ $t: token }) as any;
    return row ? rowToInvite(row) : null;
}

export function listInviteTokens(): InviteToken[] {
    if (!db) return [];
    const rows = db.prepare('SELECT * FROM invite_tokens ORDER BY created_at DESC').all() as any[];
    return rows.map(rowToInvite);
}

/** Mark token as used. Returns false if expired, already used, or not found. */
export function useInviteToken(token: string, username: string): boolean {
    if (!db) return false;
    const now = new Date().toISOString();
    const result = db.prepare(
        "UPDATE invite_tokens SET used_at = $ua, used_by = $ub WHERE token = $t AND used_at IS NULL AND expires_at > $now"
    ).run({ $ua: now, $ub: username, $t: token, $now: now });
    return result.changes > 0;
}

export function revokeInviteToken(token: string): boolean {
    if (!db) return false;
    const result = db.prepare('DELETE FROM invite_tokens WHERE token = $t').run({ $t: token });
    return result.changes > 0;
}
