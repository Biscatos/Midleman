/**
 * SSRF guard for outbound requests to user/admin-configured destinations
 * (webhook fan-out targets, etc.).
 *
 * Two layers:
 *  1. Syntactic check (assertSafeOutboundUrl) — scheme must be http/https and,
 *     when the host is an IP literal, it must not fall in a blocked range.
 *     Cheap; run at config-validation time.
 *  2. Resolved check (assertResolvedHostAllowed) — resolves the hostname via DNS
 *     and verifies every resolved address. Run immediately before dispatch to
 *     defeat DNS-rebinding (a name that resolved public at config time but points
 *     at 169.254.169.254 at request time).
 *
 * Because Midleman legitimately relays to internal services (e.g. FusionPBX),
 * private ranges (RFC1918, CGNAT, ULA) are ALLOWED BY DEFAULT. This can be
 * tightened globally or per-webhook:
 *   WEBHOOK_ALLOW_PRIVATE_TARGETS=false       → block private ranges globally
 *   per-webhook allowPrivateTargets=false     → block them for one webhook (UI)
 *   WEBHOOK_TARGET_ALLOWED_CIDRS=10.0.0.0/8,… → explicit allowlist (overrides
 *                                               every block, including loopback)
 * Loopback, link-local (incl. the cloud metadata IP 169.254.169.254) and the
 * unspecified address are ALWAYS blocked unless explicitly allowlisted, because
 * they are never legitimate webhook destinations — even when private ranges are
 * allowed.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export class SsrfBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SsrfBlockedError';
    }
}

/** Transient DNS failure — NOT a policy block; callers may retry. */
export class DnsResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DnsResolutionError';
    }
}

// Resolver results are cached so a flaky upstream DNS (EAI_AGAIN from the
// Docker embedded resolver is the usual culprit) does not fail deliveries that
// resolved fine a minute ago. A fresh hit is reused for DNS_CACHE_TTL_MS; on
// resolver failure a stale hit (up to DNS_STALE_MAX_MS) is used instead of
// giving up — the addresses were validated against the policy when cached.
const DNS_CACHE_TTL_MS = 60_000;
const DNS_STALE_MAX_MS = 6 * 60 * 60_000;
const DNS_RETRY_DELAYS_MS = [200, 600, 1500];
const dnsCache = new Map<string, { addrs: string[]; at: number }>();

