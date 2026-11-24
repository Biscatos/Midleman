// Proxy retry queue, end to end: a real proxy on its own port in front of an upstream
// that is down, then refuses, then recovers.
// Lives in servers/ so it runs after delivery-journal.test: whichever file imports webhook-server first fixes DELIVERY_ENGINE.
import { expect, test, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'mm-pretry-'));
const ws = await import('./webhook-server');
const ps = await import('./proxy-server');

const PPORT = 47980, UPORT = 47981;
type Hit = { method: string; path: string; body: string; key: string | null; apiKey: string | null; idem: string | null; marker: string | null };
const hits: Hit[] = [];
let mode: 'ok' | '503' | '400' = 'ok';
let upstream: ReturnType<typeof Bun.serve> | null = null;
const startUpstream = () => {
    upstream = Bun.serve({
        port: UPORT, hostname: '127.0.0.1',
        async fetch(req) {
            const u = new URL(req.url);
            hits.push({
                method: req.method, path: u.pathname + u.search, body: await req.text(), key: req.headers.get('x-mid-api-key'),
                apiKey: req.headers.get('x-upstream-key'), idem: req.headers.get('idempotency-key'), marker: req.headers.get('x-midleman-retry'),
            });
            if (mode === '503') return new Response('busy', { status: 503 });
            if (mode === '400') return Response.json({ error: 'bad booking' }, { status: 400 });
            return Response.json({ reference: 'REF-' + hits.length });
        },
    });
};

const profile: any = {
    name: 'bridge', targetUrl: `http://127.0.0.1:${UPORT}`, apiKey: 'upstream-secret', authHeader: 'X-Upstream-Key', authPrefix: '',
    accessKey: 'client-key', forwardPath: true, logMode: 'off', retryQueue: { enabled: true, maxAttemptsPerMinute: 120 },
};
ws.setInternalServices({
    resolve: (kind, name) => kind === 'proxy' && name === 'bridge' ? { port: PPORT } : { error: 'unknown' },
    authFor: (port): Record<string, string> => port === PPORT ? { 'x-mid-api-key': 'client-key' } : {},
    isServicePort: port => port === PPORT,
});
ps.startProxyServer(profile, PPORT);
ws.startPendingRetryScheduler();

const call = (path: string, body: unknown, method = 'POST') => fetch(`http://127.0.0.1:${PPORT}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-mid-api-key': 'client-key' }, body: method === 'GET' ? undefined : JSON.stringify(body),
    keepalive: false, // a kept-alive socket would stay on the proxy instance from before a restart
});
const mine = () => ws.getPendingRetryQueue().filter(e => e.webhookName === 'proxy:bridge');
const until = async (ok: () => boolean, ms = 6000) => { const t = performance.now(); while (!ok() && performance.now() - t < ms) await Bun.sleep(50); };

afterAll(async () => {
    ws.stopPendingRetryScheduler();
    ws.dismissAllPendingRetry({ webhook: 'proxy:bridge' } as any);
    ws.dismissAllFailedFanouts('proxy:bridge');
    await ps.stopProxyServer('bridge');
    ws.setInternalServices(null as any); // other test files expect to start without one
    upstream?.stop(true);
});

test('upstream healthy: the caller gets the upstream answer and nothing is queued', async () => {
    startUpstream();
    const r = await call('/public/reference?x=1', { n: 1 });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).reference).toBe('REF-1');
    expect(mine().length).toBe(0);
    expect(hits[0].marker).toBeNull();
});

test('upstream down: 202 to the caller, delivered later with the same body, credentials added at send time', async () => {
    upstream!.stop(true); upstream = null; hits.length = 0;
    const a = await call('/public/reference?x=2', { n: 2 });
    const b = await call('/public/reference?x=2', { n: 2 }); // identical on purpose: two operations, not a duplicate
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const body = await a.json() as any;
    expect(body.status).toBe('queued');
    expect(typeof body.requestId).toBe('string');
    const q = mine();
    expect(q.length).toBe(2);
    expect(JSON.stringify(q.map(e => e.headers))).not.toMatch(/client-key|upstream-secret/);

    startUpstream();
    await until(() => mine().length === 0);
    expect(mine().length).toBe(0);
    expect(hits.length).toBe(2);
    for (const h of hits) {
        expect(h).toMatchObject({ method: 'POST', path: '/public/reference?x=2', body: '{"n":2}', apiKey: 'upstream-secret', key: null, marker: null });
        expect(h.idem).toBeTruthy();
    }
    expect(hits[0].idem).not.toBe(hits[1].idem);
}, 15_000);

test('upstream answers 503: queued, and the answer of a failing retry is not queued again', async () => {
    mode = '503'; hits.length = 0;
    const r = await call('/pay', { n: 3 });
    expect(r.status).toBe(202);
    await until(() => hits.length >= 3);
    expect(mine().length).toBe(1); // still one entry, however many attempts failed
    mode = 'ok';
    await until(() => mine().length === 0);
    expect(mine().length).toBe(0);
}, 15_000);

test('upstream refuses with 400: passed to the caller; on a retry it goes to the failed list instead of looping', async () => {
    mode = '400'; hits.length = 0;
    const direct = await call('/pay', { n: 4 });
    expect(direct.status).toBe(400); // the upstream's own answer, not queued
    expect(mine().length).toBe(0);

    mode = '503';
    expect((await call('/pay', { n: 5 })).status).toBe(202);
    mode = '400';
    await until(() => ws.getDeadLetterQueue().some(e => e.webhookName === 'proxy:bridge'));
    expect(mine().length).toBe(0);
    const failed = ws.getDeadLetterQueue().filter(e => e.webhookName === 'proxy:bridge');
    expect(failed.length).toBe(1);
    expect(failed[0].lastError).toBe('HTTP 400');
    mode = 'ok';
}, 15_000);

test('GET is never queued, and a proxy without the option still answers 502', async () => {
    upstream!.stop(true); upstream = null;
    expect((await call('/status', null, 'GET')).status).toBe(502);
    expect(mine().length).toBe(0);
    await ps.restartProxyServer('bridge', { ...profile, retryQueue: undefined }, PPORT);
    expect((await call('/pay', { n: 6 })).status).toBe(502);
    expect(mine().length).toBe(0);
});
