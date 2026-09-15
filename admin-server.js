// Admin dashboard for the strmprov server - lets you enable/disable
// providers, add/edit/remove external-addon relays (see
// providers/external-addon.js), tune the [PREFERRED]-tag ranking (see
// lib/aggregate.js's scoreStream/applyPreferredLogic), reset a profile's
// "For You" watch history, and run a live stream test - all without SSH +
// a text editor + a restart.
//
// Same style as server.js/addon-server.js: plain Node http, no framework,
// no new dependencies. Serves one self-contained HTML page at / (vanilla
// JS/CSS, no build step) plus a small JSON API under /api/.
//
// No authentication - meant for LAN-only use, same trust model as the other
// two servers here.

try { process.loadEnvFile('.env'); } catch (e) { /* no .env file - fine, subtitle keys are optional */ }

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { execFile } = require('child_process');

const aggregate = require('./lib/aggregate');
const profileStore = require('./lib/profileStore');
const subtitles = require('./lib/subtitles');

const PORT = 3200;
const ROOT_DIR = __dirname;

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

function sendJson(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            if (!data) return resolve({});
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

function writeManifest(manifest) {
    fs.writeFileSync(aggregate.MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function writeRankingConfig(config) {
    fs.mkdirSync(path.dirname(aggregate.RANKING_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(aggregate.RANKING_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Ids that back a real, load-bearing part of this repo (build-combined.js's
// SOURCES list, this file's own defaults) - editable through the external-
// addon endpoints below like any other, but not deletable, since removing
// the manifest entry would leave those other references dangling.
const PROTECTED_EXTERNAL_IDS = ['hdhub4u', 'penguplay'];

// ---- Providers ----

function handleGetProviders(res) {
    const manifest = aggregate.readManifest();
    const providers = manifest.scrapers.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        enabled: !!s.enabled,
        isExternalAddon: s.filename === 'providers/external-addon.js',
        isProtected: PROTECTED_EXTERNAL_IDS.includes(s.id),
        config: s.filename === 'providers/external-addon.js' ? s.config : undefined
    }));
    sendJson(res, 200, { providers });
}

function handleToggleProvider(id, res) {
    const manifest = aggregate.readManifest();
    const entry = manifest.scrapers.find(s => s.id === id);
    if (!entry) return sendJson(res, 404, { error: `No provider "${id}"` });
    entry.enabled = !entry.enabled;
    writeManifest(manifest);
    sendJson(res, 200, { id, enabled: entry.enabled });
}

function validateExternalAddonBody(body) {
    if (!body || typeof body !== 'object') return 'Missing body';
    if (!body.id || typeof body.id !== 'string' || !/^[a-z0-9-]+$/.test(body.id)) return 'id must be lowercase letters/digits/hyphens';
    if (!body.name || typeof body.name !== 'string') return 'name is required';
    if (!body.addonBaseUrl || typeof body.addonBaseUrl !== 'string') return 'addonBaseUrl is required';
    if (body.configJson !== undefined && body.configJson !== null && typeof body.configJson !== 'object') return 'configJson must be an object';
    return null;
}

function handleAddExternalProvider(body, res) {
    const err = validateExternalAddonBody(body);
    if (err) return sendJson(res, 400, { error: err });

    const manifest = aggregate.readManifest();
    if (manifest.scrapers.some(s => s.id === body.id)) {
        return sendJson(res, 409, { error: `A provider with id "${body.id}" already exists` });
    }
    manifest.scrapers.push({
        id: body.id,
        name: body.name,
        description: body.description || `Relays the ${body.name} Stremio addon.`,
        version: '1.0.0',
        author: 'admin',
        supportedTypes: ['movie', 'tv'],
        filename: 'providers/external-addon.js',
        config: {
            name: body.name,
            addonBaseUrl: body.addonBaseUrl,
            configJson: body.configJson || undefined,
            namePrefix: body.namePrefix || undefined
        },
        enabled: true,
        formats: ['mkv', 'mp4'],
        contentLanguage: ['en']
    });
    writeManifest(manifest);
    sendJson(res, 201, { id: body.id });
}

function handleEditExternalProvider(id, body, res) {
    const manifest = aggregate.readManifest();
    const entry = manifest.scrapers.find(s => s.id === id);
    if (!entry) return sendJson(res, 404, { error: `No provider "${id}"` });
    if (entry.filename !== 'providers/external-addon.js') {
        return sendJson(res, 400, { error: `"${id}" is not an external-addon provider` });
    }
    if (body.name) { entry.name = body.name; entry.config.name = body.name; }
    if (body.description) entry.description = body.description;
    if (body.addonBaseUrl) entry.config.addonBaseUrl = body.addonBaseUrl;
    if (body.configJson !== undefined) entry.config.configJson = body.configJson || undefined;
    if (body.namePrefix !== undefined) entry.config.namePrefix = body.namePrefix || undefined;
    writeManifest(manifest);
    sendJson(res, 200, { id });
}

function handleDeleteProvider(id, res) {
    if (PROTECTED_EXTERNAL_IDS.includes(id)) {
        return sendJson(res, 400, { error: `"${id}" is built-in and can't be deleted - disable it instead` });
    }
    const manifest = aggregate.readManifest();
    const entry = manifest.scrapers.find(s => s.id === id);
    if (!entry) return sendJson(res, 404, { error: `No provider "${id}"` });
    if (entry.filename !== 'providers/external-addon.js') {
        return sendJson(res, 400, { error: `"${id}" is a hand-written provider, not something this panel added - remove its manifest.json entry directly if you really want to` });
    }
    manifest.scrapers = manifest.scrapers.filter(s => s.id !== id);
    writeManifest(manifest);
    sendJson(res, 200, { id, deleted: true });
}

function handleRebuildCombined(res) {
    execFile('node', ['build-combined.js'], { cwd: ROOT_DIR, timeout: 60000 }, (err, stdout, stderr) => {
        if (err) return sendJson(res, 500, { error: err.message, stdout, stderr });
        sendJson(res, 200, { output: stdout.trim() });
    });
}

// ---- Ranking ----

function handleGetRanking(res) {
    sendJson(res, 200, aggregate.readRankingConfig());
}

function validateTypeConfig(tc) {
    if (!tc || typeof tc !== 'object') return 'movie/series config missing';
    if (tc.providerPoints && typeof tc.providerPoints !== 'object') return 'providerPoints must be an object';
    if (tc.qualityPoints && typeof tc.qualityPoints !== 'object') return 'qualityPoints must be an object';
    if (tc.threshold !== undefined && typeof tc.threshold !== 'number') return 'threshold must be a number';
    if (tc.maxSizeGB !== undefined && typeof tc.maxSizeGB !== 'number') return 'maxSizeGB must be a number';
    return null;
}

function handleSetRanking(body, res) {
    const movieErr = validateTypeConfig(body.movie);
    if (movieErr) return sendJson(res, 400, { error: `movie: ${movieErr}` });
    const seriesErr = validateTypeConfig(body.series);
    if (seriesErr) return sendJson(res, 400, { error: `series: ${seriesErr}` });
    writeRankingConfig({ movie: body.movie, series: body.series });
    sendJson(res, 200, aggregate.readRankingConfig());
}

// ---- Profiles ----

// Matches the profile ids addon-server.js itself installs by default (see
// its startup log and root route) - shown even with zero watch history so a
// base viewing profile can be set for a profile before anyone's streamed
// anything on it. Merged with whatever listProfiles() actually finds on
// disk, in case a profile outside this range has real data.
const KNOWN_PROFILE_IDS = ['1', '2', '3', '4'];

function handleGetProfiles(res) {
    const withHistory = profileStore.listProfiles();
    const foundIds = new Set(withHistory.map(p => p.profileId));
    const empties = KNOWN_PROFILE_IDS
        .filter(id => !foundIds.has(id))
        .map(id => ({ profileId: id, historyCount: 0, lastWatchedAt: null, titles: [] }));
    const profiles = [...withHistory, ...empties]
        .map(p => Object.assign({}, p, { baseProfile: profileStore.getBaseProfile(p.profileId) }))
        .sort((a, b) => a.profileId.localeCompare(b.profileId, undefined, { numeric: true }));
    sendJson(res, 200, { profiles });
}

function handleGetProfileHistory(id, res) {
    sendJson(res, 200, { profileId: id, history: profileStore.getHistory(id) });
}

function handleResetProfile(id, res) {
    profileStore.resetProfile(id);
    sendJson(res, 200, { profileId: id, reset: true });
}

function handleSetBaseProfile(id, body, res) {
    if (typeof body.text !== 'string') return sendJson(res, 400, { error: 'text is required (use an empty string to clear it)' });
    profileStore.setBaseProfile(id, body.text);
    sendJson(res, 200, { profileId: id, baseProfile: profileStore.getBaseProfile(id) });
}

// ---- Subtitles ----

function writeSubtitlesConfig(config) {
    fs.mkdirSync(path.dirname(subtitles.SUBTITLES_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(subtitles.SUBTITLES_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function handleGetSubtitlesConfig(res) {
    sendJson(res, 200, Object.assign({}, subtitles.readSubtitlesConfig(), {
        subDlConfigured: subtitles.isSubDlConfigured(),
        openSubtitlesConfigured: subtitles.isOpenSubtitlesConfigured()
    }));
}

function handleSetSubtitlesConfig(body, res) {
    const firstLanguage = typeof body.firstLanguage === 'string' ? body.firstLanguage : '';
    const secondLanguage = typeof body.secondLanguage === 'string' ? body.secondLanguage : '';
    writeSubtitlesConfig({ firstLanguage, secondLanguage });
    handleGetSubtitlesConfig(res);
}

// ---- Live test ----

function handleTest(body, res) {
    const tmdbId = body.tmdbId;
    const mediaType = body.mediaType === 'tv' ? 'tv' : 'movie';
    const season = body.season ? parseInt(body.season, 10) : null;
    const episode = body.episode ? parseInt(body.episode, 10) : null;
    if (!tmdbId) return sendJson(res, 400, { error: 'tmdbId is required' });
    if (mediaType === 'tv' && (!season || !episode)) return sendJson(res, 400, { error: 'season and episode are required for tv' });

    aggregate.aggregateStreams(tmdbId, mediaType, season, episode)
        .then(({ streams, perProvider, totalMs }) => sendJson(res, 200, { streams, perProvider, totalMs }))
        .catch(err => sendJson(res, 500, { error: err.message }));
}

// ---- Dashboard HTML ----

const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'admin-dashboard.html'), 'utf8');

// ---- Router ----

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parts = parsedUrl.pathname.split('/').filter(Boolean);

    if (parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(DASHBOARD_HTML);
        return;
    }

    // /api/providers
    if (parts[0] === 'api' && parts[1] === 'providers' && parts.length === 2 && req.method === 'GET') {
        return handleGetProviders(res);
    }
    // /api/providers/:id/toggle
    if (parts[0] === 'api' && parts[1] === 'providers' && parts.length === 4 && parts[3] === 'toggle' && req.method === 'POST') {
        return handleToggleProvider(decodeURIComponent(parts[2]), res);
    }
    // /api/providers/external  (add)
    if (parts[0] === 'api' && parts[1] === 'providers' && parts[2] === 'external' && parts.length === 3 && req.method === 'POST') {
        return readBody(req).then(body => handleAddExternalProvider(body, res)).catch(e => sendJson(res, 400, { error: e.message }));
    }
    // /api/providers/external/:id  (edit)
    if (parts[0] === 'api' && parts[1] === 'providers' && parts[2] === 'external' && parts.length === 4 && req.method === 'PUT') {
        return readBody(req).then(body => handleEditExternalProvider(decodeURIComponent(parts[3]), body, res)).catch(e => sendJson(res, 400, { error: e.message }));
    }
    // /api/providers/:id  (delete)
    if (parts[0] === 'api' && parts[1] === 'providers' && parts.length === 3 && req.method === 'DELETE') {
        return handleDeleteProvider(decodeURIComponent(parts[2]), res);
    }
    // /api/rebuild-combined
    if (parts[0] === 'api' && parts[1] === 'rebuild-combined' && req.method === 'POST') {
        return handleRebuildCombined(res);
    }
    // /api/ranking
    if (parts[0] === 'api' && parts[1] === 'ranking' && req.method === 'GET') {
        return handleGetRanking(res);
    }
    if (parts[0] === 'api' && parts[1] === 'ranking' && req.method === 'POST') {
        return readBody(req).then(body => handleSetRanking(body, res)).catch(e => sendJson(res, 400, { error: e.message }));
    }
    // /api/profiles
    if (parts[0] === 'api' && parts[1] === 'profiles' && parts.length === 2 && req.method === 'GET') {
        return handleGetProfiles(res);
    }
    // /api/profiles/:id/history
    if (parts[0] === 'api' && parts[1] === 'profiles' && parts.length === 4 && parts[3] === 'history' && req.method === 'GET') {
        return handleGetProfileHistory(decodeURIComponent(parts[2]), res);
    }
    // /api/profiles/:id/reset
    if (parts[0] === 'api' && parts[1] === 'profiles' && parts.length === 4 && parts[3] === 'reset' && req.method === 'POST') {
        return handleResetProfile(decodeURIComponent(parts[2]), res);
    }
    // /api/profiles/:id/base
    if (parts[0] === 'api' && parts[1] === 'profiles' && parts.length === 4 && parts[3] === 'base' && req.method === 'POST') {
        return readBody(req).then(body => handleSetBaseProfile(decodeURIComponent(parts[2]), body, res)).catch(e => sendJson(res, 400, { error: e.message }));
    }
    // /api/subtitles-config
    if (parts[0] === 'api' && parts[1] === 'subtitles-config' && req.method === 'GET') {
        return handleGetSubtitlesConfig(res);
    }
    if (parts[0] === 'api' && parts[1] === 'subtitles-config' && req.method === 'POST') {
        return readBody(req).then(body => handleSetSubtitlesConfig(body, res)).catch(e => sendJson(res, 400, { error: e.message }));
    }
    // /api/test
    if (parts[0] === 'api' && parts[1] === 'test' && req.method === 'POST') {
        return readBody(req).then(body => handleTest(body, res)).catch(e => sendJson(res, 400, { error: e.message }));
    }

    sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
    const ip = getLocalIp();
    console.log(`\n🛠️  Admin dashboard running at: http://${ip}:${PORT}/`);
    console.log('Press Ctrl+C to stop\n');
});
