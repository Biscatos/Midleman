/**
 * Certificate store — central registry of TLS certificates used by TCP/UDP
 * proxies. Modeled after NPM (Nginx Proxy Manager): the admin manages a list
 * of certificates from three sources (upload, Let's Encrypt, self-signed),
 * and each TCP/UDP profile picks one via `certId`.
 *
 * Domain is UNIQUE — one cert per FQDN. PEM is stored in the DB (not on
 * disk) to simplify backup and avoid scattered files. Bun.listen accepts
 * PEM strings directly in `tls: { cert, key }`.
 *
 * Renewal/replace fires a `cert:changed` event so TLS listeners can hot-
 * reload without restarting the whole profile.
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import acme from 'acme-client';

export type CertSource = 'acme' | 'manual' | 'self-signed';
export type CertStatus = 'pending' | 'active' | 'expired' | 'error';

export interface CertRecord {
    id: number;
    domain: string;
    source: CertSource;
    certPem: string;
    keyPem: string;
    chainPem: string | null;
    notBefore: string | null;       // ISO
    notAfter: string | null;        // ISO
    acmeEmail: string | null;
    acmeStaging: boolean;
    status: CertStatus;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CertInput {
    domain: string;
    source: CertSource;
    certPem?: string;
    keyPem?: string;
    chainPem?: string | null;
    acmeEmail?: string | null;
    acmeStaging?: boolean;
}

let db: Database | null = null;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS certs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    domain          TEXT NOT NULL UNIQUE,
    source          TEXT NOT NULL,
    cert_pem        TEXT NOT NULL DEFAULT '',
    key_pem         TEXT NOT NULL DEFAULT '',
    chain_pem       TEXT,
    not_before      TEXT,
    not_after       TEXT,
    acme_email      TEXT,
    acme_staging    INTEGER DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cert_usage (
    cert_id         INTEGER NOT NULL,
    profile_name    TEXT NOT NULL,
    PRIMARY KEY (cert_id, profile_name),
    FOREIGN KEY (cert_id) REFERENCES certs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cert_usage_profile ON cert_usage(profile_name);
`;

export function initCertStore(dataDir: string): void {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = resolve(dataDir, 'certs.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(CREATE_TABLE);
    console.log(`🔐 Certificate store: ${dbPath}`);
}

export function shutdownCertStore(): void {
    db?.close();
    db = null;
}

// ─── In-memory event bus ────────────────────────────────────────────────────

type CertChangeHandler = (cert: CertRecord) => void;
const _handlers = new Map<number, Set<CertChangeHandler>>();

export function onCertChange(certId: number, handler: CertChangeHandler): () => void {
    let set = _handlers.get(certId);
    if (!set) { set = new Set(); _handlers.set(certId, set); }
    set.add(handler);
    return () => { set!.delete(handler); if (set!.size === 0) _handlers.delete(certId); };
}

function emitCertChange(cert: CertRecord): void {
    const set = _handlers.get(cert.id);
    if (!set) return;
    for (const h of set) {
        try { h(cert); } catch (err) {
            console.error(`[certs] hot-reload handler failed for cert #${cert.id}:`, err instanceof Error ? err.message : err);
        }
    }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

function rowToRecord(r: any): CertRecord {
    return {
        id: r.id,
        domain: r.domain,
        source: r.source,
        certPem: r.cert_pem,
        keyPem: r.key_pem,
        chainPem: r.chain_pem,
        notBefore: r.not_before,
        notAfter: r.not_after,
        acmeEmail: r.acme_email,
        acmeStaging: !!r.acme_staging,
        status: r.status,
        lastError: r.last_error,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

export function listCerts(): CertRecord[] {
    if (!db) return [];
    const rows = db.prepare(`SELECT * FROM certs ORDER BY domain`).all() as any[];
    return rows.map(rowToRecord);
}

export function getCert(id: number): CertRecord | null {
    if (!db) return null;
    const r = db.prepare(`SELECT * FROM certs WHERE id = $id`).get({ $id: id }) as any;
    return r ? rowToRecord(r) : null;
}

export function getCertByDomain(domain: string): CertRecord | null {
    if (!db) return null;
    const r = db.prepare(`SELECT * FROM certs WHERE domain = $domain`).get({ $domain: domain }) as any;
    return r ? rowToRecord(r) : null;
}

/** Extract notBefore/notAfter from a PEM cert. Returns nulls if unparseable. */
function readCertDates(pem: string): { notBefore: string | null; notAfter: string | null } {
    if (!pem || pem.trim().length === 0) return { notBefore: null, notAfter: null };
    try {
        const info = acme.crypto.readCertificateInfo(pem);
        return {
            notBefore: info.notBefore.toISOString(),
            notAfter: info.notAfter.toISOString(),
        };
    } catch {
        return { notBefore: null, notAfter: null };
    }
}

function computeStatus(notAfter: string | null, hasPem: boolean): CertStatus {
    if (!hasPem) return 'pending';
    if (!notAfter) return 'error';
    if (new Date(notAfter).getTime() < Date.now()) return 'expired';
    return 'active';
}

