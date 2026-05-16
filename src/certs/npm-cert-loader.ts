// Read-only loader for certificates produced by NPM/certbot in a shared
// Let's Encrypt volume. When the volume is mounted (NPM_LETSENCRYPT_DIR set),
// Midleman reads PEMs straight from /etc/letsencrypt/live/<domain>/{fullchain,privkey}.pem
// and watches the live/ directory for renewals.
//
// Falls back silently when the directory is not present so this module is safe
// to import unconditionally.

import { existsSync, readFileSync, watch, statSync, type FSWatcher } from 'fs';
import { resolve, join } from 'path';
import { EventEmitter } from 'events';

export interface SharedCert {
    cert: string;       // fullchain.pem contents
    key: string;        // privkey.pem contents
    notAfter?: Date;
    source: 'npm-volume';
}

const LE_DIR = process.env.NPM_LETSENCRYPT_DIR
    ? resolve(process.env.NPM_LETSENCRYPT_DIR)
    : null;

const events = new EventEmitter();
let watcher: FSWatcher | null = null;

export function isNpmCertVolumePresent(): boolean {
    return !!LE_DIR && existsSync(LE_DIR) && existsSync(join(LE_DIR, 'live'));
}

/** Lookup a cert for a given domain. Returns null if absent. */
export function loadCertForDomain(domain: string): SharedCert | null {
    if (!LE_DIR) return null;
    const dir = join(LE_DIR, 'live', domain);
    const certPath = join(dir, 'fullchain.pem');
    const keyPath = join(dir, 'privkey.pem');
    if (!existsSync(certPath) || !existsSync(keyPath)) return null;
    try {
        const cert = readFileSync(certPath, 'utf-8');
        const key = readFileSync(keyPath, 'utf-8');
        let notAfter: Date | undefined;
        try {
            const stat = statSync(certPath);
            notAfter = stat.mtime; // best-effort; certbot rewrites on renew
        } catch { /* ignore */ }
        return { cert, key, notAfter, source: 'npm-volume' };
    } catch {
        return null;
    }
}

/** Subscribe to renewal events. Listener receives the domain whose cert changed. */
export function onCertReloaded(listener: (domain: string) => void): () => void {
    events.on('cert:reloaded', listener);
    return () => events.off('cert:reloaded', listener);
}

/** Start watching the live/ directory. Safe to call multiple times. */
export function startCertWatcher(): void {
    if (watcher || !LE_DIR) return;
    const liveDir = join(LE_DIR, 'live');
    if (!existsSync(liveDir)) return;
    try {
        watcher = watch(liveDir, { recursive: true }, (_evt, filename) => {
            if (!filename) return;
            // filename looks like "example.com/fullchain.pem" — first segment is the domain.
            const domain = String(filename).split(/[\\/]/)[0];
            if (domain) events.emit('cert:reloaded', domain);
        });
        watcher.on('error', err => {
            console.warn('[npm-cert-loader] watcher error:', err.message);
        });
    } catch (err) {
        console.warn('[npm-cert-loader] could not start watcher:', err instanceof Error ? err.message : err);
    }
}

export function stopCertWatcher(): void {
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
}
