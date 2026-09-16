// In-memory ring buffer of this process's own console output, so the admin
// dashboard can show server logs without needing SSH/pm2/journalctl access -
// exactly what's needed to diagnose something like "what did addon-server.js
// actually do the moment autoplay tried to load the next episode", without
// asking the user to go find and paste raw terminal/process-manager output.
//
// Works by wrapping console.log/warn/error once at process startup (see
// install() below) - every existing console.log/error call across this
// codebase (providers, lib/*, the server files themselves) still prints to
// the real console exactly as before, and is ALSO captured here, with no
// changes needed at any of those call sites.

const MAX_LINES = 2000;
// Belt-and-suspenders alongside MAX_LINES: that cap already bounds memory
// use by line COUNT, but a busy day (heavy provider chatter) could still
// fill it with same-day noise well before 2000 lines actually means "old" -
// clearing once a day keeps the panel meaningfully scoped to "recent"
// regardless of volume, by request.
const AUTO_CLEAR_INTERVAL_MS = 24 * 60 * 60 * 1000;
const buffer = [];

function formatArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
        return JSON.stringify(arg);
    } catch (e) {
        return String(arg);
    }
}

function push(level, args) {
    buffer.push({
        time: new Date().toISOString(),
        level,
        text: args.map(formatArg).join(' ')
    });
    if (buffer.length > MAX_LINES) buffer.shift();
}

// Clears every captured line. Used by both the admin dashboard's manual
// "Clear logs" button and the once-a-day automatic timer below - pushes one
// line noting the clear happened (and why), so the panel never just goes
// silently blank with no explanation for whoever's looking at it next.
function clear(reason) {
    buffer.length = 0;
    push('log', [`[logBuffer] Cleared (${reason || 'manual'})`]);
}

let installed = false;

// Idempotent - safe to call more than once (a module required from two
// places shouldn't double-wrap console methods or start a second timer).
function install() {
    if (installed) return;
    installed = true;
    const original = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
    console.log = (...args) => { push('log', args); original.log(...args); };
    console.warn = (...args) => { push('warn', args); original.warn(...args); };
    console.error = (...args) => { push('error', args); original.error(...args); };

    const timer = setInterval(() => clear('automatic daily reset'), AUTO_CLEAR_INTERVAL_MS);
    // Doesn't count against a clean process exit all on its own - this is a
    // background-housekeeping timer, not something that should keep the
    // process alive by itself.
    if (typeof timer.unref === 'function') timer.unref();
}

function getLines(limit) {
    const lines = limit ? buffer.slice(-limit) : buffer.slice();
    return lines;
}

module.exports = { install, getLines, clear, MAX_LINES };
