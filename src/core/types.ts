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
  authMode?: 'none' | 'accessKey' | 'login'; // Auth mode: none=public, accessKey=static key, login=user login with JWT
  require2fa?: boolean;   // If true, users MUST have TOTP enabled to access this profile (login mode only)
  isWebApp?: boolean;     // If true, treat as a web application (show login page instead of JSON 401)
  disableLogs?: boolean;  // If true, skip request/response logging for this profile
  blockedExtensions?: Set<string>; // Optional set of blocked file extensions
  allowedIps?: string[];  // Optional IP allowlist (exact, CIDR, wildcard). Empty = unrestricted.
  
  // -- Target/Standalone Proxy Features --
  port?: number;          // Dedicated listening port. If 0, auto-assigns. If omitted, uses the main proxy root prefix (/proxy/{name}/).
  forwardPath?: boolean;  // Whether to append incoming path to target URL (defaults to true)
  passthrough?: boolean;  // If true, disable HTML rewriting and stream unconditionally
  authToken?: string;     // Simple token auth (X-Forward-Token or ?token=) for API connections
  loginTitle?: string;    // Custom brand title shown on the proxy login page (login mode only)
  loginLogo?: string;     // Custom logo URL shown on the proxy login page (login mode only)
  allowSelfSignedTls?: boolean; // If true, skip TLS certificate validation for this upstream (for internal services)
}



export interface WebhookRetryConfig {
  maxRetries: number;           // Number of retry attempts after the first failure (0 = no retries)
  retryDelayMs?: number;        // Base delay between retries in ms (default: 1000)
  retryOn?: number[];           // HTTP status codes that trigger a retry (default: [429, 502, 503, 504])
  backoff?: 'fixed' | 'exponential'; // Backoff strategy (default: 'exponential')
  retryUntilSuccess?: boolean;  // If true, retry on ANY non-2xx response until maxRetries is exhausted
}

export interface WebhookDestination {
  url: string;
  method?: string; // e.g. "POST", "GET"
  customHeaders?: Record<string, string>;
  forwardHeaders?: boolean; // If true, inherit all incoming request headers
  bodyTemplate?: string; // uses {{field}} syntax
  retry?: WebhookRetryConfig; // Per-destination retry config (overrides distributor-level)
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
  retry?: WebhookRetryConfig; // Default retry config for all targets (can be overridden per-destination)
  allowedIps?: string[];  // Optional IP allowlist (exact, CIDR, wildcard). Empty = unrestricted.
}

/**
 * Application configuration interface
 */
/**
 * A single inbound listener within a TcpUdpProfile.
 * Each listener runs on its own auto-assigned port.
 */
export interface TcpUdpListener {
  transport: 'tcp' | 'udp' | 'tls';
  port: number;  // 0 = auto-assigned by port manager, populated at startup
}

/**
 * Generic TCP/UDP proxy profile.
 *
 * Supports multiple simultaneous inbound listeners (UDP, TCP, TLS) on
 * auto-assigned ports, all forwarding to the same upstream via one shared
 * connection.  Useful for SIP/VoIP where phones connect via UDP, gateways
 * via TCP, and cloud carriers (e.g. Meta WhatsApp) via TLS — all reaching the
 * same FusionPBX without reconfiguring it.
 */
export interface TcpUdpProfile {
  name: string;                        // Unique identifier (e.g. "fusionpbx")
  listeners: TcpUdpListener[];         // One or more inbound listeners (each gets its own port)
  upstreamHost: string;                // Target host IP/hostname
  upstreamPort: number;                // Target port
  upstreamTransport: 'tcp' | 'udp' | 'tls'; // How to reach the upstream ('tls' = TCP+TLS)
  allowSelfSignedUpstream?: boolean;   // Skip TLS cert verification for upstream (only when upstreamTransport='tls')

  // -- TLS fields — shared across all TLS listeners in this profile --
  tlsCert?: string;                    // Path to TLS certificate PEM
  tlsKey?: string;                     // Path to TLS private key PEM
  allowedIps?: string[];               // IP allowlist — empty = unrestricted
  authToken?: string;                  // Optional token auth (TCP only, checked on first bytes)

  // -- ACME / Let's Encrypt (auto-certificate for TLS listeners) --
  acmeDomain?: string;                 // Domain for cert. Enables ACME when set.
  acmeEmail?: string;                  // Let's Encrypt account email (required if acmeDomain set)
  acmeDataDir?: string;                // Where to store account key + cert (default: DATA_DIR/acme/{name})
  acmeStaging?: boolean;               // Use LE staging endpoint for testing (default: false)

  // -- SIP routing --
  // SIP Via/Record-Route rewriting is auto-activated when upstreamTransport='udp'.
  // Override the public address put into Via headers only if auto-detection is wrong.
  sipPublicHost?: string;              // Public hostname/IP for Via/Record-Route (default: PROXY_HOST env)

  // -- RTP Media Relay --
  // When enabled, the proxy rewrites SDP (c= and m=) in INVITE/200 OK so that
  // all RTP audio flows through Midleman, allowing FusionPBX to stay on a private network.
  rtpRelay?: boolean;                  // Enable RTP relay (default: false)
  rtpPortStart?: number;               // Start of UDP port range for RTP (default: 50000)
  rtpPortEnd?: number;                 // End of UDP port range for RTP (default: 51000)
  rtpWorkers?: number;                 // Worker threads for RTP relay (0 = main thread, default: auto = CPU cores - 1)
}

export interface Config {
  port: number;
  targetUrl: string;
  authToken?: string; // Optional: if not set, authentication is disabled
  forwardPath: boolean; // If false, don't append path to target URL
  proxyProfiles: ProxyProfile[]; // Configured HTTP proxy bypass profiles
  webhooks: WebhookDistributor[]; // Configured webhook distributors
  tcpUdpProfiles: TcpUdpProfile[]; // Configured TCP/UDP proxy profiles
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
 * A global proxy user that can be granted access to one or more profiles.
 */
export interface ProxyUser {
  id: number;
  username: string;
  fullName: string;
  email: string;
  totpEnabled: boolean;
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
