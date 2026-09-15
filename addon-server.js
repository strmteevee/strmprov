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
const subtitles = require('./lib/subtitles');
const indycar = require('./providers/indycar');

const PORT = 3100;
const CATALOG_SEED_COUNT = 10;
const CATALOG_MIN_ITEMS = 30;
const CATALOG_MAX_ITEMS = 40;
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
        // 'meta' is scoped to indycar: ids specifically, not declared
        // broadly - normal movies/series use real "tt" ids, which Cinemeta
        // (Nuvio's default metadata provider) already resolves fine. IndyCar
        // videos use a custom id scheme Cinemeta has no way to recognize, so
        // without this, opening one from the catalog got stuck: Nuvio's
        // normal flow fetches an item's meta before its stream, nothing
        // installed could answer that for an indycar: id, and it never
        // reached /stream at all. Confirmed live as the actual cause.
        resources: [
            'catalog', 'stream',
            { name: 'meta', types: ['movie'], idPrefixes: ['indycar:'] },
            // Scoped to real tt-id content only - IndyCar's own custom id
            // scheme has no subtitle concept, and Cinemeta already handles
            // meta for those ids, so there's nothing for this resource to
            // add there.
            { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }
        ],
        types: ['movie', 'series'],
        catalogs: [
            { type: 'movie', id: 'strmprov-foryou-movie', name: 'For You' },
            { type: 'series', id: 'strmprov-foryou-series', name: 'For You' },
            {
                type: 'movie',
                id: 'indycar-videos',
                name: 'IndyCar Extended Highlights'
                // By request: only "Extended Race Highlights" now, across
                // every race, newest first - no genre filter needed since
                // there's only the one category left. See
                // buildIndycarCatalog below for the fixed filter.
            }
        ],
        idPrefixes: ['tt', 'indycar:'],
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
    if (seeds.length === 0) return Promise.resolve([]);
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
        return Array.from(candidates.values()).sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    });
}

function buildAiCatalog(seeds, mediaType, watchedIds, baseProfile) {
    return gemini.getAiRecommendations(seeds, mediaType, tmdb, watchedIds, baseProfile).then(resolved => {
        if (!resolved || resolved.length === 0) return null;
        const seen = new Set();
        const items = [];
        for (const r of resolved) {
            const id = String(r.item.id);
            if (seen.has(id)) continue;
            seen.add(id);
            items.push(r.item);
        }
        return items;
    });
}

// The actual (re)build: AI recommendations first, topped up with TMDB
// similar/recommendations if that falls short of CATALOG_MIN_ITEMS (a niche
// taste can easily not have 30 AI-resolvable matches on its own). The TMDB
// top-up only ever uses same-type seeds - its endpoints structurally can't
// recommend a different media type than the seed, unlike the AI path.
function regenerateCatalog(profileId, type, mediaType, aiSeeds, tmdbSeeds, watchedIds, cacheKey, seedFingerprint, baseProfile) {
    return buildAiCatalog(aiSeeds, mediaType, watchedIds, baseProfile)
        .then(items => ({ items: items || [], source: items ? 'gemini' : 'none' }))
        .then(({ items, source }) => {
            // Targets CATALOG_MAX_ITEMS here, not CATALOG_MIN_ITEMS - some
            // AI suggestions won't resolve to a usable IMDb id later in
            // tmdbItemToMeta and get dropped after this point, so gathering
            // only exactly the minimum up front reliably undershoots it
            // once that attrition happens (seen directly: 31 raw items
            // became 26 in the final response). Aiming for the max instead
            // leaves enough headroom to still clear the minimum.
            if (items.length >= CATALOG_MAX_ITEMS || tmdbSeeds.length === 0) {
                return { items, source };
            }
            const seenIds = new Set(items.map(i => String(i.id)));
            return buildTmdbCatalog(tmdbSeeds, mediaType, type, watchedIds).then(extra => {
                const merged = items.slice();
                for (const item of extra) {
                    if (merged.length >= CATALOG_MAX_ITEMS) break;
                    const id = String(item.id);
                    if (seenIds.has(id)) continue;
                    seenIds.add(id);
                    merged.push(item);
                }
                return { items: merged, source: items.length ? `${source}+tmdb` : 'tmdb' };
            });
        })
        .then(({ items, source }) => {
            console.log(`[addon-server] Built "${type}" catalog for profile ${profileId} from ${source} (${items.length} item(s))`);
            return Promise.all(items.slice(0, CATALOG_MAX_ITEMS).map(item => tmdbItemToMeta(item, mediaType, type)))
                .then(metas => metas.filter(Boolean));
        })
        .then(metas => {
            profileStore.setCache(profileId, cacheKey, { seedFingerprint, generatedAt: Date.now(), metas });
            return metas;
        });
}

