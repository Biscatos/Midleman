// Idempotent reconciler: ensures the NPM proxy-host/certificate state matches
// the Midleman profile state. Safe to call on every profile save, on startup,
// and manually from the dashboard.
//
// Failure mode: every method swallows errors into a {ok, error} result so a
// failing NPM call never blocks profile persistence. The caller logs and
// updates the profile's lastSyncError field. Retries are debounced upstream.

import type { ProxyProfile } from '../core/types.js';
import { getNpmSettings, isNpmEnabled } from '../core/npm-settings.js';
import { persistProfiles } from '../core/store.js';
import * as npm from './client.js';
import { profileToNpmHost, profileToCertPayload, shouldSync } from './mapper.js';
import { NpmError } from './client.js';
import { getProxyServerPort } from '../servers/proxy-server.js';

export interface SyncResult {
    ok: boolean;
    action?: 'created' | 'updated' | 'deleted' | 'skipped' | 'noop';
    proxyHostId?: number;
    certificateId?: number;
    error?: string;
}

const DEFAULT_BUN_PORT = Number(process.env.PORT) || 3000;

function getMidlemanHost(): string {
    return getNpmSettings()?.midlemanPublicHost || process.env.MIDLEMAN_PUBLIC_HOST || 'midleman';
}

function acmeEmail(profile: ProxyProfile): string {
    // Prefer per-profile email if we ever add one, else fall back to the NPM admin email.
    const npmSettings = getNpmSettings();
    return npmSettings?.email || `admin@${(profile.publicHostnames?.[0] || 'example.com')}`;
}

/**
 * Reconcile a single profile with NPM.
 * Mutates `profile.npmProxyHostId` and `profile.npmCertificateId` in place
 * and persists the new profile list afterwards if either changed.
 */
