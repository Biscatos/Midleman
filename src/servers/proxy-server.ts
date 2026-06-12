import type { ProxyProfile } from '../core/types';
import { handleDirectProxy, rememberPeerIp, isSecureRequest } from '../proxy/proxy';
import { resolveClientIp, getTrustProxyConfig } from '../core/ip-filter';
import { verifyProxyUserCredentials, signJwt, verifyJwt, getJwtMaxAge, checkRateLimit, recordFailedAttempt, MAX_ATTEMPTS_PER_IP, proxyUserHasProfile, createProxyLoginChallenge, consumeProxyLoginChallenge, peekProxyLoginChallenge, generateTotpSecret, verifyTotp, setupProxyUserTotp, userIdToUuid, upsertLdapShadowProxyUserDetailed, assignProxyUserToProfile, getProxyUserTotpSecret, logAudit, createPasswordResetToken, getPasswordResetToken, consumePasswordResetToken, findResetCandidateByEmail, getProxyUser, updateProxyUserPassword } from '../auth/auth';
import { isSmtpConfigured, sendMail, renderPasswordResetEmail } from '../core/smtp';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { tryLdapLogin } from '../auth/ldap';
import { getConsentPage } from '../auth/consent-pages';
import { renderConsentMarkdown, escapeHtmlAttr } from '../core/consent';

/** Resolve the consent page linked to a profile. Degrades silently to "no consent
 *  shown" when consentEnabled is true but the linked page was deleted. */
function resolveProfileConsent(profile: ProxyProfile): { enabled: boolean; title: string; body: string } {
    if (!profile.consentEnabled || !profile.consentPageId) return { enabled: false, title: '', body: '' };
    const page = getConsentPage(profile.consentPageId);
    if (!page) return { enabled: false, title: '', body: '' };
    const title = (page.title || '').trim();
    const body = (page.body || '').trim();
    if (!title && !body) return { enabled: false, title: '', body: '' };
    return { enabled: true, title: title || 'Termos de utilização', body };
}
import QRCode from 'qrcode';

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

const SAFE_LOGO_RE = /^(https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)[A-Za-z0-9+/=.\-_~:@!$&'()*+,;%?#[\]]+$/;
function safeLogoUrl(raw: string | undefined, targetUrl?: string): string {
    if (raw && SAFE_LOGO_RE.test(raw)) return raw;
    // Auto-derive favicon from the proxied target's origin
    if (targetUrl) {
        try { return new URL(targetUrl).origin + '/favicon.ico'; } catch {}
    }
    return '/logo.png';
}

export function setProxyLoginTemplate(html: string): void {
    proxyLoginHtml = html;
}
export function setProxyLogo(bytes: Uint8Array | null): void {
    logoBytes = bytes;
}

const SECURITY_HEADERS: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function jsonRes(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS },
    });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

