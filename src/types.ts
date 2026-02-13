/**
 * Proxy profile for bypassing upstream authentication
 */
export interface ProxyProfile {
  name: string;           // Profile identifier (e.g., "infobip")
  targetUrl: string;      // Base URL of the upstream service
  apiKey: string;         // API key for upstream authentication
  authHeader: string;     // Header name for the API key (e.g., "Authorization")
  authPrefix?: string;    // Optional prefix (e.g., "Bearer", "App")
  accessKey?: string;     // Optional key to protect the public link
}

/**
 * Application configuration interface
 */
export interface Config {
  port: number;
  targetUrl: string;
  authToken?: string; // Optional: if not set, authentication is disabled
  forwardPath: boolean; // If false, don't append path to target URL
  proxyProfiles: ProxyProfile[]; // Configured proxy bypass profiles
}

/**
 * Custom error for unauthorized requests
 */
export class UnauthorizedError extends Error {
  constructor(message: string = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Custom error for configuration issues
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
