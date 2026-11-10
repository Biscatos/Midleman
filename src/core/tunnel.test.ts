// End-to-end tunnel test: real Midleman tunnel server code + the real agent as a subprocess.
//   bun test tunnel.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..').split(sep).join('/');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mm-tun-'));
process.env.PORT_RANGE_START = '4600';
const T = await import(ROOT + '/src/core/agent-tunnel.ts');
const N = await import(ROOT + '/src/core/tunnels.ts');

const MB = 1024 * 1024;
const BLOB = randomBytes(128 * MB), BLOB_SHA = createHash('sha256').update(BLOB).digest('hex');
let server: any, agent: any, echo: any, source: any, sink: any;
let sourceSent = 0, sinkHash = createHash('sha256'), sinkBytes = 0, sinkDone: (() => void) | null = null;

beforeAll(async () => {
    server = Bun.serve({
        port: 0, hostname: '127.0.0.1', websocket: T.tunnelWebSocket,
        fetch(req, srv) { return new URL(req.url).pathname === '/agent/tunnel' ? T.upgradeTunnel(srv, req, 'test', '127.0.0.1') : new Response('{}'); },
    });
    echo = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data(s, d) { s.write(d); } } });   // small payloads only
    // sends BLOB then closes; counts what the kernel accepted so the test can see backpressure reach the origin
    source = Bun.listen<{ off: number }>({
        hostname: '127.0.0.1', port: 0,
        socket: {
            open(s) { s.data = { off: 0 }; pump(s); },
            drain(s) { pump(s); },
            data() {},
        },
    });
    function pump(s: any) {
        while (s.data.off < BLOB.length) {
            const n = s.write(BLOB.subarray(s.data.off, Math.min(BLOB.length, s.data.off + 256 * 1024)));
            if (n <= 0) return; s.data.off += n; sourceSent += n;
        }
        s.end();
    }
    sink = net.createServer(c => { c.on('data', d => { sinkHash.update(d); sinkBytes += d.length; }); c.on('close', () => sinkDone?.()); }).listen(0, '127.0.0.1');
    await new Promise(r => sink.once('listening', r));
    agent = Bun.spawn(['bun', 'run', 'src/agent/index.ts'], {
        cwd: ROOT, stdout: 'ignore', stderr: 'ignore',
        env: { ...process.env, MIDLEMAN_URL: `http://127.0.0.1:${server.port}`, AGENT_TOKEN: 'x', AGENT_NAME: 'test', TUNNEL_ALLOW: 'private', TUNNEL_CONNS: '2', DOCKER_SOCK: '/nonexistent' },
    });
    for (let i = 0; i < 100 && (T.tunnelAgents()[0]?.connections ?? 0) < 2; i++) await Bun.sleep(100);
});
afterAll(() => { agent?.kill(); server?.stop(true); echo?.stop(true); source?.stop(true); sink?.close(); });

function download(port: number, onData?: (sock: net.Socket, total: number) => void): Promise<{ sha: string; bytes: number; ms: number }> {
    return new Promise((resolve, reject) => {
        const h = createHash('sha256'); let n = 0; const t0 = performance.now();
        const c = net.connect(port, '127.0.0.1');
        c.on('data', d => { h.update(d); n += d.length; onData?.(c, n); });
        c.on('close', () => resolve({ sha: h.digest('hex'), bytes: n, ms: performance.now() - t0 }));
        c.on('error', reject);
    });
}

test('agent connects with a pool and reports round-trip time', async () => {
    const a = T.tunnelAgents();
    expect(a.length).toBe(1); expect(a[0].name).toBe('test'); expect(a[0].connections).toBe(2);
    for (let i = 0; i < 20 && T.tunnelAgents()[0].rttMs === null; i++) await Bun.sleep(50);
    expect(T.tunnelAgents()[0].rttMs).not.toBeNull();
});

