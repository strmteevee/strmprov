const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const PORT = 3000;
const PROVIDERS_DIR = path.join(__dirname, 'providers');
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const PROVIDER_TIMEOUT_MS = 20000;

const MAX_SIZE_GB = 30;

// Parses size strings like "40.16 GB", "700 MB", "1.2 TB" into GB.
function parseSizeToGB(sizeStr) {
    if (!sizeStr) return null;
    const m = String(sizeStr).match(/([\d.]+)\s*(TB|GB|MB)/i);
    if (!m) return null;
    const value = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    if (unit === 'TB') return value * 1024;
    if (unit === 'MB') return value / 1024;
    return value;
}

// Not every provider puts the size in its own field - some (e.g. 4KHDHub)
// only embed it as trailing text in `title` (".mkv\n40.16 GB"). Check the
// dedicated field first, then fall back to scanning the title, so the size
// cap isn't silently skipped for those. Returns null when there's genuinely
// no size info anywhere, so streams we can't judge are never filtered out.
function getStreamSizeGB(stream) {
    const fromField = parseSizeToGB(stream.size);
    if (fromField !== null) return fromField;
    return parseSizeToGB(stream.title);
}

// Series: rank everything by resolution, don't hide anything.
function seriesTier(quality) {
    const q = (quality || '').toString().toLowerCase();
    if (q.includes('1080')) return 0;
    if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) return 1;
    if (q.includes('720')) return 2;
    if (q.includes('480')) return 3;
    return 4;
}

// Movies: only 4K and 1080p are acceptable - anything else (720p, 480p,
// "Auto", "Unknown", ...) is hidden entirely, not just deprioritized.
function movieTier(quality) {
    const q = (quality || '').toString().toLowerCase();
    if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) return 0;
    if (q.includes('1080')) return 1;
    return null;
}

// Drops anything over MAX_SIZE_GB, hides sub-1080p results for movies, then
// tags the best remaining stream by resolution tier as [PREFERRED] and moves
// it to the front - the rest of the (filtered) list is left untouched.
function applyPreferredLogic(streams, mediaType) {
    let filtered = streams.filter(s => {
        const gb = getStreamSizeGB(s);
        return gb === null || gb <= MAX_SIZE_GB;
    });

    const tierFn = mediaType === 'tv' ? seriesTier : movieTier;
    if (mediaType !== 'tv') {
        filtered = filtered.filter(s => tierFn(s.quality) !== null);
    }

    if (filtered.length === 0) return filtered;

    let best = filtered[0];
    let bestTier = tierFn(best.quality);
    for (const s of filtered) {
        const tier = tierFn(s.quality);
        if (tier < bestTier) {
            best = s;
            bestTier = tier;
        }
    }

    const tagged = Object.assign({}, best, {
        name: `[PREFERRED] ${best.name || best.source}`.trim(),
        isPreferred: true
    });
    const rest = filtered.filter(s => s !== best);
    return [tagged, ...rest];
}

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

function readManifest() {
    try {
        return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } catch (e) {
        return { scrapers: [] };
    }
}

function loadProvider(id) {
    // Only allow ids that are actually registered in the manifest, and only
    // resolve inside providers/ - this is a public HTTP endpoint, so a raw
    // `?providers=` value must never reach require()/the filesystem directly.
    const manifest = readManifest();
    const entry = manifest.scrapers.find(s => s.id === id);
    if (!entry) return null;
    const filePath = path.join(__dirname, entry.filename);
    if (!filePath.startsWith(PROVIDERS_DIR)) return null;
    try {
        delete require.cache[require.resolve(filePath)];
        return require(filePath);
    } catch (e) {
        console.error(`[API] Failed to load provider "${id}": ${e.message}`);
        return null;
    }
}

// streamapi.js is a thin client for THIS server's own /api/streams endpoint
// (via global.SCRAPER_SETTINGS.serverUrl, which Nuvio provides but this
// server process never does) - querying it from here can never return
// anything, so it's excluded from the default list. It can still be queried
// explicitly via ?providers=streamapi if that's ever useful.
const SELF_REFERENTIAL_PROVIDERS = ['streamapi'];

function getEnabledProviderIds() {
    const manifest = readManifest();
    return manifest.scrapers
        .filter(s => s.enabled && !SELF_REFERENTIAL_PROVIDERS.includes(s.id))
        .map(s => s.id);
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
}

