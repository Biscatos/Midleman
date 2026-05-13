import { Database } from 'bun:sqlite';
import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync, type KeyObject } from 'crypto';
import { resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { AuthUser, ProxyUser } from '../core/types';

// ─── Database ────────────────────────────────────────────────────────────────

let db: Database | null = null;
let sessionMaxAge = 86400;

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password            TEXT NOT NULL,
    totp_secret         TEXT NOT NULL DEFAULT '',
    totp_enabled        INTEGER NOT NULL DEFAULT 0,
    full_name           TEXT NOT NULL DEFAULT '',
    email               TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    created_by_user_id  INTEGER,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id     INTEGER,
    actor_username    TEXT NOT NULL DEFAULT '',
    action            TEXT NOT NULL,
    target_type       TEXT,
    target_id         TEXT,
    details           TEXT,
    ip_address        TEXT,
    user_agent        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

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

CREATE TABLE IF NOT EXISTS admin_invites (
    token       TEXT PRIMARY KEY,
    email       TEXT NOT NULL DEFAULT '',
    full_name   TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    created_by  INTEGER,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    used_by_id  INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

        // Additive migration on `users` (legacy installs may lack newer cols)
        try {
            const info = db.prepare("PRAGMA table_info(users)").all() as any[];
            if (info.length > 0) {
                const cols = info.map((c: any) => c.name);
                if (!cols.includes('full_name')) db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
                if (!cols.includes('email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
                if (!cols.includes('totp_enabled')) db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 1");
                if (!cols.includes('created_by_user_id')) db.exec("ALTER TABLE users ADD COLUMN created_by_user_id INTEGER");
                if (!cols.includes('auth_source')) db.exec("ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
                if (!cols.includes('ldap_config_id')) db.exec("ALTER TABLE users ADD COLUMN ldap_config_id INTEGER");
                if (!cols.includes('ldap_dn')) db.exec("ALTER TABLE users ADD COLUMN ldap_dn TEXT");
            }
        } catch {}

        // Additive migration on `proxy_users` for LDAP shadow accounts
        try {
            const info = db.prepare("PRAGMA table_info(proxy_users)").all() as any[];
            if (info.length > 0) {
                const cols = info.map((c: any) => c.name);
                if (!cols.includes('auth_source')) db.exec("ALTER TABLE proxy_users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
                if (!cols.includes('ldap_config_id')) db.exec("ALTER TABLE proxy_users ADD COLUMN ldap_config_id INTEGER");
                if (!cols.includes('ldap_dn')) db.exec("ALTER TABLE proxy_users ADD COLUMN ldap_dn TEXT");
                if (!cols.includes('ldap_groups_last_seen')) db.exec("ALTER TABLE proxy_users ADD COLUMN ldap_groups_last_seen TEXT NOT NULL DEFAULT '[]'");
                if (!cols.includes('ldap_last_sync_at')) db.exec("ALTER TABLE proxy_users ADD COLUMN ldap_last_sync_at TEXT");
                if (!cols.includes('ldap_orphan')) db.exec("ALTER TABLE proxy_users ADD COLUMN ldap_orphan INTEGER NOT NULL DEFAULT 0");
            }
        } catch {}

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

/** Returns the shared SQLite handle (used by oauth.ts). Null until initAuth() runs. */
export function getAuthDb(): Database | null {
    return db;
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
    const row = db.prepare('SELECT id, username, password, totp_secret, totp_enabled, full_name, email, created_by_user_id, auth_source, ldap_config_id, ldap_dn, created_at FROM users WHERE username = $u').get({ $u: username }) as any;
    if (!row) return null;
    // Shadow accounts (auth_source='ldap') have no usable local password; the
    // LDAP path validates the password by binding to the directory directly.
    if (row.auth_source === 'ldap') return null;
    const valid = await Bun.password.verify(password, row.password);
    if (!valid) return null;
    return {
        user: rowToAuthUser(row),
        totpSecret: row.totp_secret,
    };
}

// ─── Multi-admin management ──────────────────────────────────────────────────

function rowToAuthUser(r: any): AuthUser {
    return {
        id: r.id,
        username: r.username,
        createdAt: r.created_at,
        fullName: r.full_name || '',
        email: r.email || '',
        totpEnabled: !!r.totp_enabled,
        createdByUserId: r.created_by_user_id ?? null,
        authSource: (r.auth_source || 'local') as 'local' | 'ldap',
        ldapConfigId: r.ldap_config_id ?? null,
        ldapDn: r.ldap_dn ?? null,
    };
}

export function listAdmins(): AuthUser[] {
    if (!db) return [];
    const rows = db.prepare('SELECT id, username, full_name, email, totp_enabled, created_by_user_id, auth_source, ldap_config_id, ldap_dn, created_at FROM users ORDER BY created_at ASC').all() as any[];
    return rows.map(rowToAuthUser);
}

export function getAdmin(id: number): AuthUser | null {
    if (!db) return null;
    const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, created_by_user_id, auth_source, ldap_config_id, ldap_dn, created_at FROM users WHERE id = $id').get({ $id: id }) as any;
    return row ? rowToAuthUser(row) : null;
}

export function countAdmins(): number {
    if (!db) return 0;
    const row = db.prepare('SELECT COUNT(*) as c FROM users').get() as any;
    return row?.c || 0;
}

/** Create an additional admin. TOTP is not set yet — the new admin sets it up on first login. */
export async function createAdditionalAdmin(
    username: string, password: string, fullName: string, email: string, createdByUserId: number,
): Promise<AuthUser> {
    if (!db) throw new Error('Auth not initialized');
    const hash = await Bun.password.hash(password, 'bcrypt');
    db.prepare(`INSERT INTO users (username, password, totp_secret, totp_enabled, full_name, email, created_by_user_id)
        VALUES ($u, $p, '', 0, $fn, $em, $cb)`)
        .run({ $u: username, $p: hash, $fn: fullName.trim(), $em: email.trim().toLowerCase(), $cb: createdByUserId });
    const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, created_by_user_id, auth_source, ldap_config_id, ldap_dn, created_at FROM users WHERE username = $u').get({ $u: username }) as any;
    return rowToAuthUser(row);
}

/** Delete an admin. Refuses to drop below 1 admin. Caller MUST prevent self-deletion. */
export function deleteAdmin(id: number): { deleted: boolean; reason?: string } {
    if (!db) return { deleted: false, reason: 'Auth not initialized' };
    if (countAdmins() <= 1) return { deleted: false, reason: 'Cannot delete the last admin' };
    // Drop any admin-shadow proxy row first so OAuth tokens get cleaned up via cascade.
    db.prepare("DELETE FROM proxy_users WHERE auth_source = 'admin_shadow' AND ldap_dn = $ref")
        .run({ $ref: ADMIN_SHADOW_REF_PREFIX + id });
    const result = db.prepare('DELETE FROM users WHERE id = $id').run({ $id: id });
    if (result.changes === 0) return { deleted: false, reason: 'Admin not found' };
    return { deleted: true };
}

export async function updateAdminPassword(id: number, newPassword: string): Promise<boolean> {
    if (!db) return false;
    // Refuse to set a local password on a shadow (LDAP) account — the password
    // lives in the directory.
    const row = db.prepare("SELECT auth_source FROM users WHERE id = $id").get({ $id: id }) as any;
    if (row?.auth_source === 'ldap') return false;
    const hash = await Bun.password.hash(newPassword, 'bcrypt');
    const result = db.prepare("UPDATE users SET password = $p, updated_at = datetime('now') WHERE id = $id")
        .run({ $p: hash, $id: id });
    return result.changes > 0;
}

/** Returns the stored TOTP secret for an admin (empty string if none). */
export function getAdminTotpSecret(id: number): string {
    if (!db) return '';
    const row = db.prepare('SELECT totp_secret FROM users WHERE id = $id').get({ $id: id }) as any;
    return row?.totp_secret || '';
}

/** Used during first login when the admin hasn't yet configured TOTP. */
export function setAdminTotp(id: number, totpSecret: string): boolean {
    if (!db) return false;
    const result = db.prepare("UPDATE users SET totp_secret = $t, totp_enabled = 1, updated_at = datetime('now') WHERE id = $id")
        .run({ $t: totpSecret, $id: id });
    return result.changes > 0;
}

// ─── LDAP shadow admins ─────────────────────────────────────────────────────

export interface LdapAdminProvisionInput {
    ldapConfigId: number;
    ldapDn: string;
    username: string;
    fullName: string;
    email: string;
}

/** Find a shadow admin by (ldap_config_id, ldap_dn). */
export function findLdapShadowAdmin(ldapConfigId: number, ldapDn: string): AuthUser | null {
    if (!db) return null;
    const row = db.prepare(`SELECT id, username, full_name, email, totp_enabled, created_by_user_id, auth_source, ldap_config_id, ldap_dn, created_at
        FROM users WHERE auth_source = 'ldap' AND ldap_config_id = $cid AND ldap_dn = $dn`)
        .get({ $cid: ldapConfigId, $dn: ldapDn }) as any;
    return row ? rowToAuthUser(row) : null;
}

/** Create or refresh a shadow admin and return it. Username conflicts with local users abort with null. */
export function upsertLdapShadowAdmin(input: LdapAdminProvisionInput): AuthUser | null {
    if (!db) return null;
    const existing = findLdapShadowAdmin(input.ldapConfigId, input.ldapDn);
    if (existing) {
        // Sync attrs in case they changed in the directory.
        db.prepare(`UPDATE users SET full_name = $fn, email = $em, updated_at = datetime('now') WHERE id = $id`)
            .run({ $fn: input.fullName.trim(), $em: input.email.trim().toLowerCase(), $id: existing.id });
        return getAdmin(existing.id);
    }
    // Username collision with a local admin → abort (local wins).
    const collision = db.prepare(`SELECT id, auth_source FROM users WHERE username = $u`).get({ $u: input.username }) as any;
    if (collision) return null;
    db.prepare(`INSERT INTO users (username, password, totp_secret, totp_enabled, full_name, email, auth_source, ldap_config_id, ldap_dn)
        VALUES ($u, '', '', 0, $fn, $em, 'ldap', $cid, $dn)`)
        .run({ $u: input.username, $fn: input.fullName.trim(), $em: input.email.trim().toLowerCase(), $cid: input.ldapConfigId, $dn: input.ldapDn });
    const row = db.prepare(`SELECT id, username, full_name, email, totp_enabled, created_by_user_id, auth_source, ldap_config_id, ldap_dn, created_at
        FROM users WHERE username = $u`).get({ $u: input.username }) as any;
    return row ? rowToAuthUser(row) : null;
}

/** Returns true if any local (non-LDAP) admin exists. Used to warn before
 *  provisioning the first LDAP admin (avoid lockout if AD goes down). */
export function hasLocalAdmins(): boolean {
    if (!db) return false;
    const row = db.prepare("SELECT COUNT(*) as c FROM users WHERE auth_source = 'local' OR auth_source IS NULL").get() as any;
    return (row?.c || 0) > 0;
}

// ─── Audit log ──────────────────────────────────────────────────────────────

export interface AuditEntry {
    id: number;
    actorUserId: number | null;
    actorUsername: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    details: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
}

export interface LogAuditInput {
    actorUserId?: number | null;
    actorUsername?: string;
    action: string;
    targetType?: string;
    targetId?: string | number;
    details?: unknown;
    ip?: string | null;
    userAgent?: string | null;
}

/** Append an audit log entry. Swallows errors — never blocks the parent request. */
export function logAudit(input: LogAuditInput): void {
    if (!db) return;
    try {
        db.prepare(`INSERT INTO audit_logs
            (actor_user_id, actor_username, action, target_type, target_id, details, ip_address, user_agent)
            VALUES ($auid, $aun, $a, $tt, $tid, $d, $ip, $ua)`)
            .run({
                $auid: input.actorUserId ?? null,
                $aun: input.actorUsername || '',
                $a: input.action,
                $tt: input.targetType || null,
                $tid: input.targetId !== undefined ? String(input.targetId) : null,
                $d: input.details !== undefined ? JSON.stringify(input.details) : null,
                $ip: input.ip || null,
                $ua: input.userAgent || null,
            });
    } catch (err) {
        console.warn('audit log failed:', err instanceof Error ? err.message : err);
    }
}

export interface AuditQuery {
    actor?: string;
    action?: string;
    targetType?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
}

export function queryAuditLogs(q: AuditQuery): { logs: AuditEntry[]; total: number } {
    if (!db) return { logs: [], total: 0 };
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.actor) { where.push('actor_username LIKE $actor COLLATE NOCASE'); params.$actor = `%${q.actor}%`; }
    if (q.action) { where.push('action = $action'); params.$action = q.action; }
    if (q.targetType) { where.push('target_type = $tt'); params.$tt = q.targetType; }
    if (q.from) { where.push('created_at >= $from'); params.$from = q.from; }
    if (q.to) { where.push('created_at <= $to'); params.$to = q.to; }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(Math.max(q.limit || 50, 1), 500);
    const offset = Math.max(q.offset || 0, 0);

    const total = (db.prepare(`SELECT COUNT(*) as c FROM audit_logs ${whereSql}`).get(params as any) as any)?.c || 0;
    const rows = db.prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`).all(params as any) as any[];
    const logs: AuditEntry[] = rows.map(r => ({
        id: r.id,
        actorUserId: r.actor_user_id ?? null,
        actorUsername: r.actor_username || '',
        action: r.action,
        targetType: r.target_type ?? null,
        targetId: r.target_id ?? null,
        details: r.details ? (() => { try { return JSON.parse(r.details); } catch { return r.details; } })() : null,
        ipAddress: r.ip_address ?? null,
        userAgent: r.user_agent ?? null,
        createdAt: r.created_at,
    }));
    return { logs, total };
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

interface LoginChallengeEntry {
    userId: number;
    username: string;
    totpSecret: string;
    needsSetup: boolean;
    expiresAt: number;
}

const loginChallenges = new Map<string, LoginChallengeEntry>();
const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CHALLENGES = 5_000;

export function createLoginChallenge(userId: number, username: string, totpSecret: string, needsSetup = false): string {
    if (loginChallenges.size >= MAX_CHALLENGES) {
        const oldest = loginChallenges.keys().next().value;
        if (oldest) loginChallenges.delete(oldest);
    }
    const token = crypto.randomUUID();
    loginChallenges.set(token, { userId, username, totpSecret, needsSetup, expiresAt: Date.now() + CHALLENGE_TTL });
    return token;
}

export function consumeLoginChallenge(token: string): { userId: number; username: string; totpSecret: string; needsSetup: boolean } | null {
    const entry = loginChallenges.get(token);
    if (!entry) return null;
    loginChallenges.delete(token);
    if (entry.expiresAt < Date.now()) return null;
    return { userId: entry.userId, username: entry.username, totpSecret: entry.totpSecret, needsSetup: entry.needsSetup };
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
    return {
        id: r.id,
        username: r.username,
        fullName: r.full_name || '',
        email: r.email || '',
        totpEnabled: !!r.totp_enabled,
        createdAt: r.created_at,
        authSource: (r.auth_source || 'local') as 'local' | 'ldap' | 'admin_shadow',
        ldapConfigId: r.ldap_config_id ?? null,
        ldapDn: r.ldap_dn ?? null,
        ldapOrphan: !!r.ldap_orphan,
    };
}

export async function createProxyUser(username: string, password: string, fullName = '', email = ''): Promise<ProxyUser> {
    if (!db) throw new Error('Auth not initialized');
    const hash = await Bun.password.hash(password, 'bcrypt');
    db.prepare('INSERT INTO proxy_users (username, full_name, email, password) VALUES ($u, $fn, $em, $p)')
        .run({ $u: username, $fn: fullName.trim(), $em: email.trim().toLowerCase(), $p: hash });
    const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
    return rowToProxyUser(row);
}

export function listAllProxyUsers(): ProxyUser[] {
    if (!db) return [];
    const rows = db.prepare('SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users ORDER BY username').all() as any[];
    return rows.map(rowToProxyUser);
}

export function getProxyUser(id: number): ProxyUser | null {
    if (!db) return null;
    const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE id = $id').get({ $id: id }) as any;
    return row ? rowToProxyUser(row) : null;
}

export function deleteProxyUser(id: number): boolean {
    if (!db) return false;
    // Refuse to delete admin shadow rows — they are recreated on next login
    // and the admin should be managed via the Admins page.
    const row = db.prepare("SELECT auth_source FROM proxy_users WHERE id = $id").get({ $id: id }) as any;
    if (row?.auth_source === 'admin_shadow') return false;
    const result = db.prepare('DELETE FROM proxy_users WHERE id = $id').run({ $id: id });
    return result.changes > 0;
}

export async function updateProxyUserPassword(id: number, newPassword: string): Promise<boolean> {
    if (!db) return false;
    const row = db.prepare("SELECT auth_source FROM proxy_users WHERE id = $id").get({ $id: id }) as any;
    if (row?.auth_source === 'ldap' || row?.auth_source === 'admin_shadow') return false;
    const hash = await Bun.password.hash(newPassword, 'bcrypt');
    const result = db.prepare("UPDATE proxy_users SET password = $p, updated_at = datetime('now') WHERE id = $id")
        .run({ $p: hash, $id: id });
    return result.changes > 0;
}

/** Find an existing proxy user by email or username (case-insensitive). */
export function findProxyUserByEmailOrUsername(email: string, username: string): ProxyUser | null {
    if (!db) return null;
    if (email) {
        const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE email = $e AND email != \'\'').get({ $e: email.toLowerCase() }) as any;
        if (row) return rowToProxyUser(row);
    }
    if (username) {
        const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
        if (row) return rowToProxyUser(row);
    }
    return null;
}

export function updateProxyUserInfo(id: number, fullName: string, email: string): boolean {
    if (!db) return false;
    // Shadow rows are synced from their source (admin or LDAP) at login time.
    const row = db.prepare("SELECT auth_source FROM proxy_users WHERE id = $id").get({ $id: id }) as any;
    if (row?.auth_source === 'admin_shadow' || row?.auth_source === 'ldap') return false;
    const result = db.prepare("UPDATE proxy_users SET full_name = $fn, email = $em, updated_at = datetime('now') WHERE id = $id")
        .run({ $fn: fullName.trim(), $em: email.trim().toLowerCase(), $id: id });
    return result.changes > 0;
}

/** Verify proxy user credentials by username OR email. Returns user + totpSecret or null. */
export async function verifyProxyUserCredentials(login: string, password: string): Promise<{ user: ProxyUser; totpSecret: string | null } | null> {
    if (!db) return null;
    // Try username first, then email
    let row = db.prepare('SELECT id, username, full_name, email, password, totp_secret, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE username = $u').get({ $u: login }) as any;
    if (!row && login.includes('@')) {
        row = db.prepare('SELECT id, username, full_name, email, password, totp_secret, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE email = $e').get({ $e: login.toLowerCase() }) as any;
    }
    if (!row) return null;
    // Shadow accounts have no usable local password.
    if (row.auth_source === 'ldap') return null;
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

// ─── LDAP shadow proxy users ────────────────────────────────────────────────

export interface LdapProxyProvisionInput {
    ldapConfigId: number;
    ldapDn: string;
    username: string;
    fullName: string;
    email: string;
    groups?: string[];  // Cached set of group DNs from the directory; persisted for later allow-list checks.
}

export function findLdapShadowProxyUser(ldapConfigId: number, ldapDn: string): ProxyUser | null {
    if (!db) return null;
    const row = db.prepare(`SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, created_at
        FROM proxy_users WHERE auth_source = 'ldap' AND ldap_config_id = $cid AND ldap_dn = $dn`)
        .get({ $cid: ldapConfigId, $dn: ldapDn }) as any;
    return row ? rowToProxyUser(row) : null;
}

export function upsertLdapShadowProxyUser(input: LdapProxyProvisionInput): ProxyUser | null {
    if (!db) return null;
    const groupsJson = JSON.stringify(Array.isArray(input.groups) ? input.groups : []);
    const existing = findLdapShadowProxyUser(input.ldapConfigId, input.ldapDn);
    if (existing) {
        db.prepare(`UPDATE proxy_users
            SET full_name = $fn, email = $em,
                ldap_groups_last_seen = $g, ldap_last_sync_at = datetime('now'),
                ldap_orphan = 0, updated_at = datetime('now')
            WHERE id = $id`)
            .run({
                $fn: input.fullName.trim(), $em: input.email.trim().toLowerCase(),
                $g: groupsJson, $id: existing.id,
            });
        return getProxyUser(existing.id);
    }
    const collision = db.prepare(`SELECT id FROM proxy_users WHERE username = $u`).get({ $u: input.username }) as any;
    if (collision) return null;
    db.prepare(`INSERT INTO proxy_users
        (username, full_name, email, password, totp_secret, totp_enabled,
         auth_source, ldap_config_id, ldap_dn, ldap_groups_last_seen, ldap_last_sync_at)
        VALUES ($u, $fn, $em, '', NULL, 0, 'ldap', $cid, $dn, $g, datetime('now'))`)
        .run({
            $u: input.username, $fn: input.fullName.trim(), $em: input.email.trim().toLowerCase(),
            $cid: input.ldapConfigId, $dn: input.ldapDn, $g: groupsJson,
        });
    const row = db.prepare(`SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, created_at
        FROM proxy_users WHERE username = $u`).get({ $u: input.username }) as any;
    return row ? rowToProxyUser(row) : null;
}

// ─── Admin shadow proxy users (for OAuth login as admin) ────────────────────
// Admins live in `users`, but OAuth refresh tokens / codes / SSO sessions all
// reference `proxy_users(id)`. To let an admin authenticate against OAuth apps,
// we mirror them into `proxy_users` with auth_source='admin_shadow' and stash
// the original admin id in `ldap_dn` (re-purposed as a generic external-ref
// slot — saves a schema migration).

const ADMIN_SHADOW_REF_PREFIX = 'admin:';

export interface AdminShadowProvisionInput {
    adminId: number;
    username: string;
    fullName: string;
    email: string;
}

export function findAdminShadowProxyUser(adminId: number): ProxyUser | null {
    if (!db) return null;
    const ref = ADMIN_SHADOW_REF_PREFIX + adminId;
    const row = db.prepare(`SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at
        FROM proxy_users WHERE auth_source = 'admin_shadow' AND ldap_dn = $ref`)
        .get({ $ref: ref }) as any;
    return row ? rowToProxyUser(row) : null;
}

/** Create or refresh an admin shadow row. Returns null on username collision with
 *  a non-admin-shadow proxy_users row (admin still wins for *new* logins, but we
 *  can't silently overwrite an existing user). */
export function upsertAdminShadowProxyUser(input: AdminShadowProvisionInput): ProxyUser | null {
    if (!db) return null;
    const ref = ADMIN_SHADOW_REF_PREFIX + input.adminId;
    const existing = findAdminShadowProxyUser(input.adminId);
    if (existing) {
        db.prepare(`UPDATE proxy_users
            SET full_name = $fn, email = $em, username = $u, updated_at = datetime('now')
            WHERE id = $id`)
            .run({ $fn: input.fullName.trim(), $em: input.email.trim().toLowerCase(), $u: input.username, $id: existing.id });
        return getProxyUser(existing.id);
    }
    // Username collision with a non-shadow proxy_user → refuse. Admin
    // identity protection: we don't override an existing real proxy user.
    const collision = db.prepare(`SELECT id, auth_source FROM proxy_users WHERE username = $u`).get({ $u: input.username }) as any;
    if (collision) return null;
    db.prepare(`INSERT INTO proxy_users
        (username, full_name, email, password, totp_secret, totp_enabled,
         auth_source, ldap_config_id, ldap_dn, ldap_groups_last_seen)
        VALUES ($u, $fn, $em, '', NULL, 0, 'admin_shadow', NULL, $ref, '[]')`)
        .run({
            $u: input.username, $fn: input.fullName.trim(), $em: input.email.trim().toLowerCase(),
            $ref: ref,
        });
    const row = db.prepare(`SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at
        FROM proxy_users WHERE auth_source = 'admin_shadow' AND ldap_dn = $ref`)
        .get({ $ref: ref }) as any;
    return row ? rowToProxyUser(row) : null;
}

/** Returns the cached LDAP group DNs for a shadow user (empty array otherwise). */
export function getProxyUserLdapGroups(userId: number): string[] {
    if (!db) return [];
    const row = db.prepare('SELECT ldap_groups_last_seen FROM proxy_users WHERE id = $id').get({ $id: userId }) as any;
    if (!row) return [];
    try { return JSON.parse(row.ldap_groups_last_seen || '[]'); } catch { return []; }
}

/** Iterate shadow LDAP proxy users for sync. */
export interface LdapShadowProxySummary {
    id: number;
    username: string;
    ldapConfigId: number;
    ldapDn: string;
    groupsLastSeen: string[];
    isOrphan: boolean;
}

export function listLdapShadowProxyUsers(ldapConfigId?: number): LdapShadowProxySummary[] {
    if (!db) return [];
    const rows = ldapConfigId !== undefined
        ? db.prepare(`SELECT id, username, ldap_config_id, ldap_dn, ldap_groups_last_seen, ldap_orphan
            FROM proxy_users WHERE auth_source = 'ldap' AND ldap_config_id = $cid`).all({ $cid: ldapConfigId }) as any[]
        : db.prepare(`SELECT id, username, ldap_config_id, ldap_dn, ldap_groups_last_seen, ldap_orphan
            FROM proxy_users WHERE auth_source = 'ldap'`).all() as any[];
    return rows.map(r => ({
        id: r.id,
        username: r.username,
        ldapConfigId: r.ldap_config_id,
        ldapDn: r.ldap_dn,
        groupsLastSeen: (() => { try { return JSON.parse(r.ldap_groups_last_seen || '[]'); } catch { return []; } })(),
        isOrphan: !!r.ldap_orphan,
    }));
}

/** Update a shadow user's groups cache + sync timestamp. */
export function updateShadowProxyGroups(userId: number, groups: string[]): void {
    if (!db) return;
    db.prepare(`UPDATE proxy_users SET ldap_groups_last_seen = $g, ldap_last_sync_at = datetime('now') WHERE id = $id`)
        .run({ $g: JSON.stringify(groups), $id: userId });
}

/** Mark a shadow user as orphan (no longer present in the directory). Revoking
 *  sessions / tokens is the caller's responsibility. */
export function markShadowProxyOrphan(userId: number, orphan: boolean): void {
    if (!db) return;
    db.prepare(`UPDATE proxy_users SET ldap_orphan = $o, ldap_last_sync_at = datetime('now') WHERE id = $id`)
        .run({ $o: orphan ? 1 : 0, $id: userId });
}

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

// ─── JWT (RS256) for Proxy User Auth + Supabase Third-Party Auth ─────────────
// Asymmetric signing so external verifiers (Supabase) can validate via JWKS
// without sharing the private key.

let privateKey: KeyObject | null = null;
let publicKey: KeyObject | null = null;
let publicJwk: { kty: string; n: string; e: string; alg: string; use: string; kid: string } | null = null;
let jwtIssuer: string = '';
let jwtMaxAge: number = 86400; // 24h default

function base64UrlEncode(data: Uint8Array | Buffer | string): string {
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
    const padded = str + '='.repeat((4 - str.length % 4) % 4);
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

/** RFC 7638 JWK thumbprint — canonical JSON, SHA-256, base64url. */
function computeKid(n: string, e: string): string {
    const canonical = `{"e":"${e}","kty":"RSA","n":"${n}"}`;
    return base64UrlEncode(createHash('sha256').update(canonical).digest());
}

/** Convert a public KeyObject (RSA) into a JWK for the JWKS endpoint. */
function publicKeyToJwk(pub: KeyObject): typeof publicJwk {
    const jwk = pub.export({ format: 'jwk' }) as { n: string; e: string; kty: string };
    const kid = computeKid(jwk.n, jwk.e);
    return { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid };
}

/** Load existing RSA key from DATA_DIR/jwt-key.pem or generate a new one. */
function loadOrCreateRsaKey(dataDir: string): { priv: KeyObject; pub: KeyObject } {
    const keyPath = resolve(dataDir, 'jwt-key.pem');
    mkdirSync(dataDir, { recursive: true });

    if (existsSync(keyPath)) {
        const pem = readFileSync(keyPath, 'utf-8');
        const priv = createPrivateKey(pem);
        const pub = createPublicKey(priv);
        return { priv, pub };
    }

    console.log('🔑 Generating new RSA-2048 key pair for JWT signing → ' + keyPath);
    const { privateKey: priv, publicKey: pub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = priv.export({ type: 'pkcs8', format: 'pem' }) as string;
    writeFileSync(keyPath, pem, { mode: 0o600 });
    return { priv, pub };
}

export function initJwt(dataDir: string, issuer: string, maxAge?: number): void {
    if (!issuer) {
        console.error('❌ JWT_ISSUER env var is required (e.g. https://midleman.example.com).');
        console.error('   This is the public URL where /.well-known/jwks.json will be served.');
        process.exit(1);
    }
    jwtIssuer = issuer.replace(/\/+$/, '');
    if (maxAge) jwtMaxAge = maxAge;

    const { priv, pub } = loadOrCreateRsaKey(dataDir);
    privateKey = priv;
    publicKey = pub;
    publicJwk = publicKeyToJwk(pub);
    console.log(`🔐 JWT: RS256, issuer=${jwtIssuer}, kid=${publicJwk!.kid}`);
}

// ─── UUID v5 (RFC 4122) — deterministic UUIDs for `sub` claim ───────────────

/** Namespace UUID is itself a UUID v5 derived from a fixed seed + the issuer,
 *  ensuring two Midleman deployments don't accidentally produce the same UUIDs. */
let subNamespaceBytes: Buffer | null = null;

function uuidV5Bytes(namespace: Buffer, name: string): Buffer {
    const hash = createHash('sha1').update(namespace).update(name, 'utf-8').digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    return bytes;
}

function bytesToUuid(b: Buffer): string {
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Convert an internal user id to a deterministic UUID v5 scoped to this issuer. */
export function userIdToUuid(userId: number | string): string {
    if (!subNamespaceBytes) {
        // Seed namespace = uuid v5 of "midleman-jwt-sub" under the standard DNS namespace,
        // then further scoped by the issuer URL to isolate deployments.
        const DNS_NS = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
        const seed = uuidV5Bytes(DNS_NS, 'midleman-jwt-sub');
        subNamespaceBytes = uuidV5Bytes(seed, jwtIssuer);
    }
    return bytesToUuid(uuidV5Bytes(subNamespaceBytes, String(userId)));
}

// ─── Sign / Verify ──────────────────────────────────────────────────────────

export interface SignJwtOptions {
    ttlSeconds?: number; // override default TTL for this token
}

export function signJwt(payload: Record<string, unknown>, opts?: SignJwtOptions): string {
    if (!privateKey || !publicJwk) throw new Error('JWT not initialized — call initJwt() first');
    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: publicJwk.kid }));
    const iat = Math.floor(Date.now() / 1000);
    const ttl = opts?.ttlSeconds ?? jwtMaxAge;
    const exp = iat + ttl;
    // Defaults (iss/aud/role) — caller's payload overrides via spread order.
    const body = base64UrlEncode(JSON.stringify({
        iss: jwtIssuer,
        aud: 'authenticated',
        role: 'authenticated',
        ...payload,
        iat,
        exp,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    const signature = base64UrlEncode(signer.sign(privateKey));
    return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string): Record<string, unknown> | null {
    if (!publicKey) return null;
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [header, body, signature] = parts;

        // Decode header to confirm alg — refuse anything other than RS256
        // (prevents alg=none / alg=HS256 confusion attacks).
        const headerJson = JSON.parse(base64UrlDecode(header));
        if (headerJson.alg !== 'RS256') return null;

        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${header}.${body}`);
        const sigBuf = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - signature.length % 4) % 4), 'base64');
        if (!verifier.verify(publicKey, sigBuf)) return null;

        const payload = JSON.parse(base64UrlDecode(body));
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        if (payload.iss && payload.iss !== jwtIssuer) return null;
        return payload;
    } catch {
        return null;
    }
}

