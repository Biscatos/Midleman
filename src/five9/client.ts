/**
 * Five9 Digital Engagement API client.
 *
 * Handles the client (customer → Five9) direction:
 *   • Anonymous auth (per-conversation token — no shared token war)
 *   • Conversation creation with contact + campaign routing
 *   • Status polling until ACTIVE
 *   • Text and file message send
 *   • File upload pipeline (exchange FDM token → policy → PUT → metadata)
 *
 * Auth scheme has TWO variants — do not conflate them:
 *   Conversation API  →  Authorization: Bearer-{tokenId}  (hyphen, non-standard)
 *   File/cloud APIs   →  Authorization: Bearer {accessToken}  (standard, after exchange)
 */

import { log } from '../core/logger';

export const FETCH_TIMEOUT_MS = 30_000;
const FILE_UPLOAD_TIMEOUT_MS = 120_000;

/** Structured detail attached to every Five9Error — for log correlation. */
export interface Five9ErrorDetail {
    /** Request URL with query string stripped (no tokens leak). */
    url?: string;
    /** Five9 host (data center), e.g. "app.nld1.eu.five9.com". */
    host?: string;
    httpStatus?: number;
    /** Five9's own errorCode from body.five9ExceptionDetail (e.g. 500). */
    five9ErrorCode?: number;
    /** Five9's own message from body.five9ExceptionDetail. */
    five9Message?: string;
    /** Five9's own timestamp from body.five9ExceptionDetail (epoch ms). */
    five9Timestamp?: number;
    /** Raw body preview (first 300 chars). */
    bodyPreview?: string;
    durationMs?: number;
}

export class Five9Error extends Error {
    public readonly detail: Five9ErrorDetail;

    constructor(public step: string, message: string, public httpStatus?: number, detail: Five9ErrorDetail = {}) {
        super(`[five9/${step}] ${message}`);
        this.name = 'Five9Error';
        this.detail = { ...detail, httpStatus: httpStatus ?? detail.httpStatus };
    }
    /** HTTP 404 typically means the conversation was terminated/gone. */
    conversationGone = false;

    /** Flat key/value record for structured logging. */
    toLogFields(): Record<string, string | number | boolean> {
        const d = this.detail;
        const out: Record<string, string | number | boolean> = { step: this.step };
        if (d.httpStatus !== undefined) out.http_status = d.httpStatus;
        if (d.five9ErrorCode !== undefined) out.five9_error_code = d.five9ErrorCode;
        if (d.five9Message) out.five9_message = d.five9Message;
        if (d.five9Timestamp) out.five9_ts = new Date(d.five9Timestamp).toISOString();
        if (d.host) out.five9_host = d.host;
        if (d.url) out.url = d.url;
        if (d.durationMs !== undefined) out.duration_ms = Math.round(d.durationMs);
        if (this.conversationGone) out.conversation_gone = true;
        if (d.bodyPreview) out.body = d.bodyPreview;
        return out;
    }
}

/** Parse Five9's standard error envelope {"five9ExceptionDetail":{timestamp,errorCode,message}}. */
function parseFive9ExceptionDetail(text: string): Pick<Five9ErrorDetail, 'five9ErrorCode' | 'five9Message' | 'five9Timestamp'> {
    try {
        const j = JSON.parse(text);
        const d = j?.five9ExceptionDetail ?? j;
        if (!d || typeof d !== 'object') return {};
        const out: Pick<Five9ErrorDetail, 'five9ErrorCode' | 'five9Message' | 'five9Timestamp'> = {};
        if (typeof d.errorCode === 'number') out.five9ErrorCode = d.errorCode;
        if (typeof d.message === 'string') out.five9Message = d.message;
        if (typeof d.timestamp === 'number') out.five9Timestamp = d.timestamp;
        return out;
    } catch { return {}; }
}

/** Strip query string (tokens) and return {url, host} for logging. */
function urlForLog(url: string): { url: string; host: string } {
    try {
        const u = new URL(url);
        return { url: `${u.origin}${u.pathname}`, host: u.host };
    } catch { return { url: url.split('?')[0], host: '' }; }
}

