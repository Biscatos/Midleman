/**
 * Five9 Digital Engagement connector types.
 *
 * A Five9 connector bridges a client channel (Meta WhatsApp, generic webhook)
 * to a Five9 conversation:
 *
 *   inbound:   channel message → (create/reuse Five9 conversation) → send to agent
 *   callback:  Five9 push event → fan-out (Meta and/or webhook targets)
 *   transfer:  POST /five9/transfer → create conversation with context
 *
 * No poller — Five9 is push-only via the configured callbackUrl.
 */

import type { ConnectorChannel, MetaSettings, SmoochSettings, ConnectorWebhookTarget } from './connector-types';
import { assertSafeOutboundUrl, SsrfBlockedError } from './ssrf-guard';

export interface Five9Settings {
    /** Five9 DC-specific auth endpoint, e.g. "https://app.nld1.eu.five9.com".
     *  The anonymous auth path is appended automatically. */
    authBaseUrl: string;
    /** Five9 tenant name sent in the anon auth body, e.g. "ALIVA". */
    tenantName: string;
    /** Five9 campaign name for conversation routing. */
    campaignName: string;
    /** Full public URL where Five9 will push callback events, e.g.
     *  "https://midleman.example.com/five9/callback".
     *  If callbackToken is set, Midleman automatically appends
     *  "?token={callbackToken}" when creating each conversation. */
    callbackUrl: string;
    /** Shared secret used to validate incoming Five9 callbacks.
     *  Midleman appends it as ?token= to the callbackUrl it registers with Five9,
     *  then verifies it on each incoming request. */
    callbackToken?: string;
}

export interface Five9Connector {
    name: string;
    port: number;
    enabled?: boolean;

    channel: ConnectorChannel;
    five9: Five9Settings;

    /** Inbound verify token: hub.verify_token for Meta, X-Forward-Token for generic. */
    verifyToken?: string;
    allowedIps?: string[];

    meta?: MetaSettings;
    smooch?: SmoochSettings;

    /** Only process inbound messages whose metadata.phone_number_id is in this list. */
    phoneNumberFilter?: string[];

    /** Send agent replies directly to the customer via the channel provider. */
    directReply?: boolean;

    webhookTargets?: ConnectorWebhookTarget[];
    webhooksEnabled?: boolean;

    autoReply?: {
        enabled: boolean;
        text: string;
        expiresAt?: string;
    };

    /** Idle session expiry in minutes (default 120). */
    sessionTtlMinutes?: number;

    /** SSRF policy overrides for outbound HTTP calls. */
    allowPrivateTargets?: boolean;
    targetAllowedCidrs?: string[];
}

