/**
 * Minimal RFC-4180-compliant CSV parser.
 * Handles quoted fields, embedded commas, embedded newlines, and CRLF/LF.
 * Returns an array of objects keyed by the header row.
 *
 * GoContact exports may use semicolons instead of commas — the delimiter is
 * auto-detected from the first line.
 */
export function parseCsv(raw: string): Record<string, string>[] {
    if (!raw.trim()) return [];

    const delim = detectDelimiter(raw);
    const lines = splitLines(raw);
    if (lines.length < 2) return [];

    const headers = parseRow(lines[0], delim).map(h => h.trim());
    const rows: Record<string, string>[] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const cells = parseRow(line, delim);
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = cells[j] ?? '';
        }
        rows.push(row);
    }

    return rows;
}

function detectDelimiter(raw: string): string {
    const firstLine = raw.split(/\r?\n/)[0];
    const commas = (firstLine.match(/,/g) ?? []).length;
    const semis = (firstLine.match(/;/g) ?? []).length;
    const tabs = (firstLine.match(/\t/g) ?? []).length;
    if (semis >= commas && semis >= tabs) return ';';
    if (tabs > commas) return '\t';
    return ',';
}

function splitLines(raw: string): string[] {
    const lines: string[] = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '"') {
            if (inQuote && raw[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuote = !inQuote;
                current += ch;
            }
        } else if ((ch === '\n' || (ch === '\r' && raw[i + 1] === '\n')) && !inQuote) {
            if (ch === '\r') i++;
            lines.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function parseRow(line: string, delim: string): string[] {
    const cells: string[] = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuote && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuote = !inQuote;
            }
        } else if (ch === delim && !inQuote) {
            cells.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    cells.push(current);
    return cells;
}
