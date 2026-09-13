// Stremio/Nuvio addon protocol server for this repo's providers.
//
// This is a DIFFERENT thing from server.js's /api/streams: that's a custom
// JSON API meant for StreamAPI's local Nuvio plugin. This instead speaks the
// real Stremio addon protocol (manifest.json + /catalog + /stream), so it
// can be installed directly as an addon in Nuvio (or Stremio itself) with no
// local plugin file needed at all.
//
// Routes are scoped by a profileId path segment:
//   GET /profile/:profileId/manifest.json
//   GET /profile/:profileId/catalog/:type/:id.json
//   GET /profile/:profileId/stream/:type/:id.json
//
// The SAME manifest content is served at every profileId - what differs is
// which profile's watch history a given install reads/writes. Nuvio's own
// addon-preferences storage keys installed addons by URL, not by the
// manifest's own `id` field (confirmed from Nuvio's source), so N different
// URLs pointing at the same server is exactly the supported way to give each
// profile its own addon install. Each profile's manifest `id` is still made
// distinct (below) as a defensive measure for any OTHER Stremio-protocol
// client that might de-dup addons by manifest id instead of URL.
//
// Watch history and the "For You" catalog are explained in
// lib/profileStore.js, lib/tmdb.js and lib/gemini.js - the short version:
// Stremio has no watch-progress callback to addons, so "watched" here means
// "requested a stream for", and recommendations come from Gemini reasoning
// across a profile's whole watch history at once (see lib/gemini.js for why
// that beats TMDB's per-title /recommendations and /similar), falling back
// to those same TMDB endpoints when no GEMINI_API_KEY is configured or every
// model attempt fails.

try { process.loadEnvFile('.env'); } catch (e) { /* no .env file - fine, GEMINI_API_KEY is optional */ }

const http = require('http');
const os = require('os');
const { URL } = require('url');

const aggregate = require('./lib/aggregate');
const tmdb = require('./lib/tmdb');
const profileStore = require('./lib/profileStore');
const gemini = require('./lib/gemini');

const PORT = 3100;
const CATALOG_SEED_COUNT = 10;
const CATALOG_MAX_ITEMS = 24;
const AI_CACHE_TTL_MS = 1000 * 60 * 60 * 24;

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
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(body));
}

function buildManifest(profileId) {
    return {
        id: `com.strmprov.addon.profile${profileId}`,
        version: '1.0.0',
        name: 'StrmProv',
        description: `Self-hosted multi-source streaming addon (profile ${profileId}) with a personalized "For You" catalog based on this profile's own watch history.`,
        logo: 'https://raw.githubusercontent.com/tapframe/nuvio-providers/main/Assets/Logo-2.png',
        resources: ['catalog', 'stream'],
        types: ['movie', 'series'],
        catalogs: [
            { type: 'movie', id: 'strmprov-foryou-movie', name: 'For You' },
            { type: 'series', id: 'strmprov-foryou-series', name: 'For You' }
        ],
        idPrefixes: ['tt'],
        behaviorHints: { configurable: false, configurationRequired: false }
    };
}

// mediaInfo items from TMDB's /recommendations and /similar don't carry an
// imdb_id (only the movie/tv detail and external_ids endpoints do), so each
// candidate needs its own follow-up lookup - getImdbId() caches those across
// catalog rebuilds so this isn't a full N-lookup cost every single time.
function tmdbItemToMeta(item, mediaType, type) {
    return tmdb.getImdbId(item.id, mediaType).then(imdbId => {
        if (!imdbId) return null;
        return {
            id: imdbId,
            type,
            name: item.title || item.name || 'Untitled',
            poster: tmdb.posterUrl(item.poster_path),
            description: item.overview || '',
            releaseInfo: (item.release_date || item.first_air_date || '').substring(0, 4)
        };
    }).catch(() => null);
}

// TMDB's own /recommendations and /similar only ever take one title (see
// lib/gemini.js's header comment) - this is the original per-title merge
// approach, kept as the fallback for when Gemini isn't configured or every
// model attempt fails, so the catalog never just breaks.
function buildTmdbCatalog(seeds, mediaType, type, watchedIds) {
    return Promise.all(seeds.map(seed =>
        tmdb.getRecommendations(seed.tmdbId, mediaType).then(list =>
            list.length ? list : tmdb.getSimilar(seed.tmdbId, mediaType)
        )
    )).then(lists => {
        const candidates = new Map();
        for (const item of lists.flat()) {
            const id = String(item.id);
            if (watchedIds.has(id) || candidates.has(id) || !item.poster_path) continue;
            candidates.set(id, item);
        }
        return Array.from(candidates.values())
            .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
            .slice(0, CATALOG_MAX_ITEMS);
    });
}

function buildAiCatalog(seeds, mediaType, watchedIds) {
    return gemini.getAiRecommendations(seeds, mediaType, tmdb, watchedIds).then(resolved => {
        if (!resolved || resolved.length === 0) return null;
        const seen = new Set();
        const items = [];
        for (const r of resolved) {
            const id = String(r.item.id);
            if (seen.has(id)) continue;
            seen.add(id);
            items.push(r.item);
        }
        return items.slice(0, CATALOG_MAX_ITEMS);
    });
}

