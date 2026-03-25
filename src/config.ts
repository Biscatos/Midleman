import type { Config, ProxyProfile } from './types';
import { ConfigError } from './types';
import { readFileSync } from 'fs';
import { resolve } from 'path';
5
/**
 * Re-read .env file and update process.env with new/changed values.
 * Only updates PROXY_* variables to avoid changing core config at runtime.
 */
export function reloadEnvFile(): void {
    try {
        const envPath = resolve(process.cwd(), '.env');
        const content = readFileSync(envPath, 'utf-8');

        // Clear existing PROXY_* env vars first
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('PROXY_')) {
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

            // Only reload PROXY_* variables
            if (key.startsWith('PROXY_')) {
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
 * Load and validate environment configuration
 */
export function loadConfig(): Config {

    const port = process.env.PORT || '3000';
    const targetUrl = process.env.TARGET_URL;
    const authToken = process.env.AUTH_TOKEN;
    const forwardPath = process.env.FORWARD_PATH !== 'false'; // Default: true

    // Validate required environment variables
    if (!targetUrl) {
        throw new ConfigError('TARGET_URL environment variable is required');
    }

    // AUTH_TOKEN is optional - if not provided, authentication is disabled
    if (!authToken) {
        console.warn('⚠️  AUTH_TOKEN not set - authentication is DISABLED');
        console.warn('⚠️  All incoming requests will be forwarded without authentication checks');
    }

    // Validate TARGET_URL format
    try {
        new URL(targetUrl);
    } catch {
        throw new ConfigError('TARGET_URL must be a valid URL');
    }

    // Load proxy profiles
    const proxyProfiles = loadProxyProfiles();

    // OpenTelemetry configuration
    const otel = {
        enabled: process.env.OTEL_ENABLED === 'true',
        endpoint: process.env.OTEL_ENDPOINT || 'http://localhost:4318',
        serviceName: process.env.OTEL_SERVICE_NAME || 'midleman',
        metricsInterval: parseInt(process.env.OTEL_METRICS_INTERVAL || '15000', 10),
    };

    return {
        port: parseInt(port, 10),
        targetUrl: targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl,
        authToken,
        forwardPath,
        proxyProfiles,
        otel,
    };
}

