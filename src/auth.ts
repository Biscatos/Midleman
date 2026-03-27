import { Database } from 'bun:sqlite';
import { createHmac } from 'crypto';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import type { AuthUser } from './types';

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
