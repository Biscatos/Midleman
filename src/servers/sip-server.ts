/**
 * Generic TCP/UDP proxy server — multi-listener edition.
 *
 * A single TcpUdpProfile can simultaneously accept connections on:
 *   - UDP   (SIP phones, legacy gateways)
 *   - TCP   (SIP over plain stream)
 *   - TLS   (SIPS — e.g. Meta WhatsApp Business Calling)
 *
 * All listeners forward to the same upstream (FusionPBX) using ONE shared
 * upstream socket (UDP or TCP).  SIP Via / Record-Route rewriting is applied
 * automatically when upstreamTransport='udp' so that FusionPBX sends responses
 * back through this proxy regardless of which inbound transport was used.
 */

import type { TcpUdpProfile } from '../core/types';
import { isIpAllowed } from '../core/ip-filter';
import { ensureCertificate } from '../sip/acme';
import { SipTcpParser, parseSipMessage } from '../sip/parser';
import { TransactionTable } from '../sip/transaction';
import type { SipTransaction, UdpReturn } from '../sip/transaction';
import {
    processRequestForward,
    processResponseForward,
    buildErrorResponse,
    serializeSipMessage,
    type SipForwardParams,
} from '../sip/headers';
import type { SipMessage } from '../sip/message';
import { RtpRelayManager } from '../sip/rtp-relay';
import { parseSdpAudio, rewriteSdpAudio, hasSdpBody } from '../sip/sdp';

// ─── Bun type aliases ─────────────────────────────────────────────────────────

type BunSocket    = Bun.Socket<unknown>;
type BunTcpServer = Bun.TCPSocketListener<unknown>;
type BunUdpSocket = Bun.udp.Socket<'buffer'>;

// ─── Instance ────────────────────────────────────────────────────────────────

export interface SipServerInstance {
    profile:      TcpUdpProfile;
    tcpListener:  BunTcpServer | null;    // plain TCP inbound
    tlsListener:  BunTcpServer | null;    // TLS inbound
    udpListener:  BunUdpSocket | null;    // UDP inbound (SIP phones)
    upstreamUdp:  BunUdpSocket | null;    // shared upstream UDP socket
    upstreamTcp:  BunSocket    | null;    // shared upstream TCP connection
    upstreamTcpParser: SipTcpParser | null;
    txTable:      TransactionTable;
    rtpRelay:     RtpRelayManager | null; // RTP media relay (null if disabled)
    evictTimer:   ReturnType<typeof setInterval>;
}

const servers = new Map<string, SipServerInstance>();

// ─── SIP mode ─────────────────────────────────────────────────────────────────

/**
 * SIP mode: apply Via/Record-Route rewriting.
 *
 * For UDP upstream: FusionPBX sends responses as datagrams back to the proxy's
 *   upstream UDP socket — we need Via headers so it knows where to reply.
 * For TCP/TLS upstream: responses come back on the same persistent connection,
 *   Via rewriting is still needed so in-dialog requests route back through us.
 */
function isSipMode(_profile: TcpUdpProfile): boolean {
    return true; // always rewrite Via/Record-Route
}

function resolveProxyHost(profile: TcpUdpProfile): string {
    return profile.sipPublicHost ?? process.env.PROXY_HOST ?? '127.0.0.1';
}

function buildForwardParams(
    profile: TcpUdpProfile,
    inst: SipServerInstance,
    inboundTransport: 'tcp' | 'udp' | 'tls',
): SipForwardParams {
    const proxyHost = resolveProxyHost(profile);
    // UDP upstream: upstream socket's local port — FusionPBX replies there.
    // TCP/TLS upstream: responses arrive on the same connection; use upstreamPort
    //   as the Via port so FusionPBX knows our address.
    const proxyPort = inst.upstreamUdp?.port ?? profile.upstreamPort;
    // headers.ts expects 'tcp'|'udp' for the upstream transport (not 'tls')
    const upstreamTransport: 'tcp' | 'udp' = profile.upstreamTransport === 'udp' ? 'udp' : 'tcp';
    return { upstreamTransport, inboundTransport, proxyHost, proxyPort };
}

// ─── Response dispatch (shared by all upstream handlers) ─────────────────────

