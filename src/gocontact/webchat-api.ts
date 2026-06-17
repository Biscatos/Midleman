/**
 * GoContact **Webchat API** client (mode = 'webchat-api').
 *
 * The official, documented API at e.g. https://eu.ds.gocontact.com/api/webchat
 * — distinct from the traditional plugin API in client.ts. Differences:
 *   • Auth is a JWT: POST /v1/authentication/token {username,password,audience}.
 *     (Unlike the plugin token, a new JWT does NOT invalidate the previous one,
 *     so there is no token war — but we still cache/refresh via token-manager.)
 *   • A conversation is created with POST /v1/conversations/{channelUuid} and
 *     identified by a `conversationUuid` (what the outbound webhook echoes back
 *     as data.conversation.uuid — how we map a callback to its customer).
 *   • Agent replies are PUSHED to Midleman via an outbound webhook configured on
 *     the GoContact side — there is no poller in this mode.
 *
 * This client only handles the CLIENT (customer → GoContact) direction plus the
 * attachment download used when relaying an agent file back to the customer.
 */

import { log } from '../core/logger';
import type { GoContactSettings } from '../core/connector-types';
import { getSharedToken, refreshIfCurrent } from './token-manager';
import { GoContactError, type GoToken } from './client';

const FETCH_TIMEOUT_MS = 30_000;

export interface ChannelLoginField {
    label: string;
    field: string;
    /** GoContact returns the string "true"/"false". */
    require: string;
}

/** The customer identity available from the inbound channel message. */
export interface CustomerIdentity {
    /** displayName (e.g. the WhatsApp profile name). */
    name: string;
    /** chatId — the customer's own id (wa_id / phone / Smooch conversation id). */
    phone: string;
    /** Business number the customer wrote to (Meta phone_number_id), if any. */
    phoneNumberId?: string;
}

/** Resolve the channel's loginFields from the customer identity + optional map.
 *  Returns the field/value pairs to POST and any REQUIRED fields left empty. */
export function resolveLoginFields(
    configFields: ChannelLoginField[],
    customer: CustomerIdentity,
    map: Record<string, string> | undefined,
): { fields: Array<{ field: string; value: string }>; missingRequired: string[] } {
    const out: Array<{ field: string; value: string }> = [];
    const missingRequired: string[] = [];
    for (const f of configFields) {
        let value = '';
        const override = map?.[f.field];
        if (override !== undefined) {
            value = resolveSource(override, customer);
        } else {
            // Heuristic over field+label. Check phone FIRST: a phone field is
            // often labelled "Contacto" (which would otherwise match "contact"
            // → name), and its field name carries a phone token.
            const hay = `${f.field} ${f.label}`.toLowerCase();
            if (/phone|telefone|telemov|telemóv|m[oó]vel|msisdn|cell|mobile|whatsapp|n[uú]mero|\bnumber\b/.test(hay)) {
                value = customer.phone;
            } else if (/name|nome|contact|cliente|fullname|first.?name|last.?name/.test(hay)) {
                value = customer.name;
            }
        }
        if (value) out.push({ field: f.field, value });
        if (String(f.require) === 'true' && !value) missingRequired.push(f.field);
    }
    return { fields: out, missingRequired };
}

function resolveSource(source: string, customer: CustomerIdentity): string {
    if (source.startsWith('=')) return source.slice(1);      // literal
    switch (source) {
        case 'name': return customer.name;
        case 'phone': return customer.phone;
        case 'phoneNumberId': return customer.phoneNumberId || '';
        default: return '';
    }
}

export class WebchatApiClient {
    private readonly base: string;
    private readonly tokenKey: string;
    constructor(private readonly cfg: GoContactSettings) {
        const raw = cfg.baseUrl || '';
        // Normalise to ".../api/webchat" (accept the host with or without it).
        const trimmed = raw.replace(/\/+$/, '');
        this.base = /\/api\/webchat$/i.test(trimmed) ? trimmed : trimmed + '/api/webchat';
        this.tokenKey = `webchat|${this.base}|${cfg.username}|${cfg.audience || ''}`;
    }

    private url(path: string): string {
        return this.base + (path.startsWith('/') ? path : '/' + path);
    }

