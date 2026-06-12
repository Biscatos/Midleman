/**
 * IP allowlist filtering — supports exact IPs, CIDR ranges, and wildcards.
 * IPv4 only for CIDR/wildcard; IPv6 addresses are matched by exact string equality only.
 */

function ipToInt(ip: string): number | null {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Returns true if `clientIp` matches `rule`.
 * Supported rule formats:
 *  - Exact:    "10.0.0.1"
 *  - CIDR:     "10.0.0.0/8", "192.168.1.0/24"
 *  - Wildcard: "192.168.1.*", "10.0.*.*"
 */
function ipMatchesRule(clientIp: string, rule: string): boolean {
    const trimmed = rule.trim();
    if (!trimmed) return false;

    // Wildcard — convert to CIDR equivalent by counting fixed octets
    if (trimmed.includes('*')) {
        const octets = trimmed.split('.');
        const fixedCount = octets.findIndex(o => o === '*');
        if (fixedCount < 0) return clientIp === trimmed;
        const prefix = fixedCount * 8;
        const base = octets.slice(0, fixedCount).concat(['0', '0', '0', '0']).slice(0, 4).join('.');
        return ipMatchesRule(clientIp, `${base}/${prefix}`);
    }

    // CIDR
    if (trimmed.includes('/')) {
        const [addr, prefixStr] = trimmed.split('/');
        const prefix = parseInt(prefixStr, 10);
        if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
        const ruleInt = ipToInt(addr);
        const clientInt = ipToInt(clientIp);
        if (ruleInt === null || clientInt === null) return false;
        if (prefix === 0) return true;
        const mask = (~0 << (32 - prefix)) >>> 0;
        return ((ruleInt & mask) >>> 0) === ((clientInt & mask) >>> 0);
    }

    // Exact match (works for both IPv4 and IPv6)
    return clientIp === trimmed;
}

/**
 * Returns true if `clientIp` is permitted by the allowlist.
 * An empty or undefined allowlist means unrestricted access.
 */
export function isIpAllowed(clientIp: string, allowedIps: string[] | undefined): boolean {
    if (!allowedIps || allowedIps.length === 0) return true;
    return allowedIps.some(rule => ipMatchesRule(clientIp, rule));
}

/**
 * Normalise a raw allowlist string (comma or newline separated) into a clean array.
 */
export function parseAllowedIps(raw: string): string[] {
    return raw
        .split(/[\n,]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

// ─── Trusted-proxy resolution ──────────────────────────────────────────────────
//
// `X-Forwarded-For` is attacker-controllable, so it must only be trusted when the
// immediate socket peer is a reverse proxy we operate. Configure via the
// TRUST_PROXY env var:
//   - unset / "false"  → ignore XFF entirely, use the real socket peer IP (secure default)
//   - "true" / "*"     → trust any peer (ONLY safe when the app port is not directly
//                        reachable from clients, e.g. bound to a private docker network)
//   - CIDR/IP list     → trust XFF only when the peer matches one of these
//                        (e.g. "10.0.0.0/8,172.18.0.0/16")

export interface TrustProxyConfig {
    trustAll: boolean;
    cidrs: string[];
}

export function parseTrustProxy(raw: string | undefined): TrustProxyConfig {
    const t = (raw || '').trim();
    if (!t || t === 'false') return { trustAll: false, cidrs: [] };
    if (t === 'true' || t === '*') return { trustAll: true, cidrs: [] };
    return { trustAll: false, cidrs: parseAllowedIps(t) };
}

let _trustCfg: TrustProxyConfig | null = null;
/** Lazily reads TRUST_PROXY from the environment (cached for the process). */
export function getTrustProxyConfig(): TrustProxyConfig {
    if (!_trustCfg) _trustCfg = parseTrustProxy(process.env.TRUST_PROXY);
    return _trustCfg;
}

function isTrustedProxy(ip: string, cfg: TrustProxyConfig): boolean {
    if (cfg.trustAll) return true;
    return cfg.cidrs.some(rule => ipMatchesRule(ip, rule));
}

/**
 * Resolve the real client IP from the socket peer and the X-Forwarded-For chain.
 * XFF is only consulted when the immediate peer is a trusted proxy; otherwise the
 * peer address itself is authoritative. When trusted, the rightmost address in
 * the chain that is NOT itself a trusted proxy is returned (the real client as
 * seen by our edge), defeating client-supplied spoofing of leftmost entries.
 */
export function resolveClientIp(
    peerIp: string | null | undefined,
    xff: string | null | undefined,
    cfg: TrustProxyConfig = getTrustProxyConfig(),
): string {
    const peer = (peerIp || '').trim() || 'unknown';
    if (!xff || (!cfg.trustAll && !isTrustedProxy(peer, cfg))) return peer;
    const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
        if (!isTrustedProxy(hops[i], cfg)) return hops[i];
    }
    // Every hop was a trusted proxy: the leftmost is the originating client.
    return hops[0] || peer;
}
