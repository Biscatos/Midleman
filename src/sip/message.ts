// ─── SIP Message Types ────────────────────────────────────────────────────────

/** Magic cookie that must prefix every branch parameter (RFC 3261 §8.1.1.7) */
export const BRANCH_MAGIC = 'z9hG4bK';

export type SipTransport = 'TLS' | 'TCP' | 'UDP';

export interface SipVia {
    transport: SipTransport;
    host: string;
    port: number | undefined;
    /** All params (branch, rport, received, …) — value is string or true for flag params */
    params: Map<string, string | true>;
    /** Original unparsed value for passthrough when no rewrite is needed */
    raw: string;
}

/**
 * A parsed SIP request or response.
 *
 * Headers are stored as an ordered array of [name, value] pairs — NOT a Map —
 * because SIP allows multiple headers with the same name (especially Via, Route).
 * Rewriting a header means finding its entry in `headers` and replacing it.
 */
export interface SipMessage {
    isRequest: boolean;

    // Request-only
    method?: string;        // INVITE, REGISTER, BYE, ACK, OPTIONS, CANCEL, …
    requestUri?: string;    // sip:user@domain

    // Response-only
    statusCode?: number;
    reasonPhrase?: string;

    sipVersion: string;     // "SIP/2.0"

    /** Raw ordered headers — source of truth for serialization */
    headers: [string, string][];

    /** Parsed Via entries, top (most recent) first */
    vias: SipVia[];

    callId: string;
    cseq: string;           // full value e.g. "1 INVITE"
    cseqMethod: string;     // "INVITE"
    cseqNum: number;        // 1
    from: string;
    to: string;
    maxForwards: number;

    /** Raw body bytes (SDP or empty) */
    body: Buffer;
}

// ─── Via Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a single Via header value into a structured SipVia.
 * Input: "SIP/2.0/TLS 203.0.113.1:5061;branch=z9hG4bKxxx;rport"
 */
export function parseVia(raw: string): SipVia {
    const semicolonIdx = raw.indexOf(';');
    const sentPart = semicolonIdx === -1 ? raw.trim() : raw.slice(0, semicolonIdx).trim();
    const paramStr = semicolonIdx === -1 ? '' : raw.slice(semicolonIdx + 1);

    // "SIP/2.0/TLS host:port"
    const spaceIdx = sentPart.search(/\s+/);
    const proto = spaceIdx === -1 ? sentPart : sentPart.slice(0, spaceIdx);
    const sentBy = spaceIdx === -1 ? '' : sentPart.slice(spaceIdx).trim();

    const protoParts = proto.split('/');
    const transport = (protoParts[2] ?? 'UDP').toUpperCase() as SipTransport;

    const colonIdx = sentBy.lastIndexOf(':');
    let host = sentBy;
    let port: number | undefined;
    if (colonIdx !== -1) {
        const portStr = sentBy.slice(colonIdx + 1);
        if (/^\d+$/.test(portStr)) {
            host = sentBy.slice(0, colonIdx);
            port = parseInt(portStr, 10);
        }
    }

    const params = new Map<string, string | true>();
    if (paramStr) {
        for (const part of paramStr.split(';')) {
            const eqIdx = part.indexOf('=');
            if (eqIdx === -1) {
                params.set(part.trim().toLowerCase(), true);
            } else {
                params.set(part.slice(0, eqIdx).trim().toLowerCase(), part.slice(eqIdx + 1).trim());
            }
        }
    }

    return { transport, host, port, params, raw };
}

/** Serialise a SipVia back to header value string */
export function serializeVia(via: SipVia): string {
    const sentBy = via.port !== undefined ? `${via.host}:${via.port}` : via.host;
    const base = `SIP/2.0/${via.transport} ${sentBy}`;
    const parts: string[] = [];
    for (const [k, v] of via.params) {
        parts.push(v === true ? k : `${k}=${v}`);
    }
    return parts.length > 0 ? `${base};${parts.join(';')}` : base;
}
