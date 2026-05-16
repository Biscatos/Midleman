// Pure transformations between Midleman profiles and NPM payloads.

import type { ProxyProfile } from '../core/types.js';
import type { NpmProxyHostPayload, NpmCertificatePayload } from './types.js';

export interface MapperContext {
    /** Hostname (or IP) that NPM uses as forward_host. Usually a docker service name. */
    midlemanPublicHost: string;
    /** Fallback port when the profile has no dedicated `port`. */
    defaultBunPort: number;
}

/**
 * Build the NPM proxy-host payload for a profile.
 * - When the profile has a dedicated `port`, NPM forwards directly to it.
 * - Otherwise it forwards to the main Midleman port using a /proxy/{name}/
 *   path prefix injected via advanced_config so the existing path router still works.
 */
export function profileToNpmHost(profile: ProxyProfile, ctx: MapperContext): NpmProxyHostPayload {
    const hostnames = (profile.publicHostnames || []).map(h => h.trim().toLowerCase()).filter(Boolean);
    const dedicatedPort = typeof profile.port === 'number' && profile.port > 0;
    const forwardPort = dedicatedPort ? profile.port! : ctx.defaultBunPort;

    // When using the shared main port, inject a /proxy/{name}/ rewrite via advanced_config.
    const baseAdvanced = profile.advancedConfig?.trim() || '';
    const injectedAdvanced = dedicatedPort
        ? baseAdvanced
        : [
            `location / { proxy_pass http://${ctx.midlemanPublicHost}:${ctx.defaultBunPort}/proxy/${profile.name}$request_uri; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Midleman-Profile ${profile.name}; }`,
            baseAdvanced,
        ].filter(Boolean).join('\n');

    const useAcme = profile.tlsMode === 'auto-acme' && typeof profile.npmCertificateId === 'number';
    const useManual = profile.tlsMode === 'manual' && typeof profile.npmCertificateId === 'number';
    const certificateId: number | null = (useAcme || useManual) ? profile.npmCertificateId! : null;

    const locations = (profile.npmLocations || []).map(loc => ({
        path: loc.path,
        forward_scheme: loc.forwardScheme || 'http',
        forward_host: loc.forwardHost,
        forward_port: loc.forwardPort,
        advanced_config: loc.advancedConfig || '',
    }));

    return {
        domain_names: hostnames,
        forward_host: ctx.midlemanPublicHost,
        forward_port: forwardPort,
        forward_scheme: 'http',
        certificate_id: certificateId,
        ssl_forced: !!profile.sslForced && certificateId !== null,
        http2_support: profile.http2 !== false && certificateId !== null,
        hsts_enabled: !!profile.hstsEnabled && certificateId !== null,
        advanced_config: injectedAdvanced || undefined,
        block_exploits: true,
        allow_websocket_upgrade: profile.allowWebsocketUpgrade !== false,
        locations: locations.length > 0 ? locations : undefined,
        meta: { midleman_profile: profile.name },
    };
}

/** Builds the Let's Encrypt certificate payload for NPM. */
export function profileToCertPayload(profile: ProxyProfile, email: string, staging = false): NpmCertificatePayload {
    return {
        provider: 'letsencrypt',
        nice_name: `midleman:${profile.name}`,
        domain_names: (profile.publicHostnames || []).map(h => h.trim().toLowerCase()),
        meta: {
            letsencrypt_agree: true,
            letsencrypt_email: email,
            ...(staging ? { dns_challenge: false } : {}),
        },
    };
}

/** True when the profile should be synced to NPM (has hostnames + NPM integration enabled by caller). */
export function shouldSync(profile: ProxyProfile): boolean {
    return Array.isArray(profile.publicHostnames) && profile.publicHostnames.length > 0;
}
