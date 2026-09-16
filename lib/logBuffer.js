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

let installed = false;

// Idempotent - safe to call more than once (a module required from two
// places shouldn't double-wrap console methods).
function install() {
    if (installed) return;
    installed = true;
    const original = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
    console.log = (...args) => { push('log', args); original.log(...args); };
    console.warn = (...args) => { push('warn', args); original.warn(...args); };
    console.error = (...args) => { push('error', args); original.error(...args); };
}

function getLines(limit) {
    const lines = limit ? buffer.slice(-limit) : buffer.slice();
    return lines;
}

module.exports = { install, getLines, MAX_LINES };
