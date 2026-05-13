// OAuth2 / OIDC server-side state: clients, authorization codes, refresh tokens,
// SSO sessions. Storage is the same SQLite DB initialized by auth.ts.
//
// Security model:
//   - client_secret stored as bcrypt hash (Bun.password)
//   - authorization codes are single-use, 60s TTL, bound to (client_id, redirect_uri, code_challenge)
//   - refresh tokens use rotation + family revocation: presenting a revoked token kills the family
//   - PKCE S256 only (plain rejected at the endpoint layer)
//   - redirect_uri matched by exact string against the registered list (no normalization)

import { createHash } from 'crypto';
import { getAuthDb } from './auth';
import type { ProxyUser } from '../core/types';

// ─── Schema ─────────────────────────────────────────────────────────────────

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id      TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    secret_hash    TEXT NOT NULL,
    redirect_uris  TEXT NOT NULL DEFAULT '[]',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_codes (
    code              TEXT PRIMARY KEY,
    client_id         TEXT NOT NULL,
    user_id           INTEGER NOT NULL REFERENCES proxy_users(id) ON DELETE CASCADE,
    redirect_uri      TEXT NOT NULL,
    code_challenge    TEXT NOT NULL,
    scope             TEXT NOT NULL DEFAULT '',
    nonce             TEXT,
    expires_at        TEXT NOT NULL,
    used_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash    TEXT PRIMARY KEY,
    family_id     TEXT NOT NULL,
    client_id     TEXT NOT NULL,
    user_id       INTEGER NOT NULL REFERENCES proxy_users(id) ON DELETE CASCADE,
    scope         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT NOT NULL,
    revoked_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS oauth_sso_sessions (
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES proxy_users(id) ON DELETE CASCADE,
    expires_at    TEXT NOT NULL,
    ip_address    TEXT,
    user_agent    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_sso_expires ON oauth_sso_sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_client_users (
    client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES proxy_users(id) ON DELETE CASCADE,
    PRIMARY KEY (client_id, user_id)
);

CREATE TABLE IF NOT EXISTS oauth_client_ldap_groups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    ldap_config_id  INTEGER NOT NULL,
    group_match     TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (client_id, ldap_config_id, group_match COLLATE NOCASE)
);

CREATE INDEX IF NOT EXISTS idx_oclg_client ON oauth_client_ldap_groups(client_id);
CREATE INDEX IF NOT EXISTS idx_oclg_config ON oauth_client_ldap_groups(ldap_config_id);
`;

export function initOauth(): void {
    const db = getAuthDb();
    if (!db) {
        console.error('❌ initOauth() called before initAuth()');
        return;
    }
    db.exec(CREATE_TABLES);
    // Idempotent column additions (safe to run on every boot).
    const cols = (db.prepare("PRAGMA table_info(oauth_clients)").all() as any[]).map(r => r.name);
    if (!cols.includes('consent_enabled'))     db.exec("ALTER TABLE oauth_clients ADD COLUMN consent_enabled INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes('consent_title'))         db.exec("ALTER TABLE oauth_clients ADD COLUMN consent_title TEXT");
    if (!cols.includes('consent_body'))          db.exec("ALTER TABLE oauth_clients ADD COLUMN consent_body TEXT");
    if (!cols.includes('allow_list_enabled'))    db.exec("ALTER TABLE oauth_clients ADD COLUMN allow_list_enabled INTEGER NOT NULL DEFAULT 0");
    // consent_page_id references consent_pages.id (created by initConsentPages()).
    // Weak reference: we do NOT add a FK constraint so init order is flexible.
    // The consent_title/consent_body columns above are kept for historical data
    // but are no longer read or written — replaced by the join to consent_pages.
    if (!cols.includes('consent_page_id'))       db.exec("ALTER TABLE oauth_clients ADD COLUMN consent_page_id INTEGER");
    // Cleanup expired codes / refresh tokens / sessions once per hour.
    cleanupExpired();
    setInterval(cleanupExpired, 60 * 60 * 1000);
    const clientCount = (db.prepare('SELECT COUNT(*) as c FROM oauth_clients').get() as any)?.c || 0;
    console.log(`🪪 OAuth: ${clientCount} client(s) registered`);
}

function cleanupExpired(): void {
    const db = getAuthDb();
    if (!db) return;
    try {
        const now = new Date().toISOString();
        db.prepare('DELETE FROM oauth_codes WHERE expires_at < $now OR used_at IS NOT NULL').run({ $now: now });
        db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at < $now').run({ $now: now });
        db.prepare('DELETE FROM oauth_sso_sessions WHERE expires_at < $now').run({ $now: now });
    } catch {}
}

// ─── Clients ────────────────────────────────────────────────────────────────

export interface OauthClient {
    clientId: string;
    name: string;
    redirectUris: string[];
    createdAt: string;
    consentEnabled: boolean;
    consentPageId: number | null;
    /** Resolved from consent_pages via JOIN. Empty string when no page is linked. */
    consentTitle: string;
    /** Resolved from consent_pages via JOIN. Empty string when no page is linked. */
    consentBody: string;
    allowListEnabled: boolean;
}

function randomToken(byteLength: number): string {
    const buf = new Uint8Array(byteLength);
    crypto.getRandomValues(buf);
    return Buffer.from(buf).toString('base64url');
}

/** Create a new OAuth client. The plaintext secret is returned ONCE — never retrievable again. */
function validateRedirectUris(redirectUris: string[]): void {
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) throw new Error('At least one redirect_uri required');
    for (const uri of redirectUris) {
        try {
            const u = new URL(uri);
            if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
                throw new Error(`redirect_uri must use https:// (got ${uri})`);
            }
        } catch {
            throw new Error(`Invalid redirect_uri: ${uri}`);
        }
    }
}

