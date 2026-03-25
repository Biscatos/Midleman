import type { ProxyProfile } from './types';
import { startProxySpan, endProxySpan, recordProxyBlocked, recordProxyRedirect } from './telemetry';

// ─── Access Key Session Cache ───────────────────────────────────────────────
// When a page is loaded with a valid ?key=, we cache the authorization so that
// sub-resources (CSS, JS, images) loaded by the browser in the same session
// don't get rejected. This solves the race condition where the browser fires
// sub-resource requests before processing the Set-Cookie from the HTML response.

const SESSION_TTL = 5 * 60 * 1000; // 5 minutes
const SESSION_CLEANUP_INTERVAL = 60 * 1000; // cleanup every 60s

interface AccessSession {
    key: string;
    expiresAt: number;
}

// Key: "profileName:clientIP" → session
const accessSessions = new Map<string, AccessSession>();

// Periodic cleanup
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of accessSessions) {
        if (v.expiresAt < now) accessSessions.delete(k);
    }
}, SESSION_CLEANUP_INTERVAL);

function getClientIP(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || 'unknown';
}

function grantSession(profileName: string, clientIP: string, key: string): void {
    accessSessions.set(`${profileName}:${clientIP}`, {
        key,
        expiresAt: Date.now() + SESSION_TTL,
    });
}

