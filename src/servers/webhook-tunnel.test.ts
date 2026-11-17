import { expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Other test files may have loaded these modules already (same process): set up through their API, not files.
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'mm-wtun-'));
const tunnels = await import('../core/tunnels');
const ws = await import('./webhook-server');
tunnels.saveTunnel({ name: 'erp', agent: 'a1', host: 'erp.internal', port: 8080, listenPort: 47950, maxConnections: 5 });
tunnels.saveTunnel({ name: 'off', agent: 'a1', host: 'x', port: 80, listenPort: 47951, maxConnections: 5, enabled: false });

const dlqOf = (name: string) => ws.getDeadLetterQueue().filter(e => e.webhookName === name);

test('a tunnel destination is delivered to the tunnel itself (loopback allowed only for our tunnels)', async () => {
    ws.startWebhookServer({ name: 'to-erp', port: 47952, retry: { maxRetries: 0 },
        targets: [{ url: '/api/pay/{{id}}', tunnel: 'erp' }, { url: '/x', tunnel: 'off' }, { url: '/y', tunnel: 'ghost' }] } as any);
    const r = await fetch('http://127.0.0.1:47952/', { method: 'POST', body: '{"id":"A 1"}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(202);
    await Bun.sleep(1500);
    // reached the tunnel listener (not blocked by the SSRF guard): it refused because the agent is offline
    const t = tunnels.listTunnels().find((x: any) => x.name === 'erp')!;
    expect(t.rejected).toBe(1);
    expect(t.lastRejected?.why).toBe('agent offline');
    const errs = dlqOf('to-erp').map(e => e.targetUrl + ' :: ' + e.lastError);
    expect(errs.some(e => e.startsWith('http://127.0.0.1:47950/api/pay/A%201 ::'))).toBe(true);
    expect(errs.some(e => e.endsWith('tunnel "off" is disabled'))).toBe(true);
    expect(errs.some(e => e.endsWith('tunnel "ghost" does not exist'))).toBe(true);
    await ws.stopWebhookServer('to-erp', false);
});

test('loopback stays blocked for any port that is not one of our tunnels', async () => {
    ws.startWebhookServer({ name: 'sneaky', port: 47954, retry: { maxRetries: 0 }, targets: ['http://127.0.0.1:47999/'] } as any);
    await fetch('http://127.0.0.1:47954/', { method: 'POST', body: '{}' });
    await Bun.sleep(800);
    expect(dlqOf('sneaky')[0]?.lastError).toContain('blocked address 127.0.0.1');
    await ws.stopWebhookServer('sneaky', false);
});
