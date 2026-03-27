import { loadConfig, reloadEnvFile, loadProxyProfiles, loadProxyTargets } from './config';
import { UnauthorizedError, type ProxyProfile, type ProxyTarget } from './types';
import { handleProxyRequest, invalidateProfileCache } from './proxy';
import { loadPersistedProfiles, persistProfiles, mergeProfiles, validateProfileInput,
         loadPersistedTargets, persistTargets, mergeTargets, validateTargetInput } from './store';
import { initTelemetry, shutdownTelemetry, startTargetSpan, endTargetSpan, getTelemetryConfig, getMetricsSnapshot } from './telemetry';
import { initRequestLog, shutdownRequestLog, logRequest, captureRequestBody, captureResponseBody, headersToRecord, queryRequestLogs, getRequestLogDetail, getRequestLogStats } from './request-log';
import { startTarget, stopTarget, stopAllTargets, restartTarget, getTargetStatus } from './target-server';
import { initAuth, shutdownAuth, hasUsers, createUser, verifyCredentials, generateTotpSecret, verifyTotp, createSession, validateSession, destroySession, checkRateLimit, parseCookies, sessionCookie, clearSessionCookie } from './auth';
import { readFileSync, writeFileSync } from 'fs';
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

// Initialize OpenTelemetry
initTelemetry(config.otel);

// Initialize request logging (SQLite)
initRequestLog(config.requestLog);

// Initialize auth
initAuth(config.requestLog.dataDir, config.auth.sessionMaxAge);

