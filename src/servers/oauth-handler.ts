// OAuth2 / OIDC endpoints: /oauth/authorize, /oauth/login, /oauth/token, /oauth/userinfo
//
// Security:
//   - redirect_uri: exact-string match (no normalization)
//   - PKCE S256 enforced (no plain, no missing)
//   - Auth code: single-use, 90s TTL, bound to (client, redirect_uri, code_challenge)
//   - Refresh token: rotation + family revocation on reuse
//   - Client auth: bcrypt verify, supports client_secret_post and client_secret_basic
//   - Implicit flow rejected (only response_type=code)

import {
    getOauthClient, isRedirectUriAllowed, verifyClientSecret,
    issueAuthCode, consumeAuthCode, issueRefreshToken, rotateRefreshToken,
    createSsoSession, validateSsoSession, destroySsoSession, getSsoTtl,
    type OauthClient,
} from '../auth/oauth';
import {
    verifyProxyUserCredentials, verifyTotp, getProxyUser, getJwtMaxAge,
    signJwt, verifyJwt, userIdToUuid, getJwtIssuer,
} from '../auth/auth';

const SSO_COOKIE = '__midleman_sso';
const SUPPORTED_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

let loginTemplate = '';
export function setOauthLoginTemplate(html: string): void {
    loginTemplate = html;
}

function getClientIp(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || 'unknown';
}

function parseCookies(req: Request): Record<string, string> {
    const out: Record<string, string> = {};
    const h = req.headers.get('cookie') || '';
    for (const part of h.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) out[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
    }
    return out;
}

