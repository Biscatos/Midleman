import type { ProxyProfile } from '../core/types';
import { startProxySpan, endProxySpan, recordProxyBlocked, recordProxyRedirect } from '../telemetry/telemetry';
import { logRequest, captureRequestBody, captureResponseBody, headersToRecord } from '../telemetry/request-log';
import { isIpAllowed } from '../core/ip-filter';
import { verifyJwt } from '../auth/auth';

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
 * Check if a request has a valid proxy user JWT cookie for the given profile.
 * Returns the username if valid, null otherwise.
 */
function checkProxyLoginAuth(req: Request, profileName: string): string | null {
    const cookies = req.headers.get('cookie') || '';
    const m = cookies.match(new RegExp(`(?:^|;\\s*)__midleman_auth_${profileName}=([^;]+)`));
    if (!m) return null;
    const token = decodeURIComponent(m[1]);
    const payload = verifyJwt(token);
    if (!payload) return null;
    if (payload.profile !== profileName) return null;
    return payload.username as string || null;
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
    startTime: number,
    renderLoginHtml?: (profileName: string, require2fa: boolean) => string
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

            return handleProxyRequest(req, fixedUrl, profiles, startTime, renderLoginHtml);
        }

        const available = Array.from(map.keys()).join(', ') || 'none';
        return jsonResponse(404, {
            error: 'Not Found',
            message: `Proxy profile "${profileName}" not found. Available: ${available}`,
        });
    }

    // Detect browser vs API client (used for cookie policy and error responses)
    const accept = req.headers.get('accept') || '';
    const isBrowser = accept.includes('text/html');

    // ── Auth: login mode (JWT-based user authentication) ──
    const effectiveAuthMode = profile.authMode || (profile.accessKey ? 'accessKey' : 'none');

    if (effectiveAuthMode === 'login') {
        // /auth/* routes should not be forwarded to upstream
        if (remainingPath.startsWith('/auth/')) {
            return jsonResponse(404, { error: 'Not Found' });
        }

        const proxyUser = checkProxyLoginAuth(req, profileName);
        if (!proxyUser) {
            if (profile.isWebApp) {
                const isSubResource = isAssetRequest(remainingPath, req.headers.get('accept'));
                if (isSubResource) {
                    return jsonResponse(401, { error: 'Unauthorized' });
                }
                if (renderLoginHtml) {
                    const html = renderLoginHtml(profile.name, !!profile.require2fa);
                    return new Response(html, {
                        status: 401,
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    });
                }
                const redirectTo = encodeURIComponent(url.pathname + url.search);
                return new Response(null, {
                    status: 302,
                    headers: { 'Location': `/proxy/${profileName}/auth/login?redirect=${redirectTo}` },
                });
            }
            return jsonResponse(401, {
                error: 'Unauthorized',
                message: 'Authentication required. Use POST /proxy/' + profileName + '/auth/login with username and password.',
            });
        }
    }

    // ── Auth: access key mode ──
    let validatedAccessKey: string | null = null;
    if (effectiveAuthMode === 'accessKey' && profile.accessKey) {
        const providedKey = url.searchParams.get('key');
        const clientIP = getClientIP(req);

        // ── Check if this is a sub-resource request ──
        const isSubResource = isAssetRequest(remainingPath, req.headers.get('accept'));
        const referer = req.headers.get('referer') || '';
        const refererIsFromProfile = referer.includes(`/proxy/${profileName}/`);

        // A. X-Mid-Api-Key header — for API clients / Postman (no redirect, no cookie)
        const headerKey = req.headers.get('x-mid-api-key');
        if (headerKey === profile.accessKey) {
            validatedAccessKey = profile.accessKey;
        }

        // B. Direct ?key= — redirect to strip key from URL and set cookie first.
        if (!validatedAccessKey && providedKey === profile.accessKey) {
            if (isBrowser) {
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
            validatedAccessKey = profile.accessKey;
        }

        // C. Profile-scoped cookie
        if (!validatedAccessKey && isBrowser) {
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

    // Build the target URL — normalize through URL constructor to strip default
    // ports (http:80, https:443) which Bun's fetch handles inconsistently.
    const queryString = url.search;
    const rawTargetUrl = profile.forwardPath !== false
        ? profile.targetUrl + remainingPath + queryString
        : profile.targetUrl + queryString;
    let targetUrl = rawTargetUrl;
    try { targetUrl = new URL(rawTargetUrl).href; } catch {}

    // Build headers with upstream authentication
    const forwardHeaders = new Headers();
    req.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'host' && lower !== 'x-forward-token') {
            forwardHeaders.set(key, value);
        }
    });

    // Set Host explicitly, preserving user-configured port (e.g. :80) so servers
    // that match on the full host:port value work correctly.
    try {
        const t = new URL(profile.targetUrl);
        const rawPort = profile.targetUrl.match(/^https?:\/\/[^/:]+:(\d+)/)?.[1];
        forwardHeaders.set('host', rawPort ? `${t.hostname}:${rawPort}` : t.hostname);
    } catch {}

    // Set pre-computed auth value (no string concatenation per request)
    if (profile.authHeader && profile.computedAuthValue) {
        forwardHeaders.set(profile.authHeader, profile.computedAuthValue);
    }

    // Capture request body for logging before forwarding
    const reqCapture = await captureRequestBody(req);
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();
    const clientIp = getClientIP(req);

    if (!isIpAllowed(clientIp, profile.allowedIps)) {
        console.warn(`🚫 Proxy "${profileName}": blocked IP ${clientIp}`);
        return jsonResponse(403, { error: 'Forbidden', message: 'Your IP address is not allowed to access this resource.' });
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

    // Build request body for forwarding — use original stream, not the captured string
    const forwardBody = req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined;

    try {
        for (let i = 0; i <= maxRedirects; i++) {
            targetResponse = await fetch(currentUrl, {
                method: i === 0 ? req.method : 'GET', // Redirects become GET
                headers: forwardHeaders,
                body: i === 0 ? forwardBody : undefined,
                redirect: 'manual',
                // @ts-ignore — Bun-specific TLS option
                tls: { rejectUnauthorized: !profile.allowSelfSignedTls && process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
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
        if (!profile.disableLogs) logRequest({
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

    // For HTML responses: buffer once for URL rewriting (required) + logging.
    // For everything else: stream targetResponse.body directly — zero buffering overhead.
    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('text/html')) {
        let html = await targetResponse.text();
        const resBodySize = html.length;

        if (!profile.disableLogs) logRequest({
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
            resBody: html,
            resBodySize,
            durationMs,
        });

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

    // Non-HTML: capture response body for logging, then stream.
    let resCapture: { body: string | null; size: number } = { body: null, size: 0 };
    if (!profile.disableLogs) {
        resCapture = await captureResponseBody(targetResponse);
    }

    if (!profile.disableLogs) logRequest({
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
        resBodySize: resCapture.size || parseInt(targetResponse.headers.get('content-length') || '0', 10),
        durationMs,
    });

    // Set profile cookies only for browser sub-resources (CSS, JS, fonts, images)
    // API clients should not receive or depend on cookies
    if (isBrowser || isAssetRequest(remainingPath, accept)) {
        responseHeaders.append('Set-Cookie', `__proxy_profile=${profileName}; Path=/proxy/${profileName}/; SameSite=Lax`);
        if (validatedAccessKey) {
            responseHeaders.append('Set-Cookie', `__pk_${profileName}=${encodeURIComponent(validatedAccessKey)}; Path=/proxy/${profileName}/; SameSite=Lax`);
        }
    }

    // Stream directly — body is never buffered for non-HTML responses
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
    renderLoginHtml?: (profileName: string, require2fa: boolean) => string
): Promise<Response> {
    const url = new URL(req.url);
    const pathWithSearch = url.pathname + url.search;
    const profileName = profile.name;

    // Pre-compute auth value
    const computedAuthValue = profile.apiKey
        ? (profile.authPrefix ? `${profile.authPrefix} ${profile.apiKey}` : profile.apiKey)
        : '';

    // Detect browser vs API client (used for cookie policy and error responses)
    const accept = req.headers.get('accept') || '';
    const isBrowser = accept.includes('text/html');

    // ── Auth: login mode (JWT-based user authentication) ──
    const effectiveAuthMode = profile.authMode || (profile.accessKey ? 'accessKey' : 'none');

    if (effectiveAuthMode === 'login') {
        // /auth/* routes are handled by proxy-server.ts — never forward to upstream
        if (url.pathname.startsWith('/auth/')) {
            return jsonResponse(404, { error: 'Not Found' });
        }

        const proxyUser = checkProxyLoginAuth(req, profileName);
        if (!proxyUser) {
            if (profile.isWebApp) {
                const isSubResource = isAssetRequest(url.pathname, accept);
                if (isSubResource) {
                    return jsonResponse(401, { error: 'Unauthorized' });
                }
                if (renderLoginHtml) {
                    const html = renderLoginHtml(profile.name, !!profile.require2fa);
                    return new Response(html, {
                        status: 401,
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    });
                }
                const redirectTo = encodeURIComponent(url.pathname + url.search);
                return new Response(null, {
                    status: 302,
                    headers: { 'Location': `/auth/login?redirect=${redirectTo}` },
                });
            }
            return jsonResponse(401, {
                error: 'Unauthorized',
                message: 'Authentication required. Use POST /auth/login with username and password.',
            });
        }
    }

    // ── Access key validation ──
    let validatedAccessKey: string | null = null;
    if (effectiveAuthMode === 'accessKey' && profile.accessKey) {
        const providedKey = url.searchParams.get('key');
        const clientIP = getClientIP(req);

        // A. X-Mid-Api-Key header — for API clients / Postman (no redirect, no cookie)
        const headerKey = req.headers.get('x-mid-api-key');
        if (headerKey === profile.accessKey) {
            validatedAccessKey = profile.accessKey;
        }

        // B. Direct ?key= — redirect to strip key from URL and set cookie first.
        if (!validatedAccessKey && providedKey === profile.accessKey) {
            if (isBrowser) {
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
            validatedAccessKey = profile.accessKey;
        }

        // C. Profile-scoped cookie — only for browser sessions after the initial redirect.
        //    Cookie name includes profileName so different proxies never share auth state.
        if (!validatedAccessKey && isBrowser) {
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
    // Normalize through URL constructor so default ports (http:80, https:443) are
    // stripped — Bun's fetch can behave inconsistently when they are left explicit.
    const rawTargetUrl = profile.forwardPath !== false
        ? profile.targetUrl + url.pathname + url.search
        : profile.targetUrl + url.search;
    let targetUrl = rawTargetUrl;
    try { targetUrl = new URL(rawTargetUrl).href; } catch {}

    // ── Build headers ──
    const forwardHeaders = new Headers();
    req.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'host' && lower !== 'x-forward-token') {
            forwardHeaders.set(key, value);
        }
    });

    // Set Host header explicitly from the original target URL, preserving any
    // explicit port the user configured (e.g. front-uchat:80) so that servers
    // which require the port in the Host header receive it correctly.
    try {
        const t = new URL(profile.targetUrl);
        const rawPort = profile.targetUrl.match(/^https?:\/\/[^/:]+:(\d+)/)?.[1];
        forwardHeaders.set('host', rawPort ? `${t.hostname}:${rawPort}` : t.hostname);
    } catch {}

    if (profile.authHeader && computedAuthValue) {
        forwardHeaders.set(profile.authHeader, computedAuthValue);
    }

    // ── Capture request body ──
    const reqCapture = await captureRequestBody(req);
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();
    const clientIp = getClientIP(req);

    if (!isIpAllowed(clientIp, profile.allowedIps)) {
        console.warn(`🚫 Proxy "${profileName}": blocked IP ${clientIp}`);
        return jsonResponse(403, { error: 'Forbidden', message: 'Your IP address is not allowed to access this resource.' });
    }

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
                // @ts-ignore — Bun-specific TLS option
                tls: { rejectUnauthorized: !profile.allowSelfSignedTls && process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
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

        if (!profile.disableLogs) logRequest({
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

    // Non-HTML: capture response body for logging, then stream.
    let resCapture: { body: string | null; size: number } = { body: null, size: 0 };
    if (!profile.disableLogs) {
        resCapture = await captureResponseBody(targetResponse);
    }

    if (!profile.disableLogs) logRequest({
        requestId, type: 'proxy', profileName,
        method: req.method, path: url.pathname, targetUrl: currentUrl, clientIp,
        reqHeaders: headersToRecord(forwardHeaders),
        reqBody: reqCapture.body, reqBodySize: reqCapture.size,
        resStatus: targetResponse.status, resStatusText: targetResponse.statusText,
        resHeaders: headersToRecord(responseHeaders),
        resBody: resCapture.body,
        resBodySize: resCapture.size || parseInt(targetResponse.headers.get('content-length') || '0', 10),
        durationMs,
    });

    // Set profile-scoped access key cookie only for browser sessions
    // API clients should not receive or depend on cookies
    if (validatedAccessKey && isBrowser) {
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
            message: 'Valid X-Mid-Api-Key header or ?key= parameter is required to access this resource',
        });
    }

    const currentUrl = new URL(req.url);
    const exampleUrl = `${currentUrl.origin}${currentUrl.pathname}?key=YOUR_KEY`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>401 Unauthorized</title>
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
    .wrap { max-width: 480px; width: 100%; }
    .status {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: #555;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      color: #eee;
      margin-bottom: 8px;
      letter-spacing: -.01em;
    }
    .desc {
      font-size: 13px;
      color: #666;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    code {
      font-family: 'SF Mono', ui-monospace, monospace;
      font-size: 11.5px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 4px;
      padding: 1px 5px;
      color: #aaa;
    }
    .section { margin-bottom: 24px; }
    .label {
      font-size: 11px;
      font-weight: 500;
      color: #444;
      letter-spacing: .05em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    pre {
      font-family: 'SF Mono', ui-monospace, monospace;
      font-size: 12px;
      background: #161616;
      border: 1px solid #222;
      border-radius: 6px;
      padding: 14px 16px;
      color: #888;
      overflow-x: auto;
      line-height: 1.7;
    }
    pre .hl { color: #ddd; }
    pre .dim { color: #444; }
    hr { border: none; border-top: 1px solid #1e1e1e; margin: 28px 0; }
    .foot { font-size: 11px; color: #3a3a3a; }
  </style>
</head>
<body>
  <div class="wrap">
    <p class="status">401 &mdash; Unauthorized</p>
    <h1>Authentication required</h1>
    <p class="desc">
      Access to <code>${profileName}</code> is restricted.
      Provide a valid key using one of the methods below.
    </p>

    <div class="section">
      <p class="label">Query parameter</p>
      <pre><span class="hl">${currentUrl.origin}${currentUrl.pathname}</span>?key=<span class="hl">&lt;key&gt;</span></pre>
    </div>

    <div class="section">
      <p class="label">Request header</p>
      <pre>X-Mid-Api-Key<span class="dim">:</span> <span class="hl">&lt;key&gt;</span></pre>
    </div>

    <hr>
    <p class="foot">Browser sessions are persisted via cookie after the first authenticated request.</p>
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
    
    // If the browser explicitly accepts HTML, it is requesting a document, not a sub-resource
    // (Modern browsers include image/webp in the Accept header for documents)
    if (accept && accept.includes('text/html')) return false;

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