function buildCatalog(profileId, type) {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const fullHistory = profileStore.getHistory(profileId);
    const sameTypeHistory = fullHistory.filter(h => h.mediaType === mediaType);
    const baseProfile = profileStore.getBaseProfile(profileId);

    if (fullHistory.length === 0 && !baseProfile) {
        // Nothing watched yet on this profile, and no admin-set taste
        // description either - genuinely nothing to seed recommendations
        // from. An empty catalog (rather than a guess) is the honest result
        // here.
        return Promise.resolve([]);
    }

    // Prefer same-type history to seed recommendations; if this profile has
    // never watched this type at all (e.g. a series-only viewer asking for
    // a movie catalog), fall back to its overall history instead of coming
    // back empty - see lib/gemini.js's buildPrompt for how the AI path
    // reasons across a cross-type seed set. watchedIds stays same-type only
    // regardless, since a movie and a TV series can share the same TMDB id
    // for unrelated titles - cross-type exclusion would be wrong, not just
    // unnecessary.
    const watchedIds = new Set(sameTypeHistory.map(h => String(h.tmdbId)));
    const aiSeeds = (sameTypeHistory.length > 0 ? sameTypeHistory : fullHistory).slice(0, CATALOG_SEED_COUNT);
    const tmdbSeeds = sameTypeHistory.slice(0, CATALOG_SEED_COUNT);
    const cacheKey = `ai-${type}`;
    // Includes baseProfile so editing the taste description from the admin
    // UI invalidates the cache immediately instead of waiting up to a day -
    // otherwise a profile with no watch history at all would never see its
    // seed fingerprint change (aiSeeds stays empty either way).
    const seedFingerprint = `${aiSeeds.map(s => s.tmdbId).join(',')}|${baseProfile}`;

    const cached = profileStore.getCache(profileId, cacheKey);
    const isFresh = cached && cached.seedFingerprint === seedFingerprint && Date.now() - cached.generatedAt < AI_CACHE_TTL_MS;

    if (isFresh) {
        return Promise.resolve(cached.metas);
    }
    if (cached) {
        // Stale (a new watch or a base-profile edit changed the seed set, or
        // the TTL passed) - serve what's cached right now instead of making
        // this request wait on a fresh Gemini + TMDB round trip, and refresh
        // it in the background so the NEXT request gets the updated list.
        regenerateCatalog(profileId, type, mediaType, aiSeeds, tmdbSeeds, watchedIds, cacheKey, seedFingerprint, baseProfile)
            .catch(err => console.error(`[addon-server] Background catalog refresh failed: ${err.message}`));
        return Promise.resolve(cached.metas);
    }

    // No cache at all yet for this profile+type - this one request has no
    // choice but to wait for the real thing.
    return regenerateCatalog(profileId, type, mediaType, aiSeeds, tmdbSeeds, watchedIds, cacheKey, seedFingerprint, baseProfile);
}