export function getJwtMaxAge(): number {
    return jwtMaxAge;
}

export function getJwtIssuer(): string {
    return jwtIssuer;
}

/** Returns the JWKS document for /.well-known/jwks.json */
export function getJwks(): { keys: object[] } {
    if (!publicJwk) return { keys: [] };
    return { keys: [publicJwk] };
}

/** OIDC discovery doc — Supabase reads this to find the OAuth endpoints. */
export function getOidcDiscovery(): object {
    return {
        issuer: jwtIssuer,
        jwks_uri: `${jwtIssuer}/.well-known/jwks.json`,
        authorization_endpoint: `${jwtIssuer}/oauth/authorize`,
        token_endpoint: `${jwtIssuer}/oauth/token`,
        userinfo_endpoint: `${jwtIssuer}/oauth/userinfo`,
        end_session_endpoint: `${jwtIssuer}/oauth/logout`,
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'preferred_username', 'email', 'name', 'midleman_uid'],
    };
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

// ─── Admin Invite Tokens ──────────────────────────────────────────────────────

export interface AdminInvite {
    token: string;
    email: string;
    fullName: string;
    note: string;
    createdBy: number | null;
    expiresAt: string;
    usedAt: string | null;
    usedById: number | null;
    createdAt: string;
}

function rowToAdminInvite(r: any): AdminInvite {
    return {
        token: r.token,
        email: r.email || '',
        fullName: r.full_name || '',
        note: r.note || '',
        createdBy: r.created_by ?? null,
        expiresAt: r.expires_at,
        usedAt: r.used_at || null,
        usedById: r.used_by_id ?? null,
        createdAt: r.created_at,
    };
}

