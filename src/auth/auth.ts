import { Database } from 'bun:sqlite';
import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync, type KeyObject } from 'crypto';
import { resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { AuthUser, ProxyUser } from '../core/types';

// ─── Database ────────────────────────────────────────────────────────────────

let db: Database | null = null;
let sessionMaxAge = 86400;

// Tables created on a fresh install. The `users` table is intentionally
// included so that boot succeeds on legacy databases that still have it —
// the unification migration drops it afterwards. New installs never see
// `users` populated; admins are rows in `proxy_users` with roles='admin,proxy'.
const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

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
    user_id    INTEGER NOT NULL REFERENCES proxy_users(id) ON DELETE CASCADE,
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
    force_2fa_setup INTEGER NOT NULL DEFAULT 0,
    roles        TEXT NOT NULL DEFAULT 'proxy',
    created_by_user_id INTEGER,
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

CREATE TABLE IF NOT EXISTS proxy_profile_ldap_groups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_name    TEXT NOT NULL COLLATE NOCASE,
    ldap_config_id  INTEGER NOT NULL,
    group_match     TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(profile_name, ldap_config_id, group_match)
);

CREATE INDEX IF NOT EXISTS idx_pplg_profile ON proxy_profile_ldap_groups(profile_name);
CREATE INDEX IF NOT EXISTS idx_pplg_config ON proxy_profile_ldap_groups(ldap_config_id);

CREATE TABLE IF NOT EXISTS invite_tokens (
    token             TEXT PRIMARY KEY,
    note              TEXT NOT NULL DEFAULT '',
    profiles          TEXT NOT NULL DEFAULT '',
    oauth_client_ids  TEXT NOT NULL DEFAULT '',
    email             TEXT NOT NULL DEFAULT '',
    invited_name      TEXT NOT NULL DEFAULT '',
    expires_at        TEXT NOT NULL,
    used_at           TEXT,
    used_by           TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS ldap_adoption_events (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_user_id          INTEGER NOT NULL REFERENCES proxy_users(id) ON DELETE CASCADE,
    ldap_config_id         INTEGER NOT NULL,
    ldap_dn                TEXT NOT NULL,
    matched_on             TEXT NOT NULL,
    matched_value          TEXT NOT NULL,
    previous_auth_source   TEXT NOT NULL,
    previous_password_hash TEXT,
    previous_username      TEXT,
    previous_email         TEXT,
    state                  TEXT NOT NULL DEFAULT 'pending',
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at            TEXT,
    resolved_by            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ldap_adoption_state ON ldap_adoption_events(state);
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

        // The unification migration needs to inspect & rewrite tables BEFORE
        // we create the new schema (CREATE_TABLES) — otherwise CREATE TABLE IF
        // NOT EXISTS would silently skip recreating `sessions` with the new FK.
        runLegacyAdditiveMigrations(db);
        runUsersUnificationMigration(db, dbPath);

        db.exec(CREATE_TABLES);

        // After CREATE_TABLES, make sure additive columns we may have rolled out
        // on previous releases exist on proxy_users (idempotent).
        ensureProxyUsersColumns(db);

        cleanExpiredSessions();
        setInterval(cleanExpiredSessions, 60 * 60 * 1000);
        const adminCount = (db.prepare("SELECT COUNT(*) AS c FROM proxy_users WHERE roles LIKE '%admin%'").get() as any)?.c || 0;
        const proxyCount = (db.prepare("SELECT COUNT(*) AS c FROM proxy_users").get() as any)?.c || 0;
        console.log(`🔐 Auth: ${proxyCount} user(s) total, ${adminCount} with admin role`);
    } catch (err) {
        console.error('❌ Failed to initialize auth database:', err);
        db = null;
    }
}

/** Idempotent additive column migrations that pre-date the unification. We
 *  still run these because legacy databases may have `users` or `proxy_users`
 *  rows without the newer columns. */
