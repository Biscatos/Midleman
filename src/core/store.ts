import type { ProxyProfile, WebhookDistributor, TcpUdpProfile, NpmCustomLocation } from './types';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

/**
 * JSON-serializable version of ProxyProfile
 * (Set<string> → string[] for JSON persistence)
 */
interface StoredProfile {
    name: string;
    targetUrl: string;
    apiKey?: string;
    authHeader?: string;
    authPrefix?: string;
    accessKey?: string;
    authMode?: 'none' | 'accessKey' | 'login';
    require2fa?: boolean;
    isWebApp?: boolean;
    disableLogs?: boolean;
    blockedExtensions?: string[];
    allowedIps?: string[];
    allowedPaths?: string[];
    port?: number;
    forwardPath?: boolean;
    passthrough?: boolean;
    authToken?: string;
    loginTitle?: string;
    loginLogo?: string;
    allowSelfSignedTls?: boolean;
    supabaseMode?: boolean;
    consentEnabled?: boolean;
    /** Reference to a row in consent_pages (auth DB). null/undefined means no page linked. */
    consentPageId?: number | null;
    // NPM integration (optional)
    publicHostnames?: string[];
    tlsMode?: 'auto-acme' | 'manual' | 'none';
    npmCertificateId?: number;
    npmProxyHostId?: number;
    http2?: boolean;
    hstsEnabled?: boolean;
    sslForced?: boolean;
    allowWebsocketUpgrade?: boolean;
    advancedConfig?: string;
    npmLocations?: NpmCustomLocation[];
    npmOriginalForwardHost?: string;
    npmOriginalForwardPort?: number;
    npmOriginalForwardScheme?: 'http' | 'https';
}

// Default path — override with DATA_DIR env var for Docker volumes
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const PROFILES_FILE = resolve(DATA_DIR, 'profiles.json');
const TARGETS_FILE = resolve(DATA_DIR, 'targets.json');
const WEBHOOKS_FILE = resolve(DATA_DIR, 'webhooks.json');
const DLQ_FILE = resolve(DATA_DIR, 'dlq.json');
const PENDING_RETRY_FILE = resolve(DATA_DIR, 'pending-retry.json');
const TCPUDP_FILE = resolve(DATA_DIR, 'tcpudp-profiles.json');

/**
 * Ensure the data directory exists.
 */
function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * Convert a StoredProfile (JSON) to a ProxyProfile (runtime).
 */
