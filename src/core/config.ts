import type { Config, ProxyProfile, TcpUdpProfile, TcpUdpListener } from './types';
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
        if (!value) continue;

        let prefix = '';
        if (key.startsWith('PROXY_')) prefix = 'PROXY_';
        else if (key.startsWith('TARGET_') && key !== 'TARGET_URL') prefix = 'TARGET_';
        else continue;

        const parts = key.substring(prefix.length).split('_');
        if (parts.length < 2) continue;

        const field = parts[parts.length - 1];
        const name = parts.slice(0, -1).join('_').toLowerCase();

        if (!profiles.has(name)) {
            profiles.set(name, { name, passthrough: prefix === 'TARGET_', forwardPath: true });
        }

        const profile = profiles.get(name)!;

        if (prefix === 'PROXY_') {
            switch (field) {
                case 'URL': profile.targetUrl = value.endsWith('/') ? value.slice(0, -1) : value; break;
                case 'KEY': profile.apiKey = value; break;
                case 'HEADER': profile.authHeader = value; break;
                case 'PREFIX': profile.authPrefix = value; break;
                case 'ACCESS': profile.accessKey = value; break;
                case 'BLOCKED': profile.blockedExtensions = new Set(value.split(',').map(e => e.trim().toLowerCase().replace(/^\.?/, '.'))); break;
            }
        } else {
            switch (field) {
                case 'URL': profile.targetUrl = value.endsWith('/') ? value.slice(0, -1) : value; break;
                case 'PORT': profile.port = parseInt(value, 10); break;
                case 'AUTH': profile.authToken = value; break;
                case 'FWDPATH': profile.forwardPath = value !== 'false'; break;
            }
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



const VALID_TRANSPORTS = new Set(['tcp', 'udp', 'tls']);

// Suffix → field name for TCPUDP_ env vars
const TCPUDP_FIELD_SUFFIXES: [string, string][] = [
    ['_UPSTREAM_HOST',      'upstreamHost'],
    ['_UPSTREAM_PORT',      'upstreamPort'],
    ['_UPSTREAM_TRANSPORT', 'upstreamTransport'],
    ['_LISTENERS',          'listeners'],   // e.g. "udp,tls" → [{ transport:'udp',port:0 }, { transport:'tls',port:0 }]
    ['_TLS_CERT',           'tlsCert'],
    ['_TLS_KEY',            'tlsKey'],
    ['_ALLOWED_IPS',        'allowedIps'],
    ['_AUTH_TOKEN',         'authToken'],
    ['_ACME_DOMAIN',        'acmeDomain'],
    ['_ACME_EMAIL',         'acmeEmail'],
    ['_ACME_DATA_DIR',      'acmeDataDir'],
    ['_ACME_STAGING',              'acmeStaging'],
    ['_SIP_PUBLIC_HOST',           'sipPublicHost'],
    ['_ALLOW_SELF_SIGNED_UPSTREAM','allowSelfSignedUpstream'],
    ['_RTP_RELAY',                 'rtpRelay'],
    ['_RTP_PORT_START',            'rtpPortStart'],
    ['_RTP_PORT_END',              'rtpPortEnd'],
    ['_RTP_WORKERS',               'rtpWorkers'],
];

/**
 * Scan environment variables for TCP/UDP proxy profiles.
 * Pattern: TCPUDP_{NAME}_{FIELD}
 *
 * Example:
 *   TCPUDP_META_UPSTREAM_HOST=192.168.1.100
 *   TCPUDP_META_UPSTREAM_PORT=5060
 *   TCPUDP_META_UPSTREAM_TRANSPORT=udp
 *   TCPUDP_META_LISTENERS=udp,tls   (comma-separated: udp, tcp, tls)
 *   TCPUDP_META_TLS_CERT=/etc/ssl/certs/sip.pem
 *   TCPUDP_META_TLS_KEY=/etc/ssl/private/sip.key
 */
export function loadTcpUdpProfiles(): TcpUdpProfile[] {
    const raw = new Map<string, Record<string, unknown>>();

    for (const [key, value] of Object.entries(process.env)) {
        if (!value || !key.startsWith('TCPUDP_')) continue;

        for (const [suffix, field] of TCPUDP_FIELD_SUFFIXES) {
            if (!key.endsWith(suffix)) continue;
            const name = key.slice('TCPUDP_'.length, key.length - suffix.length).toLowerCase();
            if (!name) continue;

            if (!raw.has(name)) raw.set(name, { name });
            const p = raw.get(name)!;

            if (field === 'upstreamPort') {
                p.upstreamPort = parseInt(value, 10);
            } else if (field === 'acmeStaging' || field === 'allowSelfSignedUpstream' || field === 'rtpRelay') {
                p[field] = value === 'true';
            } else if (field === 'rtpPortStart' || field === 'rtpPortEnd' || field === 'rtpWorkers') {
                p[field] = parseInt(value, 10);
            } else if (field === 'allowedIps') {
                p.allowedIps = value.split(',').map(s => s.trim()).filter(Boolean);
            } else if (field === 'listeners') {
                p.listeners = value.split(',')
                    .map(s => s.trim().toLowerCase())
                    .filter(t => VALID_TRANSPORTS.has(t))
                    .map(transport => ({ transport, port: 0 }));
            } else {
                p[field] = value;
            }
            break;
        }
    }

    const valid: TcpUdpProfile[] = [];

    for (const [name, p] of raw) {
        if (!p.upstreamHost) {
            console.warn(`⚠️  TCP/UDP profile "${name}" is incomplete (needs UPSTREAM_HOST). Skipping.`);
            continue;
        }
        valid.push({
            name,
            listeners: (p.listeners as TcpUdpListener[] | undefined) ?? [{ transport: 'tcp', port: 0 }],
            upstreamHost: p.upstreamHost as string,
            upstreamPort: (p.upstreamPort as number) ?? 5060,
            upstreamTransport: (p.upstreamTransport as 'tcp' | 'udp') ?? 'udp',
            tlsCert: p.tlsCert as string | undefined,
            tlsKey: p.tlsKey as string | undefined,
            allowedIps: p.allowedIps as string[] | undefined,
            authToken: p.authToken as string | undefined,
            acmeDomain: p.acmeDomain as string | undefined,
            acmeEmail: p.acmeEmail as string | undefined,
            acmeDataDir: p.acmeDataDir as string | undefined,
            acmeStaging: p.acmeStaging as boolean | undefined,
            sipPublicHost: p.sipPublicHost as string | undefined,
            allowSelfSignedUpstream: p.allowSelfSignedUpstream as boolean | undefined,
            rtpRelay: p.rtpRelay as boolean | undefined,
            rtpPortStart: p.rtpPortStart as number | undefined,
            rtpPortEnd: p.rtpPortEnd as number | undefined,
            rtpWorkers: p.rtpWorkers as number | undefined,
        });
    }

    return valid;
}

/**
 * Load and validate environment configuration
 */
export function loadConfig(): Config {

    const port = process.env.PORT || '3000';
    const targetUrl = process.env.TARGET_URL || '';
    const authToken = process.env.AUTH_TOKEN;
    const forwardPath = process.env.FORWARD_PATH !== 'false'; // Default: true

    // Load proxy profiles and targets
    const proxyProfiles = loadProxyProfiles();

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
        webhooks: [], // Populated in index.ts from store
        tcpUdpProfiles: loadTcpUdpProfiles(),
        otel,
        requestLog,
        auth,
    };
}
