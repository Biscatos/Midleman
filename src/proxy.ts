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
 * Invalidate the cached profile map (call after config reload).
 */
export function invalidateProfileCache(): void {
    profileMap = null;
}

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
        // Fallback: resolve the correct profile from referer or cookie.
        // Handles upstream HTML/CSS/fonts using absolute paths like /css/app.css or /fonts/x.woff
        // which the browser resolves to /proxy/css/... instead of /proxy/{profile}/css/...
        let resolvedProfileName: string | null = null;
        let resolvedKey: string | null = null;

        // 1. Try referer: scan path segments for a valid profile name
        const referer = req.headers.get('referer');
        if (referer) {
            try {
                const refUrl = new URL(referer);
                const refParts = refUrl.pathname.split('/');
                if (refParts[1] === 'proxy') {
                    for (let i = 2; i < refParts.length; i++) {
                        const candidate = refParts[i].toLowerCase();
                        if (candidate && map.has(candidate)) {
                            resolvedProfileName = candidate;
                            resolvedKey = refUrl.searchParams.get('key');
                            break;
                        }
                    }
                }
            } catch {}
        }

        // 2. Fallback to cookie (handles deep sub-resources like CSS → fonts)
        if (!resolvedProfileName) {
            const cookies = req.headers.get('cookie') || '';
            const match = cookies.match(/(?:^|;\s*)__proxy_profile=([^;]+)/);
            if (match) {
                const cookieProfile = match[1].toLowerCase();
                if (map.has(cookieProfile)) {
                    resolvedProfileName = cookieProfile;
                }
            }
            // Also check for access key cookie
            if (resolvedProfileName && !resolvedKey) {
                const keyMatch = cookies.match(/(?:^|;\s*)__proxy_key=([^;]+)/);
                if (keyMatch) resolvedKey = decodeURIComponent(keyMatch[1]);
            }
        }

        // 3. Last resort: if only one profile exists, use it (common single-site setup)
        if (!resolvedProfileName && map.size === 1) {
            resolvedProfileName = map.keys().next().value!;
            const singleProfile = map.get(resolvedProfileName)!;
            // Only auto-resolve if profile has no access key (public profile)
            if (singleProfile.accessKey) {
                resolvedProfileName = null;
            }
        }

        if (resolvedProfileName) {
            const fixedPath = '/' + profileName + remainingPath;
            const fixedUrl = new URL(url.toString());
            fixedUrl.pathname = '/proxy/' + resolvedProfileName + fixedPath;

            if (resolvedKey && !fixedUrl.searchParams.has('key')) {
                fixedUrl.searchParams.set('key', resolvedKey);
            }

            return handleProxyRequest(req, fixedUrl, profiles, startTime);
        }

        const available = Array.from(map.keys()).join(', ') || 'none';
        return jsonResponse(404, {
            error: 'Not Found',
            message: `Proxy profile "${profileName}" not found. Available: ${available}`,
        });
    }

    // Validate access key if configured
    // Accept key from: query param ?key=, or session cookie __proxy_key (set on first valid access)
    let validatedAccessKey: string | null = null;
    if (profile.accessKey) {
        const providedKey = url.searchParams.get('key');

        // Also check cookie as fallback (for sub-resources like CSS, JS, fonts)
        let cookieKey: string | null = null;
        const cookies = req.headers.get('cookie') || '';
        const keyMatch = cookies.match(/(?:^|;\s*)__proxy_key=([^;]+)/);
        if (keyMatch) cookieKey = decodeURIComponent(keyMatch[1]);

        if (providedKey === profile.accessKey) {
            validatedAccessKey = providedKey;
        } else if (cookieKey === profile.accessKey) {
            validatedAccessKey = cookieKey;
        } else {
            console.warn(`❌ Proxy "${profileName}": unauthorized access attempt`);
            return jsonResponse(401, {
                error: 'Unauthorized',
                message: 'Valid ?key= parameter is required to access this resource',
            });
        }

        // Remove the key from query params before forwarding to upstream
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

    // Forward to upstream — follow same-origin redirects internally (transparent to the client)
    let targetResponse!: Response;
    let currentUrl = targetUrl;
    const upstreamOrigin = new URL(profile.targetUrl).origin;
    const maxRedirects = 10;

    try {
        for (let i = 0; i <= maxRedirects; i++) {
            targetResponse = await fetch(currentUrl, {
                method: i === 0 ? req.method : 'GET', // Redirects become GET
                headers: forwardHeaders,
                body: i === 0 ? req.body : undefined,
                redirect: 'manual',
            });

            // Not a redirect — we're done
            if (targetResponse.status < 300 || targetResponse.status >= 400) break;

            const location = targetResponse.headers.get('location');
            if (!location) break;

            // Resolve the redirect URL
            const redirectUrl = new URL(location, currentUrl);

            // External redirect (different origin) — pass through to browser
            if (redirectUrl.origin !== upstreamOrigin) {
                return new Response(null, {
                    status: targetResponse.status,
                    headers: { 'Location': location },
                });
            }

            // Same-origin redirect — follow it internally
            console.log(`↪️  PROXY [${profileName}] ${targetResponse.status} → ${redirectUrl.pathname}${redirectUrl.search}`);
            currentUrl = redirectUrl.toString();

            if (i === maxRedirects) {
                return jsonResponse(502, { error: 'Too many redirects from upstream', profile: profileName });
            }
        }
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

    // For HTML responses: rewrite so SPA works under /proxy/{profile}/
    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('text/html')) {
        let html = await targetResponse.text();
        const proxyBase = `/proxy/${profileName}/`;

        // 1. Inject/replace <base href> so relative URLs resolve through proxy
        if (/<base\s[^>]*href=/i.test(html)) {
            html = html.replace(
                /<base\s([^>]*)href=["'][^"']*["']/i,
                `<base $1href="${proxyBase}"`
            );
        } else {
            html = html.replace(
                /(<head[^>]*>)/i,
                `$1<base href="${proxyBase}">`
            );
        }

        // 2. Rewrite absolute asset paths to relative (so <base> resolves them)
        //    /css/... → css/...  /js/... → js/...  /fonts/... → fonts/...  /img/... → img/...
        html = html.replace(/(href|src)=["']\/(?!\/)(css|js|fonts|img|assets|static|media|favicon)/gi,
            (_, attr, dir) => `${attr}="${dir}`);

        // 3. Inject script FIRST to patch History API and window.location assignments
        //    Must run before any SPA framework code
        const patchScript = `<script>(function(){
var b="${proxyBase}";
var _p=history.pushState,_r=history.replaceState;
function fix(u){if(!u||typeof u!=="string")return u;try{var x=new URL(u,location.origin);if(x.origin===location.origin&&!x.pathname.startsWith(b)){return b+x.pathname.slice(1)+x.search+x.hash}}catch(e){}if(u.startsWith("/")&&!u.startsWith(b))return b+u.slice(1);return u}
history.pushState=function(s,t,u){return _p.call(this,s,t,fix(u))};
history.replaceState=function(s,t,u){return _r.call(this,s,t,fix(u))};
var _loc=Object.getOwnPropertyDescriptor(window,"location")||{};
var _assign=window.location.assign.bind(window.location);
var _replace2=window.location.replace.bind(window.location);
window.location.assign=function(u){return _assign(fix(u))};
window.location.replace=function(u){return _replace2(fix(u))};
var _href=Object.getOwnPropertyDescriptor(Location.prototype,"href");
if(_href&&_href.set){Object.defineProperty(window.location,"href",{get:function(){return _href.get.call(window.location)},set:function(v){return _href.set.call(window.location,fix(v))},configurable:true})}
if(location.pathname===b.slice(0,-1)){_r.call(history,null,"",b+location.search+location.hash)}
})()</script>`;
        html = html.replace(/(<head[^>]*>(?:<base[^>]*>)?)/i, `$1${patchScript}`);

        // 5. Set cookies for deep sub-resource resolution (CSS → fonts)
        responseHeaders.append('Set-Cookie', `__proxy_profile=${profileName}; Path=/proxy/; SameSite=Lax`);
        if (validatedAccessKey) {
            responseHeaders.append('Set-Cookie', `__proxy_key=${encodeURIComponent(validatedAccessKey)}; Path=/proxy/; SameSite=Lax`);
        }

        responseHeaders.delete('content-length');
        responseHeaders.delete('Content-Length');

        return new Response(html, {
            status: targetResponse.status,
            statusText: targetResponse.statusText,
            headers: responseHeaders,
        });
    }

    // Set profile cookie on ALL proxy responses (not just HTML)
    // This ensures the cookie is available for deep sub-resources on subsequent requests
    responseHeaders.append('Set-Cookie', `__proxy_profile=${profileName}; Path=/proxy/; SameSite=Lax`);
    if (validatedAccessKey) {
        responseHeaders.append('Set-Cookie', `__proxy_key=${encodeURIComponent(validatedAccessKey)}; Path=/proxy/; SameSite=Lax`);
    }

    // Stream body directly for non-HTML responses
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