function toRuntime(stored: StoredProfile): ProxyProfile {
    const profile: ProxyProfile = {
        name: stored.name.toLowerCase(),
        targetUrl: stored.targetUrl.endsWith('/') ? stored.targetUrl.slice(0, -1) : stored.targetUrl,
        authPrefix: stored.authPrefix,
        accessKey: stored.accessKey,
    };
    if (stored.apiKey) profile.apiKey = stored.apiKey;
    if (stored.authHeader) profile.authHeader = stored.authHeader;
    if (stored.authMode) profile.authMode = stored.authMode;
    if (stored.require2fa) profile.require2fa = stored.require2fa;
    if (stored.isWebApp) profile.isWebApp = stored.isWebApp;
    if (stored.disableLogs) profile.disableLogs = stored.disableLogs;

    if (stored.blockedExtensions && stored.blockedExtensions.length > 0) {
        profile.blockedExtensions = new Set(
            stored.blockedExtensions.map(e => e.trim().toLowerCase().replace(/^\.?/, '.'))
        );
    }
    if (stored.allowedIps && stored.allowedIps.length > 0) profile.allowedIps = stored.allowedIps;
    if (stored.allowedPaths && stored.allowedPaths.length > 0) profile.allowedPaths = stored.allowedPaths;
    
    if (stored.port !== undefined) profile.port = stored.port;
    if (stored.forwardPath !== undefined) profile.forwardPath = stored.forwardPath;
    if (stored.passthrough !== undefined) profile.passthrough = stored.passthrough;
    if (stored.authToken !== undefined) profile.authToken = stored.authToken;
    if (stored.loginTitle !== undefined) profile.loginTitle = stored.loginTitle;
    if (stored.loginLogo !== undefined) profile.loginLogo = stored.loginLogo;
    if (stored.allowSelfSignedTls !== undefined) profile.allowSelfSignedTls = stored.allowSelfSignedTls;
    if (stored.supabaseMode !== undefined) profile.supabaseMode = stored.supabaseMode;
    if (stored.consentEnabled !== undefined) profile.consentEnabled = stored.consentEnabled;
    if (stored.consentPageId !== undefined) profile.consentPageId = stored.consentPageId;
    if (stored.publicHostnames && stored.publicHostnames.length > 0) profile.publicHostnames = stored.publicHostnames;
    if (stored.tlsMode) profile.tlsMode = stored.tlsMode;
    if (stored.npmCertificateId !== undefined) profile.npmCertificateId = stored.npmCertificateId;
    if (stored.npmProxyHostId !== undefined) profile.npmProxyHostId = stored.npmProxyHostId;
    if (stored.http2 !== undefined) profile.http2 = stored.http2;
    if (stored.hstsEnabled !== undefined) profile.hstsEnabled = stored.hstsEnabled;
    if (stored.sslForced !== undefined) profile.sslForced = stored.sslForced;
    if (stored.allowWebsocketUpgrade !== undefined) profile.allowWebsocketUpgrade = stored.allowWebsocketUpgrade;
    if (stored.advancedConfig !== undefined) profile.advancedConfig = stored.advancedConfig;
    if (Array.isArray(stored.npmLocations) && stored.npmLocations.length > 0) profile.npmLocations = stored.npmLocations;
    if (stored.npmOriginalForwardHost) profile.npmOriginalForwardHost = stored.npmOriginalForwardHost;
    if (typeof stored.npmOriginalForwardPort === 'number') profile.npmOriginalForwardPort = stored.npmOriginalForwardPort;
    if (stored.npmOriginalForwardScheme === 'http' || stored.npmOriginalForwardScheme === 'https') profile.npmOriginalForwardScheme = stored.npmOriginalForwardScheme;

    return profile;
}

/**
 * Convert a ProxyProfile (runtime) to a StoredProfile (JSON).
 */
function toStored(profile: ProxyProfile): StoredProfile {
    const stored: StoredProfile = {
        name: profile.name,
        targetUrl: profile.targetUrl,
    };
    if (profile.apiKey) stored.apiKey = profile.apiKey;
    if (profile.authHeader) stored.authHeader = profile.authHeader;

    if (profile.authPrefix) stored.authPrefix = profile.authPrefix;
    if (profile.accessKey) stored.accessKey = profile.accessKey;
    if (profile.authMode && profile.authMode !== 'none') stored.authMode = profile.authMode;
    if (profile.require2fa) stored.require2fa = profile.require2fa;
    if (profile.isWebApp) stored.isWebApp = profile.isWebApp;
    if (profile.disableLogs) stored.disableLogs = profile.disableLogs;
    if (profile.blockedExtensions && profile.blockedExtensions.size > 0) {
        stored.blockedExtensions = Array.from(profile.blockedExtensions);
    }
    if (profile.allowedIps && profile.allowedIps.length > 0) stored.allowedIps = profile.allowedIps;
    if (profile.allowedPaths && profile.allowedPaths.length > 0) stored.allowedPaths = profile.allowedPaths;
    
    if (profile.port !== undefined) stored.port = profile.port;
    if (profile.forwardPath !== undefined) stored.forwardPath = profile.forwardPath;
    if (profile.passthrough !== undefined) stored.passthrough = profile.passthrough;
    if (profile.authToken !== undefined) stored.authToken = profile.authToken;
    if (profile.loginTitle !== undefined) stored.loginTitle = profile.loginTitle;
    if (profile.loginLogo !== undefined) stored.loginLogo = profile.loginLogo;
    if (profile.allowSelfSignedTls !== undefined) stored.allowSelfSignedTls = profile.allowSelfSignedTls;
    if (profile.supabaseMode !== undefined) stored.supabaseMode = profile.supabaseMode;
    if (profile.consentEnabled !== undefined) stored.consentEnabled = profile.consentEnabled;
    // Persist null explicitly so an admin can clear a previously linked page.
    if (profile.consentPageId !== undefined) stored.consentPageId = profile.consentPageId;
    if (profile.publicHostnames && profile.publicHostnames.length > 0) stored.publicHostnames = profile.publicHostnames;
    if (profile.tlsMode) stored.tlsMode = profile.tlsMode;
    if (profile.npmCertificateId !== undefined) stored.npmCertificateId = profile.npmCertificateId;
    if (profile.npmProxyHostId !== undefined) stored.npmProxyHostId = profile.npmProxyHostId;
    if (profile.http2 !== undefined) stored.http2 = profile.http2;
    if (profile.hstsEnabled !== undefined) stored.hstsEnabled = profile.hstsEnabled;
    if (profile.sslForced !== undefined) stored.sslForced = profile.sslForced;
    if (profile.allowWebsocketUpgrade !== undefined) stored.allowWebsocketUpgrade = profile.allowWebsocketUpgrade;
    if (profile.advancedConfig !== undefined) stored.advancedConfig = profile.advancedConfig;
    if (profile.npmLocations && profile.npmLocations.length > 0) stored.npmLocations = profile.npmLocations;
    if (profile.npmOriginalForwardHost) stored.npmOriginalForwardHost = profile.npmOriginalForwardHost;
    if (profile.npmOriginalForwardPort !== undefined) stored.npmOriginalForwardPort = profile.npmOriginalForwardPort;
    if (profile.npmOriginalForwardScheme) stored.npmOriginalForwardScheme = profile.npmOriginalForwardScheme;

    return stored;
}