function dispatchResponse(
    msg: SipMessage,
    inst: SipServerInstance,
): void {
    if (!isSipMode(inst.profile)) return;

    // BYE from upstream (FusionPBX initiates hang-up) — tear down RTP relay
    if (msg.isRequest && msg.method === 'BYE') {
        inst.rtpRelay?.teardown(msg.callId);
    }

    // RTP relay: rewrite SDP in 200 OK responses to INVITE
    if (inst.rtpRelay && !msg.isRequest &&
        (msg.statusCode ?? 0) === 200 &&
        msg.cseqMethod === 'INVITE' &&
        hasSdpBody(msg.headers, msg.body)) {

        const sdp = parseSdpAudio(msg.body);
        if (sdp) {
            const portB = inst.rtpRelay.handle200Ok(msg.callId, { ip: sdp.ip, port: sdp.port });
            if (portB !== null) {
                msg.body = rewriteSdpAudio(msg.body, inst.rtpRelay.publicIp, portB);
            }
        }
    }

    const result = processResponseForward(msg, inst.txTable);
    if (!result) return;

    const { buf, tx } = result;

    if (tx.tcpSocket) {
        try { tx.tcpSocket.write(buf); } catch { /* socket may have closed */ }
    } else if (tx.udpReturn && inst.udpListener) {
        inst.udpListener.send(buf, tx.udpReturn.port, tx.udpReturn.addr);
    }
}

// ─── Request forwarding (shared by all inbound handlers) ─────────────────────

async function forwardRequest(
    msg: SipMessage,
    inst: SipServerInstance,
    inboundTransport: 'tcp' | 'udp' | 'tls',
    returnTarget: { tcpSocket?: BunSocket; udpReturn?: UdpReturn },
    onError: (buf: Buffer) => void,
): Promise<void> {
    const { profile, txTable } = inst;

    if (msg.maxForwards <= 0) {
        onError(buildErrorResponse(msg, 483, 'Too Many Hops'));
        return;
    }

    // RTP relay: rewrite SDP in INVITE before forwarding to FusionPBX
    if (inst.rtpRelay && msg.method === 'INVITE' && hasSdpBody(msg.headers, msg.body)) {
        const sdp = parseSdpAudio(msg.body);
        if (sdp) {
            const portA = await inst.rtpRelay.setupInvite(msg.callId, { ip: sdp.ip, port: sdp.port });
            if (portA !== null) {
                msg.body = rewriteSdpAudio(msg.body, inst.rtpRelay.publicIp, portA);
            }
        }
    }

    // BYE from inbound — tear down RTP relay for this call
    if (msg.method === 'BYE') {
        inst.rtpRelay?.teardown(msg.callId);
    }

    if (isSipMode(profile)) {
        const params = buildForwardParams(profile, inst, inboundTransport);
        const result = processRequestForward(msg, params);
        if (!result) { onError(buildErrorResponse(msg, 483, 'Too Many Hops')); return; }

        const tx: SipTransaction = {
            branch: result.newBranch,
            method: msg.method ?? 'UNKNOWN',
            clientBranch: result.clientBranch,
            createdAt: Date.now(),
            ...returnTarget,
        };
        txTable.set(result.newBranch, msg.method ?? 'UNKNOWN', tx);

        if (inst.upstreamUdp) {
            inst.upstreamUdp.send(result.buf, profile.upstreamPort, profile.upstreamHost);
        } else {
            inst.upstreamTcp?.write(result.buf);
        }
    } else {
        const buf = serializeSipMessage(msg);
        inst.upstreamTcp?.write(buf);
    }
}

// ─── Per-TCP-connection handler ───────────────────────────────────────────────

function handleTcpConnection(
    socket: BunSocket,
    inboundTransport: 'tcp' | 'tls',
    inst: SipServerInstance,
): SipTcpParser {
    const parser = new SipTcpParser((msg) => {
        if (!msg.isRequest) return; // stray response on inbound — ignore
        forwardRequest(msg, inst, inboundTransport,
            { tcpSocket: socket },
            (errBuf) => { try { socket.write(errBuf); } catch {} }
        ).catch(err => console.error(`[tcpudp:${inst.profile.name}] forward error:`, err instanceof Error ? err.message : err));
    });
    return parser;
}

// ─── TCP / TLS listener builder ───────────────────────────────────────────────

const connParsers = new WeakMap<BunSocket, SipTcpParser>();