async function resolveWithRetry(host: string): Promise<string[]> {
    const cached = dnsCache.get(host);
    if (cached && Date.now() - cached.at < DNS_CACHE_TTL_MS) return cached.addrs;
    let lastErr: unknown;
    for (let i = 0; i <= DNS_RETRY_DELAYS_MS.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, DNS_RETRY_DELAYS_MS[i - 1]));
        try {
            const addrs = (await lookup(host, { all: true })).map(a => a.address);
            if (addrs.length) { dnsCache.set(host, { addrs, at: Date.now() }); return addrs; }
            lastErr = new Error('no addresses');
        } catch (err) {
            lastErr = err;
            const code = (err as any)?.code;
            // Definitive answers (name does not exist) are not worth retrying.
            if (code === 'ENOTFOUND') break;
        }
    }
    if (cached && Date.now() - cached.at < DNS_STALE_MAX_MS) {
        console.warn(`🌐 [dns] resolver failing for "${host}" (${(lastErr as any)?.code || lastErr}); using cached address(es) from ${Math.round((Date.now() - cached.at) / 1000)}s ago`);
        return cached.addrs;
    }
    throw new DnsResolutionError(`DNS resolution failed for "${host}": ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inV4Cidr(ip: string, cidr: string): boolean {
    const [addr, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    const ipInt = ipv4ToInt(ip);
    const baseInt = ipv4ToInt(addr);
    if (ipInt === null || baseInt === null || isNaN(prefix)) return false;
    if (prefix === 0) return true;
    const mask = (~0 << (32 - prefix)) >>> 0;
    return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

// Never legitimate as an outbound destination.
const V4_ALWAYS_BLOCK = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '255.255.255.255/32'];
// Private/internal — blocked by default, opt-in via env.
const V4_PRIVATE = ['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15'];

/** True when the IPv4 address is in any of the CIDRs (bare addresses count as /32). Non-v4 input → false. */
export function ipInCidrs(ip: string, cidrs: string[]): boolean {
    return cidrs.some(c => inV4Cidr(ip, c.includes('/') ? c : c + '/32'));
}
/** Loopback, link-local or RFC1918/CGNAT — i.e. a client that did not come in from the internet. */
export function isPrivateOrLoopbackV4(ip: string): boolean {
    const v4 = ip.replace(/^::ffff:/, '');
    return v4 === '::1' || ip === '::1' || ipInCidrs(v4, [...V4_ALWAYS_BLOCK, ...V4_PRIVATE]);
}

export interface SsrfPolicy {
    allowPrivate: boolean;
    allowedCidrs: string[];
}

/** Per-call policy override, typically supplied per-webhook from the UI. */
export interface SsrfPolicyOverride {
    allowPrivate?: boolean;
    allowedCidrs?: string[];
}

let _envPolicy: SsrfPolicy | null = null;
function getEnvPolicy(): SsrfPolicy {
    if (!_envPolicy) {
        _envPolicy = {
            // Private/internal RFC1918/ULA ranges are ALLOWED by default — Midleman
            // is commonly used to relay to internal services (e.g. FusionPBX). Set
            // WEBHOOK_ALLOW_PRIVATE_TARGETS=false to lock this down globally.
            // Loopback and link-local/metadata stay blocked regardless (see blockedReason).
            allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS !== 'false',
            allowedCidrs: (process.env.WEBHOOK_TARGET_ALLOWED_CIDRS || '')
                .split(/[\n,]+/).map(s => s.trim()).filter(Boolean),
        };
    }
    return _envPolicy;
}

/** Resolves the effective policy: per-call override wins per field, else the
 *  global env default. */
function resolvePolicy(override?: SsrfPolicyOverride): SsrfPolicy {
    const env = getEnvPolicy();
    return {
        allowPrivate: override?.allowPrivate ?? env.allowPrivate,
        allowedCidrs: override?.allowedCidrs && override.allowedCidrs.length ? override.allowedCidrs : env.allowedCidrs,
    };
}

/** Normalises an IPv4-mapped IPv6 address (::ffff:a.b.c.d) to its IPv4 form. */
function unmapV4(ip: string): string {
    const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return m ? m[1] : ip;
}

/** Classifies a resolved IP literal. Returns null if allowed, or a reason string. */
function blockedReason(rawIp: string, policy: SsrfPolicy): string | null {
    const ip = unmapV4(rawIp);

    // Explicit allowlist overrides every block.
    const v4 = isIP(ip) === 4;
    if (v4 && policy.allowedCidrs.some(c => c.includes('/') ? inV4Cidr(ip, c) : ip === c)) return null;
    if (!v4 && policy.allowedCidrs.includes(ip)) return null;

    if (v4) {
        if (V4_ALWAYS_BLOCK.some(c => inV4Cidr(ip, c))) return `blocked address ${ip} (loopback/link-local/reserved)`;
        if (V4_PRIVATE.some(c => inV4Cidr(ip, c))) {
            return policy.allowPrivate ? null : `private address ${ip} blocked (enable "Allow private/internal destinations" for this webhook to permit)`;
        }
        return null;
    }

    // IPv6
    const lower = ip.toLowerCase();
    if (lower === '::1') return 'blocked IPv6 loopback (::1)';
    if (lower === '::' || lower === '::0') return 'blocked IPv6 unspecified (::)';
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
        return `blocked IPv6 link-local ${ip}`; // fe80::/10
    }
    if (/^f[cd]/.test(lower)) { // fc00::/7 unique-local
        return policy.allowPrivate ? null : `IPv6 unique-local ${ip} blocked (enable "Allow private/internal destinations" for this webhook to permit)`;
    }
    return null;
}

/**
 * Syntactic validation for a destination URL. Enforces http/https and rejects
 * IP-literal hosts that fall in a blocked range. Does NOT resolve DNS — use
 * assertResolvedHostAllowed at dispatch time for that. Throws SsrfBlockedError.
 */
export function assertSafeOutboundUrl(rawUrl: string, override?: SsrfPolicyOverride): URL {
    const policy = resolvePolicy(override);
    let u: URL;
    try { u = new URL(rawUrl); } catch { throw new SsrfBlockedError(`invalid URL: ${rawUrl}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new SsrfBlockedError(`unsupported scheme "${u.protocol}" (only http/https allowed)`);
    }
    let host = u.hostname;
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host.toLowerCase() === 'localhost') {
        if (!policy.allowedCidrs.length && !policy.allowPrivate) throw new SsrfBlockedError('blocked host "localhost"');
    }
    if (isIP(host)) {
        const reason = blockedReason(host, policy);
        if (reason) throw new SsrfBlockedError(reason);
    }
    return u;
}

/**
 * Dispatch-time check: resolves the hostname and verifies every resolved
 * address against the policy. Throws SsrfBlockedError on any blocked address.
 * Call immediately before fetch() to defeat DNS rebinding.
 */
export async function assertResolvedHostAllowed(rawUrl: string, override?: SsrfPolicyOverride): Promise<void> {
    const policy = resolvePolicy(override);
    const u = assertSafeOutboundUrl(rawUrl, override);
    let host = u.hostname;
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

    // IP literal already fully checked syntactically.
    if (isIP(host)) return;

    const addrs = await resolveWithRetry(host);
    for (const address of addrs) {
        const reason = blockedReason(address, policy);
        if (reason) throw new SsrfBlockedError(`${host} resolves to ${reason}`);
    }
}

/** Builds an SsrfPolicyOverride from a webhook's persisted SSRF fields. */
export function webhookSsrfPolicy(w: { allowPrivateTargets?: boolean; targetAllowedCidrs?: string[] }): SsrfPolicyOverride {
    return { allowPrivate: w.allowPrivateTargets, allowedCidrs: w.targetAllowedCidrs };
}
