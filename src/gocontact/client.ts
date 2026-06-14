/**
 * GoContact webchat protocol client.
 *
 * Implements the "traditional" webchat plugin API (poll/new-webchat-service/*)
 * used internally by GoContact's own widget — extracted from a proven C#
 * integration. Flow:
 *
 *   1. POST poll/auth/token                       (Basic user:pass)  → bearer token
 *   2. GET  poll/api/domains/nameconversion       → domain_uuid
 *   3. GET  …/webchats/schedule/{uuid}/{hashKey}  → channel online?
 *   4. POST …/plugin/access-key                   → accessKey
 *   5. POST …/plugin/{accessKey}/new-dialog-group → dialogGroupUuid (the chat)
 *
 * Then per message:
 *   POST …/plugin/{accessKey}/client-message      (episodeObj JOIN/MSG/LEAVE/FILESEND)
 *   GET  …/plugin/{accessKey}/new-client-messages (agent replies — poll)
 *   POST …/plugin/{accessKey}/mark-as-read        (server-side dedup)
 *   POST …/upload                                 (multipart file upload)
 */

import type { GoContactSettings } from '../core/connector-types';
import { getSharedToken, refreshIfCurrent } from './token-manager';

export type GoMsgType = 'JOIN' | 'MSG' | 'LEAVE' | 'FILESEND';

export interface GoToken {
    token: string;
    /** Unix seconds. */
    expireTimestamp: number;
}

export interface GoFile {
    filename: string;
    size: string | number;
    mimetype: string;
    url: string;
    filestatus: string | boolean;
}

export interface GoAgentMessage {
    usertype: string;        // "AGENT"
    displayname: string;
    msgtype: string;         // "MSG" | "FILESEND" | "LEAVE"
    msg: string;
    file: GoFile | null;
    uuid: string;            // episode uuid — used for mark-as-read
    timestamp: number;
}

export interface GoSessionHandles {
    domainUuid: string;
    accessKey: string;
    dialogGroupUuid: string;
    dialogGroupId: string;
}

export class GoContactError extends Error {
    /** Upstream HTTP status, when the failure came from a response. */
    readonly status?: number;
    constructor(step: string, detail: string, status?: number) {
        super(`GoContact ${step} failed: ${detail}`);
        this.name = 'GoContactError';
        this.status = status;
    }
}

const FETCH_TIMEOUT_MS = 30_000;

export class GoContactClient {
    private readonly base: string;
    private readonly tokenKey: string;
    constructor(private readonly cfg: GoContactSettings) {
        this.base = cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/';
        // Tokens are shared per (instance, login user) — every connector with
        // the same credentials reuses one token instead of fighting over it.
        this.tokenKey = `${this.base}|${this.cfg.username}`;
    }

    /** Domain name = part of the login e-mail after "@" (matches the original integration). */
    get domainName(): string {
        return this.cfg.username.split('@')[1] || '';
    }

    /** Episode timestamps are Unix ms shifted by the configured offset (default UTC+1). */
    episodeTimestamp(): number {
        const offset = this.cfg.timestampOffsetHours ?? 1;
        return Date.now() + offset * 3_600_000;
    }

