import { loadConfig, reloadEnvFile, loadProxyProfiles, loadTcpUdpProfiles } from './core/config';
import { UnauthorizedError, type ProxyProfile } from './core/types';
import { invalidateProfileCache } from './proxy/proxy';
import {
    loadPersistedProfiles, persistProfiles, mergeProfiles, validateProfileInput,
    loadPersistedWebhooks, persistWebhooks, validateWebhookInput,
    loadPersistedTcpUdpProfiles, persistTcpUdpProfiles, validateTcpUdpProfileInput,
} from './core/store';
import { initTelemetry, shutdownTelemetry, getTelemetryConfig, getMetricsSnapshot } from './telemetry/telemetry';
import { initRequestLog, shutdownRequestLog, queryRequestLogs, getRequestLogDetail, getRequestLogStats, getRequestLogChart } from './telemetry/request-log';
import { initSipLog, shutdownSipLog, querySipLogs, getSipLogDetail, getSipLogStats } from './telemetry/sip-log';
import { initConnLog, shutdownConnLog, queryConnLogs } from './telemetry/tcpudp-conn-log';
import { initCertStore, shutdownCertStore, listCerts, getCert, getCertByDomain, createCert, updateCertPem, deleteCert, listProfilesUsingCert, generateSelfSigned } from './core/cert-store';
import { migrateProfileCerts } from './core/cert-migration';
import { scheduleAcmeRenewal, shutdownAcme, requestCertificate } from './sip/acme';
import { startProxyServer, stopProxyServer, stopAllProxyServers, restartProxyServer, getProxyServerStatus, getProxyServerPort, isProxyServerRunning, setProxyLoginTemplate, setProxyLogo } from './servers/proxy-server';
import { loadPortAssignments, assignAllPorts, assignProxyPort, assignWebhookPort, assignTcpUdpListenerPort, releaseProxyPort, releaseWebhookPort, releaseTcpUdpListenerPorts, getWebhookPort } from './servers/port-manager';
import { startWebhookServer, stopAllWebhooks, stopWebhookServer, restartWebhook, getWebhookStatus, getDeadLetterQueue, retryFailedFanout, retryAllFailedFanouts, dismissFailedFanout, flushDlqSync, getPendingRetryQueue, dismissPendingRetry, retryPendingNow, startPendingRetryScheduler, stopPendingRetryScheduler, startSilenceAlertScheduler, stopSilenceAlertScheduler, resetSilenceState } from './servers/webhook-server';
import { startSipServer, stopSipServer, stopAllSipServers, restartSipServer, getSipServerStatus, isSipServerRunning } from './servers/sip-server';
import { challengeStore } from './sip/acme';
import { initAuth, shutdownAuth, hasUsers, createUser, verifyCredentials, generateTotpSecret, verifyTotp, createSession, validateSession, destroySession, checkRateLimit, parseCookies, sessionCookie, clearSessionCookie, createLoginChallenge, consumeLoginChallenge, initJwt, getJwks, getOidcDiscovery, createProxyUser, listAllProxyUsers, getProxyUser, deleteProxyUser, updateProxyUserPassword, updateProxyUserInfo, findProxyUserByEmailOrUsername, listProxyUsersForProfile, assignProxyUserToProfile, removeProxyUserFromProfile, removeAllProfileAssociations, listLdapGroupsForProfile, addLdapGroupToProfile, removeLdapGroupFromProfile, getProfileLdapGroupById, removeAllProfileLdapGroups, shadowUserMatchesProfileLdapGroups, listProfilesForProxyUser, disableProxyUserTotp, setProxyUserForce2faSetup, setProxyUserAdminRole, createInviteToken, getInviteToken, listInviteTokens, useInviteToken, revokeInviteToken, listAdmins, getAdmin, countAdmins, createAdditionalAdmin, deleteAdmin, updateAdminPassword, setAdminTotp, getAdminTotpSecret, logAudit, queryAuditLogs, createAdminInvite, getAdminInvite, listAdminInvites, consumeAdminInvite, revokeAdminInvite, upsertLdapShadowAdmin, listAdoptionEvents, countPendingAdoptions, confirmAdoption, revertAdoption } from './auth/auth';
import { initOauth, createOauthClient, listOauthClients, deleteOauthClient, updateOauthClient, setOauthClientAllowList, addUserToOauthClient, removeUserFromOauthClient, listUsersForOauthClient, getOauthClient, listLdapGroupsForOauthClient, addLdapGroupToOauthClient, removeLdapGroupFromOauthClient, reconcileShadowAccessAfterRuleChange, isUserAllowedForClient, revokeUserRefreshTokensForClient } from './auth/oauth';
import { initConsentPages, listConsentPages, getConsentPage, createConsentPage, updateConsentPage, deleteConsentPage, findConsentPageOauthReferences } from './auth/consent-pages';
import { initLdap, shutdownLdap, listLdapConfigs, getLdapConfig, createLdapConfig, updateLdapConfig, deleteLdapConfig, testLdapConfig, tryLdapLogin, runLdapSync, getLastLdapSyncReport } from './auth/ldap';
import { initSmtp, getSmtpConfig, publicSmtpConfig, validateSmtpInput, saveSmtpConfig, deleteSmtpConfig, isSmtpConfigured, testSmtpConnection, sendMail, renderTestEmail, renderAdminInviteEmail, renderProxyInviteEmail, renderForce2faEmail, render2faDisabledEmail } from './core/smtp';
import { initNpmSettings, getNpmSettings, publicNpmSettings, validateNpmInput, saveNpmSettings, deleteNpmSettings, isNpmEnabled, decryptNpmPassword } from './core/npm-settings';
import { isNpmCertVolumePresent, startCertWatcher, onCertReloaded } from './certs/npm-cert-loader';
import { handleAuthorize, handleOauthLogin, handleOauthTotp, handleToken, handleUserinfo, handleOauthLogout, setOauthLoginTemplate } from './servers/oauth-handler';
import { readFileSync } from 'fs';
import QRCode from 'qrcode';
import { resolve } from 'path';

// Track server start time for health checks
const startedAt = Date.now();
let activeRequests = 0;
let isShuttingDown = false;

// Load configuration
const config = loadConfig();

// Merge env profiles with persisted profiles (JSON file takes precedence)
const persistedProfiles = loadPersistedProfiles();
config.proxyProfiles = mergeProfiles(config.proxyProfiles, persistedProfiles);



// Load persisted webhooks
config.webhooks = loadPersistedWebhooks();

// Merge TCP/UDP profiles: env vars as base, persisted (UI-created) take precedence
const persistedTcpUdpProfiles = loadPersistedTcpUdpProfiles();
const tcpUdpEnvNames = new Set(persistedTcpUdpProfiles.map(p => p.name));
config.tcpUdpProfiles = [
    ...config.tcpUdpProfiles.filter(p => !tcpUdpEnvNames.has(p.name)),
    ...persistedTcpUdpProfiles,
];

// Initialize OpenTelemetry
initTelemetry(config.otel);

// Initialize request logging (SQLite)
initRequestLog(config.requestLog);

// Initialize SIP message logging (separate SQLite db, shares dataDir/retention)
initSipLog(config.requestLog);

// Initialize raw TCP/TLS connection logging (separate SQLite db)
initConnLog(config.requestLog);

// Initialize central certificate store (SQLite-backed). Must come BEFORE any
// TCP/UDP server starts so the migration step can populate it from legacy
// in-profile fields before listeners try to read certs.
initCertStore(config.requestLog.dataDir);

// One-time migration: move legacy tlsCert/acmeDomain on each profile into the
// central store and set profile.certId. Idempotent — re-running is a no-op for
// already-migrated profiles.
{
    const migrationReport = migrateProfileCerts(config.tcpUdpProfiles);
    if (migrationReport.migrated > 0) {
        persistTcpUdpProfiles(config.tcpUdpProfiles);
        console.log(`🔐 Cert migration: ${migrationReport.migrated} profile(s) migrated, ${migrationReport.skipped} skipped`);
    }
    for (const err of migrationReport.errors) console.warn(`⚠️  Cert migration: ${err}`);
}

// ACME renewal scheduler is started AFTER the main Bun.serve below so that
// the HTTP-01 challenge endpoint (/.well-known/acme-challenge/*) is already
// listening when LE tries to validate. Without this, first-time issuance
// deadlocks: ACME waits on a challenge the HTTP server hasn't started yet.
function startAcmeSchedulers(): void {
    for (const cert of listCerts()) {
        if (cert.source !== 'acme') continue;
        scheduleAcmeRenewal(cert).catch(err =>
            console.error(`[acme] Failed to schedule renewal for #${cert.id}:`, err instanceof Error ? err.message : err)
        );
    }
}

// Initialize auth
initAuth(config.requestLog.dataDir, config.auth.sessionMaxAge);

// Initialize JWT (RS256) for proxy user auth + Supabase third-party auth
initJwt(config.requestLog.dataDir, process.env.JWT_ISSUER || '', config.auth.sessionMaxAge);

// Initialize LDAP directories (depends on initJwt for bind-password encryption key)
initLdap(config.requestLog.dataDir);

// Initialize SMTP (depends on initJwt for password encryption key)
initSmtp(config.requestLog.dataDir);

// Initialize NPM integration settings (optional — depends on initJwt for password encryption)
initNpmSettings(config.requestLog.dataDir);

// Start watching shared Let's Encrypt volume if NPM mounted it
if (isNpmCertVolumePresent()) {
    startCertWatcher();
    onCertReloaded(domain => console.log(`[npm-cert-loader] cert for "${domain}" reloaded from shared volume`));
    console.log(`[npm-cert-loader] watching ${process.env.NPM_LETSENCRYPT_DIR}/live for cert renewals`);
}

function getInviteResourceNames(profileNames: string[], oauthClientIds: string[]): string[] {
    const proxyNames = profileNames
        .map(profileName => {
            const profile = config.proxyProfiles.find(p => p.name === profileName);
            return (profile?.loginTitle || profile?.name || profileName).trim();
        })
        .filter(Boolean);
    const oauthNames = oauthClientIds
        .map(clientId => {
            const client = getOauthClient(clientId);
            return (client?.name || clientId).trim();
        })
        .filter(Boolean);
    return Array.from(new Set([...proxyNames, ...oauthNames]));
}

// Initialize consent_pages before OAuth (oauth_clients.consent_page_id references it).
initConsentPages();
// Initialize OAuth2/OIDC storage + load login template
initOauth();
try {
    setOauthLoginTemplate(readFileSync(resolve(import.meta.dir, 'views/oauth-login.html'), 'utf-8'));
} catch { console.warn('⚠️  oauth-login.html not found in src/views/'); }

// Load port assignments from disk
loadPortAssignments();

// Load templates & assets
const errorTemplate = readFileSync(resolve(import.meta.dir, 'views/error.html'), 'utf-8');
const landingPage = readFileSync(resolve(import.meta.dir, 'views/landing.html'), 'utf-8');
const proxyLoginTemplate = readFileSync(resolve(import.meta.dir, 'views/proxy-login.html'), 'utf-8');
setProxyLoginTemplate(proxyLoginTemplate);
let logoSvg: Uint8Array | null = null;
try {
    logoSvg = new Uint8Array(readFileSync(resolve(import.meta.dir, 'views/logo.png')));
} catch (err) {
    console.warn('⚠️  Logo not found in src/views/logo.png');
}
setProxyLogo(logoSvg);

function renderErrorPage(statusCode: number, title: string, message: string): Response {
    const html = errorTemplate
        .replace(/\{\{STATUS\}\}/g, `${statusCode} — ${title}`)
        .replace(/\{\{STATUS_CODE\}\}/g, String(statusCode))
        .replace(/\{\{STATUS_CLASS\}\}/g, `c${statusCode}`)
        .replace(/\{\{TITLE\}\}/g, title)
        .replace(/\{\{MESSAGE\}\}/g, message);
    return new Response(html, {
        status: statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
    });
}

console.log(`🚀 Midleman starting...`);
if (config.proxyProfiles.length > 0) {
    console.log(`🔓 Proxy Profiles: ${config.proxyProfiles.map(p => p.name).join(', ')}`);
}

if (config.webhooks.length > 0) {
    console.log(`📡 Webhooks: ${config.webhooks.map(w => w.name).join(', ')}`);
}

const SECURITY_HEADERS: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

/** Shorthand for JSON responses */
function jsonRes(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS },
    });
}

/**
 * Validates admin auth: session cookie OR X-Forward-Token.
 */
function checkAdminAuth(req: Request, url: URL): Response | null {
    // 1. Check session cookie (dashboard users)
    const cookies = parseCookies(req);
    const sessionId = cookies[config.auth.cookieName];
    if (sessionId) {
        const session = validateSession(sessionId);
        if (session) return null;
    }

    // 2. Fall back to X-Forward-Token (API clients, backwards compat)
    if (config.authToken) {
        const token = req.headers.get('X-Forward-Token') || url.searchParams.get('token');
        if (token === config.authToken) return null;
    }

    // 3. If no users exist yet, allow access (setup mode)
    if (!hasUsers()) return null;

    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    });
}

/** Returns the currently authenticated admin (or null) — used for audit attribution. */
function getAuthedAdmin(req: Request): import('./core/types').AuthUser | null {
    const cookies = parseCookies(req);
    const sessionId = cookies[config.auth.cookieName];
    if (!sessionId) return null;
    const session = validateSession(sessionId);
    return session?.user || null;
}

/** Returns IP from common headers. */
function reqClientIp(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip') || 'unknown';
}

// ─── Async startup: assign ports, then start per-profile and per-target servers ─

// Build listener keys: "profileName:transport" for each listener across all profiles
const tcpUdpListenerKeys = config.tcpUdpProfiles.flatMap(p =>
    p.listeners.map(l => `${p.name}:${l.transport}`)
);

const portAssignments = await assignAllPorts(
    config.proxyProfiles.map(p => p.name),
    config.webhooks.map(w => w.name),
    tcpUdpListenerKeys,
    config.port,
);

for (const profile of config.proxyProfiles) {
    const port = portAssignments.proxies[profile.name];
    try {
        startProxyServer(profile, port);
    } catch (err) {
        console.error(`❌ Failed to start proxy "${profile.name}":`, err instanceof Error ? err.message : err);
    }
}



for (const webhook of config.webhooks) {
    const assignedPort = portAssignments.webhooks[webhook.name];
    const w = { ...webhook, port: assignedPort };
    try {
        startWebhookServer(w);
    } catch (err) {
        console.error(`❌ Failed to start webhook "${webhook.name}":`, err instanceof Error ? err.message : err);
    }
}

// Resume any persistent-retry entries left over from the previous run.
startPendingRetryScheduler();
startSilenceAlertScheduler();

// TCP/UDP proxies are started AFTER the main HTTP server below — they may run
// ACME HTTP-01 which needs the main server to be already listening on :80.
// Also fire-and-forget so a slow/failing profile cannot block the rest.
if (config.tcpUdpProfiles.length > 0) {
    console.log(`🔌 TCP/UDP Proxies: ${config.tcpUdpProfiles.map(p => p.name).join(', ')}`);
    for (const tcpUdpProfile of config.tcpUdpProfiles) {
        for (const listener of tcpUdpProfile.listeners) {
            listener.port = portAssignments.tcpUdp[`${tcpUdpProfile.name}:${listener.transport}`] ?? listener.port;
        }
    }
}

function startAllTcpUdpProxies(): void {
    for (const tcpUdpProfile of config.tcpUdpProfiles) {
        startSipServer(tcpUdpProfile).catch(err =>
            console.error(`❌ Failed to start TCP/UDP proxy "${tcpUdpProfile.name}":`, err instanceof Error ? err.message : err)
        );
    }
}

// ─── OIDC discovery server (public, dedicated port) ─────────────────────────
// Exposes ONLY /.well-known/jwks.json and /.well-known/openid-configuration so
// you can publish this single port via Nginx/DNS while keeping the rest of
// Midleman private. Configured via JWKS_PORT env (skip if unset).

