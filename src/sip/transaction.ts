// ─── SIP Transaction Table ────────────────────────────────────────────────────
//
// Maps outgoing branch IDs back to the inbound socket so that responses from
// FusionPBX can be forwarded to the correct client.
//
// Supports two return paths:
//   - TCP/TLS inbound  → tcpSocket (persistent connection)
//   - UDP inbound      → udpReturn (datagram return address)
//
// Key: `${branch}:${method.toUpperCase()}` — avoids collisions between INVITE
// and non-INVITE transactions sharing the same branch (RFC 3261 §17).

type BunSocket = Bun.Socket<unknown>;

export interface UdpReturn {
    addr: string;
    port: number;
}

export interface SipTransaction {
    branch: string;
    method: string;
    clientBranch: string;
    createdAt: number;
    /** Set for TCP/TLS inbound — write the response to this socket */
    tcpSocket?: BunSocket;
    /** Set for UDP inbound — send the response datagram to this address */
    udpReturn?: UdpReturn;
}

/** 32 seconds = 64 × T1 (T1=500ms), per RFC 3261 §17 */
const TX_TTL_MS = 32_000;

export class TransactionTable {
    private readonly table = new Map<string, SipTransaction>();

    set(branch: string, method: string, tx: SipTransaction): void {
        this.table.set(`${branch}:${method.toUpperCase()}`, tx);
    }

    get(branch: string, method: string): SipTransaction | undefined {
        return this.table.get(`${branch}:${method.toUpperCase()}`);
    }

    delete(branch: string, method: string): void {
        this.table.delete(`${branch}:${method.toUpperCase()}`);
    }

    /** Remove transactions older than TX_TTL_MS. Call periodically. */
    evictExpired(): void {
        const now = Date.now();
        for (const [key, tx] of this.table) {
            if (now - tx.createdAt > TX_TTL_MS) this.table.delete(key);
        }
    }

    /** Remove all transactions tied to a specific TCP/TLS socket (on socket close). */
    evictForSocket(socket: BunSocket): void {
        for (const [key, tx] of this.table) {
            if (tx.tcpSocket === socket) this.table.delete(key);
        }
    }

    get size(): number {
        return this.table.size;
    }
}