export async function createOauthClient(name: string, redirectUris: string[]): Promise<{ client: OauthClient; clientSecret: string }> {
    const db = getAuthDb();
    if (!db) throw new Error('Auth not initialized');
    if (!name.trim()) throw new Error('Client name required');
    validateRedirectUris(redirectUris);
    const clientId = randomToken(16);
    const clientSecret = randomToken(32);
    const secretHash = await Bun.password.hash(clientSecret, 'bcrypt');
    db.prepare('INSERT INTO oauth_clients (client_id, name, secret_hash, redirect_uris) VALUES ($id, $n, $h, $r)')
        .run({ $id: clientId, $n: name.trim(), $h: secretHash, $r: JSON.stringify(redirectUris) });
    return {
        client: { clientId, name: name.trim(), redirectUris, createdAt: new Date().toISOString(), consentEnabled: false, consentTitle: '', consentBody: '' },
        clientSecret,
    };
}

export interface UpdateOauthClientInput {
    name?: string;
    redirectUris?: string[];
    consentEnabled?: boolean;
    /** Reference to a row in consent_pages. null clears the link. */
    consentPageId?: number | null;
}

export interface UpdateOauthClientResult {
    updated: boolean;
    redirectUrisChanged: boolean;
    revokedRefreshTokens: number;
}

/** Atomically update editable fields of an OAuth client. When redirect_uris
 *  change, all refresh tokens for the client are revoked (and SSO sessions
 *  for affected users are *not* touched — sessions are short-lived; refresh
 *  revocation forces re-auth on next token refresh). */