test('old protocol is refused with a clear answer', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/agent/tunnel`, { headers: { Upgrade: 'websocket' } });
    expect(r.status).toBe(426);
});

test('probe: reachable, refused by the agent, closed port', async () => {
    expect((await T.probeTunnel('test', '127.0.0.1', echo.port)).ok).toBe(true);
    const pub = await T.probeTunnel('test', '8.8.8.8', 53);
    expect(pub.ok).toBe(false); expect(pub.error).toContain('not allowed');
    const dead = await T.probeTunnel('test', '127.0.0.1', 1);
    expect(dead.ok).toBe(false);
    expect((await T.probeTunnel('nobody', '127.0.0.1', 1)).error).toContain('no tunnel connection');
});

test('128 MB download keeps its bytes (fast reader) and reports throughput', async () => {
    const port = await T.tunnelLocalPort('test', '127.0.0.1', source.port);
    const r = await download(port);
    expect(r.bytes).toBe(BLOB.length); expect(r.sha).toBe(BLOB_SHA);
    console.log(`   download: ${(r.bytes / MB / (r.ms / 1000)).toFixed(0)} MB/s (${r.ms.toFixed(0)} ms for ${r.bytes / MB} MB)`);
}, 120_000);

test('a stalled reader stops the origin instead of filling memory', async () => {
    const port = await T.tunnelLocalPort('test', '127.0.0.1', source.port);
    sourceSent = 0; let stalled = false, sentAtStallEnd = 0;
    const rss0 = process.memoryUsage.rss();
    const r = await download(port, (c, total) => {
        if (stalled || total < MB) return;
        stalled = true; c.pause();
        setTimeout(() => { sentAtStallEnd = sourceSent; c.resume(); }, 2000);
    });
    console.log(`   stalled reader: origin had sent ${(sentAtStallEnd / MB).toFixed(1)} MB of 128 MB when the reader woke up; rss +${((process.memoryUsage.rss() - rss0) / MB).toFixed(0)} MB`);
    expect(sentAtStallEnd).toBeLessThan(32 * MB);         // window (2 MB per hop) + kernel socket buffers, not the whole file
    expect(r.bytes).toBe(BLOB.length); expect(r.sha).toBe(BLOB_SHA);
}, 120_000);

test('128 MB upload keeps its bytes', async () => {
    const port = await T.tunnelLocalPort('test', '127.0.0.1', sink.address().port);
    sinkHash = createHash('sha256'); sinkBytes = 0;
    const done = new Promise<void>(r => { sinkDone = r; });
    const t0 = performance.now();
    const c = net.connect(port, '127.0.0.1');
    await new Promise<void>((res, rej) => { c.on('error', rej); c.end(BLOB, () => res()); });
    await done;
    const ms = performance.now() - t0;
    expect(sinkBytes).toBe(BLOB.length); expect(sinkHash.digest('hex')).toBe(BLOB_SHA);
    console.log(`   upload: ${(BLOB.length / MB / (ms / 1000)).toFixed(0)} MB/s`);
}, 120_000);

test('300 concurrent streams, each gets its own bytes back', async () => {
    const port = await T.tunnelLocalPort('test', '127.0.0.1', echo.port);
    const t0 = performance.now();
    let peak = 0; const errs = new Set<string>();
    const one = async (i: number) => {
        await Bun.sleep(Math.floor(i / 50) * 40);
        return new Promise<boolean>((resolve) => {
            const want = randomBytes(8 * 1024 + i); const got: Buffer[] = []; let n = 0;
            const c = net.connect(port, '127.0.0.1', () => c.write(want));
            c.on('data', (d: Buffer) => { got.push(d); n += d.length; if (n >= want.length) setTimeout(() => { peak = Math.max(peak, T.tunnelAgents()[0].streams); c.destroy(); resolve(Buffer.concat(got).equals(want)); }, 600); });
            c.on('error', (e: any) => { errs.add(e.code); resolve(false); });
            setTimeout(() => resolve(false), 20_000);
        });
    };
    const res = await Promise.all(Array.from({ length: 300 }, (_, i) => one(i)));
    if (errs.size) console.log('   errors:', [...errs]);
    expect(res.filter(Boolean).length).toBe(300);
    expect(peak).toBeGreaterThanOrEqual(250);
    console.log(`   300 concurrent streams in ${(performance.now() - t0).toFixed(0)} ms`);
    await Bun.sleep(300);
    expect(T.tunnelAgents()[0].streams).toBe(0);           // nothing leaked
}, 60_000);

test('named tunnel: validation, address filter, limit, counters, delete', async () => {
    N.startTunnels([3000]);
    const base = { agent: 'test', host: '127.0.0.1', port: echo.port };
    expect(() => N.saveTunnel({ ...base, name: 'Bad Name' })).toThrow();
    expect(() => N.saveTunnel({ ...base, name: 'a', allowedIps: ['0.0.0.0/0'] })).toThrow(/too broad/);
    expect(() => N.saveTunnel({ ...base, name: 'a', allowedIps: ['10.0.0.300'] })).toThrow(/not an IPv4/);
    expect(() => N.saveTunnel({ ...base, name: 'a', port: 70000 })).toThrow();
    expect(() => N.saveTunnel({ ...base, name: 'a', listenPort: 3000 })).toThrow(/already used/);

    const t = N.saveTunnel({ ...base, name: 'echo', maxConnections: 1 }, undefined, 'tester');
    expect(t.listenPort).toBeGreaterThanOrEqual(4600);
    expect(() => N.saveTunnel({ ...base, name: 'echo' })).toThrow(/already exists/);
    expect(() => N.saveTunnel({ ...base, name: 'other', listenPort: t.listenPort })).toThrow(/already used/);

    const c1 = net.connect(t.listenPort, '127.0.0.1');
    const back = await new Promise<string>(r => { c1.on('data', d => r(d.toString())); c1.write('hello'); });
    expect(back).toBe('hello');
    // second connection is over the limit of 1 → closed at accept
    const closed = await new Promise<boolean>(r => { const c2 = net.connect(t.listenPort, '127.0.0.1'); c2.on('close', () => r(true)); c2.on('error', () => r(true)); setTimeout(() => r(false), 3000); });
    expect(closed).toBe(true);
    let row = N.listTunnels().find((x: any) => x.name === 'echo');
    expect(row.status).toBe('online'); expect(row.active).toBe(1); expect(row.total).toBe(1); expect(row.rejected).toBe(1);
    expect(row.lastRejected.why).toBe('connection limit reached');
    c1.destroy(); await Bun.sleep(300);
    row = N.listTunnels().find((x: any) => x.name === 'echo');
    expect(row.active).toBe(0); expect(row.bytesUp).toBe(5); expect(row.bytesDown).toBe(5); expect(row.recent.length).toBe(1);

    // off → the port stops answering; on → it answers again on the same port
    N.saveTunnel({ ...base, enabled: false }, N.getTunnel('echo'));
    expect(await new Promise<boolean>(r => { const c = net.connect(t.listenPort, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })).toBe(false);
    const again = N.saveTunnel({ ...base, enabled: true }, N.getTunnel('echo'));
    expect(again.listenPort).toBe(t.listenPort); expect(again.maxConnections).toBe(1);
    expect(await new Promise<boolean>(r => { const c = net.connect(t.listenPort, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })).toBe(true);

    // agent that is not connected → refused, counted, status offline
    const off = N.saveTunnel({ agent: 'ghost', host: '10.0.0.1', port: 6379, name: 'ghost' });
    await new Promise<void>(r => { const c = net.connect(off.listenPort, '127.0.0.1'); c.on('close', () => r()); c.on('error', () => r()); });
    const g = N.listTunnels().find((x: any) => x.name === 'ghost');
    expect(g.status).toBe('offline'); expect(g.rejected).toBe(1);

    expect(N.deleteTunnel('echo')).toBe(true); expect(N.deleteTunnel('ghost')).toBe(true); expect(N.listTunnels().length).toBe(0);
}, 30_000);