function jsonError(status: number, error: string, description?: string): Response {
    return new Response(JSON.stringify({ error, error_description: description }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

/** HTML error for cases where we MUST NOT redirect (invalid client_id / redirect_uri). */
function htmlError(status: number, title: string, message: string): Response {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;background:#080a0f;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px}.box{max-width:480px}.code{font-size:11px;color:#666;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px}h1{font-size:22px;margin-bottom:8px}p{color:#888;line-height:1.6;font-size:13px}</style>
</head><body><div class="box"><p class="code">${status} — ${title}</p><h1>${title}</h1><p>${message}</p></div></body></html>`;
    return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** Redirect to client's callback with error per RFC 6749 §4.1.2.1 */
function redirectError(redirectUri: string, state: string | null, error: string, description?: string): Response {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    if (description) u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { 'Location': u.toString() } });
}

// ─── Auth request encoding ──────────────────────────────────────────────────
// We pack the validated /authorize params into a short-lived token that the
// login form echoes back. Avoids state leaking into the HTML.

interface AuthRequest {
    clientId: string;
    redirectUri: string;
    state: string;
    scope: string;
    codeChallenge: string;
    nonce: string | null;
}

const pendingAuthRequests = new Map<string, { req: AuthRequest; expiresAt: number }>();
const AUTH_REQUEST_TTL = 10 * 60 * 1000; // 10 min

function storeAuthRequest(req: AuthRequest): string {
    const id = crypto.randomUUID();
    pendingAuthRequests.set(id, { req, expiresAt: Date.now() + AUTH_REQUEST_TTL });
    // Best-effort cap
    if (pendingAuthRequests.size > 5000) {
        const oldest = pendingAuthRequests.keys().next().value;
        if (oldest) pendingAuthRequests.delete(oldest);
    }
    return id;
}

function consumeAuthRequest(id: string): AuthRequest | null {
    const entry = pendingAuthRequests.get(id);
    if (!entry) return null;
    pendingAuthRequests.delete(id);
    if (entry.expiresAt < Date.now()) return null;
    return entry.req;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingAuthRequests) {
        if (v.expiresAt < now) pendingAuthRequests.delete(k);
    }
}, 5 * 60 * 1000);

// ─── /oauth/authorize ───────────────────────────────────────────────────────

export async function handleAuthorize(req: Request, url: URL): Promise<Response> {
    const params = url.searchParams;
    const clientId = params.get('client_id') || '';
    const redirectUri = params.get('redirect_uri') || '';
    const responseType = params.get('response_type') || '';
    const state = params.get('state') || '';
    const scope = (params.get('scope') || 'openid').trim();
    const codeChallenge = params.get('code_challenge') || '';
    const codeChallengeMethod = params.get('code_challenge_method') || '';
    const nonce = params.get('nonce');

    // 1. Client must exist — render error (DO NOT redirect to attacker-controlled URI)
    const client = getOauthClient(clientId);
    if (!client) {
        return htmlError(400, 'Invalid client', 'The client_id is not registered with this server.');
    }

    // 2. redirect_uri must match exactly — same: no redirect
    if (!isRedirectUriAllowed(client, redirectUri)) {
        return htmlError(400, 'Invalid redirect_uri', 'The redirect_uri does not match a registered URI for this client.');
    }

    // From here on, errors can be returned via redirect (we know the URI is trusted).
    if (responseType !== 'code') {
        return redirectError(redirectUri, state, 'unsupported_response_type', 'Only response_type=code is supported');
    }
    if (codeChallengeMethod !== 'S256') {
        return redirectError(redirectUri, state, 'invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    if (!codeChallenge || codeChallenge.length < 32) {
        return redirectError(redirectUri, state, 'invalid_request', 'Missing or invalid code_challenge');
    }

    // Scope filtering — silently drop unknown scopes (don't fail the request)
    const requestedScopes = scope.split(/\s+/).filter(s => SUPPORTED_SCOPES.has(s));
    const finalScope = requestedScopes.includes('openid') ? requestedScopes.join(' ') : ('openid ' + requestedScopes.join(' ')).trim();

    const authRequest: AuthRequest = { clientId, redirectUri, state, scope: finalScope, codeChallenge, nonce };

    // 3. Check SSO cookie — if logged in, skip login form
    const cookies = parseCookies(req);
    const ssoId = cookies[SSO_COOKIE];
    if (ssoId) {
        const sso = validateSsoSession(ssoId);
        if (sso) {
            const code = issueAuthCode({
                clientId, userId: sso.userId, redirectUri,
                codeChallenge, scope: finalScope, nonce: nonce || undefined,
            });
            const u = new URL(redirectUri);
            u.searchParams.set('code', code);
            if (state) u.searchParams.set('state', state);
            return new Response(null, { status: 302, headers: { 'Location': u.toString() } });
        }
    }

    // 4. Render login form
    const authRequestId = storeAuthRequest(authRequest);
    const html = loginTemplate
        .replace(/\{\{CLIENT_NAME\}\}/g, escapeHtml(client.name))
        .replace(/\{\{AUTH_REQUEST\}\}/g, authRequestId);
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── /oauth/login (POST) ────────────────────────────────────────────────────

export async function handleOauthLogin(req: Request): Promise<Response> {
    if (req.method !== 'POST') return jsonError(405, 'method_not_allowed');
    let body: any;
    try { body = await req.json(); } catch { return jsonError(400, 'invalid_request', 'Invalid JSON body'); }

    const authRequestId = (body.auth_request || '').trim();
    const username = (body.username || '').trim();
    const password = (body.password || '').trim();
    const totpCode = (body.totp || '').trim();

    if (!authRequestId || !username || !password) {
        return jsonError(400, 'invalid_request', 'Missing required fields');
    }

    const authReq = consumeAuthRequest(authRequestId);
    if (!authReq) {
        return jsonError(400, 'invalid_request', 'Login session expired. Restart the sign-in flow.');
    }

    const cred = await verifyProxyUserCredentials(username, password);
    if (!cred) {
        // Re-store the auth request so user can retry without restarting
        const newId = storeAuthRequest(authReq);
        return new Response(JSON.stringify({ error: 'Invalid username or password', auth_request: newId }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // TOTP enforcement
    if (cred.user.totpEnabled) {
        if (!totpCode) {
            const newId = storeAuthRequest(authReq);
            return new Response(JSON.stringify({ status: 'totp_required', auth_request: newId }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (!cred.totpSecret || !verifyTotp(cred.totpSecret, totpCode)) {
            const newId = storeAuthRequest(authReq);
            return new Response(JSON.stringify({ error: 'Invalid authenticator code', auth_request: newId }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    // Issue SSO session + auth code
    const ssoId = createSsoSession(cred.user.id, getClientIp(req), req.headers.get('user-agent') || '');
    const code = issueAuthCode({
        clientId: authReq.clientId, userId: cred.user.id, redirectUri: authReq.redirectUri,
        codeChallenge: authReq.codeChallenge, scope: authReq.scope, nonce: authReq.nonce || undefined,
    });

    const u = new URL(authReq.redirectUri);
    u.searchParams.set('code', code);
    if (authReq.state) u.searchParams.set('state', authReq.state);

    return new Response(JSON.stringify({ redirect: u.toString() }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SSO_COOKIE}=${ssoId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${getSsoTtl()}`,
        },
    });
}

// ─── /oauth/token ───────────────────────────────────────────────────────────

interface ClientCredentials { clientId: string; clientSecret: string; }

/** Extract client credentials from Basic Auth header OR request body. */
function extractClientCredentials(req: Request, body: Record<string, string>): ClientCredentials | null {
    const authz = req.headers.get('authorization') || '';
    if (authz.toLowerCase().startsWith('basic ')) {
        try {
            const decoded = Buffer.from(authz.slice(6).trim(), 'base64').toString('utf-8');
            const colon = decoded.indexOf(':');
            if (colon > 0) {
                return {
                    clientId: decodeURIComponent(decoded.substring(0, colon)),
                    clientSecret: decodeURIComponent(decoded.substring(colon + 1)),
                };
            }
        } catch {}
    }
    if (body.client_id && body.client_secret) {
        return { clientId: body.client_id, clientSecret: body.client_secret };
    }
    return null;
}