    /** POST /v1/authentication/token — JWT. Manager refresh function only. */
    private async fetchTokenFromServer(): Promise<GoToken> {
        const res = await fetch(this.url('/v1/authentication/token'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password, audience: this.cfg.audience }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
        } as RequestInit);
        const text = await res.text().catch(() => '');
        if (res.status < 200 || res.status >= 300) throw new GoContactError('webchat token', `HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
        let data: any = {};
        try { data = text ? JSON.parse(text) : {}; } catch { throw new GoContactError('webchat token', `invalid JSON: ${text.slice(0, 300)}`); }
        const tok = data?.data?.access_token ?? data?.access_token;
        if (!tok) throw new GoContactError('webchat token', data?.message || 'no access_token in response');
        const expiresIn = Number(data?.data?.expires_in ?? data?.expires_in ?? 3600);
        return { token: tok, expireTimestamp: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 3600) };
    }

    getToken(): Promise<GoToken> {
        return getSharedToken(this.tokenKey, () => this.fetchTokenFromServer());
    }

    /** Authenticated JSON request with one-shot 401 re-auth. */
    private async authedRequest(path: string, init: RequestInit, step: string): Promise<any> {
        const send = async (tok: GoToken): Promise<Response> => {
            const headers = new Headers(init.headers as Record<string, string> | undefined);
            headers.set('Authorization', `Bearer ${tok.token}`);
            return fetch(this.url(path), {
                ...init, headers,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
            } as RequestInit);
        };
        let token = await this.getToken();
        let res = await send(token);
        if (res.status === 401) {
            token = await refreshIfCurrent(this.tokenKey, token, () => this.fetchTokenFromServer());
            res = await send(token);
        }
        const text = await res.text().catch(() => '');
        if (res.status < 200 || res.status >= 300) {
            const e = new GoContactError(step, `HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
            if (res.status === 404) e.dialogGone = true; // conversation gone → recreate
            throw e;
        }
        try { return text ? JSON.parse(text) : {}; }
        catch { throw new GoContactError(step, `invalid JSON response: ${text.slice(0, 300)}`); }
    }

    // ── Channel + conversation ────────────────────────────────────────────────

    /** GET /v1/channels/{channelUuid}/config — the login fields this channel
     *  expects (label/field/require). */
    async getChannelConfig(): Promise<ChannelLoginField[]> {
        const data = await this.authedRequest(`/v1/channels/${this.cfg.channelUuid}/config`, { method: 'GET' }, 'channel config');
        const arr = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
        return (arr as any[]).map(f => ({ label: String(f?.label ?? ''), field: String(f?.field ?? ''), require: String(f?.require ?? 'false') }));
    }

    /** POST /v1/conversations/{channelUuid} — create the conversation. Returns
     *  the conversationUuid we store and map callbacks against. */
    async createConversation(loginFields: Array<{ field: string; value: string }>): Promise<{ conversationUuid: string; contactId: string }> {
        const data = await this.authedRequest(`/v1/conversations/${this.cfg.channelUuid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ loginFields }),
        }, 'create conversation');
        const uuid = data?.conversationUuid ?? data?.data?.conversationUuid;
        if (!uuid) throw new GoContactError('create conversation', data?.message || 'no conversationUuid in response');
        return { conversationUuid: String(uuid), contactId: String(data?.contactId ?? data?.data?.contactId ?? '') };
    }

    /** POST /v1/conversations/{uuid}/message/client — send a text message. */
    async sendClientMessage(conversationUuid: string, message: string): Promise<void> {
        await this.authedRequest(`/v1/conversations/${conversationUuid}/message/client`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ message }),
        }, 'client message');
    }

    /** POST /v1/conversations/{uuid}/message/client-upload — multipart file.
     *  The API only accepts jpg/png/pdf; callers should degrade other types to
     *  a text note rather than calling this. */
    async uploadClientFile(conversationUuid: string, bytes: Uint8Array, filename: string, mimetype: string): Promise<void> {
        const send = async (tok: GoToken): Promise<Response> => {
            const form = new FormData();
            form.append('file', new Blob([bytes], { type: mimetype }), filename);
            return fetch(this.url(`/v1/conversations/${conversationUuid}/message/client-upload`), {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${tok.token}`, 'Accept': 'application/json' },
                body: form,
                signal: AbortSignal.timeout(120_000),
                tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
            } as RequestInit);
        };
        let token = await this.getToken();
        let res = await send(token);
        if (res.status === 401) {
            token = await refreshIfCurrent(this.tokenKey, token, () => this.fetchTokenFromServer());
            res = await send(token);
        }
        const text = await res.text().catch(() => '');
        if (res.status < 200 || res.status >= 300) throw new GoContactError('client upload', `HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
    }

    /** Download an agent attachment. The outbound webhook gives a relative url
     *  ("/webchat-attachments/..."); resolve it against the API host and try the
     *  bearer token first, falling back to an unauthenticated GET. */
    async downloadAttachment(relativeOrAbsUrl: string): Promise<{ bytes: Uint8Array; mimetype: string }> {
        const abs = /^https?:\/\//i.test(relativeOrAbsUrl)
            ? relativeOrAbsUrl
            : this.base.replace(/\/api\/webchat$/i, '') + (relativeOrAbsUrl.startsWith('/') ? relativeOrAbsUrl : '/' + relativeOrAbsUrl);
        const attempt = async (withAuth: boolean): Promise<Response> => {
            const headers: Record<string, string> = {};
            if (withAuth) headers['Authorization'] = `Bearer ${(await this.getToken()).token}`;
            return fetch(abs, { headers, signal: AbortSignal.timeout(120_000), tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' } } as RequestInit);
        };
        let res = await attempt(true);
        if (res.status === 401 || res.status === 403) res = await attempt(false);
        if (!res.ok) throw new GoContactError('attachment download', `HTTP ${res.status}`, res.status);
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { bytes, mimetype: res.headers.get('content-type') || 'application/octet-stream' };
    }

    /** Absolute URL of an attachment from the outbound webhook's relative path
     *  ("/webchat-attachments/...") — what we hand to the fan-out (Meta/webhooks). */
    attachmentUrl(relativeOrAbsUrl: string): string {
        if (!relativeOrAbsUrl) return '';
        if (/^https?:\/\//i.test(relativeOrAbsUrl)) return relativeOrAbsUrl;
        return this.base.replace(/\/api\/webchat$/i, '') + (relativeOrAbsUrl.startsWith('/') ? relativeOrAbsUrl : '/' + relativeOrAbsUrl);
    }

    /** The resolved absolute base (".../api/webchat") — for logging/diagnostics. */
    get apiBase(): string { return this.base; }
}
