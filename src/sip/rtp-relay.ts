/**
 * RTP Media Relay — multi-worker edition.
 *
 * When rtpWorkers > 0: creates N Bun Worker threads, each handling its own
 * slice of the port range and running packet relay in a separate OS thread.
 * This enables true parallel packet processing across CPU cores.
 *
 * When rtpWorkers = 0 (default): single-thread mode using the main event loop.
 *
 * Capacity: (portEnd - portStart) / 4 ports per call / numWorkers workers
 *   Example: 40000-44000, 4 workers → 4000 ports / 4 = ~1000 calls
 */

type BunUdpSocket = Bun.udp.Socket<'buffer'>;

export interface RtpEndpoint {
    ip: string;
    port: number;
}

// ─── Single-thread relay (original, for low call volumes) ─────────────────────

class PortPool {
    private available: number[];
    private inUse = new Set<number>();

    constructor(start: number, end: number) {
        this.available = [];
        for (let p = start; p <= end - 1; p += 2) this.available.push(p);
    }

    allocate(): number | null {
        const p = this.available.pop();
        if (p === undefined) return null;
        this.inUse.add(p); return p;
    }

    release(port: number): void {
        if (this.inUse.delete(port)) this.available.push(port);
    }

    get free(): number { return this.available.length; }
}

interface RelayCtx {
    callId: string;
    metaRecvAddr: RtpEndpoint;
    fbpxRecvAddr: RtpEndpoint | null;
    portA: number; portB: number;
    socketA: BunUdpSocket; socketB: BunUdpSocket;
    createdAt: number;
}

const CALL_TIMEOUT_MS = 3 * 60 * 60 * 1000;

async function makeSocket(port: number, getTarget: () => RtpEndpoint | null): Promise<BunUdpSocket> {
    return (Bun.udpSocket as Function)({
        port,
        socket: {
            data(sock: BunUdpSocket, buf: Buffer) {
                const t = getTarget();
                if (t) try { sock.send(buf, t.port, t.ip); } catch {}
            },
            error(_sock: BunUdpSocket, err: Error) {
                console.error(`[rtp-relay] :${port} error:`, err.message);
            },
        },
    }) as unknown as BunUdpSocket;
}

class SingleThreadRelay {
    private pool: PortPool;
    private contexts = new Map<string, RelayCtx>();

    constructor(portStart: number, portEnd: number) {
        this.pool = new PortPool(portStart, portEnd);
    }

    async setupInvite(callId: string, meta: RtpEndpoint): Promise<number | null> {
        const existing = this.contexts.get(callId);
        if (existing) { existing.metaRecvAddr = meta; return existing.portA; }

        const portA = this.pool.allocate();
        const portB = this.pool.allocate();
        if (portA === null || portB === null) {
            if (portA !== null) this.pool.release(portA);
            console.error('[rtp-relay] Port pool exhausted');
            return null;
        }

        const ctx: Partial<RelayCtx> = { callId, metaRecvAddr: meta, fbpxRecvAddr: null, portA, portB, createdAt: Date.now() };
        ctx.socketA = await makeSocket(portA, () => ctx.metaRecvAddr ?? null);
        ctx.socketB = await makeSocket(portB, () => ctx.fbpxRecvAddr ?? null);
        this.contexts.set(callId, ctx as RelayCtx);
        return portA;
    }

    handle200Ok(callId: string, fbpx: RtpEndpoint): number | null {
        const ctx = this.contexts.get(callId);
        if (!ctx) return null;
        ctx.fbpxRecvAddr = fbpx;
        return ctx.portB;
    }

    teardown(callId: string): void {
        const ctx = this.contexts.get(callId);
        if (!ctx) return;
        ctx.socketA.close(); ctx.socketB.close();
        this.pool.release(ctx.portA); this.pool.release(ctx.portB);
        this.contexts.delete(callId);
    }

    teardownAll(): void {
        for (const ctx of this.contexts.values()) {
            ctx.socketA.close(); ctx.socketB.close();
        }
        this.contexts.clear();
    }

    evictStale(): void {
        const now = Date.now();
        for (const [id, ctx] of this.contexts) {
            if (now - ctx.createdAt > CALL_TIMEOUT_MS) this.teardown(id);
        }
    }

    get activeCalls(): number { return this.contexts.size; }
    get freePorts(): number { return this.pool.free; }
}

// ─── Worker thread coordinator (for high call volumes) ───────────────────────

type PendingCallback = (result: { portA: number; portB: number } | null) => void;

class WorkerInstance {
    private w: Worker;
    private pending = new Map<string, PendingCallback>();

    constructor(portStart: number, portEnd: number) {
        this.w = new Worker(new URL('./rtp-worker.ts', import.meta.url));
        this.w.postMessage({ type: 'init', portStart, portEnd });
        this.w.onmessage = (ev: MessageEvent) => {
            const msg = ev.data as Record<string, unknown>;
            if (msg.type === 'setup_ok') {
                const cb = this.pending.get(msg.callId as string);
                cb?.({ portA: msg.portA as number, portB: msg.portB as number });
                this.pending.delete(msg.callId as string);
            }
            if (msg.type === 'setup_err') {
                this.pending.get(msg.callId as string)?.(null);
                this.pending.delete(msg.callId as string);
            }
        };
    }