export function createCert(input: CertInput): CertRecord {
    if (!db) throw new Error('Cert store not initialized');
    const certPem = input.certPem ?? '';
    const keyPem = input.keyPem ?? '';
    const { notBefore, notAfter } = readCertDates(certPem);
    const status = computeStatus(notAfter, certPem.length > 0);

    const stmt = db.prepare(`
        INSERT INTO certs (domain, source, cert_pem, key_pem, chain_pem,
                           not_before, not_after, acme_email, acme_staging, status)
        VALUES ($domain, $source, $certPem, $keyPem, $chainPem,
                $notBefore, $notAfter, $acmeEmail, $acmeStaging, $status)
        RETURNING id
    `);
    const r = stmt.get({
        $domain: input.domain,
        $source: input.source,
        $certPem: certPem,
        $keyPem: keyPem,
        $chainPem: input.chainPem ?? null,
        $notBefore: notBefore,
        $notAfter: notAfter,
        $acmeEmail: input.acmeEmail ?? null,
        $acmeStaging: input.acmeStaging ? 1 : 0,
        $status: status,
    }) as any;
    return getCert(r.id)!;
}

/** Replace cert+key PEM and fire change event (used by ACME renewal & manual replace). */
export function updateCertPem(id: number, certPem: string, keyPem: string, chainPem?: string | null): CertRecord | null {
    if (!db) return null;
    const { notBefore, notAfter } = readCertDates(certPem);
    const status = computeStatus(notAfter, certPem.length > 0);
    db.prepare(`
        UPDATE certs
        SET cert_pem = $certPem, key_pem = $keyPem, chain_pem = $chainPem,
            not_before = $notBefore, not_after = $notAfter,
            status = $status, last_error = NULL, updated_at = datetime('now')
        WHERE id = $id
    `).run({
        $id: id,
        $certPem: certPem,
        $keyPem: keyPem,
        $chainPem: chainPem ?? null,
        $notBefore: notBefore,
        $notAfter: notAfter,
        $status: status,
    });
    const updated = getCert(id);
    if (updated) emitCertChange(updated);
    return updated;
}

export function setCertError(id: number, message: string): void {
    if (!db) return;
    db.prepare(`
        UPDATE certs SET status = 'error', last_error = $msg, updated_at = datetime('now') WHERE id = $id
    `).run({ $id: id, $msg: message });
}

export function deleteCert(id: number): { deleted: boolean; usedBy: string[] } {
    if (!db) return { deleted: false, usedBy: [] };
    const usage = (db.prepare(`SELECT profile_name FROM cert_usage WHERE cert_id = $id`).all({ $id: id }) as any[])
        .map(r => r.profile_name as string);
    if (usage.length > 0) return { deleted: false, usedBy: usage };
    db.prepare(`DELETE FROM certs WHERE id = $id`).run({ $id: id });
    return { deleted: true, usedBy: [] };
}

/** Idempotent upsert by domain — used by startup migration. */
export function upsertCertByDomain(input: CertInput): CertRecord {
    const existing = getCertByDomain(input.domain);
    if (existing) {
        // Only replace PEM if caller provided one and existing has none.
        if (input.certPem && !existing.certPem) {
            return updateCertPem(existing.id, input.certPem, input.keyPem ?? '', input.chainPem) ?? existing;
        }
        return existing;
    }
    return createCert(input);
}

// ─── Cert usage tracking (which profiles use which cert) ────────────────────

export function setCertUsage(certId: number, profileName: string): void {
    if (!db) return;
    db.prepare(`INSERT OR IGNORE INTO cert_usage (cert_id, profile_name) VALUES ($certId, $profile)`)
        .run({ $certId: certId, $profile: profileName });
}

export function clearCertUsageForProfile(profileName: string): void {
    if (!db) return;
    db.prepare(`DELETE FROM cert_usage WHERE profile_name = $profile`).run({ $profile: profileName });
}

export function listProfilesUsingCert(certId: number): string[] {
    if (!db) return [];
    return (db.prepare(`SELECT profile_name FROM cert_usage WHERE cert_id = $id`).all({ $id: certId }) as any[])
        .map(r => r.profile_name);
}

export function countUsageForCert(certId: number): number {
    if (!db) return 0;
    const r = db.prepare(`SELECT COUNT(*) as c FROM cert_usage WHERE cert_id = $id`).get({ $id: certId }) as any;
    return r?.c ?? 0;
}

// ─── Self-signed generation (via @peculiar/x509, transitive dep of acme-client) ──

export async function generateSelfSigned(domain: string, days = 365): Promise<{ certPem: string; keyPem: string }> {
    const x509 = await import('@peculiar/x509');
    // Bun's globalThis.crypto implements Web Crypto natively — no @peculiar/webcrypto needed.
    x509.cryptoProvider.set(globalThis.crypto as unknown as Crypto);

    const alg = {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
    } as const;
    const keys = await globalThis.crypto.subtle.generateKey(alg, true, ['sign', 'verify']) as CryptoKeyPair;
    const now = new Date();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: '01',
        name: `CN=${domain}`,
        notBefore: now,
        notAfter: new Date(now.getTime() + days * 24 * 3600 * 1000),
        signingAlgorithm: alg,
        keys,
        extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1' /* serverAuth */], true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
            new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: domain }]),
        ],
    });

    const certPem = cert.toString('pem');
    const pkcs8 = await globalThis.crypto.subtle.exportKey('pkcs8', keys.privateKey);
    const keyBase64 = Buffer.from(pkcs8).toString('base64');
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${keyBase64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;

    return { certPem, keyPem };
}
