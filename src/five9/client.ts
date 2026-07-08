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

export class Five9Error extends Error {
    constructor(public step: string, message: string, public httpStatus?: number) {
        super(`[five9/${step}] ${message}`);
        this.name = 'Five9Error';
    }
    /** HTTP 404 typically means the conversation was terminated/gone. */
    conversationGone = false;
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

    private async checkStatus(res: Response, step: string): Promise<string> {
        const text = await res.text().catch(() => '');
        if (res.status >= 200 && res.status < 300) return text;
        const err = new Five9Error(step, `HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
        if (res.status === 404) err.conversationGone = true;
        throw err;
    }

    private async jsonRequest(url: string, init: RequestInit, step: string): Promise<any> {
        const res = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
        } as RequestInit);
        const text = await this.checkStatus(res, step);
        try { return text ? JSON.parse(text) : {}; }
        catch { throw new Five9Error(step, `invalid JSON: ${text.slice(0, 300)}`); }
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

        const tokenId = data?.tokenId;
        if (!tokenId) throw new Five9Error('anon-auth', 'no tokenId in auth response');

        const farmId = String(data?.context?.farmId ?? '');
        const cloudClientUrl = String(data?.context?.cloudClientUrl ?? '');
        const orgId = String(data?.orgId ?? '');
        const apiHostRaw = data?.metadata?.dataCenters?.[0]?.apiUrls?.[0]?.host ?? '';
        const apiHost = apiHostRaw ? `https://${apiHostRaw}` : this.authBaseUrl;

        if (!farmId) throw new Five9Error('anon-auth', 'no context.farmId in auth response');
        if (!orgId) throw new Five9Error('anon-auth', 'no orgId in auth response');
        if (!cloudClientUrl) throw new Five9Error('anon-auth', 'no context.cloudClientUrl in auth response');

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
        if (!exchangeRes.ok) throw new Five9Error('file-exchange-token', `HTTP ${exchangeRes.status} ${exchangeText.slice(0, 300)}`, exchangeRes.status);
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
        if (!policyRes.ok) throw new Five9Error('file-upload-policy', `HTTP ${policyRes.status} ${policyText.slice(0, 300)}`, policyRes.status);
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
            throw new Five9Error('file-upload-put', `HTTP ${putRes.status} ${putText.slice(0, 300)}`, putRes.status);
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
        if (!metaRes.ok) throw new Five9Error('file-get-metadata', `HTTP ${metaRes.status} ${metaText.slice(0, 300)}`, metaRes.status);
        let metaData: any = {};
        try { metaData = JSON.parse(metaText); } catch { throw new Five9Error('file-get-metadata', 'invalid JSON'); }
        const fileDownloadId: string = metaData?.fileDownloadId ?? metaData?.id;
        if (!fileDownloadId) throw new Five9Error('file-get-metadata', 'no fileDownloadId in file metadata response');

        return fileDownloadId;
    }
}
