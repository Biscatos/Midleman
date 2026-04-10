import type { ProxyProfile, WebhookDistributor } from './types';
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
    port?: number;
    forwardPath?: boolean;
    passthrough?: boolean;
    authToken?: string;
}

// Default path — override with DATA_DIR env var for Docker volumes
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const PROFILES_FILE = resolve(DATA_DIR, 'profiles.json');
const TARGETS_FILE = resolve(DATA_DIR, 'targets.json');
const WEBHOOKS_FILE = resolve(DATA_DIR, 'webhooks.json');

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
    
    if (stored.port !== undefined) profile.port = stored.port;
    if (stored.forwardPath !== undefined) profile.forwardPath = stored.forwardPath;
    if (stored.passthrough !== undefined) profile.passthrough = stored.passthrough;
    if (stored.authToken !== undefined) profile.authToken = stored.authToken;

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
    
    if (profile.port !== undefined) stored.port = profile.port;
    if (profile.forwardPath !== undefined) stored.forwardPath = profile.forwardPath;
    if (profile.passthrough !== undefined) stored.passthrough = profile.passthrough;
    if (profile.authToken !== undefined) stored.authToken = profile.authToken;

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
    if (!p.targetUrl || typeof p.targetUrl !== 'string') return '"targetUrl" is required (string)';
    if (p.apiKey !== undefined && typeof p.apiKey !== 'string') return '"apiKey" must be a string';
    if (p.authHeader !== undefined && typeof p.authHeader !== 'string') return '"authHeader" must be a string';
    if (p.port !== undefined && p.port !== null && p.port !== 0) {
        if (typeof p.port !== 'number' || p.port < 1 || p.port > 65535) return '"port" must be a number between 1 and 65535 (or 0/omitted for auto-assign)';
    }
    if (p.authToken !== undefined && typeof p.authToken !== 'string') return '"authToken" must be a string';
    if (p.forwardPath !== undefined && typeof p.forwardPath !== 'boolean') return '"forwardPath" must be a boolean';
    if (p.passthrough !== undefined && typeof p.passthrough !== 'boolean') return '"passthrough" must be a boolean';

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
            .filter(w => w.name && Array.isArray(w.targets) && w.targets.length > 0)
            .map(w => ({
                name: w.name.toLowerCase(),
                port: w.port,
                targets: w.targets.map(t => typeof t === 'string' ? (t.endsWith('/') ? t.slice(0, -1) : t) : t),
                authToken: w.authToken,
                retry: w.retry,
                allowedIps: w.allowedIps?.length ? w.allowedIps : undefined,
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
        }));
        writeFileSync(WEBHOOKS_FILE, JSON.stringify(stored, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Could not save webhooks.json:', err instanceof Error ? err.message : err);
        throw err;
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

    for (const target of w.targets) {
        if (typeof target === 'string') {
            try { new URL(target); } catch { return `"${target}" is not a valid URL`; }
        } else if (typeof target === 'object' && target !== null) {
            const dest = target as Record<string, unknown>;
            if (typeof dest.url !== 'string') return 'Custom action must have a valid string "url"';
            try { new URL(dest.url); } catch { return `"${dest.url}" is not a valid URL`; }
            if (dest.method && typeof dest.method !== 'string') return '"method" must be a string';
            if (dest.bodyTemplate && typeof dest.bodyTemplate !== 'string') return '"bodyTemplate" must be a string';
            if (dest.customHeaders && typeof dest.customHeaders !== 'object') return '"customHeaders" must be an object';
            if (dest.forwardHeaders !== undefined && typeof dest.forwardHeaders !== 'boolean') return '"forwardHeaders" must be a boolean';
        } else {
            return 'Targets must be strings or valid WebhookDestination objects';
        }
    }

    return null;
}
