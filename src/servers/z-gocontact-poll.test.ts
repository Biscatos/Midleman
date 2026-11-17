// GoContact poll scheduler: many sessions get their agent replies within a few
// seconds, exactly once, even when the wall clock steps back 60 s (NTP) mid-run.
// Named z-… to run LAST: its hundreds of sockets churn the ephemeral port range that the
// fixed-port webhook tests (479xx) listen on, which made them flaky when they ran after it.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir, networkInterfaces } from 'os';
import { join } from 'path';

const dataDir = mkdtempSync(join(tmpdir(), 'mm-connector-poll-'));
process.env.DATA_DIR ??= dataDir; // shared process: the first test file to import webhook-server picks the dir
const { initConnectorSessions } = await import('../gocontact/sessions');
const { startConnectorServer, stopConnectorServer } = await import('./connector-server');

const CPORT = 47970, GPORT = 47971, HPORT = 47972, SESSIONS = 100;
// The SSRF guard refuses loopback webhook targets: deliver to this machine's LAN address.
const LAN = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;

// Mock GoContact: every customer MSG gets one agent reply, available 2 s later (after the clock step).
let seq = 0;
const pending = new Map<string, { uuid: string; msg: string }[]>();
const gocontact = Bun.serve({
    port: GPORT,
    async fetch(req) {
        const p = new URL(req.url).pathname;
        const raw = req.method === 'POST' ? await req.text() : '';
        await Bun.sleep(20);
        const ak = p.split('/plugin/')[1]?.split('/')[0] || '';
        if (p.endsWith('auth/token')) return Response.json({ token: 't', expireTimestamp: Date.now() + 86_400_000 });
        if (p.includes('/schedule/')) return Response.json({ online: true });
        if (p.endsWith('/access-key')) return Response.json({ accessKey: 'ak' + ++seq });
        if (p.endsWith('/new-dialog-group')) return Response.json({ dialogGroupUuid: 'dg' + ++seq });
        if (p.endsWith('/new-client-messages')) {
            return Response.json({ data: (pending.get(ak) || []).map(m => ({ usertype: 'AGENT', displayname: 'A', msgtype: 'MSG', msg: m.msg, uuid: m.uuid })) });
        }
        if (p.endsWith('/client-message')) {
            const e = JSON.parse(raw).episodeObj;
            if (e.msgtype === 'MSG') setTimeout(() => pending.set(ak, [...(pending.get(ak) || []), { uuid: 'm' + ++seq, msg: 'reply-' + e.msg }]), 2000);
            return Response.json({ data: { episode: { uuid: 'ep' + ++seq } } });
        }
        if (p.endsWith('/mark-as-read')) {
            const id = JSON.parse(raw).dialogUuid;
            pending.set(ak, (pending.get(ak) || []).filter(m => m.uuid !== id));
            return Response.json({ error: false });
        }
        return Response.json({});
    },
});

const got = new Map<string, number>();
const hooks = Bun.serve({
    port: HPORT, hostname: '0.0.0.0',
    async fetch(req) {
        const m = (await req.text()).match(/reply-(c\d+)/);
        if (m) got.set(m[1], (got.get(m[1]) || 0) + 1);
        return new Response('ok');
    },
});

const realNow = Date.now;
afterAll(async () => {
    Date.now = realNow;
    await stopConnectorServer('polltest', false);
    gocontact.stop(true); hooks.stop(true);
});

test.skipIf(!LAN)('100 sessions get every agent reply within seconds, once, despite a 60 s clock step back', async () => {
    initConnectorSessions(dataDir);
    startConnectorServer({
        name: 'polltest', port: CPORT, enabled: true, channel: 'generic', logMode: 'off',
        gocontact: { baseUrl: `http://127.0.0.1:${GPORT}/`, username: 'u', password: 'p', hashKey: 'h', domainUuid: 'd' },
        pollIntervalMs: 1000, webhookTargets: [{ kind: 'url', url: `http://${LAN}:${HPORT}/hook` }], allowPrivateTargets: true,
    } as any);

    // 20 senders: this process shares Bun's outbound sockets (and the ephemeral port range) with the connector.
    let next = 0;
    await Promise.all(Array.from({ length: 20 }, async () => {
        while (next < SESSIONS) {
            const i = next++;
            const r = await fetch(`http://127.0.0.1:${CPORT}/`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chatId: '2449' + String(i).padStart(8, '0'), text: 'c' + i }),
            });
            expect(r.status).toBe(200);
        }
    }));

    Date.now = () => realNow() - 60_000; // NTP steps the wall clock back a minute
    const t0 = performance.now();
    while (got.size < SESSIONS && performance.now() - t0 < 10_000) await Bun.sleep(100);

    expect(got.size).toBe(SESSIONS);
    expect([...got.values()].every(n => n === 1)).toBe(true);
}, 30_000);
