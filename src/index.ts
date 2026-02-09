import { loadConfig } from './config';
import { UnauthorizedError } from './types';

// Load configuration
const config = loadConfig();

console.log(`🚀 Bun-Forwarder starting...`);
console.log(`📌 Target URL: ${config.targetUrl}`);
console.log(`🔐 Authentication: ${config.authToken ? 'Enabled' : 'DISABLED ⚠️'}`);

/**
 * Main HTTP server using Bun.serve
 */
const server = Bun.serve({
    port: config.port,
    idleTimeout: 255, // Maximum allowed by Bun (4.25 minutes)

    async fetch(req: Request): Promise<Response> {
        const startTime = performance.now();

        try {
            // Security: Validate authentication token (only if configured)
            if (config.authToken) {
                const authHeader = req.headers.get('X-Forward-Token');

                if (authHeader !== config.authToken) {
                    console.warn(`❌ Unauthorized request from ${req.headers.get('X-Forwarded-For') || 'unknown'}`);
                    return new Response(JSON.stringify({
                        error: 'Unauthorized',
                        message: 'Valid X-Forward-Token header is required'
                    }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }

            // Parse incoming request URL
            const url = new URL(req.url);
            const pathWithQuery = url.pathname + url.search;

            // Construct target URL
            const targetUrl = config.targetUrl + pathWithQuery;

            // Prepare headers (exclude Host as it's auto-handled by fetch)
            const forwardHeaders = new Headers();
            req.headers.forEach((value, key) => {
                if (key.toLowerCase() !== 'host') {
                    forwardHeaders.set(key, value);
                }
            });

            // Remove the authentication header before forwarding
            forwardHeaders.delete('X-Forward-Token');

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

            // Mirror the response from target
            const responseBody = await targetResponse.arrayBuffer();
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

            return new Response(responseBody, {
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
console.log(`\n⚡ Ready to proxy requests!\n`);
