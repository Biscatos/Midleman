// Discovers the icon of an OAuth client app, the way sign-in screens of large
// identity providers show "Sign in to continue to <app>" with the app's logo.
//
// Source: the origins of the client's registered redirect URIs that are not
// local development addresses (localhost, 127.x, ::1 are skipped). API-looking
// hosts (api.*, api-*, *-api) rarely serve a page with an icon, so they are
// tried last. Every candidate's home page HTML is read for
// <link rel="apple-touch-icon"> / <link rel="icon"> (largest declared size
// wins); when none is declared, /favicon.ico is probed. The first origin that
// actually has an icon wins. Results are cached per origin so the sign-in
// page never waits on the network twice.
// Only the discovered URL is returned; the browser loads the image itself
// (the template drops a broken <img> and shows the initials instead).

const OK_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_HTML_BYTES = 256 * 1024;

const cache = new Map<string, { url: string; at: number; ok: boolean }>();
const inflight = new Map<string, Promise<{ url: string; ok: boolean }>>();

/** Development hosts never carry the app's real icon (and are not reachable
 *  from the server anyway): localhost, *.localhost, loopback, 0.0.0.0. */
export function isLocalHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1'
        || /^127\./.test(h) || h === '::ffff:127.0.0.1';
}

/** Hosts that are almost certainly an API rather than the app's site. */
function looksLikeApiHost(hostname: string): boolean {
    const first = hostname.toLowerCase().split('.')[0];
    return first === 'api' || first.startsWith('api-') || first.endsWith('-api') || first.startsWith('api.');
}

/** Redirect URIs on real hosts, in preference order: site-looking hosts first,
 *  API-looking hosts last, original order otherwise. Local development URIs are skipped. */
export function iconSourceUris(redirectUris: string[]): string[] {
    const site: string[] = [], api: string[] = [];
    for (const uri of redirectUris || []) {
        try {
            const u = new URL(uri);
            if ((u.protocol !== 'https:' && u.protocol !== 'http:') || isLocalHost(u.hostname)) continue;
            (looksLikeApiHost(u.hostname) ? api : site).push(uri);
        } catch { /* not a URL */ }
    }
    return [...site, ...api];
}

/** The preferred redirect URI for the app's home/icon (see iconSourceUris). */
export function iconSourceUri(redirectUris: string[]): string | null {
    return iconSourceUris(redirectUris)[0] ?? null;
}

function originOf(uri: string): string | null {
    try {
        const u = new URL(uri);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
    } catch {
        return null;
    }
}

async function readHead(res: Response): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_HTML_BYTES) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        size += value.length;
        // The icon links live in <head>; stop once it is closed.
        if (new TextDecoder().decode(value).toLowerCase().includes('</head>')) break;
    }
    try { await reader.cancel(); } catch { /* already closed */ }
    return new TextDecoder().decode(Buffer.concat(chunks));
}

function attr(tag: string, name: string): string {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
}

/** Best icon href declared in the page head, or '' when none. */
function pickIcon(html: string, base: string): string {
    let best = '';
    let bestScore = -1;
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
        const rel = attr(tag, 'rel').toLowerCase();
        if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
        const href = attr(tag, 'href').trim();
        if (!href || href.startsWith('data:')) continue;
        const sizes = attr(tag, 'sizes').toLowerCase();
        const px = sizes === 'any' ? 512 : Math.max(0, ...(sizes.match(/\d+/g) || ['0']).map(Number));
        // Prefer touch icons (square, opaque, ≥180px) and larger declared sizes; svg scales anywhere.
        const score = (rel.includes('apple-touch-icon') ? 1000 : 0) + (href.endsWith('.svg') ? 600 : 0) + px;
        if (score > bestScore) {
            try { best = new URL(href, base).toString(); bestScore = score; } catch { /* bad href */ }
        }
    }
    return /^https?:\/\//i.test(best) ? best : '';
}

/** Does /favicon.ico actually exist and look like an image? */
async function probeFavicon(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'Midleman-OIDC/1.0 (app icon discovery)' } });
        const type = (res.headers.get('content-type') || '').toLowerCase();
        return res.ok && (type.startsWith('image/') || type.includes('icon') || type === 'application/octet-stream');
    } catch {
        return false;
    }
}

/** { url, ok }: ok = an icon really exists at url (declared in <head>, or /favicon.ico answers). */
async function discover(origin: string): Promise<{ url: string; ok: boolean }> {
    const fallback = origin + '/favicon.ico';
    try {
        const res = await fetch(origin + '/', {
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'Accept': 'text/html', 'User-Agent': 'Midleman-OIDC/1.0 (app icon discovery)' },
        });
        const type = res.headers.get('content-type') || '';
        if (res.ok && type.includes('html')) {
            // Relative hrefs resolve against the final URL after redirects.
            const declared = pickIcon(await readHead(res), res.url || origin + '/');
            if (declared) return { url: declared, ok: true };
        }
    } catch { /* fall through to the favicon probe */ }
    return { url: fallback, ok: await probeFavicon(fallback) };
}

function resolveOrigin(origin: string): Promise<{ url: string; ok: boolean }> {
    const hit = cache.get(origin);
    if (hit && Date.now() - hit.at < (hit.ok ? OK_TTL_MS : FAIL_TTL_MS)) return Promise.resolve({ url: hit.url, ok: hit.ok });
    let p = inflight.get(origin);
    if (!p) {
        p = discover(origin).then(r => {
            cache.set(origin, { url: r.url, at: Date.now(), ok: r.ok });
            inflight.delete(origin);
            return r;
        });
        inflight.set(origin, p);
    }
    return p;
}

/** Icon for a client: the first redirect-URI origin (site hosts before API hosts)
 *  that really has one. Waits at most `waitMs`, then answers with the preferred
 *  origin's /favicon.ico while discovery keeps going in the background. */
export async function getAppIcon(redirectUris: string[], waitMs = 1500): Promise<{ url: string; origin: string }> {
    const origins = [...new Set(iconSourceUris(redirectUris).map(originOf).filter((o): o is string => !!o))];
    if (!origins.length) return { url: '', origin: '' };
    const fallback = { url: origins[0] + '/favicon.ico', origin: origins[0] };
    const all = Promise.all(origins.map(o => resolveOrigin(o))).then(results => {
        const i = results.findIndex(r => r.ok);
        return i >= 0 ? { url: results[i].url, origin: origins[i] } : fallback;
    });
    return Promise.race([all, new Promise<{ url: string; origin: string }>(r => setTimeout(() => r(fallback), waitMs))]);
}

/** Icon URL only (see getAppIcon). */
export async function getAppIconUrl(redirectUris: string[], waitMs = 1500): Promise<string> {
    return (await getAppIcon(redirectUris, waitMs)).url;
}

/** Warm the cache when a client is created or its redirect URIs change. */
export function prefetchAppIcon(redirectUris: string[]): void {
    for (const origin of new Set(iconSourceUris(redirectUris).map(originOf).filter((o): o is string => !!o))) {
        cache.delete(origin); void resolveOrigin(origin);
    }
}