// Shared by the catalog and meta builders below - a Stremio Meta Object is
// a superset of a catalog preview item, so one mapping covers both.
function indycarVideoToMeta(v) {
    return {
        id: v.id,
        type: 'movie',
        name: v.title,
        poster: v.poster,
        description: v.description,
        releaseInfo: v.timestamp ? new Date(v.timestamp).toISOString().substring(0, 10) : undefined
    };
}

// IndyCar videos have no TMDB entry, no watch history, and no personalization
// - this is a plain, static catalog, unlike "For You" above. `releaseInfo`
// uses the video's own date (read from its URL, not its displayed text - see
// providers/indycar.js for why) so the client can still show/sort by date.
// By request: only "Extended Race Highlights", across every race - listVideos()
// already returns newest-first (see providers/indycar.js's crawlAllVideos).
function buildIndycarCatalog() {
    return indycar.listVideos('Extended Race Highlights').then((videos) => videos.map(indycarVideoToMeta));
}

// Cinemeta (Nuvio's default metadata provider) only resolves real "tt" ids -
// it has no way to answer a meta lookup for our own indycar: id scheme. This
// is what closes that gap (see the manifest's scoped `meta` resource entry
// above): re-lists videos (cheap after the first call - providers/indycar.js
// caches the crawl for an hour) and returns the one whose id matches.
function buildIndycarMeta(id) {
    return indycar.listVideos(null).then((videos) => {
        const video = videos.find((v) => v.id === id);
        return video ? indycarVideoToMeta(video) : null;
    });
}

// IndyCar's "Full Race Replay" videos resolve to a YouTube `ytId` instead of
// a direct `url` (see providers/indycar.js's getVideoStreams for why) - the
// Stremio stream protocol supports both shapes, so this just passes through
// whichever one a given video actually produced.
function buildIndycarStreamResponse(id) {
    const videoPath = `/videos/${id.slice('indycar:'.length)}`;
    return indycar.getVideoStreams(videoPath).then((streams) => ({
        streams: streams.map((s) => {
            const stream = { name: s.name || 'IndyCar', title: s.quality || '' };
            if (s.ytId) stream.ytId = s.ytId;
            else stream.url = s.url;
            return stream;
        })
    })).catch((err) => {
        console.error(`[addon-server] IndyCar stream error for ${id}: ${err.message}`);
        return { streams: [] };
    });
}