export function updateOauthClient(clientId: string, input: UpdateOauthClientInput): UpdateOauthClientResult {
    const db = getAuthDb();
    if (!db) return { updated: false, redirectUrisChanged: false, revokedRefreshTokens: 0 };
    const existing = db.prepare('SELECT * FROM oauth_clients WHERE client_id = $id').get({ $id: clientId }) as any;
    if (!existing) return { updated: false, redirectUrisChanged: false, revokedRefreshTokens: 0 };

    const sets: string[] = [];
    const params: Record<string, unknown> = { $id: clientId };
    let redirectUrisChanged = false;

    if (input.name !== undefined) {
        const trimmed = input.name.trim();
        if (!trimmed) throw new Error('Client name cannot be empty');
        if (trimmed !== existing.name) {
            sets.push('name = $n');
            params.$n = trimmed;
        }
    }

    if (input.redirectUris !== undefined) {
        validateRedirectUris(input.redirectUris);
        const newJson = JSON.stringify(input.redirectUris);
        if (newJson !== (existing.redirect_uris || '[]')) {
            sets.push('redirect_uris = $r');
            params.$r = newJson;
            redirectUrisChanged = true;
        }
    }

    if (input.consentEnabled !== undefined) {
        const e = input.consentEnabled ? 1 : 0;
        if (e !== (existing.consent_enabled ? 1 : 0)) {
            sets.push('consent_enabled = $ce');
            params.$ce = e;
        }
    }
    if (input.consentPageId !== undefined) {
        const v = input.consentPageId ?? null;
        if (v !== (existing.consent_page_id ?? null)) {
            sets.push('consent_page_id = $cpid');
            params.$cpid = v;
        }
    }

    if (sets.length === 0) {
        return { updated: false, redirectUrisChanged: false, revokedRefreshTokens: 0 };
    }

    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE oauth_clients SET ${sets.join(', ')} WHERE client_id = $id`).run(params);

    let revoked = 0;
    if (redirectUrisChanged) {
        const r = db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE client_id = $id AND revoked_at IS NULL")
            .run({ $id: clientId });
        revoked = r.changes;
    }

    return { updated: true, redirectUrisChanged, revokedRefreshTokens: revoked };
}

// SELECT joining consent_pages, exposing the page fields under cp_* aliases.
// consent_title / consent_body inline columns are intentionally NOT read —
// they remain in the schema as legacy data but the live values come from
// consent_pages via consent_page_id.
const CLIENT_SELECT = `
    SELECT oc.*,
           cp.title AS cp_title,
           cp.body  AS cp_body
      FROM oauth_clients oc
      LEFT JOIN consent_pages cp ON cp.id = oc.consent_page_id
`;

function rowToClient(r: any): OauthClient {
    return {
        clientId: r.client_id,
        name: r.name,
        redirectUris: JSON.parse(r.redirect_uris || '[]'),
        createdAt: r.created_at,
        consentEnabled: !!r.consent_enabled,
        consentPageId: r.consent_page_id ?? null,
        // When consent_enabled=true but no page is linked (or page was deleted),
        // these resolve to '' — login handlers treat that as "no consent shown".
        consentTitle: r.cp_title || '',
        consentBody: r.cp_body || '',
        allowListEnabled: !!r.allow_list_enabled,
    };
}

export function getOauthClient(clientId: string): OauthClient | null {
    const db = getAuthDb();
    if (!db || !clientId) return null;
    const row = db.prepare(`${CLIENT_SELECT} WHERE oc.client_id = $id`).get({ $id: clientId }) as any;
    return row ? rowToClient(row) : null;
}

export function listOauthClients(): OauthClient[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare(`${CLIENT_SELECT} ORDER BY oc.created_at DESC`).all() as any[];
    return rows.map(rowToClient);
}

export function deleteOauthClient(clientId: string): boolean {
    const db = getAuthDb();
    if (!db) return false;
    // Also invalidate any outstanding codes & refresh tokens for this client.
    db.prepare('DELETE FROM oauth_codes WHERE client_id = $id').run({ $id: clientId });
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE client_id = $id AND revoked_at IS NULL").run({ $id: clientId });
    const result = db.prepare('DELETE FROM oauth_clients WHERE client_id = $id').run({ $id: clientId });
    return result.changes > 0;
}

/** Constant-time verification of client_secret against stored bcrypt hash. */
export async function verifyClientSecret(clientId: string, clientSecret: string): Promise<boolean> {
    const db = getAuthDb();
    if (!db || !clientId || !clientSecret) return false;
    const row = db.prepare('SELECT secret_hash FROM oauth_clients WHERE client_id = $id').get({ $id: clientId }) as any;
    if (!row) return false;
    try {
        return await Bun.password.verify(clientSecret, row.secret_hash);
    } catch {
        return false;
    }
}

/** Exact-string match against the client's registered redirect URIs (no normalization). */
export function isRedirectUriAllowed(client: OauthClient, redirectUri: string): boolean {
    if (!redirectUri) return false;
    return client.redirectUris.includes(redirectUri);
}

// ─── Authorization codes ────────────────────────────────────────────────────

const CODE_TTL_SECONDS = 90; // Spec recommends ≤10min; we go aggressive.

export interface IssueCodeParams {
    clientId: string;
    userId: number;
    redirectUri: string;
    codeChallenge: string; // PKCE S256 base64url
    scope: string;
    nonce?: string;
}

export function issueAuthCode(p: IssueCodeParams): string {
    const db = getAuthDb();
    if (!db) throw new Error('Auth not initialized');
    const code = randomToken(32);
    const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();
    db.prepare(`INSERT INTO oauth_codes
        (code, client_id, user_id, redirect_uri, code_challenge, scope, nonce, expires_at)
        VALUES ($code, $cid, $uid, $ru, $cc, $sc, $no, $exp)`)
        .run({
            $code: code, $cid: p.clientId, $uid: p.userId, $ru: p.redirectUri,
            $cc: p.codeChallenge, $sc: p.scope, $no: p.nonce || null, $exp: expiresAt,
        });
    return code;
}

export interface ConsumedCode {
    userId: number;
    scope: string;
    nonce: string | null;
}

/** Single-use consumption of an auth code. Validates client_id, redirect_uri, PKCE S256. */
export function consumeAuthCode(code: string, clientId: string, redirectUri: string, codeVerifier: string): ConsumedCode | null {
    const db = getAuthDb();
    if (!db || !code || !clientId || !codeVerifier) return null;

    const row = db.prepare('SELECT * FROM oauth_codes WHERE code = $c').get({ $c: code }) as any;
    if (!row) return null;

    // Mark used immediately to prevent double-spend (TOCTOU).
    const markResult = db.prepare("UPDATE oauth_codes SET used_at = datetime('now') WHERE code = $c AND used_at IS NULL")
        .run({ $c: code });
    if (markResult.changes === 0) return null; // already used

    // Now validate
    if (row.client_id !== clientId) return null;
    if (row.redirect_uri !== redirectUri) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    // PKCE S256: BASE64URL(SHA256(code_verifier)) === code_challenge
    const challenge = createHash('sha256').update(codeVerifier).digest().toString('base64url');
    if (challenge !== row.code_challenge) return null;

    return { userId: row.user_id, scope: row.scope, nonce: row.nonce };
}

// ─── Refresh tokens (rotation + family revocation) ──────────────────────────

const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export interface IssuedRefresh {
    refreshToken: string;
    familyId: string;
}

/** Issue a brand-new refresh token (new family). Use on initial code exchange. */
export function issueRefreshToken(clientId: string, userId: number, scope: string): IssuedRefresh {
    const db = getAuthDb();
    if (!db) throw new Error('Auth not initialized');
    const refreshToken = randomToken(48);
    const familyId = randomToken(16);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();
    db.prepare(`INSERT INTO oauth_refresh_tokens
        (token_hash, family_id, client_id, user_id, scope, expires_at)
        VALUES ($th, $fid, $cid, $uid, $sc, $exp)`)
        .run({ $th: hashToken(refreshToken), $fid: familyId, $cid: clientId, $uid: userId, $sc: scope, $exp: expiresAt });
    return { refreshToken, familyId };
}

export interface RotateResult {
    refreshToken: string;
    userId: number;
    scope: string;
    familyId: string;
}

/**
 * Rotate a refresh token. Returns null and revokes the entire family if the presented
 * token was already revoked (replay attack indicator).
 */
export function rotateRefreshToken(presentedToken: string, clientId: string): RotateResult | null {
    const db = getAuthDb();
    if (!db || !presentedToken) return null;
    const tokenHash = hashToken(presentedToken);
    const row = db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash = $th').get({ $th: tokenHash }) as any;
    if (!row) return null;
    if (row.client_id !== clientId) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    // Revoked token replay → kill the whole family.
    if (row.revoked_at) {
        console.warn(`⚠️  OAuth: revoked refresh token replayed for family ${row.family_id} (client=${clientId}, user=${row.user_id}) — revoking entire family.`);
        db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE family_id = $fid AND revoked_at IS NULL")
            .run({ $fid: row.family_id });
        return null;
    }

    // Revoke the presented token, mint a successor in the same family.
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = $th").run({ $th: tokenHash });
    const newToken = randomToken(48);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();
    db.prepare(`INSERT INTO oauth_refresh_tokens
        (token_hash, family_id, client_id, user_id, scope, expires_at)
        VALUES ($th, $fid, $cid, $uid, $sc, $exp)`)
        .run({ $th: hashToken(newToken), $fid: row.family_id, $cid: clientId, $uid: row.user_id, $sc: row.scope, $exp: expiresAt });

    return { refreshToken: newToken, userId: row.user_id, scope: row.scope, familyId: row.family_id };
}

// ─── SSO sessions ───────────────────────────────────────────────────────────
// Cookie set on JWKS_PORT host that says "this browser is logged in as user X".
// Lets /oauth/authorize skip the login form on repeat consent flows.

const SSO_TTL_SECONDS = parseInt(process.env.SSO_SESSION_TTL || '', 10) || (2 * 60 * 60); // 2h default, override via SSO_SESSION_TTL env

export function createSsoSession(userId: number, ip: string, userAgent: string): string {
    const db = getAuthDb();
    if (!db) throw new Error('Auth not initialized');
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SSO_TTL_SECONDS * 1000).toISOString();
    db.prepare('INSERT INTO oauth_sso_sessions (id, user_id, expires_at, ip_address, user_agent) VALUES ($id, $uid, $exp, $ip, $ua)')
        .run({ $id: id, $uid: userId, $exp: expiresAt, $ip: ip, $ua: userAgent });
    return id;
}

export interface SsoUser {
    userId: number;
    username: string;
    fullName: string;
    email: string;
}

export function validateSsoSession(sessionId: string): SsoUser | null {
    const db = getAuthDb();
    if (!db || !sessionId) return null;
    const row = db.prepare(`
        SELECT s.expires_at, u.id, u.username, u.full_name, u.email
        FROM oauth_sso_sessions s JOIN proxy_users u ON s.user_id = u.id
        WHERE s.id = $id
    `).get({ $id: sessionId }) as any;
    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
        db.prepare('DELETE FROM oauth_sso_sessions WHERE id = $id').run({ $id: sessionId });
        return null;
    }
    return { userId: row.id, username: row.username, fullName: row.full_name || '', email: row.email || '' };
}

export function destroySsoSession(sessionId: string): void {
    const db = getAuthDb();
    if (!db || !sessionId) return;
    db.prepare('DELETE FROM oauth_sso_sessions WHERE id = $id').run({ $id: sessionId });
}

/** Destroy ALL SSO sessions for a user (call on any logout). */
export function destroyAllUserSsoSessions(userId: number): void {
    const db = getAuthDb();
    if (!db || !userId) return;
    db.prepare('DELETE FROM oauth_sso_sessions WHERE user_id = $uid').run({ $uid: userId });
}

export function getSsoTtl(): number {
    return SSO_TTL_SECONDS;
}

/** Revoke all active refresh tokens for a user across all clients.
 *  Also destroys all SSO sessions so the next /oauth/authorize prompts for credentials. */
export function revokeAllUserRefreshTokens(userId: number): void {
    const db = getAuthDb();
    if (!db || !userId) return;
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE user_id = $uid AND revoked_at IS NULL")
        .run({ $uid: userId });
    destroyAllUserSsoSessions(userId);
}

// ─── Client allow-list ──────────────────────────────────────────────────────
// When allowListEnabled=true for a client, only users explicitly added to
// oauth_client_users OR matching an oauth_client_ldap_groups rule may obtain
// tokens for that client. The two sources are additive.

/** Extract the CN (first RDN value) from a DN, lowercased. Returns '' if not a DN. */
function cnOf(dn: string): string {
    const m = dn.match(/^\s*cn\s*=\s*((?:[^,\\]|\\.)+)/i);
    if (!m) return '';
    return m[1].replace(/\\(.)/g, '$1').trim().toLowerCase();
}

/** Match a user's group DNs against configured group-match entries
 *  (CN short form or full DN). Returns the matched user-group DN, or '' if none. */
function matchUserGroupsAgainstRules(userGroups: string[], rules: string[]): string {
    if (!rules.length || !userGroups.length) return '';
    const wantDn = new Set<string>();
    const wantCn = new Set<string>();
    let wildcard = false;
    for (const raw of rules) {
        const v = raw.trim();
        if (!v) continue;
        if (v === '*') { wildcard = true; continue; }
        if (/^cn\s*=/i.test(v) && v.includes(',')) {
            wantDn.add(v.toLowerCase());
        } else {
            wantCn.add(v.replace(/^cn\s*=\s*/i, '').toLowerCase());
        }
    }
    // Wildcard: any group within this directory is acceptable. User must still
    // have at least one group (guaranteed above) — ensures orphan/groupless
    // accounts don't pass just because of '*'. Directory scoping is enforced
    // by the caller via ldap_config_id.
    if (wildcard) return userGroups[0];
    for (const g of userGroups) {
        const dn = String(g);
        if (wantDn.has(dn.toLowerCase())) return dn;
        const cn = cnOf(dn);
        if (cn && wantCn.has(cn)) return dn;
    }
    return '';
}

/** Returns true if the user may use this client. Checks (in order):
 *    1. allow-list disabled → allow all
 *    2. user in manual oauth_client_users
 *    3. user is a LDAP shadow account whose cached groups match a rule
 */
export function isUserAllowedForClient(userId: number, clientId: string): boolean {
    const db = getAuthDb();
    if (!db) return false;
    const client = db.prepare('SELECT allow_list_enabled FROM oauth_clients WHERE client_id = $id').get({ $id: clientId }) as any;
    if (!client) return false;
    if (!client.allow_list_enabled) return true;

    // Manual list
    const manual = db.prepare('SELECT 1 FROM oauth_client_users WHERE client_id = $cid AND user_id = $uid').get({ $cid: clientId, $uid: userId });
    if (manual) return true;

    // LDAP group rules — only applicable to shadow accounts (otherwise we have no groups to match)
    const user = db.prepare('SELECT auth_source, ldap_config_id, ldap_groups_last_seen FROM proxy_users WHERE id = $uid').get({ $uid: userId }) as any;
    if (!user || user.auth_source !== 'ldap' || user.ldap_orphan) return false;

    const rules = db.prepare(
        'SELECT group_match FROM oauth_client_ldap_groups WHERE client_id = $cid AND ldap_config_id = $lcid'
    ).all({ $cid: clientId, $lcid: user.ldap_config_id }) as any[];
    if (rules.length === 0) return false;

    let groups: string[] = [];
    try { groups = JSON.parse(user.ldap_groups_last_seen || '[]'); } catch {}
    return !!matchUserGroupsAgainstRules(groups, rules.map(r => r.group_match));
}

/** Enable or disable the allow-list for a client. */
export function setOauthClientAllowList(clientId: string, enabled: boolean): boolean {
    const db = getAuthDb();
    if (!db) return false;
    const result = db.prepare("UPDATE oauth_clients SET allow_list_enabled = $e, updated_at = datetime('now') WHERE client_id = $id")
        .run({ $e: enabled ? 1 : 0, $id: clientId });
    return result.changes > 0;
}

/** Add a user to a client's allow-list (no-op if already present). */
export function addUserToOauthClient(clientId: string, userId: number): boolean {
    const db = getAuthDb();
    if (!db) return false;
    try {
        db.prepare('INSERT OR IGNORE INTO oauth_client_users (client_id, user_id) VALUES ($cid, $uid)').run({ $cid: clientId, $uid: userId });
        return true;
    } catch {
        return false;
    }
}

/** Remove a user from a client's allow-list. */
export function removeUserFromOauthClient(clientId: string, userId: number): boolean {
    const db = getAuthDb();
    if (!db) return false;
    const result = db.prepare('DELETE FROM oauth_client_users WHERE client_id = $cid AND user_id = $uid').run({ $cid: clientId, $uid: userId });
    return result.changes > 0;
}

/** List all users currently in a client's allow-list. */
export function listUsersForOauthClient(clientId: string): ProxyUser[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.totp_enabled, u.created_at
        FROM oauth_client_users cu
        JOIN proxy_users u ON cu.user_id = u.id
        WHERE cu.client_id = $cid
        ORDER BY u.username ASC
    `).all({ $cid: clientId }) as any[];
    return rows.map(r => ({
        id: r.id,
        username: r.username,
        fullName: r.full_name || '',
        email: r.email || '',
        totpEnabled: !!r.totp_enabled,
        createdAt: r.created_at,
    }));
}

