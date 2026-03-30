import { loadConfig, reloadEnvFile, loadProxyProfiles, loadProxyTargets } from './core/config';
import { UnauthorizedError, type ProxyProfile, type ProxyTarget } from './core/types';
import { invalidateProfileCache } from './proxy/proxy';
import {
    loadPersistedProfiles, persistProfiles, mergeProfiles, validateProfileInput,
    loadPersistedTargets, persistTargets, mergeTargets, validateTargetInput,
    loadPersistedWebhooks, persistWebhooks, validateWebhookInput
} from './core/store';
import { initTelemetry, shutdownTelemetry, getTelemetryConfig, getMetricsSnapshot } from './telemetry/telemetry';
import { initRequestLog, shutdownRequestLog, queryRequestLogs, getRequestLogDetail, getRequestLogStats, getRequestLogChart } from './telemetry/request-log';
import { startTarget, stopTarget, stopAllTargets, restartTarget, getTargetStatus } from './servers/target-server';
import { startProxyServer, stopProxyServer, stopAllProxyServers, restartProxyServer, getProxyServerStatus, getProxyServerPort } from './servers/proxy-server';
import { loadPortAssignments, assignAllPorts, assignProxyPort, assignTargetPort, assignWebhookPort, releaseProxyPort, releaseTargetPort, releaseWebhookPort, getTargetPort, getWebhookPort } from './servers/port-manager';
import { startWebhookServer, stopAllWebhooks, stopWebhookServer, restartWebhook, getWebhookStatus } from './servers/webhook-server';
import { initAuth, shutdownAuth, hasUsers, createUser, verifyCredentials, generateTotpSecret, verifyTotp, createSession, validateSession, destroySession, checkRateLimit, parseCookies, sessionCookie, clearSessionCookie, createLoginChallenge, consumeLoginChallenge } from './auth/auth';
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

// Merge env targets with persisted targets
const persistedTargets = loadPersistedTargets();
config.proxyTargets = mergeTargets(config.proxyTargets, persistedTargets);

// Load persisted webhooks
config.webhooks = loadPersistedWebhooks();

// Initialize OpenTelemetry
initTelemetry(config.otel);

// Initialize request logging (SQLite)
initRequestLog(config.requestLog);

// Initialize auth
initAuth(config.requestLog.dataDir, config.auth.sessionMaxAge);

// Load port assignments from disk
loadPortAssignments();

// Load templates & assets
const errorTemplate = readFileSync(resolve(import.meta.dir, 'views/error.html'), 'utf-8');
const landingPage = readFileSync(resolve(import.meta.dir, 'views/landing.html'), 'utf-8');
let logoSvg: Uint8Array | null = null;
try {
    logoSvg = new Uint8Array(readFileSync(resolve(import.meta.dir, 'views/logo.png')));
} catch (err) {
    console.warn('⚠️  Logo not found in src/views/logo.png');
}

