// Persists the user's own Usenet (NNTP) server settings to a local file.
// data/ is gitignored - this is credentials for a service the user pays for
// (or a free/trial one), stored only on their own machine, never sent
// anywhere except to that server itself.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'provider.json');

const DEFAULTS = { host: '', port: 563, ssl: true, username: '', password: '', connections: 4 };

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function save(config) {
  const merged = {
    host: String(config.host || '').trim(),
    port: parseInt(config.port, 10) || DEFAULTS.port,
    ssl: !!config.ssl,
    username: String(config.username || ''),
    password: String(config.password || ''),
    connections: Math.max(1, Math.min(20, parseInt(config.connections, 10) || DEFAULTS.connections))
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function isConfigured(config) {
  return !!(config && config.host && config.username && config.password);
}

// For sending to the browser: never echo the real password back.
function redact(config) {
  return Object.assign({}, config, { password: config.password ? '••••••••' : '' });
}

module.exports = { load, save, isConfigured, redact };