// ─── Client allow-list: LDAP group rules ────────────────────────────────────

export interface OauthClientLdapGroup {
    id: number;
    clientId: string;
    ldapConfigId: number;
    groupMatch: string;
    createdAt: string;
}

function rowToClientLdapGroup(r: any): OauthClientLdapGroup {
    return {
        id: r.id,
        clientId: r.client_id,
        ldapConfigId: r.ldap_config_id,
        groupMatch: r.group_match,
        createdAt: r.created_at,
    };
}

export function listLdapGroupsForOauthClient(clientId: string): OauthClientLdapGroup[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare('SELECT * FROM oauth_client_ldap_groups WHERE client_id = $cid ORDER BY ldap_config_id, group_match').all({ $cid: clientId }) as any[];
    return rows.map(rowToClientLdapGroup);
}

export function addLdapGroupToOauthClient(clientId: string, ldapConfigId: number, groupMatch: string): OauthClientLdapGroup | null {
    const db = getAuthDb();
    if (!db) return null;
    const match = (groupMatch || '').trim();
    if (!match) return null;
    try {
        db.prepare('INSERT OR IGNORE INTO oauth_client_ldap_groups (client_id, ldap_config_id, group_match) VALUES ($cid, $lcid, $gm)')
            .run({ $cid: clientId, $lcid: ldapConfigId, $gm: match });
    } catch { return null; }
    const row = db.prepare('SELECT * FROM oauth_client_ldap_groups WHERE client_id = $cid AND ldap_config_id = $lcid AND group_match = $gm COLLATE NOCASE')
        .get({ $cid: clientId, $lcid: ldapConfigId, $gm: match }) as any;
    return row ? rowToClientLdapGroup(row) : null;
}

