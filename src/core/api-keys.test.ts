import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// DATA_DIR is read at import time: point it at a temp dir so ./data is never touched.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mm-apikeys-'));
const k = await import('./api-keys');

test('a shared key opens only the resources assigned to it', () => {
    const a = k.createApiKey({ name: 'Partner A', scopes: ['proxy:crm', 'webhook:orders'] });
    const b = k.createApiKey({ name: 'Partner B', scopes: ['proxy:crm'] });
    expect(a.key).not.toBe(b.key);
    expect(JSON.stringify(k.listApiKeys())).not.toContain(a.key);

    expect(k.apiKeyAllows(a.key, 'proxy', 'crm')).toBe(true);
    expect(k.apiKeyAllows(b.key, 'proxy', 'crm')).toBe(true);   // a second key does not replace the first
    expect(k.apiKeyAllows(a.key, 'webhook', 'orders')).toBe(true);
    expect(k.apiKeyAllows(b.key, 'webhook', 'orders')).toBe(false);
    expect(k.apiKeyAllows(a.key, 'webhook', 'crm')).toBe(false); // kind is part of the scope
    expect(k.apiKeyAllows('mmk_wrong', 'proxy', 'crm')).toBe(false);
    expect(k.apiKeyAllows(null, 'proxy', 'crm')).toBe(false);
    expect(k.apiKeyCovers('webhook', 'orders')).toBe(true);
    expect(k.apiKeyCovers('webhook', 'other')).toBe(false);

    k.updateApiKey(b.record.id, { scopes: ['webhook:orders'] });
    expect(k.apiKeyAllows(b.key, 'webhook', 'orders')).toBe(true);
    expect(k.apiKeyAllows(b.key, 'proxy', 'crm')).toBe(false);

    expect(k.revokeApiKey(a.record.id)).toBe(true);
    expect(k.apiKeyAllows(a.key, 'proxy', 'crm')).toBe(false);
    expect(k.apiKeyAllows(b.key, 'webhook', 'orders')).toBe(true); // revoking one leaves the other
});

test('parseScopes rejects malformed entries', () => {
    expect(k.parseScopes(['proxy:a', 'proxy:a', 'webhook:b'])).toEqual(['proxy:a', 'webhook:b']);
    expect(k.parseScopes(['webhook:taag sms to whatsapp'])).toEqual(['webhook:taag sms to whatsapp']); // names may contain spaces
    expect(k.parseScopes(['tcp:a'])).toBeNull();
    expect(k.parseScopes(['proxy:'])).toBeNull();
    expect(k.parseScopes('proxy:a')).toBeNull();
});
