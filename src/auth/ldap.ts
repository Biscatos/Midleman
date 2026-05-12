// LDAP integration — Phase 1.
//
// Provides:
//   - SQLite schema for ldap_configs (one row per directory)
//   - CRUD helpers
//   - AES-256-GCM encryption of the bind password, keyed by a value derived
//     from the existing JWT RSA private key (DATA_DIR/jwt-key.pem). No new
//     secret to manage.
//   - A connection pool (one ldapts Client per config) with keep-alive, sized
//     for the >100 logins/min target.
//   - `authenticate(configId, login, password)` → resolves user attrs + groups
//     after a successful re-bind as the user.
//   - `testLdapConfig(...)` → admin bind + search, returns diagnostic.
//
// Login wiring (mapping LDAP → admin/proxy users) is deliberately NOT in this
// file. It will land in Phase 2/4.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Client, type SearchOptions } from 'ldapts';
import { getAuthDb } from './auth';

// ─── Schema ─────────────────────────────────────────────────────────────────

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS ldap_configs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL UNIQUE COLLATE NOCASE,
    url                 TEXT NOT NULL,
    bind_dn             TEXT NOT NULL DEFAULT '',
    bind_password_enc   TEXT NOT NULL DEFAULT '',
    base_dn             TEXT NOT NULL,
    user_filter         TEXT NOT NULL DEFAULT '(|(uid={login})(mail={login})(sAMAccountName={login}))',
    username_attr       TEXT NOT NULL DEFAULT 'uid',
    email_attr          TEXT NOT NULL DEFAULT 'mail',
    fullname_attr       TEXT NOT NULL DEFAULT 'cn',
    group_attr          TEXT NOT NULL DEFAULT 'memberOf',
    start_tls           INTEGER NOT NULL DEFAULT 0,
    tls_verify          INTEGER NOT NULL DEFAULT 1,
    scope               TEXT NOT NULL DEFAULT 'both',
    totp_policy         TEXT NOT NULL DEFAULT 'optional',
    enabled             INTEGER NOT NULL DEFAULT 1,
    timeout_ms          INTEGER NOT NULL DEFAULT 5000,
    default_profile     TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ldap_configs_enabled ON ldap_configs(enabled);

