/**
 * ACME (Let's Encrypt) integration for the central certificate store.
 *
 * Old model (deprecated): per-profile ACME with files on disk.
 * New model: per-cert ACME — each `CertRecord` with `source='acme'` is renewed
 * by a single background timer (`scheduleRenewal`). PEMs live in the DB, not
 * on disk. Renewal calls `updateCertPem` which fires `cert:changed` so all
 * TLS listeners using the cert hot-reload.
 *
 * Account key is still a file (shared across all ACME certs) — there is only
 * one Let's Encrypt account per Midleman instance.
 */

import acme from 'acme-client';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { updateCertPem, setCertError, type CertRecord } from '../core/cert-store';

// ─── HTTP-01 Challenge Token Store ───────────────────────────────────────────

export const challengeStore = new Map<string, string>();

// ─── Constants ────────────────────────────────────────────────────────────────

const RENEW_THRESHOLD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Account key (shared across all ACME certs) ─────────────────────────────

function accountKeyPath(): string {
    const dir = join(process.env.DATA_DIR ?? './data', 'acme');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'acme-account.key');
}

async function getOrCreateAccountKey(): Promise<Buffer> {
    const keyPath = accountKeyPath();
    if (existsSync(keyPath)) {
        return Buffer.from(await Bun.file(keyPath).arrayBuffer());
    }
    const key = await acme.crypto.createPrivateEcdsaKey('P-256');
    const tmp = `${keyPath}.tmp`;
    await Bun.write(tmp, key);
    renameSync(tmp, keyPath);
    console.log(`[acme] Created new ECDSA P-256 account key at ${keyPath}`);
    return key;
}

// ─── Certificate request ──────────────────────────────────────────────────────

/**
 * Request a fresh certificate from Let's Encrypt for the given cert record
 * and persist the result via `updateCertPem` (which fires the change event).
 */
export async function requestCertificate(cert: CertRecord): Promise<void> {
    if (cert.source !== 'acme') throw new Error(`Cert #${cert.id} is not source='acme'`);
    if (!cert.acmeEmail) throw new Error(`Cert #${cert.id} missing acmeEmail`);

    const accountKey = await getOrCreateAccountKey();

    const client = new acme.Client({
        directoryUrl: cert.acmeStaging
            ? acme.directory.letsencrypt.staging
            : acme.directory.letsencrypt.production,
        accountKey,
        backoffAttempts: 10,
        backoffMin: 5_000,
        backoffMax: 30_000,
    });

    const [certKey, csr] = await acme.crypto.createCsr({
        commonName: cert.domain,
        altNames: [cert.domain],
    });

    console.log(`[acme:#${cert.id}:${cert.domain}] Requesting certificate from Let's Encrypt${cert.acmeStaging ? ' (staging)' : ''}...`);

    const issuedPem = await client.auto({
        csr,
        email: cert.acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
            challengeStore.set(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (_authz, challenge) => {
            challengeStore.delete(challenge.token);
        },
    });

    const certPem = String(issuedPem);
    const keyPem = certKey instanceof Buffer ? certKey.toString('utf8') : String(certKey);

    updateCertPem(cert.id, certPem, keyPem);
    const info = acme.crypto.readCertificateInfo(certPem);
    console.log(`[acme:#${cert.id}:${cert.domain}] Certificate issued ✓ — expires ${info.notAfter.toISOString().slice(0, 10)}`);
}

// ─── Renewal scheduling ──────────────────────────────────────────────────────

const _renewalTimers = new Map<number, ReturnType<typeof setInterval>>();

/** Check whether the cert PEM in the record expires beyond the threshold. */
function isPemValid(pem: string, thresholdDays: number): boolean {
    if (!pem) return false;
    try {
        const info = acme.crypto.readCertificateInfo(pem);
        return info.notAfter.getTime() - Date.now() > thresholdDays * DAY_MS;
    } catch {
        return false;
    }
}

/**
 * Ensure the cert is valid (issuing one if missing/expiring) and schedule
 * background renewal. Idempotent — re-scheduling replaces any prior timer
 * for the same cert id.
 *
 * Returns when initial check/issue completes. Safe to call from background
 * (fire-and-forget) — caller can ignore the promise.
 */
export async function scheduleAcmeRenewal(cert: CertRecord): Promise<void> {
    if (cert.source !== 'acme') return;

    // When NPM owns Let's Encrypt (volume mounted), skip internal ACME entirely
    // — NPM's certbot handles issuance/renewal and we read PEMs from the shared
    // volume via src/certs/npm-cert-loader.ts.
    if (process.env.NPM_LETSENCRYPT_DIR) {
        console.log(`[acme:#${cert.id}:${cert.domain}] Skipped — NPM_LETSENCRYPT_DIR set, NPM owns Let's Encrypt`);
        return;
    }

    // Replace any existing timer for this cert
    const prev = _renewalTimers.get(cert.id);
    if (prev) clearInterval(prev);

    try {
        if (isPemValid(cert.certPem, RENEW_THRESHOLD_DAYS)) {
            const info = acme.crypto.readCertificateInfo(cert.certPem);
            const daysLeft = Math.floor((info.notAfter.getTime() - Date.now()) / DAY_MS);
            console.log(`[acme:#${cert.id}:${cert.domain}] Valid — ${daysLeft} days remaining`);
        } else {
            await requestCertificate(cert);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setCertError(cert.id, msg);
        console.error(`[acme:#${cert.id}:${cert.domain}] Initial issue failed:`, msg);
        // Schedule retries via the renewal timer below
    }

    // Daily renewal check with ±1h jitter
    const jitterMs = Math.random() * 3600 * 1000;
    const timer = setInterval(async () => {
        // Re-read latest state from DB (cert may have been updated/replaced)
        const { getCert } = await import('../core/cert-store');
        const latest = getCert(cert.id);
        if (!latest || latest.source !== 'acme') {
            clearInterval(timer);
            _renewalTimers.delete(cert.id);
            return;
        }
        if (isPemValid(latest.certPem, RENEW_THRESHOLD_DAYS)) return;
        console.log(`[acme:#${latest.id}:${latest.domain}] Expiring soon — renewing...`);
        try {
            await requestCertificate(latest);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setCertError(latest.id, msg);
            console.error(`[acme:#${latest.id}:${latest.domain}] Renewal failed:`, msg);
        }
    }, DAY_MS + jitterMs);
    _renewalTimers.set(cert.id, timer);
}

/** Cancel renewal timer for a cert (used when cert is deleted or switched away from ACME). */
export function cancelAcmeRenewal(certId: number): void {
    const t = _renewalTimers.get(certId);
    if (t) {
        clearInterval(t);
        _renewalTimers.delete(certId);
    }
}

export function shutdownAcme(): void {
    for (const t of _renewalTimers.values()) clearInterval(t);
    _renewalTimers.clear();
}
