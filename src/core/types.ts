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
  consentEnabled?: boolean; // Show a consent modal on the login page before sign-in
  consentPageId?: number | null; // Reference to consent_pages.id (auth DB). null = no page linked.
  allowSelfSignedTls?: boolean; // If true, skip TLS certificate validation for this upstream (for internal services)
  supabaseMode?: boolean; // If true (with authMode='login'): keeps the static apiKey header (Supabase anon key) AND adds Authorization: Bearer <userJwt> from the login cookie, so Supabase RLS sees the authenticated user.

  // -- Nginx Proxy Manager integration (optional addon) --
  // Public hostnames to be served by NPM in front. Empty/undefined = profile is not synced to NPM.
  publicHostnames?: string[];
  tlsMode?: 'auto-acme' | 'manual' | 'none';
  npmCertificateId?: number;   // NPM cert id once issued/associated
  npmProxyHostId?: number;     // NPM proxy-host id once created/adopted
  /** When set, this profile was created by adopting an existing NPM host.
   *  These fields capture the original forward target so we can restore it on release. */
  npmOriginalForwardHost?: string;
  npmOriginalForwardPort?: number;
  npmOriginalForwardScheme?: 'http' | 'https';
  http2?: boolean;             // NPM toggle (default true)
  hstsEnabled?: boolean;       // NPM toggle
  sslForced?: boolean;         // NPM toggle: redirect 80→443
  allowWebsocketUpgrade?: boolean; // NPM toggle: allow WebSocket upgrade headers
  advancedConfig?: string;     // NPM advanced_config — raw nginx directives
  /** Optional NPM custom locations — extra location blocks with their own upstream. */
  npmLocations?: NpmCustomLocation[];
}

/**
 * Custom location block synced to NPM's `locations` array.
 * Lets you route specific paths to a different upstream than the profile default.
 */
export interface NpmCustomLocation {
  path: string;                                // e.g. "/api"
  forwardScheme?: 'http' | 'https';            // default "http"
  forwardHost: string;                         // upstream host (e.g. "api.internal")
  forwardPort: number;                         // upstream port
  advancedConfig?: string;                     // raw nginx directives for this location
}



export interface WebhookRetryConfig {
  maxRetries: number;           // Number of retry attempts after the first failure (0 = no retries)
  retryDelayMs?: number;        // Base delay between retries in ms (default: 1000)
  retryOn?: number[];           // HTTP status codes that trigger a retry (default: [429, 502, 503, 504])
  backoff?: 'fixed' | 'exponential'; // Backoff strategy (default: 'exponential')
  retryUntilSuccess?: boolean;  // If true, retry on ANY non-2xx response until maxRetries is exhausted
}

/**
 * Persistent retry configuration. When `enabled`, a target that fails all
 * in-line retries is enqueued to the pending-retry queue and retried forever
 * (or until manually dismissed) at a throttled rate.
 */
export interface WebhookPersistentRetry {
  enabled: boolean;
  /** Cap on attempts per minute. Default 10 ⇒ min interval ≈ 6s. */
  maxAttemptsPerMinute?: number;
  /** Address to alert when notifyAfterAttempts is crossed. Empty = no email. */
  notifyEmail?: string;
  /** Send an alert once this many persistent attempts have failed. Default 10. */
  notifyAfterAttempts?: number;
}

export interface WebhookDestination {
  url: string;
  method?: string; // e.g. "POST", "GET"
  customHeaders?: Record<string, string>;
  forwardHeaders?: boolean; // If true, inherit all incoming request headers
  bodyTemplate?: string; // uses {{field}} syntax, supports {{path || "fallback"}} and {{path || other.path}}
  /** When true and a bodyTemplate produces valid JSON, recursively strip keys
   *  whose value is null/undefined/"" before delivering. */
  dropEmpty?: boolean;
  retry?: WebhookRetryConfig; // Per-destination retry config (overrides distributor-level)
  /** Per-destination persistent retry. When enabled, failures go to the
   *  pending-retry queue (not the DLQ) and are retried indefinitely. */
  persistentRetry?: WebhookPersistentRetry;
}

