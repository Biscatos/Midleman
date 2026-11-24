import { expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// tunnels.ts reads DATA_DIR when it is first imported, and every test file shares that one copy.
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'mm-tunhost-'));
const { tunnelHostRouting } = await import('./tunnel-host');
const { DNS_NAME_RE } = await import('../core/tunnels');

test('the NPM host forwards the internal name to the tunnel port, https only when the service speaks TLS', () => {
    expect(tunnelHostRouting({ hostname: 'rabbit.apps.ucall.local', listenPort: 4011, port: 15672 }, '10.11.1.200'))
        .toEqual({ domain_names: ['rabbit.apps.ucall.local'], forward_host: '10.11.1.200', forward_port: 4011, forward_scheme: 'http' });
    expect(tunnelHostRouting({ hostname: 'erp.apps.ucall.local', listenPort: 4012, port: 8443 }, 'midleman').forward_scheme).toBe('https');
});

test('an internal name is a full lower-case DNS name', () => {
    for (const ok of ['rabbit.apps.ucall.local', 'a-b.example.co.ao', 'x1.lan']) expect(DNS_NAME_RE.test(ok)).toBe(true);
    for (const bad of ['rabbit', 'Rabbit.apps.local', 'http://x.local', 'a..b.local', '-a.local', 'x.local/path', 'x.local:80', '*.apps.local', '']) expect(DNS_NAME_RE.test(bad)).toBe(false);
});