/** Validate a Five9Connector object from API input. Returns an error string or null. */
export function validateFive9ConnectorInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';
    const c = input as Record<string, unknown>;

    if (!c.name || typeof c.name !== 'string') return '"name" is required (string)';
    if (!/^[a-z0-9_-]+$/.test(c.name)) return '"name" may only contain lowercase letters, numbers, hyphens and underscores';
    if (c.name.length < 2 || c.name.length > 48) return '"name" must be between 2 and 48 characters';

    if (c.port !== undefined && c.port !== null && c.port !== 0) {
        if (typeof c.port !== 'number' || c.port < 1 || c.port > 65535) return '"port" must be 1–65535 (or 0/omitted for auto-assign)';
    }

    const channels: ConnectorChannel[] = ['meta-whatsapp', 'smooch', 'generic'];
    if (!c.channel || !channels.includes(c.channel as ConnectorChannel)) return `"channel" must be one of: ${channels.join(', ')}`;

    if (!c.five9 || typeof c.five9 !== 'object') return '"five9" settings are required';
    const f = c.five9 as Record<string, unknown>;

    if (!f.authBaseUrl || typeof f.authBaseUrl !== 'string') return '"five9.authBaseUrl" is required';
    try { new URL(f.authBaseUrl as string); } catch { return '"five9.authBaseUrl" must be a valid URL'; }

    if (!f.tenantName || typeof f.tenantName !== 'string' || !(f.tenantName as string).trim()) {
        return '"five9.tenantName" is required';
    }
    if (!f.campaignName || typeof f.campaignName !== 'string' || !(f.campaignName as string).trim()) {
        return '"five9.campaignName" is required';
    }
    if (!f.callbackUrl || typeof f.callbackUrl !== 'string') return '"five9.callbackUrl" is required';
    try { new URL(f.callbackUrl as string); } catch { return '"five9.callbackUrl" must be a valid URL'; }
    if (f.callbackToken !== undefined && typeof f.callbackToken !== 'string') {
        return '"five9.callbackToken" must be a string';
    }

    const directReply = c.directReply === true;

    if (c.meta !== undefined) {
        if (typeof c.meta !== 'object' || c.meta === null) return '"meta" must be an object';
        const m = c.meta as Record<string, unknown>;
        if (m.accessToken !== undefined && typeof m.accessToken !== 'string') return '"meta.accessToken" must be a string';
        if (m.phoneNumberId !== undefined && typeof m.phoneNumberId !== 'string') return '"meta.phoneNumberId" must be a string';
    }

    if (c.smooch !== undefined) {
        if (typeof c.smooch !== 'object' || c.smooch === null) return '"smooch" must be an object';
        const sm = c.smooch as Record<string, unknown>;
        for (const k of ['appId', 'baseUrl', 'keyId', 'keySecret', 'bearerToken', 'webhookSecret']) {
            if (sm[k] !== undefined && typeof sm[k] !== 'string') return `"smooch.${k}" must be a string`;
        }
        if (sm.baseUrl) { try { new URL(sm.baseUrl as string); } catch { return '"smooch.baseUrl" must be a valid URL'; } }
    }

    if (c.channel === 'smooch') {
        const sm = (c.smooch || {}) as Record<string, unknown>;
        if (!sm.appId) return '"smooch.appId" is required for the smooch channel';
        if (!sm.bearerToken && !(sm.keyId && sm.keySecret)) {
            return 'Smooch auth requires either "smooch.bearerToken" or both "smooch.keyId" and "smooch.keySecret"';
        }
    }

    if (directReply) {
        if (c.channel === 'meta-whatsapp') {
            const m = (c.meta || {}) as Record<string, unknown>;
            if (!m.accessToken) return 'Replying directly requires "meta.accessToken"';
        } else if (c.channel === 'smooch') {
            const sm = (c.smooch || {}) as Record<string, unknown>;
            if (!sm.appId || (!sm.bearerToken && !(sm.keyId && sm.keySecret))) {
                return 'Replying directly requires Smooch credentials';
            }
        } else {
            return `Direct reply is not supported on the "${c.channel}" channel — use webhook targets instead`;
        }
    }

    if (c.directReply !== undefined && typeof c.directReply !== 'boolean') return '"directReply" must be a boolean';
    if (c.phoneNumberFilter !== undefined && (!Array.isArray(c.phoneNumberFilter) || (c.phoneNumberFilter as unknown[]).some(x => typeof x !== 'string'))) {
        return '"phoneNumberFilter" must be an array of phone_number_id strings';
    }

    if (c.allowedIps !== undefined && (!Array.isArray(c.allowedIps) || (c.allowedIps as unknown[]).some(x => typeof x !== 'string'))) {
        return '"allowedIps" must be an array of strings';
    }

    if (c.autoReply !== undefined) {
        if (typeof c.autoReply !== 'object' || c.autoReply === null) return '"autoReply" must be an object';
        const ar = c.autoReply as Record<string, unknown>;
        if (typeof ar.enabled !== 'boolean') return '"autoReply.enabled" must be a boolean';
        if (ar.enabled) {
            if (!ar.text || typeof ar.text !== 'string' || !(ar.text as string).trim()) return '"autoReply.text" is required when auto-reply is enabled';
            if ((ar.text as string).length > 2000) return '"autoReply.text" must be 2000 characters or fewer';
        }
        if (ar.expiresAt !== undefined && ar.expiresAt !== '') {
            if (typeof ar.expiresAt !== 'string' || isNaN(Date.parse(ar.expiresAt as string))) {
                return '"autoReply.expiresAt" must be a valid ISO datetime (or empty for no expiry)';
            }
        }
    }

    const ssrfOverride = {
        allowPrivate: c.allowPrivateTargets as boolean | undefined,
        allowedCidrs: c.targetAllowedCidrs as string[] | undefined,
    };

    if (c.webhookTargets !== undefined) {
        if (!Array.isArray(c.webhookTargets)) return '"webhookTargets" must be an array';
        if (c.webhookTargets.length > 16) return '"webhookTargets" cannot exceed 16 entries';
        for (const t of c.webhookTargets as unknown[]) {
            if (!t || typeof t !== 'object') return '"webhookTargets" entries must be objects';
            const wt = t as Record<string, unknown>;
            if (typeof wt.url !== 'string' || !wt.url.trim()) return '"webhookTargets[].url" is required';
            try { assertSafeOutboundUrl(wt.url as string, ssrfOverride); }
            catch (e) { return e instanceof SsrfBlockedError ? `"${wt.url}": ${e.message}` : `"${wt.url}" is not a valid URL`; }
            if (wt.method !== undefined && typeof wt.method !== 'string') return '"webhookTargets[].method" must be a string';
            if (wt.customHeaders !== undefined && (typeof wt.customHeaders !== 'object' || wt.customHeaders === null)) {
                return '"webhookTargets[].customHeaders" must be an object';
            }
        }
    }

    if (c.webhooksEnabled !== undefined && typeof c.webhooksEnabled !== 'boolean') return '"webhooksEnabled" must be a boolean';

    const webhooksActive = c.webhooksEnabled !== false && Array.isArray(c.webhookTargets) && (c.webhookTargets as unknown[]).length > 0;
    if (!directReply && !webhooksActive) {
        return 'Agent replies need at least one active destination: enable direct reply or add (and enable) a webhook target';
    }

    if (c.sessionTtlMinutes !== undefined && (typeof c.sessionTtlMinutes !== 'number' || c.sessionTtlMinutes < 5 || c.sessionTtlMinutes > 10080)) {
        return '"sessionTtlMinutes" must be between 5 and 10080';
    }
    if (c.allowPrivateTargets !== undefined && typeof c.allowPrivateTargets !== 'boolean') return '"allowPrivateTargets" must be a boolean';
    if (c.targetAllowedCidrs !== undefined && (!Array.isArray(c.targetAllowedCidrs) || (c.targetAllowedCidrs as unknown[]).some(x => typeof x !== 'string'))) {
        return '"targetAllowedCidrs" must be an array of CIDR strings';
    }

    return null;
}
