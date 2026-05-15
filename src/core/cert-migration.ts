/**
 * Idempotent migration from legacy in-profile cert fields to the central
 * cert store. Runs once at startup, before any TCP/UDP server starts.
 *
 * For each profile with TLS:
 *   - If `acmeDomain` set: upsert cert by domain (source='acme'). If the legacy
 *     PEM file exists at `tlsCert`, load it into the DB so the cert is "active"
 *     immediately and the listener can mount without waiting for re-issue.
 *   - If `tlsCert` set (manual): read the PEM, extract CN as domain, upsert
 *     (source='manual').
 *   - Set profile.certId = cert.id, persist profiles.
 *
 * Idempotency: keyed on `domain` (UNIQUE in certs table). Re-running is a
 * no-op once profiles already have `certId`.
 */

import { existsSync, readFileSync } from 'node:fs';
import acme from 'acme-client';
import type { TcpUdpProfile } from './types';
import { upsertCertByDomain, type CertRecord } from './cert-store';

function readPemSafe(path: string): string {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function extractCnFromPem(pem: string): string | null {
    try {
        const info = acme.crypto.readCertificateInfo(pem);
        // commonName lives in info.subject (acme-client v5 exposes it as a string).
        const subj = (info as unknown as { subject?: { commonName?: string } }).subject;
        return subj?.commonName ?? null;
    } catch {
        return null;
    }
}

export interface MigrationReport {
    migrated: number;
    skipped: number;
    errors: string[];
}

export function migrateProfileCerts(profiles: TcpUdpProfile[]): MigrationReport {
    const report: MigrationReport = { migrated: 0, skipped: 0, errors: [] };

    for (const profile of profiles) {
        // Already migrated → skip
        if (profile.certId) { report.skipped++; continue; }

        const hasTlsListener = profile.listeners.some(l => l.transport === 'tls');
        if (!hasTlsListener) { report.skipped++; continue; }

        try {
            let cert: CertRecord | null = null;

            if (profile.acmeDomain) {
                // ACME-managed cert. Try to preserve existing PEM if it's on disk.
                let certPem = '';
                let keyPem = '';
                if (profile.tlsCert && existsSync(profile.tlsCert)) certPem = readPemSafe(profile.tlsCert);
                if (profile.tlsKey  && existsSync(profile.tlsKey))  keyPem  = readPemSafe(profile.tlsKey);

                cert = upsertCertByDomain({
                    domain: profile.acmeDomain,
                    source: 'acme',
                    certPem,
                    keyPem,
                    acmeEmail: profile.acmeEmail ?? null,
                    acmeStaging: !!profile.acmeStaging,
                });
                console.log(`🔐 Migrated profile "${profile.name}" → cert #${cert.id} ${cert.domain} (source=acme, status=${cert.status})`);
            } else if (profile.tlsCert && profile.tlsKey) {
                // Manual cert — load from disk
                const certPem = readPemSafe(profile.tlsCert);
                const keyPem  = readPemSafe(profile.tlsKey);
                if (!certPem || !keyPem) {
                    report.errors.push(`Profile "${profile.name}": tlsCert/tlsKey files missing or unreadable`);
                    continue;
                }
                const domain = extractCnFromPem(certPem) ?? `legacy-${profile.name}`;
                cert = upsertCertByDomain({
                    domain,
                    source: 'manual',
                    certPem,
                    keyPem,
                });
                console.log(`🔐 Migrated profile "${profile.name}" → cert #${cert.id} ${cert.domain} (source=manual)`);
            } else {
                report.errors.push(`Profile "${profile.name}" has TLS listener but no cert config — set certId after creating a certificate`);
                continue;
            }

            profile.certId = cert.id;
            report.migrated++;
        } catch (err) {
            report.errors.push(`Profile "${profile.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    return report;
}
