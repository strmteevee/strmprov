// Memory settings for a long-running server process on a small Linux box
// (the Pi), applied by the process itself so they hold however it is started
// (systemd with or without deploy-pi.sh's drop-in, pm2, by hand).
//
// Measured on the Pi (2026-11-14): the addon's JavaScript heap stayed at
// ~50MB while the process held ~280MB. The rest is native memory - TLS
// connections and buffers from ~27 providers fetching at once - which glibc
// keeps in a pool per thread and seldom gives back. Limiting it to two pools
// and handing large freed blocks back to the system is what these do:
//   MALLOC_ARENA_MAX=2             two malloc pools instead of 8 per CPU core
//   MALLOC_TRIM_THRESHOLD_=131072  give freed memory at the top back sooner
//   --max-semi-space-size=2        a small young generation (default 16MB)
//   --max-old-space-size=256       collect well before the multi-GB default
//
// glibc only reads its settings when a process starts, so a process started
// without them replaces itself once (process.execve: same PID, so systemd or
// pm2 notice nothing) with them set. Where that's unavailable (Node before
// 22.15, or not Linux) it just runs as it is.

const MALLOC_ENV = { MALLOC_ARENA_MAX: '2', MALLOC_TRIM_THRESHOLD_: '131072' };
const NODE_FLAGS = ['--max-semi-space-size=2', '--max-old-space-size=256'];
const MARKER = 'STRMPROV_MEMORY_TUNED';

function hasFlag(list, flag) {
    const name = flag.split('=')[0];
    return list.some((f) => f.split('=')[0] === name);
}

function apply() {
    if (process.platform !== 'linux' || process.env[MARKER] || typeof process.execve !== 'function') return;
    const env = Object.assign({}, process.env, { [MARKER]: '1' });
    let changed = false;
    for (const [key, value] of Object.entries(MALLOC_ENV)) {
        if (!env[key]) { env[key] = value; changed = true; }
    }
    const nodeOptions = (env.NODE_OPTIONS || '').split(/\s+/).filter(Boolean);
    const present = nodeOptions.concat(process.execArgv);
    const missing = NODE_FLAGS.filter((f) => !hasFlag(present, f));
    if (!missing.length && !changed) return;
    try {
        process.execve(process.execPath, [process.execPath, ...missing, ...process.execArgv, ...process.argv.slice(1)], env);
    } catch (e) {
        // Runs on untuned rather than not at all.
        process.stderr.write(`[memoryTuning] Could not restart with memory settings: ${e.message}\n`);
    }
}

// One line for the log: whether the settings are in effect.
function describe() {
    const v8 = require('v8');
    const limit = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
    const malloc = Object.keys(MALLOC_ENV).map((k) => `${k}=${process.env[k] || 'unset'}`).join(' ');
    return `Node ${process.version}, heap limit ${limit} MB, ${malloc}`;
}

module.exports = { apply, describe };
