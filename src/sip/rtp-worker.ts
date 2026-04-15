/**
 * RTP Relay Worker Thread
 *
 * Runs in a dedicated OS thread via Bun Worker.
 * Manages its own port pool and UDP sockets — no shared state with main thread.
 *
 * Protocol (postMessage):
 *   Main → Worker:
 *     { type:'init',      portStart, portEnd }
 *     { type:'setup',     callId, metaIp, metaPort }
 *     { type:'update',    callId, fbpxIp, fbpxPort }
 *     { type:'teardown',  callId }
 *     { type:'teardown_all' }
 *     { type:'evict' }
 *
 *   Worker → Main:
 *     { type:'setup_ok',  callId, portA, portB }
 *     { type:'setup_err', callId, reason }
 */

type BunUdpSocket = Bun.udp.Socket<'buffer'>;

interface RtpEndpoint { ip: string; port: number; }

interface Relay {
    callId:       string;
    metaRecvAddr: RtpEndpoint;           // where Meta receives audio from us
    fbpxRecvAddr: RtpEndpoint | null;    // where FusionPBX receives audio from us
    portA:        number;                // socketA bound here
    portB:        number;                // socketB bound here
    socketA:      BunUdpSocket;          // FusionPBX → us → Meta
    socketB:      BunUdpSocket;          // Meta → us → FusionPBX
    createdAt:    number;
}

// ─── Port Pool ────────────────────────────────────────────────────────────────

class PortPool {
    private available: number[] = [];
    private inUse = new Set<number>();

    init(start: number, end: number): void {
        for (let p = start; p <= end - 1; p += 2) {
            this.available.push(p);
        }
    }

    allocate(): number | null {
        const port = this.available.pop();
        if (port === undefined) return null;
        this.inUse.add(port);
        return port;
    }

    release(port: number): void {
        if (this.inUse.delete(port)) this.available.push(port);
    }
}

// In Bun Workers, `self` is the global worker scope (Web Worker API)
declare const self: { onmessage: ((ev: MessageEvent) => unknown) | null; postMessage(data: unknown): void };

// ─── State ────────────────────────────────────────────────────────────────────

const pool = new PortPool();
const relays = new Map<string, Relay>();
let initialized = false;

const CALL_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours

// ─── UDP socket factory ───────────────────────────────────────────────────────

async function createSocket(port: number, getTarget: () => RtpEndpoint | null): Promise<BunUdpSocket> {
    return (Bun.udpSocket as Function)({
        port,
        socket: {
            data(sock: BunUdpSocket, buf: Buffer) {
                const t = getTarget();
                if (t) try { sock.send(buf, t.port, t.ip); } catch {}
            },
            error(_sock: BunUdpSocket, err: Error) {
                console.error(`[rtp-worker] :${port} error:`, err.message);
            },
        },
    }) as unknown as BunUdpSocket;
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
    const msg = event.data as Record<string, unknown>;

    // ── init ──────────────────────────────────────────────────────────────────
    if (msg.type === 'init') {
        pool.init(msg.portStart as number, msg.portEnd as number);
        initialized = true;
        return;
    }

    if (!initialized) return;

    // ── setup ─────────────────────────────────────────────────────────────────
    if (msg.type === 'setup') {
        const callId  = msg.callId as string;
        const metaIp  = msg.metaIp as string;
        const metaPort = msg.metaPort as number;

        // Re-INVITE: update Meta address, keep sockets
        const existing = relays.get(callId);
        if (existing) {
            existing.metaRecvAddr = { ip: metaIp, port: metaPort };
            self.postMessage({ type: 'setup_ok', callId, portA: existing.portA, portB: existing.portB });
            return;
        }

        const portA = pool.allocate();
        const portB = pool.allocate();

        if (portA === null || portB === null) {
            if (portA !== null) pool.release(portA);
            self.postMessage({ type: 'setup_err', callId, reason: 'port pool exhausted' });
            return;
        }

        // Use a mutable ref so closures always see the latest addresses
        const relay: Partial<Relay> = {
            callId, portA, portB,
            metaRecvAddr: { ip: metaIp, port: metaPort },
            fbpxRecvAddr: null,
            createdAt: Date.now(),
        };

        relay.socketA = await createSocket(portA, () => relay.metaRecvAddr ?? null);
        relay.socketB = await createSocket(portB, () => relay.fbpxRecvAddr ?? null);

        relays.set(callId, relay as Relay);
        self.postMessage({ type: 'setup_ok', callId, portA, portB });
        return;
    }

    // ── update (200 OK arrived — now we know FusionPBX recv addr) ─────────────
    if (msg.type === 'update') {
        const relay = relays.get(msg.callId as string);
        if (relay) relay.fbpxRecvAddr = { ip: msg.fbpxIp as string, port: msg.fbpxPort as number };
        return;
    }

    // ── teardown ──────────────────────────────────────────────────────────────
    if (msg.type === 'teardown') {
        const relay = relays.get(msg.callId as string);
        if (!relay) return;
        relay.socketA.close();
        relay.socketB.close();
        pool.release(relay.portA);
        pool.release(relay.portB);
        relays.delete(relay.callId);
        return;
    }

    // ── teardown_all ──────────────────────────────────────────────────────────
    if (msg.type === 'teardown_all') {
        for (const relay of relays.values()) {
            relay.socketA.close();
            relay.socketB.close();
        }
        relays.clear();
        return;
    }

    // ── evict stale calls ─────────────────────────────────────────────────────
    if (msg.type === 'evict') {
        const now = Date.now();
        for (const [callId, relay] of relays) {
            if (now - relay.createdAt > CALL_TIMEOUT_MS) {
                relay.socketA.close();
                relay.socketB.close();
                pool.release(relay.portA);
                pool.release(relay.portB);
                relays.delete(callId);
            }
        }
    }
};