    private url(path: string): string {
        return this.base + path.replace(/^\//, '');
    }

    /** Raw token fetch (Basic auth). Goes through the shared manager — never
     *  call directly except as the manager's refresh function. */
    private async fetchTokenFromServer(): Promise<GoToken> {
        const basic = Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64');
        const res = await fetch(this.url('poll/auth/token'), {
            method: 'POST',
            headers: { 'Authorization': `Basic ${basic}`, 'Connection': 'Keep-Alive' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
        } as RequestInit);
        const text = await res.text().catch(() => '');
        if (res.status < 200 || res.status >= 300) throw new GoContactError('token', `HTTP ${res.status} ${text.slice(0, 300)}`);
        let data: any = {};
        try { data = text ? JSON.parse(text) : {}; } catch { throw new GoContactError('token', `invalid JSON: ${text.slice(0, 300)}`); }
        if (!data.token) throw new GoContactError('token', data.message || 'no token in response');
        const expire = typeof data.expire_timestamp === 'number'
            ? data.expire_timestamp
            : Math.floor(Date.now() / 1000) + (typeof data.expire_in === 'number' ? data.expire_in : 3600);
        return { token: data.token, expireTimestamp: expire };
    }

    /** The current shared token for this user (cached, single-flight refresh). */
    getToken(): Promise<GoToken> {
        return getSharedToken(this.tokenKey, () => this.fetchTokenFromServer());
    }

    /**
     * Authenticated request with one-shot 401 re-auth: gets the shared token,
     * sends the request, and on 401 refreshes-if-current (reusing a token
     * another caller may have already rotated) and retries once.
     */
    private async authedRequest(path: string, init: RequestInit, step: string): Promise<any> {
        const send = async (tok: GoToken): Promise<Response> => {
            const headers = new Headers(init.headers as Record<string, string> | undefined);
            headers.set('Authorization', `Bearer ${tok.token}`);
            headers.set('Connection', 'Keep-Alive');
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
            throw new GoContactError(step, `HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
        }
        try { return text ? JSON.parse(text) : {}; }
        catch { throw new GoContactError(step, `invalid JSON response: ${text.slice(0, 300)}`); }
    }

    // ── Session establishment ───────────────────────────────────────────────

    async getDomainUuid(): Promise<string> {
        const data = await this.authedRequest(
            `poll/api/domains/nameconversion?domain_name=${encodeURIComponent(this.domainName)}`,
            { method: 'GET' },
            'domain lookup',
        );
        if (!data.domain_uuid) throw new GoContactError('domain lookup', `no domain_uuid for "${this.domainName}"`);
        return data.domain_uuid;
    }

    async isChannelOnline(domainUuid: string): Promise<boolean> {
        const data = await this.authedRequest(
            `poll/new-webchat-service/webchats/schedule/${domainUuid}/${this.cfg.hashKey}`,
            { method: 'GET' },
            'channel status',
        );
        return data.online === true;
    }

    async requestAccessKey(domainUuid: string): Promise<string> {
        const data = await this.authedRequest('poll/new-webchat-service/plugin/access-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ domainUuid, hashKey: this.cfg.hashKey }),
        }, 'access key');
        if (!data.accessKey) throw new GoContactError('access key', 'no accessKey in response');
        return data.accessKey;
    }

    async createDialogGroup(accessKey: string, displayName: string, contact: string): Promise<{ uuid: string; id: string }> {
        const data = await this.authedRequest(`poll/new-webchat-service/plugin/${accessKey}/new-dialog-group`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                originPath: '/',
                loginFields: [
                    { label: 'Nome', field: 'contact', searchable: false, require: true, extrafieldlabel: 'Contact+Name', isExtraField: false, value: displayName },
                    { label: 'Contacto', field: 'first_phone', searchable: true, require: true, extrafieldlabel: '1st+phone', isExtraField: false, value: contact },
                ],
                language: this.cfg.language || 'en',
            }),
        }, 'new dialog group');
        const uuid = data.dialogGroupUuid || data.dialog_group_uuid;
        if (!uuid) throw new GoContactError('new dialog group', data.message || 'no dialogGroupUuid in response');
        return { uuid, id: String(data.dialogGroupId ?? data.dialog_group_id ?? '') };
    }

    /** Full session bootstrap: token → domain → online check → access key → dialog group.
     *  When the config carries an explicit domainUuid (from the embed script's
     *  `_domain`), the nameconversion lookup is skipped. */
    async openSession(displayName: string, contact: string): Promise<GoSessionHandles> {
        const domainUuid = this.cfg.domainUuid || await this.getDomainUuid();
        const online = await this.isChannelOnline(domainUuid);
        if (!online) throw new GoContactError('channel status', `webchat channel is offline (domain ${this.domainName})`);
        const accessKey = await this.requestAccessKey(domainUuid);
        const dg = await this.createDialogGroup(accessKey, displayName, contact);
        return { domainUuid, accessKey, dialogGroupUuid: dg.uuid, dialogGroupId: dg.id };
    }

    // ── Messaging ───────────────────────────────────────────────────────────

    async sendClientMessage(
        accessKey: string, dialogGroupUuid: string,
        displayName: string, msgType: GoMsgType, msg: string, file: GoFile | null = null,
    ): Promise<{ episodeUuid: string | null }> {
        const data = await this.authedRequest(`poll/new-webchat-service/plugin/${accessKey}/client-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                episodeObj: {
                    usertype: 'CLIENT',
                    displayname: displayName,
                    msgtype: msgType,
                    msg: msgType === 'FILESEND' ? '' : msg,
                    options: '',
                    optionstype: '',
                    rating: '',
                    file,
                    timestamp: this.episodeTimestamp(),
                    uuid: dialogGroupUuid,
                    status: '',
                },
            }),
        }, `client-message (${msgType})`);
        return { episodeUuid: data?.data?.episode?.uuid ?? null };
    }

