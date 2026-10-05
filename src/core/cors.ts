// Per-profile CORS policy for HTTP proxies.
//
// When enabled on a profile, Midleman becomes the CORS authority for that
// proxy: it answers preflight (OPTIONS + Access-Control-Request-Method)
// itself without touching the upstream, and it rewrites the CORS headers of
// every response so only the configured origins are allowed — whatever the
// upstream says. When disabled, nothing changes and upstream headers pass
// through untouched.

export interface ProxyCorsConfig {
    enabled: boolean;
    /** Allowed origins: exact ("https://app.example.com"), "*" (any), or a
     *  single-label wildcard ("https://*.example.com"). Compared case-insensitively. */
    allowedOrigins: string[];
    /** Default: GET, POST, PUT, PATCH, DELETE, OPTIONS */
    allowedMethods?: string[];
    /** Default: echo Access-Control-Request-Headers from the preflight. */
    allowedHeaders?: string[];
    /** Response headers the browser may read (Access-Control-Expose-Headers). */
    exposedHeaders?: string[];
    /** Send Access-Control-Allow-Credentials: true. Never combined with "*". */
    allowCredentials?: boolean;
    /** Preflight cache in seconds (Access-Control-Max-Age). Default 600. */
    maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_MAX_AGE = 600;

function normalizeOrigin(o: string): string {
    return o.trim().toLowerCase().replace(/\/+$/, '');
}

/** Does `origin` match one of the configured patterns? Returns the matched
 *  pattern, or null. "*" matches anything (including a missing Origin). */
export function matchCorsOrigin(cfg: ProxyCorsConfig, origin: string | null): string | null {
    const patterns = cfg.allowedOrigins || [];
    if (patterns.some(p => p.trim() === '*')) return '*';
    if (!origin) return null;
    const o = normalizeOrigin(origin);
    for (const raw of patterns) {
        const p = normalizeOrigin(raw);
        if (!p) continue;
        if (p === o) return raw;
        // Subdomain wildcard: "https://*.example.com" matches "https://a.example.com"
        // and "https://a.b.example.com" but NOT "https://example.com".
        const star = p.indexOf('*');
        if (star >= 0) {
            const prefix = p.slice(0, star);
            const suffix = p.slice(star + 1);
            if (o.startsWith(prefix) && o.endsWith(suffix) && o.length > prefix.length + suffix.length) return raw;
        }
    }
    return null;
}

export function isCorsPreflight(req: Request): boolean {
    return req.method === 'OPTIONS'
        && !!req.headers.get('origin')
        && !!req.headers.get('access-control-request-method');
}

/** Headers to put on an actual (non-preflight) response. Empty when the
 *  origin is not allowed — the browser then blocks the response. */
export function corsHeadersFor(cfg: ProxyCorsConfig, req: Request): Record<string, string> {
    const origin = req.headers.get('origin');
    const matched = matchCorsOrigin(cfg, origin);
    if (!matched) return {};
    const h: Record<string, string> = {};
    // With credentials the spec forbids "*": echo the concrete origin instead.
    if (matched === '*' && !cfg.allowCredentials) {
        h['Access-Control-Allow-Origin'] = '*';
    } else {
        h['Access-Control-Allow-Origin'] = origin || '*';
        h['Vary'] = 'Origin';
    }
    if (cfg.allowCredentials) h['Access-Control-Allow-Credentials'] = 'true';
    if (cfg.exposedHeaders?.length) h['Access-Control-Expose-Headers'] = cfg.exposedHeaders.join(', ');
    return h;
}

/** Build the preflight response, or null when this is not a preflight. */
export function corsPreflightResponse(cfg: ProxyCorsConfig, req: Request): Response | null {
    if (!cfg.enabled || !isCorsPreflight(req)) return null;
    const origin = req.headers.get('origin');
    const matched = matchCorsOrigin(cfg, origin);
    if (!matched) {
        return new Response(JSON.stringify({ error: 'Forbidden', message: 'Origin not allowed by CORS policy.' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', 'Vary': 'Origin' },
        });
    }
    const methods = (cfg.allowedMethods?.length ? cfg.allowedMethods : DEFAULT_METHODS).map(m => m.toUpperCase());
    const requested = req.headers.get('access-control-request-method')?.toUpperCase() || '';
    if (requested && !methods.includes(requested)) {
        return new Response(JSON.stringify({ error: 'Forbidden', message: `Method ${requested} not allowed by CORS policy.` }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', 'Vary': 'Origin' },
        });
    }
    const headers = new Headers(corsHeadersFor(cfg, req));
    headers.set('Access-Control-Allow-Methods', methods.join(', '));
    const reqHeaders = req.headers.get('access-control-request-headers');
    if (cfg.allowedHeaders?.length) headers.set('Access-Control-Allow-Headers', cfg.allowedHeaders.join(', '));
    else if (reqHeaders) headers.set('Access-Control-Allow-Headers', reqHeaders);
    headers.set('Access-Control-Max-Age', String(cfg.maxAge && cfg.maxAge > 0 ? Math.floor(cfg.maxAge) : DEFAULT_MAX_AGE));
    headers.set('Content-Length', '0');
    headers.append('Vary', 'Access-Control-Request-Method');
    headers.append('Vary', 'Access-Control-Request-Headers');
    return new Response(null, { status: 204, headers });
}

/** Replace whatever CORS headers the upstream sent with ours. Returns the
 *  same Response when its headers are mutable, otherwise a shallow copy. */
export function applyCorsToResponse(cfg: ProxyCorsConfig | undefined, req: Request, res: Response): Response {
    if (!cfg?.enabled) return res;
    const ours = corsHeadersFor(cfg, req);
    let headers = res.headers;
    let out = res;
    try {
        headers.delete('access-control-allow-origin');
    } catch {
        headers = new Headers(res.headers);
        out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    for (const k of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-expose-headers', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']) {
        headers.delete(k);
    }
    for (const [k, v] of Object.entries(ours)) {
        if (k.toLowerCase() === 'vary') headers.append('Vary', v); else headers.set(k, v);
    }
    return out;
}

/** Validate a cors object coming from the admin API. Returns an error string or null. */
export function validateCorsInput(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) return '"cors" must be an object';
    const c = v as Record<string, unknown>;
    if (typeof c.enabled !== 'boolean') return '"cors.enabled" must be a boolean';
    if (!Array.isArray(c.allowedOrigins) || c.allowedOrigins.some(o => typeof o !== 'string')) return '"cors.allowedOrigins" must be an array of strings';
    const origins = (c.allowedOrigins as string[]).map(s => s.trim()).filter(Boolean);
    if (c.enabled && origins.length === 0) return '"cors.allowedOrigins" needs at least one origin (or "*") when CORS is enabled';
    for (const o of origins) {
        if (o === '*') continue;
        if (!/^https?:\/\/[^/\s]+$/i.test(o)) return `"cors.allowedOrigins": "${o}" must be an origin like https://app.example.com (no path), "*", or https://*.example.com`;
        if ((o.match(/\*/g) || []).length > 1) return `"cors.allowedOrigins": "${o}" may contain at most one "*"`;
    }
    for (const key of ['allowedMethods', 'allowedHeaders', 'exposedHeaders'] as const) {
        if (c[key] !== undefined && (!Array.isArray(c[key]) || (c[key] as unknown[]).some(x => typeof x !== 'string'))) return `"cors.${key}" must be an array of strings`;
    }
    if (c.allowCredentials !== undefined && typeof c.allowCredentials !== 'boolean') return '"cors.allowCredentials" must be a boolean';
    if (c.allowCredentials === true && origins.includes('*')) return '"cors.allowCredentials" cannot be combined with the "*" origin — list the origins explicitly';
    if (c.maxAge !== undefined && (typeof c.maxAge !== 'number' || !Number.isFinite(c.maxAge) || c.maxAge < 0 || c.maxAge > 86400)) return '"cors.maxAge" must be a number of seconds between 0 and 86400';
    return null;
}

/** Normalise an admin-supplied cors object into the stored shape. */
export function normalizeCorsInput(v: Record<string, unknown>): ProxyCorsConfig {
    const list = (x: unknown) => Array.isArray(x) ? (x as unknown[]).map(s => String(s).trim()).filter(Boolean) : [];
    const cfg: ProxyCorsConfig = {
        enabled: v.enabled === true,
        allowedOrigins: list(v.allowedOrigins),
    };
    const m = list(v.allowedMethods).map(s => s.toUpperCase()); if (m.length) cfg.allowedMethods = m;
    const h = list(v.allowedHeaders); if (h.length) cfg.allowedHeaders = h;
    const e = list(v.exposedHeaders); if (e.length) cfg.exposedHeaders = e;
    if (v.allowCredentials === true) cfg.allowCredentials = true;
    if (typeof v.maxAge === 'number' && v.maxAge >= 0) cfg.maxAge = Math.floor(v.maxAge);
    return cfg;
}
