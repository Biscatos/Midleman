import { expect, test } from 'bun:test';
import { auditChanges, auditSnapshot } from './audit-diff';

test('only changed fields are reported, with old and new value', () => {
    const before = { name: 'p', targetUrl: 'http://a', rateLimit: { requestsPerMinute: 60 }, allowedIps: ['1.1.1.1'] };
    const after = { name: 'p', targetUrl: 'http://b', allowedIps: ['1.1.1.1'], cors: { enabled: true } };
    expect(auditChanges(before, after)).toEqual({
        targetUrl: { from: 'http://a', to: 'http://b' },
        rateLimit: { from: { requestsPerMinute: 60 }, to: null },
        cors: { from: null, to: { enabled: true } },
    });
    expect(auditChanges(before, { ...before })).toBeUndefined();
});

test('secrets never reach the log, but a rotated secret is noticed', () => {
    const c = auditChanges(
        { apiKey: 'old-key', gocontact: { username: 'u', password: 'p1' }, hasAuthToken: true },
        { apiKey: 'new-key', gocontact: { username: 'u', password: 'p2' }, hasAuthToken: true },
    )!;
    expect(JSON.stringify(c)).not.toMatch(/old-key|new-key|p1|p2/);
    expect(c.apiKey).toEqual({ from: '(secret)', to: '(secret changed)' });
    expect(c.gocontact).toEqual({ from: '(secret)', to: '(secret changed)' });
    expect(c.hasAuthToken).toBeUndefined();
});

test('snapshot masks nested secrets, keeps flags, converts Sets', () => {
    expect(auditSnapshot({ a: { accessToken: 'x', hasAccessToken: true }, ext: new Set(['.b', '.a']), empty: '' }))
        .toEqual({ a: { accessToken: '(secret)', hasAccessToken: true }, ext: ['.a', '.b'], empty: '' });
});

test('secrets inside URLs and header maps are masked', () => {
    expect(auditSnapshot({ targets: ['https://u:pw@h.example/x?access_token=abc&page=2'], customHeaders: { 'X-Api-Key': 'k', Accept: 'json' } }))
        .toEqual({ targets: ['https://u:(secret)@h.example/x?access_token=(secret)&page=2'], customHeaders: { 'X-Api-Key': '(secret)', Accept: 'json' } });
});