const jwksPortRaw = process.env.JWKS_PORT;
const jwksServer = jwksPortRaw ? Bun.serve({
    port: parseInt(jwksPortRaw, 10),
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname;

        // ── OIDC discovery (public, cacheable) ──
        if (path === '/.well-known/jwks.json') {
            return new Response(JSON.stringify(getJwks()), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=600',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }
        if (path === '/.well-known/openid-configuration') {
            return new Response(JSON.stringify(getOidcDiscovery()), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=600',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        // ── OAuth2 / OIDC endpoints ──
        if (path === '/oauth/authorize' && req.method === 'GET') return handleAuthorize(req, url);
        if (path === '/oauth/login' && req.method === 'POST') return handleOauthLogin(req);
        if (path === '/oauth/totp' && req.method === 'POST') return handleOauthTotp(req);
        if (path === '/oauth/token' && req.method === 'POST') return handleToken(req);
        if (path === '/oauth/userinfo') return handleUserinfo(req);
        if (path === '/oauth/logout') return handleOauthLogout(req, url);

        return new Response('Not Found', { status: 404 });
    },
}) : null;

if (jwksServer) {
    console.log(`🔓 OIDC discovery server: http://localhost:${jwksServer.port}/.well-known/jwks.json`);
} else {
    console.log('ℹ️  JWKS_PORT not set — OIDC discovery server disabled (Supabase third-party auth requires it).');
}

// ─── Main HTTP server ───────────────────────────────────────────────────────

const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
    maxRequestBodySize: 50 * 1024 * 1024, // 50MB

    async fetch(req: Request): Promise<Response> {
        // ── ACME HTTP-01 challenge — must respond before any auth or shutdown check ──
        const url0 = new URL(req.url);
        if (url0.pathname.startsWith('/.well-known/acme-challenge/')) {
            const token = url0.pathname.slice('/.well-known/acme-challenge/'.length);
            const keyAuth = challengeStore.get(token);
            if (keyAuth) {
                return new Response(keyAuth, {
                    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
                });
            }
            return new Response('Not Found', { status: 404 });
        }

        if (isShuttingDown) {
            return jsonRes(503, { error: 'Service Unavailable', message: 'Server is shutting down' });
        }

        activeRequests++;
        const startTime = performance.now();
        const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();

        try {
            const url = new URL(req.url);

            // Serve logo/favicon requests
            if (url.pathname === '/logo.png' || url.pathname === '/favicon.ico' || url.pathname === '/favicon.png') {
                if (logoSvg) {
                    return new Response(logoSvg, {
                        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' }
                    });
                }
                return new Response(null, { status: 204 });
            }

            // Landing page
            if (url.pathname === '/' && !req.headers.get('X-Forward-Token') && !url.searchParams.get('token')) {
                const accept = req.headers.get('Accept') || '';
                if (accept.includes('text/html') || accept === '*/*' || accept === '') {
                    return new Response(landingPage, {
                        status: 200,
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    });
                }
            }

            // ===== Auth Routes =====
            if (url.pathname === '/auth/status') {
                const cookies = parseCookies(req);
                const sessionId = cookies[config.auth.cookieName];
                const session = sessionId ? validateSession(sessionId) : null;
                const body = JSON.stringify({ needsSetup: !hasUsers(), loggedIn: !!session, username: session?.user?.username || null });
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                // Stale cookie: exists but session is gone — clear it so login works cleanly
                if (sessionId && !session) {
                    headers['Set-Cookie'] = clearSessionCookie(config.auth.cookieName);
                }
                return new Response(body, { status: 200, headers });
            }

            if (url.pathname === '/auth/setup' && req.method === 'POST') {
                if (hasUsers()) return jsonRes(403, { error: 'Setup already completed' });
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const username = (body.username || '').trim();
                if (!username || username.length < 2) return jsonRes(400, { error: 'Username must be at least 2 characters' });
                const totp = generateTotpSecret(username);
                const qrDataUrl = await QRCode.toDataURL(totp.otpauthUrl, { width: 200, margin: 1 });
                return jsonRes(200, { secret: totp.secret, otpauthUrl: totp.otpauthUrl, qrDataUrl });
            }

            if (url.pathname === '/auth/register' && req.method === 'POST') {
                if (hasUsers()) return jsonRes(403, { error: 'Setup already completed' });
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const username = (body.username || '').trim();
                const password = body.password || '';
                const totpSecret = body.totpSecret || '';
                const totpCode = (body.totpCode || '').trim();
                if (!username || username.length < 2) return jsonRes(400, { error: 'Username must be at least 2 characters' });
                if (!password || password.length < 6) return jsonRes(400, { error: 'Password must be at least 6 characters' });
                if (!totpSecret || !totpCode) return jsonRes(400, { error: 'TOTP verification required' });
                if (!verifyTotp(totpSecret, totpCode)) return jsonRes(400, { error: 'Invalid TOTP code. Scan the QR code and enter the 6-digit code.' });
                try {
                    const user = await createUser(username, password, totpSecret);
                    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
                    const sid = createSession(user.id, clientIp, req.headers.get('user-agent') || '');
                    return new Response(JSON.stringify({ status: 'ok', username: user.username }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Set-Cookie': sessionCookie(sid, config.auth.cookieName, config.auth.sessionMaxAge),
                        },
                    });
                } catch (err: any) {
                    if (err.message?.includes('UNIQUE')) return jsonRes(409, { error: 'Username already exists' });
                    return jsonRes(500, { error: err.message || 'Failed to create user' });
                }
            }

            // Step 1: verify username + password, return challenge token
            if (url.pathname === '/auth/login/verify' && req.method === 'POST') {
                const clientIp = reqClientIp(req);
                if (!checkRateLimit(clientIp)) return jsonRes(429, { error: 'Too many attempts. Try again in 15 minutes.' });
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const username = (body.username || '').trim();
                const password = body.password || '';
                if (!username || !password) return jsonRes(400, { error: 'Username and password required' });
                // 1) Local-first: try the local user table (also rejects shadow LDAP rows).
                let cred = await verifyCredentials(username, password);

                // 2) Fallback to LDAP if no local match. We deliberately collapse
                //    ALL failure modes (bad credentials, missing admin group, username
                //    collision, LDAP server error) to the same generic 401 response
                //    so that the caller cannot tell the difference. Details — incl.
                //    the directory, dn, matched group, and any error reason — go to
                //    the audit log only.
                if (!cred) {
                    const ldap = await tryLdapLogin('admin', username, password);
                    if (ldap.ok) {
                        if (ldap.role !== 'admin') {
                            logAudit({
                                action: 'admin.login.failed',
                                actorUsername: username,
                                details: {
                                    reason: 'ldap_no_admin_group',
                                    dn: ldap.auth.dn,
                                    directory: ldap.auth.configName,
                                    userGroups: ldap.auth.groups,
                                },
                                ip: clientIp, userAgent: req.headers.get('user-agent'),
                            });
                            // Do NOT confirm to the caller that the password was correct.
                        } else {
                            const shadow = upsertLdapShadowAdmin({
                                ldapConfigId: ldap.auth.configId,
                                ldapDn: ldap.auth.dn,
                                username: ldap.auth.username,
                                fullName: ldap.auth.fullName,
                                email: ldap.auth.email,
                            });
                            if (!shadow) {
                                logAudit({ action: 'admin.login.failed', actorUsername: username, details: { reason: 'ldap_username_collision', dn: ldap.auth.dn }, ip: clientIp, userAgent: req.headers.get('user-agent') });
                                // Same 401 below — admins resolve collision via audit + manual cleanup.
                            } else {
                                logAudit({ action: 'ldap.login.success', actorUserId: shadow.id, actorUsername: shadow.username, details: { directory: ldap.auth.configName, role: 'admin', dn: ldap.auth.dn, matchedGroup: ldap.matchedAdminGroup }, ip: clientIp, userAgent: req.headers.get('user-agent') });
                                // Pull the stored TOTP secret so subsequent logins skip the setup flow.
                                cred = { user: shadow, totpSecret: getAdminTotpSecret(shadow.id) };
                            }
                        }
                    } else if (ldap.reason === 'server_error') {
                        logAudit({ action: 'admin.login.failed', actorUsername: username, details: { reason: 'ldap_server_error', detail: ldap.detail }, ip: clientIp, userAgent: req.headers.get('user-agent') });
                        // Same 401 below — error detail stays in audit only.
                    }
                    // invalid_credentials | no_directory → fall through to generic failure below
                }

                if (!cred) {
                    logAudit({ action: 'admin.login.failed', actorUsername: username, ip: clientIp, userAgent: req.headers.get('user-agent') });
                    return jsonRes(401, { error: 'Invalid username or password' });
                }
                // First-time login for an admin without TOTP set up yet → enrol TOTP now.
                // Admins via LDAP always go through this path on their first login (totpEnabled=false).
                if (!cred.user.totpEnabled || !cred.totpSecret) {
                    const totp = generateTotpSecret(cred.user.username);
                    const qrDataUrl = await QRCode.toDataURL(totp.otpauthUrl, { width: 220, margin: 2 }).catch(() => null);
                    const challengeToken = createLoginChallenge(cred.user.id, cred.user.username, totp.secret, true);
                    return jsonRes(200, { status: 'totp_setup', challengeToken, totpSecret: totp.secret, qrDataUrl });
                }
                const challengeToken = createLoginChallenge(cred.user.id, cred.user.username, cred.totpSecret, false);
                return jsonRes(200, { status: 'ok', challengeToken });
            }

            // Step 2: verify TOTP with challenge token, create session
            if (url.pathname === '/auth/login' && req.method === 'POST') {
                const clientIp = reqClientIp(req);
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const challengeToken = (body.challengeToken || '').trim();
                const totpCode = (body.totpCode || '').trim();
                if (!challengeToken || !totpCode) return jsonRes(400, { error: 'Challenge token and TOTP code required' });
                const challenge = consumeLoginChallenge(challengeToken);
                if (!challenge) return jsonRes(401, { error: 'Session expired. Please start login again.' });
                if (!verifyTotp(challenge.totpSecret, totpCode)) {
                    logAudit({ action: 'admin.login.failed', actorUserId: challenge.userId, actorUsername: challenge.username, details: { reason: 'bad_totp' }, ip: clientIp, userAgent: req.headers.get('user-agent') });
                    return jsonRes(401, { error: 'Invalid authenticator code' });
                }
                // First-login flow: persist the freshly-set TOTP secret
                if (challenge.needsSetup) {
                    setAdminTotp(challenge.userId, challenge.totpSecret);
                }
                const sid = createSession(challenge.userId, clientIp, req.headers.get('user-agent') || '');
                logAudit({ action: 'admin.login', actorUserId: challenge.userId, actorUsername: challenge.username, details: challenge.needsSetup ? { firstLogin: true } : undefined, ip: clientIp, userAgent: req.headers.get('user-agent') });
                return new Response(JSON.stringify({ status: 'ok', username: challenge.username }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Set-Cookie': sessionCookie(sid, config.auth.cookieName, config.auth.sessionMaxAge),
                    },
                });
            }

            if (url.pathname === '/auth/logout' && req.method === 'POST') {
                const me = getAuthedAdmin(req);
                const cookies = parseCookies(req);
                const sessionId = cookies[config.auth.cookieName];
                if (sessionId) destroySession(sessionId);
                if (me) logAudit({ action: 'admin.logout', actorUserId: me.id, actorUsername: me.username, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                return new Response(JSON.stringify({ status: 'ok' }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Set-Cookie': clearSessionCookie(config.auth.cookieName),
                    },
                });
            }

            // Health check
            if (url.pathname === '/health') {
                const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
                const healthData = {
                    status: 'ok',
                    uptime: uptimeSec,
                    activeRequests,
                    proxies: config.proxyProfiles.length,
                    webhooks: config.webhooks.length,
                };

                const accept = req.headers.get('accept') || '';
                if (!accept.includes('text/html')) {
                    return jsonRes(200, healthData);
                }

                function fmtUptime(s: number): string {
                    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
                          m = Math.floor((s % 3600) / 60), sec = s % 60;
                    if (d > 0) return `${d}d ${h}h ${m}m`;
                    if (h > 0) return `${h}h ${m}m ${sec}s`;
                    if (m > 0) return `${m}m ${sec}s`;
                    return `${sec}s`;
                }

                const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Midleman — Health</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #111;
      color: #ccc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 24px;
    }
    .wrap { max-width: 400px; width: 100%; }
    .wordmark {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: #444;
      margin-bottom: 32px;
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #3a3;
      flex-shrink: 0;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      color: #eee;
      letter-spacing: -.01em;
    }
    .sub {
      font-size: 13px;
      color: #555;
      margin-bottom: 36px;
      padding-left: 18px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 1px;
      background: #1e1e1e;
      border: 1px solid #1e1e1e;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 20px;
    }
    .cell {
      background: #161616;
      padding: 18px 16px;
      text-align: center;
    }
    .cell-val {
      font-size: 22px;
      font-weight: 600;
      color: #ddd;
      font-variant-numeric: tabular-nums;
      letter-spacing: -.02em;
    }
    .cell-label {
      font-size: 11px;
      color: #444;
      margin-top: 4px;
      font-weight: 500;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #333;
      padding-top: 16px;
      border-top: 1px solid #1a1a1a;
    }
    .meta span { font-family: 'SF Mono', ui-monospace, monospace; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="wordmark">Midleman</div>
    <div class="status-row">
      <span class="dot"></span>
      <h1>Operational</h1>
    </div>
    <p class="sub">All systems running</p>
    <div class="grid">
      <div class="cell">
        <div class="cell-val">${healthData.proxies}</div>
        <div class="cell-label">Proxies</div>
      </div>
      <div class="cell">
        <div class="cell-val">${healthData.webhooks}</div>
        <div class="cell-label">Webhooks</div>
      </div>
    </div>
    <div class="meta">
      <span>uptime ${fmtUptime(uptimeSec)}</span>
      <span>${healthData.activeRequests} active</span>
    </div>
  </div>
</body>
</html>`;

                return new Response(html, {
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
            }

            // Dashboard & Static Assets
            if (url.pathname.startsWith('/dashboard/css/')) {
                const file = url.pathname.replace('/dashboard/css/', '');
                try {
                    const css = readFileSync(resolve(import.meta.dir, `views/css/${file}`), 'utf-8');
                    return new Response(css, { status: 200, headers: { 'Content-Type': 'text/css; charset=utf-8' } });
                } catch {
                    return new Response('Not found', { status: 404 });
                }
            }

            if (url.pathname.startsWith('/dashboard/js/')) {
                const file = url.pathname.replace('/dashboard/js/', '');
                try {
                    const js = readFileSync(resolve(import.meta.dir, `views/js/${file}`), 'utf-8');
                    return new Response(js, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
                } catch {
                    return new Response('Not found', { status: 404 });
                }
            }

            if (url.pathname === '/dashboard' || url.pathname === '/dashboard/') {
                const htmlPath = resolve(import.meta.dir, 'views/dashboard.html');
                let html = readFileSync(htmlPath, 'utf-8');
                
                try {
                    const setupHtml = readFileSync(resolve(import.meta.dir, 'views/partials/_setup.html'), 'utf-8');
                    const loginHtml = readFileSync(resolve(import.meta.dir, 'views/partials/_login.html'), 'utf-8');
                    const appHtml = readFileSync(resolve(import.meta.dir, 'views/partials/_app.html'), 'utf-8');
                    html = html.replace('<!-- INJECT_SETUP -->', setupHtml)
                               .replace('<!-- INJECT_LOGIN -->', loginHtml)
                               .replace('<!-- INJECT_APP -->', appHtml);
                } catch (err) {
                    console.error('Failed to load dashboard partials:', err);
                }

                return new Response(html, {
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
            }

            // ===== Public Admin Invite Pages =====
            if (url.pathname.match(/^\/admin-invite\/[^/]+$/) && req.method === 'GET') {
                const token = url.pathname.split('/')[2];
                const invite = getAdminInvite(token);
                const escH = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                const pageHtml = readFileSync(resolve(import.meta.dir, 'views/admin-invite.html'), 'utf-8');
                if (!invite || invite.usedAt || new Date(invite.expiresAt) < new Date()) {
                    const msg = !invite ? 'Link de convite não encontrado.' : invite.usedAt ? 'Este convite já foi utilizado.' : 'Este convite expirou.';
                    return new Response(
                        pageHtml.replace(/\{\{TOKEN\}\}/g, '').replace(/\{\{FULL_NAME\}\}/g, '').replace(/\{\{EMAIL\}\}/g, '').replace(/\{\{NOTE\}\}/g, '').replace(/\{\{INVALID_MSG\}\}/g, escH(msg)).replace(/\{\{INVALID_DISPLAY\}\}/g, 'block').replace(/\{\{FORM_DISPLAY\}\}/g, 'none'),
                        { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                    );
                }
                return new Response(
                    pageHtml.replace(/\{\{TOKEN\}\}/g, escH(token)).replace(/\{\{FULL_NAME\}\}/g, escH(invite.fullName)).replace(/\{\{EMAIL\}\}/g, escH(invite.email)).replace(/\{\{NOTE\}\}/g, escH(invite.note)).replace(/\{\{INVALID_MSG\}\}/g, '').replace(/\{\{INVALID_DISPLAY\}\}/g, 'none').replace(/\{\{FORM_DISPLAY\}\}/g, 'block'),
                    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                );
            }

            if (url.pathname.match(/^\/admin-invite\/[^/]+\/register$/) && req.method === 'POST') {
                const token = url.pathname.split('/')[2];
                const invite = getAdminInvite(token);
                if (!invite || invite.usedAt || new Date(invite.expiresAt) < new Date()) {
                    return jsonRes(410, { error: 'Convite inválido, expirado ou já utilizado.' });
                }
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const username = (body.username || '').trim().toLowerCase().replace(/[^a-z0-9._\-]/g, '');
                const password = body.password || '';
                if (!username || username.length < 2) return jsonRes(400, { error: 'Username deve ter pelo menos 2 caracteres.' });
                if (!password || password.length < 8) return jsonRes(400, { error: 'A password deve ter pelo menos 8 caracteres.' });
                try {
                    const admin = await createAdditionalAdmin(username, password, invite.fullName, invite.email, 0);
                    consumeAdminInvite(token, admin.id);
                    logAudit({ actorUsername: username, action: 'admin.create.via_invite', targetType: 'admin', targetId: admin.id, details: { email: invite.email }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'created', username: admin.username });
                } catch (err: any) {
                    const msg = err?.message || String(err);
                    if (msg.includes('UNIQUE') || msg.includes('unique')) return jsonRes(409, { error: 'Já existe uma conta com este username.' });
                    return jsonRes(500, { error: msg });
                }
            }

            // ===== Public Invite Pages =====
            if (url.pathname.match(/^\/invite\/[^/]+$/) && req.method === 'GET') {
                const token = url.pathname.split('/')[2];
                const invite = getInviteToken(token);
                const profile = invite ? config.proxyProfiles.find(p => p.name === invite.profileName) : null;
                const loginTitle = profile?.loginTitle || profile?.name || 'Acesso';
                const SAFE_LOGO_RE = /^(https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)[A-Za-z0-9+/=.\-_~:@!$&'()*+,;%?#[\]]+$/;
                const loginLogoUrl = (profile?.loginLogo && SAFE_LOGO_RE.test(profile.loginLogo)) ? profile.loginLogo
                    : (profile?.targetUrl ? (() => { try { return new URL(profile.targetUrl).origin + '/favicon.ico'; } catch { return '/logo.png'; } })() : '/logo.png');

                const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

                if (!invite || invite.usedAt || new Date(invite.expiresAt) < new Date()) {
                    const msg = !invite ? 'Link de acesso não encontrado.' : invite.usedAt ? 'Este link de acesso já foi utilizado.' : 'Este link de acesso expirou.';
                    const errHtml = readFileSync(resolve(import.meta.dir, 'views/invite.html'), 'utf-8')
                        .replace(/\{\{TOKEN\}\}/g, '')
                        .replace(/\{\{LOGIN_TITLE\}\}/g, esc(loginTitle))
                        .replace(/\{\{LOGIN_LOGO_URL\}\}/g, loginLogoUrl)
                        .replace(/\{\{INVITED_NAME\}\}/g, '')
                        .replace(/\{\{EMAIL\}\}/g, '')
                        .replace(/\{\{NOTE\}\}/g, '')
                        .replace(/\{\{IS_RETURNING\}\}/g, 'false')
                        .replace(/\{\{PROXY_LOGIN_URL\}\}/g, '')
                        .replace(/\{\{INVALID_MSG\}\}/g, msg)
                        .replace(/\{\{INVALID_DISPLAY\}\}/g, 'block')
                        .replace(/\{\{FORM_DISPLAY\}\}/g, 'none');
                    return new Response(errHtml, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }

                // Check if the invited email already has an account
                const existingUser = invite.email ? findProxyUserByEmailOrUsername(invite.email, '') : null;
                const isReturning = !!existingUser;

                // Build proxy login URL so the page can redirect after success
                const proxyPort = getProxyServerPort(invite.profileName);
                const reqHost = req.headers.get('host')?.split(':')[0] || 'localhost';
                const proxyLoginUrl = proxyPort ? `http://${reqHost}:${proxyPort}/auth/login` : '';

                const inviteHtml = readFileSync(resolve(import.meta.dir, 'views/invite.html'), 'utf-8')
                    .replace(/\{\{TOKEN\}\}/g, token)
                    .replace(/\{\{LOGIN_TITLE\}\}/g, esc(loginTitle))
                    .replace(/\{\{LOGIN_LOGO_URL\}\}/g, loginLogoUrl)
                    .replace(/\{\{INVITED_NAME\}\}/g, esc(invite.invitedName || existingUser?.fullName || ''))
                    .replace(/\{\{EMAIL\}\}/g, esc(invite.email))
                    .replace(/\{\{NOTE\}\}/g, esc(invite.note))
                    .replace(/\{\{IS_RETURNING\}\}/g, isReturning ? 'true' : 'false')
                    .replace(/\{\{PROXY_LOGIN_URL\}\}/g, proxyLoginUrl)
                    .replace(/\{\{INVALID_MSG\}\}/g, '')
                    .replace(/\{\{INVALID_DISPLAY\}\}/g, 'none')
                    .replace(/\{\{FORM_DISPLAY\}\}/g, 'block');
                return new Response(inviteHtml, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            }

            if (url.pathname.match(/^\/invite\/[^/]+\/register$/) && req.method === 'POST') {
                const token = url.pathname.split('/')[2];
                const invite = getInviteToken(token);
                if (!invite || invite.usedAt || new Date(invite.expiresAt) < new Date()) {
                    return jsonRes(410, { error: 'Link de acesso inválido, expirado ou já utilizado.' });
                }

                // Email and identity come from the invite — not from user input
                const email = invite.email;
                const fullName = invite.invitedName || '';
                // Derive username from email (part before @, cleaned up)
                const derivedUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._\-]/g, '');

                // Check if user already exists
                const existing = findProxyUserByEmailOrUsername(email, '');
                if (existing) {
                    for (const pn of invite.profileNames) assignProxyUserToProfile(existing.id, pn);
                    for (const cid of invite.oauthClientIds) addUserToOauthClient(cid, existing.id);
                    useInviteToken(token, existing.username);
                    console.log(`✅ Existing user "${existing.username}" linked to ${invite.profileNames.length} proxy(ies) + ${invite.oauthClientIds.length} OAuth client(s) via invite`);
                    return jsonRes(200, { status: 'linked', username: existing.username, profileName: invite.profileName });
                }

                // New user — only password comes from the form
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const password = body.password || '';
                if (!password || password.length < 6) return jsonRes(400, { error: 'A palavra-passe deve ter pelo menos 6 caracteres.' });

                try {
                    const user = await createProxyUser(derivedUsername, password, fullName, email);
                    for (const pn of invite.profileNames) assignProxyUserToProfile(user.id, pn);
                    for (const cid of invite.oauthClientIds) addUserToOauthClient(cid, user.id);
                    // Invited users must configure 2FA on their first login.
                    setProxyUserForce2faSetup(user.id, true);
                    useInviteToken(token, user.username);
                    console.log(`✅ Proxy user "${user.username}" created via invite (${invite.profileNames.length} proxy(ies) + ${invite.oauthClientIds.length} OAuth client(s))`);
                    return jsonRes(200, { status: 'created', username: user.username, profileName: invite.profileName });
                } catch (err: any) {
                    if (err.message?.includes('UNIQUE')) return jsonRes(409, { error: 'Já existe uma conta com este email. Recarregue a página.' });
                    return jsonRes(500, { error: err.message || 'Erro ao criar conta.' });
                }
            }

            // ===== Admin API =====
            const isAdminPath = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
            if (isAdminPath) {
                const authError = checkAdminAuth(req, url);
                if (authError) return authError;

                // GET /admin — API Discovery & Status
                if ((url.pathname === '/admin' || url.pathname === '/admin/') && req.method === 'GET') {
                    return jsonRes(200, {
                        status: 'Bun-Forwarder Admin API',
                        version: '2.0.0',
                        endpoints: {
                            'GET /dashboard': 'Web dashboard',
                            'GET /admin/config': 'Get current configuration',
                            'GET /admin/profiles': 'List all proxy profiles',
                            'GET /admin/profiles/:name': 'Get profile details',
                            'POST /admin/profiles': 'Create or update a profile',
                            'DELETE /admin/profiles/:name': 'Remove a profile',
                            'POST /admin/reload': 'Reload .env, targets, and profiles',
                            'GET /admin/telemetry': 'Live telemetry data',
                            'GET /admin/requests': 'List request logs',
                            'GET /admin/requests/stats': 'Request log stats',
                            'GET /admin/requests/:id': 'Full request detail',
                            'GET /health': 'Health check',
                        },
                        config: {
                            targetUrl: config.targetUrl || null,
                            forwardPath: config.forwardPath,
                            authEnabled: !!config.authToken,
                        },
                        telemetry: getTelemetryConfig(),
                        activeProfiles: config.proxyProfiles.length,
                    });
                }

                // POST /admin/reload
                if (url.pathname === '/admin/reload' && req.method === 'POST') {
                    reloadEnvFile();
                    const envProfiles = loadProxyProfiles();
                    const persisted = loadPersistedProfiles();
                    config.proxyProfiles = mergeProfiles(envProfiles, persisted);
                    invalidateProfileCache();



                    // Reload webhooks
                    config.webhooks = loadPersistedWebhooks();

                    // Reassign all ports
                    const newPorts = await assignAllPorts(
                        config.proxyProfiles.map(p => p.name),
                        config.webhooks.map(w => w.name),
                        config.tcpUdpProfiles.map(p => p.name),
                        config.port,
                    );

                    // Restart all proxy servers
                    await stopAllProxyServers();
                    for (const profile of config.proxyProfiles) {
                        const port = newPorts.proxies[profile.name];
                        try { startProxyServer(profile, port); } catch (err) {
                            console.error(`❌ Failed to restart proxy "${profile.name}":`, err instanceof Error ? err.message : err);
                        }
                    }



                    // Restart all webhook servers
                    await stopAllWebhooks();
                    for (const webhook of config.webhooks) {
                        const assignedPort = newPorts.webhooks[webhook.name];
                        const w = { ...webhook, port: assignedPort };
                        try { startWebhookServer(w); } catch (err) {
                            console.error(`❌ Failed to restart webhook "${webhook.name}":`, err instanceof Error ? err.message : err);
                        }
                    }

                    console.log(`🔄 Reloaded: profiles=[${config.proxyProfiles.map(p => p.name).join(', ')}] webhooks=[${config.webhooks.map(w => w.name).join(', ')}]`);
                    return jsonRes(200, {
                        status: 'reloaded',
                        profiles: config.proxyProfiles.map(p => p.name),
                        webhooks: config.webhooks.map(w => w.name),
                    });
                }

                // GET /admin/telemetry
                if (url.pathname === '/admin/telemetry' && req.method === 'GET') {
                    return jsonRes(200, getMetricsSnapshot() as unknown as Record<string, unknown>);
                }

                // ── Request Log endpoints ──
                if (url.pathname === '/admin/requests' && req.method === 'GET') {
                    const result = queryRequestLogs({
                        page: parseInt(url.searchParams.get('page') || '1', 10),
                        limit: parseInt(url.searchParams.get('limit') || '50', 10),
                        type: (url.searchParams.get('type') as 'target' | 'proxy' | 'webhook') || undefined,
                        profileName: url.searchParams.get('profile') || undefined,
                        targetName: url.searchParams.get('target') || undefined,
                        method: url.searchParams.get('method') || undefined,
                        status: url.searchParams.get('status') ? parseInt(url.searchParams.get('status')!, 10) : undefined,
                        search: url.searchParams.get('search') || undefined,
                        searchBody: url.searchParams.get('searchBody') === '1',
                        from: url.searchParams.get('from') || undefined,
                        to: url.searchParams.get('to') || undefined,
                    });
                    return jsonRes(200, result as unknown as Record<string, unknown>);
                }

                if (url.pathname === '/admin/requests/stats' && req.method === 'GET') {
                    return jsonRes(200, getRequestLogStats() as unknown as Record<string, unknown>);
                }

                if (url.pathname === '/admin/requests/chart' && req.method === 'GET') {
                    return jsonRes(200, getRequestLogChart() as unknown as Record<string, unknown>);
                }

                if (url.pathname.match(/^\/admin\/requests\/\d+$/) && req.method === 'GET') {
                    const id = parseInt(url.pathname.split('/').pop()!, 10);
                    const detail = getRequestLogDetail(id);
                    if (!detail) return jsonRes(404, { error: 'Request log not found' });
                    return jsonRes(200, detail as unknown as Record<string, unknown>);
                }

                // ── SIP message log endpoints ──
                if (url.pathname === '/admin/sip-logs' && req.method === 'GET') {
                    const result = querySipLogs({
                        page: parseInt(url.searchParams.get('page') || '1', 10),
                        pageSize: parseInt(url.searchParams.get('pageSize') || '50', 10),
                        profileName: url.searchParams.get('profile') || undefined,
                        callId: url.searchParams.get('callId') || undefined,
                        method: url.searchParams.get('method') || undefined,
                        direction: (url.searchParams.get('direction') as 'in' | 'out') || undefined,
                        transport: (url.searchParams.get('transport') as 'udp' | 'tcp' | 'tls') || undefined,
                        statusCode: url.searchParams.get('status') ? parseInt(url.searchParams.get('status')!, 10) : undefined,
                        since: url.searchParams.get('since') || undefined,
                        until: url.searchParams.get('until') || undefined,
                    });
                    return jsonRes(200, result as unknown as Record<string, unknown>);
                }

                if (url.pathname === '/admin/sip-logs/stats' && req.method === 'GET') {
                    return jsonRes(200, getSipLogStats() as unknown as Record<string, unknown>);
                }

                if (url.pathname === '/admin/tcpudp-conns' && req.method === 'GET') {
                    const result = queryConnLogs({
                        page: parseInt(url.searchParams.get('page') || '1', 10),
                        pageSize: parseInt(url.searchParams.get('pageSize') || '50', 10),
                        profileName: url.searchParams.get('profile') || undefined,
                        transport: (url.searchParams.get('transport') as 'tcp' | 'tls') || undefined,
                        since: url.searchParams.get('since') || undefined,
                        until: url.searchParams.get('until') || undefined,
                    });
                    return jsonRes(200, result as unknown as Record<string, unknown>);
                }

                if (url.pathname.match(/^\/admin\/sip-logs\/\d+$/) && req.method === 'GET') {
                    const id = parseInt(url.pathname.split('/').pop()!, 10);
                    const detail = getSipLogDetail(id);
                    if (!detail) return jsonRes(404, { error: 'SIP log not found' });
                    return jsonRes(200, detail as unknown as Record<string, unknown>);
                }

                // ── Certificate store endpoints ──
                if (url.pathname === '/admin/certs' && req.method === 'GET') {
                    const rows = listCerts().map(c => ({
                        id: c.id,
                        domain: c.domain,
                        source: c.source,
                        notBefore: c.notBefore,
                        notAfter: c.notAfter,
                        status: c.status,
                        lastError: c.lastError,
                        acmeEmail: c.acmeEmail,
                        acmeStaging: c.acmeStaging,
                        hasPem: !!c.certPem,
                        usedBy: listProfilesUsingCert(c.id),
                        createdAt: c.createdAt,
                        updatedAt: c.updatedAt,
                    }));
                    return jsonRes(200, { certs: rows });
                }

                if (url.pathname === '/admin/certs' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const source = body.source as string;
                    const domain = (body.domain || '').trim().toLowerCase();
                    if (!domain) return jsonRes(400, { error: '"domain" is required' });
                    if (getCertByDomain(domain)) return jsonRes(409, { error: `Certificate for "${domain}" already exists` });

                    try {
                        if (source === 'manual') {
                            const certPem = (body.certPem || '').trim();
                            const keyPem = (body.keyPem || '').trim();
                            if (!certPem || !keyPem) return jsonRes(400, { error: 'certPem and keyPem are required for manual upload' });
                            const created = createCert({ domain, source: 'manual', certPem, keyPem, chainPem: body.chainPem || null });
                            return jsonRes(200, { cert: created });
                        }
                        if (source === 'self-signed') {
                            const { certPem, keyPem } = await generateSelfSigned(domain);
                            const created = createCert({ domain, source: 'self-signed', certPem, keyPem });
                            return jsonRes(200, { cert: created });
                        }
                        if (source === 'acme') {
                            const acmeEmail = (body.acmeEmail || '').trim();
                            if (!acmeEmail) return jsonRes(400, { error: 'acmeEmail is required for ACME source' });
                            const created = createCert({
                                domain, source: 'acme',
                                acmeEmail,
                                acmeStaging: body.acmeStaging === true,
                            });
                            // Fire-and-forget issue + schedule renewal
                            scheduleAcmeRenewal(created).catch(err =>
                                console.error(`[acme] schedule failed for #${created.id}:`, err instanceof Error ? err.message : err)
                            );
                            return jsonRes(200, { cert: created });
                        }
                        return jsonRes(400, { error: 'source must be "manual", "self-signed", or "acme"' });
                    } catch (err) {
                        return jsonRes(500, { error: err instanceof Error ? err.message : String(err) });
                    }
                }

                if (url.pathname.match(/^\/admin\/certs\/\d+$/) && req.method === 'GET') {
                    const id = parseInt(url.pathname.split('/').pop()!, 10);
                    const c = getCert(id);
                    if (!c) return jsonRes(404, { error: 'Certificate not found' });
                    return jsonRes(200, { cert: c, usedBy: listProfilesUsingCert(c.id) });
                }

                if (url.pathname.match(/^\/admin\/certs\/\d+$/) && req.method === 'PUT') {
                    // Replace cert PEM (manual cert update)
                    const id = parseInt(url.pathname.split('/').pop()!, 10);
                    const c = getCert(id);
                    if (!c) return jsonRes(404, { error: 'Certificate not found' });
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const certPem = (body.certPem || '').trim();
                    const keyPem = (body.keyPem || '').trim();
                    if (!certPem || !keyPem) return jsonRes(400, { error: 'certPem and keyPem are required' });
                    const updated = updateCertPem(id, certPem, keyPem, body.chainPem || null);
                    return jsonRes(200, { cert: updated });
                }

                if (url.pathname.match(/^\/admin\/certs\/\d+\/renew$/) && req.method === 'POST') {
                    // Force ACME renewal now
                    const id = parseInt(url.pathname.split('/')[3], 10);
                    const c = getCert(id);
                    if (!c) return jsonRes(404, { error: 'Certificate not found' });
                    if (c.source !== 'acme') return jsonRes(400, { error: 'Only ACME certificates can be renewed via this endpoint' });
                    try {
                        await requestCertificate(c);
                        return jsonRes(200, { cert: getCert(id) });
                    } catch (err) {
                        return jsonRes(500, { error: err instanceof Error ? err.message : String(err) });
                    }
                }

                if (url.pathname.match(/^\/admin\/certs\/\d+$/) && req.method === 'DELETE') {
                    const id = parseInt(url.pathname.split('/').pop()!, 10);
                    const result = deleteCert(id);
                    if (!result.deleted) return jsonRes(409, { error: `Certificate in use by: ${result.usedBy.join(', ')}` });
                    return jsonRes(200, { status: 'deleted' });
                }



                // ── Webhook CRUD ──
                if (url.pathname === '/admin/webhooks' && req.method === 'GET') {
                    const status = getWebhookStatus();
                    const webhooks = config.webhooks.map(w => {
                        const s = status.find(s => s.name === w.name);
                        return {
                            name: w.name,
                            targets: w.targets,
                            port: s?.port ?? w.port,
                            hasAuth: !!w.authToken,
                            retry: w.retry,
                            allowedIps: w.allowedIps || [],
                            running: s?.running ?? false,
                            active: s?.active ?? 0,
                        };
                    });
                    return jsonRes(200, { webhooks });
                }

                if (url.pathname.match(/^\/admin\/webhooks\/[^/]+\/restart$/) && req.method === 'POST') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    const webhook = config.webhooks.find(w => w.name === name);
                    if (!webhook) return jsonRes(404, { error: `Webhook "${name}" not found` });
                    try {
                        const portToUse = getWebhookPort(name) || webhook.port;
                        await restartWebhook({ ...webhook, port: portToUse });
                        return jsonRes(200, { status: 'restarted', webhook: name });
                    } catch (err) {
                        return jsonRes(500, { error: `Failed to restart: ${err instanceof Error ? err.message : err}` });
                    }
                }

                // ── Dead Letter Queue ──
                if (url.pathname === '/admin/webhooks/dlq' && req.method === 'GET') {
                    const nameFilter = url.searchParams.get('webhook') || undefined;
                    const queue = getDeadLetterQueue();
                    const filtered = nameFilter ? queue.filter(e => e.webhookName === nameFilter) : queue;
                    const safeEntries = filtered.map(e => ({
                        id: e.id,
                        webhookName: e.webhookName,
                        requestId: e.requestId,
                        targetUrl: e.targetUrl,
                        method: e.method,
                        bodyPreview: e.bodyPreview,
                        bodySize: e.bodySize,
                        path: e.path,
                        clientIp: e.clientIp,
                        lastError: e.lastError,
                        totalAttempts: e.totalAttempts,
                        failedAt: e.failedAt,
                        retrying: e.retrying,
                    }));
                    return jsonRes(200, { queue: safeEntries, total: safeEntries.length });
                }

                if (url.pathname === '/admin/webhooks/dlq/retry-all' && req.method === 'POST') {
                    let webhookName: string | undefined;
                    try { const b = await req.json() as any; webhookName = b?.webhook || undefined; } catch {}
                    const result = await retryAllFailedFanouts(webhookName);
                    return jsonRes(200, result);
                }

                if (url.pathname.match(/^\/admin\/webhooks\/dlq\/[^/]+\/retry$/) && req.method === 'POST') {
                    const id = url.pathname.split('/')[4];
                    const result = await retryFailedFanout(id);
                    return result.ok
                        ? jsonRes(200, { status: 'ok', ...result })
                        : jsonRes(502, { error: result.error, ...result });
                }

                if (url.pathname.match(/^\/admin\/webhooks\/dlq\/[^/]+$/) && req.method === 'DELETE') {
                    const id = url.pathname.split('/')[4];
                    const removed = dismissFailedFanout(id);
                    return removed ? jsonRes(200, { status: 'dismissed' }) : jsonRes(404, { error: 'Not found' });
                }

                // ── Pending Retry Queue (persistent retries) ──
                if (url.pathname === '/admin/webhooks/pending-retry' && req.method === 'GET') {
                    const nameFilter = url.searchParams.get('webhook') || undefined;
                    const requestIdFilter = url.searchParams.get('requestId') || undefined;
                    let queue = getPendingRetryQueue();
                    if (nameFilter) queue = queue.filter(e => e.webhookName === nameFilter);
                    if (requestIdFilter) queue = queue.filter(e => e.requestId === requestIdFilter);
                    const safeEntries = queue.map(e => ({
                        id: e.id,
                        webhookName: e.webhookName,
                        requestId: e.requestId,
                        targetUrl: e.targetUrl,
                        method: e.method,
                        bodyPreview: e.bodyPreview,
                        bodySize: e.bodySize,
                        path: e.path,
                        clientIp: e.clientIp,
                        lastError: e.lastError,
                        attempts: e.attempts,
                        enqueuedAt: e.enqueuedAt,
                        lastAttemptAt: e.lastAttemptAt,
                        nextAttemptAt: e.nextAttemptAt,
                        notified: e.notified,
                        running: e.running,
                        notifyEmail: e.persistentRetry.notifyEmail || '',
                        maxAttemptsPerMinute: e.persistentRetry.maxAttemptsPerMinute ?? 10,
                    }));
                    return jsonRes(200, { queue: safeEntries, total: safeEntries.length });
                }

                if (url.pathname.match(/^\/admin\/webhooks\/pending-retry\/[^/]+\/retry-now$/) && req.method === 'POST') {
                    const id = url.pathname.split('/')[4];
                    const r = await retryPendingNow(id);
                    return r.ok ? jsonRes(200, r) : jsonRes(502, r);
                }

                if (url.pathname.match(/^\/admin\/webhooks\/pending-retry\/[^/]+$/) && req.method === 'DELETE') {
                    const id = url.pathname.split('/')[4];
                    const removed = dismissPendingRetry(id);
                    return removed ? jsonRes(200, { status: 'dismissed' }) : jsonRes(404, { error: 'Not found' });
                }

                if (url.pathname.startsWith('/admin/webhooks/') && req.method === 'GET') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '');
                    if (!name) return jsonRes(400, { error: 'Webhook name required' });
                    const webhook = config.webhooks.find(w => w.name.toLowerCase() === name.toLowerCase());
                    if (!webhook) return jsonRes(404, { error: `Webhook "${name}" not found` });
                    const status = getWebhookStatus().find(s => s.name === name);
                    return jsonRes(200, {
                        webhook: {
                            name: webhook.name,
                            targets: webhook.targets,
                            port: webhook.port,
                            authToken: webhook.authToken || '',
                            retry: webhook.retry,
                            allowedIps: webhook.allowedIps || [],
                            silenceAlert: webhook.silenceAlert,
                            testPayload: webhook.testPayload,
                            running: status?.running ?? false,
                            active: status?.active ?? 0,
                        },
                    });
                }

                if (url.pathname === '/admin/webhooks' && req.method === 'POST') {
                    let body: unknown;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON body' }); }

                    const error = validateWebhookInput(body);
                    if (error) return jsonRes(400, { error });

                    const input = body as Record<string, unknown>;
                    const configuredPort = input.port ? parseInt(String(input.port), 10) : 0;
                    const webhook: import('./core/types').WebhookDistributor = {
                        name: (input.name as string).toLowerCase(),
                        targets: input.targets as string[],
                        port: configuredPort,
                    };
                    if (input.authToken) webhook.authToken = input.authToken as string;
                    if (input.retry && typeof input.retry === 'object') webhook.retry = input.retry as import('./core/types').WebhookRetryConfig;
                    if (Array.isArray(input.allowedIps) && input.allowedIps.length) webhook.allowedIps = input.allowedIps as string[];
                    if (input.silenceAlert && typeof input.silenceAlert === 'object') webhook.silenceAlert = input.silenceAlert as import('./core/types').WebhookSilenceAlert;
                    if (typeof input.testPayload === 'string' && input.testPayload.trim()) webhook.testPayload = input.testPayload;

                    // Reset any pending silence state so the next tick starts fresh.
                    resetSilenceState(webhook.name);

                    // Assign a port (auto or explicit)
                    const existingIdx = config.webhooks.findIndex(w => w.name === webhook.name);
                    // When updating, preserve the existing port if none was explicitly set
                    let portToUse = configuredPort;
                    if (existingIdx >= 0 && configuredPort === 0) {
                        const existingPort = getWebhookStatus().find(s => s.name === webhook.name)?.port || config.webhooks[existingIdx].port || 0;
                        if (existingPort > 0) portToUse = existingPort;
                    }
                    const excludePorts = getWebhookStatus().filter(s => s.name !== webhook.name).map(s => s.port).filter(Boolean);
                    const assignedPort = await assignWebhookPort(webhook.name, portToUse, config.port, excludePorts);
                    const webhookWithPort = { ...webhook, port: assignedPort };

                    // Update or add config entry (always save with assigned port)
                    if (existingIdx >= 0) {
                        config.webhooks[existingIdx] = webhookWithPort;
                    } else {
                        config.webhooks.push(webhookWithPort);
                    }

                    persistWebhooks(config.webhooks);

                    // Start/restart the server
                    try {
                        if (existingIdx >= 0) {
                            await restartWebhook(webhookWithPort);
                        } else {
                            startWebhookServer(webhookWithPort);
                        }
                    } catch (err) {
                        console.error(`⚠️  Webhook "${webhook.name}" saved but failed to start:`, err);
                    }

                    const action = existingIdx >= 0 ? 'updated' : 'created';
                    console.log(`✅ Webhook "${webhook.name}" ${action} (port ${assignedPort})`);
                    return jsonRes(200, { status: action, webhook: webhook.name, port: assignedPort });
                }

                if (url.pathname.startsWith('/admin/webhooks/') && req.method === 'DELETE') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '');
                    if (!name) return jsonRes(400, { error: 'Webhook name required' });

                    const idx = config.webhooks.findIndex(w => w.name.toLowerCase() === name.toLowerCase());
                    if (idx === -1) return jsonRes(404, { error: `Webhook "${name}" not found` });

                    config.webhooks.splice(idx, 1);
                    persistWebhooks(config.webhooks);
                    await stopWebhookServer(name);
                    releaseWebhookPort(name);

                    console.log(`🗑️  Webhook "${name}" deleted`);
                    return jsonRes(200, { status: 'deleted', webhook: name });
                }

                // ── Config ──
                if (url.pathname === '/admin/config' && req.method === 'GET') {
                    return jsonRes(200, {
                        port: config.port,
                        targetUrl: config.targetUrl || '',
                        authToken: config.authToken || '',
                        forwardPath: config.forwardPath,
                    });
                }



                // ── Profile CRUD ──
                if (url.pathname.match(/^\/admin\/profiles\/[^/]+\/restart$/) && req.method === 'POST') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    const profile = config.proxyProfiles.find(p => p.name === name);
                    if (!profile) return jsonRes(404, { error: `Profile "${name}" not found` });
                    try {
                        await restartProxyServer(name, profile);
                        console.log(`🔄 Profile "${name}" restarted`);
                        return jsonRes(200, { status: 'restarted', profile: name });
                    } catch (err) {
                        return jsonRes(500, { error: `Failed to restart: ${err instanceof Error ? err.message : err}` });
                    }
                }

                if (url.pathname.match(/^\/admin\/profiles\/[^/]+$/) && req.method === 'GET') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Profile name required' });
                    const profile = config.proxyProfiles.find(p => p.name === name);
                    if (!profile) return jsonRes(404, { error: `Profile "${name}" not found` });
                    return jsonRes(200, {
                        profile: {
                            name: profile.name,
                            targetUrl: profile.targetUrl,
                            apiKey: profile.apiKey,
                            authHeader: profile.authHeader,
                            authPrefix: profile.authPrefix || '',
                            accessKey: profile.accessKey || '',
                            authMode: profile.authMode || 'none',
                            require2fa: !!profile.require2fa,
                            isWebApp: !!profile.isWebApp,
                            disableLogs: !!profile.disableLogs,
                            forwardPath: profile.forwardPath !== false,
                            loginTitle: profile.loginTitle || '',
                            loginLogo: profile.loginLogo || '',
                            allowSelfSignedTls: !!profile.allowSelfSignedTls,
                            consentEnabled: !!profile.consentEnabled,
                            consentPageId: profile.consentPageId ?? null,
                            blockedExtensions: profile.blockedExtensions ? Array.from(profile.blockedExtensions) : [],
                            allowedIps: profile.allowedIps || [],
                            port: getProxyServerPort(profile.name),
                            running: isProxyServerRunning(profile.name),
                            publicHostnames: profile.publicHostnames || [],
                            tlsMode: profile.tlsMode || 'none',
                            http2: profile.http2 !== false,
                            hstsEnabled: !!profile.hstsEnabled,
                            sslForced: !!profile.sslForced,
                            allowWebsocketUpgrade: profile.allowWebsocketUpgrade !== false,
                            advancedConfig: profile.advancedConfig || '',
                            npmLocations: profile.npmLocations || [],
                            npmProxyHostId: profile.npmProxyHostId,
                            npmCertificateId: profile.npmCertificateId,
                            npmOriginalForwardHost: profile.npmOriginalForwardHost,
                            npmOriginalForwardPort: profile.npmOriginalForwardPort,
                            npmOriginalForwardScheme: profile.npmOriginalForwardScheme,
                        },
                    });
                }

                if (url.pathname === '/admin/profiles' && req.method === 'GET') {
                    const profiles = config.proxyProfiles.map(p => ({
                        name: p.name,
                        targetUrl: p.targetUrl,
                        authHeader: p.authHeader,
                        authPrefix: p.authPrefix,
                        hasAccessKey: !!p.accessKey,
                        authMode: p.authMode || 'none',
                        require2fa: !!p.require2fa,
                        isWebApp: !!p.isWebApp,
                        disableLogs: !!p.disableLogs,
                        blockedExtensions: p.blockedExtensions ? Array.from(p.blockedExtensions) : [],
                        allowedIps: p.allowedIps || [],
                        forwardPath: p.forwardPath !== false,
                        loginTitle: p.loginTitle || '',
                        loginLogo: p.loginLogo || '',
                        allowSelfSignedTls: !!p.allowSelfSignedTls,
                        consentEnabled: !!p.consentEnabled,
                        consentPageId: p.consentPageId ?? null,
                        port: getProxyServerPort(p.name),
                        running: isProxyServerRunning(p.name),
                        publicHostnames: p.publicHostnames || [],
                        tlsMode: p.tlsMode || 'none',
                        http2: p.http2 !== false,
                        hstsEnabled: !!p.hstsEnabled,
                        sslForced: !!p.sslForced,
                        allowWebsocketUpgrade: p.allowWebsocketUpgrade !== false,
                        advancedConfig: p.advancedConfig || '',
                        npmLocations: p.npmLocations || [],
                        npmProxyHostId: p.npmProxyHostId,
                        npmCertificateId: p.npmCertificateId,
                    }));
                    return jsonRes(200, { profiles });
                }

                if (url.pathname === '/admin/profiles' && req.method === 'POST') {
                    let body: unknown;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON body' }); }

                    const error = validateProfileInput(body);
                    if (error) return jsonRes(400, { error });

                    const input = body as Record<string, unknown>;
                    const profile: ProxyProfile = {
                        name: (input.name as string).toLowerCase(),
                        targetUrl: (input.targetUrl as string).replace(/\/$/, ''),
                    };
                    if (input.apiKey) profile.apiKey = input.apiKey as string;
                    if (input.authHeader) profile.authHeader = input.authHeader as string;
                    if (input.authPrefix) profile.authPrefix = input.authPrefix as string;
                    if (input.accessKey) profile.accessKey = input.accessKey as string;
                    if (input.authMode && ['none', 'accessKey', 'login'].includes(input.authMode as string)) {
                        profile.authMode = input.authMode as 'none' | 'accessKey' | 'login';
                    }
                    if (typeof input.require2fa === 'boolean') profile.require2fa = input.require2fa;
                    if (typeof input.isWebApp === 'boolean') profile.isWebApp = input.isWebApp;
                    if (typeof input.disableLogs === 'boolean') profile.disableLogs = input.disableLogs;
                    if (typeof input.forwardPath === 'boolean') profile.forwardPath = input.forwardPath;
                    if (typeof input.loginTitle === 'string' && input.loginTitle) profile.loginTitle = input.loginTitle;
                    if (typeof input.loginLogo === 'string' && input.loginLogo) profile.loginLogo = input.loginLogo;
                    if (typeof input.allowSelfSignedTls === 'boolean') profile.allowSelfSignedTls = input.allowSelfSignedTls;
                    if (typeof input.supabaseMode === 'boolean') profile.supabaseMode = input.supabaseMode;
                    if (typeof input.consentEnabled === 'boolean') profile.consentEnabled = input.consentEnabled;
                    if (input.consentPageId === null) {
                        profile.consentPageId = null;
                    } else if (typeof input.consentPageId === 'number') {
                        if (!getConsentPage(input.consentPageId)) return jsonRes(400, { error: 'consentPageId references an unknown page' });
                        profile.consentPageId = input.consentPageId;
                    }
                    if (input.blockedExtensions) {
                        profile.blockedExtensions = new Set(
                            (input.blockedExtensions as string[]).map(e => e.trim().toLowerCase().replace(/^\.?/, '.'))
                        );
                    }
                    if (Array.isArray(input.allowedIps) && input.allowedIps.length) profile.allowedIps = input.allowedIps as string[];

                    // NPM integration fields (all optional)
                    if (Array.isArray(input.publicHostnames)) {
                        const hosts = (input.publicHostnames as string[]).map(h => String(h).trim().toLowerCase()).filter(Boolean);
                        if (hosts.length > 0) profile.publicHostnames = hosts;
                    }
                    if (input.tlsMode === 'auto-acme' || input.tlsMode === 'manual' || input.tlsMode === 'none') {
                        profile.tlsMode = input.tlsMode;
                    }
                    if (typeof input.http2 === 'boolean') profile.http2 = input.http2;
                    if (typeof input.hstsEnabled === 'boolean') profile.hstsEnabled = input.hstsEnabled;
                    if (typeof input.sslForced === 'boolean') profile.sslForced = input.sslForced;
                    if (typeof input.allowWebsocketUpgrade === 'boolean') profile.allowWebsocketUpgrade = input.allowWebsocketUpgrade;
                    if (typeof input.advancedConfig === 'string') profile.advancedConfig = input.advancedConfig;
                    // Adoption fields — accepted on create only (preserved across updates via the merge below).
                    if (typeof input.npmProxyHostId === 'number' && input.npmProxyHostId > 0) profile.npmProxyHostId = input.npmProxyHostId;
                    if (typeof input.npmOriginalForwardHost === 'string' && input.npmOriginalForwardHost) profile.npmOriginalForwardHost = input.npmOriginalForwardHost;
                    if (typeof input.npmOriginalForwardPort === 'number' && input.npmOriginalForwardPort > 0) profile.npmOriginalForwardPort = input.npmOriginalForwardPort;
                    if (input.npmOriginalForwardScheme === 'http' || input.npmOriginalForwardScheme === 'https') profile.npmOriginalForwardScheme = input.npmOriginalForwardScheme;
                    if (Array.isArray(input.npmLocations) && input.npmLocations.length > 0) {
                        profile.npmLocations = (input.npmLocations as any[]).map(l => ({
                            path: String(l.path).trim(),
                            forwardScheme: l.forwardScheme === 'https' ? 'https' : 'http',
                            forwardHost: String(l.forwardHost).trim(),
                            forwardPort: Number(l.forwardPort),
                            advancedConfig: typeof l.advancedConfig === 'string' ? l.advancedConfig : undefined,
                        }));
                    }

                    const idx = config.proxyProfiles.findIndex(p => p.name === profile.name);
                    if (idx >= 0) {
                        // Preserve NPM-managed ids across saves (the user can't edit these directly).
                        const existing = config.proxyProfiles[idx];
                        if (existing.npmProxyHostId !== undefined && profile.npmProxyHostId === undefined) profile.npmProxyHostId = existing.npmProxyHostId;
                        if (existing.npmCertificateId !== undefined && profile.npmCertificateId === undefined) profile.npmCertificateId = existing.npmCertificateId;
                        if (existing.npmOriginalForwardHost && !profile.npmOriginalForwardHost) profile.npmOriginalForwardHost = existing.npmOriginalForwardHost;
                        if (existing.npmOriginalForwardPort !== undefined && profile.npmOriginalForwardPort === undefined) profile.npmOriginalForwardPort = existing.npmOriginalForwardPort;
                        if (existing.npmOriginalForwardScheme && !profile.npmOriginalForwardScheme) profile.npmOriginalForwardScheme = existing.npmOriginalForwardScheme;
                        config.proxyProfiles[idx] = profile;
                    }
                    else config.proxyProfiles.push(profile);

                    persistProfiles(config.proxyProfiles);
                    invalidateProfileCache();

                    // Fire-and-forget NPM sync; failures never block profile save.
                    if (isNpmEnabled()) {
                        (async () => {
                            try {
                                const { syncProfile } = await import('./npm/sync');
                                const r = await syncProfile(profile, config.proxyProfiles);
                                if (!r.ok) console.warn(`[npm] sync failed for "${profile.name}": ${r.error}`);
                                else if (r.action && r.action !== 'noop') console.log(`[npm] ${r.action} proxy host #${r.proxyHostId ?? '?'} for "${profile.name}"`);
                            } catch (e) {
                                console.warn(`[npm] sync error for "${profile.name}":`, e instanceof Error ? e.message : e);
                            }
                        })();
                    }

                    let proxyPort: number;
                    const me = getAuthedAdmin(req);
                    if (idx >= 0) {
                        // Update: the server still owns its port — use it directly without probing.
                        // Probing would fail (port in use) and cause a spurious reassignment.
                        proxyPort = getProxyServerPort(profile.name) || 0;
                        if (!proxyPort) {
                            const excludePorts = getProxyServerStatus().map(s => s.port).filter(Boolean);
                            proxyPort = await assignProxyPort(profile.name, config.port, excludePorts);
                        }
                        await restartProxyServer(profile.name, profile, proxyPort);
                        console.log(`✅ Profile "${profile.name}" updated (port ${proxyPort})`);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'profile.update', targetType: 'profile', targetId: profile.name, details: { targetUrl: profile.targetUrl, authMode: profile.authMode }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(200, { status: 'updated', profile: profile.name, port: proxyPort });
                    } else {
                        const excludePorts = getProxyServerStatus().map(s => s.port).filter(Boolean);
                        proxyPort = await assignProxyPort(profile.name, config.port, excludePorts);
                        startProxyServer(profile, proxyPort);
                        console.log(`✅ Profile "${profile.name}" created (port ${proxyPort})`);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'profile.create', targetType: 'profile', targetId: profile.name, details: { targetUrl: profile.targetUrl, authMode: profile.authMode }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(200, { status: 'created', profile: profile.name, port: proxyPort });
                    }
                }

                if (url.pathname.match(/^\/admin\/profiles\/[^/]+$/) && req.method === 'DELETE') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Profile name required' });
                    const idx = config.proxyProfiles.findIndex(p => p.name === name);
                    if (idx === -1) return jsonRes(404, { error: `Profile "${name}" not found` });
                    const removed = config.proxyProfiles[idx];
                    // Best-effort NPM unsync before we drop the profile from memory.
                    if (isNpmEnabled() && removed.npmProxyHostId) {
                        try {
                            const { deleteSyncedHost } = await import('./npm/sync');
                            await deleteSyncedHost(removed, config.proxyProfiles);
                        } catch (e) {
                            console.warn(`[npm] failed to unsync "${name}":`, e instanceof Error ? e.message : e);
                        }
                    }
                    config.proxyProfiles.splice(idx, 1);
                    persistProfiles(config.proxyProfiles);
                    invalidateProfileCache();
                    await stopProxyServer(name);
                    releaseProxyPort(name);
                    removeAllProfileAssociations(name);
                    removeAllProfileLdapGroups(name);
                    console.log(`🗑️  Profile "${name}" deleted`);
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'profile.delete', targetType: 'profile', targetId: name, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'deleted', profile: name });
                }

                // ── Global Proxy Users CRUD ──

                // GET /admin/proxy-users — list all global proxy users
                if (url.pathname === '/admin/proxy-users' && req.method === 'GET') {
                    const users = listAllProxyUsers().map(u => {
                        return {
                            ...u,
                            profiles: listProfilesForProxyUser(u.id),
                        };
                    });
                    const me = getAuthedAdmin(req);
                    return jsonRes(200, { users, currentUserId: me?.id ?? null });
                }

                // POST /admin/proxy-users — create a new global proxy user
                if (url.pathname === '/admin/proxy-users' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const username = (body.username || '').trim();
                    const password = body.password || '';
                    const fullName = (body.fullName || '').trim();
                    const email = (body.email || '').trim().toLowerCase();
                    if (!username || username.length < 2) return jsonRes(400, { error: 'Username must be at least 2 characters' });
                    if (!password || password.length < 6) return jsonRes(400, { error: 'Password must be at least 6 characters' });
                    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes(400, { error: 'Invalid email address' });

                    try {
                        const user = await createProxyUser(username, password, fullName, email);
                        const profiles: string[] = Array.isArray(body.profiles) ? body.profiles : [];
                        for (const pn of profiles) {
                            assignProxyUserToProfile(user.id, pn);
                        }
                        console.log(`✅ Proxy user "${username}" created`);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'proxy_user.create', targetType: 'proxy_user', targetId: user.id, details: { username, email, profiles }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(200, { status: 'created', user: { ...user, profiles } });
                    } catch (err: any) {
                        if (err.message?.includes('UNIQUE')) return jsonRes(409, { error: 'Username already exists' });
                        return jsonRes(500, { error: err.message || 'Failed to create user' });
                    }
                }

                // GET /admin/proxy-users/:id — get a single proxy user
                if (url.pathname.match(/^\/admin\/proxy-users\/\d+$/) && req.method === 'GET') {
                    const userId = parseInt(url.pathname.split('/').pop()!, 10);
                    const user = getProxyUser(userId);
                    if (!user) return jsonRes(404, { error: 'User not found' });
                    return jsonRes(200, { user: { ...user, profiles: listProfilesForProxyUser(userId) } });
                }

                // GET /admin/proxy-users/:id/resources — list ALL resources the user can access
                if (url.pathname.match(/^\/admin\/proxy-users\/\d+\/resources$/) && req.method === 'GET') {
                    const userId = parseInt(url.pathname.split('/')[3]!, 10);
                    const user = getProxyUser(userId);
                    if (!user) return jsonRes(404, { error: 'User not found' });

                    const assignedProfileNames = new Set(listProfilesForProxyUser(userId).map(n => n.toLowerCase()));
                    const loginProfiles = config.proxyProfiles.filter(p => (p.authMode || 'none') === 'login');
                    const httpProxies = loginProfiles.map(p => {
                        const direct = assignedProfileNames.has(p.name.toLowerCase());
                        const viaLdap = !direct && shadowUserMatchesProfileLdapGroups(userId, p.name);
                        return {
                            name: p.name,
                            assigned: direct || viaLdap,
                            source: direct ? 'direct' : (viaLdap ? 'ldap_group' : null),
                        };
                    });

                    const allClients = listOauthClients();
                    const oauthClients = allClients.map(c => {
                        const allowed = isUserAllowedForClient(userId, c.clientId);
                        // Determine if directly listed: query oauth_client_users via existing helper indirectly.
                        // We don't have a single helper; check by listing users for this client.
                        const direct = listUsersForOauthClient(c.clientId).some(u => u.id === userId);
                        const viaLdap = allowed && !direct && c.allowListEnabled;
                        return {
                            clientId: c.clientId,
                            name: c.name,
                            allowListEnabled: c.allowListEnabled,
                            assigned: allowed,
                            source: !c.allowListEnabled ? 'open' : (direct ? 'direct' : (viaLdap ? 'ldap_group' : null)),
                        };
                    });

                    return jsonRes(200, { httpProxies, oauthClients });
                }

                // PUT /admin/proxy-users/:id — update user (password, info, reset 2fa, admin role)
                if (url.pathname.match(/^\/admin\/proxy-users\/\d+$/) && req.method === 'PUT') {
                    const userId = parseInt(url.pathname.split('/').pop()!, 10);
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    if (body.password) {
                        if (body.password.length < 6) return jsonRes(400, { error: 'Password must be at least 6 characters' });
                        const updated = await updateProxyUserPassword(userId, body.password);
                        if (!updated) return jsonRes(404, { error: 'User not found' });
                    }
                    if (typeof body.fullName === 'string' || typeof body.email === 'string') {
                        const current = getProxyUser(userId);
                        if (!current) return jsonRes(404, { error: 'User not found' });
                        const email = (body.email ?? current.email).trim().toLowerCase();
                        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes(400, { error: 'Invalid email address' });
                        updateProxyUserInfo(userId, (body.fullName ?? current.fullName).trim(), email);
                    }
                    if (body.reset2fa) {
                        const target = getProxyUser(userId);
                        disableProxyUserTotp(userId);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'proxy_user.2fa.disable', targetType: 'proxy_user', targetId: userId, details: { username: target?.username }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        if (target?.email && isSmtpConfigured()) {
                            const reqHost = req.headers.get('host') || `localhost:${config.port}`;
                            const protocol = req.headers.get('x-forwarded-proto') || 'http';
                            const profiles = listProfilesForProxyUser(userId);
                            const loginUrl = profiles.length > 0
                                ? `${protocol}://${reqHost}/proxy/${encodeURIComponent(profiles[0])}/auth/login`
                                : `${protocol}://${reqHost}/`;
                            const tpl = render2faDisabledEmail({ fullName: target.fullName, loginUrl });
                            sendMail({ to: target.email, subject: tpl.subject, html: tpl.html, text: tpl.text }).catch(() => { });
                        }
                    }
                    if (body.force2fa) {
                        const target = getProxyUser(userId);
                        if (!target) return jsonRes(404, { error: 'User not found' });
                        setProxyUserForce2faSetup(userId, true);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'proxy_user.2fa.force', targetType: 'proxy_user', targetId: userId, details: { username: target.username, hadTotp: target.totpEnabled }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        if (target.email && isSmtpConfigured()) {
                            const reqHost = req.headers.get('host') || `localhost:${config.port}`;
                            const protocol = req.headers.get('x-forwarded-proto') || 'http';
                            const profiles = listProfilesForProxyUser(userId);
                            const loginUrl = profiles.length > 0
                                ? `${protocol}://${reqHost}/proxy/${encodeURIComponent(profiles[0])}/auth/login`
                                : `${protocol}://${reqHost}/`;
                            const tpl = renderForce2faEmail({ fullName: target.fullName, loginUrl });
                            sendMail({ to: target.email, subject: tpl.subject, html: tpl.html, text: tpl.text }).catch(() => { });
                        }
                    }
                    if (typeof body.isAdmin === 'boolean') {
                        const current = getProxyUser(userId);
                        if (!current) return jsonRes(404, { error: 'User not found' });
                        const me = getAuthedAdmin(req);
                        // Guard A: refuse self-demote. The current session still
                        // carries admin privileges in its cookie; removing the
                        // role here would let the user keep doing admin things
                        // until refresh. Ask another admin to do it.
                        if (!body.isAdmin && current.isAdmin && me?.id === userId) {
                            return jsonRes(409, { error: "You can't remove admin from your own account. Ask another admin." });
                        }
                        // Guard B: refuse demoting the last admin.
                        if (!body.isAdmin && current.isAdmin && countAdmins() <= 1) {
                            return jsonRes(409, { error: 'Cannot demote the last admin. Promote someone else first.' });
                        }
                        const changed = setProxyUserAdminRole(userId, body.isAdmin);
                        if (changed) {
                            logAudit({
                                actorUserId: me?.id, actorUsername: me?.username,
                                action: body.isAdmin ? 'admin.promote' : 'admin.demote',
                                targetType: 'proxy_user', targetId: userId,
                                details: { username: current.username },
                                ip: reqClientIp(req), userAgent: req.headers.get('user-agent'),
                            });
                        }
                    }
                    return jsonRes(200, { status: 'updated' });
                }

                // DELETE /admin/proxy-users/:id — delete a global proxy user
                if (url.pathname.match(/^\/admin\/proxy-users\/\d+$/) && req.method === 'DELETE') {
                    const userId = parseInt(url.pathname.split('/').pop()!, 10);
                    const target = getProxyUser(userId);
                    const deleted = deleteProxyUser(userId);
                    if (!deleted) return jsonRes(404, { error: 'User not found' });
                    console.log(`🗑️  Proxy user #${userId} deleted`);
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'proxy_user.delete', targetType: 'proxy_user', targetId: userId, details: { username: target?.username }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'deleted' });
                }

                // ── Admins (additional admin users) ─────────────────────────────────────

                if (url.pathname === '/admin/admins' && req.method === 'GET') {
                    return jsonRes(200, { admins: listAdmins(), currentUserId: getAuthedAdmin(req)?.id ?? null });
                }

                if (url.pathname === '/admin/admins' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const username = (body.username || '').trim();
                    const password = body.password || '';
                    const fullName = (body.fullName || '').trim();
                    const email = (body.email || '').trim().toLowerCase();
                    if (!username || username.length < 2) return jsonRes(400, { error: 'Username must be at least 2 characters' });
                    if (!password || password.length < 8) return jsonRes(400, { error: 'Password must be at least 8 characters' });
                    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes(400, { error: 'Invalid email' });
                    const me = getAuthedAdmin(req);
                    try {
                        const admin = await createAdditionalAdmin(username, password, fullName, email, me?.id ?? 0);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'admin.create', targetType: 'admin', targetId: admin.id, details: { username, email, fullName }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(201, { admin });
                    } catch (err: any) {
                        const msg = err?.message || String(err);
                        if (msg.includes('UNIQUE') || msg.includes('unique')) return jsonRes(409, { error: 'Username already exists' });
                        return jsonRes(400, { error: msg });
                    }
                }

                if (url.pathname.match(/^\/admin\/admins\/\d+$/) && req.method === 'DELETE') {
                    const id = parseInt(url.pathname.split('/').pop()!, 10);
                    const me = getAuthedAdmin(req);
                    if (me?.id === id) return jsonRes(400, { error: 'Cannot delete your own account' });
                    const target = getAdmin(id);
                    const result = deleteAdmin(id);
                    if (!result.deleted) return jsonRes(400, { error: result.reason || 'Cannot delete' });
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'admin.delete', targetType: 'admin', targetId: id, details: { username: target?.username }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'deleted' });
                }

                if (url.pathname.match(/^\/admin\/admins\/\d+\/password$/) && req.method === 'PATCH') {
                    const id = parseInt(url.pathname.split('/')[3], 10);
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const newPassword = body.password || '';
                    if (newPassword.length < 8) return jsonRes(400, { error: 'Password must be at least 8 characters' });
                    const me = getAuthedAdmin(req);
                    const ok = await updateAdminPassword(id, newPassword);
                    if (!ok) return jsonRes(404, { error: 'Admin not found' });
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'admin.password_reset', targetType: 'admin', targetId: id, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'updated' });
                }

                // ── Admin invites ────────────────────────────────────────────────────────

                if (url.pathname === '/admin/admins/invite' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const email = (body.email || '').trim().toLowerCase();
                    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes(400, { error: 'Email inválido' });
                    const fullName = (body.fullName || '').trim().slice(0, 100);
                    const note = (body.note || '').trim().slice(0, 200);
                    const expiresInHours = Math.min(Math.max(parseInt(body.expiresInHours) || 48, 1), 720);
                    const me = getAuthedAdmin(req);
                    const invite = createAdminInvite(email, fullName, note, expiresInHours, me?.id);
                    const reqHost = req.headers.get('host') || `localhost:${config.port}`;
                    const protocol = req.headers.get('x-forwarded-proto') || 'http';
                    const inviteUrl = `${protocol}://${reqHost}/admin-invite/${invite.token}`;
                    let emailSent: boolean | undefined;
                    let emailError: string | undefined;
                    if (email && isSmtpConfigured()) {
                        const tpl = renderAdminInviteEmail({ inviteUrl, fullName, note, expiresInHours });
                        const r = await sendMail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
                        emailSent = r.ok;
                        emailError = r.error;
                    }
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'admin.invite.create', targetType: 'admin', details: { email, fullName, expiresInHours, emailSent: emailSent ?? null, emailError: emailError ?? null }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { invite, inviteUrl, emailSent: emailSent ?? false, emailError: emailError ?? null });
                }

                if (url.pathname === '/admin/admins/invites' && req.method === 'GET') {
                    return jsonRes(200, { invites: listAdminInvites() });
                }

                if (url.pathname.match(/^\/admin\/admins\/invite\/[^/]+$/) && req.method === 'DELETE') {
                    const token = url.pathname.split('/').pop()!;
                    const ok = revokeAdminInvite(token);
                    if (!ok) return jsonRes(404, { error: 'Convite não encontrado ou já usado' });
                    return jsonRes(200, { status: 'revoked' });
                }

                // POST /admin/admins/invites/:token/resend — resend admin invite email
                if (url.pathname.match(/^\/admin\/admins\/invites\/[^/]+\/resend$/) && req.method === 'POST') {
                    const token = url.pathname.split('/')[4];
                    const invite = getAdminInvite(token);
                    if (!invite) return jsonRes(404, { error: 'Invite not found' });
                    if (invite.usedAt) return jsonRes(409, { error: 'Invite already used' });
                    if (new Date(invite.expiresAt) < new Date()) return jsonRes(409, { error: 'Invite expired' });
                    if (!invite.email) return jsonRes(400, { error: 'Invite has no email address' });
                    if (!isSmtpConfigured()) return jsonRes(400, { error: 'SMTP not configured. Configure SMTP in Settings first.' });
                    const reqHost = req.headers.get('host') || `localhost:${config.port}`;
                    const protocol = req.headers.get('x-forwarded-proto') || 'http';
                    const inviteUrl = `${protocol}://${reqHost}/admin-invite/${invite.token}`;
                    const expiresInHours = Math.max(1, Math.round((new Date(invite.expiresAt).getTime() - Date.now()) / 3_600_000));
                    const tpl = renderAdminInviteEmail({ inviteUrl, fullName: invite.fullName, note: invite.note, expiresInHours });
                    const r = await sendMail({ to: invite.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
                    if (!r.ok) return jsonRes(502, { error: r.error || 'Failed to send email' });
                    console.log(`✅ Admin invite resent to "${invite.email}"`);
                    return jsonRes(200, { status: 'sent', emailSent: true });
                }

                // ── SMTP / Email ─────────────────────────────────────────────────────────

                if (url.pathname === '/admin/smtp' && req.method === 'GET') {
                    return jsonRes(200, { smtp: publicSmtpConfig(getSmtpConfig()) });
                }

                if (url.pathname === '/admin/smtp' && req.method === 'PUT') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const err = validateSmtpInput(body);
                    if (err) return jsonRes(400, { error: err });
                    try {
                        const cfg = saveSmtpConfig(body);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'smtp.update', targetType: 'smtp', details: { host: cfg.host, port: cfg.port, security: cfg.security, fromAddress: cfg.fromAddress }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(200, { smtp: publicSmtpConfig(cfg) });
                    } catch (e) {
                        return jsonRes(500, { error: e instanceof Error ? e.message : String(e) });
                    }
                }

                if (url.pathname === '/admin/smtp' && req.method === 'DELETE') {
                    deleteSmtpConfig();
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'smtp.delete', targetType: 'smtp', ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'deleted' });
                }

                if (url.pathname === '/admin/smtp/test' && req.method === 'POST') {
                    let body: any = undefined;
                    if (req.headers.get('content-length') && req.headers.get('content-length') !== '0') {
                        try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                        if (body && Object.keys(body).length) {
                            const err = validateSmtpInput(body);
                            if (err) return jsonRes(400, { error: err });
                        } else {
                            body = undefined;
                        }
                    }
                    const result = await testSmtpConnection(body, { signal: req.signal });
                    return jsonRes(result.ok ? 200 : 400, { ...result });
                }

                if (url.pathname === '/admin/smtp/send-test' && req.method === 'POST') {
                    if (!isSmtpConfigured()) return jsonRes(400, { error: 'SMTP not configured. Save settings first.' });
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const to = (body?.to || '').trim();
                    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return jsonRes(400, { error: '"to" must be a valid email' });
                    const tpl = renderTestEmail();
                    const result = await sendMail({ to, subject: tpl.subject, html: tpl.html, text: tpl.text }, { signal: req.signal });
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'smtp.test_send', targetType: 'smtp', details: { to, ok: result.ok, error: result.error }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(result.ok ? 200 : 400, { ...result });
                }

                // ── NPM (Nginx Proxy Manager) integration ────────────────────────────────

                if (url.pathname === '/admin/npm' && req.method === 'GET') {
                    return jsonRes(200, {
                        npm: publicNpmSettings(getNpmSettings()),
                        certVolumeMounted: isNpmCertVolumePresent(),
                    });
                }

                if (url.pathname === '/admin/npm' && req.method === 'PUT') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const err = validateNpmInput(body);
                    if (err) return jsonRes(400, { error: err });
                    try {
                        const cfg = saveNpmSettings(body);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'npm.update', targetType: 'npm', details: { url: cfg.url, email: cfg.email, enabled: cfg.enabled }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(200, { npm: publicNpmSettings(cfg) });
                    } catch (e) {
                        return jsonRes(500, { error: e instanceof Error ? e.message : String(e) });
                    }
                }

                if (url.pathname === '/admin/npm' && req.method === 'DELETE') {
                    deleteNpmSettings();
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'npm.delete', targetType: 'npm', ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'deleted' });
                }

                if (url.pathname === '/admin/npm/test' && req.method === 'POST') {
                    let body: any = undefined;
                    if (req.headers.get('content-length') && req.headers.get('content-length') !== '0') {
                        try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    }
                    try {
                        const { testConnection } = await import('./npm/client');
                        let override: { url: string; email: string; password: string } | undefined;
                        if (body && body.url && body.email && body.password) {
                            override = { url: String(body.url).replace(/\/$/, ''), email: String(body.email), password: String(body.password) };
                        }
                        const result = await testConnection(override);
                        return jsonRes(200, result);
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        return jsonRes(400, { ok: false, error: msg });
                    }
                }

                if (url.pathname === '/admin/npm/status' && req.method === 'GET') {
                    if (!isNpmEnabled()) return jsonRes(200, { enabled: false });
                    try {
                        const { listProxyHosts, listCertificates } = await import('./npm/client');
                        const [hosts, certs] = await Promise.all([listProxyHosts(), listCertificates()]);
                        return jsonRes(200, {
                            enabled: true,
                            hostsCount: hosts.length,
                            certsCount: certs.length,
                            certVolumeMounted: isNpmCertVolumePresent(),
                        });
                    } catch (e) {
                        return jsonRes(200, { enabled: true, error: e instanceof Error ? e.message : String(e) });
                    }
                }

                // List proxy hosts from NPM with adoption status.
                if (url.pathname === '/admin/npm/proxy-hosts' && req.method === 'GET') {
                    if (!isNpmEnabled()) return jsonRes(400, { error: 'NPM integration is disabled' });
                    try {
                        const { listProxyHosts } = await import('./npm/client');
                        const hosts = await listProxyHosts();
                        const npmHost = (getNpmSettings()?.midlemanPublicHost || 'midleman').toLowerCase();
                        const byId = new Map<number, string>();
                        for (const p of config.proxyProfiles) if (p.npmProxyHostId) byId.set(p.npmProxyHostId, p.name);
                        const out = hosts.map(h => {
                            const linkedTo = byId.get(h.id);
                            const looksAdopted = (h.forward_host || '').toLowerCase() === npmHost && !!linkedTo;
                            return {
                                id: h.id,
                                domain_names: h.domain_names || [],
                                forward_scheme: h.forward_scheme,
                                forward_host: h.forward_host,
                                forward_port: h.forward_port,
                                certificate_id: typeof h.certificate_id === 'number' ? h.certificate_id : null,
                                ssl_forced: !!h.ssl_forced,
                                http2_support: !!h.http2_support,
                                enabled: h.enabled !== false,
                                linkedProfile: linkedTo || null,
                                adopted: !!linkedTo,
                                adoptedAndPointingHere: looksAdopted,
                            };
                        });
                        return jsonRes(200, { hosts: out });
                    } catch (e) {
                        return jsonRes(502, { error: e instanceof Error ? e.message : String(e) });
                    }
                }

                // Adopt an NPM proxy host: read its current forward target, then ask client to
                // open a profile form pre-filled with that target. The actual update of NPM
                // (point forward_host to Midleman) happens when the user saves the profile.
                const adoptMatch = url.pathname.match(/^\/admin\/npm\/proxy-hosts\/(\d+)\/preview-adopt$/);
                if (adoptMatch && req.method === 'GET') {
                    if (!isNpmEnabled()) return jsonRes(400, { error: 'NPM integration is disabled' });
                    const id = Number(adoptMatch[1]);
                    try {
                        const { getProxyHost } = await import('./npm/client');
                        const host = await getProxyHost(id);
                        const taken = config.proxyProfiles.find(p => p.npmProxyHostId === id);
                        if (taken) return jsonRes(409, { error: `Already linked to profile "${taken.name}"` });
                        const scheme = host.forward_scheme === 'https' ? 'https' : 'http';
                        return jsonRes(200, {
                            preview: {
                                npmProxyHostId: host.id,
                                publicHostnames: host.domain_names || [],
                                targetUrl: `${scheme}://${host.forward_host}:${host.forward_port}`,
                                npmOriginalForwardHost: host.forward_host,
                                npmOriginalForwardPort: host.forward_port,
                                npmOriginalForwardScheme: scheme,
                                http2: !!host.http2_support,
                                hstsEnabled: !!host.hsts_enabled,
                                sslForced: !!host.ssl_forced,
                                allowWebsocketUpgrade: host.allow_websocket_upgrade !== false,
                                advancedConfig: host.advanced_config || '',
                                certificateId: typeof host.certificate_id === 'number' ? host.certificate_id : null,
                            },
                        });
                    } catch (e) {
                        return jsonRes(502, { error: e instanceof Error ? e.message : String(e) });
                    }
                }

                // Release: restore the host's original forward target in NPM and clear the link.
                const releaseMatch = url.pathname.match(/^\/admin\/profiles\/([^/]+)\/npm-release$/);
                if (releaseMatch && req.method === 'POST') {
                    if (!isNpmEnabled()) return jsonRes(400, { error: 'NPM integration is disabled' });
                    const name = decodeURIComponent(releaseMatch[1]).toLowerCase();
                    const profile = config.proxyProfiles.find(p => p.name === name);
                    if (!profile) return jsonRes(404, { error: 'Profile not found' });
                    if (!profile.npmProxyHostId) return jsonRes(400, { error: 'Profile is not linked to an NPM host' });
                    try {
                        const { updateProxyHost } = await import('./npm/client');
                        if (profile.npmOriginalForwardHost && profile.npmOriginalForwardPort) {
                            await updateProxyHost(profile.npmProxyHostId, {
                                forward_host: profile.npmOriginalForwardHost,
                                forward_port: profile.npmOriginalForwardPort,
                                forward_scheme: profile.npmOriginalForwardScheme || 'http',
                                domain_names: profile.publicHostnames || [],
                            });
                        }
                        profile.npmProxyHostId = undefined;
                        profile.npmOriginalForwardHost = undefined;
                        profile.npmOriginalForwardPort = undefined;
                        profile.npmOriginalForwardScheme = undefined;
                        persistProfiles(config.proxyProfiles);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'npm.release', targetType: 'profile', targetId: name, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(200, { ok: true });
                    } catch (e) {
                        return jsonRes(502, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                }

                // Bulk adopt: create profiles for several NPM hosts at once.
                // Body: { hostIds: number[], authMode: 'none'|'accessKey'|'login', accessKey?, isWebApp?, require2fa? }
                if (url.pathname === '/admin/npm/proxy-hosts/bulk-adopt' && req.method === 'POST') {
                    if (!isNpmEnabled()) return jsonRes(400, { error: 'NPM integration is disabled' });
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const ids = Array.isArray(body?.hostIds) ? body.hostIds.filter((v: unknown) => typeof v === 'number' && v > 0) : [];
                    if (ids.length === 0) return jsonRes(400, { error: 'No host ids supplied' });
                    if (ids.length > 100) return jsonRes(400, { error: 'Too many hosts (max 100 per batch)' });
                    const authMode = (body?.authMode === 'accessKey' || body?.authMode === 'login') ? body.authMode : 'none';
                    const require2fa = !!body?.require2fa;
                    const isWebApp = !!body?.isWebApp;
                    const sharedAccessKey: string = typeof body?.accessKey === 'string' ? body.accessKey.trim() : '';

                    // Helper: build a unique, valid profile name from hostnames.
                    const slugify = (s: string) =>
                        s.toLowerCase()
                         .replace(/^\*\.?/, '')
                         .replace(/[^a-z0-9._-]+/g, '-')
                         .replace(/^[-.]+|[-.]+$/g, '')
                         .slice(0, 64) || 'host';
                    const existingNames = new Set(config.proxyProfiles.map(p => p.name));
                    const uniqueName = (base: string) => {
                        if (!existingNames.has(base)) { existingNames.add(base); return base; }
                        for (let i = 2; i < 1000; i++) {
                            const candidate = (base.length > 60 ? base.slice(0, 60) : base) + '-' + i;
                            if (!existingNames.has(candidate)) { existingNames.add(candidate); return candidate; }
                        }
                        throw new Error('Could not derive a unique profile name');
                    };

                    const { getProxyHost } = await import('./npm/client');
                    const { syncProfile } = await import('./npm/sync');

                    const results: Array<{ hostId: number; ok: boolean; profile?: string; error?: string }> = [];
                    for (const hostId of ids) {
                        try {
                            const taken = config.proxyProfiles.find(p => p.npmProxyHostId === hostId);
                            if (taken) { results.push({ hostId, ok: false, error: `Already linked to "${taken.name}"` }); continue; }
                            const host = await getProxyHost(hostId);
                            const scheme = host.forward_scheme === 'https' ? 'https' : 'http';
                            const domains = (host.domain_names || []).filter(Boolean);
                            if (domains.length === 0) { results.push({ hostId, ok: false, error: 'Host has no domain_names' }); continue; }
                            const name = uniqueName(slugify(domains[0]));
                            const profile = {
                                name,
                                targetUrl: `${scheme}://${host.forward_host}:${host.forward_port}`,
                                authMode,
                                require2fa: authMode === 'login' ? require2fa : undefined,
                                isWebApp: authMode === 'login' ? isWebApp : undefined,
                                accessKey: authMode === 'accessKey' && sharedAccessKey ? sharedAccessKey : undefined,
                                publicHostnames: domains.map(d => d.toLowerCase()),
                                tlsMode: (typeof host.certificate_id === 'number' && host.certificate_id > 0) ? 'manual' as const : 'none' as const,
                                http2: !!host.http2_support,
                                hstsEnabled: !!host.hsts_enabled,
                                sslForced: !!host.ssl_forced,
                                allowWebsocketUpgrade: host.allow_websocket_upgrade !== false,
                                advancedConfig: host.advanced_config || undefined,
                                npmProxyHostId: host.id,
                                npmCertificateId: (typeof host.certificate_id === 'number' && host.certificate_id > 0) ? host.certificate_id : undefined,
                                npmOriginalForwardHost: host.forward_host,
                                npmOriginalForwardPort: host.forward_port,
                                npmOriginalForwardScheme: scheme,
                                forwardPath: true,
                            };
                            config.proxyProfiles.push(profile as any);
                            persistProfiles(config.proxyProfiles);

                            // Start the proxy server for the new profile so /proxy/{name}/ routes through.
                            try {
                                const excludePorts = getProxyServerStatus().map(s => s.port).filter(Boolean);
                                const port = await assignProxyPort(profile.name, config.port, excludePorts);
                                startProxyServer(profile as any, port);
                            } catch (e) {
                                console.warn(`[npm:bulk] could not start proxy server for "${profile.name}":`, e instanceof Error ? e.message : e);
                            }

                            // Update NPM so it points at Midleman now.
                            const syncRes = await syncProfile(profile as any, config.proxyProfiles);
                            if (!syncRes.ok) {
                                results.push({ hostId, ok: false, profile: profile.name, error: syncRes.error || 'sync failed' });
                            } else {
                                results.push({ hostId, ok: true, profile: profile.name });
                            }
                        } catch (e) {
                            results.push({ hostId, ok: false, error: e instanceof Error ? e.message : String(e) });
                        }
                    }
                    invalidateProfileCache();

                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'npm.bulk_adopt', targetType: 'npm', details: { count: ids.length, authMode, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { results, total: ids.length, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
                }

                const npmSyncMatch = url.pathname.match(/^\/admin\/npm\/sync\/([a-z0-9_-]+)$/i);
                if (npmSyncMatch && req.method === 'POST') {
                    if (!isNpmEnabled()) return jsonRes(400, { error: 'NPM integration is disabled' });
                    const profileName = npmSyncMatch[1].toLowerCase();
                    const profile = config.proxyProfiles.find(p => p.name === profileName);
                    if (!profile) return jsonRes(404, { error: 'Profile not found' });
                    try {
                        const { syncProfile } = await import('./npm/sync');
                        const result = await syncProfile(profile, config.proxyProfiles);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'npm.sync', targetType: 'profile', details: { profile: profileName, result }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(result.ok ? 200 : 502, { ...result });
                    } catch (e) {
                        return jsonRes(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                }

                // ── Audit log ────────────────────────────────────────────────────────────

                if (url.pathname === '/admin/audit' && req.method === 'GET') {
                    const q = {
                        actor: url.searchParams.get('actor') || undefined,
                        action: url.searchParams.get('action') || undefined,
                        targetType: url.searchParams.get('target_type') || undefined,
                        from: url.searchParams.get('from') || undefined,
                        to: url.searchParams.get('to') || undefined,
                        limit: parseInt(url.searchParams.get('limit') || '50', 10),
                        offset: parseInt(url.searchParams.get('offset') || '0', 10),
                    };
                    return jsonRes(200, queryAuditLogs(q));
                }

                // ── Consent pages ────────────────────────────────────────────────────────

                if (url.pathname === '/admin/consent-pages' && req.method === 'GET') {
                    return jsonRes(200, { pages: listConsentPages() });
                }

                if (url.pathname === '/admin/consent-pages' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    try {
                        const page = createConsentPage({
                            name: String(body.name || ''),
                            title: String(body.title || ''),
                            body: String(body.body || ''),
                        });
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'consent_page.create', targetType: 'consent_page', targetId: page.id, details: { name: page.name }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(201, { page });
                    } catch (err) {
                        return jsonRes(400, { error: err instanceof Error ? err.message : String(err) });
                    }
                }

                if (url.pathname.match(/^\/admin\/consent-pages\/\d+$/) && req.method === 'GET') {
                    const id = Number(url.pathname.split('/').pop());
                    const page = getConsentPage(id);
                    if (!page) return jsonRes(404, { error: 'Page not found' });
                    return jsonRes(200, { page });
                }

                if (url.pathname.match(/^\/admin\/consent-pages\/\d+$/) && req.method === 'PUT') {
                    const id = Number(url.pathname.split('/').pop());
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    try {
                        const page = updateConsentPage(id, {
                            name: typeof body.name === 'string' ? body.name : undefined,
                            title: typeof body.title === 'string' ? body.title : undefined,
                            body: typeof body.body === 'string' ? body.body : undefined,
                        });
                        if (!page) return jsonRes(404, { error: 'Page not found' });
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'consent_page.update', targetType: 'consent_page', targetId: id, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(200, { page });
                    } catch (err) {
                        return jsonRes(400, { error: err instanceof Error ? err.message : String(err) });
                    }
                }

                if (url.pathname.match(/^\/admin\/consent-pages\/\d+$/) && req.method === 'DELETE') {
                    const id = Number(url.pathname.split('/').pop());
                    const oauthRefs = findConsentPageOauthReferences(id);
                    const profileRefs = config.proxyProfiles
                        .filter(p => p.consentPageId === id)
                        .map(p => ({ kind: 'proxy_profile' as const, id: p.name, name: p.name }));
                    const refs = [...oauthRefs, ...profileRefs];
                    if (refs.length > 0) {
                        return jsonRes(409, {
                            error: 'Page is in use. Detach it from the listed targets first.',
                            references: refs,
                        });
                    }
                    const deleted = deleteConsentPage(id);
                    if (!deleted) return jsonRes(404, { error: 'Page not found' });
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'consent_page.delete', targetType: 'consent_page', targetId: id, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'deleted' });
                }

                // ── OAuth clients ────────────────────────────────────────────────────────

                if (url.pathname === '/admin/oauth-clients' && req.method === 'GET') {
                    return jsonRes(200, { clients: listOauthClients() });
                }

                if (url.pathname === '/admin/oauth-clients' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const name = (body.name || '').trim();
                    const redirectUris = Array.isArray(body.redirectUris) ? body.redirectUris.map((s: string) => s.trim()).filter(Boolean) : [];
                    if (!name) return jsonRes(400, { error: 'Client name required' });
                    if (redirectUris.length === 0) return jsonRes(400, { error: 'At least one redirect_uri required' });
                    const pkceRequired = body.pkceRequired === undefined ? true : !!body.pkceRequired;
                    try {
                        const { client, clientSecret } = await createOauthClient(name, redirectUris, { pkceRequired });
                        console.log(`🪪 OAuth client created: ${client.name} (${client.clientId})`);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'oauth_client.create', targetType: 'oauth_client', targetId: client.clientId, details: { name, redirectUris }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(201, {
                            client,
                            clientSecret,
                            warning: 'Save the client_secret now. It cannot be retrieved later.',
                        });
                    } catch (err) {
                        return jsonRes(400, { error: err instanceof Error ? err.message : String(err) });
                    }
                }

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+$/) && req.method === 'PUT') {
                    const clientId = decodeURIComponent(url.pathname.split('/').pop()!);
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const input: Parameters<typeof updateOauthClient>[1] = {};
                    if (typeof body.name === 'string') input.name = body.name;
                    if (Array.isArray(body.redirectUris)) {
                        input.redirectUris = body.redirectUris.map((s: string) => String(s).trim()).filter(Boolean);
                    }
                    if (typeof body.consentEnabled === 'boolean') input.consentEnabled = body.consentEnabled;
                    if (typeof body.pkceRequired === 'boolean') input.pkceRequired = body.pkceRequired;
                    if (body.consentPageId === null) {
                        input.consentPageId = null;
                    } else if (typeof body.consentPageId === 'number') {
                        if (!Number.isInteger(body.consentPageId) || body.consentPageId < 1) {
                            return jsonRes(400, { error: 'consentPageId must be a positive integer' });
                        }
                        if (!getConsentPage(body.consentPageId)) return jsonRes(400, { error: 'consentPageId references an unknown page' });
                        input.consentPageId = body.consentPageId;
                    }
                    let result;
                    try { result = updateOauthClient(clientId, input); }
                    catch (err) { return jsonRes(400, { error: err instanceof Error ? err.message : String(err) }); }
                    if (!result.updated && !result.redirectUrisChanged) {
                        // Either client not found OR nothing changed — disambiguate.
                        if (!getOauthClient(clientId)) return jsonRes(404, { error: 'Client not found' });
                        return jsonRes(200, { status: 'no_changes' });
                    }
                    const me = getAuthedAdmin(req);
                    logAudit({
                        actorUserId: me?.id, actorUsername: me?.username,
                        action: 'oauth_client.update', targetType: 'oauth_client', targetId: clientId,
                        details: {
                            changedFields: Object.keys(input),
                            redirectUrisChanged: result.redirectUrisChanged,
                            revokedRefreshTokens: result.revokedRefreshTokens,
                        },
                        ip: reqClientIp(req), userAgent: req.headers.get('user-agent'),
                    });
                    return jsonRes(200, { status: 'ok', redirectUrisChanged: result.redirectUrisChanged, revokedRefreshTokens: result.revokedRefreshTokens });
                }

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+$/) && req.method === 'DELETE') {
                    const clientId = decodeURIComponent(url.pathname.split('/').pop()!);
                    const deleted = deleteOauthClient(clientId);
                    if (!deleted) return jsonRes(404, { error: 'Client not found' });
                    console.log(`🗑️  OAuth client deleted: ${clientId}`);
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'oauth_client.delete', targetType: 'oauth_client', targetId: clientId, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'deleted' });
                }

                // ── OAuth client allow-list management ───────────────────────────────────

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+\/allow-list$/) && req.method === 'PUT') {
                    const clientId = decodeURIComponent(url.pathname.split('/')[3]);
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const ok = setOauthClientAllowList(clientId, !!body.enabled);
                    if (!ok) return jsonRes(404, { error: 'Client not found' });
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'oauth_client.allow_list.update', targetType: 'oauth_client', targetId: clientId, details: { enabled: !!body.enabled }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'ok' });
                }

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+\/users$/) && req.method === 'GET') {
                    const clientId = decodeURIComponent(url.pathname.split('/')[3]);
                    const client = getOauthClient(clientId);
                    if (!client) return jsonRes(404, { error: 'Client not found' });
                    const users = listUsersForOauthClient(clientId);
                    return jsonRes(200, { allowListEnabled: client.allowListEnabled, users });
                }

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+\/users$/) && req.method === 'POST') {
                    const clientId = decodeURIComponent(url.pathname.split('/')[3]);
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const userId = Number(body.userId);
                    if (!userId || isNaN(userId)) return jsonRes(400, { error: 'userId required' });
                    const ok = addUserToOauthClient(clientId, userId);
                    if (!ok) return jsonRes(404, { error: 'Client not found or user not found' });
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'oauth_client.user.add', targetType: 'oauth_client', targetId: clientId, details: { userId }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'ok' });
                }

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+\/users\/[^/]+$/) && req.method === 'DELETE') {
                    const parts = url.pathname.split('/');
                    const clientId = decodeURIComponent(parts[3]);
                    const userId = Number(decodeURIComponent(parts[5]));
                    if (!userId || isNaN(userId)) return jsonRes(400, { error: 'Invalid userId' });
                    const ok = removeUserFromOauthClient(clientId, userId);
                    if (!ok) return jsonRes(404, { error: 'User not in allow-list' });
                    // If the user is now off the allow-list (and no LDAP rule grants them
                    // access), kill their live refresh tokens for this client right away.
                    let tokensRevoked = false;
                    if (!isUserAllowedForClient(userId, clientId)) {
                        revokeUserRefreshTokensForClient(userId, clientId);
                        tokensRevoked = true;
                    }
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'oauth_client.user.remove', targetType: 'oauth_client', targetId: clientId, details: { userId, tokensRevoked }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'ok', tokensRevoked });
                }

                // ── OAuth client ↔ LDAP group rules ─────────────────────────────────────

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+\/ldap-groups$/) && req.method === 'GET') {
                    const clientId = decodeURIComponent(url.pathname.split('/')[3]);
                    const client = getOauthClient(clientId);
                    if (!client) return jsonRes(404, { error: 'Client not found' });
                    const groups = listLdapGroupsForOauthClient(clientId);
                    const directories = listLdapConfigs().map(c => ({ id: c.id, name: c.name }));
                    return jsonRes(200, { groups, directories });
                }

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+\/ldap-groups$/) && req.method === 'POST') {
                    const clientId = decodeURIComponent(url.pathname.split('/')[3]);
                    const client = getOauthClient(clientId);
                    if (!client) return jsonRes(404, { error: 'Client not found' });
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const ldapConfigId = Number(body.ldapConfigId);
                    const groupMatch = typeof body.groupMatch === 'string' ? body.groupMatch.trim() : '';
                    if (!ldapConfigId || isNaN(ldapConfigId)) return jsonRes(400, { error: 'ldapConfigId required' });
                    if (!groupMatch) return jsonRes(400, { error: 'groupMatch required (CN short form or full DN)' });
                    if (!getLdapConfig(ldapConfigId)) return jsonRes(400, { error: 'Unknown ldapConfigId' });
                    const rule = addLdapGroupToOauthClient(clientId, ldapConfigId, groupMatch);
                    if (!rule) return jsonRes(409, { error: 'Rule already exists or could not be created' });
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'oauth_client.ldap_group.add', targetType: 'oauth_client', targetId: clientId, details: { ldapConfigId, groupMatch }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(201, { rule });
                }

                if (url.pathname.match(/^\/admin\/oauth-clients\/[^/]+\/ldap-groups\/\d+$/) && req.method === 'DELETE') {
                    const parts = url.pathname.split('/');
                    const clientId = decodeURIComponent(parts[3]);
                    const ruleId = Number(parts[5]);
                    if (!ruleId || isNaN(ruleId)) return jsonRes(400, { error: 'Invalid rule id' });
                    // Capture which directory this rule belonged to before deletion, so we can
                    // recompute access for that directory's shadow users.
                    const ruleBefore = listLdapGroupsForOauthClient(clientId).find(r => r.id === ruleId);
                    const ok = removeLdapGroupFromOauthClient(clientId, ruleId);
                    if (!ok) return jsonRes(404, { error: 'Rule not found' });
                    let revokedUserIds: number[] = [];
                    if (ruleBefore) {
                        revokedUserIds = reconcileShadowAccessAfterRuleChange(clientId, ruleBefore.ldapConfigId);
                    }
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'oauth_client.ldap_group.remove', targetType: 'oauth_client', targetId: clientId, details: { ruleId, ldapConfigId: ruleBefore?.ldapConfigId, groupMatch: ruleBefore?.groupMatch, revokedUserIds }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'ok', revokedUserIds });
                }

                // ── LDAP directories ─────────────────────────────────────────────────────

                if (url.pathname === '/admin/ldap/configs' && req.method === 'GET') {
                    return jsonRes(200, { configs: listLdapConfigs() });
                }

                if (url.pathname === '/admin/ldap/configs' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    try {
                        const cfg = createLdapConfig(body);
                        const me = getAuthedAdmin(req);
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'ldap.config.create', targetType: 'ldap_config', targetId: cfg.id, details: { name: cfg.name, url: cfg.url, scope: cfg.scope }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(201, { config: cfg });
                    } catch (err) {
                        return jsonRes(400, { error: err instanceof Error ? err.message : String(err) });
                    }
                }

                if (url.pathname.match(/^\/admin\/ldap\/configs\/\d+$/) && req.method === 'GET') {
                    const id = Number(url.pathname.split('/').pop());
                    const cfg = getLdapConfig(id);
                    if (!cfg) return jsonRes(404, { error: 'Config not found' });
                    return jsonRes(200, { config: cfg });
                }

                if (url.pathname.match(/^\/admin\/ldap\/configs\/\d+$/) && req.method === 'PUT') {
                    const id = Number(url.pathname.split('/').pop());
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    try {
                        const cfg = updateLdapConfig(id, body);
                        if (!cfg) return jsonRes(404, { error: 'Config not found' });
                        const me = getAuthedAdmin(req);
                        const changedKeys = Object.keys(body).filter(k => k !== 'bindPassword');
                        const passwordChanged = 'bindPassword' in body;
                        logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'ldap.config.update', targetType: 'ldap_config', targetId: id, details: { changed: changedKeys, passwordChanged }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                        return jsonRes(200, { config: cfg });
                    } catch (err) {
                        return jsonRes(400, { error: err instanceof Error ? err.message : String(err) });
                    }
                }

                if (url.pathname.match(/^\/admin\/ldap\/configs\/\d+$/) && req.method === 'DELETE') {
                    const id = Number(url.pathname.split('/').pop());
                    const deleted = deleteLdapConfig(id);
                    if (!deleted) return jsonRes(404, { error: 'Config not found' });
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'ldap.config.delete', targetType: 'ldap_config', targetId: id, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'deleted' });
                }

                if (url.pathname.match(/^\/admin\/ldap\/configs\/\d+\/test$/) && req.method === 'POST') {
                    const id = Number(url.pathname.split('/')[4]);
                    const cfg = getLdapConfig(id);
                    if (!cfg) return jsonRes(404, { error: 'Config not found' });
                    let body: any = {};
                    try { body = await req.json(); } catch { /* body optional */ }
                    const sampleLogin = typeof body?.sampleLogin === 'string' ? body.sampleLogin.trim() : undefined;
                    const outcome = await testLdapConfig(cfg, sampleLogin || undefined);
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'ldap.config.test', targetType: 'ldap_config', targetId: id, details: { ok: outcome.ok, hasSample: !!sampleLogin, durationMs: outcome.durationMs }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, outcome as unknown as Record<string, unknown>);
                }

                if (url.pathname === '/admin/ldap/sync' && req.method === 'GET') {
                    const report = getLastLdapSyncReport();
                    return jsonRes(200, { report });
                }

                if (url.pathname === '/admin/ldap/sync' && req.method === 'POST') {
                    // Fire-and-await — small directories finish fast; large ones may take a while.
                    const report = await runLdapSync();
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'ldap.sync.forced', details: { durationMs: report.durationMs, configs: report.configs.length }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { report } as unknown as Record<string, unknown>);
                }

                // ── LDAP adoption events ─────────────────────────────────────────────────

                if (url.pathname === '/admin/ldap/adoptions' && req.method === 'GET') {
                    const stateParam = url.searchParams.get('state');
                    const state = stateParam === 'pending' || stateParam === 'confirmed' || stateParam === 'reverted'
                        ? stateParam : undefined;
                    return jsonRes(200, {
                        pending: countPendingAdoptions(),
                        events: listAdoptionEvents(state) as unknown as Record<string, unknown>[],
                    });
                }

                if (url.pathname.match(/^\/admin\/ldap\/adoptions\/\d+\/confirm$/) && req.method === 'POST') {
                    const id = Number(url.pathname.split('/')[4]);
                    const me = getAuthedAdmin(req);
                    const ok = confirmAdoption(id, me?.id || 0);
                    if (!ok) return jsonRes(404, { error: 'Adoption event not found or already resolved' });
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'ldap.user.adoption_confirmed', targetType: 'adoption_event', targetId: id, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'ok' });
                }

                if (url.pathname.match(/^\/admin\/ldap\/adoptions\/\d+\/revert$/) && req.method === 'POST') {
                    const id = Number(url.pathname.split('/')[4]);
                    const me = getAuthedAdmin(req);
                    const result = revertAdoption(id, me?.id || 0);
                    if (!result.reverted) return jsonRes(404, { error: 'Adoption event not found or already resolved' });
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'ldap.user.adoption_reverted', targetType: 'adoption_event', targetId: id, details: { restoredUserId: result.restoredUserId }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'ok', restoredUserId: result.restoredUserId });
                }

                // ── TCP/UDP Proxy CRUD ───────────────────────────────────────────────────

                if (url.pathname === '/admin/tcpudp' && req.method === 'GET') {
                    const status = getSipServerStatus();
                    const list = config.tcpUdpProfiles.map(p => {
                        const s = status.find(s => s.name === p.name);
                        return {
                            name: p.name,
                            listeners: p.listeners,
                            upstreamHost: p.upstreamHost,
                            upstreamPort: p.upstreamPort,
                            upstreamTransport: p.upstreamTransport,
                            tlsCert: p.tlsCert ?? '',
                            tlsKey: p.tlsKey ?? '',
                            acmeDomain: p.acmeDomain,
                            acmeEmail: p.acmeEmail,
                            acmeStaging: !!p.acmeStaging,
                            allowedIps: p.allowedIps || [],
                            authToken: p.authToken,
                            sipPublicHost: p.sipPublicHost,
                            allowSelfSignedUpstream: !!p.allowSelfSignedUpstream,
                            rtpRelay: !!p.rtpRelay,
                            rtpPortStart: p.rtpPortStart,
                            rtpPortEnd: p.rtpPortEnd,
                            rtpWorkers: p.rtpWorkers,
                            certId: p.certId,
                            logMessages: !!p.logMessages,
                            logMessageBody: !!p.logMessageBody,
                            logNoise: !!p.logNoise,
                            logConnections: !!p.logConnections,
                            running: !!s?.running,
                        };
                    });
                    return jsonRes(200, { tcpUdpProxies: list });
                }

                if (url.pathname.startsWith('/admin/tcpudp/') && url.pathname.split('/').length === 4 && req.method === 'GET') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    const p = config.tcpUdpProfiles.find(p => p.name === name);
                    if (!p) return jsonRes(404, { error: `TCP/UDP profile "${name}" not found` });
                    return jsonRes(200, { tcpUdpProxy: p, running: isSipServerRunning(name) });
                }

                if (url.pathname === '/admin/tcpudp' && req.method === 'POST') {
                    let body: unknown;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON body' }); }

                    const err = validateTcpUdpProfileInput(body);
                    if (err) return jsonRes(400, { error: err });

                    const input = body as Record<string, unknown>;
                    const name = (input.name as string).toLowerCase();
                    const isUpdate = config.tcpUdpProfiles.some(p => p.name === name);
                    const existingProfile = config.tcpUdpProfiles.find(p => p.name === name);

                    // Build listeners with auto-assigned ports
                    const inListeners = (input.listeners as { transport: string }[]);
                    const listeners: import('./core/types').TcpUdpListener[] = [];
                    for (const l of inListeners) {
                        const transport = l.transport as 'tcp' | 'udp' | 'tls';
                        const key = `${name}:${transport}`;
                        const existingPort = existingProfile?.listeners.find(x => x.transport === transport)?.port ?? 0;
                        const port = existingPort > 0
                            ? existingPort
                            : await assignTcpUdpListenerPort(key, config.port, []);
                        listeners.push({ transport, port });
                    }

                    // Release ports for removed listeners
                    if (isUpdate && existingProfile) {
                        for (const oldL of existingProfile.listeners) {
                            if (!listeners.some(l => l.transport === oldL.transport)) {
                                // Port no longer needed — will be freed by port manager on next assignAllPorts
                                // (we don't actively release here to avoid port reuse race)
                            }
                        }
                    }

                    // certId references the central cert store. Legacy tlsCert/acmeDomain
                    // are no longer accepted on new/edited profiles — only certId.
                    const certId = typeof input.certId === 'number' ? input.certId : undefined;
                    if (listeners.some(l => l.transport === 'tls') && !certId) {
                        return jsonRes(400, { error: 'TLS listener requires "certId" — create or pick a certificate in Settings → Certificates first' });
                    }
                    if (certId && !getCert(certId)) {
                        return jsonRes(400, { error: `certId ${certId} not found in certificate store` });
                    }

                    const profile: import('./core/types').TcpUdpProfile = {
                        name,
                        listeners,
                        upstreamHost: input.upstreamHost as string,
                        upstreamPort: (input.upstreamPort as number) ?? 5060,
                        upstreamTransport: ((input.upstreamTransport as string) ?? 'udp') as 'tcp' | 'udp',
                        certId,
                        allowedIps: Array.isArray(input.allowedIps) ? input.allowedIps as string[] : undefined,
                        authToken: input.authToken as string | undefined,
                        sipPublicHost: input.sipPublicHost as string | undefined,
                        allowSelfSignedUpstream: input.allowSelfSignedUpstream === true,
                        rtpRelay: input.rtpRelay === true,
                        rtpPortStart: input.rtpPortStart as number | undefined,
                        rtpPortEnd: input.rtpPortEnd as number | undefined,
                        rtpWorkers: input.rtpWorkers as number | undefined,
                        logMessages: input.logMessages === true,
                        logMessageBody: input.logMessageBody === true,
                        logNoise: input.logNoise === true,
                        logConnections: input.logConnections === true,
                    };

                    if (isUpdate) {
                        config.tcpUdpProfiles = config.tcpUdpProfiles.map(p => p.name === name ? profile : p);
                        if (isSipServerRunning(name)) await restartSipServer(name, profile);
                    } else {
                        config.tcpUdpProfiles.push(profile);
                        try { await startSipServer(profile); } catch (e) {
                            console.error(`❌ TCP/UDP "${name}" failed to start:`, e instanceof Error ? e.message : e);
                        }
                    }

                    persistTcpUdpProfiles(config.tcpUdpProfiles);
                    const ports = listeners.map(l => `${l.transport.toUpperCase()}:${l.port}`).join(', ');
                    console.log(`✅ TCP/UDP "${name}" ${isUpdate ? 'updated' : 'created'} [${ports}]`);
                    return jsonRes(200, { status: isUpdate ? 'updated' : 'created', name, listeners });
                }

                if (url.pathname.startsWith('/admin/tcpudp/') && req.method === 'DELETE') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    const idx = config.tcpUdpProfiles.findIndex(p => p.name === name);
                    if (idx === -1) return jsonRes(404, { error: `TCP/UDP profile "${name}" not found` });
                    config.tcpUdpProfiles.splice(idx, 1);
                    await stopSipServer(name);
                    releaseTcpUdpListenerPorts(name);
                    persistTcpUdpProfiles(config.tcpUdpProfiles);
                    console.log(`🗑️  TCP/UDP "${name}" deleted`);
                    return jsonRes(200, { status: 'deleted' });
                }

                if (url.pathname.startsWith('/admin/tcpudp/') && url.pathname.endsWith('/restart') && req.method === 'POST') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    const p = config.tcpUdpProfiles.find(p => p.name === name);
                    if (!p) return jsonRes(404, { error: `TCP/UDP profile "${name}" not found` });
                    await restartSipServer(name, p);
                    return jsonRes(200, { status: 'restarted', name });
                }

                // ── Profile ↔ User Association ──

                // GET /admin/profiles/:name/users — list users assigned to a profile
                if (url.pathname.match(/^\/admin\/profiles\/[^/]+\/users$/) && req.method === 'GET') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    const profile = config.proxyProfiles.find(p => p.name === name);
                    if (!profile) return jsonRes(404, { error: `Profile "${name}" not found` });
                    const users = listProxyUsersForProfile(name);
                    return jsonRes(200, { users });
                }

                // POST /admin/profiles/:name/users — assign user(s) to a profile
                if (url.pathname.match(/^\/admin\/profiles\/[^/]+\/users$/) && req.method === 'POST') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    const profile = config.proxyProfiles.find(p => p.name === name);
                    if (!profile) return jsonRes(404, { error: `Profile "${name}" not found` });

                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const userId = body.userId;
                    if (!userId) return jsonRes(400, { error: 'userId is required' });
                    assignProxyUserToProfile(userId, name);
                    return jsonRes(200, { status: 'assigned' });
                }

                // DELETE /admin/profiles/:name/users/:userId — remove user from profile
                if (url.pathname.match(/^\/admin\/profiles\/[^/]+\/users\/\d+$/) && req.method === 'DELETE') {
                    const parts = url.pathname.split('/');
                    const name = decodeURIComponent(parts[3] || '').toLowerCase();
                    const userId = parseInt(parts[5], 10);
                    removeProxyUserFromProfile(userId, name);
                    return jsonRes(200, { status: 'removed' });
                }

                // ── Profile ↔ LDAP group rules ──

                // GET /admin/profiles/:name/ldap-groups — list rules + available directories
                if (url.pathname.match(/^\/admin\/profiles\/[^/]+\/ldap-groups$/) && req.method === 'GET') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    const profile = config.proxyProfiles.find(p => p.name === name);
                    if (!profile) return jsonRes(404, { error: `Profile "${name}" not found` });
                    if (profile.authMode !== 'login') return jsonRes(400, { error: 'LDAP group rules only apply to profiles with authMode=login' });
                    const groups = listLdapGroupsForProfile(name);
                    const directories = listLdapConfigs().map(c => ({ id: c.id, name: c.name }));
                    return jsonRes(200, { groups, directories });
                }

                // POST /admin/profiles/:name/ldap-groups — add a rule
                if (url.pathname.match(/^\/admin\/profiles\/[^/]+\/ldap-groups$/) && req.method === 'POST') {
                    const name = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
                    const profile = config.proxyProfiles.find(p => p.name === name);
                    if (!profile) return jsonRes(404, { error: `Profile "${name}" not found` });
                    if (profile.authMode !== 'login') return jsonRes(400, { error: 'LDAP group rules only apply to profiles with authMode=login' });
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    const ldapConfigId = Number(body.ldapConfigId);
                    const groupMatch = typeof body.groupMatch === 'string' ? body.groupMatch.trim() : '';
                    if (!ldapConfigId || isNaN(ldapConfigId)) return jsonRes(400, { error: 'ldapConfigId required' });
                    if (!groupMatch) return jsonRes(400, { error: 'groupMatch required (CN short form or full DN)' });
                    if (!getLdapConfig(ldapConfigId)) return jsonRes(400, { error: 'Unknown ldapConfigId' });
                    const rule = addLdapGroupToProfile(name, ldapConfigId, groupMatch);
                    if (!rule) return jsonRes(409, { error: 'Rule already exists or could not be created' });
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'profile.ldap_group.add', targetType: 'profile', targetId: name, details: { ldapConfigId, groupMatch }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(201, { rule });
                }

                // DELETE /admin/profiles/:name/ldap-groups/:ruleId — remove a rule
                if (url.pathname.match(/^\/admin\/profiles\/[^/]+\/ldap-groups\/\d+$/) && req.method === 'DELETE') {
                    const parts = url.pathname.split('/');
                    const name = decodeURIComponent(parts[3] || '').toLowerCase();
                    const ruleId = Number(parts[5]);
                    if (!ruleId || isNaN(ruleId)) return jsonRes(400, { error: 'Invalid rule id' });
                    const ruleBefore = getProfileLdapGroupById(name, ruleId);
                    const ok = removeLdapGroupFromProfile(name, ruleId);
                    if (!ok) return jsonRes(404, { error: 'Rule not found' });
                    const me = getAuthedAdmin(req);
                    logAudit({ actorUserId: me?.id, actorUsername: me?.username, action: 'profile.ldap_group.remove', targetType: 'profile', targetId: name, details: { ruleId, ldapConfigId: ruleBefore?.ldapConfigId, groupMatch: ruleBefore?.groupMatch }, ip: reqClientIp(req), userAgent: req.headers.get('user-agent') });
                    return jsonRes(200, { status: 'ok' });
                }

                // ── Invite Tokens ──
                // GET /admin/invites — list all invite tokens
                if (url.pathname === '/admin/invites' && req.method === 'GET') {
                    return jsonRes(200, { invites: listInviteTokens() });
                }

                // POST /admin/invites — create invite token
                if (url.pathname === '/admin/invites' && req.method === 'POST') {
                    let body: any;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                    // Accept either profileNames[] / oauthClientIds[] (new) or profileName (legacy).
                    let profileNames: string[] = Array.isArray(body.profileNames)
                        ? body.profileNames.map((s: any) => String(s || '').trim().toLowerCase()).filter(Boolean)
                        : [];
                    if (profileNames.length === 0 && body.profileName) {
                        const pn = String(body.profileName).trim().toLowerCase();
                        if (pn) profileNames = [pn];
                    }
                    const oauthClientIds: string[] = Array.isArray(body.oauthClientIds)
                        ? body.oauthClientIds.map((s: any) => String(s || '').trim()).filter(Boolean)
                        : [];
                    for (const pn of profileNames) {
                        if (!config.proxyProfiles.some(p => p.name === pn)) {
                            return jsonRes(404, { error: `Profile "${pn}" not found` });
                        }
                    }
                    for (const cid of oauthClientIds) {
                        if (!getOauthClient(cid)) return jsonRes(404, { error: `OAuth client "${cid}" not found` });
                    }
                    const email = (body.email || '').trim().toLowerCase();
                    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes(400, { error: 'Valid email is required' });
                    const invitedName = (body.invitedName || '').trim().slice(0, 100);
                    if (!invitedName) return jsonRes(400, { error: 'invitedName is required' });
                    const note = (body.note || '').trim().slice(0, 200);
                    const expiresInHours = Math.min(Math.max(parseInt(body.expiresInHours) || 48, 1), 720);
                    if (profileNames.length === 0 && oauthClientIds.length === 0) {
                        return jsonRes(400, { error: 'Select at least one proxy or OAuth client.' });
                    }
                    const invite = createInviteToken(profileNames, oauthClientIds, email, invitedName, note, expiresInHours);
                    const reqHost = req.headers.get('host') || `localhost:${config.port}`;
                    const protocol = req.headers.get('x-forwarded-proto') || 'http';
                    const inviteUrl = `${protocol}://${reqHost}/invite/${invite.token}`;
                    let emailSent: boolean | undefined;
                    let emailError: string | undefined;
                    const resourceNames = getInviteResourceNames(profileNames, oauthClientIds);
                    const primaryProfile = resourceNames[0] || profileNames[0] || '';
                    if (isSmtpConfigured()) {
                        const tpl = renderProxyInviteEmail({ inviteUrl, profileName: primaryProfile, invitedName, note, expiresInHours, resourceNames });
                        const r = await sendMail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
                        emailSent = r.ok;
                        emailError = r.error;
                    }
                    const summary = [
                        profileNames.length ? `${profileNames.length} proxy${profileNames.length === 1 ? '' : 'ies'}` : '',
                        oauthClientIds.length ? `${oauthClientIds.length} OAuth client${oauthClientIds.length === 1 ? '' : 's'}` : '',
                    ].filter(Boolean).join(' + ') || 'no resources';
                    console.log(`✅ Invite for ${summary} to "${email}" created (expires in ${expiresInHours}h, emailSent=${emailSent ?? 'n/a'})`);
                    return jsonRes(200, { invite, inviteUrl, emailSent: emailSent ?? false, emailError: emailError ?? null });
                }

                // POST /admin/invites/:token/resend — resend invite email
                if (url.pathname.match(/^\/admin\/invites\/[^/]+\/resend$/) && req.method === 'POST') {
                    const token = url.pathname.split('/')[3];
                    const invite = getInviteToken(token);
                    if (!invite) return jsonRes(404, { error: 'Invite not found' });
                    if (invite.usedAt) return jsonRes(409, { error: 'Invite already used' });
                    if (new Date(invite.expiresAt) < new Date()) return jsonRes(409, { error: 'Invite expired' });
                    if (!invite.email) return jsonRes(400, { error: 'Invite has no email address' });
                    if (!isSmtpConfigured()) return jsonRes(400, { error: 'SMTP not configured. Configure SMTP in Settings first.' });
                    const reqHost = req.headers.get('host') || `localhost:${config.port}`;
                    const protocol = req.headers.get('x-forwarded-proto') || 'http';
                    const inviteUrl = `${protocol}://${reqHost}/invite/${invite.token}`;
                    const expiresInHours = Math.max(1, Math.round((new Date(invite.expiresAt).getTime() - Date.now()) / 3_600_000));
                    const resourceNames = getInviteResourceNames(invite.profileNames || (invite.profileName ? [invite.profileName] : []), invite.oauthClientIds || []);
                    const tpl = renderProxyInviteEmail({ inviteUrl, profileName: invite.profileName, invitedName: invite.invitedName, note: invite.note, expiresInHours, resourceNames });
                    const r = await sendMail({ to: invite.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
                    if (!r.ok) return jsonRes(502, { error: r.error || 'Failed to send email' });
                    console.log(`✅ Invite resent to "${invite.email}"`);
                    return jsonRes(200, { status: 'sent', emailSent: true });
                }

                // DELETE /admin/invites/:token — revoke invite token
                if (url.pathname.match(/^\/admin\/invites\/[^/]+$/) && req.method === 'DELETE') {
                    const token = url.pathname.split('/')[3];
                    const revoked = revokeInviteToken(token);
                    if (!revoked) return jsonRes(404, { error: 'Invite not found' });
                    return jsonRes(200, { status: 'revoked' });
                }

                const accept = req.headers.get('Accept') || '';
                if (accept.includes('text/html')) {
                    return renderErrorPage(404, 'Not Found', 'Check the <a href="/dashboard" style="color:#0078d4">Dashboard</a>.');
                }
                return jsonRes(404, { error: 'Admin endpoint not found' });
            }

            // Catch unmatched /auth/* paths (e.g. wrong method)
            if (url.pathname.startsWith('/auth/')) {
                return jsonRes(404, { error: 'Not Found' });
            }

            // Admin-only port — no forwarding
            const accept = req.headers.get('Accept') || '';
            if (accept.includes('text/html')) {
                return renderErrorPage(404, 'Not Found', 'This is the Midleman admin server. Visit the <a href="/dashboard" style="color:#0078d4">Dashboard</a> to manage targets and profiles.');
            }
            return jsonRes(404, { error: 'Not Found', message: 'No target configured on this port. Use named targets or set TARGET_URL.' });

        } catch (error) {
            const overhead = (performance.now() - startTime).toFixed(2);

            if (error instanceof UnauthorizedError) {
                const accept = req.headers.get('Accept') || '';
                if (accept.includes('text/html')) {
                    return renderErrorPage(401, 'Unauthorized', 'Provide a valid token.');
                }
                return jsonRes(401, { error: 'Unauthorized', message: 'Valid token required' });
            }

            console.error(`❌ Error (${overhead}ms):`, error);
            return jsonRes(500, { error: 'Internal Server Error', message: error instanceof Error ? error.message : 'Unknown error' });
        } finally {
            activeRequests--;
        }
    },

    error(error) {
        console.error('Server error:', error);
        return jsonRes(500, { error: 'Internal Server Error', message: 'An unexpected error occurred' });
    },
});