export function loadPersistedProfiles(): ProxyProfile[] {
    try {
        const profiles: ProxyProfile[] = [];
        
        if (existsSync(PROFILES_FILE)) {
            const raw = readFileSync(PROFILES_FILE, 'utf-8');
            const stored: StoredProfile[] = JSON.parse(raw);
            profiles.push(...stored.filter(p => p.name && p.targetUrl).map(toRuntime));
        }

        // Migrate legacy targets.json
        if (existsSync(TARGETS_FILE)) {
            try {
                const raw = readFileSync(TARGETS_FILE, 'utf-8');
                const storedTargets: any[] = JSON.parse(raw);
                const migrated = storedTargets.filter(t => t.name && t.targetUrl).map(t => ({
                    name: t.name.toLowerCase(),
                    targetUrl: t.targetUrl.endsWith('/') ? t.targetUrl.slice(0, -1) : t.targetUrl,
                    port: t.port,
                    authToken: t.authToken,
                    forwardPath: t.forwardPath !== false,
                    passthrough: true,
                    allowedIps: t.allowedIps?.length ? t.allowedIps : undefined,
                }));
                profiles.push(...migrated);
            } catch (err) {
                console.warn('⚠️  Could not migrate targets.json:', err instanceof Error ? err.message : err);
            }
        }

        return profiles;
    } catch (err) {
        console.warn('⚠️  Could not load profiles:', err instanceof Error ? err.message : err);
        return [];
    }
}

/**
 * Save profiles to the persistent JSON file.
 */