export interface Five9AuthResult {
    tokenId: string;
    farmId: string;
    /** Full HTTPS URL derived from auth response: "https://{apiUrls[0].host}" */
    apiHost: string;
    /** Cloud services base URL, e.g. "https://files.eu.five9.com/" */
    cloudClientUrl: string;
    /** Tenant/org identifier — used as tenantId in conversation creation */
    orgId: string;
}

/** Auth data stored per session; same shape as Five9AuthResult */
export interface Five9SessionAuth extends Five9AuthResult {}

export class Five9ApiClient {
    constructor(private readonly authBaseUrl: string) {
        // Normalise: strip trailing slash
        this.authBaseUrl = authBaseUrl.replace(/\/+$/, '');
    }

    /** Common headers for the Conversation API (Bearer- with hyphen). */
    private convHeaders(auth: Five9SessionAuth): Record<string, string> {
        return {
            'Authorization': `Bearer-${auth.tokenId}`,
            'farmId': auth.farmId,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
    }

    /** Build a Five9Error for a non-2xx response, enriched with Five9's error envelope. */
    private httpError(step: string, url: string, res: Response, text: string, startedAt: number): Five9Error {
        const preview = text.slice(0, 300);
        const err = new Five9Error(step, `HTTP ${res.status} ${preview}`, res.status, {
            ...urlForLog(url),
            ...parseFive9ExceptionDetail(text),
            bodyPreview: preview,
            durationMs: performance.now() - startedAt,
        });
        if (res.status === 404) err.conversationGone = true;
        return err;
    }

    /** Wrap network-level failures (timeout, DNS, TLS) so they carry step + url. */
    private networkError(step: string, url: string, cause: unknown, startedAt: number): Five9Error {
        const msg = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        return new Five9Error(step, `network error: ${msg}`, undefined, {
            ...urlForLog(url),
            durationMs: performance.now() - startedAt,
        });
    }

    private async checkStatus(res: Response, step: string, url: string, startedAt: number): Promise<string> {
        const text = await res.text().catch(() => '');
        if (res.status >= 200 && res.status < 300) return text;
        throw this.httpError(step, url, res, text, startedAt);
    }

    private async jsonRequest(url: string, init: RequestInit, step: string): Promise<any> {
        const startedAt = performance.now();
        let res: Response;
        try {
            res = await fetch(url, {
                ...init,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
            } as RequestInit);
        } catch (cause) {
            throw this.networkError(step, url, cause, startedAt);
        }
        const text = await this.checkStatus(res, step, url, startedAt);
        try { return text ? JSON.parse(text) : {}; }
        catch {
            throw new Five9Error(step, `invalid JSON: ${text.slice(0, 300)}`, res.status, {
                ...urlForLog(url), bodyPreview: text.slice(0, 300), durationMs: performance.now() - startedAt,
            });
        }
    }

    // ── Auth ─────────────────────────────────────────────────────────────────

    /** POST {authBaseUrl}/appsvcs/rs/svc/auth/anon?cookieless=true
     *  Returns session credentials including the dynamic API host. */
    async anonAuth(tenantName: string): Promise<Five9AuthResult> {
        const url = `${this.authBaseUrl}/appsvcs/rs/svc/auth/anon?cookieless=true`;
        const data = await this.jsonRequest(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ tenantName }),
        }, 'anon-auth');

        const missing = (field: string) => new Five9Error('anon-auth', `no ${field} in auth response`, 200, {
            ...urlForLog(url), bodyPreview: JSON.stringify(data).slice(0, 300),
        });

        const tokenId = data?.tokenId;
        if (!tokenId) throw missing('tokenId');

        const farmId = String(data?.context?.farmId ?? '');
        const cloudClientUrl = String(data?.context?.cloudClientUrl ?? '');
        const orgId = String(data?.orgId ?? '');
        const apiHostRaw = data?.metadata?.dataCenters?.[0]?.apiUrls?.[0]?.host ?? '';
        const apiHost = apiHostRaw ? `https://${apiHostRaw}` : this.authBaseUrl;

        if (!farmId) throw missing('context.farmId');
        if (!orgId) throw missing('orgId');
        if (!cloudClientUrl) throw missing('context.cloudClientUrl');

        return { tokenId, farmId, apiHost, cloudClientUrl, orgId };
    }

    // ── Conversation ─────────────────────────────────────────────────────────

    /** POST {apiHost}/appsvcs/rs/svc/conversations
     *  Returns the correlationId (conversation id) to use for all subsequent calls. */
    async createConversation(auth: Five9SessionAuth, opts: {
        externalId: string;
        campaignName: string;
        callbackUrl: string;
        contact: { firstName: string; lastName: string; number1: string };
        question: string;
    }): Promise<string> {
        const data = await this.jsonRequest(
            `${auth.apiHost}/appsvcs/rs/svc/conversations`,
            {
                method: 'POST',
                headers: this.convHeaders(auth),
                body: JSON.stringify({
                    tenantId: auth.orgId,
                    externalId: opts.externalId,
                    campaignName: opts.campaignName,
                    contentType: 'WHATSAPP',
                    callbackUrl: opts.callbackUrl,
                    contact: opts.contact,
                    attributes: { question: opts.question },
                }),
            },
            'create-conversation',
        );
        const id = data?.id ?? data?.correlationId;
        if (!id) throw new Five9Error('create-conversation', 'no id in create response');
        return String(id);
    }

    /** GET {apiHost}/appsvcs/rs/svc/conversations/{correlationId}/info
     *  Returns the conversation status string. */
    async getConversationStatus(auth: Five9SessionAuth, correlationId: string): Promise<string> {
        const data = await this.jsonRequest(
            `${auth.apiHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(correlationId)}/info`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer-${auth.tokenId}`,
                    'farmId': auth.farmId,
                    'Accept': 'application/json',
                },
            },
            'conversation-status',
        );
        return String(data?.status ?? '');
    }

    /** Poll until status becomes ACTIVE (or TERMINATED), up to maxAttempts×delaySec. */
    async waitForActive(auth: Five9SessionAuth, correlationId: string, maxAttempts = 6, delaySec = 3): Promise<void> {
        for (let i = 0; i < maxAttempts; i++) {
            if (i > 0) await Bun.sleep(delaySec * 1000);
            const status = await this.getConversationStatus(auth, correlationId);
            if (status === 'ACTIVE') return;
            if (status === 'TERMINATED') {
                const err = new Five9Error('wait-active', `Conversation ${correlationId} terminated before becoming active`);
                err.conversationGone = true;
                throw err;
            }
            log.debug(`[five9] conversation ${correlationId} status=${status} (attempt ${i + 1}/${maxAttempts})`);
        }
        throw new Five9Error('wait-active', `Conversation ${correlationId} did not become ACTIVE after ${maxAttempts} attempts`);
    }

    // ── Messaging ────────────────────────────────────────────────────────────

    /** POST {apiHost}/appsvcs/rs/svc/conversations/{correlationId}/messages — text */
    async sendText(auth: Five9SessionAuth, correlationId: string, message: string): Promise<void> {
        await this.jsonRequest(
            `${auth.apiHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(correlationId)}/messages`,
            {
                method: 'POST',
                headers: this.convHeaders(auth),
                body: JSON.stringify({ message, messageType: 'TEXT' }),
            },
            'send-text',
        );
    }

    /** POST .../messages — file attachment (uses fileDownloadId from upload pipeline). */
    async sendFileMessage(auth: Five9SessionAuth, correlationId: string, fileDownloadId: string, caption = ''): Promise<void> {
        await this.jsonRequest(
            `${auth.apiHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(correlationId)}/messages`,
            {
                method: 'POST',
                headers: this.convHeaders(auth),
                body: JSON.stringify({
                    message: caption,
                    attachments: [fileDownloadId],
                    messageType: 'TEXT',
                }),
            },
            'send-file',
        );
    }

    // ── File upload pipeline ─────────────────────────────────────────────────

    /** Upload a file to Five9 cloud and return the fileDownloadId for use in
     *  sendFileMessage. Flow: exchange FDM token → get upload policy → PUT binary
     *  → wait 4s → GET file metadata → fileDownloadId. */
    async uploadClientFile(
        auth: Five9SessionAuth,
        bytes: Uint8Array,
        filename: string,
        mimetype: string,
    ): Promise<string> {
        const cloudUrl = auth.cloudClientUrl.replace(/\/?$/, '/');
        const orgId = auth.orgId;

        // Step 1: Exchange anonymous token for FDM access token (standard Bearer, no dash)
        const exchangeRes = await fetch(
            `${cloudUrl}cloudauthsvcs/v1/domains/${encodeURIComponent(orgId)}/exchangefdmtoken`,
            {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${auth.tokenId}`, 'Accept': '*/*' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
            } as RequestInit,
        );
        const exchangeText = await exchangeRes.text().catch(() => '');
        if (!exchangeRes.ok) throw this.httpError('file-exchange-token', exchangeRes.url || cloudUrl, exchangeRes, exchangeText, performance.now());
        let exchangeData: any = {};
        try { exchangeData = JSON.parse(exchangeText); } catch { throw new Five9Error('file-exchange-token', 'invalid JSON'); }
        const accessToken: string = exchangeData?.access_token ?? exchangeData?.accessToken;
        if (!accessToken) throw new Five9Error('file-exchange-token', 'no access_token in exchange response');

        // Step 2: Get upload policy
        const policyRes = await fetch(
            `${cloudUrl}file-svc/v1/domains/${encodeURIComponent(orgId)}/file-upload/file-policies/GENERIC`,
            {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': '*/*', 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: filename }),
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
            } as RequestInit,
        );
        const policyText = await policyRes.text().catch(() => '');
        if (!policyRes.ok) throw this.httpError('file-upload-policy', policyRes.url || cloudUrl, policyRes, policyText, performance.now());
        let policyData: any = {};
        try { policyData = JSON.parse(policyText); } catch { throw new Five9Error('file-upload-policy', 'invalid JSON'); }
        const uploadUrl: string = policyData?.uploadUrl;
        const policyId: string = policyData?.id;
        if (!uploadUrl) throw new Five9Error('file-upload-policy', 'no uploadUrl in policy response');
        if (!policyId) throw new Five9Error('file-upload-policy', 'no id in policy response');

        // Step 3: PUT file binary to upload URL
        const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': mimetype },
            body: bytes,
            signal: AbortSignal.timeout(FILE_UPLOAD_TIMEOUT_MS),
            tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
        } as RequestInit);
        if (!putRes.ok) {
            const putText = await putRes.text().catch(() => '');
            throw this.httpError('file-upload-put', uploadUrl, putRes, putText, performance.now());
        }
        await putRes.body?.cancel().catch(() => {});

        // Step 4: Wait for processing
        await Bun.sleep(4000);

        // Step 5: Get file metadata to obtain fileDownloadId
        const metaRes = await fetch(
            `${cloudUrl}file-svc/v1/domains/${encodeURIComponent(orgId)}/files/${encodeURIComponent(policyId)}`,
            {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': '*/*' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
            } as RequestInit,
        );
        const metaText = await metaRes.text().catch(() => '');
        if (!metaRes.ok) throw this.httpError('file-get-metadata', metaRes.url || cloudUrl, metaRes, metaText, performance.now());
        let metaData: any = {};
        try { metaData = JSON.parse(metaText); } catch { throw new Five9Error('file-get-metadata', 'invalid JSON'); }
        const fileDownloadId: string = metaData?.fileDownloadId ?? metaData?.id;
        if (!fileDownloadId) throw new Five9Error('file-get-metadata', 'no fileDownloadId in file metadata response');

        return fileDownloadId;
    }
}
