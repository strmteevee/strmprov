const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { readManifest, aggregateStreams } = require('./lib/aggregate');
const { rewriteStreamUrls, handleProxyRequest } = require('./lib/rangeProxy');

const PORT = 3000;

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
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
}

// GET /api/streams?tmdbId=550&type=movie
// GET /api/streams?tmdbId=1396&type=tv&season=1&episode=1
// GET /api/streams?tmdbId=550&type=movie&providers=vidrock,moviebox
function handleStreamsApi(query, res, baseUrl) {
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

    const providerIds = providersParam
        ? providersParam.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    aggregateStreams(tmdbId, mediaType, season, episode, { providerIds, preferred: wantPreferred })
        .then(({ streams, perProvider, totalMs }) => {
            // Some sources (confirmed: video-downloads.googleusercontent.com
            // Google Drive links) don't support HTTP Range requests at all,
            // which breaks playback on players that need random access just
            // to start (ExoPlayer/Android TV). Routing those through this
            // server's own /proxy (lib/rangeProxy.js) fakes Range support
            // instead of handing the player a URL it can't actually use.
            const rewritten = rewriteStreamUrls(streams, baseUrl);
            sendJson(res, 200, {
                tmdbId,
                mediaType,
                season,
                episode,
                totalMs,
                totalStreams: rewritten.length,
                providers: perProvider,
                streams: rewritten
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
    const baseUrl = `http://${req.headers.host || `localhost:${PORT}`}`;

    if (parsedUrl.pathname === '/api/streams') {
        return handleStreamsApi(parsedUrl.searchParams, res, baseUrl);
    }
    if (parsedUrl.pathname === '/api/providers') {
        return handleProvidersApi(res);
    }
    if (parsedUrl.pathname === '/proxy') {
        return handleProxyRequest(req, res, parsedUrl.searchParams);
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