export function startProxyServer(profile: ProxyProfile, port: number): ProxyServerInstance {
    const server = Bun.serve({
        port,
        idleTimeout: 0,
        maxRequestBodySize: 50 * 1024 * 1024, // 50MB
        async fetch(req: Request, srv): Promise<Response> {
            const startTime = performance.now();
            const url = new URL(req.url);
            // Capture the real socket peer IP before any handler reads the
            // (spoofable) X-Forwarded-For header.
            rememberPeerIp(req, srv?.requestIP?.(req)?.address ?? null);

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
                    const loginTitle = escapeHtmlAttr(profile.loginTitle || 'Midleman');
                    const loginLogoUrl = safeLogoUrl(profile.loginLogo, profile.targetUrl);
                    const consent = resolveProfileConsent(profile);
                    const html = proxyLoginHtml
                        .replace(/\{\{PROFILE_NAME\}\}/g, profile.name)
                        .replace(/\{\{REQUIRE_2FA\}\}/g, profile.require2fa ? 'true' : 'false')
                        .replace(/\{\{LOGIN_TITLE\}\}/g, loginTitle)
                        .replace(/\{\{LOGIN_LOGO_URL\}\}/g, loginLogoUrl)
                        .replace(/\{\{CONSENT_ENABLED\}\}/g, consent.enabled ? '1' : '0')
                        .replace(/\{\{CONSENT_TITLE\}\}/g, escapeHtmlAttr(consent.title))
                        .replace(/\{\{CONSENT_BODY\}\}/g, renderConsentMarkdown(consent.body));
                    return new Response(html, {
                        status: 200,
                        headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
                    });
                }

                // POST /auth/login — Step 1: verify credentials, return challenge token
                if (url.pathname === '/auth/login' && req.method === 'POST') {
                    const clientIp = resolveClientIp(srv?.requestIP?.(req)?.address ?? null, req.headers.get('x-forwarded-for'), getTrustProxyConfig());
                    const userAgent = req.headers.get('user-agent');

                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const username = (body.username || '').trim();
                    const password = body.password || '';
                    if (!username || !password) return jsonRes(400, { error: 'Username and password required' });

                    // Two-tier rate limit: tight 5/15min by username (blocks
                    // targeted brute-force) + loose 50/15min by IP (catches
                    // distributed credential stuffing without locking out an
                    // entire corporate NAT when one user mistypes).
                    const rlKey = `u:${username.toLowerCase()}`;
                    const ipKey = `ip:${clientIp}`;
                    if (!checkRateLimit(rlKey) || !checkRateLimit(ipKey, MAX_ATTEMPTS_PER_IP)) {
                        logAudit({ action: 'proxy.login.rate_limited', actorUsername: username, targetType: 'proxy_profile', targetId: profile.name, details: { profile: profile.name }, ip: clientIp, userAgent });
                        return jsonRes(429, { error: 'Too many attempts. Try again in 15 minutes.' });
                    }

                    // 1) Local-first
                    let cred = await verifyProxyUserCredentials(username, password);
                    let ldapDiagnostic: { reason?: string; detail?: string; configName?: string } | null = null;

                    // 2) Fallback to LDAP
                    if (!cred) {
                        const ldap = await tryLdapLogin('proxy', username, password);
                        if (ldap.ok) {
                            const outcome = upsertLdapShadowProxyUserDetailed({
                                ldapConfigId: ldap.auth.configId,
                                ldapDn: ldap.auth.dn,
                                username: ldap.auth.username,
                                fullName: ldap.auth.fullName,
                                email: ldap.auth.email,
                                groups: ldap.auth.groups,
                                autoAdoptLocal: ldap.auth.autoAdoptLocal,
                            });
                            if (!outcome.ok) {
                                logAudit({
                                    action: 'ldap.provision.refused',
                                    actorUsername: ldap.auth.username,
                                    targetType: 'proxy_profile',
                                    targetId: profile.name,
                                    details: {
                                        directory: ldap.auth.configName,
                                        dn: ldap.auth.dn,
                                        reason: outcome.reason,
                                        collidingUserId: 'collidingUserId' in outcome ? outcome.collidingUserId : undefined,
                                        profile: profile.name,
                                    },
                                });
                                recordFailedAttempt(rlKey);
                                recordFailedAttempt(ipKey);
                                return jsonRes(401, { error: 'Invalid username or password' });
                            }
                            const shadow = outcome.user;
                            if (outcome.adopted) {
                                logAudit({
                                    action: 'ldap.user.adopted',
                                    actorUserId: shadow.id,
                                    actorUsername: shadow.username,
                                    targetType: 'proxy_profile',
                                    targetId: profile.name,
                                    details: {
                                        directory: ldap.auth.configName,
                                        dn: ldap.auth.dn,
                                        matchedOn: outcome.adopted.matchedOn,
                                        adoptionEventId: outcome.adopted.eventId,
                                        previousAuthSource: outcome.adopted.previousAuthSource,
                                    },
                                });
                            }
                            if (ldap.grantedProfile) {
                                assignProxyUserToProfile(shadow.id, ldap.grantedProfile);
                            }
                            // The shadow row may already have TOTP enrolled
                            // (e.g. an admin who set up TOTP in the dashboard
                            // and now logs into the proxy via LDAP). Load the
                            // stored secret so the challenge can verify a code
                            // instead of falling through to the setup branch.
                            cred = { user: shadow, totpSecret: shadow.totpEnabled ? getProxyUserTotpSecret(shadow.id) : null };
                        } else if (ldap.reason === 'server_error') {
                            return jsonRes(502, { error: 'Directory configuration error. Ask an admin to check the LDAP directory.' });
                        } else {
                            // Capture WHY ldap failed so the proxy.login.failed
                            // audit entry below carries something actionable
                            // instead of a generic 'bad_credentials'.
                            ldapDiagnostic = {
                                reason: ldap.reason,
                                detail: 'detail' in ldap ? ldap.detail : undefined,
                            };
                        }
                    }

                    if (!cred) {
                        logAudit({
                            action: 'proxy.login.failed',
                            actorUsername: username,
                            targetType: 'proxy_profile',
                            targetId: profile.name,
                            details: {
                                profile: profile.name,
                                reason: ldapDiagnostic ? `ldap_${ldapDiagnostic.reason}` : 'local_password_mismatch',
                                ldapDetail: ldapDiagnostic?.detail,
                            },
                            ip: clientIp,
                            userAgent,
                        });
                        recordFailedAttempt(rlKey);
                        recordFailedAttempt(ipKey);
                        return jsonRes(401, { error: 'Invalid username or password' });
                    }

                    // Check if user has access to this profile
                    if (!proxyUserHasProfile(cred.user.id, profile.name)) {
                        logAudit({ action: 'proxy.login.denied', actorUserId: cred.user.id, actorUsername: cred.user.username, targetType: 'proxy_profile', targetId: profile.name, details: { profile: profile.name, reason: 'no_profile_access' }, ip: clientIp, userAgent });
                        return jsonRes(403, { error: 'You do not have access to this application' });
                    }

                    const require2fa = !!profile.require2fa || !!cred.user.force2faSetup;
                    const totpEnabled = cred.user.totpEnabled;

                    // If no TOTP required and user hasn't set up TOTP, issue JWT directly
                    if (!require2fa && !totpEnabled) {
                        const token = signJwt({ sub: userIdToUuid(cred.user.id), username: cred.user.username, profile: profile.name, midleman_uid: cred.user.id });
                        const maxAge = getJwtMaxAge();
                        logAudit({ action: 'proxy.login.success', actorUserId: cred.user.id, actorUsername: cred.user.username, targetType: 'proxy_profile', targetId: profile.name, details: { profile: profile.name, mfa: false, authSource: cred.user.authSource || 'local' }, ip: clientIp, userAgent });
                        return new Response(JSON.stringify({ status: 'ok', username: cred.user.username }), {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/json',
                                'Set-Cookie': `__midleman_auth_${profile.name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/;${isSecureRequest(req) ? ' Secure;' : ''} Max-Age=${maxAge}`,
                            },
                        });
                    }

                    // Otherwise, issue a challenge token for the TOTP step
                    const challengeToken = createProxyLoginChallenge(cred.user.id, cred.user.username, cred.totpSecret, totpEnabled, profile.name);

                    if (totpEnabled) {
                        // User already has TOTP → ask for code
                        return jsonRes(200, { status: 'totp_required', challengeToken });
                    } else {
                        // 2FA required by profile but user hasn't set it up → generate QR server-side
                        const totp = generateTotpSecret(cred.user.username);
                        const qrDataUrl = await QRCode.toDataURL(totp.otpauthUrl, { width: 200, margin: 2 }).catch(() => null);
                        return jsonRes(200, {
                            status: 'totp_setup',
                            challengeToken,
                            totpSecret: totp.secret,
                            qrDataUrl,
                        });
                    }
                }

                // POST /auth/totp — Step 2: verify TOTP code (or setup + verify)
                if (url.pathname === '/auth/totp' && req.method === 'POST') {
                    const clientIp = resolveClientIp(srv?.requestIP?.(req)?.address ?? null, req.headers.get('x-forwarded-for'), getTrustProxyConfig());
                    const userAgent = req.headers.get('user-agent');

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
                            logAudit({ action: 'proxy.login.failed', actorUserId: challenge.userId, actorUsername: challenge.username, targetType: 'proxy_profile', targetId: profile.name, details: { profile: profile.name, reason: 'bad_totp' }, ip: clientIp, userAgent });
                            return jsonRes(401, { error: 'Invalid authenticator code' });
                        }
                    } else if (totpSecret) {
                        // First-time setup: verify the code against the new secret, then save
                        if (!verifyTotp(totpSecret, totpCode)) {
                            logAudit({ action: 'proxy.login.failed', actorUserId: challenge.userId, actorUsername: challenge.username, targetType: 'proxy_profile', targetId: profile.name, details: { profile: profile.name, reason: 'bad_totp_setup' }, ip: clientIp, userAgent });
                            return jsonRes(401, { error: 'Invalid code. Scan the QR code and try again.' });
                        }
                        setupProxyUserTotp(challenge.userId, totpSecret);
                    } else {
                        return jsonRes(400, { error: 'TOTP secret required for setup' });
                    }

                    // Issue JWT
                    const token = signJwt({ sub: userIdToUuid(challenge.userId), username: challenge.username, profile: profile.name, midleman_uid: challenge.userId });
                    const maxAge = getJwtMaxAge();
                    logAudit({ action: 'proxy.login.success', actorUserId: challenge.userId, actorUsername: challenge.username, targetType: 'proxy_profile', targetId: profile.name, details: { profile: profile.name, mfa: true }, ip: clientIp, userAgent });
                    return new Response(JSON.stringify({ status: 'ok', username: challenge.username }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Set-Cookie': `__midleman_auth_${profile.name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
                        },
                    });
                }

                // POST /auth/forgot — self-service password reset (always 200).
                if (url.pathname === '/auth/forgot' && req.method === 'POST') {
                    const clientIp = resolveClientIp(srv?.requestIP?.(req)?.address ?? null, req.headers.get('x-forwarded-for'), getTrustProxyConfig());
                    const userAgent = req.headers.get('user-agent');
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const email = String(body.email || '').trim().toLowerCase();
                    const ok = jsonRes(200, { status: 'ok', message: 'If an account exists for this address, a password reset email has been sent.' });
                    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ok;
                    const ipKey = `forgot:ip:${clientIp}`;
                    const emailKey = `forgot:em:${email}`;
                    if (!checkRateLimit(ipKey, MAX_ATTEMPTS_PER_IP) || !checkRateLimit(emailKey)) {
                        logAudit({ action: 'password_reset.rate_limited', targetType: 'proxy_profile', targetId: profile.name, details: { email, profile: profile.name }, ip: clientIp, userAgent });
                        return ok;
                    }
                    recordFailedAttempt(ipKey);
                    const candidate = findResetCandidateByEmail(email);
                    if (!candidate) {
                        logAudit({ action: 'password_reset.requested', targetType: 'proxy_profile', targetId: profile.name, details: { email, outcome: 'no_local_match', profile: profile.name }, ip: clientIp, userAgent });
                        return ok;
                    }
                    if (!isSmtpConfigured()) {
                        logAudit({ action: 'password_reset.requested', actorUserId: candidate.id, actorUsername: candidate.username, targetType: 'proxy_user', targetId: candidate.id, details: { email, outcome: 'smtp_unavailable', profile: profile.name }, ip: clientIp, userAgent });
                        return ok;
                    }
                    const { token: rtoken, expiresAt } = createPasswordResetToken(candidate.id, { createdBy: null, createdIp: clientIp });
                    const reqHost = req.headers.get('host') || 'localhost';
                    const protocol = req.headers.get('x-forwarded-proto') || 'http';
                    const resetUrl = `${protocol}://${reqHost}/auth/reset?token=${encodeURIComponent(rtoken)}`;
                    const tpl = renderPasswordResetEmail({
                        fullName: candidate.fullName,
                        resetUrl,
                        expiresInMinutes: 60,
                        initiatedByAdmin: false,
                    });
                    const r = await sendMail({ to: candidate.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
                    logAudit({
                        actorUserId: candidate.id, actorUsername: candidate.username,
                        action: 'password_reset.requested',
                        targetType: 'proxy_user', targetId: candidate.id,
                        details: { email, outcome: r.ok ? 'sent' : 'send_failed', emailError: r.error, expiresAt, profile: profile.name },
                        ip: clientIp, userAgent,
                    });
                    return ok;
                }

                // GET /auth/reset?token=… — serve the reset page.
                if (url.pathname === '/auth/reset' && req.method === 'GET') {
                    const token = url.searchParams.get('token') || '';
                    const info = getPasswordResetToken(token);
                    const expired = !info || !!info.usedAt || new Date(info.expiresAt) < new Date();
                    const escH = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    const pageHtml = readFileSync(resolve(import.meta.dir, '../views/password-reset.html'), 'utf-8');
                    const html = pageHtml
                        .replace(/\{\{TOKEN\}\}/g, expired ? '' : escH(token))
                        .replace(/\{\{INVALID_DISPLAY\}\}/g, expired ? 'block' : 'none')
                        .replace(/\{\{FORM_DISPLAY\}\}/g, expired ? 'none' : 'block');
                    return new Response(html, { status: expired ? 410 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
                }

                // POST /auth/reset — { token, password } → set new password.
                if (url.pathname === '/auth/reset' && req.method === 'POST') {
                    const clientIp = resolveClientIp(srv?.requestIP?.(req)?.address ?? null, req.headers.get('x-forwarded-for'), getTrustProxyConfig());
                    const userAgent = req.headers.get('user-agent');
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const rtoken = String(body.token || '').trim();
                    const password = String(body.password || '');
                    if (!rtoken) return jsonRes(400, { error: 'Missing token.' });
                    if (!password || password.length < 8) return jsonRes(400, { error: 'Password must be at least 8 characters.' });
                    const ipKey = `reset:ip:${clientIp}`;
                    if (!checkRateLimit(ipKey, MAX_ATTEMPTS_PER_IP)) return jsonRes(429, { error: 'Too many attempts. Try again in 15 minutes.' });
                    const userId = consumePasswordResetToken(rtoken);
                    if (!userId) {
                        recordFailedAttempt(ipKey);
                        logAudit({ action: 'password_reset.failed', targetType: 'proxy_profile', targetId: profile.name, details: { reason: 'invalid_or_expired_token', profile: profile.name }, ip: clientIp, userAgent });
                        return jsonRes(410, { error: 'This reset link is invalid, expired, or already used. Request a new one.' });
                    }
                    const target = getProxyUser(userId);
                    if (!target) return jsonRes(410, { error: 'Account no longer exists.' });
                    if ((target.authSource || 'local') !== 'local') {
                        logAudit({ action: 'password_reset.failed', actorUserId: userId, actorUsername: target.username, targetType: 'proxy_user', targetId: userId, details: { reason: 'ldap_user', profile: profile.name }, ip: clientIp, userAgent });
                        return jsonRes(409, { error: 'This account is managed by a directory and cannot be reset here.' });
                    }
                    const updated = await updateProxyUserPassword(userId, password);
                    if (!updated) {
                        logAudit({ action: 'password_reset.failed', actorUserId: userId, actorUsername: target.username, targetType: 'proxy_user', targetId: userId, details: { reason: 'update_failed', profile: profile.name }, ip: clientIp, userAgent });
                        return jsonRes(500, { error: 'Failed to update password.' });
                    }
                    logAudit({
                        actorUserId: userId, actorUsername: target.username,
                        action: 'password_reset.completed',
                        targetType: 'proxy_user', targetId: userId,
                        details: { username: target.username, profile: profile.name },
                        ip: clientIp, userAgent,
                    });
                    return jsonRes(200, { status: 'ok' });
                }

                // POST /auth/logout — clear JWT cookie
                if (url.pathname === '/auth/logout' && req.method === 'POST') {
                    const clientIp = resolveClientIp(srv?.requestIP?.(req)?.address ?? null, req.headers.get('x-forwarded-for'), getTrustProxyConfig());
                    const userAgent = req.headers.get('user-agent');
                    const cookies = req.headers.get('cookie') || '';
                    const m = cookies.match(new RegExp(`(?:^|;\\s*)__midleman_auth_${profile.name}=([^;]+)`));
                    if (m) {
                        const payload = verifyJwt(decodeURIComponent(m[1]));
                        if (payload) {
                            logAudit({
                                action: 'proxy.logout',
                                actorUserId: typeof payload.midleman_uid === 'number' ? payload.midleman_uid : null,
                                actorUsername: typeof payload.username === 'string' ? payload.username : '',
                                targetType: 'proxy_profile',
                                targetId: profile.name,
                                details: { profile: profile.name },
                                ip: clientIp,
                                userAgent,
                            });
                        }
                    }
                    return new Response(JSON.stringify({ status: 'ok' }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Set-Cookie': `__midleman_auth_${profile.name}=; HttpOnly; SameSite=Lax; Path=/;${isSecureRequest(req) ? ' Secure;' : ''} Max-Age=0`,
                        },
                    });
                }
            }

            const renderLoginHtml = (profileName: string, require2fa: boolean) => {
                const loginTitle = escapeHtmlAttr(profile.loginTitle || 'Midleman');
                const loginLogoUrl = safeLogoUrl(profile.loginLogo, profile.targetUrl);
                const consent = resolveProfileConsent(profile);
                return proxyLoginHtml
                    .replace(/\{\{PROFILE_NAME\}\}/g, profileName)
                    .replace(/\{\{REQUIRE_2FA\}\}/g, require2fa ? 'true' : 'false')
                    .replace(/\{\{LOGIN_TITLE\}\}/g, loginTitle)
                    .replace(/\{\{LOGIN_LOGO_URL\}\}/g, loginLogoUrl)
                    .replace(/\{\{LOGIN_TITLE_SUFFIX\}\}/g, profile.loginTitle ? '' : ' — Midleman')
                    .replace(/\{\{CONSENT_ENABLED\}\}/g, consent.enabled ? '1' : '0')
                    .replace(/\{\{CONSENT_TITLE\}\}/g, escapeHtmlAttr(consent.title))
                    .replace(/\{\{CONSENT_BODY\}\}/g, renderConsentMarkdown(consent.body));
            };

            return handleDirectProxy(req, profile, startTime, renderLoginHtml);
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