    setup(callId: string, meta: RtpEndpoint): Promise<{ portA: number; portB: number } | null> {
        return new Promise((resolve) => {
            this.pending.set(callId, resolve);
            this.w.postMessage({ type: 'setup', callId, metaIp: meta.ip, metaPort: meta.port });
            // 5s timeout — prevents hang if worker crashes
            setTimeout(() => {
                if (this.pending.has(callId)) {
                    this.pending.delete(callId);
                    resolve(null);
                }
            }, 5_000);
        });
    }

    update(callId: string, fbpx: RtpEndpoint): void {
        this.w.postMessage({ type: 'update', callId, fbpxIp: fbpx.ip, fbpxPort: fbpx.port });
    }

    teardown(callId: string): void {
        this.w.postMessage({ type: 'teardown', callId });
    }

    teardownAll(): void { this.w.postMessage({ type: 'teardown_all' }); }
    evict(): void       { this.w.postMessage({ type: 'evict' }); }
    terminate(): void   { this.w.terminate(); }
}

class WorkerCoordinator {
    private workers: WorkerInstance[];
    private nextWorker = 0;
    private portBByCall  = new Map<string, number>();
    private callToWorker = new Map<string, WorkerInstance>();

    constructor(numWorkers: number, portStart: number, portEnd: number) {
        const rangePerWorker = Math.floor((portEnd - portStart) / numWorkers);
        this.workers = Array.from({ length: numWorkers }, (_, i) => {
            const wStart = portStart + i * rangePerWorker;
            const wEnd   = i === numWorkers - 1 ? portEnd : wStart + rangePerWorker - 1;
            console.log(`[rtp-relay] worker ${i}: ports ${wStart}-${wEnd}`);
            return new WorkerInstance(wStart, wEnd);
        });
    }

    async setupInvite(callId: string, meta: RtpEndpoint): Promise<number | null> {
        // Re-INVITE: reuse same worker
        let worker = this.callToWorker.get(callId);
        if (!worker) {
            worker = this.workers[this.nextWorker % this.workers.length];
            this.nextWorker++;
            this.callToWorker.set(callId, worker);
        }

        const result = await worker.setup(callId, meta);
        if (!result) return null;
        this.portBByCall.set(callId, result.portB);
        return result.portA;
    }

    handle200Ok(callId: string, fbpx: RtpEndpoint): number | null {
        const worker = this.callToWorker.get(callId);
        if (!worker) return null;
        worker.update(callId, fbpx);
        return this.portBByCall.get(callId) ?? null;
    }

    teardown(callId: string): void {
        const worker = this.callToWorker.get(callId);
        worker?.teardown(callId);
        this.callToWorker.delete(callId);
        this.portBByCall.delete(callId);
    }

    teardownAll(): void {
        for (const w of this.workers) w.teardownAll();
        this.callToWorker.clear();
        this.portBByCall.clear();
    }

    evictStale(): void {
        for (const w of this.workers) w.evict();
    }

    terminate(): void {
        for (const w of this.workers) w.terminate();
    }

    get activeCalls(): number { return this.callToWorker.size; }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class RtpRelayManager {
    readonly publicIp: string;
    private single: SingleThreadRelay | null = null;
    private multi:  WorkerCoordinator  | null = null;

    constructor(publicIp: string, portStart: number, portEnd: number, numWorkers = 0) {
        this.publicIp = publicIp;
        const maxCalls = Math.floor((portEnd - portStart) / 4);

        if (numWorkers > 0) {
            this.multi = new WorkerCoordinator(numWorkers, portStart, portEnd);
            console.log(`[rtp-relay] ${publicIp} ${numWorkers} workers ports ${portStart}-${portEnd} (~${maxCalls} calls)`);
        } else {
            this.single = new SingleThreadRelay(portStart, portEnd);
            console.log(`[rtp-relay] ${publicIp} single-thread ports ${portStart}-${portEnd} (~${maxCalls} calls)`);
        }
    }

    async setupInvite(callId: string, meta: RtpEndpoint): Promise<number | null> {
        return this.multi?.setupInvite(callId, meta)
            ?? this.single?.setupInvite(callId, meta)
            ?? null;
    }

    handle200Ok(callId: string, fbpx: RtpEndpoint): number | null {
        return this.multi?.handle200Ok(callId, fbpx)
            ?? this.single?.handle200Ok(callId, fbpx)
            ?? null;
    }

    teardown(callId: string): void {
        this.multi?.teardown(callId);
        this.single?.teardown(callId);
    }

    teardownAll(): void {
        this.multi?.teardownAll();
        this.multi?.terminate();
        this.single?.teardownAll();
    }

    evictStale(): void {
        this.multi?.evictStale();
        this.single?.evictStale();
    }

    get activeCalls(): number {
        return this.multi?.activeCalls ?? this.single?.activeCalls ?? 0;
    }
}