function renderErrorPage(statusCode: number, title: string, message: string): Response {
    const html = errorTemplate
        .replace(/\{\{STATUS\}\}/g, `${statusCode} — ${title}`)
        .replace(/\{\{STATUS_CODE\}\}/g, String(statusCode))
        .replace(/\{\{STATUS_CLASS\}\}/g, `c${statusCode}`)
        .replace(/\{\{TITLE\}\}/g, title)
        .replace(/\{\{MESSAGE\}\}/g, message);
    return new Response(html, {
        status: statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

console.log(`🚀 Midleman starting...`);
if (config.proxyProfiles.length > 0) {
    console.log(`🔓 Proxy Profiles: ${config.proxyProfiles.map(p => p.name).join(', ')}`);
}
if (config.proxyTargets.length > 0) {
    console.log(`🎯 Named Targets: ${config.proxyTargets.map(t => t.name).join(', ')}`);
}
if (config.webhooks.length > 0) {
    console.log(`📡 Webhooks: ${config.webhooks.map(w => w.name).join(', ')}`);
}

/** Shorthand for JSON responses */
function jsonRes(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
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

// ─── Async startup: assign ports, then start per-profile and per-target servers ─

const portAssignments = await assignAllPorts(
    config.proxyProfiles.map(p => p.name),
    config.proxyTargets.map(t => ({ name: t.name, configuredPort: t.port })),
    config.webhooks.map(w => w.name),
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

for (const target of config.proxyTargets) {
    const assignedPort = portAssignments.targets[target.name];
    const t = { ...target, port: assignedPort };
    try {
        startTarget(t);
    } catch (err) {
        console.error(`❌ Failed to start target "${target.name}":`, err instanceof Error ? err.message : err);
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

// ─── Main HTTP server ───────────────────────────────────────────────────────

const server = Bun.serve({
    port: config.port,
    idleTimeout: 255,

    async fetch(req: Request): Promise<Response> {
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
                const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
                if (!checkRateLimit(clientIp)) return jsonRes(429, { error: 'Too many attempts. Try again in 15 minutes.' });
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const username = (body.username || '').trim();
                const password = body.password || '';
                if (!username || !password) return jsonRes(400, { error: 'Username and password required' });
                const cred = await verifyCredentials(username, password);
                if (!cred) return jsonRes(401, { error: 'Invalid username or password' });
                const challengeToken = createLoginChallenge(cred.user.id, cred.user.username, cred.totpSecret);
                return jsonRes(200, { status: 'ok', challengeToken });
            }

            // Step 2: verify TOTP with challenge token, create session
            if (url.pathname === '/auth/login' && req.method === 'POST') {
                const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const challengeToken = (body.challengeToken || '').trim();
                const totpCode = (body.totpCode || '').trim();
                if (!challengeToken || !totpCode) return jsonRes(400, { error: 'Challenge token and TOTP code required' });
                const challenge = consumeLoginChallenge(challengeToken);
                if (!challenge) return jsonRes(401, { error: 'Session expired. Please start login again.' });
                if (!verifyTotp(challenge.totpSecret, totpCode)) return jsonRes(401, { error: 'Invalid authenticator code' });
                const sid = createSession(challenge.userId, clientIp, req.headers.get('user-agent') || '');
                return new Response(JSON.stringify({ status: 'ok', username: challenge.username }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Set-Cookie': sessionCookie(sid, config.auth.cookieName, config.auth.sessionMaxAge),
                    },
                });
            }

            if (url.pathname === '/auth/logout' && req.method === 'POST') {
                const cookies = parseCookies(req);
                const sessionId = cookies[config.auth.cookieName];
                if (sessionId) destroySession(sessionId);
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
                const otelConfig = getTelemetryConfig();
                return jsonRes(200, {
                    status: 'ok',
                    uptime: Math.floor((Date.now() - startedAt) / 1000),
                    activeRequests,
                    proxyProfiles: config.proxyProfiles.length,
                    proxyTargets: config.proxyTargets.length,
                    webhooks: config.webhooks.length,
                    targets: getTargetStatus(),
                    webhookServers: getWebhookStatus(),
                    telemetry: { enabled: otelConfig.enabled, endpoint: otelConfig.endpoint },
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
                            'GET /admin/targets': 'List all named targets',
                            'GET /admin/targets/:name': 'Get target details',
                            'POST /admin/targets': 'Create or update a target',
                            'DELETE /admin/targets/:name': 'Remove a target',
                            'POST /admin/targets/:name/restart': 'Restart a target server',
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
                        activeTargets: getTargetStatus(),
                    });
                }

                // POST /admin/reload
                if (url.pathname === '/admin/reload' && req.method === 'POST') {
                    reloadEnvFile();
                    const envProfiles = loadProxyProfiles();
                    const persisted = loadPersistedProfiles();
                    config.proxyProfiles = mergeProfiles(envProfiles, persisted);
                    invalidateProfileCache();

                    // Reload targets
                    const envTargets = loadProxyTargets();
                    const persistedTgts = loadPersistedTargets();
                    config.proxyTargets = mergeTargets(envTargets, persistedTgts);

                    // Reload webhooks
                    config.webhooks = loadPersistedWebhooks();

                    // Reassign all ports
                    const newPorts = await assignAllPorts(
                        config.proxyProfiles.map(p => p.name),
                        config.proxyTargets.map(t => ({ name: t.name, configuredPort: t.port })),
                        config.webhooks.map(w => w.name),
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

                    // Restart all target servers
                    await stopAllTargets();
                    for (const target of config.proxyTargets) {
                        const assignedPort = newPorts.targets[target.name];
                        const t = { ...target, port: assignedPort };
                        try { startTarget(t); } catch (err) {
                            console.error(`❌ Failed to restart target "${target.name}":`, err instanceof Error ? err.message : err);
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

                    console.log(`🔄 Reloaded: profiles=[${config.proxyProfiles.map(p => p.name).join(', ')}] targets=[${config.proxyTargets.map(t => t.name).join(', ')}] webhooks=[${config.webhooks.map(w => w.name).join(', ')}]`);
                    return jsonRes(200, {
                        status: 'reloaded',
                        profiles: config.proxyProfiles.map(p => p.name),
                        targets: config.proxyTargets.map(t => t.name),
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

                // ── Target CRUD ──
                if (url.pathname === '/admin/targets' && req.method === 'GET') {
                    const status = getTargetStatus();
                    const targets = config.proxyTargets.map(t => {
                        const s = status.find(s => s.name === t.name);
                        return {
                            name: t.name,
                            targetUrl: t.targetUrl,
                            port: s?.port ?? t.port,
                            forwardPath: t.forwardPath,
                            hasAuth: !!t.authToken,
                            running: s?.running ?? false,
                            active: s?.active ?? 0,
                        };
                    });
                    return jsonRes(200, { targets });
                }

                if (url.pathname.match(/^\/admin\/targets\/[^/]+\/restart$/) && req.method === 'POST') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    const target = config.proxyTargets.find(t => t.name === name);
                    if (!target) return jsonRes(404, { error: `Target "${name}" not found` });
                    try {
                        const portToUse = getTargetPort(name) || target.port;
                        await restartTarget({ ...target, port: portToUse });
                        return jsonRes(200, { status: 'restarted', target: name });
                    } catch (err) {
                        return jsonRes(500, { error: `Failed to restart: ${err instanceof Error ? err.message : err}` });
                    }
                }

                if (url.pathname.startsWith('/admin/targets/') && req.method === 'GET') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Target name required' });
                    const target = config.proxyTargets.find(t => t.name === name);
                    if (!target) return jsonRes(404, { error: `Target "${name}" not found` });
                    const status = getTargetStatus().find(s => s.name === name);
                    return jsonRes(200, {
                        target: {
                            name: target.name,
                            targetUrl: target.targetUrl,
                            port: target.port,
                            authToken: target.authToken || '',
                            forwardPath: target.forwardPath,
                            running: status?.running ?? false,
                            active: status?.active ?? 0,
                        },
                    });
                }

                if (url.pathname === '/admin/targets' && req.method === 'POST') {
                    let body: unknown;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON body' }); }

                    const error = validateTargetInput(body);
                    if (error) return jsonRes(400, { error });

                    const input = body as Record<string, unknown>;
                    const configuredPort = input.port ? parseInt(String(input.port), 10) : 0;
                    const target: ProxyTarget = {
                        name: (input.name as string).toLowerCase(),
                        targetUrl: (input.targetUrl as string).replace(/\/$/, ''),
                        port: configuredPort,
                        forwardPath: input.forwardPath !== false,
                    };
                    if (input.authToken) target.authToken = input.authToken as string;

                    // Assign a port (auto or explicit)
                    const excludePorts = getTargetStatus().filter(s => s.name !== target.name).map(s => s.port).filter(Boolean);
                    const assignedPort = await assignTargetPort(target.name, configuredPort, config.port, excludePorts);
                    const targetWithPort = { ...target, port: assignedPort };

                    // Update or add config entry (store configured port, not assigned)
                    const idx = config.proxyTargets.findIndex(t => t.name === target.name);
                    if (idx >= 0) {
                        config.proxyTargets[idx] = target;
                    } else {
                        config.proxyTargets.push(target);
                    }

                    // Persist
                    persistTargets(config.proxyTargets);

                    // Start/restart the server with the assigned port
                    try {
                        await restartTarget(targetWithPort);
                    } catch (err) {
                        console.error(`⚠️  Target "${target.name}" saved but failed to start:`, err);
                    }

                    const action = idx >= 0 ? 'updated' : 'created';
                    console.log(`✅ Target "${target.name}" ${action} (port ${assignedPort})`);
                    return jsonRes(200, { status: action, target: target.name, port: assignedPort });
                }

                if (url.pathname.startsWith('/admin/targets/') && req.method === 'DELETE') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Target name required' });

                    const idx = config.proxyTargets.findIndex(t => t.name === name);
                    if (idx === -1) return jsonRes(404, { error: `Target "${name}" not found` });

                    config.proxyTargets.splice(idx, 1);
                    persistTargets(config.proxyTargets);
                    await stopTarget(name);
                    releaseTargetPort(name);

                    console.log(`🗑️  Target "${name}" deleted`);
                    return jsonRes(200, { status: 'deleted', target: name });
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

                if (url.pathname.startsWith('/admin/webhooks/') && req.method === 'GET') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Webhook name required' });
                    const webhook = config.webhooks.find(w => w.name === name);
                    if (!webhook) return jsonRes(404, { error: `Webhook "${name}" not found` });
                    const status = getWebhookStatus().find(s => s.name === name);
                    return jsonRes(200, {
                        webhook: {
                            name: webhook.name,
                            targets: webhook.targets,
                            port: webhook.port,
                            authToken: webhook.authToken || '',
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

                    // Assign a port (auto or explicit)
                    const excludePorts = getWebhookStatus().filter(s => s.name !== webhook.name).map(s => s.port).filter(Boolean);
                    const assignedPort = await assignWebhookPort(webhook.name, configuredPort, config.port, excludePorts);
                    const webhookWithPort = { ...webhook, port: assignedPort };

                    // Update or add config entry
                    const idx = config.webhooks.findIndex(w => w.name === webhook.name);
                    if (idx >= 0) {
                        config.webhooks[idx] = webhook;
                    } else {
                        config.webhooks.push(webhook);
                    }

                    persistWebhooks(config.webhooks);

                    // Start/restart the server
                    try {
                        if (idx >= 0) {
                            await restartWebhook(webhookWithPort);
                        } else {
                            startWebhookServer(webhookWithPort);
                        }
                    } catch (err) {
                        console.error(`⚠️  Webhook "${webhook.name}" saved but failed to start:`, err);
                    }

                    const action = idx >= 0 ? 'updated' : 'created';
                    console.log(`✅ Webhook "${webhook.name}" ${action} (port ${assignedPort})`);
                    return jsonRes(200, { status: action, webhook: webhook.name, port: assignedPort });
                }

                if (url.pathname.startsWith('/admin/webhooks/') && req.method === 'DELETE') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Webhook name required' });

                    const idx = config.webhooks.findIndex(w => w.name === name);
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
                if (url.pathname.startsWith('/admin/profiles/') && req.method === 'GET') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
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
                            blockedExtensions: profile.blockedExtensions ? Array.from(profile.blockedExtensions) : [],
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
                        blockedExtensions: p.blockedExtensions ? Array.from(p.blockedExtensions) : [],
                        port: getProxyServerPort(p.name),
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
                    if (input.blockedExtensions) {
                        profile.blockedExtensions = new Set(
                            (input.blockedExtensions as string[]).map(e => e.trim().toLowerCase().replace(/^\.?/, '.'))
                        );
                    }

                    const idx = config.proxyProfiles.findIndex(p => p.name === profile.name);
                    if (idx >= 0) config.proxyProfiles[idx] = profile;
                    else config.proxyProfiles.push(profile);

                    persistProfiles(config.proxyProfiles);
                    invalidateProfileCache();

                    // Assign port and start/restart the proxy server
                    const excludePorts = getProxyServerStatus().filter(s => s.name !== profile.name).map(s => s.port).filter(Boolean);
                    const proxyPort = await assignProxyPort(profile.name, config.port, excludePorts);
                    if (idx >= 0) {
                        await restartProxyServer(profile.name, profile, proxyPort);
                    } else {
                        startProxyServer(profile, proxyPort);
                    }

                    const action = idx >= 0 ? 'updated' : 'created';
                    console.log(`✅ Profile "${profile.name}" ${action} (port ${proxyPort})`);
                    return jsonRes(200, { status: action, profile: profile.name, port: proxyPort });
                }

                if (url.pathname.startsWith('/admin/profiles/') && req.method === 'DELETE') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Profile name required' });
                    const idx = config.proxyProfiles.findIndex(p => p.name === name);
                    if (idx === -1) return jsonRes(404, { error: `Profile "${name}" not found` });
                    config.proxyProfiles.splice(idx, 1);
                    persistProfiles(config.proxyProfiles);
                    invalidateProfileCache();
                    await stopProxyServer(name);
                    releaseProxyPort(name);
                    console.log(`🗑️  Profile "${name}" deleted`);
                    return jsonRes(200, { status: 'deleted', profile: name });
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

// Graceful shutdown
const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} received — shutting down...`);
    isShuttingDown = true;

    // Stop all proxy and target servers
    await stopAllProxyServers();
    await stopAllTargets();
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

    await shutdownTelemetry();
    shutdownRequestLog();
    shutdownAuth();

    server.stop();
    console.log('👋 Server stopped.');
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
