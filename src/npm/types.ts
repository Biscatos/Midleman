// Type definitions for Nginx Proxy Manager REST API resources.

export interface NpmTokenResponse {
    token: string;
    expires: string; // ISO 8601
}

export interface NpmCertificate {
    id: number;
    provider: 'letsencrypt' | 'other';
    nice_name: string;
    domain_names: string[];
    expires_on?: string;
    meta?: Record<string, unknown>;
}

export interface NpmProxyHost {
    id: number;
    domain_names: string[];
    forward_host: string;
    forward_port: number;
    forward_scheme: 'http' | 'https';
    certificate_id: number | 'new' | null;
    ssl_forced: boolean;
    http2_support: boolean;
    hsts_enabled: boolean;
    hsts_subdomains?: boolean;
    advanced_config?: string;
    block_exploits?: boolean;
    allow_websocket_upgrade?: boolean;
    caching_enabled?: boolean;
    meta?: Record<string, unknown>;
    enabled?: boolean;
    locations?: Array<Record<string, unknown>>;
}

export interface NpmProxyHostPayload {
    domain_names: string[];
    forward_host: string;
    forward_port: number;
    forward_scheme: 'http' | 'https';
    certificate_id: number | null;
    ssl_forced: boolean;
    http2_support: boolean;
    hsts_enabled: boolean;
    hsts_subdomains?: boolean;
    advanced_config?: string;
    block_exploits?: boolean;
    allow_websocket_upgrade?: boolean;
    caching_enabled?: boolean;
    meta?: Record<string, unknown>;
    locations?: Array<Record<string, unknown>>;
}

export interface NpmCertificatePayload {
    provider: 'letsencrypt';
    nice_name?: string;
    domain_names: string[];
    meta: {
        letsencrypt_agree: boolean;
        letsencrypt_email: string;
        dns_challenge?: boolean;
    };
}

export interface NpmHealth {
    status: string;
    version?: string;
}
