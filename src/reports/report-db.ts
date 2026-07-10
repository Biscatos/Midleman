/**
 * SQLite persistence for report feed data.
 *
 * Each feed's last successful fetch is stored as JSON so data survives
 * server restarts and consumers never trigger a GoContact fetch.
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { ReportCacheEntry } from './types';

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
let _db: Database | null = null;

function db(): Database {
    if (_db) return _db;
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    _db = new Database(resolve(DATA_DIR, 'report-cache.db'), { create: true });
    _db.run(`
        CREATE TABLE IF NOT EXISTS report_cache (
            feed_name    TEXT    PRIMARY KEY,
            rows_json    TEXT    NOT NULL,
            raw_rows_json TEXT   NOT NULL,
            fetched_at   INTEGER NOT NULL,
            row_count    INTEGER NOT NULL
        )
    `);
    return _db;
}

export function loadFeedFromDb(name: string): ReportCacheEntry | null {
    try {
        const row = db().query<{
            rows_json: string;
            raw_rows_json: string;
            fetched_at: number;
            row_count: number;
        }, [string]>('SELECT rows_json, raw_rows_json, fetched_at, row_count FROM report_cache WHERE feed_name = ?')
            .get(name);
        if (!row) return null;
        return {
            rows:     JSON.parse(row.rows_json),
            rawRows:  JSON.parse(row.raw_rows_json),
            fetchedAt: row.fetched_at,
            rowCount:  row.row_count,
        };
    } catch {
        return null;
    }
}

export function saveFeedToDb(name: string, entry: ReportCacheEntry): void {
    try {
        db().run(
            `INSERT INTO report_cache (feed_name, rows_json, raw_rows_json, fetched_at, row_count)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(feed_name) DO UPDATE SET
               rows_json     = excluded.rows_json,
               raw_rows_json = excluded.raw_rows_json,
               fetched_at    = excluded.fetched_at,
               row_count     = excluded.row_count`,
            [name, JSON.stringify(entry.rows), JSON.stringify(entry.rawRows), entry.fetchedAt, entry.rowCount],
        );
    } catch (err) {
        console.error(`[reports-db] failed to save "${name}":`, err instanceof Error ? err.message : err);
    }
}

export function deleteFeedFromDb(name: string): void {
    try {
        db().run('DELETE FROM report_cache WHERE feed_name = ?', [name]);
    } catch {}
}

export function getAllFeedsFromDb(): Array<{ name: string; fetchedAt: number; rowCount: number }> {
    try {
        return db().query<{ feed_name: string; fetched_at: number; row_count: number }, []>(
            'SELECT feed_name, fetched_at, row_count FROM report_cache ORDER BY fetched_at DESC',
        ).all().map(r => ({ name: r.feed_name, fetchedAt: r.fetched_at, rowCount: r.row_count }));
    } catch {
        return [];
    }
}
