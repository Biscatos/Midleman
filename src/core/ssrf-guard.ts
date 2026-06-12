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

    let addrs: { address: string }[];
    try {
        addrs = await lookup(host, { all: true });
    } catch (err) {
        throw new SsrfBlockedError(`DNS resolution failed for "${host}": ${err instanceof Error ? err.message : err}`);
    }
    if (!addrs.length) throw new SsrfBlockedError(`no addresses resolved for "${host}"`);
    for (const { address } of addrs) {
        const reason = blockedReason(address, policy);
        if (reason) throw new SsrfBlockedError(`${host} resolves to ${reason}`);
    }
}

/** Builds an SsrfPolicyOverride from a webhook's persisted SSRF fields. */
export function webhookSsrfPolicy(w: { allowPrivateTargets?: boolean; targetAllowedCidrs?: string[] }): SsrfPolicyOverride {
    return { allowPrivate: w.allowPrivateTargets, allowedCidrs: w.targetAllowedCidrs };
}