    /** Poll agent replies for one session. Returns [] when nothing pending. */
    async fetchNewMessages(accessKey: string): Promise<GoAgentMessage[]> {
        const data = await this.authedRequest(`poll/new-webchat-service/plugin/${accessKey}/new-client-messages`, {
            method: 'GET',
        }, 'new-client-messages');
        if (data.error === true || !Array.isArray(data.data)) return [];
        return (data.data as any[]).map(m => {
            // Normalize the file object — field names/casing vary between
            // GoContact versions (url/Url/path, filename/FileName/name, …).
            const rawFile = m.file ?? m.File ?? null;
            let file: GoFile | null = null;
            if (rawFile && typeof rawFile === 'object') {
                const url = rawFile.url ?? rawFile.Url ?? rawFile.path ?? rawFile.Path ?? rawFile.filepath ?? null;
                if (!url && String(m.msgtype ?? m.MsgType ?? '') === 'FILESEND') {
                    // Discovery aid: dump the untouched episode so we can spot
                    // where (or whether) the download URL actually lives.
                    console.log(`🔍 [gocontact] FILESEND without url — original episode: ${JSON.stringify(m).slice(0, 800)}`);
                }
                file = {
                    filename: String(rawFile.filename ?? rawFile.FileName ?? rawFile.name ?? rawFile.Name ?? 'file'),
                    size: rawFile.size ?? rawFile.Size ?? 0,
                    mimetype: String(rawFile.mimetype ?? rawFile.MimeType ?? rawFile.mime_type ?? 'application/octet-stream'),
                    url: url ? String(url) : '',
                    filestatus: rawFile.filestatus ?? rawFile.FileStatus ?? '',
                };
            }
            return {
                usertype: String(m.usertype ?? m.Usertype ?? ''),
                displayname: String(m.displayname ?? m.Displayname ?? ''),
                msgtype: String(m.msgtype ?? m.MsgType ?? ''),
                msg: String(m.msg ?? m.Msg ?? ''),
                file,
                uuid: String(m.uuid ?? m.Uuid ?? ''),
                timestamp: Number(m.timestamp ?? m.Timestamp ?? 0),
            };
        });
    }

    /** Server-side dedup: a message marked as read is not returned again. */
    async markAsRead(accessKey: string, messageUuid: string): Promise<boolean> {
        const data = await this.authedRequest(`poll/new-webchat-service/plugin/${accessKey}/mark-as-read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dialogUuid: messageUuid }),
        }, 'mark-as-read');
        return data.error !== true;
    }

    // ── Files ───────────────────────────────────────────────────────────────

    /**
     * Multipart upload of a customer file, attaching the binary to an already
     * created FILESEND episode. Flow (mirrors GoContact's own widget):
     *   1. POST client-message (FILESEND, file metadata) → episode uuid
     *   2. POST upload with chat_uuid=dialogGroupUuid, dialog_uuid=EPISODE uuid
     */
    async uploadFile(
        handles: { dialogGroupUuid: string; episodeUuid: string; domainUuid: string },
        bytes: Uint8Array, filename: string, mimetype: string,
    ): Promise<void> {
        const send = async (tok: GoToken): Promise<Response> => {
            const form = new FormData();
            form.append('file', new Blob([bytes], { type: mimetype }), filename);
            form.append('chat_uuid', handles.dialogGroupUuid);
            form.append('dialog_uuid', handles.episodeUuid);
            form.append('domain', handles.domainUuid);
            return fetch(this.url('poll/new-webchat-service/upload'), {
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
        if (res.status !== 200 && res.status !== 201) {
            throw new GoContactError('upload', `HTTP ${res.status} ${text.slice(0, 300)}`);
        }
        if (text.toLowerCase().includes('"error"') && !text.toLowerCase().includes('"error":false')) {
            throw new GoContactError('upload', `rejected: ${text.slice(0, 300)}`);
        }
    }

    /** Build the public URL of an agent attachment ({base}/{bucket}{relativePath}).
     *  Some episodes (e.g. automatic messages) carry a file object with a null
     *  url — returns '' for those. */
    agentFileUrl(relativeUrl: string | null | undefined): string {
        if (!relativeUrl || typeof relativeUrl !== 'string') return '';
        if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
        const bucket = (this.cfg.storageBucket ?? 'storage').replace(/^\/|\/$/g, '');
        const rel = relativeUrl.startsWith('/') ? relativeUrl : '/' + relativeUrl;
        return this.base.replace(/\/$/, '') + (bucket ? `/${bucket}` : '') + rel;
    }
}

/** Strip HTML tags and &nbsp; entities from agent messages (same cleanup as the
 *  original integration — GoContact agents can produce rich text). */
export function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}
