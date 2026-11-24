// Internal name for a tunnelled web app: "rabbit.apps.example.local" instead of "midleman:4011".
// The company DNS points the name (usually a wildcard record) at Nginx Proxy Manager; here we
// keep the NPM proxy host that forwards that name to the tunnel's port in step with the tunnel.
import { createProxyHost, updateProxyHost, deleteProxyHost } from './client';
import type { NpmProxyHostPayload } from './types';
import { getNpmSettings, isNpmEnabled } from '../core/npm-settings';
import { ipInCidrs } from '../core/ssrf-guard';
import { setTunnelNpmHost, type Tunnel } from '../core/tunnels';

/** Ports where the tunnelled service itself speaks TLS, so NPM must forward with https. */
const TLS_PORTS = new Set([443, 8443]);

/** What Midleman owns on the NPM host. Certificates and access lists set in NPM are left alone on update. */
export function tunnelHostRouting(t: Pick<Tunnel, 'hostname' | 'listenPort' | 'port'>, forwardHost: string) {
    return {
        domain_names: [t.hostname!],
        forward_host: forwardHost,
        forward_port: t.listenPort,
        forward_scheme: (TLS_PORTS.has(t.port) ? 'https' : 'http') as 'http' | 'https',
    };
}

const isMissing = (e: unknown) => /404|not found/i.test(e instanceof Error ? e.message : String(e));

/**
 * Create, update or remove the NPM host of a tunnel after it was saved (`t`) or deleted (`t` null).
 * The tunnel itself is already saved: a problem here comes back as a message for the admin, never as a failure.
 */
export async function syncTunnelHost(t: Tunnel | null, before?: Tunnel): Promise<string | null> {
    const id = before?.npmProxyHostId;
    if (!t || !t.hostname) {
        if (!id) return null;
        if (!isNpmEnabled()) return `Remove the proxy host "${before!.hostname}" in Nginx Proxy Manager by hand — the integration is off.`;
        try { await deleteProxyHost(id); } catch (e) { if (!isMissing(e)) return `Could not remove the NPM host "${before!.hostname}": ${e instanceof Error ? e.message : e}`; }
        if (t) setTunnelNpmHost(t.name, undefined);
        return null;
    }
    const s = getNpmSettings();
    if (!isNpmEnabled() || !s) return `Internal name saved, but the Nginx Proxy Manager integration is off: create a proxy host for ${t.hostname} → port ${t.listenPort} by hand.`;
    if (!s.midlemanPublicHost) return 'Internal name saved, but NPM does not know how to reach Midleman: set "Midleman host" in the Nginx Proxy Manager settings and save the tunnel again.';
    const routing = tunnelHostRouting(t, s.midlemanPublicHost);
    try {
        let host;
        if (id) { try { host = await updateProxyHost(id, routing); } catch (e) { if (!isMissing(e)) throw e; } }
        host ??= await createProxyHost({
            ...routing, certificate_id: null, ssl_forced: false, http2_support: false, hsts_enabled: false,
            block_exploits: false, allow_websocket_upgrade: true, caching_enabled: false,
        } satisfies NpmProxyHostPayload);
        if (host.id !== id) setTunnelNpmHost(t.name, host.id);
    } catch (e) {
        return `Tunnel saved, but NPM refused the host "${t.hostname}": ${e instanceof Error ? e.message : e}`;
    }
    // NPM is now the client of this tunnel: it must be on the allow-list or every visit is refused.
    let npmIp = ''; try { npmIp = new URL(s.url).hostname; } catch { /* no hint */ }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(npmIp) && npmIp !== '127.0.0.1' && !ipInCidrs(npmIp, t.allowedIps)) {
        return `Add ${npmIp} to "Allowed from": visitors of ${t.hostname} arrive through NPM, and the tunnel refuses it today.`;
    }
    return null;
}