function runLegacyAdditiveMigrations(d: Database): void {
    try {
        const info = d.prepare("PRAGMA table_info(users)").all() as any[];
        if (info.length > 0) {
            const cols = info.map((c: any) => c.name);
            if (!cols.includes('full_name')) d.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
            if (!cols.includes('email')) d.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
            if (!cols.includes('totp_enabled')) d.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 1");
            if (!cols.includes('created_by_user_id')) d.exec("ALTER TABLE users ADD COLUMN created_by_user_id INTEGER");
            if (!cols.includes('auth_source')) d.exec("ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
            if (!cols.includes('ldap_config_id')) d.exec("ALTER TABLE users ADD COLUMN ldap_config_id INTEGER");
            if (!cols.includes('ldap_dn')) d.exec("ALTER TABLE users ADD COLUMN ldap_dn TEXT");
        }
    } catch {}

    try {
        const info = d.prepare("PRAGMA table_info(proxy_users)").all() as any[];
        const cols = info.map((c: any) => c.name);
        if (info.length > 0) {
            if (cols.includes('profile_name') && !cols.includes('totp_secret')) {
                console.log('🔄 Migrating proxy_users table to new schema...');
                d.exec('DROP TABLE IF EXISTS proxy_users');
            } else {
                if (!cols.includes('full_name')) d.exec("ALTER TABLE proxy_users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
                if (!cols.includes('email')) d.exec("ALTER TABLE proxy_users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
                if (!cols.includes('auth_source')) d.exec("ALTER TABLE proxy_users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
                if (!cols.includes('ldap_config_id')) d.exec("ALTER TABLE proxy_users ADD COLUMN ldap_config_id INTEGER");
                if (!cols.includes('ldap_dn')) d.exec("ALTER TABLE proxy_users ADD COLUMN ldap_dn TEXT");
                if (!cols.includes('ldap_groups_last_seen')) d.exec("ALTER TABLE proxy_users ADD COLUMN ldap_groups_last_seen TEXT NOT NULL DEFAULT '[]'");
                if (!cols.includes('ldap_last_sync_at')) d.exec("ALTER TABLE proxy_users ADD COLUMN ldap_last_sync_at TEXT");
                if (!cols.includes('ldap_orphan')) d.exec("ALTER TABLE proxy_users ADD COLUMN ldap_orphan INTEGER NOT NULL DEFAULT 0");
            }
        }
    } catch {}

    try {
        const info = d.prepare("PRAGMA table_info(invite_tokens)").all() as any[];
        if (info.length > 0) {
            const cols = info.map((c: any) => c.name);
            if (!cols.includes('email')) d.exec("ALTER TABLE invite_tokens ADD COLUMN email TEXT NOT NULL DEFAULT ''");
            if (!cols.includes('invited_name')) d.exec("ALTER TABLE invite_tokens ADD COLUMN invited_name TEXT NOT NULL DEFAULT ''");
            if (!cols.includes('oauth_client_ids')) d.exec("ALTER TABLE invite_tokens ADD COLUMN oauth_client_ids TEXT NOT NULL DEFAULT ''");
        }
    } catch {}
}

/** Ensures proxy_users has the newer columns (roles, created_by_user_id) on
 *  databases that may have been upgraded to a pre-unification version where
 *  proxy_users already existed but without these. */
function ensureProxyUsersColumns(d: Database): void {
    try {
        const cols = (d.prepare("PRAGMA table_info(proxy_users)").all() as any[]).map((c: any) => c.name);
        if (!cols.includes('roles')) d.exec("ALTER TABLE proxy_users ADD COLUMN roles TEXT NOT NULL DEFAULT 'proxy'");
        if (!cols.includes('created_by_user_id')) d.exec("ALTER TABLE proxy_users ADD COLUMN created_by_user_id INTEGER");
        if (!cols.includes('force_2fa_setup')) d.exec("ALTER TABLE proxy_users ADD COLUMN force_2fa_setup INTEGER NOT NULL DEFAULT 0");
    } catch {}
}

// ─── Users ⇆ proxy_users unification migration ──────────────────────────────
// Runs once. Collapses admin rows from `users` into `proxy_users` with
// `roles='admin,proxy'`, preserving OAuth token IDs by re-using the existing
// admin-shadow row when one exists. Then drops `users`.

function runUsersUnificationMigration(d: Database, dbPath: string): void {
    // Idempotency: meta marker.
    let metaExists = false;
    try {
        const r = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
        metaExists = !!r;
    } catch { metaExists = false; }
    if (metaExists) {
        const done = d.prepare("SELECT value FROM meta WHERE key = 'users_unified_at'").get() as any;
        if (done) return;
    }

    // If `users` doesn't exist, this is a fresh install — nothing to migrate.
    const usersTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (!usersTable) {
        // Just mark migration done for future boots (after CREATE_TABLES creates meta).
        // We can't INSERT into meta here yet because it doesn't exist; do it at the end.
        // Use a temporary sentinel: rely on the post-CREATE_TABLES marker step below.
        finaliseUnification(d, /*adminsCopied*/ 0, /*adoptionsQueued*/ 0, /*backup*/ '');
        return;
    }

    // Check if there are any admins to migrate. If `users` exists but is empty,
    // we still want to drop it and mark the migration done.
    let adminRows: any[] = [];
    try {
        adminRows = d.prepare("SELECT * FROM users").all() as any[];
    } catch {
        adminRows = [];
    }

    // Backup before destructive changes.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = dbPath + '.pre-unification-' + ts;
    try {
        // Use SQLite's built-in backup via VACUUM INTO — atomic, no external deps.
        d.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
        console.log(`💾 Backup pre-unification: ${backupPath}`);
    } catch (err) {
        console.error('❌ Could not create pre-unification backup:', err);
        throw err;
    }

    console.log(`🔄 Unifying users → proxy_users (${adminRows.length} admin row(s))`);

    // Run the whole rewrite in a transaction. Foreign keys OFF so we can
    // rebuild `sessions` without referential errors during the swap.
    d.exec('PRAGMA foreign_keys = OFF');

    let adminsCopied = 0;
    let adoptionsQueued = 0;

    try {
        d.exec('BEGIN');

        // Make sure proxy_users exists. On very old databases that pre-date
        // proxy_users entirely, the table is missing — create a minimal version
        // with the columns we touch below. CREATE_TABLES will later add any
        // remaining indexes/constraints idempotently.
        d.exec(`CREATE TABLE IF NOT EXISTS proxy_users (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
            full_name    TEXT NOT NULL DEFAULT '',
            email        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
            password     TEXT NOT NULL,
            totp_secret  TEXT,
            totp_enabled INTEGER NOT NULL DEFAULT 0,
            force_2fa_setup INTEGER NOT NULL DEFAULT 0,
            roles        TEXT NOT NULL DEFAULT 'proxy',
            auth_source  TEXT NOT NULL DEFAULT 'local',
            ldap_config_id INTEGER,
            ldap_dn      TEXT,
            ldap_groups_last_seen TEXT NOT NULL DEFAULT '[]',
            ldap_last_sync_at TEXT,
            ldap_orphan  INTEGER NOT NULL DEFAULT 0,
            created_by_user_id INTEGER,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        )`);

        // Make sure proxy_users has the new columns BEFORE we start writing to them.
        const pu = (d.prepare("PRAGMA table_info(proxy_users)").all() as any[]).map((c: any) => c.name);
        if (!pu.includes('roles')) d.exec("ALTER TABLE proxy_users ADD COLUMN roles TEXT NOT NULL DEFAULT 'proxy'");
        if (!pu.includes('created_by_user_id')) d.exec("ALTER TABLE proxy_users ADD COLUMN created_by_user_id INTEGER");
        // Ensure ldap_adoption_events exists for any deferred collision queue.
        d.exec(`CREATE TABLE IF NOT EXISTS ldap_adoption_events (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            proxy_user_id          INTEGER,
            ldap_config_id         INTEGER NOT NULL,
            ldap_dn                TEXT NOT NULL,
            matched_on             TEXT NOT NULL,
            matched_value          TEXT NOT NULL,
            previous_auth_source   TEXT NOT NULL,
            previous_password_hash TEXT,
            previous_username      TEXT,
            previous_email         TEXT,
            state                  TEXT NOT NULL DEFAULT 'pending',
            created_at             TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at            TEXT,
            resolved_by            INTEGER
        )`);

        // Build remap: Map<oldAdminId, newProxyId>
        const idMap = new Map<number, number>();

        for (const admin of adminRows) {
            const oldId: number = admin.id;
            // Look for an existing admin-shadow row that we should collapse with.
            const shadow = d.prepare(
                "SELECT * FROM proxy_users WHERE auth_source = 'admin_shadow' AND ldap_dn = $ref"
            ).get({ $ref: 'admin:' + oldId }) as any;

            if (shadow) {
                // Collapse: shadow row becomes the canonical admin row.
                d.prepare(`UPDATE proxy_users SET
                    password = $pw,
                    totp_secret = $ts,
                    totp_enabled = $te,
                    full_name = CASE WHEN COALESCE(full_name,'') = '' THEN $fn ELSE full_name END,
                    email = CASE WHEN COALESCE(email,'') = '' THEN $em ELSE email END,
                    auth_source = $as,
                    ldap_config_id = $lci,
                    ldap_dn = $ld,
                    roles = 'admin,proxy',
                    created_by_user_id = $cb,
                    updated_at = datetime('now')
                    WHERE id = $id`).run({
                    $pw: admin.password || '',
                    $ts: admin.totp_secret || '',
                    $te: admin.totp_enabled ? 1 : 0,
                    $fn: admin.full_name || '',
                    $em: (admin.email || '').toLowerCase(),
                    $as: admin.auth_source || 'local',
                    $lci: admin.ldap_config_id ?? null,
                    $ld: admin.ldap_dn ?? null,
                    $cb: admin.created_by_user_id ?? null,
                    $id: shadow.id,
                });
                idMap.set(oldId, shadow.id);
                adminsCopied++;
                continue;
            }

            // No shadow → create a fresh proxy_users row for this admin.
            // Username/email collision handling: if the username already exists
            // in proxy_users (and it's not an admin shadow we just collapsed),
            // queue an adoption event with a suffixed username so the admin
            // can resolve later instead of crashing the boot.
            const usernameTaken = d.prepare("SELECT id FROM proxy_users WHERE username = $u").get({ $u: admin.username }) as any;
            let targetUsername: string = admin.username;
            let queuedReason: string | null = null;
            if (usernameTaken) {
                targetUsername = admin.username + '_admin_' + oldId;
                queuedReason = 'username_collision_on_migration';
            }

            const result = d.prepare(`INSERT INTO proxy_users
                (username, full_name, email, password, totp_secret, totp_enabled,
                 auth_source, ldap_config_id, ldap_dn, ldap_groups_last_seen,
                 roles, created_by_user_id, created_at)
                VALUES ($u, $fn, $em, $pw, $ts, $te, $as, $lci, $ld, '[]',
                        'admin,proxy', $cb, $createdAt)`).run({
                $u: targetUsername,
                $fn: admin.full_name || '',
                $em: (admin.email || '').toLowerCase(),
                $pw: admin.password || '',
                $ts: admin.totp_secret || '',
                $te: admin.totp_enabled ? 1 : 0,
                $as: admin.auth_source || 'local',
                $lci: admin.ldap_config_id ?? null,
                $ld: admin.ldap_dn ?? null,
                $cb: admin.created_by_user_id ?? null,
                $createdAt: admin.created_at,
            });
            const newId = Number(result.lastInsertRowid);
            idMap.set(oldId, newId);
            adminsCopied++;

            if (queuedReason) {
                d.prepare(`INSERT INTO ldap_adoption_events
                    (proxy_user_id, ldap_config_id, ldap_dn, matched_on, matched_value,
                     previous_auth_source, previous_username, previous_email, state)
                    VALUES ($pid, 0, '', 'username_migration', $u, $as, $oldu, $em, 'pending')`).run({
                    $pid: newId,
                    $u: admin.username,
                    $as: admin.auth_source || 'local',
                    $oldu: admin.username,
                    $em: (admin.email || '').toLowerCase(),
                });
                adoptionsQueued++;
            }
        }

        // Remap dependent tables.
        if (idMap.size > 0) {
            const entries = Array.from(idMap.entries());

            // 1) sessions: recreate with new FK (REFERENCES proxy_users) + remap user_id.
            //    Use a CASE WHEN ... THEN ... mapping so it's one statement.
            const caseClauses = entries.map(([oldId, newId]) => `WHEN ${oldId} THEN ${newId}`).join(' ');
            const inList = entries.map(([oldId]) => oldId).join(',');

            // Drop the old sessions table and recreate with FK to proxy_users.
            const sessionsExists = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
            if (sessionsExists) {
                d.exec(`CREATE TABLE sessions_new (
                    id         TEXT PRIMARY KEY,
                    user_id    INTEGER NOT NULL REFERENCES proxy_users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    expires_at TEXT NOT NULL,
                    ip_address TEXT,
                    user_agent TEXT
                )`);
                d.exec(`INSERT INTO sessions_new (id, user_id, created_at, expires_at, ip_address, user_agent)
                    SELECT id,
                           CASE user_id ${caseClauses} ELSE user_id END,
                           created_at, expires_at, ip_address, user_agent
                    FROM sessions
                    WHERE user_id IN (${inList}) OR user_id IN (SELECT id FROM proxy_users)`);
                d.exec('DROP TABLE sessions');
                d.exec('ALTER TABLE sessions_new RENAME TO sessions');
                d.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)');
                d.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
            }

            // 2) audit_logs.actor_user_id — table may not exist on very old DBs
            try {
                d.exec(`UPDATE audit_logs SET actor_user_id = CASE actor_user_id ${caseClauses} ELSE actor_user_id END WHERE actor_user_id IN (${inList})`);
            } catch {}

            // 3) admin_invites.created_by and used_by_id
            try {
                d.exec(`UPDATE admin_invites SET created_by = CASE created_by ${caseClauses} ELSE created_by END WHERE created_by IN (${inList})`);
                d.exec(`UPDATE admin_invites SET used_by_id = CASE used_by_id ${caseClauses} ELSE used_by_id END WHERE used_by_id IN (${inList})`);
            } catch {}

            // 4) proxy_users.created_by_user_id (self-referential to former admin ids)
            try {
                d.exec(`UPDATE proxy_users SET created_by_user_id = CASE created_by_user_id ${caseClauses} ELSE created_by_user_id END WHERE created_by_user_id IN (${inList})`);
            } catch {}
        }

        // Drop the legacy users table.
        d.exec('DROP TABLE IF EXISTS users');

        // Marker (meta table may not exist yet — create if needed).
        d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('users_unified_at', datetime('now'))").run();

        d.exec('COMMIT');
    } catch (err) {
        try { d.exec('ROLLBACK'); } catch {}
        d.exec('PRAGMA foreign_keys = ON');
        console.error('❌ Unification migration failed:', err);
        console.error(`   Restore from backup: ${backupPath}`);
        throw err;
    }

    d.exec('PRAGMA foreign_keys = ON');

    finaliseUnification(d, adminsCopied, adoptionsQueued, backupPath);
}

function finaliseUnification(d: Database, adminsCopied: number, adoptionsQueued: number, backupPath: string): void {
    try {
        d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('users_unified_at', datetime('now'))").run();
    } catch {}
    if (adminsCopied > 0) {
        console.log(`✅ Unification done: ${adminsCopied} admin(s) migrated to proxy_users (${adoptionsQueued} need manual review).`);
        if (backupPath) console.log(`   Backup kept at: ${backupPath}`);
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

/** Returns true if at least one admin exists. Used to gate setup mode in /admin/* routes. */
export function hasUsers(): boolean {
    if (!db) return false;
    const row = db.prepare("SELECT COUNT(*) as c FROM proxy_users WHERE roles LIKE '%admin%'").get() as any;
    return (row?.c || 0) > 0;
}

/** Setup mode: create the very first admin. TOTP is already configured here
 *  (the setup wizard generated and verified it). */
export async function createUser(username: string, password: string, totpSecret: string): Promise<AuthUser> {
    if (!db) throw new Error('Auth not initialized');
    const hash = await Bun.password.hash(password, 'bcrypt');
    const stmt = db.prepare(`INSERT INTO proxy_users
        (username, password, totp_secret, totp_enabled, roles)
        VALUES ($u, $p, $t, 1, 'admin,proxy')`);
    stmt.run({ $u: username, $p: hash, $t: totpSecret });
    const row = db.prepare('SELECT id, username, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
    return { id: row.id, username: row.username, createdAt: row.created_at };
}

/** Verify dashboard-admin credentials (username-or-email + password).
 *  After unification, admins are rows in `proxy_users` with `roles` containing
 *  'admin'. LDAP-sourced rows have no usable local password — those are
 *  verified by the LDAP bind path instead. */
export async function verifyCredentials(login: string, password: string): Promise<{ user: AuthUser; totpSecret: string } | null> {
    if (!db) return null;
    const cols = `id, username, password, totp_secret, totp_enabled, full_name, email,
            created_by_user_id, auth_source, ldap_config_id, ldap_dn, roles, created_at`;
    let row = db.prepare(`SELECT ${cols}
        FROM proxy_users WHERE username = $u AND roles LIKE '%admin%'`).get({ $u: login }) as any;
    if (!row && login.includes('@')) {
        row = db.prepare(`SELECT ${cols}
            FROM proxy_users WHERE email = $e AND email != '' AND roles LIKE '%admin%'`).get({ $e: login.toLowerCase() }) as any;
    }
    if (!row) return null;
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

const ADMIN_COLS = `id, username, full_name, email, totp_enabled, created_by_user_id,
    auth_source, ldap_config_id, ldap_dn, roles, created_at`;

export function listAdmins(): AuthUser[] {
    if (!db) return [];
    const rows = db.prepare(`SELECT ${ADMIN_COLS} FROM proxy_users
        WHERE roles LIKE '%admin%' ORDER BY created_at ASC`).all() as any[];
    return rows.map(rowToAuthUser);
}

export function getAdmin(id: number): AuthUser | null {
    if (!db) return null;
    const row = db.prepare(`SELECT ${ADMIN_COLS} FROM proxy_users
        WHERE id = $id AND roles LIKE '%admin%'`).get({ $id: id }) as any;
    return row ? rowToAuthUser(row) : null;
}

export function countAdmins(): number {
    if (!db) return 0;
    const row = db.prepare("SELECT COUNT(*) as c FROM proxy_users WHERE roles LIKE '%admin%'").get() as any;
    return row?.c || 0;
}

/** Create an additional admin. TOTP is not set yet — the new admin sets it up on first login. */
export async function createAdditionalAdmin(
    username: string, password: string, fullName: string, email: string, createdByUserId: number,
): Promise<AuthUser> {
    if (!db) throw new Error('Auth not initialized');
    const hash = await Bun.password.hash(password, 'bcrypt');
    // If a row with the same username already exists (e.g. a proxy user being
    // promoted), just grant it the admin role instead of creating a duplicate.
    const existing = db.prepare("SELECT id, roles FROM proxy_users WHERE username = $u").get({ $u: username }) as any;
    if (existing) {
        const roles = String(existing.roles || 'proxy').split(',').map((r: string) => r.trim()).filter(Boolean);
        if (!roles.includes('admin')) roles.push('admin');
        if (!roles.includes('proxy')) roles.push('proxy');
        db.prepare(`UPDATE proxy_users
            SET password = $p, totp_secret = '', totp_enabled = 0,
                full_name = $fn, email = $em, created_by_user_id = $cb,
                roles = $r, updated_at = datetime('now')
            WHERE id = $id`).run({
            $p: hash, $fn: fullName.trim(), $em: email.trim().toLowerCase(),
            $cb: createdByUserId, $r: roles.join(','), $id: existing.id,
        });
        const row = db.prepare(`SELECT ${ADMIN_COLS} FROM proxy_users WHERE id = $id`).get({ $id: existing.id }) as any;
        return rowToAuthUser(row);
    }
    db.prepare(`INSERT INTO proxy_users
        (username, password, totp_secret, totp_enabled, full_name, email,
         created_by_user_id, roles)
        VALUES ($u, $p, '', 0, $fn, $em, $cb, 'admin,proxy')`)
        .run({ $u: username, $p: hash, $fn: fullName.trim(), $em: email.trim().toLowerCase(), $cb: createdByUserId });
    const row = db.prepare(`SELECT ${ADMIN_COLS} FROM proxy_users WHERE username = $u`).get({ $u: username }) as any;
    return rowToAuthUser(row);
}

/** Delete an admin. Refuses to drop below 1 admin. Caller MUST prevent self-deletion.
 *  Cascades to all OAuth tokens, sessions, SSO via the FKs. */
export function deleteAdmin(id: number): { deleted: boolean; reason?: string } {
    if (!db) return { deleted: false, reason: 'Auth not initialized' };
    if (countAdmins() <= 1) return { deleted: false, reason: 'Cannot delete the last admin' };
    const result = db.prepare("DELETE FROM proxy_users WHERE id = $id AND roles LIKE '%admin%'").run({ $id: id });
    if (result.changes === 0) return { deleted: false, reason: 'Admin not found' };
    return { deleted: true };
}

export async function updateAdminPassword(id: number, newPassword: string): Promise<boolean> {
    if (!db) return false;
    // Refuse to set a local password on an LDAP-sourced row — password lives in
    // the directory.
    const row = db.prepare("SELECT auth_source, roles FROM proxy_users WHERE id = $id").get({ $id: id }) as any;
    if (!row || !String(row.roles || '').includes('admin')) return false;
    if (row.auth_source === 'ldap') return false;
    const hash = await Bun.password.hash(newPassword, 'bcrypt');
    const result = db.prepare("UPDATE proxy_users SET password = $p, updated_at = datetime('now') WHERE id = $id")
        .run({ $p: hash, $id: id });
    return result.changes > 0;
}

/** Returns the stored TOTP secret for an admin (empty string if none). */
export function getAdminTotpSecret(id: number): string {
    if (!db) return '';
    const row = db.prepare("SELECT totp_secret FROM proxy_users WHERE id = $id AND roles LIKE '%admin%'").get({ $id: id }) as any;
    return row?.totp_secret || '';
}

/** Used during first login when the admin hasn't yet configured TOTP. */
export function setAdminTotp(id: number, totpSecret: string): boolean {
    if (!db) return false;
    const result = db.prepare(`UPDATE proxy_users
        SET totp_secret = $t, totp_enabled = 1, updated_at = datetime('now')
        WHERE id = $id AND roles LIKE '%admin%'`).run({ $t: totpSecret, $id: id });
    return result.changes > 0;
}

// ─── LDAP-sourced admins ────────────────────────────────────────────────────

export interface LdapAdminProvisionInput {
    ldapConfigId: number;
    ldapDn: string;
    username: string;
    fullName: string;
    email: string;
}

/** Find an admin (any source) by (ldap_config_id, ldap_dn). */
export function findLdapShadowAdmin(ldapConfigId: number, ldapDn: string): AuthUser | null {
    if (!db) return null;
    const row = db.prepare(`SELECT ${ADMIN_COLS} FROM proxy_users
        WHERE auth_source = 'ldap' AND ldap_config_id = $cid AND ldap_dn = $dn
          AND roles LIKE '%admin%'`)
        .get({ $cid: ldapConfigId, $dn: ldapDn }) as any;
    return row ? rowToAuthUser(row) : null;
}

/** Create or refresh an LDAP-sourced admin. Returns null on username collision
 *  with a row that is not already this same LDAP user (local-wins). */
export function upsertLdapShadowAdmin(input: LdapAdminProvisionInput): AuthUser | null {
    if (!db) return null;
    const existing = findLdapShadowAdmin(input.ldapConfigId, input.ldapDn);
    if (existing) {
        db.prepare(`UPDATE proxy_users SET full_name = $fn, email = $em, updated_at = datetime('now')
            WHERE id = $id`).run({ $fn: input.fullName.trim(), $em: input.email.trim().toLowerCase(), $id: existing.id });
        return getAdmin(existing.id);
    }
    const collision = db.prepare("SELECT id FROM proxy_users WHERE username = $u").get({ $u: input.username }) as any;
    if (collision) return null;
    db.prepare(`INSERT INTO proxy_users
        (username, password, totp_secret, totp_enabled, full_name, email,
         auth_source, ldap_config_id, ldap_dn, roles)
        VALUES ($u, '', '', 0, $fn, $em, 'ldap', $cid, $dn, 'admin,proxy')`)
        .run({ $u: input.username, $fn: input.fullName.trim(), $em: input.email.trim().toLowerCase(),
            $cid: input.ldapConfigId, $dn: input.ldapDn });
    const row = db.prepare(`SELECT ${ADMIN_COLS} FROM proxy_users WHERE username = $u`).get({ $u: input.username }) as any;
    return row ? rowToAuthUser(row) : null;
}

/** Returns true if any non-LDAP admin exists. */
export function hasLocalAdmins(): boolean {
    if (!db) return false;
    const row = db.prepare(`SELECT COUNT(*) as c FROM proxy_users
        WHERE roles LIKE '%admin%' AND (auth_source = 'local' OR auth_source IS NULL)`).get() as any;
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
        SELECT s.id, s.expires_at, u.id as user_id, u.username, u.created_at, u.roles
        FROM sessions s JOIN proxy_users u ON s.user_id = u.id
        WHERE s.id = $id
    `).get({ $id: sessionId }) as any;
    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
        db.prepare('DELETE FROM sessions WHERE id = $id').run({ $id: sessionId });
        return null;
    }
    // A dashboard session is only valid if the underlying account still carries
    // the admin role (an admin demoted via Audit/SQL invalidates open sessions).
    if (!String(row.roles || '').includes('admin')) {
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

/** Peek: returns true if the key is still under the limit. Does NOT increment.
 *  Call this BEFORE attempting credentials to block already-saturated keys.
 *  Pass a higher `max` for coarse-grained keys (e.g. per-IP behind corporate
 *  NAT — many legitimate users share one egress IP). */
export function checkRateLimit(key: string, max: number = MAX_ATTEMPTS): boolean {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || entry.resetAt < now) return true;
    return entry.count < max;
}

/** Increment failure counter for the key. Call this only on FAILED auth
 *  attempts — successful logins must not consume budget, otherwise a busy user
 *  locks themselves out. */
export function recordFailedAttempt(key: string): void {
    const now = Date.now();
    if (attempts.size >= MAX_RATE_LIMIT_ENTRIES) {
        const oldest = attempts.keys().next().value;
        if (oldest) attempts.delete(oldest);
    }
    const entry = attempts.get(key);
    if (!entry || entry.resetAt < now) {
        attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return;
    }
    entry.count++;
}

/** Per-IP threshold. Generous so corporate NATs (one egress IP for many users)
 *  don't lock everyone out when one person mistypes. The per-username bucket
 *  is the real defence against brute-force on a specific account. */
export const MAX_ATTEMPTS_PER_IP = 50;

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
        force2faSetup: !!r.force_2fa_setup,
        createdAt: r.created_at,
        authSource: (r.auth_source || 'local') as 'local' | 'ldap',
        ldapConfigId: r.ldap_config_id ?? null,
        ldapDn: r.ldap_dn ?? null,
        ldapOrphan: !!r.ldap_orphan,
        isAdmin: typeof r.roles === 'string' && r.roles.split(',').map((s: string) => s.trim()).includes('admin'),
    };
}

export async function createProxyUser(username: string, password: string, fullName = '', email = ''): Promise<ProxyUser> {
    if (!db) throw new Error('Auth not initialized');
    const hash = await Bun.password.hash(password, 'bcrypt');
    db.prepare('INSERT INTO proxy_users (username, full_name, email, password) VALUES ($u, $fn, $em, $p)')
        .run({ $u: username, $fn: fullName.trim(), $em: email.trim().toLowerCase(), $p: hash });
    const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, force_2fa_setup, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
    return rowToProxyUser(row);
}

export function listAllProxyUsers(): ProxyUser[] {
    if (!db) return [];
    // Filter legacy 'admin_shadow' rows — they're remnants of the pre-merge era
    // (admins lived in a separate table and had mirror rows here). After the
    // migration any admin is just a regular row with 'admin' in `roles`.
    const rows = db.prepare(
        "SELECT id, username, full_name, email, totp_enabled, force_2fa_setup, auth_source, ldap_config_id, ldap_dn, ldap_orphan, roles, created_at FROM proxy_users WHERE auth_source != 'admin_shadow' ORDER BY username"
    ).all() as any[];
    return rows.map(rowToProxyUser);
}

export function getProxyUser(id: number): ProxyUser | null {
    if (!db) return null;
    const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, force_2fa_setup, auth_source, ldap_config_id, ldap_dn, ldap_orphan, roles, created_at FROM proxy_users WHERE id = $id').get({ $id: id }) as any;
    return row ? rowToProxyUser(row) : null;
}

/** Atomically add or remove the 'admin' role from a user, preserving any other
 *  roles (e.g. 'proxy'). Returns true if a row was actually updated. */
export function setProxyUserAdminRole(id: number, makeAdmin: boolean): boolean {
    if (!db) return false;
    const row = db.prepare('SELECT roles FROM proxy_users WHERE id = $id').get({ $id: id }) as any;
    if (!row) return false;
    const current: string[] = String(row.roles || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const has = current.includes('admin');
    if (makeAdmin === has) return false; // no-op
    const next = makeAdmin
        ? [...current, 'admin']
        : current.filter(r => r !== 'admin');
    // Ensure at least 'proxy' is kept if nothing else remains.
    if (next.length === 0) next.push('proxy');
    db.prepare("UPDATE proxy_users SET roles = $r, updated_at = datetime('now') WHERE id = $id")
        .run({ $r: next.join(','), $id: id });
    return true;
}

export function deleteProxyUser(id: number): boolean {
    if (!db) return false;
    // Refuse to delete via the proxy-user page if the row carries the admin role
    // — these are managed in the Admins page (which also enforces the
    // "at least one admin" guard).
    const row = db.prepare("SELECT roles FROM proxy_users WHERE id = $id").get({ $id: id }) as any;
    if (row && String(row.roles || '').includes('admin')) return false;
    const result = db.prepare('DELETE FROM proxy_users WHERE id = $id').run({ $id: id });
    return result.changes > 0;
}

export async function updateProxyUserPassword(id: number, newPassword: string): Promise<boolean> {
    if (!db) return false;
    const row = db.prepare("SELECT auth_source FROM proxy_users WHERE id = $id").get({ $id: id }) as any;
    if (row?.auth_source === 'ldap') return false;
    const hash = await Bun.password.hash(newPassword, 'bcrypt');
    const result = db.prepare("UPDATE proxy_users SET password = $p, updated_at = datetime('now') WHERE id = $id")
        .run({ $p: hash, $id: id });
    return result.changes > 0;
}

/** Find an existing proxy user by email or username (case-insensitive). */
export function findProxyUserByEmailOrUsername(email: string, username: string): ProxyUser | null {
    if (!db) return null;
    if (email) {
        const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, force_2fa_setup, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE email = $e AND email != \'\'').get({ $e: email.toLowerCase() }) as any;
        if (row) return rowToProxyUser(row);
    }
    if (username) {
        const row = db.prepare('SELECT id, username, full_name, email, totp_enabled, force_2fa_setup, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE username = $u').get({ $u: username }) as any;
        if (row) return rowToProxyUser(row);
    }
    return null;
}

export function updateProxyUserInfo(id: number, fullName: string, email: string): boolean {
    if (!db) return false;
    // LDAP-sourced rows are refreshed from the directory at login.
    const row = db.prepare("SELECT auth_source FROM proxy_users WHERE id = $id").get({ $id: id }) as any;
    if (row?.auth_source === 'ldap') return false;
    const result = db.prepare("UPDATE proxy_users SET full_name = $fn, email = $em, updated_at = datetime('now') WHERE id = $id")
        .run({ $fn: fullName.trim(), $em: email.trim().toLowerCase(), $id: id });
    return result.changes > 0;
}

/** Verify proxy user credentials by username OR email. Returns user + totpSecret or null. */
export async function verifyProxyUserCredentials(login: string, password: string): Promise<{ user: ProxyUser; totpSecret: string | null } | null> {
    if (!db) return null;
    // Try username first, then email
    let row = db.prepare('SELECT id, username, full_name, email, password, totp_secret, totp_enabled, force_2fa_setup, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE username = $u').get({ $u: login }) as any;
    if (!row && login.includes('@')) {
        row = db.prepare('SELECT id, username, full_name, email, password, totp_secret, totp_enabled, force_2fa_setup, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at FROM proxy_users WHERE email = $e').get({ $e: login.toLowerCase() }) as any;
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

/** Check if a proxy user has access to a specific profile. Considers both the
 *  explicit proxy_user_profiles association AND any matching LDAP group rule
 *  for shadow users (so LDAP-group access doesn't require pre-provisioning). */
export function proxyUserHasProfile(userId: number, profileName: string): boolean {
    if (!db) return false;
    const row = db.prepare('SELECT 1 FROM proxy_user_profiles WHERE user_id = $uid AND profile_name = $pn')
        .get({ $uid: userId, $pn: profileName.toLowerCase() }) as any;
    if (row) return true;
    return shadowUserMatchesProfileLdapGroups(userId, profileName);
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

// ─── Profile ↔ LDAP group rules ─────────────────────────────────────────────
// Mirrors the oauth_client_ldap_groups model. A profile with authMode='login'
// can grant access to anyone authenticated against an LDAP directory whose
// cached groups match one of the configured rules for that profile.

export interface ProfileLdapGroup {
    id: number;
    profileName: string;
    ldapConfigId: number;
    groupMatch: string;
    createdAt: string;
}

function rowToProfileLdapGroup(r: any): ProfileLdapGroup {
    return {
        id: r.id,
        profileName: r.profile_name,
        ldapConfigId: r.ldap_config_id,
        groupMatch: r.group_match,
        createdAt: r.created_at,
    };
}

export function listLdapGroupsForProfile(profileName: string): ProfileLdapGroup[] {
    if (!db) return [];
    const rows = db.prepare('SELECT * FROM proxy_profile_ldap_groups WHERE profile_name = $pn COLLATE NOCASE ORDER BY ldap_config_id, group_match')
        .all({ $pn: profileName }) as any[];
    return rows.map(rowToProfileLdapGroup);
}

export function addLdapGroupToProfile(profileName: string, ldapConfigId: number, groupMatch: string): ProfileLdapGroup | null {
    if (!db) return null;
    const match = (groupMatch || '').trim();
    if (!match) return null;
    try {
        db.prepare('INSERT OR IGNORE INTO proxy_profile_ldap_groups (profile_name, ldap_config_id, group_match) VALUES ($pn, $lcid, $gm)')
            .run({ $pn: profileName, $lcid: ldapConfigId, $gm: match });
    } catch { return null; }
    const row = db.prepare('SELECT * FROM proxy_profile_ldap_groups WHERE profile_name = $pn COLLATE NOCASE AND ldap_config_id = $lcid AND group_match = $gm COLLATE NOCASE')
        .get({ $pn: profileName, $lcid: ldapConfigId, $gm: match }) as any;
    return row ? rowToProfileLdapGroup(row) : null;
}

export function getProfileLdapGroupById(profileName: string, ruleId: number): ProfileLdapGroup | null {
    if (!db) return null;
    const row = db.prepare('SELECT * FROM proxy_profile_ldap_groups WHERE id = $id AND profile_name = $pn COLLATE NOCASE')
        .get({ $id: ruleId, $pn: profileName }) as any;
    return row ? rowToProfileLdapGroup(row) : null;
}

export function removeLdapGroupFromProfile(profileName: string, ruleId: number): boolean {
    if (!db) return false;
    const result = db.prepare('DELETE FROM proxy_profile_ldap_groups WHERE id = $id AND profile_name = $pn COLLATE NOCASE')
        .run({ $id: ruleId, $pn: profileName });
    return result.changes > 0;
}

export function removeAllProfileLdapGroups(profileName: string): number {
    if (!db) return 0;
    const result = db.prepare('DELETE FROM proxy_profile_ldap_groups WHERE profile_name = $pn COLLATE NOCASE')
        .run({ $pn: profileName });
    return result.changes;
}

/** Group-match strings configured for (profile_name, ldap_config_id). */
export function getProfileLdapGroupMatches(profileName: string, ldapConfigId: number): string[] {
    if (!db) return [];
    const rows = db.prepare('SELECT group_match FROM proxy_profile_ldap_groups WHERE profile_name = $pn COLLATE NOCASE AND ldap_config_id = $lcid')
        .all({ $pn: profileName, $lcid: ldapConfigId }) as any[];
    return rows.map(r => r.group_match);
}

/** Extract the CN (first RDN value) from a DN, lowercased. */
function profileCnOf(dn: string): string {
    const m = dn.match(/^\s*cn\s*=\s*((?:[^,\\]|\\.)+)/i);
    if (!m) return '';
    return m[1].replace(/\\(.)/g, '$1').trim().toLowerCase();
}

/** Pure check: do these LDAP groups satisfy any of the configured rules? */
export function profileLdapGroupsMatch(profileName: string, ldapConfigId: number, userGroups: string[]): boolean {
    const rules = getProfileLdapGroupMatches(profileName, ldapConfigId);
    if (rules.length === 0 || userGroups.length === 0) return false;
    const wantDn = new Set<string>();
    const wantCn = new Set<string>();
    let wildcard = false;
    for (const raw of rules) {
        const v = raw.trim();
        if (!v) continue;
        if (v === '*') { wildcard = true; continue; }
        if (/^cn\s*=/i.test(v) && v.includes(',')) wantDn.add(v.toLowerCase());
        else wantCn.add(v.replace(/^cn\s*=\s*/i, '').toLowerCase());
    }
    if (wildcard) return true;
    for (const g of userGroups) {
        const dn = String(g);
        if (wantDn.has(dn.toLowerCase())) return true;
        const cn = profileCnOf(dn);
        if (cn && wantCn.has(cn)) return true;
    }
    return false;
}

/** Returns true if any profile has at least one LDAP rule for this directory. */
export function listProfilesWithLdapGroupsForConfig(ldapConfigId: number): string[] {
    if (!db) return [];
    const rows = db.prepare('SELECT DISTINCT profile_name FROM proxy_profile_ldap_groups WHERE ldap_config_id = $lcid')
        .all({ $lcid: ldapConfigId }) as any[];
    return rows.map(r => r.profile_name);
}

/** Checks LDAP-based access for a shadow user against a profile, using the
 *  user's cached groups (proxy_users.ldap_groups_last_seen). Returns true if
 *  the user is a non-orphan shadow account whose groups satisfy any rule for
 *  the given profile. */
export function shadowUserMatchesProfileLdapGroups(userId: number, profileName: string): boolean {
    if (!db) return false;
    const user = db.prepare('SELECT auth_source, ldap_config_id, ldap_orphan, ldap_groups_last_seen FROM proxy_users WHERE id = $uid')
        .get({ $uid: userId }) as any;
    if (!user || user.auth_source !== 'ldap' || user.ldap_orphan || !user.ldap_config_id) return false;
    let groups: string[] = [];
    try { groups = JSON.parse(user.ldap_groups_last_seen || '[]'); } catch {}
    return profileLdapGroupsMatch(profileName, user.ldap_config_id, groups);
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
    autoAdoptLocal?: boolean;  // When true, allows adopting a local row whose email matches.
}

export type LdapProvisionOutcome =
    | { ok: true; user: ProxyUser; adopted?: { eventId: number; previousAuthSource: string; matchedOn: 'email' } }
    | { ok: false; reason: 'username_collision' | 'multi_directory_conflict' | 'local_has_totp' | 'auto_adopt_disabled' | 'auth_unavailable';
        collidingUserId?: number; otherConfigId?: number }
;

export function findLdapShadowProxyUser(ldapConfigId: number, ldapDn: string): ProxyUser | null {
    if (!db) return null;
    // AD/LDAP DNs are case-insensitive by spec; compare without case so that a
    // CN re-cased by the directory server doesn't orphan an existing shadow row.
    const row = db.prepare(`SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, created_at
        FROM proxy_users WHERE auth_source = 'ldap' AND ldap_config_id = $cid AND ldap_dn = $dn COLLATE NOCASE`)
        .get({ $cid: ldapConfigId, $dn: ldapDn }) as any;
    return row ? rowToProxyUser(row) : null;
}

/** Idempotent provisioning of an LDAP-sourced proxy_users row.
 *
 *  Behaviour (in order):
 *    A) Same (ldap_config_id, ldap_dn) already exists → update attrs/groups.
 *    B) Email collides with a row sourced from a DIFFERENT LDAP directory →
 *       refuse (multi_directory_conflict). Sign of misconfiguration.
 *    C) Email collides with a LOCAL row:
 *         - if !autoAdoptLocal → refuse (auto_adopt_disabled)
 *         - if local row has TOTP → refuse (local_has_totp): protecting
 *           deliberately-secured account
 *         - else → ADOPT: mutate the local row to LDAP, queue an
 *           ldap_adoption_event in 'pending' state for admin confirmation
 *    D) Username collides with another non-LDAP row (no email match) → refuse
 *       (username_collision).
 *    E) Otherwise → INSERT a fresh row.
 *
 *  The legacy `null` return path of older callers is preserved by exporting
 *  a thin wrapper `upsertLdapShadowProxyUser` that maps `{ok:false}` → null.
 */
export function upsertLdapShadowProxyUserDetailed(input: LdapProxyProvisionInput): LdapProvisionOutcome {
    if (!db) return { ok: false, reason: 'auth_unavailable' };
    const groupsJson = JSON.stringify(Array.isArray(input.groups) ? input.groups : []);
    const normalizedEmail = input.email.trim().toLowerCase();
    const cleanFullName = input.fullName.trim();

    // A) Same LDAP identity → straight update.
    const existing = findLdapShadowProxyUser(input.ldapConfigId, input.ldapDn);
    if (existing) {
        db.prepare(`UPDATE proxy_users
            SET full_name = $fn, email = $em,
                ldap_groups_last_seen = $g, ldap_last_sync_at = datetime('now'),
                ldap_orphan = 0, updated_at = datetime('now')
            WHERE id = $id`)
            .run({ $fn: cleanFullName, $em: normalizedEmail, $g: groupsJson, $id: existing.id });
        const updated = getProxyUser(existing.id);
        return updated ? { ok: true, user: updated } : { ok: false, reason: 'auth_unavailable' };
    }

    // B+C) Look for an email collision (only if we have a non-empty email).
    if (normalizedEmail) {
        const emailRow = db.prepare(`SELECT id, auth_source, ldap_config_id, totp_enabled, password, username, email, roles
            FROM proxy_users WHERE email = $e AND email != ''`).get({ $e: normalizedEmail }) as any;
        if (emailRow) {
            if (emailRow.auth_source === 'ldap' && emailRow.ldap_config_id !== input.ldapConfigId) {
                // B) Cross-directory conflict — always refuse.
                return { ok: false, reason: 'multi_directory_conflict', collidingUserId: emailRow.id, otherConfigId: emailRow.ldap_config_id };
            }
            if (emailRow.auth_source === 'ldap' && emailRow.ldap_config_id === input.ldapConfigId) {
                // Same directory, same email — the row is the same identity but
                // findLdapShadowProxyUser missed it (likely because the stored
                // ldap_dn drifted from what the directory now returns: re-cased
                // CN, moved OU, etc.). Refresh the DN and attrs in place
                // instead of falling through to the username_collision branch.
                db.prepare(`UPDATE proxy_users
                    SET ldap_dn = $dn, full_name = $fn, username = $u,
                        ldap_groups_last_seen = $g, ldap_last_sync_at = datetime('now'),
                        ldap_orphan = 0, updated_at = datetime('now')
                    WHERE id = $id`)
                    .run({ $dn: input.ldapDn, $fn: cleanFullName, $u: input.username, $g: groupsJson, $id: emailRow.id });
                const refreshed = getProxyUser(emailRow.id);
                return refreshed ? { ok: true, user: refreshed } : { ok: false, reason: 'auth_unavailable' };
            }
            if (emailRow.auth_source === 'local' || emailRow.auth_source === null) {
                // C) Local match — adopt only if explicitly opted in and the
                //    local row does NOT have TOTP enabled.
                if (!input.autoAdoptLocal) {
                    return { ok: false, reason: 'auto_adopt_disabled', collidingUserId: emailRow.id };
                }
                if (emailRow.totp_enabled) {
                    return { ok: false, reason: 'local_has_totp', collidingUserId: emailRow.id };
                }
                // Snapshot for reversal.
                const eventResult = db.prepare(`INSERT INTO ldap_adoption_events
                    (proxy_user_id, ldap_config_id, ldap_dn, matched_on, matched_value,
                     previous_auth_source, previous_password_hash, previous_username, previous_email, state)
                    VALUES ($pid, $cid, $dn, 'email', $mv, $pas, $pph, $pun, $pem, 'pending')`).run({
                    $pid: emailRow.id,
                    $cid: input.ldapConfigId,
                    $dn: input.ldapDn,
                    $mv: normalizedEmail,
                    $pas: emailRow.auth_source || 'local',
                    $pph: emailRow.password || '',
                    $pun: emailRow.username,
                    $pem: emailRow.email,
                });
                const eventId = Number(eventResult.lastInsertRowid);
                db.prepare(`UPDATE proxy_users SET
                    auth_source = 'ldap',
                    ldap_config_id = $cid,
                    ldap_dn = $dn,
                    password = '',
                    totp_secret = NULL,
                    totp_enabled = 0,
                    ldap_groups_last_seen = $g,
                    ldap_last_sync_at = datetime('now'),
                    ldap_orphan = 0,
                    full_name = $fn,
                    username = $u,
                    updated_at = datetime('now')
                    WHERE id = $id`).run({
                    $cid: input.ldapConfigId, $dn: input.ldapDn, $g: groupsJson,
                    $fn: cleanFullName, $u: input.username, $id: emailRow.id,
                });
                const adopted = getProxyUser(emailRow.id);
                if (!adopted) return { ok: false, reason: 'auth_unavailable' };
                return { ok: true, user: adopted, adopted: { eventId, previousAuthSource: emailRow.auth_source || 'local', matchedOn: 'email' } };
            }
        }
    }

    // D) Username collision without email match.
    const usernameCollision = db.prepare(`SELECT id, auth_source, ldap_config_id FROM proxy_users WHERE username = $u`).get({ $u: input.username }) as any;
    if (usernameCollision) {
        if (usernameCollision.auth_source === 'ldap' && usernameCollision.ldap_config_id === input.ldapConfigId) {
            // Same directory, same username — same identity as A, but the stored
            // ldap_dn drifted. Refresh in place instead of refusing.
            db.prepare(`UPDATE proxy_users
                SET ldap_dn = $dn, full_name = $fn, email = $em,
                    ldap_groups_last_seen = $g, ldap_last_sync_at = datetime('now'),
                    ldap_orphan = 0, updated_at = datetime('now')
                WHERE id = $id`)
                .run({ $dn: input.ldapDn, $fn: cleanFullName, $em: normalizedEmail, $g: groupsJson, $id: usernameCollision.id });
            const refreshed = getProxyUser(usernameCollision.id);
            return refreshed ? { ok: true, user: refreshed } : { ok: false, reason: 'auth_unavailable' };
        }
        return { ok: false, reason: 'username_collision', collidingUserId: usernameCollision.id };
    }

    // E) Fresh insert.
    db.prepare(`INSERT INTO proxy_users
        (username, full_name, email, password, totp_secret, totp_enabled,
         auth_source, ldap_config_id, ldap_dn, ldap_groups_last_seen, ldap_last_sync_at, roles)
        VALUES ($u, $fn, $em, '', NULL, 0, 'ldap', $cid, $dn, $g, datetime('now'), 'proxy')`)
        .run({
            $u: input.username, $fn: cleanFullName, $em: normalizedEmail,
            $cid: input.ldapConfigId, $dn: input.ldapDn, $g: groupsJson,
        });
    const row = db.prepare(`SELECT id, username, full_name, email, totp_enabled, auth_source, ldap_config_id, ldap_dn, ldap_orphan, created_at
        FROM proxy_users WHERE username = $u`).get({ $u: input.username }) as any;
    const created = row ? rowToProxyUser(row) : null;
    return created ? { ok: true, user: created } : { ok: false, reason: 'auth_unavailable' };
}

/** Legacy wrapper. Returns the user on success, null on any failure mode.
 *  Use upsertLdapShadowProxyUserDetailed when you need to distinguish reasons. */
export function upsertLdapShadowProxyUser(input: LdapProxyProvisionInput): ProxyUser | null {
    const outcome = upsertLdapShadowProxyUserDetailed(input);
    return outcome.ok ? outcome.user : null;
}

// ─── LDAP adoption events ───────────────────────────────────────────────────

export interface LdapAdoptionEvent {
    id: number;
    proxyUserId: number;
    ldapConfigId: number;
    ldapDn: string;
    matchedOn: string;
    matchedValue: string;
    previousAuthSource: string;
    previousUsername: string;
    previousEmail: string;
    state: 'pending' | 'confirmed' | 'reverted';
    createdAt: string;
    resolvedAt: string | null;
    resolvedBy: number | null;
}

function rowToAdoptionEvent(r: any): LdapAdoptionEvent {
    return {
        id: r.id,
        proxyUserId: r.proxy_user_id,
        ldapConfigId: r.ldap_config_id,
        ldapDn: r.ldap_dn,
        matchedOn: r.matched_on,
        matchedValue: r.matched_value,
        previousAuthSource: r.previous_auth_source,
        previousUsername: r.previous_username || '',
        previousEmail: r.previous_email || '',
        state: (r.state || 'pending') as 'pending' | 'confirmed' | 'reverted',
        createdAt: r.created_at,
        resolvedAt: r.resolved_at || null,
        resolvedBy: r.resolved_by ?? null,
    };
}

export function listAdoptionEvents(state?: 'pending' | 'confirmed' | 'reverted'): LdapAdoptionEvent[] {
    if (!db) return [];
    const rows = state
        ? db.prepare(`SELECT id, proxy_user_id, ldap_config_id, ldap_dn, matched_on, matched_value,
            previous_auth_source, previous_username, previous_email, state, created_at, resolved_at, resolved_by
            FROM ldap_adoption_events WHERE state = $s ORDER BY created_at DESC`).all({ $s: state }) as any[]
        : db.prepare(`SELECT id, proxy_user_id, ldap_config_id, ldap_dn, matched_on, matched_value,
            previous_auth_source, previous_username, previous_email, state, created_at, resolved_at, resolved_by
            FROM ldap_adoption_events ORDER BY created_at DESC LIMIT 200`).all() as any[];
    return rows.map(rowToAdoptionEvent);
}

export function countPendingAdoptions(): number {
    if (!db) return 0;
    const row = db.prepare("SELECT COUNT(*) AS c FROM ldap_adoption_events WHERE state = 'pending'").get() as any;
    return row?.c || 0;
}

export function confirmAdoption(eventId: number, resolvedBy: number): boolean {
    if (!db) return false;
    const result = db.prepare(`UPDATE ldap_adoption_events
        SET state = 'confirmed', resolved_at = datetime('now'), resolved_by = $rb
        WHERE id = $id AND state = 'pending'`).run({ $id: eventId, $rb: resolvedBy });
    return result.changes > 0;
}

/** Revert an adoption: restore the original local row, detach it from LDAP, and
 *  recreate a fresh LDAP row for the directory user so they keep working. */
export interface AdoptionRevertResult {
    reverted: boolean;
    restoredUserId?: number;
    newLdapUserId?: number;
}

export function revertAdoption(eventId: number, resolvedBy: number): AdoptionRevertResult {
    if (!db) return { reverted: false };
    const event = db.prepare("SELECT * FROM ldap_adoption_events WHERE id = $id AND state = 'pending'").get({ $id: eventId }) as any;
    if (!event) return { reverted: false };

    // 1) Restore the row to its previous local form.
    db.prepare(`UPDATE proxy_users SET
        auth_source = $as,
        ldap_config_id = NULL,
        ldap_dn = NULL,
        ldap_groups_last_seen = '[]',
        ldap_last_sync_at = NULL,
        ldap_orphan = 0,
        password = $pwd,
        username = $un,
        email = $em,
        totp_secret = NULL,
        totp_enabled = 0,
        updated_at = datetime('now')
        WHERE id = $id`).run({
        $as: event.previous_auth_source || 'local',
        $pwd: event.previous_password_hash || '',
        $un: event.previous_username || '',
        $em: event.previous_email || '',
        $id: event.proxy_user_id,
    });

    // 2) Mark the event reverted.
    db.prepare(`UPDATE ldap_adoption_events
        SET state = 'reverted', resolved_at = datetime('now'), resolved_by = $rb
        WHERE id = $id`).run({ $id: eventId, $rb: resolvedBy });

    return { reverted: true, restoredUserId: event.proxy_user_id };
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
    const result = db.prepare("UPDATE proxy_users SET totp_secret = $t, totp_enabled = 1, force_2fa_setup = 0, updated_at = datetime('now') WHERE id = $id")
        .run({ $t: totpSecret, $id: userId });
    return result.changes > 0;
}

export function disableProxyUserTotp(userId: number): boolean {
    if (!db) return false;
    const result = db.prepare("UPDATE proxy_users SET totp_secret = NULL, totp_enabled = 0, force_2fa_setup = 0, updated_at = datetime('now') WHERE id = $id")
        .run({ $id: userId });
    return result.changes > 0;
}

/** Mark (or clear) the flag that forces a user to set up TOTP on next login.
 *  When `force=true`, also clear any existing TOTP secret so the user goes
 *  through a fresh setup flow (reconfigure). */
export function setProxyUserForce2faSetup(userId: number, force: boolean): boolean {
    if (!db) return false;
    const sql = force
        ? "UPDATE proxy_users SET force_2fa_setup = 1, totp_secret = NULL, totp_enabled = 0, updated_at = datetime('now') WHERE id = $id"
        : "UPDATE proxy_users SET force_2fa_setup = 0, updated_at = datetime('now') WHERE id = $id";
    return db.prepare(sql).run({ $id: userId }).changes > 0;
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
    /** Primary profile (first of profileNames). Kept for back-compat. */
    profileName: string;
    profileNames: string[];
    oauthClientIds: string[];
    email: string;
    invitedName: string;
    expiresAt: string;
    usedAt: string | null;
    usedBy: string | null;
    createdAt: string;
}

function _csvToArr(s: any): string[] {
    return typeof s === 'string' ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
}

function rowToInvite(row: any): InviteToken {
    const profileNames = _csvToArr(row.profiles);
    return {
        token: row.token,
        note: row.note,
        profileName: profileNames[0] || '',
        profileNames,
        oauthClientIds: _csvToArr(row.oauth_client_ids),
        email: row.email || '',
        invitedName: row.invited_name || '',
        expiresAt: row.expires_at,
        usedAt: row.used_at || null,
        usedBy: row.used_by || null,
        createdAt: row.created_at,
    };
}

export function createInviteToken(profileNames: string[], oauthClientIds: string[], email: string, invitedName: string, note: string, expiresInHours: number): InviteToken {
    if (!db) throw new Error('Auth not initialized');
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000).toISOString();
    const profilesCsv = profileNames.map(p => p.toLowerCase().trim()).filter(Boolean).join(',');
    const clientsCsv = oauthClientIds.map(c => c.trim()).filter(Boolean).join(',');
    db.prepare('INSERT INTO invite_tokens (token, note, profiles, oauth_client_ids, email, invited_name, expires_at) VALUES ($t, $n, $p, $oc, $em, $in, $e)')
        .run({ $t: token, $n: note, $p: profilesCsv, $oc: clientsCsv, $em: email.trim().toLowerCase(), $in: invitedName.trim(), $e: expiresAt });
    return {
        token, note,
        profileName: profilesCsv.split(',')[0] || '',
        profileNames: profilesCsv ? profilesCsv.split(',') : [],
        oauthClientIds: clientsCsv ? clientsCsv.split(',') : [],
        email: email.trim().toLowerCase(),
        invitedName: invitedName.trim(),
        expiresAt, usedAt: null, usedBy: null,
        createdAt: new Date().toISOString(),
    };
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
