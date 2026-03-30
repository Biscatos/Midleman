import type { ProxyProfile } from '../core/types';
import { startProxySpan, endProxySpan, recordProxyBlocked, recordProxyRedirect } from '../telemetry/telemetry';
import { logRequest, captureRequestBody, captureResponseBody, headersToRecord } from '../telemetry/request-log';

// ─── Access Key Session Cache ───────────────────────────────────────────────
// When a page is loaded with a valid ?key=, we cache the authorization so that
// sub-resources (CSS, JS, images) loaded by the browser in the same session
// don't get rejected. This solves the race condition where the browser fires
// sub-resource requests before processing the Set-Cookie from the HTML response.

// Cookie max-age for access key sessions (5 minutes)
const SESSION_TTL = 5 * 60 * 1000;

function getClientIP(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || 'unknown';
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
            // Also check for profile-scoped access key cookie
            if (resolvedProfileName && !resolvedKey) {
                const keyMatch = cookies.match(new RegExp(`(?:^|;\\s*)__pk_${resolvedProfileName}=([^;]+)`));
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

        // A. X-Access-Key header — for API clients / Postman (no redirect, no cookie)
        const headerKey = req.headers.get('x-access-key');
        if (headerKey === profile.accessKey) {
            validatedAccessKey = profile.accessKey;
        }

        // B. Direct ?key= — redirect to strip key from URL and set cookie first.
        //    The browser receives the cookie BEFORE loading the page, so all
        //    sub-resources (CSS, JS, fonts) automatically include it. No race condition.
        if (!validatedAccessKey && providedKey === profile.accessKey) {
            const clean = new URL(url.toString());
            clean.searchParams.delete('key');
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': clean.pathname + clean.search,
                    'Set-Cookie': `__pk_${profileName}=${encodeURIComponent(providedKey)}; Path=/proxy/${profileName}/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
                },
            });
        }

        // C. Profile-scoped cookie — the only valid credential after the initial redirect.
        //    Cookie name includes profileName so different proxies never share auth state.
        if (!validatedAccessKey) {
            const cookies = req.headers.get('cookie') || '';
            const m = cookies.match(new RegExp(`(?:^|;\\s*)__pk_${profileName}=([^;]+)`));
            if (m && decodeURIComponent(m[1]) === profile.accessKey) {
                validatedAccessKey = profile.accessKey;
            }
        }

        if (!validatedAccessKey) {
            console.warn(`❌ Proxy "${profileName}": REJECTED ${remainingPath} | cookie=${!!(req.headers.get('cookie')?.includes(`__pk_${profileName}`))} isAsset=${isSubResource}`);
            return unauthorizedResponse(req, profileName);
        }
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

    // Capture request body for logging before forwarding
    const reqCapture = await captureRequestBody(req);
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();
    const clientIp = getClientIP(req);

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

    // Build request body for forwarding — use original stream, not the captured string
    const forwardBody = req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined;

    try {
        for (let i = 0; i <= maxRedirects; i++) {
            targetResponse = await fetch(currentUrl, {
                method: i === 0 ? req.method : 'GET', // Redirects become GET
                headers: forwardHeaders,
                body: i === 0 ? forwardBody : undefined,
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

            // Same-origin redirect → rewrite Location to proxy path and pass to browser
            recordProxyRedirect(profileName);
            const proxyLocation = `/proxy/${profileName}${redirectUrl.pathname}${redirectUrl.search || ''}`;
            console.log(`↪️  PROXY [${profileName}] ${targetResponse.status} → ${proxyLocation}`);
            endProxySpan(otelSpan, profileName, targetResponse.status, performance.now() - startTime);
            return new Response(null, {
                status: targetResponse.status,
                headers: { 'Location': proxyLocation },
            });
        }
    } catch (fetchError) {
        const durationMs = performance.now() - startTime;
        const overhead = durationMs.toFixed(2);
        console.error(`❌ Proxy "${profileName}": failed to connect (${overhead}ms):`, fetchError);

        endProxySpan(otelSpan, profileName, 502, durationMs,
            fetchError instanceof Error ? fetchError : new Error(String(fetchError)));

        // Log failed proxy request
        logRequest({
            requestId,
            type: 'proxy',
            profileName,
            method: req.method,
            path: remainingPath,
            targetUrl,
            clientIp,
            reqHeaders: headersToRecord(forwardHeaders),
            reqBody: reqCapture.body,
            reqBodySize: reqCapture.size,
            resStatus: 502,
            resStatusText: 'Bad Gateway',
            durationMs,
            error: fetchError instanceof Error ? fetchError.message : String(fetchError),
        });

        return jsonResponse(502, {
            error: 'Bad Gateway',
            message: fetchError instanceof Error ? fetchError.message : 'Failed to connect to upstream',
            profile: profileName,
        });
    }

    // Stream the response directly — no buffering in memory
    const responseHeaders = new Headers();
    // Copy all headers except ones we'll rewrite, handling multiple Set-Cookie correctly
    for (const [key, value] of (targetResponse.headers as any)) {
        const lower = key.toLowerCase();
        if (lower === 'content-encoding' || lower === 'content-length') continue;
        if (lower === 'set-cookie') {
            // Strip Domain= so upstream cookies work on our proxy host (e.g. localhost)
            const rewritten = value
                .replace(/;\s*domain=[^;]*/gi, '')
                .replace(/;\s*samesite=none/gi, '; SameSite=Lax');
            responseHeaders.append('set-cookie', rewritten);
            continue;
        }
        responseHeaders.set(key, value);
    }
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

    // Capture response body for request logging
    const resCapture = await captureResponseBody(targetResponse);

    // Log proxy request to SQLite
    logRequest({
        requestId,
        type: 'proxy',
        profileName,
        method: req.method,
        path: remainingPath,
        targetUrl: currentUrl,
        clientIp,
        reqHeaders: headersToRecord(forwardHeaders),
        reqBody: reqCapture.body,
        reqBodySize: reqCapture.size,
        resStatus: targetResponse.status,
        resStatusText: targetResponse.statusText,
        resHeaders: headersToRecord(responseHeaders),
        resBody: resCapture.body,
        resBodySize: resCapture.size,
        durationMs,
    });

    // For HTML responses: generic rewriting so ANY upstream app works under /proxy/{profile}/
    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('text/html')) {
        let html = resCapture.body || '';

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
        responseHeaders.append('Set-Cookie', `__proxy_profile=${profileName}; Path=/proxy/${profileName}/; SameSite=Lax`);
        if (validatedAccessKey) {
            responseHeaders.append('Set-Cookie', `__pk_${profileName}=${encodeURIComponent(validatedAccessKey)}; Path=/proxy/${profileName}/; SameSite=Lax`);
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
    responseHeaders.append('Set-Cookie', `__proxy_profile=${profileName}; Path=/proxy/${profileName}/; SameSite=Lax`);
    if (validatedAccessKey) {
        responseHeaders.append('Set-Cookie', `__pk_${profileName}=${encodeURIComponent(validatedAccessKey)}; Path=/proxy/${profileName}/; SameSite=Lax`);
    }

    // Stream the original response body directly — never convert binary to string.
    // resCapture was only used for logging; targetResponse.body is still intact
    // because captureResponseBody clones text responses and skips binary ones.
    return new Response(targetResponse.body, {
        status: targetResponse.status,
        statusText: targetResponse.statusText,
        headers: responseHeaders,
    });
}

/**
 * Handle proxy requests on a dedicated port — no /proxy/{name} prefix needed.
 * The profile is already known from the server instance.
 * Transparent proxying: requests are forwarded as-is to the upstream.
 */
export async function handleDirectProxy(
    req: Request,
    profile: ProxyProfile,
    startTime: number,
): Promise<Response> {
    const url = new URL(req.url);
    const pathWithSearch = url.pathname + url.search;
    const profileName = profile.name;

    // Pre-compute auth value
    const computedAuthValue = profile.apiKey
        ? (profile.authPrefix ? `${profile.authPrefix} ${profile.apiKey}` : profile.apiKey)
        : '';

    // ── Access key validation ──
    let validatedAccessKey: string | null = null;
    if (profile.accessKey) {
        const providedKey = url.searchParams.get('key');
        const clientIP = getClientIP(req);

        // A. X-Access-Key header — for API clients / Postman (no redirect, no cookie)
        const headerKey = req.headers.get('x-access-key');
        if (headerKey === profile.accessKey) {
            validatedAccessKey = profile.accessKey;
        }

        // B. Direct ?key= — redirect to strip key from URL and set cookie first.
        //    Cookie is received by the browser BEFORE the page loads, so all
        //    sub-resources (CSS, JS, fonts) automatically include it. No race condition.
        if (!validatedAccessKey && providedKey === profile.accessKey) {
            const clean = new URL(url.toString());
            clean.searchParams.delete('key');
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': clean.pathname + clean.search,
                    'Set-Cookie': `__pk_${profileName}=${encodeURIComponent(providedKey)}; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
                },
            });
        }

        // C. Profile-scoped cookie — the only valid credential after the initial redirect.
        //    Cookie name includes profileName so different proxies never share auth state.
        if (!validatedAccessKey) {
            const cookies = req.headers.get('cookie') || '';
            const m = cookies.match(new RegExp(`(?:^|;\\s*)__pk_${profileName}=([^;]+)`));
            if (m && decodeURIComponent(m[1]) === profile.accessKey) {
                validatedAccessKey = profile.accessKey;
            }
        }

        if (!validatedAccessKey) {
            return unauthorizedResponse(req, profileName);
        }

        url.searchParams.delete('key');
    }

    // ── Blocked extensions (from URL) ──
    if (profile.blockedExtensions && profile.blockedExtensions.size > 0) {
        const urlExt = getExtFromPath(url.pathname);
        if (urlExt && profile.blockedExtensions.has(urlExt)) {
            console.warn(`🚫 Proxy "${profileName}": blocked extension "${urlExt}" for ${url.pathname}`);
            recordProxyBlocked(profileName, urlExt);
            return jsonResponse(403, {
                error: 'Forbidden',
                message: `File type "${urlExt}" is not allowed`,
            });
        }
    }

    // ── Build target URL (transparent: path goes directly to upstream) ──
    const targetUrl = profile.targetUrl + url.pathname + url.search;

    // ── Build headers ──
    const forwardHeaders = new Headers();
    req.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'host' && lower !== 'x-forward-token') {
            forwardHeaders.set(key, value);
        }
    });

    if (profile.authHeader && computedAuthValue) {
        forwardHeaders.set(profile.authHeader, computedAuthValue);
    }

    // ── Capture request body ──
    const reqCapture = await captureRequestBody(req);
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();
    const clientIp = getClientIP(req);

    const forwardBody = req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined;

    // ── Telemetry ──
    const otelSpan = startProxySpan({
        method: req.method,
        path: url.pathname,
        profileName,
        targetUrl,
    });

    // ── Fetch with redirect following ──
    let targetResponse!: Response;
    let currentUrl = targetUrl;
    const upstreamOrigin = new URL(profile.targetUrl).origin;
    const maxRedirects = 10;

    try {
        for (let i = 0; i <= maxRedirects; i++) {
            targetResponse = await fetch(currentUrl, {
                method: i === 0 ? req.method : 'GET',
                headers: forwardHeaders,
                body: i === 0 ? forwardBody : undefined,
                redirect: 'manual',
            });

            if (targetResponse.status < 300 || targetResponse.status >= 400) break;

            const location = targetResponse.headers.get('location');
            if (!location) break;

            const redirectUrl = new URL(location, currentUrl);

            // External redirect → pass through to browser
            if (redirectUrl.origin !== upstreamOrigin) {
                endProxySpan(otelSpan, profileName, targetResponse.status, performance.now() - startTime);
                return new Response(null, {
                    status: targetResponse.status,
                    headers: { 'Location': location },
                });
            }

            // Same-origin → rewrite Location to proxy path and pass to browser
            recordProxyRedirect(profileName);
            const redirectPath = redirectUrl.pathname + (redirectUrl.search || '');
            console.log(`↪️  PROXY [${profileName}] ${targetResponse.status} → ${redirectPath}`);
            endProxySpan(otelSpan, profileName, targetResponse.status, performance.now() - startTime);
            return new Response(null, {
                status: targetResponse.status,
                headers: { 'Location': redirectPath },
            });
        }
    } catch (fetchError) {
        const durationMs = performance.now() - startTime;
        console.error(`❌ Proxy "${profileName}": failed to connect (${durationMs.toFixed(2)}ms):`, fetchError);

        endProxySpan(otelSpan, profileName, 502, durationMs,
            fetchError instanceof Error ? fetchError : new Error(String(fetchError)));

        logRequest({
            requestId, type: 'proxy', profileName,
            method: req.method, path: url.pathname, targetUrl, clientIp,
            reqHeaders: headersToRecord(forwardHeaders),
            reqBody: reqCapture.body, reqBodySize: reqCapture.size,
            resStatus: 502, resStatusText: 'Bad Gateway', durationMs,
            error: fetchError instanceof Error ? fetchError.message : String(fetchError),
        });

        return jsonResponse(502, {
            error: 'Bad Gateway',
            message: fetchError instanceof Error ? fetchError.message : 'Failed to connect to upstream',
            profile: profileName,
        });
    }

    // ── Process response ──
    const responseHeaders = new Headers();
    // Copy all headers except ones we'll rewrite, handling multiple Set-Cookie correctly
    for (const [key, value] of (targetResponse.headers as any)) {
        const lower = key.toLowerCase();
        if (lower === 'content-encoding' || lower === 'content-length') continue;
        if (lower === 'set-cookie') {
            // Strip Domain= so the browser sends this cookie back to our proxy host.
            // Without this, cookies set by the upstream (e.g. Domain=payment.ucall.co.ao)
            // are never sent by the browser to localhost:XXXX, causing 401 on sub-resources.
            const rewritten = value
                .replace(/;\s*domain=[^;]*/gi, '')
                .replace(/;\s*samesite=none/gi, '; SameSite=Lax');
            responseHeaders.append('set-cookie', rewritten);
            continue;
        }
        responseHeaders.set(key, value);
    }
    responseHeaders.set('Connection', 'close');

    // Block by Content-Type (fallback check)
    if (profile.blockedExtensions && profile.blockedExtensions.size > 0) {
        const contentType = responseHeaders.get('content-type')?.split(';')[0]?.trim();
        if (contentType) {
            const ext = MIME_TO_EXT[contentType];
            if (ext && profile.blockedExtensions.has(ext)) {
                console.warn(`🚫 Proxy "${profileName}": blocked type "${ext}" (${contentType}) for ${url.pathname}`);
                recordProxyBlocked(profileName, ext);
                endProxySpan(otelSpan, profileName, 403, performance.now() - startTime);
                return jsonResponse(403, {
                    error: 'Forbidden',
                    message: `File type "${ext}" is not allowed`,
                });
            }
        }
    }

    // Content-Disposition for files
    if (!responseHeaders.has('content-disposition')) {
        const contentType = responseHeaders.get('content-type')?.split(';')[0]?.trim();
        if (contentType) {
            const ext = MIME_TO_EXT[contentType];
            if (ext) {
                const urlFilename = url.pathname.split('/').pop() || 'file';
                const baseName = urlFilename.includes('.') ? urlFilename : `${urlFilename}${ext}`;
                responseHeaders.set('Content-Disposition', `inline; filename="${baseName}"`);
            }
        }
    }

    const durationMs = performance.now() - startTime;
    const statusEmoji = targetResponse.status < 400 ? '🔓' : '⚠️';
    console.log(
        `${statusEmoji} PROXY [${profileName}] ${req.method} ${url.pathname} → ${targetResponse.status} ${targetResponse.statusText} (${durationMs.toFixed(2)}ms)`
    );

    endProxySpan(otelSpan, profileName, targetResponse.status, durationMs);

    // Capture response for logging
    const resCapture = await captureResponseBody(targetResponse);

    logRequest({
        requestId, type: 'proxy', profileName,
        method: req.method, path: url.pathname, targetUrl: currentUrl, clientIp,
        reqHeaders: headersToRecord(forwardHeaders),
        reqBody: reqCapture.body, reqBodySize: reqCapture.size,
        resStatus: targetResponse.status, resStatusText: targetResponse.statusText,
        resHeaders: headersToRecord(responseHeaders),
        resBody: resCapture.body, resBodySize: resCapture.size,
        durationMs,
    });

    // Set profile-scoped access key cookie for session persistence
    // Cookie name includes profileName to prevent cross-proxy authentication leakage
    if (validatedAccessKey) {
        responseHeaders.append('Set-Cookie', `__pk_${profileName}=${encodeURIComponent(validatedAccessKey)}; Path=/; SameSite=Lax`);
    }

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

