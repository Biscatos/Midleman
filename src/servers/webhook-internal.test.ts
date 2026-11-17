import { expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'mm-wint-'));
const ws = await import('./webhook-server');

// A stand-in for one of our proxies on 127.0.0.1 (fails the first call, then accepts).
const seen: { path: string; key: string | null }[] = [];
let fail = true;
const svc = Bun.serve({ port: 47960, hostname: '127.0.0.1', fetch(req) {
    seen.push({ path: new URL(req.url).pathname, key: req.headers.get('x-mid-api-key') });
    if (fail) { fail = false; return new Response('down', { status: 503 }); }
    return new Response('ok');
} });
ws.setInternalServices({
    resolve: (kind, name) => kind === 'proxy' && name === 'erp-proxy' ? { port: 47960 } : { error: `${kind} "${name}" does not exist` },
    authFor: (port): Record<string, string> => port === 47960 ? { 'x-mid-api-key': 'k-secret' } : {},
    isServicePort: port => port === 47960,
});

test('proxy destination: path + access key at send time, key never stored in the retry queue', async () => {
    ws.startWebhookServer({ name: 'to-proxy', port: 47961, targets: [
        { url: '/orders/{{id}}', proxy: 'erp-proxy', persistentRetry: { enabled: true, maxAttemptsPerMinute: 30 } },
        { url: '/x', connector: 'nope', retry: { maxRetries: 0 } },
    ] } as any);
    ws.startPendingRetryScheduler();
    await fetch('http://127.0.0.1:47961/', { method: 'POST', body: '{"id":7}', headers: { 'content-type': 'application/json' } });
    await Bun.sleep(400);
    const queued = ws.getPendingRetryQueue().find(e => e.webhookName === 'to-proxy');
    expect(queued).toBeDefined();
    expect(JSON.stringify(queued!.headers).includes('k-secret')).toBe(false);
    await Bun.sleep(3500); // the scheduler retries (every 2 s at 30/min)
    expect(seen.map(s => s.path)).toEqual(['/orders/7', '/orders/7']);
    expect(seen.every(s => s.key === 'k-secret')).toBe(true);
    expect(ws.getDeadLetterQueue().find(e => e.webhookName === 'to-proxy' && e.lastError.includes('connector "nope" does not exist'))).toBeDefined();
    ws.stopPendingRetryScheduler();
    await ws.stopWebhookServer('to-proxy', false);
    svc.stop(true);
});
