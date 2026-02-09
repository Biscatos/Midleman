import type { Config } from './types';
import { ConfigError } from './types';

/**
 * Load and validate environment configuration
 */
export function loadConfig(): Config {

    const port = process.env.PORT || '3000';
    const targetUrl = process.env.TARGET_URL;
    const authToken = process.env.AUTH_TOKEN;

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

    return {
        port: parseInt(port, 10),
        targetUrl: targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl,
        authToken,
    };
}
