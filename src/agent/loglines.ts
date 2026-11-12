// Which container log lines the agent reports, and at what level.
// Errors alert; warnings are only kept and shown, because apps log routine noise at that level.

const NET_HEADER = /^(warn|fail|crit|info|dbug|trce): \S/;   // .NET console logger: level and category here, the message indented on the next line
const STACK = /^\s*(at |--- End of )/;                       // stack frames repeat the exception line already captured
const WARN = /\bWARN(ING)?\b/i;

/** msgs = log lines without the Docker timestamp. Returns the lines worth reporting; `i` is the index of the line it started on. */
export function pickLogLines(msgs: string[], pattern: RegExp, ignore: RegExp | null): { i: number; line: string; warn: boolean }[] {
    const out: { i: number; line: string; warn: boolean }[] = [];
    for (let i = 0; i < msgs.length; i++) {
        let msg = msgs[i];
        const at = i;
        if (STACK.test(msg)) continue;
        const level = NET_HEADER.exec(msg)?.[1];
        // join the header with its message, otherwise the capture is just "warn: Category[0]"
        if (level && i + 1 < msgs.length && /^\s+\S/.test(msgs[i + 1]) && !STACK.test(msgs[i + 1])) msg += ' ' + msgs[++i].trim();
        if (ignore?.test(msg)) continue;
        const error = level === 'fail' || level === 'crit' || pattern.test(msg);
        if (error || level === 'warn' || (!level && WARN.test(msg))) out.push({ i: at, line: msg, warn: !error });
    }
    return out;
}
