// WireGuard tunnels for sources that only answer from another country (Pluto
// TV from the US). Each tunnel is a WireGuard config uploaded on the admin
// dashboard; wireproxy (a small program that speaks WireGuard on its own,
// installed by deploy-pi.sh) turns it into an HTTP proxy on 127.0.0.1, so a
// source sends just its own requests through it (lib/tunnelFetch.js) and the
// rest of this machine's traffic is untouched - no system VPN, no root.
//
// Files, in config/wireguard/ (git-ignored, readable by this user only):
//   <name>.conf   the uploaded config, cleaned up (see cleanConfig)
//   tunnels.json  { tunnels: { <name>: { port, label, uploadedAt } },
//                   uses: { <source id>: <tunnel name> } }
//   run/          wireproxy's own config per tunnel, written at start
//
// Only one process may run a tunnel (one WireGuard key, one connection), so
// only addon-server.js starts them (start()); the admin server writes the
// files and asks the addon for status over its local HTTP port.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const DIR = path.join(ROOT_DIR, 'config', 'wireguard');
const STATE_PATH = path.join(DIR, 'tunnels.json');
const RUN_DIR = path.join(DIR, 'run');
const FIRST_PORT = 25345;
const RESTART_DELAY_MS = 10000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

// The sources that can use a tunnel, for the dashboard: id -> name.
const SOURCES = { plutotv: 'Pluto TV' };

function readState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        return { tunnels: s.tunnels || {}, uses: s.uses || {} };
    } catch (e) {
        return { tunnels: {}, uses: {} };
    }
}