export function removeLdapGroupFromOauthClient(clientId: string, ruleId: number): boolean {
    const db = getAuthDb();
    if (!db) return false;
    const result = db.prepare('DELETE FROM oauth_client_ldap_groups WHERE id = $id AND client_id = $cid').run({ $id: ruleId, $cid: clientId });
    return result.changes > 0;
}

/** All clients that have at least one rule for this directory.
 *  Used by the periodic sync to know which clients each shadow user could lose. */
export function listClientsRelyingOnLdapConfig(ldapConfigId: number): string[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare('SELECT DISTINCT client_id FROM oauth_client_ldap_groups WHERE ldap_config_id = $lcid').all({ $lcid: ldapConfigId }) as any[];
    return rows.map(r => r.client_id);
}

/** Group-match strings configured for (client_id, ldap_config_id). */
export function getClientLdapGroupMatches(clientId: string, ldapConfigId: number): string[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare('SELECT group_match FROM oauth_client_ldap_groups WHERE client_id = $cid AND ldap_config_id = $lcid').all({ $cid: clientId, $lcid: ldapConfigId }) as any[];
    return rows.map(r => r.group_match);
}

/** Pure version of the group-match check (exported for the sync job). */
export function userGroupsMatchClient(clientId: string, ldapConfigId: number, userGroups: string[]): boolean {
    const rules = getClientLdapGroupMatches(clientId, ldapConfigId);
    if (rules.length === 0) return false;
    return !!matchUserGroupsAgainstRules(userGroups, rules);
}

