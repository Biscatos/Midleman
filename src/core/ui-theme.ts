// Shared visual identity for every HTML surface Midleman serves.
//
// The dashboard loads /dashboard/css/theme.css directly, but the standalone
// pages (OAuth on the OIDC port, proxy login on each proxy port, invites,
// password reset, error pages) are served by servers that do not expose the
// dashboard's static routes. Those templates carry a `<!-- MM_THEME -->`
// marker in <head>; `withTheme()` swaps it for the fonts, the inlined token
// sheet and the SVG favicon, so every page renders from the same tokens.

import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

const VIEWS = resolve(import.meta.dir, '../views');
const THEME_PATH = resolve(VIEWS, 'css/theme.css');

export const MM_THEME_MARKER = '<!-- MM_THEME -->';

/** The logo: a faceted owl — flat polygons in two blues, white eyes. 64×64, self-coloured. */
export const LOGO_GLYPH_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><polygon points="14,8 26,16 18,24" fill="#1E6FAE"/><polygon points="50,8 38,16 46,24" fill="#1E6FAE"/><polygon points="18,24 26,16 38,16 46,24 48,46 32,58 16,46" fill="#2A8BD4"/><polygon points="16,46 18,24 8,40" fill="#1E6FAE"/><polygon points="48,46 46,24 56,40" fill="#1E6FAE"/><polygon points="26,16 38,16 32,22" fill="#1E6FAE"/><polygon points="22,40 32,58 42,40 32,46" fill="#5FB0EA"/><circle cx="25" cy="29" r="6" fill="#fff"/><circle cx="39" cy="29" r="6" fill="#fff"/><circle cx="25.8" cy="29.5" r="2.8" fill="#1E6FAE"/><circle cx="38.2" cy="29.5" r="2.8" fill="#1E6FAE"/><polygon points="29.5,35 34.5,35 32,40" fill="#1E6FAE"/><polygon points="26,58 30,58 28,62" fill="#1E6FAE"/><polygon points="34,58 38,58 36,62" fill="#1E6FAE"/></svg>';

/** Square mark (glyph inside the bordered tile). Size it with `font-size` on the parent. */
export const LOGO_MARK_HTML = `<span class="mm-mark">${LOGO_GLYPH_SVG}</span>`;

// Favicon: the owl itself — self-coloured, so it reads the same on light and dark tabs.
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><polygon points="14,8 26,16 18,24" fill="#1E6FAE"/><polygon points="50,8 38,16 46,24" fill="#1E6FAE"/><polygon points="18,24 26,16 38,16 46,24 48,46 32,58 16,46" fill="#2A8BD4"/><polygon points="16,46 18,24 8,40" fill="#1E6FAE"/><polygon points="48,46 46,24 56,40" fill="#1E6FAE"/><polygon points="26,16 38,16 32,22" fill="#1E6FAE"/><polygon points="22,40 32,58 42,40 32,46" fill="#5FB0EA"/><circle cx="25" cy="29" r="6" fill="#fff"/><circle cx="39" cy="29" r="6" fill="#fff"/><circle cx="25.8" cy="29.5" r="2.8" fill="#1E6FAE"/><circle cx="38.2" cy="29.5" r="2.8" fill="#1E6FAE"/><polygon points="29.5,35 34.5,35 32,40" fill="#1E6FAE"/><polygon points="26,58 30,58 28,62" fill="#1E6FAE"/><polygon points="34,58 38,58 36,62" fill="#1E6FAE"/></svg>';
export const FAVICON_DATA_URI = 'data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG);

export const FONT_LINKS =
    '<link rel="preconnect" href="https://fonts.googleapis.com">'
    + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">';

let cache: { mtimeMs: number; css: string } | null = null;

/** theme.css contents, re-read only when the file changes (cheap per request). */
export function themeCss(): string {
    try {
        const { mtimeMs } = statSync(THEME_PATH);
        if (!cache || cache.mtimeMs !== mtimeMs) cache = { mtimeMs, css: readFileSync(THEME_PATH, 'utf-8') };
        return cache.css;
    } catch {
        return cache?.css ?? '';
    }
}

/** <head> fragment for a standalone page: fonts + inlined tokens + favicon. */
export function themeHead(opts: { favicon?: boolean } = {}): string {
    const fav = opts.favicon === false ? '' : `<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">`;
    return `${fav}${FONT_LINKS}<style>${themeCss()}</style>`;
}

/** Replace the MM_THEME marker in a template. Templates without it are returned unchanged. */
export function withTheme(html: string, opts: { favicon?: boolean } = {}): string {
    return html.includes(MM_THEME_MARKER) ? html.replace(MM_THEME_MARKER, themeHead(opts)) : html;
}

/** Short content hash of the dashboard assets, used as `?v=` to bust browser caches on deploy. */
let assetVersion: string | null = null;
export function dashboardAssetVersion(): string {
    if (assetVersion) return assetVersion;
    const h = createHash('sha1');
    for (const f of ['css/theme.css', 'css/dashboard.css', 'css/request-detail.css', 'js/dashboard-app.js', 'js/dashboard-data.js', 'js/dashboard-charts.js', 'js/wizard.js', 'js/ui-select.js']) {
        try { h.update(readFileSync(resolve(VIEWS, f))); } catch { /* missing file → still versioned */ }
    }
    assetVersion = h.digest('hex').slice(0, 10);
    return assetVersion;
}