/**
 * Webhook Fan-out distributor: listens on a dedicated port
 * and duplicates or transforms incoming requests to multiple upstream URLs.
 */
/**
 * Silence alert: notify by email when the webhook hasn't received any payload
 * for at least `thresholdMinutes`. Only fires once per silence episode; reset
 * when a new payload arrives. Webhooks that never received a payload are not
 * considered "silent" — the timer starts at the first real delivery.
 */
export interface WebhookSilenceAlert {
  enabled: boolean;
  /** Minutes of inactivity before firing the alert. */
  thresholdMinutes: number;
  /** Destination email address. SMTP must be configured. */
  notifyEmail: string;
}

export interface WebhookDistributor {
  name: string;           // Unique identifier
  port: number;           // Dedicated listening port (0 = auto-assign)
  targets: (string | WebhookDestination)[];      // Array of upstream destinations
  authToken?: string;     // Optional auth token to restrict inbound requests
  retry?: WebhookRetryConfig; // Default retry config for all targets (can be overridden per-destination)
  allowedIps?: string[];  // Optional IP allowlist (exact, CIDR, wildcard). Empty = unrestricted.
  silenceAlert?: WebhookSilenceAlert; // Optional inactivity notifier
  /** Persisted JSON test payload used by the dashboard editor to preview
   *  template interpolation. Has no runtime effect on delivery. */
  testPayload?: string;

  // -- Nginx Proxy Manager adoption (optional addon) --
  npmProxyHostId?: number;
  npmOriginalForwardHost?: string;
  npmOriginalForwardPort?: number;
  npmOriginalForwardScheme?: 'http' | 'https';
  publicHostnames?: string[];
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

  // -- Certificate selection (TLS listeners) --
  // Pick a cert from the central store (managed under Settings → Certificates).
  // The legacy in-profile fields below are kept for backwards-compat read; new
  // profiles use `certId`. Startup migration converts legacy to certId.
  certId?: number;                     // Reference to certs.id

  // -- DEPRECATED — kept for migration only. New code reads `certId`. --
  tlsCert?: string;                    // [legacy] Path to TLS certificate PEM
  tlsKey?: string;                     // [legacy] Path to TLS private key PEM
  acmeDomain?: string;                 // [legacy] Domain for ACME
  acmeEmail?: string;                  // [legacy] Let's Encrypt account email
  acmeDataDir?: string;                // [legacy] Per-profile ACME dir
  acmeStaging?: boolean;               // [legacy] LE staging endpoint

  allowedIps?: string[];               // IP allowlist — empty = unrestricted
  authToken?: string;                  // Optional token auth (TCP only, checked on first bytes)

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

  // -- Message logging (currently SIP-decoded; protocol-agnostic schema) --
  logMessages?: boolean;               // Persist every parseable message to the log (default: false)
  logMessageBody?: boolean;            // Include full message body (SDP, etc.) — implies logMessages
  logNoise?: boolean;                  // Include SIP 100 Trying and OPTIONS keepalives (default: false)

  // -- Raw connection logging (TCP/TLS only; UDP is connectionless) --
  logConnections?: boolean;            // One row per accepted connection: peer, bytes, duration (default: false)
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
  fullName?: string;
  email?: string;
  totpEnabled?: boolean;
  createdByUserId?: number | null;
  authSource?: 'local' | 'ldap';
  ldapConfigId?: number | null;
  ldapDn?: string | null;
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
  /** If true, user is forced to set up TOTP on their next login regardless of profile config. */
  force2faSetup?: boolean;
  createdAt: string;
  authSource?: 'local' | 'ldap' | 'admin_shadow';
  ldapConfigId?: number | null;
  ldapDn?: string | null;
  ldapOrphan?: boolean;
  /** True if 'admin' is present in the comma-separated `roles` column. */
  isAdmin?: boolean;
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