CREATE TABLE IF NOT EXISTS ldap_admin_groups (
    ldap_config_id  INTEGER NOT NULL,
    group_dn        TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (ldap_config_id, group_dn)
);
`;

export type LdapScope = 'admin' | 'proxy' | 'both';
export type LdapTotpPolicy = 'disabled' | 'optional' | 'required';

export interface LdapConfig {
    id: number;
    name: string;
    url: string;             // ldap://... or ldaps://...
    bindDn: string;
    baseDn: string;
    userFilter: string;      // contains {login} placeholder
    usernameAttr: string;
    emailAttr: string;
    fullnameAttr: string;
    groupAttr: string;       // attr that holds group DNs on the user entry (AD: memberOf)
    startTls: boolean;
    tlsVerify: boolean;
    scope: LdapScope;
    totpPolicy: LdapTotpPolicy;
    enabled: boolean;
    timeoutMs: number;
    defaultProfile: string;  // profile assigned to new proxy shadow users; '' = none
    adminGroups: string[];   // group DNs that grant admin role
    createdAt: string;
    updatedAt: string;
}

export interface LdapConfigInput {
    name: string;
    url: string;
    bindDn?: string;
    bindPassword?: string; // plaintext; only persisted on create/update
    baseDn: string;
    userFilter?: string;
    usernameAttr?: string;
    emailAttr?: string;
    fullnameAttr?: string;
    groupAttr?: string;
    startTls?: boolean;
    tlsVerify?: boolean;
    scope?: LdapScope;
    totpPolicy?: LdapTotpPolicy;
    enabled?: boolean;
    timeoutMs?: number;
    defaultProfile?: string;
    adminGroups?: string[];
}

// ─── Encryption key (derived from JWT RSA private key on disk) ──────────────

let encKey: Buffer | null = null;
let dataDirCached: string = '';

function deriveEncKey(dataDir: string): Buffer {
    const keyPath = resolve(dataDir, 'jwt-key.pem');
    if (!existsSync(keyPath)) {
        // initJwt() should always run first. If we hit this, fail loudly
        // rather than silently using a weak key.
        throw new Error('LDAP: jwt-key.pem not found — initJwt() must run before initLdap()');
    }
    const pem = readFileSync(keyPath, 'utf-8');
    // Domain-separate so the same input never produces a key reused elsewhere.
    return createHash('sha256').update('midleman:ldap:bindpw:v1\n').update(pem).digest();
}

function encryptBindPassword(plaintext: string): string {
    if (!plaintext) return '';
    if (!encKey) throw new Error('LDAP not initialized');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: v1:base64(iv):base64(tag):base64(ct)
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptBindPassword(encoded: string): string {
    if (!encoded) return '';
    if (!encKey) throw new Error('LDAP not initialized');
    const parts = encoded.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
        throw new Error('LDAP: malformed bind_password_enc');
    }
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf-8');
}

// ─── Init / shutdown ────────────────────────────────────────────────────────

export function initLdap(dataDir: string): void {
    const db = getAuthDb();
    if (!db) {
        console.error('❌ initLdap() called before initAuth()');
        return;
    }
    dataDirCached = dataDir;
    encKey = deriveEncKey(dataDir);
    db.exec(CREATE_TABLES);
    // Additive migration for installs that ran a pre-default_profile version.
    try {
        const cols = (db.prepare("PRAGMA table_info(ldap_configs)").all() as any[]).map(r => r.name);
        if (!cols.includes('default_profile')) {
            db.exec("ALTER TABLE ldap_configs ADD COLUMN default_profile TEXT NOT NULL DEFAULT ''");
        }
    } catch {}
    const count = (db.prepare('SELECT COUNT(*) as c FROM ldap_configs WHERE enabled = 1').get() as any)?.c || 0;
    console.log(`🪪 LDAP: ${count} enabled directory(ies)`);
}

export function shutdownLdap(): void {
    for (const client of clientPool.values()) {
        client.unbind().catch(() => {});
    }
    clientPool.clear();
}

// ─── Row mapping ────────────────────────────────────────────────────────────

function loadAdminGroups(configId: number): string[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare('SELECT group_dn FROM ldap_admin_groups WHERE ldap_config_id = $id ORDER BY group_dn').all({ $id: configId }) as any[];
    return rows.map(r => r.group_dn);
}

function setAdminGroups(configId: number, groups: string[]): void {
    const db = getAuthDb();
    if (!db) return;
    const normalized = Array.from(new Set(groups.map(g => g.trim()).filter(Boolean)));
    db.prepare('DELETE FROM ldap_admin_groups WHERE ldap_config_id = $id').run({ $id: configId });
    if (normalized.length === 0) return;
    const insert = db.prepare('INSERT OR IGNORE INTO ldap_admin_groups (ldap_config_id, group_dn) VALUES ($id, $g)');
    for (const g of normalized) insert.run({ $id: configId, $g: g });
}

function rowToConfig(r: any): LdapConfig {
    return {
        id: r.id,
        name: r.name,
        url: r.url,
        bindDn: r.bind_dn || '',
        baseDn: r.base_dn,
        userFilter: r.user_filter,
        usernameAttr: r.username_attr,
        emailAttr: r.email_attr,
        fullnameAttr: r.fullname_attr,
        groupAttr: r.group_attr,
        startTls: !!r.start_tls,
        tlsVerify: !!r.tls_verify,
        scope: (r.scope || 'both') as LdapScope,
        totpPolicy: (r.totp_policy || 'optional') as LdapTotpPolicy,
        enabled: !!r.enabled,
        timeoutMs: r.timeout_ms || 5000,
        defaultProfile: r.default_profile || '',
        adminGroups: loadAdminGroups(r.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function validateInput(input: LdapConfigInput, isCreate: boolean): void {
    if (isCreate || input.name !== undefined) {
        if (!input.name?.trim()) throw new Error('name required');
    }
    if (isCreate || input.url !== undefined) {
        if (!input.url?.trim()) throw new Error('url required');
        try {
            const u = new URL(input.url);
            if (u.protocol !== 'ldap:' && u.protocol !== 'ldaps:') {
                throw new Error('url must use ldap:// or ldaps://');
            }
        } catch (err) {
            if (err instanceof Error && err.message.startsWith('url must')) throw err;
            throw new Error(`Invalid url: ${input.url}`);
        }
    }
    if (isCreate || input.baseDn !== undefined) {
        if (!input.baseDn?.trim()) throw new Error('baseDn required');
    }
    if (input.userFilter !== undefined && !input.userFilter.includes('{login}')) {
        throw new Error('userFilter must contain the {login} placeholder');
    }
    if (input.scope && !['admin', 'proxy', 'both'].includes(input.scope)) {
        throw new Error('scope must be admin|proxy|both');
    }
    if (input.totpPolicy && !['disabled', 'optional', 'required'].includes(input.totpPolicy)) {
        throw new Error('totpPolicy must be disabled|optional|required');
    }
    if (input.timeoutMs !== undefined && (input.timeoutMs < 500 || input.timeoutMs > 60_000)) {
        throw new Error('timeoutMs must be between 500 and 60000');
    }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function createLdapConfig(input: LdapConfigInput): LdapConfig {
    const db = getAuthDb();
    if (!db) throw new Error('Auth not initialized');
    validateInput(input, true);
    const enc = encryptBindPassword(input.bindPassword || '');
    db.prepare(`INSERT INTO ldap_configs
        (name, url, bind_dn, bind_password_enc, base_dn, user_filter,
         username_attr, email_attr, fullname_attr, group_attr,
         start_tls, tls_verify, scope, totp_policy, enabled, timeout_ms, default_profile)
        VALUES ($n, $u, $bd, $bp, $base, $f, $ua, $ea, $fa, $ga,
                $st, $tv, $sc, $tp, $en, $to, $dp)`).run({
        $n: input.name.trim(),
        $u: input.url.trim(),
        $bd: (input.bindDn || '').trim(),
        $bp: enc,
        $base: input.baseDn.trim(),
        $f: input.userFilter || '(|(uid={login})(mail={login})(sAMAccountName={login}))',
        $ua: input.usernameAttr || 'uid',
        $ea: input.emailAttr || 'mail',
        $fa: input.fullnameAttr || 'cn',
        $ga: input.groupAttr || 'memberOf',
        $st: input.startTls ? 1 : 0,
        $tv: input.tlsVerify === false ? 0 : 1,
        $sc: input.scope || 'both',
        $tp: input.totpPolicy || 'optional',
        $en: input.enabled === false ? 0 : 1,
        $to: input.timeoutMs || 5000,
        $dp: (input.defaultProfile || '').trim().toLowerCase(),
    });
    const row = db.prepare('SELECT * FROM ldap_configs WHERE name = $n').get({ $n: input.name.trim() }) as any;
    if (Array.isArray(input.adminGroups)) setAdminGroups(row.id, input.adminGroups);
    return rowToConfig(row);
}

export function updateLdapConfig(id: number, input: Partial<LdapConfigInput>): LdapConfig | null {
    const db = getAuthDb();
    if (!db) return null;
    validateInput(input as LdapConfigInput, false);
    const existing = db.prepare('SELECT * FROM ldap_configs WHERE id = $id').get({ $id: id }) as any;
    if (!existing) return null;

    const fields: string[] = [];
    const params: Record<string, unknown> = { $id: id };
    const set = (col: string, key: string, value: unknown) => {
        fields.push(`${col} = $${key}`);
        params[`$${key}`] = value;
    };

    if (input.name !== undefined) set('name', 'n', input.name.trim());
    if (input.url !== undefined) set('url', 'u', input.url.trim());
    if (input.bindDn !== undefined) set('bind_dn', 'bd', input.bindDn.trim());
    if (input.bindPassword !== undefined) set('bind_password_enc', 'bp', encryptBindPassword(input.bindPassword));
    if (input.baseDn !== undefined) set('base_dn', 'base', input.baseDn.trim());
    if (input.userFilter !== undefined) set('user_filter', 'f', input.userFilter);
    if (input.usernameAttr !== undefined) set('username_attr', 'ua', input.usernameAttr);
    if (input.emailAttr !== undefined) set('email_attr', 'ea', input.emailAttr);
    if (input.fullnameAttr !== undefined) set('fullname_attr', 'fa', input.fullnameAttr);
    if (input.groupAttr !== undefined) set('group_attr', 'ga', input.groupAttr);
    if (input.startTls !== undefined) set('start_tls', 'st', input.startTls ? 1 : 0);
    if (input.tlsVerify !== undefined) set('tls_verify', 'tv', input.tlsVerify ? 1 : 0);
    if (input.scope !== undefined) set('scope', 'sc', input.scope);
    if (input.totpPolicy !== undefined) set('totp_policy', 'tp', input.totpPolicy);
    if (input.enabled !== undefined) set('enabled', 'en', input.enabled ? 1 : 0);
    if (input.timeoutMs !== undefined) set('timeout_ms', 'to', input.timeoutMs);
    if (input.defaultProfile !== undefined) set('default_profile', 'dp', input.defaultProfile.trim().toLowerCase());

    if (input.adminGroups !== undefined) setAdminGroups(id, input.adminGroups);

    if (fields.length === 0 && input.adminGroups === undefined) return rowToConfig(existing);
    if (fields.length > 0) {
        fields.push("updated_at = datetime('now')");
        db.prepare(`UPDATE ldap_configs SET ${fields.join(', ')} WHERE id = $id`).run(params as any);
    }

    // Invalidate cached client — config may have changed url/tls/etc.
    const cached = clientPool.get(id);
    if (cached) {
        cached.unbind().catch(() => {});
        clientPool.delete(id);
    }

    const row = db.prepare('SELECT * FROM ldap_configs WHERE id = $id').get({ $id: id }) as any;
    return row ? rowToConfig(row) : null;
}

export function deleteLdapConfig(id: number): boolean {
    const db = getAuthDb();
    if (!db) return false;
    const cached = clientPool.get(id);
    if (cached) {
        cached.unbind().catch(() => {});
        clientPool.delete(id);
    }
    db.prepare('DELETE FROM ldap_admin_groups WHERE ldap_config_id = $id').run({ $id: id });
    const result = db.prepare('DELETE FROM ldap_configs WHERE id = $id').run({ $id: id });
    return result.changes > 0;
}

export function getLdapConfig(id: number): LdapConfig | null {
    const db = getAuthDb();
    if (!db) return null;
    const row = db.prepare('SELECT * FROM ldap_configs WHERE id = $id').get({ $id: id }) as any;
    return row ? rowToConfig(row) : null;
}

export function listLdapConfigs(): LdapConfig[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare('SELECT * FROM ldap_configs ORDER BY name ASC').all() as any[];
    return rows.map(rowToConfig);
}

/** Returns enabled configs whose scope matches the desired login surface. */
export function listLdapConfigsForScope(scope: 'admin' | 'proxy'): LdapConfig[] {
    return listLdapConfigs().filter(c => c.enabled && (c.scope === scope || c.scope === 'both'));
}

function getBindPassword(id: number): string {
    const db = getAuthDb();
    if (!db) return '';
    const row = db.prepare('SELECT bind_password_enc FROM ldap_configs WHERE id = $id').get({ $id: id }) as any;
    return row ? decryptBindPassword(row.bind_password_enc) : '';
}

// ─── Connection pool ────────────────────────────────────────────────────────
// One ldapts.Client per config id. ldapts keeps the underlying socket open
// across operations, which is what we want for the >100 logins/min target.

const clientPool = new Map<number, Client>();

async function getClient(cfg: LdapConfig): Promise<Client> {
    let client = clientPool.get(cfg.id);
    if (client) return client;
    client = new Client({
        url: cfg.url,
        timeout: cfg.timeoutMs,
        connectTimeout: cfg.timeoutMs,
        tlsOptions: cfg.url.startsWith('ldaps:') || cfg.startTls
            ? { rejectUnauthorized: cfg.tlsVerify }
            : undefined,
    });
    if (cfg.startTls && cfg.url.startsWith('ldap:')) {
        await client.startTLS({ rejectUnauthorized: cfg.tlsVerify });
    }
    clientPool.set(cfg.id, client);
    return client;
}

// ─── LDAP filter escaping (RFC 4515) ────────────────────────────────────────

/** Escapes special chars in an LDAP filter value to prevent filter injection. */
export function escapeLdapFilter(value: string): string {
    return value.replace(/[\\*\(\) ]/g, ch => {
        switch (ch) {
            case '\\': return '\\5c';
            case '*':  return '\\2a';
            case '(':  return '\\28';
            case ')':  return '\\29';
            case '\0': return '\\00';
            default:   return ch;
        }
    });
}

// ─── Authentication ─────────────────────────────────────────────────────────

export interface LdapAuthResult {
    configId: number;
    configName: string;
    dn: string;
    username: string;
    email: string;
    fullName: string;
    groups: string[];        // group DNs (or values of cfg.groupAttr if non-DN)
    raw: Record<string, string | string[]>;
    totpPolicy: LdapTotpPolicy;
    scope: LdapScope;
}

export type LdapAuthFailure =
    | { ok: false; reason: 'invalid_credentials' }
    | { ok: false; reason: 'user_not_found' }
    | { ok: false; reason: 'server_error'; detail: string };

export type LdapAuthOutcome =
    | { ok: true; result: LdapAuthResult }
    | LdapAuthFailure;

/** Bind admin → search user → re-bind as user. Returns user attrs on success. */
export async function authenticateAgainst(cfg: LdapConfig, login: string, password: string): Promise<LdapAuthOutcome> {
    if (!cfg.enabled) return { ok: false, reason: 'server_error', detail: 'config disabled' };
    if (!login || !password) return { ok: false, reason: 'invalid_credentials' };

    const adminClient = await getClient(cfg).catch(err => {
        return { __err: err instanceof Error ? err.message : String(err) } as any;
    });
    if ((adminClient as any).__err) {
        return { ok: false, reason: 'server_error', detail: (adminClient as any).__err };
    }

    try {
        // Admin bind (may be anonymous if bindDn empty)
        if (cfg.bindDn) {
            await adminClient.bind(cfg.bindDn, getBindPassword(cfg.id));
        }
    } catch (err) {
        return { ok: false, reason: 'server_error', detail: 'admin bind failed: ' + (err instanceof Error ? err.message : String(err)) };
    }

    // Search for user
    const filter = cfg.userFilter.replace(/\{login\}/g, escapeLdapFilter(login));
    const opts: SearchOptions = {
        scope: 'sub',
        filter,
        attributes: [
            cfg.usernameAttr,
            cfg.emailAttr,
            cfg.fullnameAttr,
            cfg.groupAttr,
            'dn',
        ],
        sizeLimit: 2,
    };

    let entries: any[];
    try {
        const res = await adminClient.search(cfg.baseDn, opts);
        entries = res.searchEntries || [];
    } catch (err) {
        return { ok: false, reason: 'server_error', detail: 'search failed: ' + (err instanceof Error ? err.message : String(err)) };
    }

    if (entries.length === 0) return { ok: false, reason: 'user_not_found' };
    if (entries.length > 1) {
        return { ok: false, reason: 'server_error', detail: 'user filter matched multiple entries — refine filter' };
    }

    const entry = entries[0];
    const dn: string = entry.dn;

    // Re-bind as user with provided password. Use a SEPARATE client so we
    // don't lose the admin bind on the pooled client.
    const verifyClient = new Client({
        url: cfg.url,
        timeout: cfg.timeoutMs,
        connectTimeout: cfg.timeoutMs,
        tlsOptions: cfg.url.startsWith('ldaps:') || cfg.startTls
            ? { rejectUnauthorized: cfg.tlsVerify }
            : undefined,
    });
    try {
        if (cfg.startTls && cfg.url.startsWith('ldap:')) {
            await verifyClient.startTLS({ rejectUnauthorized: cfg.tlsVerify });
        }
        await verifyClient.bind(dn, password);
    } catch (err) {
        await verifyClient.unbind().catch(() => {});
        // ldapts surfaces InvalidCredentialsError on wrong password
        const msg = err instanceof Error ? err.message : String(err);
        if (/invalid credentials|49/i.test(msg)) {
            return { ok: false, reason: 'invalid_credentials' };
        }
        return { ok: false, reason: 'server_error', detail: 'user bind failed: ' + msg };
    }
    await verifyClient.unbind().catch(() => {});

    // Extract attrs (ldapts returns string | string[] | Buffer)
    const pick = (key: string): string => {
        const v = entry[key];
        if (Array.isArray(v)) return String(v[0] ?? '');
        if (v === undefined || v === null) return '';
        return String(v);
    };
    const pickArray = (key: string): string[] => {
        const v = entry[key];
        if (Array.isArray(v)) return v.map(String);
        if (v === undefined || v === null) return [];
        return [String(v)];
    };

    const raw: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(entry)) {
        if (k === 'dn') continue;
        raw[k] = Array.isArray(v) ? v.map(String) : String(v as any);
    }

    return {
        ok: true,
        result: {
            configId: cfg.id,
            configName: cfg.name,
            dn,
            username: pick(cfg.usernameAttr) || login,
            email: pick(cfg.emailAttr),
            fullName: pick(cfg.fullnameAttr),
            groups: pickArray(cfg.groupAttr),
            raw,
            totpPolicy: cfg.totpPolicy,
            scope: cfg.scope,
        },
    };
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export interface LdapTestOutcome {
    ok: boolean;
    durationMs: number;
    steps: { step: string; ok: boolean; detail?: string }[];
    sample?: { dn: string; attrs: Record<string, string | string[]> };
}

/**
 * Admin-side connectivity test. If `sampleLogin` is provided, also runs the
 * user-search step against it. Never attempts a user bind — that's reserved
 * for the actual login path.
 */
export async function testLdapConfig(cfg: LdapConfig, sampleLogin?: string): Promise<LdapTestOutcome> {
    const started = Date.now();
    const steps: LdapTestOutcome['steps'] = [];
    let client: Client | null = null;
    try {
        client = new Client({
            url: cfg.url,
            timeout: cfg.timeoutMs,
            connectTimeout: cfg.timeoutMs,
            tlsOptions: cfg.url.startsWith('ldaps:') || cfg.startTls
                ? { rejectUnauthorized: cfg.tlsVerify }
                : undefined,
        });
        steps.push({ step: 'connect', ok: true });

        if (cfg.startTls && cfg.url.startsWith('ldap:')) {
            try {
                await client.startTLS({ rejectUnauthorized: cfg.tlsVerify });
                steps.push({ step: 'starttls', ok: true });
            } catch (err) {
                steps.push({ step: 'starttls', ok: false, detail: err instanceof Error ? err.message : String(err) });
                return { ok: false, durationMs: Date.now() - started, steps };
            }
        }

        if (cfg.bindDn) {
            try {
                await client.bind(cfg.bindDn, getBindPassword(cfg.id));
                steps.push({ step: 'admin_bind', ok: true });
            } catch (err) {
                steps.push({ step: 'admin_bind', ok: false, detail: err instanceof Error ? err.message : String(err) });
                return { ok: false, durationMs: Date.now() - started, steps };
            }
        } else {
            steps.push({ step: 'admin_bind', ok: true, detail: 'anonymous — AD usually requires a Bind DN for searches' });
        }

        let sample: LdapTestOutcome['sample'];
        if (sampleLogin) {
            const filter = cfg.userFilter.replace(/\{login\}/g, escapeLdapFilter(sampleLogin));
            try {
                const res = await client.search(cfg.baseDn, {
                    scope: 'sub',
                    filter,
                    attributes: [cfg.usernameAttr, cfg.emailAttr, cfg.fullnameAttr, cfg.groupAttr],
                    sizeLimit: 2,
                });
                if (res.searchEntries.length === 0) {
                    steps.push({ step: 'user_search', ok: false, detail: 'no entries matched' });
                } else if (res.searchEntries.length > 1) {
                    steps.push({ step: 'user_search', ok: false, detail: 'filter matched multiple entries' });
                } else {
                    const e: any = res.searchEntries[0];
                    const attrs: Record<string, string | string[]> = {};
                    for (const [k, v] of Object.entries(e)) {
                        if (k === 'dn') continue;
                        attrs[k] = Array.isArray(v) ? v.map(String) : String(v as any);
                    }
                    sample = { dn: e.dn, attrs };
                    steps.push({ step: 'user_search', ok: true });
                }
            } catch (err) {
                steps.push({ step: 'user_search', ok: false, detail: err instanceof Error ? err.message : String(err) });
            }
        }

        const ok = steps.every(s => s.ok);
        return { ok, durationMs: Date.now() - started, steps, sample };
    } catch (err) {
        steps.push({ step: 'connect', ok: false, detail: err instanceof Error ? err.message : String(err) });
        return { ok: false, durationMs: Date.now() - started, steps };
    } finally {
        if (client) {
            await client.unbind().catch(() => {});
        }
    }
}

// ─── Combined auth helpers (admin / proxy) ──────────────────────────────────
// Walk all enabled directories for the requested scope, try to bind the user.
// Returns the first successful outcome with role/profile decision baked in.

export type LdapLoginRole = 'admin' | 'proxy' | 'denied';

export interface LdapLoginDecision {
    ok: true;
    auth: LdapAuthResult;
    role: LdapLoginRole;       // 'denied' = auth ok but no admin group / no profile
    grantedProfile: string;    // empty when role !== 'proxy' or no default_profile
    matchedAdminGroup: string; // empty if not admin
}

export type LdapLoginOutcome =
    | LdapLoginDecision
    | { ok: false; reason: 'invalid_credentials' | 'no_directory' | 'server_error'; detail?: string };

function matchAdminGroup(groups: string[], adminGroups: string[]): string {
    if (!adminGroups.length || !groups.length) return '';
    const lower = new Set(adminGroups.map(g => g.toLowerCase()));
    for (const g of groups) {
        if (lower.has(String(g).toLowerCase())) return g;
    }
    return '';
}

/** Try LDAP login across all enabled directories for the requested surface. */
export async function tryLdapLogin(
    scope: 'admin' | 'proxy',
    login: string,
    password: string,
): Promise<LdapLoginOutcome> {
    const candidates = listLdapConfigsForScope(scope);
    if (candidates.length === 0) return { ok: false, reason: 'no_directory' };

    let lastServerError: string | undefined;
    let sawInvalidCreds = false;

    for (const cfg of candidates) {
        const outcome = await authenticateAgainst(cfg, login, password);
        if (outcome.ok) {
            const auth = outcome.result;
            if (scope === 'admin') {
                const matched = matchAdminGroup(auth.groups, cfg.adminGroups);
                if (!matched) {
                    return { ok: true, auth, role: 'denied', grantedProfile: '', matchedAdminGroup: '' };
                }
                return { ok: true, auth, role: 'admin', grantedProfile: '', matchedAdminGroup: matched };
            }
            // proxy scope: default_profile decides; empty means shadow without profile
            return {
                ok: true, auth, role: 'proxy',
                grantedProfile: cfg.defaultProfile || '',
                matchedAdminGroup: '',
            };
        }
        if (outcome.reason === 'invalid_credentials') sawInvalidCreds = true;
        else if (outcome.reason === 'server_error') lastServerError = outcome.detail;
        // user_not_found → try next directory
    }

    if (sawInvalidCreds) return { ok: false, reason: 'invalid_credentials' };
    if (lastServerError) return { ok: false, reason: 'server_error', detail: lastServerError };
    return { ok: false, reason: 'invalid_credentials' }; // all "user_not_found"
}

// Avoid an unused-import warning when dataDirCached is reserved for future
// re-key support (it isn't read elsewhere yet).
export function _ldapDataDir(): string { return dataDirCached; }