async function parseTokenBody(req: Request): Promise<Record<string, string>> {
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await req.text();
        const out: Record<string, string> = {};
        for (const part of text.split('&')) {
            const eq = part.indexOf('=');
            if (eq > 0) out[decodeURIComponent(part.substring(0, eq))] = decodeURIComponent(part.substring(eq + 1).replace(/\+/g, ' '));
        }
        return out;
    }
    if (ct.includes('application/json')) {
        try { return await req.json() as Record<string, string>; } catch { return {}; }
    }
    return {};
}

export async function handleToken(req: Request): Promise<Response> {
    if (req.method !== 'POST') return jsonError(405, 'method_not_allowed');

    const body = await parseTokenBody(req);
    const creds = extractClientCredentials(req, body);
    if (!creds) return jsonError(401, 'invalid_client', 'Missing client credentials');

    const ok = await verifyClientSecret(creds.clientId, creds.clientSecret);
    if (!ok) return jsonError(401, 'invalid_client', 'Invalid client credentials');

    const grant = (body.grant_type || '').trim();
    if (grant === 'authorization_code') {
        return await handleCodeGrant(creds.clientId, body);
    }
    if (grant === 'refresh_token') {
        return await handleRefreshGrant(creds.clientId, body);
    }
    return jsonError(400, 'unsupported_grant_type', `Grant '${grant}' is not supported`);
}

async function handleCodeGrant(clientId: string, body: Record<string, string>): Promise<Response> {
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const codeVerifier = body.code_verifier;
    if (!code || !redirectUri || !codeVerifier) {
        return jsonError(400, 'invalid_request', 'Missing code, redirect_uri or code_verifier');
    }

    const consumed = consumeAuthCode(code, clientId, redirectUri, codeVerifier);
    if (!consumed) return jsonError(400, 'invalid_grant', 'Invalid or expired authorization code');

    const user = getProxyUser(consumed.userId);
    if (!user) return jsonError(400, 'invalid_grant', 'User no longer exists');

    return await issueTokenResponse(clientId, user, consumed.scope, consumed.nonce);
}

async function handleRefreshGrant(clientId: string, body: Record<string, string>): Promise<Response> {
    const presented = body.refresh_token;
    if (!presented) return jsonError(400, 'invalid_request', 'Missing refresh_token');

    const rotated = rotateRefreshToken(presented, clientId);
    if (!rotated) return jsonError(400, 'invalid_grant', 'Invalid or revoked refresh_token');

    const user = getProxyUser(rotated.userId);
    if (!user) return jsonError(400, 'invalid_grant', 'User no longer exists');

    return await issueTokenResponse(clientId, user, rotated.scope, null, rotated.refreshToken);
}

async function issueTokenResponse(
    clientId: string,
    user: ReturnType<typeof getProxyUser> & object,
    scope: string,
    nonce: string | null,
    rotatedRefreshToken?: string,
): Promise<Response> {
    const sub = userIdToUuid(user.id);
    const accessTtl = getJwtMaxAge();

    const claims: Record<string, unknown> = {
        sub,
        aud: clientId,
        midleman_uid: user.id,
        preferred_username: user.username,
    };
    if (scope.includes('email') && user.email) claims.email = user.email;
    if (scope.includes('profile') && user.fullName) claims.name = user.fullName;
    if (nonce) claims.nonce = nonce;

    const idToken = signJwt(claims, { ttlSeconds: accessTtl });
    // For our case, access_token and id_token carry the same JWT. Supabase verifies
    // it via JWKS and uses claims to populate auth.users.
    const accessToken = idToken;

    const responseBody: Record<string, unknown> = {
        access_token: accessToken,
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: accessTtl,
        scope,
    };

    if (rotatedRefreshToken) {
        responseBody.refresh_token = rotatedRefreshToken;
    } else if (scope.includes('offline_access') || scope.includes('openid')) {
        // Always issue a refresh token alongside an id_token. Supabase expects this.
        const { refreshToken } = issueRefreshToken(clientId, user.id, scope);
        responseBody.refresh_token = refreshToken;
    }

    return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    });
}

// ─── /oauth/userinfo ────────────────────────────────────────────────────────

export async function handleUserinfo(req: Request): Promise<Response> {
    const authz = req.headers.get('authorization') || '';
    if (!authz.toLowerCase().startsWith('bearer ')) {
        return new Response(JSON.stringify({ error: 'invalid_token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
        });
    }
    const token = authz.slice(7).trim();
    const payload = verifyJwt(token);
    if (!payload) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    const uid = payload.midleman_uid as number;
    if (!uid) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    const user = getProxyUser(uid);
    if (!user) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({
        sub: userIdToUuid(user.id),
        preferred_username: user.username,
        email: user.email || undefined,
        name: user.fullName || undefined,
        midleman_uid: user.id,
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ─── /oauth/logout ──────────────────────────────────────────────────────────

export function handleOauthLogout(req: Request): Response {
    const cookies = parseCookies(req);
    const ssoId = cookies[SSO_COOKIE];
    if (ssoId) destroySsoSession(ssoId);
    return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SSO_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        },
    });
}
