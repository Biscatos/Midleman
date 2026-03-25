import { loadConfig, reloadEnvFile, loadProxyProfiles } from './config';
import { UnauthorizedError, type ProxyProfile } from './types';
import { handleProxyRequest, invalidateProfileCache } from './proxy';
import { loadPersistedProfiles, persistProfiles, mergeProfiles, validateProfileInput } from './store';
import { initTelemetry, shutdownTelemetry, startTargetSpan, endTargetSpan, getTelemetryConfig, getMetricsSnapshot } from './telemetry';
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

// Initialize OpenTelemetry
initTelemetry(config.otel);

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

console.log(`🚀 Bun-Forwarder starting...`);
console.log(`📌 Target URL: ${config.targetUrl}`);
console.log(`🔐 Authentication: ${config.authToken ? 'Enabled' : 'DISABLED ⚠️'}`);
console.log(`🔀 Forward Path: ${config.forwardPath ? 'Enabled' : 'DISABLED (Fixed URL mode)'}`);
if (config.proxyProfiles.length > 0) {
    console.log(`🔓 Proxy Profiles: ${config.proxyProfiles.map(p => p.name).join(', ')}`);
} else {
    console.log(`🔓 Proxy Profiles: None configured`);
}

/** Shorthand for JSON responses */
function jsonRes(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Validates admin auth token. Returns error Response or null if authorized.
 */
function checkAdminAuth(req: Request, url: URL): Response | null {
    if (!config.authToken) return null;
    const token = req.headers.get('X-Forward-Token') || url.searchParams.get('token');
    if (token === config.authToken) return null;
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Main HTTP server using Bun.serve
 */
const server = Bun.serve({
    port: config.port,
    idleTimeout: 255, // Maximum allowed by Bun (4.25 minutes)

    async fetch(req: Request): Promise<Response> {
        // Reject new requests during shutdown
        if (isShuttingDown) {
            return new Response(JSON.stringify({ error: 'Service Unavailable', message: 'Server is shutting down' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        activeRequests++;
        const startTime = performance.now();

        // Generate or propagate request ID for distributed tracing
        const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();

        try {
            // Parse incoming request URL
            const url = new URL(req.url);

            // Serve logo/favicon requests
            if (url.pathname === '/logo.svg' || url.pathname === '/favicon.ico' || url.pathname === '/favicon.png') {
                if (logoSvg) {
                    return new Response(logoSvg, {
                        headers: { 
                            'Content-Type': 'image/svg+xml',
                            'Cache-Control': 'public, max-age=31536000'
                        }
                    });
                }
                return new Response(null, { status: 204 });
            }

            // Landing page — only for browsers without auth token
            if (url.pathname === '/' && !req.headers.get('X-Forward-Token') && !url.searchParams.get('token')) {
                const accept = req.headers.get('Accept') || '';
                if (accept.includes('text/html')) {
                    return new Response(landingPage, {
                        status: 200,
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    });
                }
            }

            // Health check endpoint for load balancers / k8s
            if (url.pathname === '/health') {
                const otelConfig = getTelemetryConfig();
                return new Response(JSON.stringify({
                    status: 'ok',
                    uptime: Math.floor((Date.now() - startedAt) / 1000),
                    activeRequests,
                    proxyProfiles: config.proxyProfiles.length,
                    telemetry: { enabled: otelConfig.enabled, endpoint: otelConfig.endpoint },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // ===== Dashboard =====
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

                // GET /admin or /admin/ — API Discovery & Status
                if ((url.pathname === '/admin' || url.pathname === '/admin/') && req.method === 'GET') {
                    return jsonRes(200, {
                        status: 'Bun-Forwarder Admin API',
                        version: '1.0.0',
                        endpoints: {
                            'GET /dashboard': 'Web dashboard for managing the server',
                            'GET /admin/config': 'Get current configuration',
                            'PUT /admin/config': 'Update .env configuration',
                            'GET /admin/profiles': 'List all active profiles',
                            'GET /admin/profiles/:name': 'Get full profile details',
                            'POST /admin/profiles': 'Create or update a profile',
                            'DELETE /admin/profiles/:name': 'Remove a profile',
                            'POST /admin/reload': 'Reload .env and profiles.json',
                            'GET /admin/telemetry': 'Live telemetry data (target + per-profile)',
                            'GET /health': 'System health check'
                        },
                        config: {
                            targetUrl: config.targetUrl,
                            forwardPath: config.forwardPath,
                            authEnabled: !!config.authToken,
                        },
                        telemetry: getTelemetryConfig(),
                        activeProfiles: config.proxyProfiles.length
                    });
                }

                // POST /admin/reload — re-read .env + persisted JSON
                if (url.pathname === '/admin/reload' && req.method === 'POST') {
                    reloadEnvFile();
                    const envProfiles = loadProxyProfiles();
                    const persisted = loadPersistedProfiles();
                    config.proxyProfiles = mergeProfiles(envProfiles, persisted);
                    invalidateProfileCache();

                    const names = config.proxyProfiles.map(p => p.name);
                    console.log(`🔄 Profiles reloaded: ${names.join(', ') || 'none'}`);
                    return jsonRes(200, { status: 'reloaded', profiles: names });
                }

                // GET /admin/telemetry — return in-memory telemetry data
                if (url.pathname === '/admin/telemetry' && req.method === 'GET') {
                    return jsonRes(200, getMetricsSnapshot() as unknown as Record<string, unknown>);
                }

                // GET /admin/config — return current configuration
                if (url.pathname === '/admin/config' && req.method === 'GET') {
                    return jsonRes(200, {
                        port: config.port,
                        targetUrl: config.targetUrl,
                        authToken: config.authToken || '',
                        forwardPath: config.forwardPath,
                    });
                }

                // PUT /admin/config — update .env file
                if (url.pathname === '/admin/config' && req.method === 'PUT') {
                    let body: unknown;
                    try {
                        body = await req.json();
                    } catch {
                        return jsonRes(400, { error: 'Invalid JSON body' });
                    }

                    const input = body as Record<string, unknown>;
                    const envPath = resolve(process.cwd(), '.env');

                    try {
                        // Read current .env to preserve comments and proxy settings
                        let envContent = '';
                        try {
                            envContent = readFileSync(envPath, 'utf-8');
                        } catch {}

                        // Parse existing lines, update core values
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

                        // Add any keys that weren't found in the file
                        for (const [key, value] of coreKeys) {
                            if (!updatedKeys.has(key)) {
                                newLines.unshift(`${key}=${value}`);
                            }
                        }

                        writeFileSync(envPath, newLines.join('\n'), 'utf-8');
                        console.log('✅ .env file updated via dashboard');

                        return jsonRes(200, {
                            status: 'saved',
                            message: 'Configuration saved to .env. Restart the server to apply core changes.',
                        });
                    } catch (err) {
                        return jsonRes(500, { error: 'Failed to write .env: ' + (err instanceof Error ? err.message : String(err)) });
                    }
                }

                // GET /admin/profiles/:name — return full profile data (for editing)
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

                // GET /admin/profiles — list all active profiles (keys masked)
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

                // POST /admin/profiles — create or update a profile (persisted)
                if (url.pathname === '/admin/profiles' && req.method === 'POST') {
                    let body: unknown;
                    try {
                        body = await req.json();
                    } catch {
                        return jsonRes(400, { error: 'Invalid JSON body' });
                    }

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

                    // Update or add
                    const idx = config.proxyProfiles.findIndex(p => p.name === profile.name);
                    if (idx >= 0) {
                        config.proxyProfiles[idx] = profile;
                    } else {
                        config.proxyProfiles.push(profile);
                    }

                    // Persist and invalidate cache
                    persistProfiles(config.proxyProfiles);
                    invalidateProfileCache();

                    const action = idx >= 0 ? 'updated' : 'created';
                    console.log(`✅ Profile "${profile.name}" ${action} (persisted)`);
                    return jsonRes(200, { status: action, profile: profile.name });
                }

                // DELETE /admin/profiles/:name — remove a profile (persisted)
                if (url.pathname.startsWith('/admin/profiles/') && req.method === 'DELETE') {
                    const name = url.pathname.split('/')[3]?.toLowerCase();
                    if (!name) return jsonRes(400, { error: 'Profile name required' });

                    const idx = config.proxyProfiles.findIndex(p => p.name === name);
                    if (idx === -1) return jsonRes(404, { error: `Profile "${name}" not found` });

                    config.proxyProfiles.splice(idx, 1);
                    persistProfiles(config.proxyProfiles);
                    invalidateProfileCache();

                    console.log(`🗑️  Profile "${name}" deleted (persisted)`);
                    return jsonRes(200, { status: 'deleted', profile: name });
                }

                const accept = req.headers.get('Accept') || '';
                if (accept.includes('text/html')) {
                    return renderErrorPage(404, 'Not Found', 'The admin endpoint you requested does not exist. Check the <a href="/dashboard" style="color:#6c5ce7">Dashboard</a> for available options.');
                }
                return jsonRes(404, { error: 'Admin endpoint not found' });
            }

            // Handle proxy bypass requests (before auth validation)
            if (url.pathname.startsWith('/proxy/')) {
                if (config.proxyProfiles.length === 0) {
                    const accept = req.headers.get('Accept') || '';
                    if (accept.includes('text/html')) {
                        return renderErrorPage(404, 'Not Found', 'No proxy profiles are configured yet. Visit the <a href="/dashboard" style="color:#6c5ce7">Dashboard</a> to create one.');
                    }
                    return new Response(JSON.stringify({
                        error: 'Not Found',
                        message: 'No proxy profiles configured'
                    }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return handleProxyRequest(req, url, config.proxyProfiles, startTime);
            }

            // Security: Validate authentication token (only if configured)
            // Support both header and query parameter authentication
            if (config.authToken) {
                const authHeader = req.headers.get('X-Forward-Token');
                const authQuery = url.searchParams.get('token');

                // Use header if provided, otherwise use query parameter
                const providedToken = authHeader || authQuery;

                if (providedToken !== config.authToken) {
                    console.warn(`❌ Unauthorized ${req.method} ${url.pathname} from ${req.headers.get('X-Forwarded-For') || 'unknown'}`);
                    const accept = req.headers.get('Accept') || '';
                    if (accept.includes('text/html')) {
                        return renderErrorPage(401, 'Unauthorized', 'Authentication is required to access this resource. Provide a valid token via the <strong>X-Forward-Token</strong> header or <strong>?token=</strong> query parameter.');
                    }
                    return new Response(JSON.stringify({
                        error: 'Unauthorized',
                        message: 'Valid X-Forward-Token header or ?token=xxx query parameter is required'
                    }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                // Remove token from query parameters before forwarding
                url.searchParams.delete('token');
            }

            const pathWithQuery = url.pathname + url.search;

            // Construct target URL based on forwardPath setting
            let targetUrl: string;

            if (config.forwardPath) {
                // Default behavior: append path and query to target
                targetUrl = config.targetUrl + pathWithQuery;
            } else {
                // Fixed URL mode: always use TARGET_URL as-is
                targetUrl = config.targetUrl;

                // Preserve original URL in query parameter if not already present
                if (!url.searchParams.has('original_url')) {
                    const separator = config.targetUrl.includes('?') ? '&' : '?';
                    targetUrl += `${separator}original_url=${encodeURIComponent(pathWithQuery)}`;
                }
            }

            // Prepare headers (exclude Host as it's auto-handled by fetch)
            const forwardHeaders = new Headers();
            req.headers.forEach((value, key) => {
                if (key.toLowerCase() !== 'host') {
                    forwardHeaders.set(key, value);
                }
            });

            // Remove the authentication header before forwarding
            forwardHeaders.delete('X-Forward-Token');

            // Propagate request ID for distributed tracing
            forwardHeaders.set('X-Request-ID', requestId);

            // If not forwarding path, add original URL as custom header
            if (!config.forwardPath) {
                forwardHeaders.set('X-Original-URL', pathWithQuery);
            }

            // Forward the request to target
            // Use req.body directly to avoid blocking on arrayBuffer()
            let targetResponse: Response;

            // Start OpenTelemetry span for target forwarding
            const otelSpan = startTargetSpan({
                method: req.method,
                path: pathWithQuery,
                targetUrl,
                requestId,
            });

            try {
                targetResponse = await fetch(targetUrl, {
                    method: req.method,
                    headers: forwardHeaders,
                    body: req.body, // Stream body directly
                });
            } catch (fetchError) {
                const endTime = performance.now();
                const durationMs = endTime - startTime;
                const overhead = durationMs.toFixed(2);

                console.error(`❌ Failed to connect to target (${overhead}ms):`, fetchError);

                endTargetSpan(otelSpan, 502, durationMs,
                    fetchError instanceof Error ? fetchError : new Error(String(fetchError)));

                return new Response(JSON.stringify({
                    error: 'Failed to connect to target server',
                    message: fetchError instanceof Error ? fetchError.message : 'Unknown error',
                    target: targetUrl
                }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Stream the response directly — no buffering in memory
            const responseHeaders = new Headers(targetResponse.headers);

            // Remove compression headers as fetch automatically decompresses
            // Keeping these would cause "Decompression failed" errors in clients
            responseHeaders.delete('content-encoding');
            responseHeaders.delete('Content-Encoding');

            // Remove content-length as it may not match after decompression
            responseHeaders.delete('content-length');
            responseHeaders.delete('Content-Length');

            // Force connection close to ensure response is sent completely
            responseHeaders.set('Connection', 'close');

            const endTime = performance.now();
            const durationMs = endTime - startTime;
            const overhead = durationMs.toFixed(2);

            // Log with appropriate emoji based on status
            const statusEmoji = targetResponse.status < 400 ? '✅' : '⚠️';
            console.log(
                `${statusEmoji} ${req.method} ${pathWithQuery} → ${targetResponse.status} ${targetResponse.statusText} (${overhead}ms)`
            );

            // End OpenTelemetry span
            endTargetSpan(otelSpan, targetResponse.status, durationMs);

            // Add request ID to response for tracing
            responseHeaders.set('X-Request-ID', requestId);

            // Stream body directly instead of await arrayBuffer()
            return new Response(targetResponse.body, {
                status: targetResponse.status,
                statusText: targetResponse.statusText,
                headers: responseHeaders,
            });

        } catch (error) {
            const endTime = performance.now();
            const overhead = (endTime - startTime).toFixed(2);

            if (error instanceof UnauthorizedError) {
                const accept = req.headers.get('Accept') || '';
                if (accept.includes('text/html')) {
                    return renderErrorPage(401, 'Unauthorized', 'Authentication is required to access this resource. Provide a valid token via the <strong>X-Forward-Token</strong> header or <strong>?token=</strong> query parameter.');
                }
                return new Response(JSON.stringify({
                    error: 'Unauthorized',
                    message: 'Valid X-Forward-Token header is required'
                }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            console.error(`❌ Error forwarding request (${overhead}ms):`, error);

            return new Response(JSON.stringify({
                error: 'Internal Server Error',
                message: error instanceof Error ? error.message : 'Unknown error occurred'
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        } finally {
            activeRequests--;
        }
    },

    error(error) {
        console.error('Server error:', error);
        return new Response(JSON.stringify({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred'
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    },
});

console.log(`✨ Server running on http://localhost:${server.port}`);
console.log(`📡 Forwarding to: ${config.targetUrl}`);
console.log(`💚 Health check: http://localhost:${server.port}/health`);
console.log(`🖥️  Dashboard: http://localhost:${server.port}/dashboard`);
console.log(`\n⚡ Ready to proxy requests!\n`);

// Graceful shutdown handler
const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} received — graceful shutdown starting...`);
    isShuttingDown = true;

    // Wait for active requests to complete (max 10s)
    const maxWait = 10_000;
    const start = Date.now();

    while (activeRequests > 0 && Date.now() - start < maxWait) {
        console.log(`   ⏳ Waiting for ${activeRequests} active request(s)...`);
        await Bun.sleep(500);
    }

    if (activeRequests > 0) {
        console.warn(`   ⚠️  Forcing shutdown with ${activeRequests} request(s) still active`);
    }

    // Flush pending telemetry data before stopping
    await shutdownTelemetry();

    server.stop();
    console.log('👋 Server stopped.');
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

