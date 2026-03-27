import type { ProxyProfile, ProxyTarget } from './types';
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
    blockedExtensions?: string[];
}

// Default path — override with DATA_DIR env var for Docker volumes
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const PROFILES_FILE = resolve(DATA_DIR, 'profiles.json');
const TARGETS_FILE = resolve(DATA_DIR, 'targets.json');

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

    if (stored.blockedExtensions && stored.blockedExtensions.length > 0) {
        profile.blockedExtensions = new Set(
            stored.blockedExtensions.map(e => e.trim().toLowerCase().replace(/^\.?/, '.'))
        );
    }

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
    if (profile.blockedExtensions && profile.blockedExtensions.size > 0) {
        stored.blockedExtensions = Array.from(profile.blockedExtensions);
    }

    return stored;
}

/**
 * Load profiles from the persistent JSON file.
 * Returns empty array if file doesn't exist.
 */
export function loadPersistedProfiles(): ProxyProfile[] {
    try {
        if (!existsSync(PROFILES_FILE)) return [];

        const raw = readFileSync(PROFILES_FILE, 'utf-8');
        const stored: StoredProfile[] = JSON.parse(raw);

        return stored
            .filter(p => p.name && p.targetUrl)
            .map(toRuntime);
    } catch (err) {
        console.warn('⚠️  Could not load profiles.json:', err instanceof Error ? err.message : err);
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

    // Validate URL
    try {
        new URL(p.targetUrl as string);
    } catch {
        return '"targetUrl" must be a valid URL';
    }

    return null;
}

// ─── Target Persistence ─────────────────────────────────────────────────────

interface StoredTarget {
    name: string;
    targetUrl: string;
    port: number;
    authToken?: string;
    forwardPath: boolean;
}

/**
 * Load targets from the persistent JSON file.
 */
export function loadPersistedTargets(): ProxyTarget[] {
    try {
        if (!existsSync(TARGETS_FILE)) return [];

        const raw = readFileSync(TARGETS_FILE, 'utf-8');
        const stored: StoredTarget[] = JSON.parse(raw);

        return stored
            .filter(t => t.name && t.targetUrl && t.port)
            .map(t => ({
                name: t.name.toLowerCase(),
                targetUrl: t.targetUrl.endsWith('/') ? t.targetUrl.slice(0, -1) : t.targetUrl,
                port: t.port,
                authToken: t.authToken,
                forwardPath: t.forwardPath !== false,
            }));
    } catch (err) {
        console.warn('⚠️  Could not load targets.json:', err instanceof Error ? err.message : err);
        return [];
    }
}

/**
 * Save targets to the persistent JSON file.
 */
export function persistTargets(targets: ProxyTarget[]): void {
    try {
        ensureDataDir();
        const stored: StoredTarget[] = targets.map(t => ({
            name: t.name,
            targetUrl: t.targetUrl,
            port: t.port,
            authToken: t.authToken,
            forwardPath: t.forwardPath,
        }));
        writeFileSync(TARGETS_FILE, JSON.stringify(stored, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Could not save targets.json:', err instanceof Error ? err.message : err);
        throw err;
    }
}

/**
 * Merge env-based targets with persisted targets.
 * Persisted targets take precedence (override by name).
 */
export function mergeTargets(envTargets: ProxyTarget[], persistedTargets: ProxyTarget[]): ProxyTarget[] {
    const merged = new Map<string, ProxyTarget>();

    for (const t of envTargets) {
        merged.set(t.name, t);
    }
    for (const t of persistedTargets) {
        merged.set(t.name, t);
    }

    return Array.from(merged.values());
}

/**
 * Validate a target object from API input.
 */
export function validateTargetInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';

    const t = input as Record<string, unknown>;

    if (!t.name || typeof t.name !== 'string') return '"name" is required (string)';
    if (!t.targetUrl || typeof t.targetUrl !== 'string') return '"targetUrl" is required (string)';
    if (!t.port || typeof t.port !== 'number' || t.port < 1 || t.port > 65535) return '"port" is required (number 1-65535)';

    try {
        new URL(t.targetUrl as string);
    } catch {
        return '"targetUrl" must be a valid URL';
    }

    return null;
}