export function createAdminInvite(email: string, fullName: string, note: string, expiresInHours: number, createdBy?: number): AdminInvite {
    if (!db) throw new Error('Auth not initialized');
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000).toISOString();
    db.prepare('INSERT INTO admin_invites (token, email, full_name, note, created_by, expires_at) VALUES ($t, $em, $fn, $no, $cb, $ex)')
        .run({ $t: token, $em: email.trim().toLowerCase(), $fn: fullName.trim(), $no: note.trim(), $cb: createdBy ?? null, $ex: expiresAt });
    return { token, email: email.trim().toLowerCase(), fullName: fullName.trim(), note: note.trim(), createdBy: createdBy ?? null, expiresAt, usedAt: null, usedById: null, createdAt: new Date().toISOString() };
}

export function getAdminInvite(token: string): AdminInvite | null {
    if (!db || !token) return null;
    const row = db.prepare('SELECT * FROM admin_invites WHERE token = $t').get({ $t: token }) as any;
    return row ? rowToAdminInvite(row) : null;
}

export function listAdminInvites(): AdminInvite[] {
    if (!db) return [];
    const rows = db.prepare('SELECT * FROM admin_invites ORDER BY created_at DESC').all() as any[];
    return rows.map(rowToAdminInvite);
}

/** Mark token as used. Returns false if expired, already used, or not found. */
export function consumeAdminInvite(token: string, usedById: number): boolean {
    if (!db) return false;
    const now = new Date().toISOString();
    const result = db.prepare(
        'UPDATE admin_invites SET used_at = $ua, used_by_id = $uid WHERE token = $t AND used_at IS NULL AND expires_at > $now'
    ).run({ $ua: now, $uid: usedById, $t: token, $now: now });
    return result.changes > 0;
}

export function revokeAdminInvite(token: string): boolean {
    if (!db) return false;
    const result = db.prepare('DELETE FROM admin_invites WHERE token = $t AND used_at IS NULL').run({ $t: token });
    return result.changes > 0;
}