function buildTcpListener(
    profile: TcpUdpProfile,
    port: number,
    tls: boolean,
    inst: SipServerInstance,
): BunTcpServer {
    const label = profile.name;
    const transport: 'tcp' | 'tls' = tls ? 'tls' : 'tcp';

    const socketHandlers = {
        open(socket: BunSocket) {
            if (!isIpAllowed(socket.remoteAddress, profile.allowedIps)) {
                console.warn(`[tcpudp:${label}] Rejected ${socket.remoteAddress} (allowlist)`);
                socket.end();
                return;
            }
            console.log(`[tcpudp:${label}] ${transport.toUpperCase()} from ${socket.remoteAddress}`);
            connParsers.set(socket, handleTcpConnection(socket, transport, inst));
        },
        data(socket: BunSocket, data: Buffer) {
            connParsers.get(socket)?.feed(data);
        },
        close(socket: BunSocket) {
            connParsers.delete(socket);
            inst.txTable.evictForSocket(socket);
        },
        error(socket: BunSocket, err: Error) {
            console.error(`[tcpudp:${label}] ${transport.toUpperCase()} error:`, err.message);
            connParsers.delete(socket);
        },
    };

    if (tls) {
        return Bun.listen({
            hostname: '0.0.0.0', port,
            tls: { cert: Bun.file(profile.tlsCert!), key: Bun.file(profile.tlsKey!) },
            socket: socketHandlers,
        }) as BunTcpServer;
    }
    return Bun.listen({ hostname: '0.0.0.0', port, socket: socketHandlers }) as BunTcpServer;
}

// ─── UDP inbound listener builder ────────────────────────────────────────────

function buildUdpListener(
    profile: TcpUdpProfile,
    port: number,
    inst: SipServerInstance,
): BunUdpSocket {
    return (Bun.udpSocket as Function)({
        port,
        socket: {
            data(_sock: BunUdpSocket, buf: Buffer, remotePort: number, remoteAddr: string) {
                if (!isIpAllowed(remoteAddr, profile.allowedIps)) return;

                let msg: SipMessage;
                try { msg = parseSipMessage(buf); } catch { return; }

                if (!msg.isRequest) {
                    // UDP datagram from FusionPBX? Shouldn't happen on inbound port — ignore.
                    return;
                }

                forwardRequest(msg, inst, 'udp',
                    { udpReturn: { addr: remoteAddr, port: remotePort } },
                    (errBuf) => { _sock.send(errBuf, remotePort, remoteAddr); }
                ).catch(err => console.error(`[tcpudp:${profile.name}] udp forward error:`, err instanceof Error ? err.message : err));
            },
            error(_sock: BunUdpSocket, err: Error) {
                console.error(`[tcpudp:${profile.name}] UDP inbound error:`, err.message);
            },
        },
    }) as unknown as BunUdpSocket;
}

// ─── Upstream socket builders ─────────────────────────────────────────────────

function buildUpstreamUdp(profile: TcpUdpProfile, inst: SipServerInstance): BunUdpSocket {
    return (Bun.udpSocket as Function)({
        port: 0, // OS assigns ephemeral port → inst.upstreamUdp.port
        socket: {
            data(_sock: BunUdpSocket, buf: Buffer) {
                if (!isSipMode(profile)) return;
                try {
                    const msg = parseSipMessage(buf);
                    dispatchResponse(msg, inst);
                } catch {
                    // Non-SIP datagram from upstream — drop
                }
            },
            error(_sock: BunUdpSocket, err: Error) {
                console.error(`[tcpudp:${profile.name}] upstream UDP error:`, err.message);
            },
        },
    }) as unknown as BunUdpSocket;
}