function unauthorizedResponse(req: Request, profileName: string): Response {
    const accept = req.headers.get('accept') || '';
    const wantsBrowser = accept.includes('text/html');

    if (!wantsBrowser) {
        return jsonResponse(401, {
            error: 'Unauthorized',
            message: 'Valid ?key= parameter is required to access this resource',
        });
    }

    const currentUrl = new URL(req.url);
    const exampleUrl = `${currentUrl.origin}${currentUrl.pathname}?key=YOUR_KEY`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Required — ${profileName}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1a1d27;
      border: 1px solid #2d3148;
      border-radius: 12px;
      padding: 40px;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .icon { font-size: 36px; margin-bottom: 16px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; color: #f1f5f9; }
    .subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 28px; }
    .badge {
      display: inline-block;
      background: #1e2235;
      border: 1px solid #2d3148;
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 12px;
      font-family: monospace;
      color: #7c86f7;
    }
    .method {
      margin-bottom: 20px;
    }
    .method-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #64748b;
      margin-bottom: 8px;
    }
    .code-block {
      background: #0f1117;
      border: 1px solid #2d3148;
      border-radius: 8px;
      padding: 12px 16px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 12px;
      color: #a5f3fc;
      word-break: break-all;
      position: relative;
    }
    .key-placeholder { color: #fbbf24; }
    .dim { color: #475569; }
    .divider {
      border: none;
      border-top: 1px solid #2d3148;
      margin: 24px 0;
    }
    .note {
      font-size: 12px;
      color: #64748b;
      line-height: 1.6;
    }
    .note a { color: #7c86f7; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#128274;</div>
    <h1>Access Required</h1>
    <p class="subtitle">This resource <span class="badge">${profileName}</span> requires an access key. Choose one of the methods below.</p>

    <div class="method">
      <div class="method-title">Option 1 — Query parameter (browser)</div>
      <div class="code-block">${exampleUrl.replace('YOUR_KEY', '<span class="key-placeholder">YOUR_KEY</span>')}</div>
    </div>

    <div class="method">
      <div class="method-title">Option 2 — Request header (API / curl)</div>
      <div class="code-block">
        curl <span class="dim">\\</span><br>
        &nbsp;&nbsp;-H <span class="key-placeholder">"X-Access-Key: YOUR_KEY"</span> <span class="dim">\\</span><br>
        &nbsp;&nbsp;${currentUrl.origin}${currentUrl.pathname}
      </div>
    </div>

    <hr class="divider">
    <p class="note">
      The key is set by the administrator of this Midleman instance.<br>
      After the first successful authentication the session is kept via a secure cookie — you won't need to include the key on every request.
    </p>
  </div>
</body>
</html>`;

    return new Response(html, {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'WWW-Authenticate': 'ApiKey realm="Proxy Access"' },
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

