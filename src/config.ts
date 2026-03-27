import type { Config, ProxyProfile, ProxyTarget } from './types';
import { ConfigError } from './types';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Re-read .env file and update process.env with new/changed values.
 * Reloads PROXY_* and TARGET_* variables to avoid changing core config at runtime.
 */
export function reloadEnvFile(): void {
    try {
        const envPath = resolve(process.cwd(), '.env');
        const content = readFileSync(envPath, 'utf-8');

        // Clear existing PROXY_* and TARGET_* env vars first
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('PROXY_') || (key.startsWith('TARGET_') && key !== 'TARGET_URL')) {
                delete process.env[key];
            }
        }

        // Parse and set new values
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;

            const key = trimmed.substring(0, eqIndex).trim();
            const value = trimmed.substring(eqIndex + 1).trim();

            // Reload PROXY_* and TARGET_* variables
            if (key.startsWith('PROXY_') || (key.startsWith('TARGET_') && key !== 'TARGET_URL')) {
                process.env[key] = value;
            }
        }
    } catch (err) {
        console.warn('⚠️  Could not reload .env file:', err instanceof Error ? err.message : err);
    }
}

/**
 * Scan environment variables for proxy profiles.
 * Pattern: PROXY_{NAME}_URL, PROXY_{NAME}_KEY, PROXY_{NAME}_HEADER, etc.
 */
export function loadProxyProfiles(): ProxyProfile[] {
    const profiles = new Map<string, Partial<ProxyProfile>>();

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('PROXY_') || !value) continue;

        // Parse: PROXY_{NAME}_{FIELD}
        const parts = key.substring(6).split('_'); // Remove "PROXY_"
        if (parts.length < 2) continue;

        // The last part is the field, everything before is the profile name
        const field = parts[parts.length - 1];
        const name = parts.slice(0, -1).join('_').toLowerCase();

        if (!profiles.has(name)) {
            profiles.set(name, { name });
        }

        const profile = profiles.get(name)!;

        switch (field) {
            case 'URL':
                profile.targetUrl = value.endsWith('/') ? value.slice(0, -1) : value;
                break;
            case 'KEY':
                profile.apiKey = value;
                break;
            case 'HEADER':
                profile.authHeader = value;
                break;
            case 'PREFIX':
                profile.authPrefix = value;
                break;
            case 'ACCESS':
                profile.accessKey = value;
                break;
            case 'BLOCKED':
                profile.blockedExtensions = new Set(
                    value.split(',').map(e => e.trim().toLowerCase().replace(/^\.?/, '.'))
                );
                break;
        }
    }

    const validProfiles: ProxyProfile[] = [];

    for (const [name, profile] of profiles) {
        if (!profile.targetUrl) {
            console.warn(`⚠️  Proxy profile "${name}" is incomplete (needs URL). Skipping.`);
            continue;
        }

        // Validate URL format
        try {
            new URL(profile.targetUrl);
        } catch {
            console.warn(`⚠️  Proxy profile "${name}" has an invalid URL: ${profile.targetUrl}. Skipping.`);
            continue;
        }

        validProfiles.push(profile as ProxyProfile);
    }

    return validProfiles;
}

/**
 * Scan environment variables for named targets.
 * Pattern: TARGET_{NAME}_URL, TARGET_{NAME}_PORT, etc.
 * Note: TARGET_URL (no name) is the legacy single-target var and is NOT parsed here.
 */
export function loadProxyTargets(): ProxyTarget[] {
    const targets = new Map<string, Partial<ProxyTarget>>();

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('TARGET_') || !value) continue;

        // Skip the legacy TARGET_URL variable
        if (key === 'TARGET_URL') continue;

        // Parse: TARGET_{NAME}_{FIELD}
        const parts = key.substring(7).split('_'); // Remove "TARGET_"
        if (parts.length < 2) continue;

        // The last part is the field, everything before is the target name
        const field = parts[parts.length - 1];
        const name = parts.slice(0, -1).join('_').toLowerCase();

        if (!targets.has(name)) {
            targets.set(name, { name, forwardPath: true });
        }

        const target = targets.get(name)!;

        switch (field) {
            case 'URL':
                target.targetUrl = value.endsWith('/') ? value.slice(0, -1) : value;
                break;
            case 'PORT':
                target.port = parseInt(value, 10);
                break;
            case 'AUTH':
                target.authToken = value;
                break;
            case 'FWDPATH':
                target.forwardPath = value !== 'false';
                break;
        }
    }

    const validTargets: ProxyTarget[] = [];

    for (const [name, target] of targets) {
        if (!target.targetUrl) {
            console.warn(`⚠️  Target "${name}" is incomplete (needs URL). Skipping.`);
            continue;
        }
        if (!target.port) {
            console.warn(`⚠️  Target "${name}" is incomplete (needs PORT). Skipping.`);
            continue;
        }

        // Validate URL format
        try {
            new URL(target.targetUrl);
        } catch {
            console.warn(`⚠️  Target "${name}" has an invalid URL: ${target.targetUrl}. Skipping.`);
            continue;
        }

        validTargets.push(target as ProxyTarget);
    }

    return validTargets;
}

/**
 * Load and validate environment configuration
 */
export function loadConfig(): Config {

    const port = process.env.PORT || '3000';
    const targetUrl = process.env.TARGET_URL || '';
    const authToken = process.env.AUTH_TOKEN;
    const forwardPath = process.env.FORWARD_PATH !== 'false'; // Default: true

    // AUTH_TOKEN is optional - if not provided, authentication is disabled
    if (!authToken) {
        console.warn('⚠️  AUTH_TOKEN not set - authentication is DISABLED');
        console.warn('⚠️  All incoming requests will be forwarded without authentication checks');
    }

    // Validate TARGET_URL format if provided
    if (targetUrl) {
        try {
            new URL(targetUrl);
        } catch {
            throw new ConfigError('TARGET_URL must be a valid URL');
        }
    }

    // Load proxy profiles and targets
    const proxyProfiles = loadProxyProfiles();
    const proxyTargets = loadProxyTargets();

    // Warn if no target and no targets defined
    if (!targetUrl && proxyTargets.length === 0) {
        console.warn('⚠️  No TARGET_URL or named targets configured — main forwarding is disabled');
    }

    // OpenTelemetry configuration
    const otel = {
        enabled: process.env.OTEL_ENABLED === 'true',
        endpoint: process.env.OTEL_ENDPOINT || 'http://localhost:4318',
        serviceName: process.env.OTEL_SERVICE_NAME || 'midleman',
        metricsInterval: parseInt(process.env.OTEL_METRICS_INTERVAL || '15000', 10),
    };

    // Request logging configuration
    const dataDir = process.env.DATA_DIR || './data';
    const requestLog = {
        enabled: process.env.REQUEST_LOG_ENABLED !== 'false', // default: true
        dataDir,
        retentionDays: parseInt(process.env.REQUEST_LOG_RETENTION_DAYS || '7', 10),
        maxBodySize: parseInt(process.env.REQUEST_LOG_MAX_BODY_SIZE || String(64 * 1024), 10),
    };

    const auth = {
        sessionMaxAge: parseInt(process.env.SESSION_MAX_AGE || '86400', 10),
        cookieName: 'midleman_session',
    };

    return {
        port: parseInt(port, 10),
        targetUrl: targetUrl ? (targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl) : '',
        authToken,
        forwardPath,
        proxyProfiles,
        proxyTargets,
        otel,
        requestLog,
        auth,
    };
}
