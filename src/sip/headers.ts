import type { SipMessage, SipVia } from './message';
import { BRANCH_MAGIC, parseVia, serializeVia } from './message';
import type { TransactionTable, SipTransaction } from './transaction';

// ─── Forward Parameters ───────────────────────────────────────────────────────

/**
 * Parameters needed to forward a SIP request to the upstream.
 * Decoupled from TcpUdpProfile so the server can pass per-listener values.
 */
export interface SipForwardParams {
    upstreamTransport: 'tcp' | 'udp';
    /** Transport the client used to reach US — goes into Record-Route transport= tag */
    inboundTransport: 'tcp' | 'udp' | 'tls';
    /** Public host/IP of this proxy (put in Via and Record-Route) */
    proxyHost: string;
    /**
     * Port of our upstream socket — FusionPBX sends responses here.
     * For UDP upstream: the local port of the shared upstream UDP socket.
     * For TCP upstream: any reachable port (upstream replies on the same TCP conn).
     */
    proxyPort: number;
}

// ─── Branch Generation ────────────────────────────────────────────────────────

export function generateBranch(): string {
    return BRANCH_MAGIC + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

// ─── Header helpers ───────────────────────────────────────────────────────────

function headerIndex(headers: [string, string][], name: string): number {
    const lower = name.toLowerCase();
    return headers.findIndex(([n]) => n.toLowerCase() === lower);
}

function setHeader(headers: [string, string][], name: string, value: string): void {
    const idx = headerIndex(headers, name);
    if (idx === -1) headers.push([name, value]);
    else headers[idx] = [name, value];
}

function prependHeader(headers: [string, string][], name: string, value: string): void {
    headers.unshift([name, value]);
}

// ─── Serialisation ────────────────────────────────────────────────────────────

/**
 * Serialise a SipMessage back to a raw Buffer ready to send on the wire.
 * Always recalculates Content-Length from msg.body.
 */
export function serializeSipMessage(msg: SipMessage): Buffer {
    setHeader(msg.headers, 'Content-Length', String(msg.body.byteLength));

    const lines: string[] = [];
    if (msg.isRequest) {
        lines.push(`${msg.method} ${msg.requestUri} ${msg.sipVersion}`);
    } else {
        lines.push(`${msg.sipVersion} ${msg.statusCode} ${msg.reasonPhrase}`);
    }
    for (const [name, value] of msg.headers) {
        lines.push(`${name}: ${value}`);
    }
    lines.push('');
    lines.push('');

    const headerBuf = Buffer.from(lines.join('\r\n'), 'utf8');
    return Buffer.concat([headerBuf, msg.body]);
}

// ─── Error Response Builder ───────────────────────────────────────────────────

export function buildErrorResponse(request: SipMessage, statusCode: number, reason: string): Buffer {
    const headers: [string, string][] = [];
    for (const [n, v] of request.headers) {
        if (n.toLowerCase() === 'via') headers.push([n, v]);
    }
    headers.push(['From', request.from]);
    headers.push(['To', request.to]);
    headers.push(['Call-ID', request.callId]);
    headers.push(['CSeq', request.cseq]);
    headers.push(['Content-Length', '0']);

    const msg: SipMessage = {
        isRequest: false, sipVersion: 'SIP/2.0', statusCode, reasonPhrase: reason,
        headers, vias: [], callId: request.callId, cseq: request.cseq,
        cseqMethod: request.cseqMethod, cseqNum: request.cseqNum,
        from: request.from, to: request.to, maxForwards: 0, body: Buffer.alloc(0),
    };
    return serializeSipMessage(msg);
}

// ─── Request Processing (client → upstream) ───────────────────────────────────

export interface ForwardRequestResult {
    buf: Buffer;
    newBranch: string;
    clientBranch: string;
}

/**
 * Rewrite Via and Record-Route headers on an inbound SIP request and
 * serialise it ready to send to the upstream PBX.
 *
 * Returns null if Max-Forwards is exhausted.
 */
export function processRequestForward(
    msg: SipMessage,
    params: SipForwardParams,
): ForwardRequestResult | null {
    if (msg.maxForwards <= 0) return null;

    setHeader(msg.headers, 'Max-Forwards', String(msg.maxForwards - 1));

    const clientBranch = msg.vias[0]?.params.get('branch') as string | undefined ?? '';
    const newBranch = generateBranch();

    // Via transport = what we use to forward (outbound transport to FusionPBX)
    const outVia: SipVia = {
        transport: params.upstreamTransport === 'tcp' ? 'TCP' : 'UDP',
        host: params.proxyHost,
        port: params.proxyPort,
        params: new Map([['branch', newBranch]]),
        raw: '',
    };
    prependHeader(msg.headers, 'Via', serializeVia(outVia));

    // Record-Route: transport= reflects how the CLIENT reached us (for in-dialog re-routing)
    const rrTransport = params.inboundTransport;
    prependHeader(msg.headers, 'Record-Route',
        `<sip:${params.proxyHost}:${params.proxyPort};lr;transport=${rrTransport}>`);

    return { buf: serializeSipMessage(msg), newBranch, clientBranch };
}

// ─── Response Processing (upstream → client) ─────────────────────────────────

export interface ForwardResponseResult {
    buf: Buffer;
    /** The matched transaction — caller uses tx.tcpSocket or tx.udpReturn to deliver */
    tx: SipTransaction;
    isFinal: boolean;
}

/**
 * Strip the proxy's top Via from an upstream SIP response and look up the
 * transaction table to find the correct return path.
 *
 * Returns null if the response is stray (no matching transaction).
 */
export function processResponseForward(
    msg: SipMessage,
    txTable: TransactionTable,
): ForwardResponseResult | null {
    const topVia = msg.vias[0];
    if (!topVia) return null;

    const branch = topVia.params.get('branch') as string | undefined ?? '';
    const tx = txTable.get(branch, msg.cseqMethod);
    if (!tx) {
        console.warn(`[sip-headers] Stray response: branch=${branch} method=${msg.cseqMethod}`);
        return null;
    }

    // Remove proxy's top Via
    const viaIdx = msg.headers.findIndex(([n]) => n.toLowerCase() === 'via');
    if (viaIdx !== -1) msg.headers.splice(viaIdx, 1);

    const isFinal = !msg.isRequest && (msg.statusCode ?? 0) >= 200;
    if (isFinal) txTable.delete(branch, msg.cseqMethod);

    return { buf: serializeSipMessage(msg), tx, isFinal };
}