// Load templates & assets
const errorTemplate = readFileSync(resolve(import.meta.dir, 'error.html'), 'utf-8');
const landingPage = readFileSync(resolve(import.meta.dir, 'landing.html'), 'utf-8');
let logoSvg: Uint8Array | null = null;
try {
    logoSvg = new Uint8Array(readFileSync(resolve(import.meta.dir, 'logo.svg')));
} catch (err) {
    console.warn('⚠️  Logo not found in src/logo.svg');
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

// Determine if we're in multi-target mode or legacy single-target mode
const hasNamedTargets = config.proxyTargets.length > 0;
const hasLegacyTarget = !!config.targetUrl;

console.log(`🚀 Bun-Forwarder starting...`);
if (hasLegacyTarget) {
    console.log(`📌 Target URL: ${config.targetUrl}`);
    console.log(`🔀 Forward Path: ${config.forwardPath ? 'Enabled' : 'DISABLED (Fixed URL mode)'}`);
}
console.log(`🔐 Authentication: ${config.authToken ? 'Enabled' : 'DISABLED ⚠️'}`);
if (config.proxyProfiles.length > 0) {
    console.log(`🔓 Proxy Profiles: ${config.proxyProfiles.map(p => p.name).join(', ')}`);
}
if (hasNamedTargets) {
    console.log(`🎯 Named Targets: ${config.proxyTargets.map(t => `${t.name}(:${t.port})`).join(', ')}`);
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

// ─── Start named target servers ─────────────────────────────────────────────

for (const target of config.proxyTargets) {
    try {
        startTarget(target);
    } catch (err) {
        console.error(`❌ Failed to start target "${target.name}":`, err instanceof Error ? err.message : err);
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
            if (url.pathname === '/logo.svg' || url.pathname === '/favicon.ico' || url.pathname === '/favicon.png') {
                if (logoSvg) {
                    return new Response(logoSvg, {
                        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=31536000' }
                    });
                }
                return new Response(null, { status: 204 });
            }

            // Landing page
            if (url.pathname === '/' && !req.headers.get('X-Forward-Token') && !url.searchParams.get('token')) {
                const accept = req.headers.get('Accept') || '';
                if (accept.includes('text/html')) {
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
                return jsonRes(200, { needsSetup: !hasUsers(), loggedIn: !!session, username: session?.user?.username || null });
            }

            if (url.pathname === '/auth/setup' && req.method === 'POST') {
                if (hasUsers()) return jsonRes(403, { error: 'Setup already completed' });
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const username = (body.username || '').trim();
                if (!username || username.length < 2) return jsonRes(400, { error: 'Username must be at least 2 characters' });
                const totp = generateTotpSecret(username);
                return jsonRes(200, { secret: totp.secret, otpauthUrl: totp.otpauthUrl });
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

            if (url.pathname === '/auth/login' && req.method === 'POST') {
                const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
                if (!checkRateLimit(clientIp)) return jsonRes(429, { error: 'Too many attempts. Try again in 15 minutes.' });
                let body: any;
                try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
                const username = (body.username || '').trim();
                const password = body.password || '';
                const totpCode = (body.totpCode || '').trim();
                if (!username || !password || !totpCode) return jsonRes(400, { error: 'Username, password, and TOTP code required' });
                const cred = await verifyCredentials(username, password);
                if (!cred) return jsonRes(401, { error: 'Invalid username or password' });
                if (!verifyTotp(cred.totpSecret, totpCode)) return jsonRes(401, { error: 'Invalid TOTP code' });
                const sid = createSession(cred.user.id, clientIp, req.headers.get('user-agent') || '');
                return new Response(JSON.stringify({ status: 'ok', username: cred.user.username }), {
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
                    targets: getTargetStatus(),
                    telemetry: { enabled: otelConfig.enabled, endpoint: otelConfig.endpoint },
                });
            }

            // Dashboard
            if (url.pathname === '/dashboard' || url.pathname === '/dashboard/') {
                const htmlPath = resolve(import.meta.dir, 'dashboard.html');
                const html = readFileSync(htmlPath, 'utf-8');
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
                            'PUT /admin/config': 'Update .env configuration',
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

                    // Restart all target servers
                    await stopAllTargets();
                    for (const target of config.proxyTargets) {
                        try { startTarget(target); } catch (err) {
                            console.error(`❌ Failed to restart target "${target.name}":`, err instanceof Error ? err.message : err);
                        }
                    }

                    console.log(`🔄 Reloaded: profiles=[${config.proxyProfiles.map(p => p.name).join(', ')}] targets=[${config.proxyTargets.map(t => t.name).join(', ')}]`);
                    return jsonRes(200, {
                        status: 'reloaded',
                        profiles: config.proxyProfiles.map(p => p.name),
                        targets: config.proxyTargets.map(t => t.name),
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
                        type: (url.searchParams.get('type') as 'target' | 'proxy') || undefined,
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
                            port: t.port,
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
                        await restartTarget(target);
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
                    const target: ProxyTarget = {
                        name: (input.name as string).toLowerCase(),
                        targetUrl: (input.targetUrl as string).replace(/\/$/, ''),
                        port: input.port as number,
                        forwardPath: input.forwardPath !== false,
                    };
                    if (input.authToken) target.authToken = input.authToken as string;

                    // Check port conflicts
                    if (target.port === config.port) {
                        return jsonRes(400, { error: `Port ${target.port} is used by the main admin server` });
                    }
                    const portConflict = config.proxyTargets.find(t => t.port === target.port && t.name !== target.name);
                    if (portConflict) {
                        return jsonRes(400, { error: `Port ${target.port} is already used by target "${portConflict.name}"` });
                    }

                    // Update or add
                    const idx = config.proxyTargets.findIndex(t => t.name === target.name);
                    if (idx >= 0) {
                        config.proxyTargets[idx] = target;
                    } else {
                        config.proxyTargets.push(target);
                    }

                    // Persist
                    persistTargets(config.proxyTargets);

                    // Start/restart the server
                    try {
                        await restartTarget(target);
                    } catch (err) {
                        console.error(`⚠️  Target "${target.name}" saved but failed to start:`, err);
                    }

                    const action = idx >= 0 ? 'updated' : 'created';
                    console.log(`✅ Target "${target.name}" ${action} (port ${target.port})`);
                    return jsonRes(200, { status: action, target: target.name });
                }

                if (url.pathname.startsWith('/admin/targets/') && req.method === 'DELETE') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Target name required' });

                    const idx = config.proxyTargets.findIndex(t => t.name === name);
                    if (idx === -1) return jsonRes(404, { error: `Target "${name}" not found` });

                    config.proxyTargets.splice(idx, 1);
                    persistTargets(config.proxyTargets);
                    await stopTarget(name);

                    console.log(`🗑️  Target "${name}" deleted`);
                    return jsonRes(200, { status: 'deleted', target: name });
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

                if (url.pathname === '/admin/config' && req.method === 'PUT') {
                    let body: unknown;
                    try { body = await req.json(); } catch { return jsonRes(400, { error: 'Invalid JSON body' }); }

                    const input = body as Record<string, unknown>;
                    const envPath = resolve(process.cwd(), '.env');

                    try {
                        let envContent = '';
                        try { envContent = readFileSync(envPath, 'utf-8'); } catch {}

                        const lines = envContent.split('\n');
                        const coreKeys = new Map<string, string>();
                        if (input.port !== undefined) coreKeys.set('PORT', String(input.port));
                        if (input.targetUrl !== undefined) coreKeys.set('TARGET_URL', String(input.targetUrl));
                        if (input.authToken !== undefined) coreKeys.set('AUTH_TOKEN', String(input.authToken));
                        if (input.forwardPath !== undefined) coreKeys.set('FORWARD_PATH', String(input.forwardPath));

                        const updatedKeys = new Set<string>();
                        const newLines = lines.map(line => {
                            const trimmed = line.trim();
                            if (!trimmed || trimmed.startsWith('#')) return line;
                            const eqIdx = trimmed.indexOf('=');
                            if (eqIdx === -1) return line;
                            const key = trimmed.substring(0, eqIdx).trim();
                            if (coreKeys.has(key)) {
                                updatedKeys.add(key);
                                return `${key}=${coreKeys.get(key)}`;
                            }
                            return line;
                        });

                        for (const [key, value] of coreKeys) {
                            if (!updatedKeys.has(key)) newLines.unshift(`${key}=${value}`);
                        }

                        writeFileSync(envPath, newLines.join('\n'), 'utf-8');
                        console.log('✅ .env file updated via dashboard');

                        return jsonRes(200, {
                            status: 'saved',
                            message: 'Configuration saved. Restart to apply core changes.',
                        });
                    } catch (err) {
                        return jsonRes(500, { error: 'Failed to write .env: ' + (err instanceof Error ? err.message : String(err)) });
                    }
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

                    const action = idx >= 0 ? 'updated' : 'created';
                    console.log(`✅ Profile "${profile.name}" ${action}`);
                    return jsonRes(200, { status: action, profile: profile.name });
                }

                if (url.pathname.startsWith('/admin/profiles/') && req.method === 'DELETE') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Profile name required' });
                    const idx = config.proxyProfiles.findIndex(p => p.name === name);
                    if (idx === -1) return jsonRes(404, { error: `Profile "${name}" not found` });
                    config.proxyProfiles.splice(idx, 1);
                    persistProfiles(config.proxyProfiles);
                    invalidateProfileCache();
                    console.log(`🗑️  Profile "${name}" deleted`);
                    return jsonRes(200, { status: 'deleted', profile: name });
                }

                const accept = req.headers.get('Accept') || '';
                if (accept.includes('text/html')) {
                    return renderErrorPage(404, 'Not Found', 'Check the <a href="/dashboard" style="color:#6c5ce7">Dashboard</a>.');
                }
                return jsonRes(404, { error: 'Admin endpoint not found' });
            }

            // Handle proxy bypass requests
            if (url.pathname.startsWith('/proxy/')) {
                if (config.proxyProfiles.length === 0) {
                    const accept = req.headers.get('Accept') || '';
                    if (accept.includes('text/html')) {
                        return renderErrorPage(404, 'Not Found', 'No proxy profiles configured. Visit the <a href="/dashboard" style="color:#6c5ce7">Dashboard</a>.');
                    }
                    return jsonRes(404, { error: 'Not Found', message: 'No proxy profiles configured' });
                }
                return handleProxyRequest(req, url, config.proxyProfiles, startTime);
            }

            // ─── Legacy single-target forwarding ────────────────────────────
            // Only active if TARGET_URL is set AND no named targets are defined
            if (hasLegacyTarget) {
                // Auth check
                if (config.authToken) {
                    const authHeader = req.headers.get('X-Forward-Token');
                    const authQuery = url.searchParams.get('token');
                    const providedToken = authHeader || authQuery;

                    if (providedToken !== config.authToken) {
                        console.warn(`❌ Unauthorized ${req.method} ${url.pathname}`);
                        const accept = req.headers.get('Accept') || '';
                        if (accept.includes('text/html')) {
                            return renderErrorPage(401, 'Unauthorized', 'Provide a valid token via <strong>X-Forward-Token</strong> header or <strong>?token=</strong>.');
                        }
                        return jsonRes(401, { error: 'Unauthorized', message: 'Valid token required' });
                    }
                    url.searchParams.delete('token');
                }

                const pathWithQuery = url.pathname + url.search;
                let targetUrl: string;

                if (config.forwardPath) {
                    targetUrl = config.targetUrl + pathWithQuery;
                } else {
                    targetUrl = config.targetUrl;
                    if (!url.searchParams.has('original_url')) {
                        const separator = config.targetUrl.includes('?') ? '&' : '?';
                        targetUrl += `${separator}original_url=${encodeURIComponent(pathWithQuery)}`;
                    }
                }

                const forwardHeaders = new Headers();
                req.headers.forEach((value, key) => {
                    if (key.toLowerCase() !== 'host') forwardHeaders.set(key, value);
                });
                forwardHeaders.delete('X-Forward-Token');
                forwardHeaders.set('X-Request-ID', requestId);
                if (!config.forwardPath) forwardHeaders.set('X-Original-URL', pathWithQuery);

                const reqCapture = await captureRequestBody(req);

                const otelSpan = startTargetSpan({
                    method: req.method,
                    path: pathWithQuery,
                    targetUrl,
                    requestId,
                });

                const forwardBody = reqCapture.body && req.method !== 'GET' && req.method !== 'HEAD'
                    ? reqCapture.body : req.body;

                let targetResponse: Response;

                try {
                    targetResponse = await fetch(targetUrl, {
                        method: req.method,
                        headers: forwardHeaders,
                        body: forwardBody,
                    });
                } catch (fetchError) {
                    const durationMs = performance.now() - startTime;
                    console.error(`❌ Failed to connect to target (${durationMs.toFixed(2)}ms):`, fetchError);
                    endTargetSpan(otelSpan, 502, durationMs,
                        fetchError instanceof Error ? fetchError : new Error(String(fetchError)));

                    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
                    logRequest({
                        requestId, type: 'target', targetName: 'default', method: req.method, path: pathWithQuery, targetUrl, clientIp,
                        reqHeaders: headersToRecord(forwardHeaders), reqBody: reqCapture.body, reqBodySize: reqCapture.size,
                        resStatus: 502, resStatusText: 'Bad Gateway', durationMs,
                        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
                    });

                    return jsonRes(502, {
                        error: 'Failed to connect to target server',
                        message: fetchError instanceof Error ? fetchError.message : 'Unknown error',
                        target: targetUrl,
                    });
                }

                const resCapture = await captureResponseBody(targetResponse);
                const responseHeaders = new Headers(targetResponse.headers);
                responseHeaders.delete('content-encoding');
                responseHeaders.delete('Content-Encoding');
                responseHeaders.delete('content-length');
                responseHeaders.delete('Content-Length');
                responseHeaders.set('Connection', 'close');
                responseHeaders.set('X-Request-ID', requestId);

                const durationMs = performance.now() - startTime;
                const statusEmoji = targetResponse.status < 400 ? '✅' : '⚠️';
                console.log(`${statusEmoji} ${req.method} ${pathWithQuery} → ${targetResponse.status} ${targetResponse.statusText} (${durationMs.toFixed(2)}ms)`);

                endTargetSpan(otelSpan, targetResponse.status, durationMs);

                const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
                logRequest({
                    requestId, type: 'target', targetName: 'default', method: req.method, path: pathWithQuery, targetUrl, clientIp,
                    reqHeaders: headersToRecord(forwardHeaders), reqBody: reqCapture.body, reqBodySize: reqCapture.size,
                    resStatus: targetResponse.status, resStatusText: targetResponse.statusText,
                    resHeaders: headersToRecord(responseHeaders), resBody: resCapture.body, resBodySize: resCapture.size,
                    durationMs,
                });

                return new Response(resCapture.body, {
                    status: targetResponse.status,
                    statusText: targetResponse.statusText,
                    headers: responseHeaders,
                });
            }

            // No target to forward to — return helpful message
            const accept = req.headers.get('Accept') || '';
            if (accept.includes('text/html')) {
                return renderErrorPage(404, 'Not Found', 'This is the Midleman admin server. Visit the <a href="/dashboard" style="color:#6c5ce7">Dashboard</a> to manage targets and profiles.');
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
if (hasLegacyTarget) {
    console.log(`📡 Forwarding to: ${config.targetUrl}`);
}
console.log(`💚 Health check: http://localhost:${server.port}/health`);
console.log(`🖥️  Dashboard: http://localhost:${server.port}/dashboard`);
console.log(`\n⚡ Ready!\n`);

// Graceful shutdown
const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} received — shutting down...`);
    isShuttingDown = true;

    // Stop all named target servers
    await stopAllTargets();

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