console.log(`\n✨ Admin server on http://localhost:${server.port}`);
console.log(`💚 Health check: http://localhost:${server.port}/health`);
console.log(`🖥️  Dashboard: http://localhost:${server.port}/dashboard`);
console.log(`\n⚡ Ready!\n`);

// Start TCP/UDP proxies now that the main HTTP server is listening — required
// for ACME HTTP-01 challenges. Runs fire-and-forget so any single profile's
// upstream/cert problems cannot delay or block the rest of the platform.
startAllTcpUdpProxies();

// Same reason for ACME: the HTTP-01 challenge endpoint must be live before LE
// validates. Each cert's first-issue/renewal runs in background.
startAcmeSchedulers();

// Reconcile NPM state on startup (fire-and-forget). No-op when disabled.
if (isNpmEnabled()) {
    (async () => {
        try {
            const { reconcileAll } = await import('./npm/sync');
            const r = await reconcileAll(config.proxyProfiles);
            console.log(`[npm] startup reconcile: ${r.synced} synced, ${r.failed} failed`);
        } catch (e) {
            console.warn('[npm] startup reconcile error:', e instanceof Error ? e.message : e);
        }
    })();
}

// Graceful shutdown
const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} received — shutting down...`);
    isShuttingDown = true;

    // Stop all proxy, SIP and target servers
    await stopAllProxyServers();
    await stopAllSipServers();
    stopPendingRetryScheduler();
    stopSilenceAlertScheduler();
    await stopAllWebhooks();

    // Wait for main server requests
    const maxWait = 10_000;
    const start = Date.now();
    while (activeRequests > 0 && Date.now() - start < maxWait) {
        console.log(`   ⏳ Waiting for ${activeRequests} active request(s)...`);
        await Bun.sleep(500);
    }

    if (activeRequests > 0) {
        console.warn(`   ⚠️  Forcing shutdown with ${activeRequests} request(s) still active`);
    }

    flushDlqSync(); // persist any pending DLQ changes before exit
    await shutdownTelemetry();
    shutdownRequestLog();
    shutdownSipLog();
    shutdownConnLog();
    shutdownAcme();
    shutdownCertStore();
    shutdownLdap();
    shutdownAuth();

    server.stop();
    jwksServer?.stop();
    console.log('👋 Server stopped.');
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