async function buildUpstreamTcp(
    profile: TcpUdpProfile,
    inst: SipServerInstance,
): Promise<BunSocket> {
    const parser = new SipTcpParser((msg) => dispatchResponse(msg, inst));
    inst.upstreamTcpParser = parser;

    const isTls = profile.upstreamTransport === 'tls';
    const label = `[tcpudp:${profile.name}] upstream ${isTls ? 'TLS' : 'TCP'}`;

    const socketHandlers = {
        open(_s: BunSocket) {
            console.log(`${label} connected → ${profile.upstreamHost}:${profile.upstreamPort}`);
        },
        data(_s: BunSocket, data: Buffer) {
            parser.feed(data);
        },
        close(_s: BunSocket) {
            console.warn(`${label} closed`);
            inst.upstreamTcp = null;
        },
        error(_s: BunSocket, err: Error) {
            console.error(`${label} error:`, err.message);
        },
    };

    if (isTls) {
        return Bun.connect({
            hostname: profile.upstreamHost,
            port: profile.upstreamPort,
            tls: { rejectUnauthorized: !profile.allowSelfSignedUpstream },
            socket: socketHandlers,
        });
    }

    return Bun.connect({
        hostname: profile.upstreamHost,
        port: profile.upstreamPort,
        socket: socketHandlers,
    });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export async function startSipServer(profile: TcpUdpProfile): Promise<SipServerInstance> {
    const txTable = new TransactionTable();

    // Create RTP relay manager if enabled
    let rtpRelay: RtpRelayManager | null = null;
    if (profile.rtpRelay) {
        // rtpWorkers: explicit value, or auto (CPU cores - 1), or 0 for single-thread
        const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 1) : 1;
        const workers = profile.rtpWorkers !== undefined
            ? profile.rtpWorkers
            : Math.max(0, cores - 1);
        rtpRelay = new RtpRelayManager(
            resolveProxyHost(profile),
            profile.rtpPortStart ?? 50000,
            profile.rtpPortEnd   ?? 51000,
            workers,
        );
    }

    // Create the instance shell first so callbacks can close over it
    const inst: SipServerInstance = {
        profile,
        tcpListener: null, tlsListener: null, udpListener: null,
        upstreamUdp: null, upstreamTcp: null, upstreamTcpParser: null,
        txTable,
        rtpRelay,
        evictTimer: setInterval(() => {
            txTable.evictExpired();
            rtpRelay?.evictStale();
        }, 10_000),
    };

    // ── Upstream ─────────────────────────────────────────────────────────────
    if (profile.upstreamTransport === 'udp') {
        inst.upstreamUdp = buildUpstreamUdp(profile, inst);
    } else {
        // tcp or tls — both use a persistent TCP connection (TLS adds cert negotiation)
        try {
            inst.upstreamTcp = await buildUpstreamTcp(profile, inst);
        } catch (err) {
            const transport = profile.upstreamTransport.toUpperCase();
            console.error(`[tcpudp:${profile.name}] upstream ${transport} connect failed:`, err instanceof Error ? err.message : err);
        }
    }

    // ── ACME cert (if any TLS listener) ──────────────────────────────────────
    const hasTls = profile.listeners.some(l => l.transport === 'tls');
    if (hasTls) {
        await ensureCertificate(profile as never, async () => {
            const existing = servers.get(profile.name);
            if (!existing) return;
            console.log(`[tcpudp:${profile.name}] Certificate renewed — restarting TLS listener...`);
            const tlsL = profile.listeners.find(l => l.transport === 'tls');
            if (tlsL) {
                existing.tlsListener?.stop(true);
                existing.tlsListener = buildTcpListener(profile, tlsL.port, true, existing);
                console.log(`[tcpudp:${profile.name}] TLS listener restarted ✓`);
            }
        });
    }

    // ── Inbound listeners ─────────────────────────────────────────────────────
    for (const listener of profile.listeners) {
        if (listener.transport === 'tcp') {
            inst.tcpListener = buildTcpListener(profile, listener.port, false, inst);
        } else if (listener.transport === 'tls') {
            inst.tlsListener = buildTcpListener(profile, listener.port, true, inst);
        } else if (listener.transport === 'udp') {
            inst.udpListener = buildUdpListener(profile, listener.port, inst);
        }
    }

    servers.set(profile.name, inst);

    const upstreamDesc = `${profile.upstreamHost}:${profile.upstreamPort}/${profile.upstreamTransport.toUpperCase()}`;
    for (const l of profile.listeners) {
        console.log(`🔌 TCP/UDP "${profile.name}" :${l.port}/${l.transport.toUpperCase()} → ${upstreamDesc}`);
    }
    return inst;
}

export async function stopSipServer(name: string): Promise<void> {
    const inst = servers.get(name);
    if (!inst) return;
    clearInterval(inst.evictTimer);
    inst.rtpRelay?.teardownAll();
    inst.tcpListener?.stop(true);
    inst.tlsListener?.stop(true);
    inst.udpListener?.close();
    inst.upstreamUdp?.close();
    inst.upstreamTcp?.end();
    servers.delete(name);
    console.log(`🛑 TCP/UDP "${name}" stopped`);
}

export async function stopAllSipServers(): Promise<void> {
    for (const name of [...servers.keys()]) await stopSipServer(name);
}

export async function restartSipServer(name: string, newProfile?: TcpUdpProfile): Promise<SipServerInstance | null> {
    const existing = servers.get(name);
    if (!existing) return null;
    const profile = newProfile ?? existing.profile;
    await stopSipServer(name);
    return startSipServer(profile);
}

export function getSipServerStatus(): { name: string; listeners: { transport: string; port: number }[]; upstream: string; transport: string; running: boolean }[] {
    return Array.from(servers.values()).map(inst => ({
        name: inst.profile.name,
        listeners: inst.profile.listeners.map(l => ({ transport: l.transport, port: l.port })),
        upstream: `${inst.profile.upstreamHost}:${inst.profile.upstreamPort}`,
        transport: inst.profile.upstreamTransport,
        running: true,
    }));
}

export function isSipServerRunning(name: string): boolean {
    return servers.has(name);
}