function buildCatalog(profileId, type) {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const history = profileStore.getHistory(profileId).filter(h => h.mediaType === mediaType);

    if (history.length === 0) {
        // Nothing watched yet on this profile for this type - nothing to
        // seed recommendations from. An empty catalog (rather than a guess)
        // is the honest result here.
        return Promise.resolve([]);
    }

    const watchedIds = new Set(history.map(h => String(h.tmdbId)));
    const seeds = history.slice(0, CATALOG_SEED_COUNT);
    const cacheKey = `ai-${type}`;
    const seedFingerprint = seeds.map(s => s.tmdbId).join(',');

    const cached = profileStore.getCache(profileId, cacheKey);
    if (cached && cached.seedFingerprint === seedFingerprint && Date.now() - cached.generatedAt < AI_CACHE_TTL_MS) {
        return Promise.resolve(cached.metas);
    }

    // Gemini's own occasional per-model overload is already retried inside
    // lib/gemini.js - a null here means "not configured, or every model
    // attempt genuinely failed", which is what actually falls back to TMDB.
    return buildAiCatalog(seeds, mediaType, watchedIds)
        .then(items => items ? { items, source: 'gemini' } : buildTmdbCatalog(seeds, mediaType, type, watchedIds).then(items => ({ items, source: 'tmdb' })))
        .then(({ items, source }) => {
            console.log(`[addon-server] Built "${type}" catalog for profile ${profileId} from ${source} (${items.length} item(s))`);
            return Promise.all(items.map(item => tmdbItemToMeta(item, mediaType, type)))
                .then(metas => metas.filter(Boolean));
        })
        .then(metas => {
            profileStore.setCache(profileId, cacheKey, { seedFingerprint, generatedAt: Date.now(), metas });
            return metas;
        });
}

function buildStreamResponse(profileId, type, rawId) {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const [imdbId, seasonStr, episodeStr] = rawId.split(':');
    const season = seasonStr ? parseInt(seasonStr, 10) : null;
    const episode = episodeStr ? parseInt(episodeStr, 10) : null;

    if (mediaType === 'tv' && (!season || !episode)) {
        return Promise.resolve({ streams: [] });
    }

    return tmdb.findByImdbId(imdbId).then(found => {
        if (!found) {
            console.log(`[addon-server] No TMDB match for ${imdbId}`);
            return { streams: [] };
        }
        return aggregate.aggregateStreams(found.tmdbId, found.mediaType, season, episode).then(({ streams }) => {
            profileStore.recordWatch(profileId, { tmdbId: found.tmdbId, mediaType: found.mediaType, title: found.title, year: found.year });

            const stremioStreams = streams.map(s => {
                const behaviorHints = { notWebReady: true };
                if (s.headers && Object.keys(s.headers).length) {
                    behaviorHints.proxyHeaders = { request: s.headers };
                }
                return {
                    url: s.url,
                    name: s.name || s.source || 'Stream',
                    title: [s.quality, s.size].filter(Boolean).join(' | ') || s.title || '',
                    behaviorHints
                };
            });
            return { streams: stremioStreams };
        });
    }).catch(err => {
        console.error(`[addon-server] stream error for ${imdbId}: ${err.message}`);
        return { streams: [] };
    });
}

function notFound(res) {
    sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parts = parsedUrl.pathname.split('/').filter(Boolean);

    if (parts.length === 0) {
        const ip = getLocalIp();
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(
            'StrmProv Addon Server running.\n\n' +
            'Install one of these as a Nuvio/Stremio addon per profile:\n' +
            [1, 2, 3, 4].map(n => `  http://${ip}:${PORT}/profile/${n}/manifest.json`).join('\n') +
            '\n'
        );
        return;
    }

    // /profile/:profileId/...
    if (parts[0] !== 'profile' || parts.length < 3) {
        return notFound(res);
    }
    const profileId = parts[1];
    const resource = parts[2];

    if (resource === 'manifest.json' && parts.length === 3) {
        return sendJson(res, 200, buildManifest(profileId));
    }

    if (resource === 'catalog' && parts.length >= 5) {
        const type = parts[3];
        const idWithExt = parts[4];
        const id = idWithExt.replace(/\.json$/, '');
        // Only the two catalogs declared in the manifest are ever served.
        const validId = id === `strmprov-foryou-${type}`;
        if (!validId || (type !== 'movie' && type !== 'series')) {
            return sendJson(res, 200, { metas: [] });
        }
        return buildCatalog(profileId, type).then(metas => sendJson(res, 200, { metas }));
    }

    if (resource === 'stream' && parts.length >= 5) {
        const type = parts[3];
        const idWithExt = decodeURIComponent(parts.slice(4).join('/'));
        const id = idWithExt.replace(/\.json$/, '');
        if (type !== 'movie' && type !== 'series') {
            return sendJson(res, 200, { streams: [] });
        }
        return buildStreamResponse(profileId, type, id).then(body => sendJson(res, 200, body));
    }

    return notFound(res);
});

server.listen(PORT, () => {
    const ip = getLocalIp();
    console.log(`\n🚀 StrmProv addon server running at: http://${ip}:${PORT}/`);
    console.log('Install one of these as a Nuvio/Stremio addon per profile:');
    [1, 2, 3, 4].forEach(n => console.log(`  http://${ip}:${PORT}/profile/${n}/manifest.json`));
    console.log('\nEach profile builds its own "For You" catalog from its own watch history once it has streamed a few titles.');
    console.log('Press Ctrl+C to stop\n');
});
