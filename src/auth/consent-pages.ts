// Reusable consent pages: a library of (name, title, body) entries that
// OAuth clients and proxy profiles can reference instead of carrying inline
// markdown. The same page can be referenced from both contexts.
//
// Storage: SQLite (auth DB). Profiles live in JSON store, so the FK is
// "weak" — references are integer ids without DB-enforced constraints.
// Delete is blocked manually by checking references in both stores.

import { getAuthDb } from './auth';

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS consent_pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initConsentPages(): void {
    const db = getAuthDb();
    if (!db) return;
    db.exec(CREATE_TABLE);
}

export interface ConsentPage {
    id: number;
    name: string;
    title: string;
    body: string;
    createdAt: string;
    updatedAt: string;
}

function rowToConsentPage(r: any): ConsentPage {
    return {
        id: r.id,
        name: r.name,
        title: r.title || '',
        body: r.body || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

export function listConsentPages(): ConsentPage[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare('SELECT * FROM consent_pages ORDER BY name COLLATE NOCASE').all() as any[];
    return rows.map(rowToConsentPage);
}

export function getConsentPage(id: number): ConsentPage | null {
    const db = getAuthDb();
    if (!db || !id) return null;
    const row = db.prepare('SELECT * FROM consent_pages WHERE id = $id').get({ $id: id }) as any;
    return row ? rowToConsentPage(row) : null;
}

export function createConsentPage(input: { name: string; title: string; body: string }): ConsentPage {
    const db = getAuthDb();
    if (!db) throw new Error('Auth not initialized');
    const name = input.name.trim();
    const title = (input.title || '').trim();
    const body = input.body || '';
    if (!name) throw new Error('Name is required');
    if (name.length > 80) throw new Error('Name too long (max 80)');
    if (title.length > 200) throw new Error('Title too long (max 200)');
    if (body.length > 20_000) throw new Error('Body too long (max 20000)');
    try {
        db.prepare('INSERT INTO consent_pages (name, title, body) VALUES ($n, $t, $b)')
            .run({ $n: name, $t: title, $b: body });
    } catch (err: any) {
        if (String(err?.message || '').includes('UNIQUE')) throw new Error('A page with this name already exists');
        throw err;
    }
    const row = db.prepare('SELECT * FROM consent_pages WHERE name = $n').get({ $n: name }) as any;
    return rowToConsentPage(row);
}

export function updateConsentPage(id: number, input: { name?: string; title?: string; body?: string }): ConsentPage | null {
    const db = getAuthDb();
    if (!db) return null;
    const existing = db.prepare('SELECT * FROM consent_pages WHERE id = $id').get({ $id: id }) as any;
    if (!existing) return null;

    const sets: string[] = [];
    const params: Record<string, unknown> = { $id: id };
    if (input.name !== undefined) {
        const n = input.name.trim();
        if (!n) throw new Error('Name cannot be empty');
        if (n.length > 80) throw new Error('Name too long (max 80)');
        if (n !== existing.name) { sets.push('name = $n'); params.$n = n; }
    }
    if (input.title !== undefined) {
        const t = input.title.trim();
        if (t.length > 200) throw new Error('Title too long (max 200)');
        if (t !== (existing.title || '')) { sets.push('title = $t'); params.$t = t; }
    }
    if (input.body !== undefined) {
        const b = input.body;
        if (b.length > 20_000) throw new Error('Body too long (max 20000)');
        if (b !== (existing.body || '')) { sets.push('body = $b'); params.$b = b; }
    }
    if (sets.length === 0) return rowToConsentPage(existing);

    sets.push("updated_at = datetime('now')");
    try {
        db.prepare(`UPDATE consent_pages SET ${sets.join(', ')} WHERE id = $id`).run(params);
    } catch (err: any) {
        if (String(err?.message || '').includes('UNIQUE')) throw new Error('A page with this name already exists');
        throw err;
    }
    const row = db.prepare('SELECT * FROM consent_pages WHERE id = $id').get({ $id: id }) as any;
    return row ? rowToConsentPage(row) : null;
}

export interface ConsentPageReference {
    kind: 'oauth_client' | 'proxy_profile';
    id: string;
    name: string;
}

/** Returns references to this page that would prevent deletion. The proxy_profile
 *  references must be supplied by the caller (profiles live in a JSON store and
 *  aren't reachable from here). */
export function findConsentPageOauthReferences(pageId: number): ConsentPageReference[] {
    const db = getAuthDb();
    if (!db) return [];
    const rows = db.prepare('SELECT client_id, name FROM oauth_clients WHERE consent_page_id = $id').all({ $id: pageId }) as any[];
    return rows.map(r => ({ kind: 'oauth_client' as const, id: r.client_id, name: r.name }));
}

export function deleteConsentPage(id: number): boolean {
    const db = getAuthDb();
    if (!db) return false;
    const result = db.prepare('DELETE FROM consent_pages WHERE id = $id').run({ $id: id });
    return result.changes > 0;
}