function writeState(state) {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function confPath(name) {
    return path.join(DIR, `${name}.conf`);
}

// A WireGuard config as uploaded (Proton's, or any wg-quick file) -> the same
// config with only what wireproxy needs and IPv4 only: inside the tunnel IPv6
// didn't route (2026-11-15: every request to a host with an IPv6 address hung
// until IPv6 was left out). Throws with a readable reason when it isn't one.
function cleanConfig(text) {
    const sections = [];
    let current = null;
    let label = null;
    String(text).split(/\r?\n/).forEach(raw => {
        const line = raw.trim();
        const header = line.match(/^\[(\w+)\]$/);
        if (header) { current = { name: header[1].toLowerCase(), keys: {} }; sections.push(current); return; }
        // Proton names the server in a comment under [Peer] ("# US-CA#1017").
        if (line.startsWith('#') && current && current.name === 'peer' && !label && /^#\s*[A-Z]{2}[\w-]*#\d+/.test(line)) label = line.replace(/^#\s*/, '');
        const kv = line.match(/^([A-Za-z]+)\s*=\s*(.+)$/);
        if (kv && current) current.keys[kv[1].toLowerCase()] = kv[2].trim();
    });
    const iface = sections.find(s => s.name === 'interface');
    const peer = sections.find(s => s.name === 'peer');
    if (!iface || !peer) throw new Error('This is not a WireGuard config: it needs an [Interface] and a [Peer] section');
    const ipv4 = (list) => (list || '').split(',').map(s => s.trim()).filter(s => /^\d{1,3}(\.\d{1,3}){3}(\/\d+)?$/.test(s));
    const address = ipv4(iface.keys.address);
    const dns = ipv4(iface.keys.dns);
    if (!iface.keys.privatekey) throw new Error('The config has no PrivateKey');
    if (!address.length) throw new Error('The config has no IPv4 Address');
    if (!peer.keys.publickey || !peer.keys.endpoint) throw new Error('The [Peer] needs a PublicKey and an Endpoint');
    const out = ['[Interface]', `PrivateKey = ${iface.keys.privatekey}`, `Address = ${address.join(', ')}`];
    if (dns.length) out.push(`DNS = ${dns.join(', ')}`);
    if (iface.keys.mtu) out.push(`MTU = ${iface.keys.mtu}`);
    out.push('', '[Peer]', `PublicKey = ${peer.keys.publickey}`);
    if (peer.keys.presharedkey) out.push(`PresharedKey = ${peer.keys.presharedkey}`);
    out.push(`Endpoint = ${peer.keys.endpoint}`, 'AllowedIPs = 0.0.0.0/0', `PersistentKeepalive = ${peer.keys.persistentkeepalive || 25}`);
    return { text: out.join('\n') + '\n', label: label || peer.keys.endpoint };
}

// ---- for the admin server: managing the files -------------------------------

function saveTunnel(name, uploadedText) {
    if (!NAME_PATTERN.test(name || '')) throw new Error('Name: lowercase letters, digits and dashes (e.g. "us")');
    const { text, label } = cleanConfig(uploadedText);
    const state = readState();
    const used = new Set(Object.values(state.tunnels).map(t => t.port));
    let port = state.tunnels[name] ? state.tunnels[name].port : FIRST_PORT;
    while (!state.tunnels[name] && used.has(port)) port++;
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(confPath(name), text, { mode: 0o600 });
    state.tunnels[name] = { port, label, uploadedAt: new Date().toISOString() };
    writeState(state);
    return state.tunnels[name];
}

function deleteTunnel(name) {
    const state = readState();
    if (!state.tunnels[name]) return false;
    delete state.tunnels[name];
    Object.keys(state.uses).forEach(source => { if (state.uses[source] === name) delete state.uses[source]; });
    writeState(state);
    try { fs.unlinkSync(confPath(name)); } catch (e) { /* already gone */ }
    return true;
}

function setUse(source, name) {
    if (!SOURCES[source]) throw new Error(`Unknown source ${source}`);
    const state = readState();
    if (name && !state.tunnels[name]) throw new Error(`No tunnel named ${name}`);
    if (name) state.uses[source] = name; else delete state.uses[source];
    writeState(state);
}

// ---- for the addon server: running the tunnels ------------------------------

function wireproxyBinary() {
    if (process.env.WIREPROXY_PATH) return process.env.WIREPROXY_PATH;
    const local = path.join(ROOT_DIR, 'bin', process.platform === 'win32' ? 'wireproxy.exe' : 'wireproxy');
    return fs.existsSync(local) ? local : 'wireproxy';
}

const running = new Map(); // name -> { child, port, stamp, startedAt, lastError, exits }

function stampOf(name) {
    try {
        const st = fs.statSync(confPath(name));
        return `${st.mtimeMs}:${st.size}`;
    } catch (e) {
        return null;
    }
}

function launch(name, tunnel) {
    handleSignals();
    fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
    const runConf = path.join(RUN_DIR, `${name}.wireproxy.conf`);
    fs.writeFileSync(runConf, `WGConfig = ${confPath(name)}\n\n[http]\nBindAddress = 127.0.0.1:${tunnel.port}\n`, { mode: 0o600 });
    const entry = { child: null, port: tunnel.port, stamp: stampOf(name), startedAt: Date.now(), lastError: null, exits: (running.get(name) || {}).exits || 0 };
    let child;
    try {
        child = spawn(wireproxyBinary(), ['-s', '-c', runConf], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
        entry.lastError = e.message;
        running.set(name, entry);
        return entry;
    }
    entry.child = child;
    child.stderr.on('data', d => { entry.lastError = String(d).trim().split('\n').pop().slice(0, 300); });
    child.on('error', e => { entry.lastError = e.code === 'ENOENT' ? 'wireproxy is not installed (deploy-pi.sh installs it)' : e.message; });
    child.on('exit', code => {
        if (running.get(name) !== entry) return; // replaced or stopped on purpose
        entry.child = null;
        entry.exits++;
        console.error(`[wireguard] Tunnel ${name} stopped (exit ${code})${entry.lastError ? `: ${entry.lastError}` : ''}; starting it again in ${RESTART_DELAY_MS / 1000}s`);
        setTimeout(() => { if (running.get(name) === entry) running.delete(name); }, RESTART_DELAY_MS).unref();
    });
    running.set(name, entry);
    console.log(`[wireguard] Tunnel ${name} started (${tunnel.label}) on 127.0.0.1:${tunnel.port}`);
    return entry;
}

function stop(name) {
    const entry = running.get(name);
    running.delete(name);
    if (entry && entry.child) entry.child.kill();
}

// Brings the running tunnels in line with the files: starts what's new or
// changed, stops what was deleted. Cheap, so it's called on every use.
function sync() {
    const state = readState();
    running.forEach((entry, name) => {
        const t = state.tunnels[name];
        if (!t || entry.port !== t.port || (entry.child && entry.stamp !== stampOf(name))) stop(name);
    });
    Object.entries(state.tunnels).forEach(([name, t]) => {
        if (!running.has(name) && stampOf(name)) launch(name, t);
    });
    return state;
}

// The proxy a source sends its requests through: { host, port, tunnel } or
// null when it has none assigned (or that one isn't running).
function proxyFor(source) {
    const state = sync();
    const name = state.uses[source];
    if (!name) return null;
    const entry = running.get(name);
    if (!entry || !entry.child) return null;
    return { host: '127.0.0.1', port: entry.port, tunnel: name };
}

function status() {
    const state = sync();
    return Object.entries(state.tunnels).map(([name, t]) => {
        const entry = running.get(name) || {};
        return {
            name,
            label: t.label,
            port: t.port,
            uploadedAt: t.uploadedAt,
            running: !!entry.child,
            since: entry.child ? new Date(entry.startedAt).toISOString() : null,
            error: entry.lastError || null,
            usedBy: Object.keys(state.uses).filter(s => state.uses[s] === name).map(s => SOURCES[s] || s)
        };
    });
}

function stopAll() {
    Array.from(running.keys()).forEach(stop);
}

// wireproxy must not outlive this process (a stray one would keep the port and
// an old config): stopped on a normal exit, and on the signals a service
// manager stops with, which otherwise end Node without an 'exit' event.
process.on('exit', stopAll);
let signalsHandled = false;
function handleSignals() {
    if (signalsHandled) return;
    signalsHandled = true;
    ['SIGTERM', 'SIGINT'].forEach(sig => process.once(sig, () => { stopAll(); process.exit(0); }));
}

module.exports = { SOURCES, readState, saveTunnel, deleteTunnel, setUse, cleanConfig, proxyFor, status, sync, stopAll, DIR };
