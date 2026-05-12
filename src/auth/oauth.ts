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
    consentTitle: string;
    consentBody: string;
    allowListEnabled: boolean;
}

function randomToken(byteLength: number): string {
    const buf = new Uint8Array(byteLength);
    crypto.getRandomValues(buf);
    return Buffer.from(buf).toString('base64url');
}

/** Create a new OAuth client. The plaintext secret is returned ONCE — never retrievable again. */
export async function createOauthClient(name: string, redirectUris: string[]): Promise<{ client: OauthClient; clientSecret: string }> {
    const db = getAuthDb();
    if (!db) throw new Error('Auth not initialized');
    if (!name.trim()) throw new Error('Client name required');
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) throw new Error('At least one redirect_uri required');
    for (const uri of redirectUris) {
        try {
            const u = new URL(uri);
            if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
                throw new Error(`redirect_uri must use https:// (got ${uri})`);
            }
        } catch (err) {
            throw new Error(`Invalid redirect_uri: ${uri}`);
        }
    }
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

export function updateOauthClientConsent(clientId: string, enabled: boolean, title: string, body: string): boolean {
    const db = getAuthDb();
    if (!db) return false;
    const result = db.prepare("UPDATE oauth_clients SET consent_enabled = $e, consent_title = $t, consent_body = $b, updated_at = datetime('now') WHERE client_id = $id")
        .run({ $e: enabled ? 1 : 0, $t: title || null, $b: body || null, $id: clientId });
    return result.changes > 0;
}

function rowToClient(r: any): OauthClient {
    return {
        clientId: r.client_id,
        name: r.name,
        redirectUris: JSON.parse(r.redirect_uris || '[]'),
        createdAt: r.created_at,
        consentEnabled: !!r.consent_enabled,
        consentTitle: r.consent_title || '',
        consentBody: r.consent_body || '',
        allowListEnabled: !!r.allow_list_enabled,
    };
}

export function getOauthClient(clientId: string): OauthClient | null {
    const db = getAuthDb();
    if (!db || !clientId) return null;
    const row = db.prepare('SELECT * FROM oauth_clients WHERE client_id = $id').get({ $id: clientId }) as any;
    return row ? rowToClient(row) : null;
}

export function listOauthClients(): OauthClient[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare('SELECT * FROM oauth_clients ORDER BY created_at DESC').all() as any[];
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
// oauth_client_users may obtain tokens for that client.

/** Returns true if the user may use this client (allow-list disabled OR user is in the list). */
export function isUserAllowedForClient(userId: number, clientId: string): boolean {
    const db = getAuthDb();
    if (!db) return false;
    const client = db.prepare('SELECT allow_list_enabled FROM oauth_clients WHERE client_id = $id').get({ $id: clientId }) as any;
    if (!client) return false;
    if (!client.allow_list_enabled) return true;
    const row = db.prepare('SELECT 1 FROM oauth_client_users WHERE client_id = $cid AND user_id = $uid').get({ $cid: clientId, $uid: userId });
    return !!row;
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
