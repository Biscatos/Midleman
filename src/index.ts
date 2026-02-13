import { loadConfig } from './config';
import { UnauthorizedError } from './types';
import { handleProxyRequest } from './proxy';

// Track server start time for health checks
const startedAt = Date.now();
let activeRequests = 0;
let isShuttingDown = false;

// Load configuration
const config = loadConfig();

console.log(`🚀 Bun-Forwarder starting...`);
console.log(`📌 Target URL: ${config.targetUrl}`);
console.log(`🔐 Authentication: ${config.authToken ? 'Enabled' : 'DISABLED ⚠️'}`);
console.log(`🔀 Forward Path: ${config.forwardPath ? 'Enabled' : 'DISABLED (Fixed URL mode)'}`);


if (config.proxyProfiles.length > 0) {
    console.log(`🔓 Proxy Profiles: ${config.proxyProfiles.map(p => p.name).join(', ')}`);
} else {
    console.log(`🔓 Proxy Profiles: None configured`);
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

            // Silently ignore favicon requests
            if (url.pathname === '/favicon.ico') {
                return new Response(null, { status: 204 });
            }

            // Health check endpoint for load balancers / k8s
            if (url.pathname === '/health') {
                return new Response(JSON.stringify({
                    status: 'ok',
                    uptime: Math.floor((Date.now() - startedAt) / 1000),
                    activeRequests,
                    proxyProfiles: config.proxyProfiles.length,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Handle proxy bypass requests (before auth validation)
            if (url.pathname.startsWith('/proxy/')) {
                if (config.proxyProfiles.length === 0) {
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

            try {
                targetResponse = await fetch(targetUrl, {
                    method: req.method,
                    headers: forwardHeaders,
                    body: req.body, // Stream body directly
                });
            } catch (fetchError) {
                const endTime = performance.now();
                const overhead = (endTime - startTime).toFixed(2);

                console.error(`❌ Failed to connect to target (${overhead}ms):`, fetchError);

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
            const overhead = (endTime - startTime).toFixed(2);

            // Log with appropriate emoji based on status
            const statusEmoji = targetResponse.status < 400 ? '✅' : '⚠️';
            console.log(
                `${statusEmoji} ${req.method} ${pathWithQuery} → ${targetResponse.status} ${targetResponse.statusText} (${overhead}ms)`
            );

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

    server.stop();
    console.log('👋 Server stopped.');
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