export async function syncProfile(
    profile: ProxyProfile,
    allProfiles: ProxyProfile[],
): Promise<SyncResult> {
    if (!isNpmEnabled()) return { ok: true, action: 'skipped' };
    if (!shouldSync(profile)) {
        // If hostnames were removed but a proxy host id is still around, delete it.
        if (typeof profile.npmProxyHostId === 'number') {
            return await deleteSyncedHost(profile, allProfiles);
        }
        return { ok: true, action: 'noop' };
    }

    try {
        // Adopted hosts: cert is owned by NPM (or by the user), we don't touch it.
        const isAdopted = !!profile.npmOriginalForwardHost;

        // 1. Ensure certificate (only for auto-acme; manual mode expects user to attach in NPM UI).
        //    Adopted hosts skip this entirely — the cert was already attached in NPM.
        let certId = profile.npmCertificateId;
        if (!isAdopted) {
            if (profile.tlsMode === 'auto-acme') {
                const needsNewCert = !certId || (await certDomainsMismatch(certId, profile.publicHostnames || []));
                if (needsNewCert) {
                    const created = await npm.createLetsEncryptCert(profileToCertPayload(profile, acmeEmail(profile)));
                    certId = created.id;
                    profile.npmCertificateId = certId;
                }
            } else if (profile.tlsMode === 'none') {
                if (certId) {
                    profile.npmCertificateId = undefined;
                    certId = undefined;
                }
            }
        }

        // 2. Create or update the proxy host.
        const fullPayload = profileToNpmHost(profile, {
            midlemanPublicHost: getMidlemanHost(),
            defaultBunPort: DEFAULT_BUN_PORT,
            resolvedProxyPort: getProxyServerPort(profile.name),
        });

        let action: SyncResult['action'];
        let hostId = profile.npmProxyHostId;
        if (hostId) {
            // For adopted hosts: only push fields that belong to Midleman, preserving
            // the user's original cert / SSL / advanced config they set up in NPM.
            const updatePayload = isAdopted ? {
                domain_names: fullPayload.domain_names,
                forward_host: fullPayload.forward_host,
                forward_port: fullPayload.forward_port,
                forward_scheme: fullPayload.forward_scheme,
                allow_websocket_upgrade: fullPayload.allow_websocket_upgrade,
                locations: fullPayload.locations,
            } : fullPayload;
            try {
                await npm.updateProxyHost(hostId, updatePayload);
                action = 'updated';
            } catch (err) {
                if (err instanceof NpmError && err.status === 404) {
                    // Lost reference — recreate (non-adopted only; adopted hosts shouldn't be silently recreated).
                    if (isAdopted) throw err;
                    const created = await npm.createProxyHost(fullPayload);
                    hostId = created.id;
                    profile.npmProxyHostId = hostId;
                    action = 'created';
                } else {
                    throw err;
                }
            }
        } else {
            const created = await npm.createProxyHost(fullPayload);
            hostId = created.id;
            profile.npmProxyHostId = hostId;
            action = 'created';
        }

        persistProfiles(allProfiles);
        return { ok: true, action, proxyHostId: hostId, certificateId: certId };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}

async function certDomainsMismatch(certId: number, expected: string[]): Promise<boolean> {
    try {
        const cert = await npm.getCertificate(certId);
        const have = new Set((cert.domain_names || []).map(d => d.toLowerCase()));
        const want = new Set(expected.map(d => d.trim().toLowerCase()));
        if (have.size !== want.size) return true;
        for (const d of want) if (!have.has(d)) return true;
        return false;
    } catch (err) {
        if (err instanceof NpmError && err.status === 404) return true;
        // Be conservative: don't churn certs on transient errors.
        return false;
    }
}

/**
 * Remove the NPM proxy host (and optionally the cert, if no other profile uses it).
 */
export async function deleteSyncedHost(
    profile: ProxyProfile,
    allProfiles: ProxyProfile[],
): Promise<SyncResult> {
    if (!isNpmEnabled()) return { ok: true, action: 'skipped' };
    if (!profile.npmProxyHostId) return { ok: true, action: 'noop' };

    try {
        // Adopted host: restore the original forward target instead of deleting it.
        if (profile.npmOriginalForwardHost && profile.npmOriginalForwardPort) {
            try {
                await npm.updateProxyHost(profile.npmProxyHostId, {
                    forward_host: profile.npmOriginalForwardHost,
                    forward_port: profile.npmOriginalForwardPort,
                    forward_scheme: profile.npmOriginalForwardScheme || 'http',
                    domain_names: profile.publicHostnames || [],
                });
            } catch (e) {
                // If the host vanished in NPM, fall through to cleanup.
                if (!(e instanceof NpmError && e.status === 404)) throw e;
            }
            profile.npmProxyHostId = undefined;
            profile.npmOriginalForwardHost = undefined;
            profile.npmOriginalForwardPort = undefined;
            profile.npmOriginalForwardScheme = undefined;
            persistProfiles(allProfiles);
            return { ok: true, action: 'deleted' };
        }
        await npm.deleteProxyHost(profile.npmProxyHostId);
        profile.npmProxyHostId = undefined;

        // Clean up cert if it was managed by us and no other profile references it.
        if (profile.npmCertificateId) {
            const certId = profile.npmCertificateId;
            const shared = allProfiles.some(p => p !== profile && p.npmCertificateId === certId);
            if (!shared) {
                try { await npm.deleteCertificate(certId); } catch { /* swallow */ }
            }
            profile.npmCertificateId = undefined;
        }

        persistProfiles(allProfiles);
        return { ok: true, action: 'deleted' };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}

/** Sweep all profiles on startup. Returns counts; logs each failure. */
export async function reconcileAll(profiles: ProxyProfile[]): Promise<{ synced: number; failed: number }> {
    if (!isNpmEnabled()) return { synced: 0, failed: 0 };
    let synced = 0, failed = 0;
    for (const p of profiles) {
        if (!shouldSync(p) && !p.npmProxyHostId) continue;
        const r = await syncProfile(p, profiles);
        if (r.ok) synced++;
        else { failed++; console.warn(`[npm] sync failed for "${p.name}": ${r.error}`); }
    }
    return { synced, failed };
}