/** Revoke all active refresh tokens issued to a specific (user, client) pair.
 *  Used by the sync job when a user loses access to a particular client only. */
export function revokeUserRefreshTokensForClient(userId: number, clientId: string): void {
    const db = getAuthDb();
    if (!db || !userId || !clientId) return;
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE user_id = $uid AND client_id = $cid AND revoked_at IS NULL")
        .run({ $uid: userId, $cid: clientId });
}

/** All shadow proxy user IDs for a directory. Used to recompute access after
 *  a group rule is removed. */
export function listShadowProxyUserIdsForLdapConfig(ldapConfigId: number): number[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare("SELECT id FROM proxy_users WHERE auth_source = 'ldap' AND ldap_config_id = $cid").all({ $cid: ldapConfigId }) as any[];
    return rows.map(r => r.id);
}

/** After mutating allow-list rules, revoke refresh tokens for any shadow user
 *  who no longer has access. Returns the user ids that lost access (used for audit). */
export function reconcileShadowAccessAfterRuleChange(clientId: string, ldapConfigId: number): number[] {
    const userIds = listShadowProxyUserIdsForLdapConfig(ldapConfigId);
    const lost: number[] = [];
    for (const uid of userIds) {
        if (!isUserAllowedForClient(uid, clientId)) {
            // Only count users who actually had live tokens — keeps audit noise down.
            const db = getAuthDb();
            if (!db) continue;
            const live = db.prepare("SELECT COUNT(*) AS c FROM oauth_refresh_tokens WHERE user_id = $uid AND client_id = $cid AND revoked_at IS NULL").get({ $uid: uid, $cid: clientId }) as any;
            if ((live?.c || 0) > 0) {
                revokeUserRefreshTokensForClient(uid, clientId);
                lost.push(uid);
            }
        }
    }
    return lost;
}
