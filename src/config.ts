import type { Config, ProxyProfile } from './types';
import { ConfigError } from './types';

/**
 * Scan environment variables for proxy profiles.
 * Pattern: PROXY_{NAME}_URL, PROXY_{NAME}_KEY, PROXY_{NAME}_HEADER, etc.
 */
function loadProxyProfiles(): ProxyProfile[] {
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
        if (!profile.targetUrl || !profile.apiKey || !profile.authHeader) {
            console.warn(`⚠️  Proxy profile "${name}" is incomplete (needs URL, KEY, and HEADER). Skipping.`);
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

    return {
        port: parseInt(port, 10),
        targetUrl: targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl,
        authToken,
        forwardPath,
        proxyProfiles,
    };
}

