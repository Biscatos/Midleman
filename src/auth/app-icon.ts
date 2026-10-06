// Discovers the icon of an OAuth client app, the way sign-in screens of large
// identity providers show "Sign in to continue to <app>" with the app's logo.
//
// Source: the origin of the client's FIRST registered redirect URI. The home
// page HTML is read for <link rel="apple-touch-icon"> / <link rel="icon">
// (largest declared size wins), falling back to /favicon.ico. Results are
// cached per origin so the sign-in page never waits on the network twice.
// Only the discovered URL is returned; the browser loads the image itself
// (the template drops a broken <img> and shows the initials instead).

const OK_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_HTML_BYTES = 256 * 1024;

const cache = new Map<string, { url: string; at: number; ok: boolean }>();
const inflight = new Map<string, Promise<string>>();

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

async function discover(origin: string): Promise<string> {
    const fallback = origin + '/favicon.ico';
    try {
        const res = await fetch(origin + '/', {
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'Accept': 'text/html', 'User-Agent': 'Midleman-OIDC/1.0 (app icon discovery)' },
        });
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.includes('html')) return fallback;
        // Relative hrefs resolve against the final URL after redirects.
        return pickIcon(await readHead(res), res.url || origin + '/') || fallback;
    } catch {
        return fallback;
    }
}

function resolveOrigin(origin: string): Promise<string> {
    const hit = cache.get(origin);
    if (hit && Date.now() - hit.at < (hit.ok ? OK_TTL_MS : FAIL_TTL_MS)) return Promise.resolve(hit.url);
    let p = inflight.get(origin);
    if (!p) {
        p = discover(origin).then(url => {
            cache.set(origin, { url, at: Date.now(), ok: !url.endsWith('/favicon.ico') });
            inflight.delete(origin);
            return url;
        });
        inflight.set(origin, p);
    }
    return p;
}

/** Icon URL for a client, from its first redirect URI. Waits at most `waitMs`
 *  for a first discovery (then answers with /favicon.ico and keeps discovering). */
export async function getAppIconUrl(redirectUris: string[], waitMs = 1500): Promise<string> {
    const origin = originOf(redirectUris[0] || '');
    if (!origin) return '';
    const fallback = origin + '/favicon.ico';
    return Promise.race([resolveOrigin(origin), new Promise<string>(r => setTimeout(() => r(fallback), waitMs))]);
}

/** Warm the cache when a client is created or its redirect URIs change. */
export function prefetchAppIcon(redirectUris: string[]): void {
    const origin = originOf(redirectUris[0] || '');
    if (origin) { cache.delete(origin); void resolveOrigin(origin); }
}