export function persistProfiles(profiles: ProxyProfile[]): void {
    try {
        ensureDataDir();
        const stored = profiles.map(toStored);
        writeFileSync(PROFILES_FILE, JSON.stringify(stored, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Could not save profiles.json:', err instanceof Error ? err.message : err);
        throw err;
    }
}

/**
 * Merge env-based profiles with persisted profiles.
 * Persisted profiles take precedence (override by name).
 */
export function mergeProfiles(envProfiles: ProxyProfile[], persistedProfiles: ProxyProfile[]): ProxyProfile[] {
    const merged = new Map<string, ProxyProfile>();

    // Load env profiles first (base defaults)
    for (const p of envProfiles) {
        merged.set(p.name, p);
    }

    // Persisted profiles override env profiles
    for (const p of persistedProfiles) {
        merged.set(p.name, p);
    }

    return Array.from(merged.values());
}

/**
 * Validate a profile object from API input.
 * Returns error message or null if valid.
 */
export function validateProfileInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';

    const p = input as Record<string, unknown>;

    if (!p.name || typeof p.name !== 'string') return '"name" is required (string)';
    if (p.name.length > 64) return '"name" must be 64 characters or fewer';
    if (!p.targetUrl || typeof p.targetUrl !== 'string') return '"targetUrl" is required (string)';
    if (p.targetUrl.length > 2048) return '"targetUrl" must be 2048 characters or fewer';
    if (p.apiKey !== undefined && typeof p.apiKey !== 'string') return '"apiKey" must be a string';
    if (typeof p.apiKey === 'string' && p.apiKey.length > 512) return '"apiKey" must be 512 characters or fewer';
    if (p.authHeader !== undefined && typeof p.authHeader !== 'string') return '"authHeader" must be a string';
    if (typeof p.authHeader === 'string' && p.authHeader.length > 128) return '"authHeader" must be 128 characters or fewer';
    if (p.port !== undefined && p.port !== null && p.port !== 0) {
        if (typeof p.port !== 'number' || p.port < 1 || p.port > 65535) return '"port" must be a number between 1 and 65535 (or 0/omitted for auto-assign)';
    }
    if (p.authToken !== undefined && typeof p.authToken !== 'string') return '"authToken" must be a string';
    if (typeof p.authToken === 'string' && p.authToken.length > 256) return '"authToken" must be 256 characters or fewer';
    if (p.forwardPath !== undefined && typeof p.forwardPath !== 'boolean') return '"forwardPath" must be a boolean';
    if (p.passthrough !== undefined && typeof p.passthrough !== 'boolean') return '"passthrough" must be a boolean';
    if (p.loginTitle !== undefined && typeof p.loginTitle !== 'string') return '"loginTitle" must be a string';
    if (typeof p.loginTitle === 'string' && p.loginTitle.length > 64) return '"loginTitle" must be 64 characters or fewer';
    if (p.loginLogo !== undefined && typeof p.loginLogo !== 'string') return '"loginLogo" must be a string';
    if (typeof p.loginLogo === 'string' && p.loginLogo.length > 200_000) return '"loginLogo" exceeds maximum size (200KB)';
    if (p.consentEnabled !== undefined && typeof p.consentEnabled !== 'boolean') return '"consentEnabled" must be a boolean';
    if (p.consentPageId !== undefined && p.consentPageId !== null && (typeof p.consentPageId !== 'number' || !Number.isInteger(p.consentPageId) || p.consentPageId < 1)) {
        return '"consentPageId" must be a positive integer or null';
    }
    // NPM integration fields (all optional)
    if (p.publicHostnames !== undefined) {
        if (!Array.isArray(p.publicHostnames)) return '"publicHostnames" must be an array of strings';
        for (const h of p.publicHostnames) {
            if (typeof h !== 'string' || !h.trim()) return '"publicHostnames" entries must be non-empty strings';
            if ((h as string).length > 253) return '"publicHostnames" entries must be 253 characters or fewer';
            if (!/^[a-zA-Z0-9*]([a-zA-Z0-9-_.]*[a-zA-Z0-9])?$/.test(h as string)) return `"publicHostnames" entry "${h}" is not a valid hostname`;
        }
    }
    if (p.tlsMode !== undefined && p.tlsMode !== 'auto-acme' && p.tlsMode !== 'manual' && p.tlsMode !== 'none') {
        return '"tlsMode" must be "auto-acme", "manual" or "none"';
    }
    if (p.http2 !== undefined && typeof p.http2 !== 'boolean') return '"http2" must be a boolean';
    if (p.hstsEnabled !== undefined && typeof p.hstsEnabled !== 'boolean') return '"hstsEnabled" must be a boolean';
    if (p.sslForced !== undefined && typeof p.sslForced !== 'boolean') return '"sslForced" must be a boolean';
    if (p.allowWebsocketUpgrade !== undefined && typeof p.allowWebsocketUpgrade !== 'boolean') return '"allowWebsocketUpgrade" must be a boolean';
    if (p.advancedConfig !== undefined && typeof p.advancedConfig !== 'string') return '"advancedConfig" must be a string';
    if (typeof p.advancedConfig === 'string' && p.advancedConfig.length > 16384) return '"advancedConfig" exceeds maximum size (16KB)';
    if (p.npmLocations !== undefined) {
        if (!Array.isArray(p.npmLocations)) return '"npmLocations" must be an array';
        if (p.npmLocations.length > 32) return '"npmLocations" cannot exceed 32 entries';
        for (const loc of p.npmLocations as unknown[]) {
            if (!loc || typeof loc !== 'object') return '"npmLocations" entries must be objects';
            const l = loc as Record<string, unknown>;
            if (typeof l.path !== 'string' || !l.path.trim() || !l.path.startsWith('/')) return '"npmLocations[].path" must be a non-empty string starting with "/"';
            if ((l.path as string).length > 256) return '"npmLocations[].path" too long (max 256)';
            if (typeof l.forwardHost !== 'string' || !l.forwardHost.trim()) return '"npmLocations[].forwardHost" is required';
            if ((l.forwardHost as string).length > 253) return '"npmLocations[].forwardHost" too long';
            if (typeof l.forwardPort !== 'number' || l.forwardPort < 1 || l.forwardPort > 65535) return '"npmLocations[].forwardPort" must be 1–65535';
            if (l.forwardScheme !== undefined && l.forwardScheme !== 'http' && l.forwardScheme !== 'https') return '"npmLocations[].forwardScheme" must be "http" or "https"';
            if (l.advancedConfig !== undefined && typeof l.advancedConfig !== 'string') return '"npmLocations[].advancedConfig" must be a string';
            if (typeof l.advancedConfig === 'string' && (l.advancedConfig as string).length > 4096) return '"npmLocations[].advancedConfig" too long (max 4KB)';
        }
    }

    if (p.allowedPaths !== undefined) {
        if (!Array.isArray(p.allowedPaths)) return '"allowedPaths" must be an array of strings';
        if (p.allowedPaths.length > 64) return '"allowedPaths" cannot exceed 64 entries';
        for (const pat of p.allowedPaths) {
            if (typeof pat !== 'string' || !pat.trim()) return '"allowedPaths" entries must be non-empty strings';
            if (!(pat as string).startsWith('/')) return `"allowedPaths" entry "${pat}" must start with "/"`;
            if ((pat as string).length > 512) return '"allowedPaths" entries must be 512 characters or fewer';
        }
    }

    // Validate URL
    try {
        new URL(p.targetUrl as string);
    } catch {
        return '"targetUrl" must be a valid URL';
    }

    return null;
}



// ─── Webhook Persistence ────────────────────────────────────────────────────

interface StoredWebhook {
    name: string;
    port: number;
    targets: (string | import('./types').WebhookDestination)[];
    authToken?: string;
    retry?: import('./types').WebhookRetryConfig;
    allowedIps?: string[];
    silenceAlert?: import('./types').WebhookSilenceAlert;
    testPayload?: string;
    npmProxyHostId?: number;
    npmOriginalForwardHost?: string;
    npmOriginalForwardPort?: number;
    npmOriginalForwardScheme?: 'http' | 'https';
    publicHostnames?: string[];
}

/**
 * Load webhooks from the persistent JSON file.
 */
export function loadPersistedWebhooks(): WebhookDistributor[] {
    try {
        if (!existsSync(WEBHOOKS_FILE)) return [];

        const raw = readFileSync(WEBHOOKS_FILE, 'utf-8');
        const stored: StoredWebhook[] = JSON.parse(raw);

        return stored
            .filter(w => w.name && Array.isArray(w.targets))
            .map(w => ({
                name: w.name.toLowerCase(),
                port: w.port,
                targets: w.targets.map(t => typeof t === 'string' ? (t.endsWith('/') ? t.slice(0, -1) : t) : t),
                authToken: w.authToken,
                retry: w.retry,
                allowedIps: w.allowedIps?.length ? w.allowedIps : undefined,
                silenceAlert: w.silenceAlert,
                testPayload: w.testPayload,
                npmProxyHostId: w.npmProxyHostId,
                npmOriginalForwardHost: w.npmOriginalForwardHost,
                npmOriginalForwardPort: w.npmOriginalForwardPort,
                npmOriginalForwardScheme: w.npmOriginalForwardScheme,
                publicHostnames: w.publicHostnames && w.publicHostnames.length ? w.publicHostnames : undefined,
            }));
    } catch (err) {
        console.warn('⚠️  Could not load webhooks.json:', err instanceof Error ? err.message : err);
        return [];
    }
}

/**
 * Save webhooks to the persistent JSON file.
 */
export function persistWebhooks(webhooks: WebhookDistributor[]): void {
    try {
        ensureDataDir();
        const stored: StoredWebhook[] = webhooks.map(w => ({
            name: w.name,
            port: w.port,
            targets: w.targets,
            authToken: w.authToken,
            retry: w.retry,
            allowedIps: w.allowedIps?.length ? w.allowedIps : undefined,
            silenceAlert: w.silenceAlert,
            testPayload: w.testPayload,
            npmProxyHostId: w.npmProxyHostId,
            npmOriginalForwardHost: w.npmOriginalForwardHost,
            npmOriginalForwardPort: w.npmOriginalForwardPort,
            npmOriginalForwardScheme: w.npmOriginalForwardScheme,
            publicHostnames: w.publicHostnames && w.publicHostnames.length ? w.publicHostnames : undefined,
        }));
        writeFileSync(WEBHOOKS_FILE, JSON.stringify(stored, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Could not save webhooks.json:', err instanceof Error ? err.message : err);
        throw err;
    }
}

// ─── DLQ Persistence ────────────────────────────────────────────────────────

/**
 * On-disk representation of a FailedFanout.
 * ArrayBuffer bodies are stored as base64 to survive JSON serialization.
 */
export interface StoredFailedFanout {
    id: string;
    webhookName: string;
    requestId: string;
    targetUrl: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;         // base64 if bodyEncoding='base64', raw string if 'text', null if 'none'
    bodyEncoding: 'base64' | 'text' | 'none';
    bodyPreview: string | null;
    bodySize: number;
    path: string;
    clientIp: string;
    retryConfig: unknown;
    lastError: string;
    totalAttempts: number;
    failedAt: number;
}

export function loadPersistedDlq(): StoredFailedFanout[] {
    try {
        if (!existsSync(DLQ_FILE)) return [];
        const raw = readFileSync(DLQ_FILE, 'utf-8');
        return JSON.parse(raw) as StoredFailedFanout[];
    } catch (err) {
        console.warn('⚠️  Could not load dlq.json:', err instanceof Error ? err.message : err);
        return [];
    }
}

export function persistDlq(entries: StoredFailedFanout[]): void {
    try {
        ensureDataDir();
        writeFileSync(DLQ_FILE, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Could not save dlq.json:', err instanceof Error ? err.message : err);
    }
}

// ─── Pending-Retry Persistence ──────────────────────────────────────────────
//
// Pending-retry holds fanouts whose destination has `persistentRetry.enabled`.
// They are retried forever (or until manually dismissed) at a throttled rate,
// separately from the DLQ (which holds non-persistent failures).

export interface StoredPendingRetry {
    id: string;
    webhookName: string;
    requestId: string;
    targetUrl: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    bodyEncoding: 'base64' | 'text' | 'none';
    bodyPreview: string | null;
    bodySize: number;
    path: string;
    clientIp: string;
    retryConfig: unknown;
    persistentRetry: unknown;
    lastError: string;
    attempts: number;
    enqueuedAt: number;        // Unix ms
    lastAttemptAt: number | null;
    nextAttemptAt: number;     // Unix ms — scheduler picks the earliest
    notified: boolean;         // true once the notify-email has been sent for this entry
}

export function loadPersistedPendingRetry(): StoredPendingRetry[] {
    try {
        if (!existsSync(PENDING_RETRY_FILE)) return [];
        const raw = readFileSync(PENDING_RETRY_FILE, 'utf-8');
        return JSON.parse(raw) as StoredPendingRetry[];
    } catch (err) {
        console.warn('⚠️  Could not load pending-retry.json:', err instanceof Error ? err.message : err);
        return [];
    }
}

export function persistPendingRetry(entries: StoredPendingRetry[]): void {
    try {
        ensureDataDir();
        writeFileSync(PENDING_RETRY_FILE, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Could not save pending-retry.json:', err instanceof Error ? err.message : err);
    }
}

/**
 * Validate a webhook object from API input.
 */
export function validateWebhookInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';

    const w = input as Record<string, unknown>;

    if (!w.name || typeof w.name !== 'string') return '"name" is required (string)';
    if (!/^[a-z0-9_-]+$/.test(w.name)) return '"name" may only contain lowercase letters, numbers, hyphens and underscores (no spaces)';
    if (w.name.length < 2 || w.name.length > 48) return '"name" must be between 2 and 48 characters';
    
    if (w.port !== undefined && w.port !== null && w.port !== 0) {
        if (typeof w.port !== 'number' || w.port < 1 || w.port > 65535) return '"port" must be a number between 1 and 65535 (or 0/omitted for auto-assign)';
    }

    if (!Array.isArray(w.targets) || w.targets.length === 0) {
        return '"targets" must be a non-empty array of destinations';
    }

    if (w.testPayload !== undefined && w.testPayload !== null) {
        if (typeof w.testPayload !== 'string') return '"testPayload" must be a string';
        if (w.testPayload.length > 100_000) return '"testPayload" exceeds 100KB limit';
    }

    if (w.silenceAlert !== undefined) {
        if (typeof w.silenceAlert !== 'object' || w.silenceAlert === null) return '"silenceAlert" must be an object';
        const s = w.silenceAlert as Record<string, unknown>;
        if (typeof s.enabled !== 'boolean') return '"silenceAlert.enabled" must be a boolean';
        if (s.enabled) {
            if (typeof s.thresholdMinutes !== 'number' || s.thresholdMinutes < 1 || s.thresholdMinutes > 100000) return '"silenceAlert.thresholdMinutes" must be a positive number (1–100000)';
            if (typeof s.notifyEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.notifyEmail)) return '"silenceAlert.notifyEmail" must be a valid email';
        }
    }

    for (const target of w.targets) {
        if (typeof target === 'string') {
            try { new URL(target); } catch { return `"${target}" is not a valid URL`; }
        } else if (typeof target === 'object' && target !== null) {
            const dest = target as Record<string, unknown>;
            if (typeof dest.url !== 'string') return 'Custom action must have a valid string "url"';
            try { new URL(dest.url); } catch { return `"${dest.url}" is not a valid URL`; }
            if (dest.method && typeof dest.method !== 'string') return '"method" must be a string';
            if (dest.bodyTemplate && typeof dest.bodyTemplate !== 'string') return '"bodyTemplate" must be a string';
            if (dest.dropEmpty !== undefined && typeof dest.dropEmpty !== 'boolean') return '"dropEmpty" must be a boolean';
            if (dest.customHeaders && typeof dest.customHeaders !== 'object') return '"customHeaders" must be an object';
            if (dest.forwardHeaders !== undefined && typeof dest.forwardHeaders !== 'boolean') return '"forwardHeaders" must be a boolean';
            if (dest.persistentRetry !== undefined) {
                if (typeof dest.persistentRetry !== 'object' || dest.persistentRetry === null) return '"persistentRetry" must be an object';
                const pr = dest.persistentRetry as Record<string, unknown>;
                if (typeof pr.enabled !== 'boolean') return '"persistentRetry.enabled" must be a boolean';
                if (pr.maxAttemptsPerMinute !== undefined && (typeof pr.maxAttemptsPerMinute !== 'number' || pr.maxAttemptsPerMinute < 1 || pr.maxAttemptsPerMinute > 600)) return '"persistentRetry.maxAttemptsPerMinute" must be 1–600';
                if (pr.notifyAfterAttempts !== undefined && (typeof pr.notifyAfterAttempts !== 'number' || pr.notifyAfterAttempts < 1 || pr.notifyAfterAttempts > 100000)) return '"persistentRetry.notifyAfterAttempts" must be a positive integer';
                if (pr.notifyEmail !== undefined && pr.notifyEmail !== '' && (typeof pr.notifyEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pr.notifyEmail))) return '"persistentRetry.notifyEmail" must be a valid email';
                // Mutually exclusive with the bounded per-destination retry override
                if (pr.enabled === true && dest.retry) {
                    return 'A destination cannot have both "retry" override and "persistentRetry" enabled — pick one';
                }
            }
        } else {
            return 'Targets must be strings or valid WebhookDestination objects';
        }
    }

    return null;
}

// ─── TCP/UDP Profile Persistence ─────────────────────────────────────────────

export function loadPersistedTcpUdpProfiles(): TcpUdpProfile[] {
    try {
        if (!existsSync(TCPUDP_FILE)) return [];
        const raw = readFileSync(TCPUDP_FILE, 'utf-8');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stored: any[] = JSON.parse(raw);
        return stored
            .filter(p => p.name && p.upstreamHost)
            .map(p => {
                // Migrate old format: port + inboundTls → listeners array
                if (!Array.isArray(p.listeners)) {
                    const transport = p.inboundTls ? 'tls' : 'tcp';
                    p.listeners = [{ transport, port: p.port ?? 0 }];
                    delete p.port;
                    delete p.inboundTls;
                }
                return p as TcpUdpProfile;
            });
    } catch (err) {
        console.warn('⚠️  Could not load TCP/UDP profiles:', err instanceof Error ? err.message : err);
        return [];
    }
}

export function persistTcpUdpProfiles(profiles: TcpUdpProfile[]): void {
    try {
        ensureDataDir();
        writeFileSync(TCPUDP_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
    } catch (err) {
        console.warn('⚠️  Could not persist TCP/UDP profiles:', err instanceof Error ? err.message : err);
    }
}

export function validateTcpUdpProfileInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';
    const p = input as Record<string, unknown>;

    if (!p.name || typeof p.name !== 'string') return '"name" is required (string)';
    if (p.name.length > 64) return '"name" must be 64 characters or fewer';
    if (!/^[a-z0-9_-]+$/.test(p.name)) return '"name" must only contain lowercase letters, numbers, hyphens and underscores';
    if (!p.upstreamHost || typeof p.upstreamHost !== 'string') return '"upstreamHost" is required (string)';

    // Validate listeners array
    if (!Array.isArray(p.listeners) || p.listeners.length === 0)
        return '"listeners" must be a non-empty array of { transport, port } objects';
    const validTransports = new Set(['tcp', 'udp', 'tls']);
    for (const l of p.listeners as unknown[]) {
        if (!l || typeof l !== 'object') return 'Each listener must be an object';
        const t = (l as Record<string, unknown>).transport as string;
        if (!validTransports.has(t)) return `Listener transport "${t}" must be "tcp", "udp" or "tls"`;
    }

    // TLS cert: must reference a cert in the central store via certId.
    // Legacy tlsCert/acmeDomain are accepted on disk for migration but a new/
    // edited profile from the API must have certId.
    const hasTls = (p.listeners as { transport: string }[]).some(l => l.transport === 'tls');
    if (hasTls && !p.certId && !p.acmeDomain && !p.tlsCert) {
        return 'TLS listener requires "certId" — create a certificate first';
    }
    if (p.upstreamPort !== undefined && (typeof p.upstreamPort !== 'number' || p.upstreamPort < 1 || p.upstreamPort > 65535))
        return '"upstreamPort" must be 1–65535';
    if (p.upstreamTransport !== undefined &&
        p.upstreamTransport !== 'udp' &&
        p.upstreamTransport !== 'tcp' &&
        p.upstreamTransport !== 'tls')
        return '"upstreamTransport" must be "udp", "tcp" or "tls"';
    return null;
}