// Merges the provider-embedded subtitles a stream already carries with the
// (possibly hash-matched) results from lib/subtitles.js, deduping by
// (lang, url) - the embedded ones are guaranteed to ship with this exact
// release, so they're kept even when a broader-language extra result exists
// for the same language.
function mergeSubtitles(embedded, extra) {
    const merged = embedded.slice();
    const seen = new Set(merged.map(s => `${(s.lang || '').toLowerCase()}|${s.url}`));
    for (const s of extra) {
        const key = `${(s.lang || '').toLowerCase()}|${s.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ url: s.url, lang: s.lang });
    }
    return merged;
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

            // Only the [PREFERRED] stream (the one most likely to actually
            // get played) gets a hash-matched subtitle lookup - hashing is a
            // couple of Range requests against the real file, so doing it
            // for every candidate would multiply that cost for no benefit.
            const preferred = streams.find(s => s.isPreferred);
            const extraSubsPromise = preferred
                ? subtitles.getSubtitles({
                    imdbId,
                    mediaType,
                    season,
                    episode,
                    videoUrl: preferred.url
                }).catch(err => {
                    console.error(`[addon-server] Subtitle lookup failed for ${imdbId}: ${err.message}`);
                    return [];
                })
                : Promise.resolve([]);

            return extraSubsPromise.then(extraSubs => {
                const stremioStreams = streams.map(s => {
                    const behaviorHints = { notWebReady: true };
                    if (s.headers && Object.keys(s.headers).length) {
                        behaviorHints.proxyHeaders = { request: s.headers };
                    }
                    const stream = {
                        url: s.url,
                        name: s.name || s.source || 'Stream',
                        title: [s.quality, s.size].filter(Boolean).join(' | ') || s.title || '',
                        behaviorHints
                    };
                    // Several providers (Castle, MovieBox, VidLink, ...) already
                    // extract subtitle tracks tied to this exact stream's own
                    // file - a better match than a generic lookup, since it's
                    // guaranteed to be the subtitle that ships with this
                    // specific release. Stremio's protocol names the field
                    // `lang`, but every provider except kickassanime.js calls
                    // it `language`.
                    let embedded = [];
                    if (Array.isArray(s.subtitles) && s.subtitles.length) {
                        embedded = s.subtitles
                            .filter(sub => sub && sub.url)
                            .map(sub => ({ url: sub.url, lang: sub.lang || sub.language || 'unknown' }));
                    }
                    const combined = s === preferred ? mergeSubtitles(embedded, extraSubs) : embedded;
                    if (combined.length) stream.subtitles = combined;
                    return stream;
                });
                return { streams: stremioStreams };
            });
        });
    }).catch(err => {
        console.error(`[addon-server] stream error for ${imdbId}: ${err.message}`);
        return { streams: [] };
    });
}

// Stremio requests the subtitles resource independently of any specific
// stream, so there's nothing to hash yet here - this is SubDL +
// non-hash-matched OpenSubtitles only, ordered by language preference. The
// per-[PREFERRED]-stream call in buildStreamResponse above is what adds
// hash-matching on top, once there's an actual file to hash.
function buildSubtitlesResponse(type, rawId) {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const [imdbId, seasonStr, episodeStr] = rawId.split(':');
    const season = seasonStr ? parseInt(seasonStr, 10) : null;
    const episode = episodeStr ? parseInt(episodeStr, 10) : null;

    if (mediaType === 'tv' && (!season || !episode)) {
        return Promise.resolve({ subtitles: [] });
    }

    return subtitles.getSubtitles({ imdbId, mediaType, season, episode })
        .then(subs => ({ subtitles: subs.map(s => ({ url: s.url, lang: s.lang })) }))
        .catch(err => {
            console.error(`[addon-server] subtitles error for ${imdbId}: ${err.message}`);
            return { subtitles: [] };
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
        const id = parts[4].replace(/\.json$/, '');

        if (id === `strmprov-foryou-${type}` && (type === 'movie' || type === 'series')) {
            return buildCatalog(profileId, type).then(metas => sendJson(res, 200, { metas }));
        }
        if (id === 'indycar-videos' && type === 'movie') {
            return buildIndycarCatalog().then(metas => sendJson(res, 200, { metas }));
        }
        return sendJson(res, 200, { metas: [] });
    }

    if (resource === 'meta' && parts.length >= 5) {
        const type = parts[3];
        const id = decodeURIComponent(parts[4]).replace(/\.json$/, '');
        if (id.startsWith('indycar:') && type === 'movie') {
            return buildIndycarMeta(id).then(meta => sendJson(res, 200, { meta }));
        }
        return sendJson(res, 200, { meta: null });
    }

    if (resource === 'subtitles' && parts.length >= 5) {
        const type = parts[3];
        const idWithExt = decodeURIComponent(parts.slice(4).join('/'));
        const id = idWithExt.replace(/\.json$/, '');
        if (type !== 'movie' && type !== 'series') {
            return sendJson(res, 200, { subtitles: [] });
        }
        return buildSubtitlesResponse(type, id).then(body => sendJson(res, 200, body));
    }

    if (resource === 'stream' && parts.length >= 5) {
        const type = parts[3];
        const idWithExt = decodeURIComponent(parts.slice(4).join('/'));
        const id = idWithExt.replace(/\.json$/, '');
        if (id.startsWith('indycar:')) {
            return buildIndycarStreamResponse(id).then(body => sendJson(res, 200, body));
        }
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
