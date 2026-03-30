/**
 * Proxy profile for bypassing upstream authentication
 */
export interface ProxyProfile {
  name: string;           // Profile identifier (e.g., "infobip")
  targetUrl: string;      // Base URL of the upstream service
  apiKey?: string;        // API key for upstream authentication (optional — omit for no-auth targets)
  authHeader?: string;    // Header name for the API key (e.g., "Authorization")
  authPrefix?: string;    // Optional prefix (e.g., "Bearer", "App")
  accessKey?: string;     // Optional key to protect the public link
  blockedExtensions?: Set<string>; // Optional set of blocked file extensions
}

/**
 * Named target — each gets its own Bun.serve() on a dedicated port.
 */
export interface ProxyTarget {
  name: string;           // Unique identifier (e.g., "api", "webhook")
  targetUrl: string;      // Upstream URL to forward to
  port: number;           // Dedicated listening port (0 = auto-assign)
  authToken?: string;     // Per-target auth token (optional)
  forwardPath: boolean;   // Whether to append incoming path to target URL
}

export interface WebhookDestination {
  url: string;
  method?: string; // e.g. "POST", "GET"
  customHeaders?: Record<string, string>;
  forwardHeaders?: boolean; // If true, inherit all incoming request headers
  bodyTemplate?: string; // uses {{field}} syntax
}

/**
 * Webhook Fan-out distributor: listens on a dedicated port
 * and duplicates or transforms incoming requests to multiple upstream URLs.
 */
export interface WebhookDistributor {
  name: string;           // Unique identifier
  port: number;           // Dedicated listening port (0 = auto-assign)
  targets: (string | WebhookDestination)[];      // Array of upstream destinations
  authToken?: string;     // Optional auth token to restrict inbound requests
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
  proxyTargets: ProxyTarget[];   // Named targets with dedicated ports
  webhooks: WebhookDistributor[]; // Configured webhook distributors
  otel: {
    enabled: boolean;
    endpoint: string;
    serviceName: string;
    metricsInterval: number;
  };
  requestLog: {
    enabled: boolean;
    dataDir: string;
    retentionDays: number;
    maxBodySize: number;
  };
  auth: {
    sessionMaxAge: number;
    cookieName: string;
  };
}

export interface AuthUser {
  id: number;
  username: string;
  createdAt: string;
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
