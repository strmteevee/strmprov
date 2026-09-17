// Shared config for the user's own Usenet (NNTP) provider - the credentials
// needed to actually download article bodies. Kept separate from
// config/subtitles.json-style plain settings and gitignored (see
// .gitignore) since, unlike a language preference, this is a real login the
// user pays for.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'usenet.json');

const DEFAULTS = { host: '', port: 563, ssl: true, username: '', password: '', connections: 4 };

function readUsenetConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return Object.assign({}, DEFAULTS, raw);
    } catch (e) {
        return Object.assign({}, DEFAULTS);
    }
}

function writeUsenetConfig(config) {
    const merged = {
        host: String((config && config.host) || '').trim(),
        port: parseInt(config && config.port, 10) || DEFAULTS.port,
        ssl: !!(config && config.ssl),
        username: String((config && config.username) || ''),
        password: String((config && config.password) || ''),
        connections: Math.max(1, Math.min(20, parseInt(config && config.connections, 10) || DEFAULTS.connections))
    };
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
    return merged;
}

function isUsenetConfigured(config) {
    const c = config || readUsenetConfig();
    return !!(c && c.host && c.username && c.password);
}

// For sending to the browser: never echo the real password back.
function redactUsenetConfig(config) {
    return Object.assign({}, config, { password: config.password ? '••••••••' : '' });
}

module.exports = { readUsenetConfig, writeUsenetConfig, isUsenetConfigured, redactUsenetConfig, CONFIG_PATH };