function getSessionKey(profileName: string, clientIP: string): string | null {
    const session = accessSessions.get(`${profileName}:${clientIP}`);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
        accessSessions.delete(`${profileName}:${clientIP}`);
        return null;
    }
    // Extend TTL on access
    session.expiresAt = Date.now() + SESSION_TTL;
    return session.key;
}

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
                computedAuthValue: p.apiKey
                    ? (p.authPrefix ? `${p.authPrefix} ${p.apiKey}` : p.apiKey)
                    : '',
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
    let validatedAccessKey: string | null = null;
    if (profile.accessKey) {
        const providedKey = url.searchParams.get('key');
        const clientIP = getClientIP(req);

        // ── Check if this is a sub-resource request ──
        // Sub-resources (CSS, JS, images, fonts, etc.) loaded by the browser
        // from an authenticated page should not be blocked. We detect them by:
        //   1. The Referer header pointing to the same profile path, OR
        //   2. The file extension being a known asset type, OR
        //   3. An active session from a recent authenticated page load
        const isSubResource = isAssetRequest(remainingPath, req.headers.get('accept'));
        const referer = req.headers.get('referer') || '';
        const refererIsFromProfile = referer.includes(`/proxy/${profileName}/`);

        // A. Direct ?key= parameter (page load)
        if (providedKey === profile.accessKey) {
            validatedAccessKey = providedKey;
            grantSession(profileName, clientIP, providedKey);
        }

        // B. Cookie
        if (!validatedAccessKey) {
            const cookies = req.headers.get('cookie') || '';
            const m = cookies.match(/(?:^|;\s*)__proxy_key=([^;]+)/);
            if (m && decodeURIComponent(m[1]) === profile.accessKey) {
                validatedAccessKey = profile.accessKey;
            }
        }

        // C. In-memory session cache
        if (!validatedAccessKey) {
            const sessionKey = getSessionKey(profileName, clientIP);
            if (sessionKey === profile.accessKey) {
                validatedAccessKey = sessionKey;
            }
        }

        // D. Sub-resource with Referer from same profile → always allow
        //    The parent page was authenticated; browser is just loading assets.
        if (!validatedAccessKey && refererIsFromProfile) {
            validatedAccessKey = profile.accessKey;
            grantSession(profileName, clientIP, profile.accessKey);
            console.log(`🔑 Proxy "${profileName}": sub-resource ${remainingPath} allowed via referer`);
        }

        // E. Known asset type with active session OR referer present
        //    Catches edge cases where referer path doesn't match exactly
        if (!validatedAccessKey && isSubResource && referer) {
            validatedAccessKey = profile.accessKey;
            console.log(`🔑 Proxy "${profileName}": asset ${remainingPath} allowed (asset+referer)`);
        }

        if (!validatedAccessKey) {
            console.warn(`❌ Proxy "${profileName}": REJECTED ${remainingPath} | key=${!!providedKey} cookie=${!!(req.headers.get('cookie')?.includes('__proxy_key'))} session=${!!getSessionKey(profileName, clientIP)} referer=${referer.substring(0, 80)} isAsset=${isSubResource}`);
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
            recordProxyBlocked(profileName, urlExt);
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
    if (profile.authHeader && profile.computedAuthValue) {
        forwardHeaders.set(profile.authHeader, profile.computedAuthValue);
    }

    // Forward to upstream — follow same-origin redirects internally (transparent to the client)
    let targetResponse!: Response;
    let currentUrl = targetUrl;
    const upstreamOrigin = new URL(profile.targetUrl).origin;
    const maxRedirects = 10;

    // Start OpenTelemetry span for this proxy request
    const otelSpan = startProxySpan({
        method: req.method,
        path: remainingPath,
        profileName,
        targetUrl,
    });

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
                endProxySpan(otelSpan, profileName, targetResponse.status, performance.now() - startTime);
                return new Response(null, {
                    status: targetResponse.status,
                    headers: { 'Location': location },
                });
            }

            // Same-origin redirect — follow it internally
            recordProxyRedirect(profileName);
            console.log(`↪️  PROXY [${profileName}] ${targetResponse.status} → ${redirectUrl.pathname}${redirectUrl.search}`);
            currentUrl = redirectUrl.toString();

            if (i === maxRedirects) {
                endProxySpan(otelSpan, profileName, 502, performance.now() - startTime);
                return jsonResponse(502, { error: 'Too many redirects from upstream', profile: profileName });
            }
        }
    } catch (fetchError) {
        const overhead = (performance.now() - startTime).toFixed(2);
        console.error(`❌ Proxy "${profileName}": failed to connect (${overhead}ms):`, fetchError);

        endProxySpan(otelSpan, profileName, 502, performance.now() - startTime,
            fetchError instanceof Error ? fetchError : new Error(String(fetchError)));

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
                recordProxyBlocked(profileName, ext);
                endProxySpan(otelSpan, profileName, 403, performance.now() - startTime);
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

    const durationMs = performance.now() - startTime;
    const overhead = durationMs.toFixed(2);
    const statusEmoji = targetResponse.status < 400 ? '🔓' : '⚠️';
    console.log(
        `${statusEmoji} PROXY [${profileName}] ${req.method} ${remainingPath} → ${targetResponse.status} ${targetResponse.statusText} (${overhead}ms)`
    );

    // End OpenTelemetry span
    endProxySpan(otelSpan, profileName, targetResponse.status, durationMs);

    // For HTML responses: generic rewriting so ANY upstream app works under /proxy/{profile}/
    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('text/html')) {
        let html = await targetResponse.text();

        // Compute base href from the actual request path so relative URLs
        // resolve correctly even in subdirectories.
        // e.g. /proxy/adv/swagger/index.html → base = /proxy/adv/swagger/
        const lastSlash = remainingPath.lastIndexOf('/');
        const subDir = lastSlash > 0 ? remainingPath.substring(0, lastSlash + 1) : '/';
        const proxyBase = `/proxy/${profileName}${subDir}`;
        const proxyRoot = `/proxy/${profileName}/`;

        // 1. Inject/replace <base href> so relative URLs (./file) resolve through proxy
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

        // 2. Rewrite ALL absolute paths in href/src/action attributes.
        //    /anything → rewritten to go through proxy root.
        //    Does NOT touch: // (protocol-relative), http/https (full URLs), # (anchors), data:, javascript:
        html = html.replace(
            /((?:href|src|action)\s*=\s*["'])\/(?!\/|proxy\/)([\w])/gi,
            (_, prefix, firstChar) => `${prefix}${proxyRoot}${firstChar}`
        );

        // 3. Inject script to patch ALL browser APIs that make network requests.
        //    This is the generic proxy layer — intercepts fetch(), XMLHttpRequest,
        //    History API, location changes, and EventSource so absolute paths
        //    like /api/data or /swagger/v1/swagger.json route through the proxy.
        const patchScript = `<script>(function(){
var P="${proxyRoot}";
function fix(u){
if(!u||typeof u!=="string")return u;
if(u.startsWith("//"))return u;
try{var x=new URL(u,location.origin);if(x.origin===location.origin&&!x.pathname.startsWith(P)){return P+x.pathname.slice(1)+x.search+x.hash}}catch(e){}
if(u.startsWith("/")&&!u.startsWith(P))return P+u.slice(1);
return u;
}
/* fetch */
var _f=window.fetch;
window.fetch=function(i,o){
if(typeof i==="string")i=fix(i);
else if(i instanceof Request)i=new Request(fix(i.url),i);
return _f.call(this,i,o);
};
/* XMLHttpRequest */
var _xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
arguments[1]=fix(u);
return _xo.apply(this,arguments);
};
/* History API */
var _p=history.pushState,_r=history.replaceState;
history.pushState=function(s,t,u){return _p.call(this,s,t,fix(u))};
history.replaceState=function(s,t,u){return _r.call(this,s,t,fix(u))};
/* location */
var _assign=location.assign.bind(location);
var _replace2=location.replace.bind(location);
location.assign=function(u){return _assign(fix(u))};
location.replace=function(u){return _replace2(fix(u))};
var _href=Object.getOwnPropertyDescriptor(Location.prototype,"href");
if(_href&&_href.set){Object.defineProperty(location,"href",{get:function(){return _href.get.call(location)},set:function(v){_href.set.call(location,fix(v))},configurable:true})}
/* EventSource */
if(window.EventSource){var _ES=window.EventSource;window.EventSource=function(u,o){return new _ES(fix(u),o)};window.EventSource.prototype=_ES.prototype;}
/* fix current URL if needed */
if(location.pathname===P.slice(0,-1)){_r.call(history,null,"",P+location.search+location.hash)}
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

/** Known asset extensions that browsers load as sub-resources */
const ASSET_EXTENSIONS = new Set([
    '.css', '.js', '.mjs', '.jsx', '.ts', '.tsx',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif', '.bmp',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp4', '.webm', '.ogg', '.mp3', '.wav',
    '.map', '.json', '.xml', '.txt',
    '.pdf', '.zip', '.gz', '.wasm',
]);

/**
 * Detect if a request is for a sub-resource (CSS, JS, image, font, etc.)
 * Uses file extension and Accept header.
 */
function isAssetRequest(path: string, accept: string | null): boolean {
    // Check file extension
    const ext = getExtFromPath(path);
    if (ext && ASSET_EXTENSIONS.has(ext)) return true;
    // Check Accept header — browsers send specific accept types for sub-resources
    if (accept) {
        if (accept.includes('text/css')) return true;
        if (accept.includes('image/')) return true;
        if (accept.includes('font/')) return true;
        if (accept.includes('application/javascript')) return true;
        if (accept.includes('*/*') && !accept.includes('text/html')) return true;
    }
    return false;
}

