import type { ProxyProfile } from './types';

/** Lightweight MIME → extension map (common types only, zero dependency) */
const MIME_TO_EXT: Record<string, string> = {
    // Images
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/avif': '.avif',
    'image/ico': '.ico',
    'image/x-icon': '.ico',
    // Video
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/ogg': '.ogg',
    'video/quicktime': '.mov',
    // Audio
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/webm': '.weba',
    // Documents
    'application/pdf': '.pdf',
    'application/json': '.json',
    'application/xml': '.xml',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/css': '.css',
    'text/csv': '.csv',
    // Archives
    'application/zip': '.zip',
    'application/gzip': '.gz',
    'application/x-tar': '.tar',
    // Office
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/msword': '.doc',
    'application/vnd.ms-excel': '.xls',
};

// Pre-computed profile map for O(1) lookup + cached auth values
interface CachedProfile extends ProxyProfile {
    computedAuthValue: string;
}

let profileMap: Map<string, CachedProfile> | null = null;

/**
 * Build a Map from profiles array for O(1) lookup.
 * Pre-computes auth header values to avoid string concatenation per request.
 */
function getProfileMap(profiles: ProxyProfile[]): Map<string, CachedProfile> {
    if (!profileMap) {
        profileMap = new Map();
        for (const p of profiles) {
            profileMap.set(p.name, {
                ...p,
                computedAuthValue: p.authPrefix ? `${p.authPrefix} ${p.apiKey}` : p.apiKey,
            });
        }
    }
    return profileMap;
}

/**
 * Handle proxy bypass requests.
 * Routes: /proxy/{profileName}/...path
 *
 * Authenticates with the upstream service using the configured API key
 * and serves the response publicly (or with optional access key protection).
 */
export async function handleProxyRequest(
    req: Request,
    url: URL,
    profiles: ProxyProfile[],
    startTime: number
): Promise<Response> {
    // Parse: /proxy/{profileName}/...rest
    const pathParts = url.pathname.split('/');
    // pathParts[0] = "", pathParts[1] = "proxy", pathParts[2] = profileName, rest = path
    const profileName = pathParts[2]?.toLowerCase();
    const remainingPath = '/' + pathParts.slice(3).join('/');

    if (!profileName) {
        return jsonResponse(400, {
            error: 'Bad Request',
            message: 'Missing proxy profile name. Use /proxy/{profileName}/path',
        });
    }

    // O(1) lookup via Map instead of Array.find()
    const map = getProfileMap(profiles);
    const profile = map.get(profileName);

    if (!profile) {
        const available = Array.from(map.keys()).join(', ') || 'none';
        return jsonResponse(404, {
            error: 'Not Found',
            message: `Proxy profile "${profileName}" not found. Available: ${available}`,
        });
    }

    // Validate access key if configured
    if (profile.accessKey) {
        const providedKey = url.searchParams.get('key');

        if (providedKey !== profile.accessKey) {
            console.warn(`❌ Proxy "${profileName}": unauthorized access attempt`);
            return jsonResponse(401, {
                error: 'Unauthorized',
                message: 'Valid ?key= parameter is required to access this resource',
            });
        }

        // Remove the key from query params before forwarding
        url.searchParams.delete('key');
    }

    // Check if extension is blocked (fast path: from URL)
    if (profile.blockedExtensions && profile.blockedExtensions.size > 0) {
        const urlExt = getExtFromPath(remainingPath);
        if (urlExt && profile.blockedExtensions.has(urlExt)) {
            console.warn(`🚫 Proxy "${profileName}": blocked extension "${urlExt}" for ${remainingPath}`);
            return jsonResponse(403, {
                error: 'Forbidden',
                message: `File type "${urlExt}" is not allowed`,
            });
        }
    }

    // Build the target URL
    const queryString = url.search;
    const targetUrl = profile.targetUrl + remainingPath + queryString;

    // Build headers with upstream authentication
    const forwardHeaders = new Headers();
    req.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'host' && lower !== 'x-forward-token') {
            forwardHeaders.set(key, value);
        }
    });

    // Set pre-computed auth value (no string concatenation per request)
    forwardHeaders.set(profile.authHeader, profile.computedAuthValue);

    // Forward to upstream
    let targetResponse: Response;

    try {
        targetResponse = await fetch(targetUrl, {
            method: req.method,
            headers: forwardHeaders,
            body: req.body,
        });
    } catch (fetchError) {
        const overhead = (performance.now() - startTime).toFixed(2);
        console.error(`❌ Proxy "${profileName}": failed to connect (${overhead}ms):`, fetchError);

        return jsonResponse(502, {
            error: 'Bad Gateway',
            message: fetchError instanceof Error ? fetchError.message : 'Failed to connect to upstream',
            profile: profileName,
        });
    }

    // Stream the response directly — no buffering in memory
    const responseHeaders = new Headers(targetResponse.headers);

    // Clean up compression headers (fetch auto-decompresses)
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('Content-Encoding');
    responseHeaders.delete('content-length');
    responseHeaders.delete('Content-Length');

    // Use Transfer-Encoding chunked for streaming
    responseHeaders.set('Connection', 'close');

    // Block by Content-Type if URL had no extension (fallback check)
    if (profile.blockedExtensions && profile.blockedExtensions.size > 0) {
        const contentType = responseHeaders.get('content-type')?.split(';')[0]?.trim();
        if (contentType) {
            const ext = MIME_TO_EXT[contentType];
            if (ext && profile.blockedExtensions.has(ext)) {
                console.warn(`🚫 Proxy "${profileName}": blocked type "${ext}" (${contentType}) for ${remainingPath}`);
                return jsonResponse(403, {
                    error: 'Forbidden',
                    message: `File type "${ext}" is not allowed`,
                });
            }
        }
    }

    // Infer file extension from Content-Type and set Content-Disposition
    // so browsers can identify the file even without extension in the URL
    if (!responseHeaders.has('content-disposition')) {
        const contentType = responseHeaders.get('content-type')?.split(';')[0]?.trim();
        if (contentType) {
            const ext = MIME_TO_EXT[contentType];
            if (ext) {
                // Extract a filename hint from the URL path, or use "file"
                const urlFilename = remainingPath.split('/').pop() || 'file';
                const baseName = urlFilename.includes('.') ? urlFilename : `${urlFilename}${ext}`;
                responseHeaders.set('Content-Disposition', `inline; filename="${baseName}"`);
            }
        }
    }

    const overhead = (performance.now() - startTime).toFixed(2);
    const statusEmoji = targetResponse.status < 400 ? '🔓' : '⚠️';
    console.log(
        `${statusEmoji} PROXY [${profileName}] ${req.method} ${remainingPath} → ${targetResponse.status} ${targetResponse.statusText} (${overhead}ms)`
    );

    // Stream body directly instead of await arrayBuffer()
    return new Response(targetResponse.body, {
        status: targetResponse.status,
        statusText: targetResponse.statusText,
        headers: responseHeaders,
    });
}

/**
 * Helper to create JSON error responses
 */
function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Extract file extension from a URL path (e.g., "/path/to/file.jpg" → ".jpg")
 */
function getExtFromPath(path: string): string | null {
    const filename = path.split('/').pop() || '';
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex <= 0) return null;
    return filename.substring(dotIndex).toLowerCase();
}

