// VPN check: with it on, stream searches only run while this server's
// internet traffic goes out through the VPN network set in the dashboard.
//
// The VPN runs on the router, so nothing on this machine itself shows it;
// what does is the network the public IP belongs to ("AS208172 Proton AG"
// with the VPN on, the internet provider's own network with it off). That is
// looked up at ipinfo.io, or at ipapi.is when ipinfo doesn't answer, and kept
// for CHECK_TTL_MS. When neither answers the check fails: without knowing,
// nothing is fetched.
//
// The setting lives in config/vpn.json ({ enabled, network }), written by the
// admin dashboard and read here by every process (addon, admin, server.js),
// so a change takes effect without a restart.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'vpn.json');
const CHECK_TTL_MS = 60 * 1000;
const LOOKUP_TIMEOUT_MS = 5000;

function readConfig() {
    try {
        const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { enabled: !!c.enabled, network: typeof c.network === 'string' ? c.network.trim() : '' };
    } catch (e) {
        return { enabled: false, network: '' };
    }
}

function writeConfig(config) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ enabled: !!config.enabled, network: (config.network || '').trim() }, null, 2) + '\n');
}

function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    return fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
        .then(res => (res.ok ? res.json() : null))
        .finally(() => clearTimeout(timer));
}

// -> { ip, network } for this machine's public IP, or null when no service answers.
function lookupPublicNetwork() {
    return getJson('https://ipinfo.io/json')
        .then(j => (j && j.org ? { ip: j.ip, network: j.org } : null))
        .catch(() => null)
        .then(found => found || getJson('https://api.ipapi.is/')
            .then(j => (j && (j.asn || j.company) ? { ip: j.ip, network: [j.asn, j.company].filter(Boolean).join(' ') } : null))
            .catch(() => null));
}

// The network name without its "AS1234 " number, as it is shown and stored.
function networkName(network) {
    return (network || '').replace(/^AS\d+\s+/i, '').trim();
}

let lastCheck = { at: 0, promise: null };

// -> { ok, enabled, network (expected), current: {ip, network} | null, reason }
function check(force) {
    const config = readConfig();
    if (!config.enabled) return Promise.resolve({ ok: true, enabled: false, network: config.network, current: null, reason: 'VPN check is off' });
    if (force || !lastCheck.promise || Date.now() - lastCheck.at >= CHECK_TTL_MS) {
        lastCheck = { at: Date.now(), promise: lookupPublicNetwork() };
    }
    return lastCheck.promise.then(current => {
        const fresh = readConfig();
        if (!fresh.network) return { ok: false, enabled: true, network: '', current, reason: 'No VPN network set' };
        if (!current) return { ok: false, enabled: true, network: fresh.network, current, reason: 'Could not look up the public IP' };
        const ok = current.network.toLowerCase().includes(fresh.network.toLowerCase());
        return { ok, enabled: true, network: fresh.network, current, reason: ok ? 'On the VPN' : 'Not on the VPN' };
    });
}

module.exports = { check, readConfig, writeConfig, lookupPublicNetwork, networkName, CONFIG_PATH };
