import { expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mm-guards-'));
const ws = await import('./webhook-server');
const { isLoopbackIp } = await import('../core/ip-filter');
import { networkInterfaces } from 'os';
// The SSRF guard always refuses loopback destinations, so deliveries in these tests go to this machine's LAN address.
const LAN = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)!.address;

test('loopback callers are recognised (Midleman calling itself)', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('10.11.1.104')).toBe(false);
    expect(isLoopbackIp('')).toBe(false);
});

test('a destination pointing at the webhook itself is detected at save time', () => {
    const base = { name: 'self', port: 4555, targets: [] as any[], publicHostnames: ['hooks.example.com'] } as any;
    expect(ws.findSelfTarget({ ...base, targets: ['http://127.0.0.1:4555/x'] })).toBe('http://127.0.0.1:4555/x');
    expect(ws.findSelfTarget({ ...base, targets: [{ url: 'http://localhost:4555/{{id}}' }] })).toBe('http://localhost:4555/{{id}}');
    expect(ws.findSelfTarget({ ...base, targets: [{ url: 'https://hooks.example.com/in' }] })).toBe('https://hooks.example.com/in');
    expect(ws.findSelfTarget({ ...base, targets: ['http://127.0.0.1:4556/other-webhook'] })).toBe(null);
    expect(ws.findSelfTarget({ ...base, targets: ['https://crm.example.com/api'] })).toBe(null);
});

test('at runtime a payload never loops: A → A is refused after one pass', async () => {
    let hits = 0;
    const rx = Bun.serve({ port: 47901, hostname: '0.0.0.0', fetch() { hits++; return new Response('ok'); } });
    // Saved configs can't do this (findSelfTarget), but an old config or a public URL might.
    ws.startWebhookServer({ name: 'loop-a', port: 47900, allowPrivateTargets: true, retry: { maxRetries: 0 },
        targets: [`http://${LAN}:47900/`, `http://${LAN}:47901/`] } as any);
    const r = await fetch('http://127.0.0.1:47900/', { method: 'POST', body: '{"n":1}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(202);
    await Bun.sleep(800);
    expect(hits).toBe(1); // without the guard the self copy fans out again and again — here it is answered 508 once
    await ws.stopWebhookServer('loop-a', false);
    rx.stop(true);
});

test('IP allowlist does not block Midleman itself on loopback', async () => {
    const rx = Bun.serve({ port: 47903, fetch() { return new Response('ok'); } });
    ws.startWebhookServer({ name: 'locked', port: 47902, allowedIps: ['203.0.113.7'], allowPrivateTargets: true,
        targets: ['http://127.0.0.1:47903/'] } as any);
    const r = await fetch('http://127.0.0.1:47902/', { method: 'POST', body: '{}' });
    expect(r.status).toBe(202);
    await ws.stopWebhookServer('locked', false);
    rx.stop(true);
});

test('a method the webhook does not accept is answered 200 "ignored" and never delivered', async () => {
    let hits = 0;
    const rx = Bun.serve({ port: 47905, hostname: '0.0.0.0', fetch() { hits++; return new Response('ok'); } });
    ws.startWebhookServer({ name: 'post-only', port: 47904, allowedMethods: ['POST'], allowPrivateTargets: true,
        targets: [`http://${LAN}:47905/`] } as any);
    const g = await fetch('http://127.0.0.1:47904/SDK/webLanguage');
    expect(g.status).toBe(200);
    expect(((await g.json()) as any).status).toBe('Ignored');
    const p = await fetch('http://127.0.0.1:47904/', { method: 'POST', body: '{}' });
    expect(p.status).toBe(202);
    await Bun.sleep(500);
    expect(hits).toBe(1);
    await ws.stopWebhookServer('post-only', false);
    rx.stop(true);
});

test('allowedMethods and the Meta settings survive a save + reload', async () => {
    const store = await import('../core/store');
    store.persistWebhooks([{ name: 'm', port: 1, targets: [], allowedMethods: ['POST'], meta: { enabled: true, appSecret: 's' } } as any]);
    const w = store.loadPersistedWebhooks().find(x => x.name === 'm')!;
    expect(w.allowedMethods).toEqual(['POST']);
    expect(w.meta).toEqual({ enabled: true, appSecret: 's' });
});

test('saving a webhook applies the new destinations live — same socket, no restart', async () => {
    const hits: string[] = [];
    const rx = Bun.serve({ port: 47907, hostname: '0.0.0.0', fetch(req) { hits.push(new URL(req.url).pathname); return new Response('ok'); } });
    const base = { name: 'live', port: 47906, allowPrivateTargets: true } as any;
    const server = ws.startWebhookServer({ ...base, targets: [`http://${LAN}:47907/old`] }).server;
    expect(ws.updateWebhookConfig({ ...base, targets: [`http://${LAN}:47907/new`] })).toBe(true);
    expect(ws.getWebhookServers().get('live')!.server).toBe(server); // the listener was not replaced
    await fetch('http://127.0.0.1:47906/', { method: 'POST', body: '{}' });
    await Bun.sleep(500);
    expect(hits).toEqual(['/new']);
    expect(ws.updateWebhookConfig({ ...base, port: 47999, targets: [] })).toBe(false); // a port change still needs a restart
    await ws.stopWebhookServer('live', false);
    rx.stop(true);
});
