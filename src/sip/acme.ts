import acme from 'acme-client';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { TcpUdpProfile } from '../core/types';

// ─── HTTP-01 Challenge Token Store ───────────────────────────────────────────
//
// The main HTTP server reads this map to serve:
//   GET /.well-known/acme-challenge/{token}  →  keyAuthorization string
//
// Access is synchronous from the HTTP handler — no lock needed (single-threaded JS).

export const challengeStore = new Map<string, string>();

// ─── Constants ────────────────────────────────────────────────────────────────

/** Renew when fewer than this many days remain */
const RENEW_THRESHOLD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Certificate validity check ───────────────────────────────────────────────

/**
 * Returns true if the PEM cert at `certPath` exists and expires in more than
 * `thresholdDays` days. Safe to call even if the file is missing.
 */
async function isCertValid(certPath: string, thresholdDays: number): Promise<boolean> {
    try {
        const pem = await Bun.file(certPath).text();
        const info = acme.crypto.readCertificateInfo(pem);
        return info.notAfter.getTime() - Date.now() > thresholdDays * DAY_MS;
    } catch {
        return false;
    }
}

// ─── Account key management ───────────────────────────────────────────────────

/**
 * Return the persisted ACME account private key, creating one if absent.
 * Uses ECDSA P-256: smaller keys, faster TLS handshakes, equivalent security
 * to RSA-3072 per NIST guidelines.
 */
async function getOrCreateAccountKey(dataDir: string): Promise<Buffer> {
    const keyPath = join(dataDir, 'acme-account.key');

    if (existsSync(keyPath)) {
        return Buffer.from(await Bun.file(keyPath).arrayBuffer());
    }

    const key = await acme.crypto.createPrivateEcdsaKey('P-256');

    // Atomic write: write to *.tmp then rename — avoids a corrupt key file on crash
    const tmp = `${keyPath}.tmp`;
    await Bun.write(tmp, key);
    renameSync(tmp, keyPath);

    console.log(`[acme] Created new ECDSA P-256 account key at ${keyPath}`);
    return key;
}

// ─── Certificate request ──────────────────────────────────────────────────────

async function requestCertificate(profile: TcpUdpProfile): Promise<void> {
    const domain = profile.acmeDomain!;
    const dataDir = resolveDataDir(profile);

    mkdirSync(dataDir, { recursive: true });

    const accountKey = await getOrCreateAccountKey(dataDir);

    const client = new acme.Client({
        directoryUrl: profile.acmeStaging
            ? acme.directory.letsencrypt.staging
            : acme.directory.letsencrypt.production,
        accountKey,
        backoffAttempts: 10,
        backoffMin: 5_000,
        backoffMax: 30_000,
    });

    // ECDSA P-256 cert key — fastest option for SIP TLS handshakes
    const [certKey, csr] = await acme.crypto.createCsr({
        commonName: domain,
        altNames: [domain],
    });

    console.log(`[acme:${profile.name}] Requesting certificate for ${domain} from Let's Encrypt${profile.acmeStaging ? ' (staging)' : ''}...`);

    const cert = await client.auto({
        csr,
        email: profile.acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
            challengeStore.set(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (_authz, challenge) => {
            challengeStore.delete(challenge.token);
        },
    });

    // Atomic writes for both cert and key — avoids serving a mismatched pair
    const certPath = profile.tlsCert!;
    const keyPath = profile.tlsKey!;
    const certTmp = `${certPath}.tmp`;
    const keyTmp = `${keyPath}.tmp`;
    await Bun.write(certTmp, cert);
    await Bun.write(keyTmp, certKey);
    renameSync(certTmp, certPath);
    renameSync(keyTmp, keyPath);

    const info = acme.crypto.readCertificateInfo(cert);
    console.log(`[acme:${profile.name}] Certificate issued ✓ — expires ${info.notAfter.toISOString().slice(0, 10)}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function resolveDataDir(profile: TcpUdpProfile): string {
    return profile.acmeDataDir ?? join(process.env.DATA_DIR ?? './data', 'acme', profile.name);
}

/**
 * Ensure a valid TLS certificate exists for the given SIP profile.
 *
 * - If `acmeDomain` is not set, this is a no-op (manual cert management).
 * - Requests a new cert from Let's Encrypt if missing or expiring within 30 days.
 * - Starts a background daily renewal timer with ±1 h jitter.
 *
 * `onRenewed` is called after a successful renewal so the caller can hot-reload
 * the TLS server with the new certificate.
 */
export async function ensureCertificate(
    profile: TcpUdpProfile,
    onRenewed?: () => Promise<void>,
): Promise<void> {
    if (!profile.acmeDomain) return;

    if (!profile.acmeEmail) {
        throw new Error(`[acme:${profile.name}] acmeEmail is required when acmeDomain is set`);
    }

    // Ensure cert directories exist
    const certPath = profile.tlsCert!;
    const keyPath = profile.tlsKey!;
    mkdirSync(join(certPath, '..'), { recursive: true });
    mkdirSync(join(keyPath, '..'), { recursive: true });

    if (await isCertValid(certPath, RENEW_THRESHOLD_DAYS)) {
        const pem = await Bun.file(certPath).text();
        const info = acme.crypto.readCertificateInfo(pem);
        const daysLeft = Math.floor((info.notAfter.getTime() - Date.now()) / DAY_MS);
        console.log(`[acme:${profile.name}] Certificate valid — ${daysLeft} days remaining`);
    } else {
        await requestCertificate(profile);
    }

    // Background daily renewal check — jitter avoids thundering herd on multi-profile setups
    const jitterMs = Math.random() * 3600 * 1000;
    setInterval(async () => {
        if (await isCertValid(certPath, RENEW_THRESHOLD_DAYS)) return;

        console.log(`[acme:${profile.name}] Certificate expiring soon — renewing...`);
        try {
            await requestCertificate(profile);
            await onRenewed?.();
        } catch (err) {
            console.error(`[acme:${profile.name}] Renewal failed:`, err instanceof Error ? err.message : err);
            // Keep running with old cert — retry next day
        }
    }, DAY_MS + jitterMs);
}