// GET /api/streams?tmdbId=550&type=movie
// GET /api/streams?tmdbId=1396&type=tv&season=1&episode=1
// GET /api/streams?tmdbId=550&type=movie&providers=vidrock,moviebox
//
// Queries every requested provider (default: every enabled provider in
// manifest.json) concurrently - this runs in plain Node, not inside the
// app's sandboxed engine, so there's no size/concurrency ceiling to work
// around here the way there was trying to do this as a provider itself.
function handleStreamsApi(query, res) {
    const tmdbId = query.get('tmdbId');
    const mediaType = query.get('type') === 'tv' ? 'tv' : 'movie';
    const season = query.get('season') ? parseInt(query.get('season'), 10) : null;
    const episode = query.get('episode') ? parseInt(query.get('episode'), 10) : null;
    const providersParam = query.get('providers');
    const wantPreferred = query.get('preferred') !== 'false';

    if (!tmdbId) {
        return sendJson(res, 400, { error: 'Missing required query param: tmdbId' });
    }
    if (mediaType === 'tv' && (!season || !episode)) {
        return sendJson(res, 400, { error: 'season and episode are required when type=tv' });
    }

    let requestedIds = providersParam
        ? providersParam.split(',').map(s => s.trim()).filter(Boolean)
        : getEnabledProviderIds();

    if (requestedIds.length === 0) {
        return sendJson(res, 400, { error: 'No providers to query' });
    }

    const perProvider = {};
    const startedAt = Date.now();

    const work = requestedIds.map(id => {
        const mod = loadProvider(id);
        if (!mod || typeof mod.getStreams !== 'function') {
            perProvider[id] = { error: 'provider not found or not enabled' };
            return Promise.resolve([]);
        }
        const providerStart = Date.now();
        return withTimeout(Promise.resolve(mod.getStreams(tmdbId, mediaType, season, episode)), PROVIDER_TIMEOUT_MS, id)
            .then(streams => {
                const list = Array.isArray(streams) ? streams : [];
                perProvider[id] = { count: list.length, ms: Date.now() - providerStart };
                return list.map(s => Object.assign({}, s, { source: id }));
            })
            .catch(err => {
                perProvider[id] = { error: err.message, ms: Date.now() - providerStart };
                return [];
            });
    });

    Promise.all(work).then(results => {
        const streams = results.flat();
        const finalStreams = wantPreferred ? applyPreferredLogic(streams, mediaType) : streams;

        sendJson(res, 200, {
            tmdbId,
            mediaType,
            season,
            episode,
            totalMs: Date.now() - startedAt,
            totalStreams: finalStreams.length,
            providers: perProvider,
            streams: finalStreams
        });
    });
}

function handleProvidersApi(res) {
    const manifest = readManifest();
    sendJson(res, 200, {
        providers: manifest.scrapers.map(s => ({
            id: s.id,
            name: s.name,
            enabled: s.enabled,
            supportedTypes: s.supportedTypes
        }))
    });
}

const mimeTypes = {
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.html': 'text/html',
};

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (parsedUrl.pathname === '/api/streams') {
        return handleStreamsApi(parsedUrl.searchParams, res);
    }
    if (parsedUrl.pathname === '/api/providers') {
        return handleProvidersApi(res);
    }

    // Prepare file path
    let filePath = path.join(__dirname, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);

    // Security check: prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov'];

    const extname = path.extname(filePath);
    let contentType = mimeTypes[extname] || 'application/octet-stream';
    if (videoExtensions.includes(extname)) {
        contentType = "video/mp4"; // Defaulting to mp4 for video files for simplicity
    }


    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // If asking for root and index.html doesn't exist, allow checking specific files
                if (parsedUrl.pathname === '/') {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('Nuvio Providers Server Running. Access /manifest.json for the provider manifest, or /api/streams?tmdbId=550&type=movie for aggregated streams.');
                    return;
                }
                res.writeHead(404);
                res.end(`File not found: ${req.url}`);
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    const ip = getLocalIp();
    console.log(`\n🚀 Server running at: http://${ip}:${PORT}/`);
    console.log(`📝 Manifest URL:      http://${ip}:${PORT}/manifest.json`);
    console.log(`📡 Providers API:     http://${ip}:${PORT}/api/providers`);
    console.log(`🎬 Streams API:       http://${ip}:${PORT}/api/streams?tmdbId=550&type=movie`);
    console.log('Press Ctrl+C to stop\n');
});
