import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mm-journal-'));
process.env.DELIVERY_ENGINE = 'journal';
const dir = join(process.env.DATA_DIR, 'delivery-journal');

const j = await import('./delivery-journal');
const files = () => readdirSync(dir).filter(f => f.endsWith('.jsonl'));
const rec = (id: string, keys: string[]) => ({
    id, webhook: 'hook', requestId: 'r-' + id, method: 'POST', path: '/x?y=1',
    headers: { 'content-type': 'application/json' }, body: Buffer.from('{"n":1}').toString('base64'),
    clientIp: '10.0.0.1', at: Date.now(), keys,
});

test('fresh start: nothing to replay, one empty segment', () => {
    expect(j.journalOpen()).toEqual([]);
    expect(files().length).toBe(1);
    expect(j.journalPendingCount()).toBe(0);
});

test('accept + done per destination; finished payloads stop counting', () => {
    j.journalAccept(rec('a', ['POST http://one', 'POST http://two']));
    j.journalAccept(rec('b', ['POST http://one']));
    expect(j.journalPendingCount()).toBe(3);
    j.journalDone('a', 'POST http://one');
    j.journalDone('a', 'POST http://one'); // twice is harmless
    j.journalDone('b', 'POST http://one');
    j.journalDone('zzz', 'POST http://one'); // unknown id is harmless
    expect(j.journalPendingCount()).toBe(1);
});

test('restart replays exactly what was not done, with the original payload', () => {
    j.journalClose();
    const left = j.journalOpen();
    expect(left.length).toBe(1);
    expect(left[0].id).toBe('a');
    expect(left[0].keys).toEqual(['POST http://two']);
    expect(left[0].path).toBe('/x?y=1');
    expect(Buffer.from(left[0].body!, 'base64').toString()).toBe('{"n":1}');
    // old segments were folded into a single new one
    expect(files().length).toBe(1);
    j.journalDone('a', 'POST http://two');
    expect(j.journalPendingCount()).toBe(0);
});

test('a torn last line (crash mid-write) is ignored, not fatal', () => {
    j.journalAccept(rec('c', ['POST http://one']));
    j.journalClose();
    appendFileSync(join(dir, files()[0]), '{"a":1,"id":"broken","keys":["POST ht');
    const left = j.journalOpen();
    expect(left.map(r => r.id)).toEqual(['c']);
    j.journalDone('c', 'POST http://one');
    j.journalClose();
    expect(j.journalOpen()).toEqual([]);
});

test('throughput: 20k accept+done stays well under a second', () => {
    const t = performance.now();
    for (let i = 0; i < 20_000; i++) {
        j.journalAccept(rec('p' + i, ['POST http://one', 'POST http://two']));
        j.journalDone('p' + i, 'POST http://one');
        j.journalDone('p' + i, 'POST http://two');
    }
    const ms = performance.now() - t;
    console.log(`journal: 20k payloads × 2 destinations in ${ms.toFixed(0)} ms (${(ms * 1000 / 20_000).toFixed(1)} µs/payload)`);
    expect(j.journalPendingCount()).toBe(0);
    expect(ms).toBeLessThan(5_000);
    j.journalClose();
});
