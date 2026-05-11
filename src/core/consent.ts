// Limited markdown → HTML renderer for consent screens.
// Supports: paragraphs, line breaks, **bold**, *italic*, [text](url), - lists.
// Everything else is escaped. Output is safe to inject into HTML.

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderInline(s: string): string {
    let out = escapeHtml(s);
    // Links: [text](https://… or http://…) — only http(s) allowed
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) => {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
    // Bold then italic (bold first so ** is consumed before *)
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    return out;
}

export function renderConsentMarkdown(input: string): string {
    if (!input) return '';
    const lines = input.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let para: string[] = [];
    let list: string[] = [];

    const flushPara = () => {
        if (para.length) {
            out.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
            para = [];
        }
    };
    const flushList = () => {
        if (list.length) {
            out.push(`<ul>${list.map(li => `<li>${renderInline(li)}</li>`).join('')}</ul>`);
            list = [];
        }
    };

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) { flushPara(); flushList(); continue; }
        const liMatch = line.match(/^[-*]\s+(.+)/);
        if (liMatch) { flushPara(); list.push(liMatch[1]); continue; }
        flushList();
        para.push(line);
    }
    flushPara();
    flushList();
    return out.join('');
}

export function escapeHtmlAttr(s: string): string {
    return escapeHtml(s);
}
