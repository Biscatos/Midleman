import type { ProxyProfile } from '../core/types';
import { handleDirectProxy } from '../proxy/proxy';
import { verifyProxyUserCredentials, signJwt, getJwtMaxAge, checkRateLimit, proxyUserHasProfile, createProxyLoginChallenge, consumeProxyLoginChallenge, peekProxyLoginChallenge, generateTotpSecret, verifyTotp, setupProxyUserTotp } from '../auth/auth';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProxyServerInstance {
    profile: ProxyProfile;
    server: ReturnType<typeof Bun.serve>;
    port: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

const servers = new Map<string, ProxyServerInstance>();

// Injected from outside to avoid circular deps
let proxyLoginHtml = '';
let logoBytes: Uint8Array | null = null;

export function setProxyLoginTemplate(html: string): void {
    proxyLoginHtml = html;
}
export function setProxyLogo(bytes: Uint8Array | null): void {
    logoBytes = bytes;
}

function jsonRes(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

export function startProxyServer(profile: ProxyProfile, port: number): ProxyServerInstance {
    const server = Bun.serve({
        port,
        idleTimeout: 0,
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        async fetch(req: Request): Promise<Response> {
            const startTime = performance.now();
            const url = new URL(req.url);

            // ── Serve static assets (logo, favicon) for login page ──
            if (url.pathname === '/logo.png' || url.pathname === '/favicon.ico' || url.pathname === '/favicon.png') {
                if (logoBytes) {
                    return new Response(logoBytes, {
                        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' },
                    });
                }
                return new Response(null, { status: 204 });
            }

            // ── Proxy user auth routes (login mode only) ──
            if (profile.authMode === 'login') {
                // GET /auth/login — serve login page
                if (url.pathname === '/auth/login' && req.method === 'GET') {
                    const html = proxyLoginHtml
                        .replace(/\{\{PROFILE_NAME\}\}/g, profile.name)
                        .replace(/\{\{REQUIRE_2FA\}\}/g, profile.require2fa ? 'true' : 'false');
                    return new Response(html, {
                        status: 200,
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    });
                }

                // POST /auth/login — Step 1: verify credentials, return challenge token
                if (url.pathname === '/auth/login' && req.method === 'POST') {
                    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
                    if (!checkRateLimit(clientIp)) {
                        return jsonRes(429, { error: 'Too many attempts. Try again in 15 minutes.' });
                    }

                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const username = (body.username || '').trim();
                    const password = body.password || '';
                    if (!username || !password) return jsonRes(400, { error: 'Username and password required' });

                    const cred = await verifyProxyUserCredentials(username, password);
                    if (!cred) return jsonRes(401, { error: 'Invalid username or password' });

                    // Check if user has access to this profile
                    if (!proxyUserHasProfile(cred.user.id, profile.name)) {
                        return jsonRes(403, { error: 'You do not have access to this application' });
                    }

                    const require2fa = !!profile.require2fa;
                    const totpEnabled = cred.user.totpEnabled;

                    // If no TOTP required and user hasn't set up TOTP, issue JWT directly
                    if (!require2fa && !totpEnabled) {
                        const token = signJwt({ sub: cred.user.id, username: cred.user.username, profile: profile.name });
                        const maxAge = getJwtMaxAge();
                        return new Response(JSON.stringify({ status: 'ok', username: cred.user.username }), {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/json',
                                'Set-Cookie': `__midleman_auth_${profile.name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
                            },
                        });
                    }

                    // Otherwise, issue a challenge token for the TOTP step
                    const challengeToken = createProxyLoginChallenge(cred.user.id, cred.user.username, cred.totpSecret, totpEnabled, profile.name);

                    if (totpEnabled) {
                        // User already has TOTP → ask for code
                        return jsonRes(200, { status: 'totp_required', challengeToken });
                    } else {
                        // 2FA required by profile but user hasn't set it up → generate QR
                        const totp = generateTotpSecret(cred.user.username);
                        return jsonRes(200, {
                            status: 'totp_setup',
                            challengeToken,
                            totpSecret: totp.secret,
                            otpauthUrl: totp.otpauthUrl,
                        });
                    }
                }

                // POST /auth/totp — Step 2: verify TOTP code (or setup + verify)
                if (url.pathname === '/auth/totp' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const challengeToken = (body.challengeToken || '').trim();
                    const totpCode = (body.totpCode || '').trim();
                    const totpSecret = (body.totpSecret || '').trim(); // only for setup flow
                    if (!challengeToken || !totpCode) return jsonRes(400, { error: 'Challenge token and TOTP code required' });

                    const challenge = consumeProxyLoginChallenge(challengeToken);
                    if (!challenge) return jsonRes(401, { error: 'Session expired. Please start login again.' });

                    if (challenge.totpEnabled && challenge.totpSecret) {
                        // Verify existing TOTP
                        if (!verifyTotp(challenge.totpSecret, totpCode)) {
                            return jsonRes(401, { error: 'Invalid authenticator code' });
                        }
                    } else if (totpSecret) {
                        // First-time setup: verify the code against the new secret, then save
                        if (!verifyTotp(totpSecret, totpCode)) {
                            return jsonRes(401, { error: 'Invalid code. Scan the QR code and try again.' });
                        }
                        setupProxyUserTotp(challenge.userId, totpSecret);
                    } else {
                        return jsonRes(400, { error: 'TOTP secret required for setup' });
                    }

                    // Issue JWT
                    const token = signJwt({ sub: challenge.userId, username: challenge.username, profile: profile.name });
                    const maxAge = getJwtMaxAge();
                    return new Response(JSON.stringify({ status: 'ok', username: challenge.username }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Set-Cookie': `__midleman_auth_${profile.name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
                        },
                    });
                }

                // POST /auth/logout — clear JWT cookie
                if (url.pathname === '/auth/logout' && req.method === 'POST') {
                    return new Response(JSON.stringify({ status: 'ok' }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Set-Cookie': `__midleman_auth_${profile.name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
                        },
                    });
                }
            }

            return handleDirectProxy(req, profile, startTime);
        },
        error(err: Error) {
            console.error(`[proxy:${profile.name}] server error:`, err);
            return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    });

    const instance: ProxyServerInstance = { profile, server, port: server.port ?? port };
    servers.set(profile.name, instance);
    console.log(`🌐 Proxy "${profile.name}" on :${server.port} → ${profile.targetUrl}`);
    return instance;
}

export async function stopProxyServer(name: string): Promise<void> {
    const ps = servers.get(name);
    if (!ps) return;
    ps.server.stop();
    servers.delete(name);
    console.log(`🛑 Proxy "${name}" stopped`);
}

export async function stopAllProxyServers(): Promise<void> {
    for (const name of [...servers.keys()]) {
        await stopProxyServer(name);
    }
}

export async function restartProxyServer(name: string, newProfile?: ProxyProfile, newPort?: number): Promise<ProxyServerInstance | null> {
    const existing = servers.get(name);
    if (!existing) return null;
    const port = newPort ?? existing.port;
    const profile = newProfile || existing.profile;
    await stopProxyServer(name);
    return startProxyServer(profile, port);
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function getProxyServerStatus(): { name: string; port: number; targetUrl: string; running: boolean }[] {
    return Array.from(servers.values()).map(ps => ({
        name: ps.profile.name,
        port: ps.port,
        targetUrl: ps.profile.targetUrl,
        running: true,
    }));
}

export function getProxyServerPort(name: string): number | undefined {
    return servers.get(name)?.port;
}

export function isProxyServerRunning(name: string): boolean {
    return servers.has(name);
}
