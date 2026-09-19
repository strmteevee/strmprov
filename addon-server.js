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

// Installed before any other require() below so every console.log/error
// from this point on - including from providers/ and lib/* - is captured
// for the admin dashboard's server-logs panel, not just ones logged directly
// in this file.
const logBuffer = require('./lib/logBuffer');
logBuffer.install();

// There was no global crash guard anywhere in this codebase before this -
// a single unhandled error in ANY of the ~15 independently-written provider
// modules (several doing genuinely complex things: AES decryption, chained
// multi-step API calls) would silently kill the whole Node process. That's
// a real, structural risk distinct from anything about ranking/probing/
// subtitles: it would explain a request just dying mid-flight from the
// client's perspective (matching "starting stream" then nothing), and - if
// a process manager restarts the server afterward - would also silently
// wipe this process's in-memory log buffer, making the very history needed
// to diagnose it disappear. It also naturally gets MORE likely with MORE
// providers returning data for a given title, since more of their code
// actually runs. Logging and surviving here (rather than crashing) turns an
// invisible process death into a normal, visible error line in the exact
// same server-logs panel this was already built for.
process.on('uncaughtException', (err) => {
    console.error(`[addon-server] uncaughtException (process kept alive): ${err && err.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
    console.error(`[addon-server] unhandledRejection (process kept alive): ${reason && reason.stack || reason}`);
});

const aggregate = require('./lib/aggregate');
const tmdb = require('./lib/tmdb');
const profileStore = require('./lib/profileStore');
const gemini = require('./lib/gemini');
const subtitles = require('./lib/subtitles');
const indycar = require('./providers/indycar');
const f1 = require('./providers/f1');
const sportzx = require('./providers/sportzx');

const PORT = 3100;
const CATALOG_SEED_COUNT = 10;
const CATALOG_MIN_ITEMS = 30;
const CATALOG_MAX_ITEMS = 40;
const AI_CACHE_TTL_MS = 1000 * 60 * 60 * 24;

// Plain TMDB browse catalogs (genres, streaming services, popular/new/
// featured) - unlike "For You" above, these have no per-profile
// personalization signal at all, so they're built once globally and shared
// across every profile rather than cached per profileId.
const DISCOVER_CATALOG_MAX_ITEMS = 40;
const DISCOVER_CATALOG_TTL_MS = 1000 * 60 * 60 * 6; // 6h - browse lists move slowly
const discoverCatalogCache = new Map(); // catalog id -> { metas, timestamp }

function getOrBuildDiscoverCatalog(catalogId, builder) {
    const cached = discoverCatalogCache.get(catalogId);
    if (cached && Date.now() - cached.timestamp < DISCOVER_CATALOG_TTL_MS) {
        return Promise.resolve(cached.metas);
    }
    return builder().then(metas => {
        discoverCatalogCache.set(catalogId, { metas, timestamp: Date.now() });
        return metas;
    }).catch(err => {
        console.error(`[addon-server] Failed to build catalog "${catalogId}": ${err.message}`);
        return cached ? cached.metas : [];
    });
}

// By request: the 17 separate genre catalogs (34 with movie+series) were
// consolidated into fewer, more logically grouped categories, and Teen was
// dropped entirely. Each entry's movie/tv value is either one params object
// (a single /discover call) or an array of them (run separately and merged -
// only needed when a category spans two TMDB filter DIMENSIONS that can't be
// OR'd together in one request, e.g. a genre id and a keyword id at once;
// two ids of the SAME dimension, like two genres, are OR'd with a single
// pipe-joined with_genres/with_keywords value instead - both confirmed live
// against TMDB's /discover).
//
// TMDB genre ids differ between movies and TV, and TV doesn't even have a
// distinct genre for every category here - confirmed live against TMDB's own
// /genre/movie/list and /genre/tv/list. Action+Adventure and Sci-Fi+Fantasy
// are each already ONE combined TV genre on TMDB's side, which conveniently
// matches grouping them here. History and Horror/Thriller have no TV genre
// at all, so those fall back to TMDB keyword search (with_keywords) instead -
// the closest available approximation, not a perfect substitute. Sport isn't
// a real TMDB genre for either media type either, so it uses keyword search
// too (ids confirmed via TMDB's /search/keyword).
const GENRE_CATALOGS = [
    { slug: 'action-adventure', label: 'Action & Adventure', movie: { with_genres: '28|12' }, tv: { with_genres: '10759' } },
    { slug: 'scifi-fantasy', label: 'Sci-Fi & Fantasy', movie: { with_genres: '878|14' }, tv: { with_genres: '10765' } },
    // TMDB's Animation genre includes anime - excluded via the "anime"
    // keyword plus a belt-and-suspenders original_language filter below
    // (virtually all anime is JP-original; virtually no Western animation
    // is), since without_keywords alone doesn't catch everything.
    { slug: 'animation-family', label: 'Animation & Family', movie: { with_genres: '16|10751', without_keywords: '210024' }, tv: { with_genres: '16|10751', without_keywords: '210024' }, excludeOriginalLanguage: 'ja' },
    { slug: 'comedy', label: 'Comedy', movie: { with_genres: '35' }, tv: { with_genres: '35' } },
    { slug: 'crime-mystery', label: 'Crime & Mystery', movie: { with_genres: '80|9648' }, tv: { with_genres: '80|9648' } },
    { slug: 'drama', label: 'Drama', movie: { with_genres: '18' }, tv: { with_genres: '18' } },
    { slug: 'horror-thriller', label: 'Horror & Thriller', movie: { with_genres: '27|53' }, tv: { with_keywords: '315058|316362' } },
    // TV War has a real genre (War & Politics) but TV History doesn't (only a
    // keyword) - a genre id and a keyword id can't be OR'd in one /discover
    // call (different filter dimensions, always ANDed), so TV runs both as
    // separate queries and merges the results instead of one combined call.
    { slug: 'history-war', label: 'History & War', movie: { with_genres: '36|10752' }, tv: [{ with_genres: '10768' }, { with_keywords: '282633' }] },
    { slug: 'sport', label: 'Sport', movie: { with_keywords: '333328' }, tv: { with_keywords: '333328' } },
    { slug: 'western', label: 'Western', movie: { with_genres: '37' }, tv: { with_genres: '37' } }
];

// By request: the genre/browse/streaming catalogs above were surfacing a lot
// of Indian and other Asian content (TMDB's global popularity ranking favors
// Bollywood/Chinese/Korean titles heavily by raw view/vote counts) - this
// restricts every TMDB-driven browse catalog to North American and European
// content instead. with_origin_country (production country, not language) is
// confirmed live to filter correctly for both /discover/movie and
// /discover/tv, ANDed together with whatever genre/keyword filter a catalog
// already applies. Not an exact "Western" definition (South America, e.g.,
// is deliberately excluded, matching the original "america and europe"
// request), but a reasonable, adjustable list.
const WESTERN_ORIGIN_COUNTRIES = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'SE', 'NO', 'DK', 'FI', 'PT', 'AT', 'CH', 'PL', 'GR', 'CZ'];
const WESTERN_REGION_PARAMS = { with_origin_country: WESTERN_ORIGIN_COUNTRIES.join('|') };
// /discover isn't available for buildNewCatalog's now_playing/on_the_air
// lists (they're fixed endpoints, not filterable by with_origin_country) -
// those are post-filtered instead using origin_country (present on TV list
// results) or, for movies, original_language as the best available proxy
// (movie list results carry no origin_country field at all).
const WESTERN_LANGUAGES = new Set(['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'pl', 'el', 'cs', 'ro', 'hu']);
function isWesternListItem(item, mediaType) {
    if (mediaType === 'tv' && Array.isArray(item.origin_country) && item.origin_country.length) {
        return item.origin_country.some(c => WESTERN_ORIGIN_COUNTRIES.includes(c));
    }
    return WESTERN_LANGUAGES.has(item.original_language);
}

// One catalog pair (Movies/Series) per streaming service, by request - rather
// than the one combined catalog this used to be. TMDB provider ids below,
// watch_region 'US' - picked because it's the one region where TMDB actually
// has ids for all of these at once. Sky is UK-only on TMDB (no single region
// covers both Sky and these US-only services), so it's left out rather than
// adding a second, region-specific set of catalogs just for it.
const STREAMING_SERVICES = [
    { slug: 'netflix', label: 'Netflix', providerId: '8' },
    { slug: 'prime', label: 'Prime Video', providerId: '9' },
    { slug: 'disneyplus', label: 'Disney+', providerId: '337' },
    { slug: 'hulu', label: 'Hulu', providerId: '15' },
    { slug: 'max', label: 'Max', providerId: '1899' },
    { slug: 'appletv', label: 'Apple TV+', providerId: '350' },
    { slug: 'paramountplus', label: 'Paramount+', providerId: '2303' },
    { slug: 'peacock', label: 'Peacock', providerId: '386' }
];

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
        // Bumped whenever the manifest's own shape changes (new catalogs,
        // resources, etc.) - some Stremio-protocol clients key their cached
        // manifest/catalog data on this and won't notice new catalogs on an
        // existing install (even after a reinstall) unless it changes.
        version: '1.6.0',
        name: 'StrmProv',
        description: `Self-hosted multi-source streaming addon (profile ${profileId}) with a personalized "For You" catalog based on this profile's own watch history.`,
        logo: 'https://raw.githubusercontent.com/tapframe/nuvio-providers/main/Assets/Logo-2.png',
        // 'meta' is scoped to indycar:/f1: ids specifically, not declared
        // broadly - normal movies/series use real "tt" ids, which Cinemeta
        // (Nuvio's default metadata provider) already resolves fine. IndyCar
        // and F1/F2/F3/Academy videos use custom id schemes Cinemeta has no
        // way to recognize, so without this, opening one from the catalog
        // got stuck: Nuvio's normal flow fetches an item's meta before its
        // stream, nothing installed could answer that for those ids, and it
        // never reached /stream at all. Confirmed live as the actual cause
        // (for indycar: originally, and the same fix reused for f1:).
        resources: [
            'catalog', 'stream',
            // SportzX events are genuinely live/linear, not on-demand clips
            // like IndyCar/F1's, but 'movie' is used here anyway rather than
            // Stremio's own 'tv' catalog type - IndyCar/F1's 'movie' catalogs
            // are confirmed working in Nuvio's UI, while 'tv' was untested
            // and Nuvio's app surfaces are built around movie/series
            // browsing, not a separate live-channel guide screen; there's no
            // confirmation it renders a 'tv' catalog anywhere at all.
            { name: 'meta', types: ['movie'], idPrefixes: ['indycar:', 'f1:', 'sportzx:'] },
            // Scoped to real tt-id content only - neither IndyCar's nor
            // F1/F2/F3/Academy's/SportzX's own custom id schemes have a
            // subtitle concept, and Cinemeta already handles meta for the
            // tt-id ones, so there's nothing for this resource to add there.
            { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }
        ],
        types: ['movie', 'series'],
        catalogs: [
            { type: 'movie', id: 'strmprov-foryou-movie', name: 'For You' },
            { type: 'series', id: 'strmprov-foryou-series', name: 'For You' },
            // Plain TMDB browse catalogs - no personalization, same for every
            // profile (see the DISCOVER_CATALOG_* constants/builders above).
            { type: 'movie', id: 'strmprov-new-movie', name: 'New' },
            { type: 'series', id: 'strmprov-new-series', name: 'New' },
            ...GENRE_CATALOGS.flatMap(g => [
                { type: 'movie', id: `genre-${g.slug}-movie`, name: `${g.label} Movies` },
                { type: 'series', id: `genre-${g.slug}-series`, name: `${g.label} Series` }
            ]),
            ...STREAMING_SERVICES.flatMap(s => [
                { type: 'movie', id: `streaming-${s.slug}-movie`, name: `${s.label} Movies` },
                { type: 'series', id: `streaming-${s.slug}-series`, name: `${s.label} Series` }
            ]),
            {
                type: 'movie',
                id: 'indycar-videos',
                name: 'IndyCar Extended Highlights'
                // By request: only "Extended Race Highlights" now, across
                // every race, newest first - no genre filter needed since
                // there's only the one category left. See
                // buildIndycarCatalog below for the fixed filter.
            },
            // Separate catalogs per series, by request - each backed by the
            // same providers/f1.js crawl, filtered to that one series (see
            // buildF1Catalog below).
            { type: 'movie', id: 'f1-highlights', name: 'F1 Race Highlights' },
            { type: 'movie', id: 'f2-highlights', name: 'F2 Race Highlights' },
            { type: 'movie', id: 'f3-highlights', name: 'F3 Race Highlights' },
            { type: 'movie', id: 'f1academy-highlights', name: 'F1 Academy Highlights' },
            // One combined catalog rather than one per sport - see
            // buildSportzxCatalog below for why. type: 'movie', not 'tv' -
            // see the meta resource entry above for why.
            { type: 'movie', id: 'sportzx-live', name: 'SportzX Live' }
        ],
        idPrefixes: ['tt', 'indycar:', 'f1:', 'sportzx:'],
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

// Genre/keyword browse catalog (see GENRE_CATALOGS above). Fetches double
// the target count up front since both the original_language filter and
// tmdbItemToMeta's own imdb-lookup attrition (some TMDB titles have no
// imdb_id at all) can both drop items after the fact - same "aim higher than
// the minimum" reasoning as regenerateCatalog's own comment below.
function buildDiscoverGenreCatalog(def, mediaType, type) {
    // Most categories are one /discover call; a few (see history-war's tv
    // entry above) need two separate calls merged together because they mix
    // filter dimensions that can't be OR'd in a single request.
    const rawParamSets = mediaType === 'tv' ? def.tv : def.movie;
    const paramSets = Array.isArray(rawParamSets) ? rawParamSets : [rawParamSets];
    return Promise.all(paramSets.map(p =>
        tmdb.discoverMany(mediaType, Object.assign({}, p, WESTERN_REGION_PARAMS), DISCOVER_CATALOG_MAX_ITEMS * 2)
    )).then(lists => {
        const seen = new Set();
        const merged = [];
        for (const list of lists) {
            for (const item of list) {
                const id = String(item.id);
                if (seen.has(id)) continue;
                seen.add(id);
                merged.push(item);
            }
        }
        merged.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        const filtered = def.excludeOriginalLanguage
            ? merged.filter(item => item.original_language !== def.excludeOriginalLanguage)
            : merged;
        return Promise.all(filtered.slice(0, DISCOVER_CATALOG_MAX_ITEMS).map(item => tmdbItemToMeta(item, mediaType, type)))
            .then(metas => metas.filter(Boolean));
    });
}

// A movie's overall `release_date` field (what now_playing sorts/filters by,
// and what /discover's primary_release_date.gte/lte filters check) reflects
// its EARLIEST/theatrical release, not its digital one - confirmed live that
// a movie still theatrical-only, with only a scheduled FUTURE digital date on
// record, still passes a with_release_type=4 discover filter and any coarse
// range built on primary_release_date (e.g. a movie theatrical Jul 31 with a
// digital date of Sep 29 still shows up in a query bounded to "on or before
// Sep 19"). The only reliable way to know a movie is actually available
// digitally today is to read its own real per-region release_dates (type 4 =
// Digital) and check that specific date has actually passed.
function getDigitalReleaseDate(releaseDatesResults) {
    const nowIso = new Date().toISOString();
    const regions = releaseDatesResults || [];
    const us = regions.find(r => r.iso_3166_1 === 'US');
    const candidates = us ? [us] : regions;
    let best = null;
    for (const region of candidates) {
        for (const rd of region.release_dates || []) {
            if (rd.type !== 4 || rd.release_date > nowIso) continue;
            if (!best || rd.release_date > best) best = rd.release_date;
        }
    }
    return best;
}

// "New" - by request, only already-digitally-released movies (no
// theatrical-only titles), sorted newest first. TV has no theatrical/digital
// concept at all, so "currently airing" (on_the_air) is already the right
// definition of "new" there and needs none of the extra checking below.
function buildNewCatalog(mediaType, type) {
    if (mediaType === 'tv') {
        return tmdb.getList('tv', 'on_the_air', DISCOVER_CATALOG_MAX_ITEMS * 2).then(list => {
            const seen = new Set();
            const merged = [];
            for (const item of list) {
                const id = String(item.id);
                if (seen.has(id) || !item.poster_path || !isWesternListItem(item, 'tv')) continue;
                seen.add(id);
                merged.push(item);
            }
            merged.sort((a, b) => (b.first_air_date || '').localeCompare(a.first_air_date || ''));
            return Promise.all(merged.slice(0, DISCOVER_CATALOG_MAX_ITEMS).map(item => tmdbItemToMeta(item, 'tv', type)))
                .then(metas => metas.filter(Boolean));
        });
    }

    // Movies: with_release_type=4 + region narrows candidates to ones with
    // SOME US digital release record and the primary_release_date range is
    // just a coarse popularity-pool trimmer (not a trustworthy digital-date
    // filter, per getDigitalReleaseDate's comment above) - the real check
    // happens per-candidate below. A wide 180-day window plus a 3x candidate
    // pool leaves enough headroom for the two layers of attrition that
    // follow (not-yet-digital exclusion, then the usual imdb-lookup misses).
    const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 180).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const params = Object.assign({
        with_release_type: '4',
        region: 'US',
        sort_by: 'popularity.desc',
        'primary_release_date.gte': since,
        'primary_release_date.lte': today
    }, WESTERN_REGION_PARAMS);

    return tmdb.discoverMany('movie', params, DISCOVER_CATALOG_MAX_ITEMS * 3).then(candidates => {
        const usable = candidates.filter(item => item.poster_path && isWesternListItem(item, 'movie'));
        return Promise.all(usable.map(item =>
            tmdb.getReleaseDates(item.id).then(rd => ({ item, digitalDate: getDigitalReleaseDate(rd) }))
        ));
    }).then(withDates => {
        const released = withDates.filter(x => x.digitalDate);
        released.sort((a, b) => b.digitalDate.localeCompare(a.digitalDate));
        return Promise.all(released.slice(0, DISCOVER_CATALOG_MAX_ITEMS).map(x => tmdbItemToMeta(x.item, 'movie', type)))
            .then(metas => metas.filter(Boolean));
    });
}

// "Movies and series catalog for streaming services like netflix, sky,
// prime, hulu etc" - one combined catalog per type, not one per service (see
// STREAMING_SERVICE_PARAMS above for which providers/region).
function buildStreamingServiceCatalog(service, mediaType, type) {
    const params = Object.assign({
        with_watch_providers: service.providerId,
        watch_region: 'US',
        with_watch_monetization_types: 'flatrate'
    }, WESTERN_REGION_PARAMS);
    return tmdb.discoverMany(mediaType, params, DISCOVER_CATALOG_MAX_ITEMS * 2).then(items =>
        Promise.all(items.slice(0, DISCOVER_CATALOG_MAX_ITEMS).map(item => tmdbItemToMeta(item, mediaType, type)))
            .then(metas => metas.filter(Boolean))
    );
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
        // v.raceNumber is that race's 1-indexed position in its own
        // season's schedule (see providers/indycar.js) - shown here so the
        // catalog/hero title reads e.g. "Race 5: Extended Race
        // Highlights: ...", making it clear where a race falls in the
        // season without having to open it first.
        name: v.raceNumber ? `Race ${v.raceNumber}: ${v.title}` : v.title,
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
// The one "Auto (HLS)" rendition JW Player offers adapts to the viewer's
// real bandwidth mid-playback, unlike the other, fixed-resolution
// renditions offered alongside it - marking it [PREFERRED] steers Nuvio to
// default to it, matching the convention lib/aggregate.js already uses for
// regular movie/series streams.
function withPreferredHls(streams, fallbackName) {
    // Only the first HLS match gets tagged - F1's Brightcove response lists
    // both an http:// and an https:// copy of the same "Auto (HLS)" manifest
    // as separate entries, and tagging both would put two [PREFERRED]
    // streams in the same list instead of the usual convention of exactly one.
    let tagged = false;
    return streams.map((s) => {
        const isPreferred = !tagged && s.quality === 'Auto (HLS)';
        if (isPreferred) tagged = true;
        const name = s.name || fallbackName;
        return Object.assign({}, s, { name: isPreferred ? `[PREFERRED] ${name}` : name });
    });
}

function buildIndycarStreamResponse(id) {
    const videoPath = `/videos/${id.slice('indycar:'.length)}`;
    return indycar.getVideoStreams(videoPath).then((streams) => ({
        streams: withPreferredHls(streams, 'IndyCar').map((s) => {
            const stream = { name: s.name, title: s.quality || '' };
            if (s.ytId) stream.ytId = s.ytId;
            else stream.url = s.url;
            return stream;
        })
    })).catch((err) => {
        console.error(`[addon-server] IndyCar stream error for ${id}: ${err.message}`);
        return { streams: [] };
    });
}

// Shared by the catalog and meta builders below, same shape as
// indycarVideoToMeta - a Stremio Meta Object is a superset of a catalog
// preview item.
function f1VideoToMeta(v) {
    return {
        id: v.id,
        type: 'movie',
        name: v.title,
        poster: v.poster,
        description: v.description,
        releaseInfo: v.timestamp ? new Date(v.timestamp).toISOString().substring(0, 10) : undefined
    };
}

// series: 'f1' | 'f2' | 'f3' | 'academy' - one separate catalog each, by
// request. providers/f1.js's listVideos() already returns newest-first.
function buildF1Catalog(series) {
    return f1.listVideos(series).then((videos) => videos.map(f1VideoToMeta));
}

// Same reasoning as buildIndycarMeta above - Cinemeta has no way to resolve
// our own f1: id scheme, so this closes that gap for the manifest's scoped
// `meta` resource entry.
function buildF1Meta(id) {
    return f1.listVideos(null).then((videos) => {
        const video = videos.find((v) => v.id === id);
        return video ? f1VideoToMeta(video) : null;
    });
}

function buildF1StreamResponse(id) {
    const videoId = id.slice('f1:'.length);
    return f1.getVideoStreams(videoId).then((streams) => ({
        streams: withPreferredHls(streams, 'F1').map((s) => ({ name: s.name, title: s.quality || '', url: s.url }))
    })).catch((err) => {
        console.error(`[addon-server] F1 stream error for ${id}: ${err.message}`);
        return { streams: [] };
    });
}

// Same team-vs-team / plain-title display logic and 🔴/🔜/✅ status prefix
// the real SportzX app itself uses for its own event list (recovered from
// its decompiled source), so the catalog reads the same way the app's own
// would - live events sort first, then upcoming, then everything else.
function sportzxEventStatus(event) {
    const info = event && event.eventInfo;
    if (!info) return '';
    const start = info.startTime ? Date.parse(info.startTime.replace(' ', 'T').replace(/\+0000$/, 'Z')) : NaN;
    const end = info.endTime ? Date.parse(info.endTime.replace(' ', 'T').replace(/\+0000$/, 'Z')) : NaN;
    const now = Date.now();
    if (!Number.isNaN(end) && now >= end) return '✅';
    if (Number.isNaN(start) || now < start) return Number.isNaN(start) ? '' : '\u{1F51C}';
    return '\u{1F534}';
}
function sportzxDisplayTitle(event) {
    const info = event && event.eventInfo;
    if (info && info.teamA && info.teamB) {
        return info.teamA === info.teamB ? info.teamA : `${info.teamA} vs ${info.teamB}`;
    }
    return event.title;
}
function sportzxStatusRank(event) {
    const status = sportzxEventStatus(event);
    if (status === '\u{1F534}') return 0; // live
    if (status === '\u{1F51C}') return 1; // upcoming
    if (status === '✅') return 2; // ended
    return 3;
}
function sportzxEventToMeta(event) {
    const status = sportzxEventStatus(event);
    const title = sportzxDisplayTitle(event);
    const info = event.eventInfo || {};
    return {
        id: `sportzx:${event.id}`,
        type: 'movie',
        name: status ? `${status} ${title}` : title,
        poster: info.eventBanner || info.teamAFlag || undefined,
        description: [info.eventName, info.startTime ? `Starts: ${info.startTime}` : null].filter(Boolean).join('\n') || undefined
    };
}

// One combined catalog rather than one per sport (events.json's own `cat`
// field has dozens of distinct values, including several that are really
// just regional channel bundles, not sports) - sorted live-first the same
// way the app's own home screen is, so the catalog opens with what's
// actually on right now instead of an alphabetical or arrival-order list.
function buildSportzxCatalog() {
    return sportzx.listEvents().then((events) => {
        const sorted = events.slice().sort((a, b) => {
            const rankDiff = sportzxStatusRank(a) - sportzxStatusRank(b);
            if (rankDiff !== 0) return rankDiff;
            const aStart = a.eventInfo && a.eventInfo.startTime ? Date.parse(a.eventInfo.startTime.replace(' ', 'T').replace(/\+0000$/, 'Z')) : Infinity;
            const bStart = b.eventInfo && b.eventInfo.startTime ? Date.parse(b.eventInfo.startTime.replace(' ', 'T').replace(/\+0000$/, 'Z')) : Infinity;
            return (Number.isNaN(aStart) ? Infinity : aStart) - (Number.isNaN(bStart) ? Infinity : bStart);
        });
        return sorted.map(sportzxEventToMeta);
    });
}

// Same reasoning as buildIndycarMeta/buildF1Meta above - Cinemeta has no way
// to resolve our own sportzx: id scheme.
function buildSportzxMeta(id) {
    const eventId = id.slice('sportzx:'.length);
    return sportzx.getEvent(eventId).then((event) => (event ? sportzxEventToMeta(event) : null));
}

function buildSportzxStreamResponse(id) {
    const eventId = id.slice('sportzx:'.length);
    return sportzx.getEventStreams(eventId).then((streams) => ({
        streams: streams.map((s) => {
            const behaviorHints = { notWebReady: true };
            if (s.headers && Object.keys(s.headers).length) behaviorHints.proxyHeaders = { request: s.headers };
            return { name: s.name, title: s.quality || 'Live', url: s.url, behaviorHints };
        })
    })).catch((err) => {
        console.error(`[addon-server] SportzX stream error for ${id}: ${err.message}`);
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
        merged.push({ url: s.url, lang: s.lang, language: s.lang, name: s.name });
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

            const preferred = streams.find(s => s.isPreferred);
            if (preferred) {
                console.log(`[addon-server] [PREFERRED] pick for ${imdbId}:${season || ''}:${episode || ''} -> ${preferred.source} "${preferred.name}" score=${preferred.score} lowConfidence=${!!preferred.lowConfidence} url=${preferred.url}`);
            }

            // Only the [PREFERRED] stream (the one most likely to actually
            // get played) gets a hash-matched subtitle lookup - hashing is a
            // couple of Range requests against the real file, so doing it
            // for every candidate would multiply that cost for no benefit.
            // This was removed for a while while chasing an autoplay-next-
            // episode bug that turned out to be a Nuvio client-side issue
            // (fixed in a later Nuvio update, confirmed live) - restored now
            // that the actual cause is known to be unrelated to this.
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
                    // specific release. Every provider except kickassanime.js
                    // calls the language field `language` rather than `lang`.
                    // Nuvio itself (see DOCUMENTATION.md's "Subtitle Support")
                    // shows a subtitle's own `name` field as its selector
                    // label, not `lang`/`language` - confirmed live that
                    // omitting `name` made every subtitle show up with the
                    // same generic fallback label instead of its actual
                    // language, so it's set here too. Providers vary in
                    // whether their own `lang`/`language` value is a short
                    // code ("en") or already a full word ("English") -
                    // lib/subtitles.js's languageName() only recognizes short
                    // codes, so a longer value is assumed already-readable
                    // and just capitalized instead.
                    let embedded = [];
                    if (Array.isArray(s.subtitles) && s.subtitles.length) {
                        embedded = s.subtitles
                            .filter(sub => sub && sub.url)
                            .map(sub => {
                                const lang = sub.lang || sub.language || 'unknown';
                                const name = lang.length <= 3
                                    ? subtitles.languageName(lang)
                                    : lang.charAt(0).toUpperCase() + lang.slice(1);
                                return { url: sub.url, lang, language: lang, name };
                            });
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

// Stremio requests this resource independently of any specific stream, so
// there's nothing to hash yet here - this is SubDL + non-hash-matched
// OpenSubtitles only, ordered by language preference. The
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
        .then(subs => ({ subtitles: subs.map(s => ({ url: s.url, lang: s.lang, language: s.lang, name: s.name })) }))
        .catch(err => {
            console.error(`[addon-server] subtitles error for ${imdbId}: ${err.message}`);
            return { subtitles: [] };
        });
}

function notFound(res) {
    sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    console.log(`${req.method} ${req.url}`);
    // Logged separately from the request-received line above (which fires
    // immediately) so the two can be matched up by URL in the logs panel to
    // see how long THIS server actually took to answer a given request -
    // confirmed live this project's own dev-machine timing doesn't
    // necessarily reflect the Pi's real-world latency to third-party APIs
    // (SubDL/OpenSubtitles for subtitles, TMDB, the many stream providers),
    // so this is what actually answers "was the server slow enough to make
    // Nuvio time out and retry" instead of guessing from a different machine.
    res.on('finish', () => {
        console.log(`  -> ${res.statusCode} ${req.url} (${Date.now() - startedAt}ms)`);
    });

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

    // /logs?limit=200 - read by admin-server.js's own /api/logs proxy, same
    // pattern as its existing catalog-test proxy - lets the admin dashboard
    // show this process's own console output without SSH/pm2/journalctl
    // access.
    if (parts[0] === 'logs' && parts.length === 1 && req.method === 'GET') {
        const limit = parseInt(parsedUrl.searchParams.get('limit'), 10) || 300;
        return sendJson(res, 200, { lines: logBuffer.getLines(limit) });
    }
    // /logs/clear - the admin dashboard's manual "Clear logs" button, proxied
    // the same way as the read above (see admin-server.js's handleClearLogs).
    if (parts[0] === 'logs' && parts[1] === 'clear' && parts.length === 2 && req.method === 'POST') {
        logBuffer.clear('manual (admin dashboard)');
        return sendJson(res, 200, { cleared: true });
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
        const f1CatalogSeries = { 'f1-highlights': 'f1', 'f2-highlights': 'f2', 'f3-highlights': 'f3', 'f1academy-highlights': 'academy' }[id];
        if (f1CatalogSeries && type === 'movie') {
            return buildF1Catalog(f1CatalogSeries).then(metas => sendJson(res, 200, { metas }));
        }
        if (id === 'sportzx-live' && type === 'movie') {
            return buildSportzxCatalog().then(metas => sendJson(res, 200, { metas }));
        }
        const newCatalogType = { 'strmprov-new-movie': 'movie', 'strmprov-new-series': 'series' }[id];
        if (newCatalogType && type === newCatalogType) {
            const mediaType = type === 'series' ? 'tv' : 'movie';
            return getOrBuildDiscoverCatalog(id, () => buildNewCatalog(mediaType, type)).then(metas => sendJson(res, 200, { metas }));
        }
        const streamingMatch = STREAMING_SERVICES.find(s => id === `streaming-${s.slug}-${type}`);
        if (streamingMatch && (type === 'movie' || type === 'series')) {
            const mediaType = type === 'series' ? 'tv' : 'movie';
            return getOrBuildDiscoverCatalog(id, () => buildStreamingServiceCatalog(streamingMatch, mediaType, type)).then(metas => sendJson(res, 200, { metas }));
        }
        const genreMatch = GENRE_CATALOGS.find(g => id === `genre-${g.slug}-${type}`);
        if (genreMatch && (type === 'movie' || type === 'series')) {
            const mediaType = type === 'series' ? 'tv' : 'movie';
            return getOrBuildDiscoverCatalog(id, () => buildDiscoverGenreCatalog(genreMatch, mediaType, type)).then(metas => sendJson(res, 200, { metas }));
        }
        return sendJson(res, 200, { metas: [] });
    }

    if (resource === 'meta' && parts.length >= 5) {
        const type = parts[3];
        const id = decodeURIComponent(parts[4]).replace(/\.json$/, '');
        if (id.startsWith('indycar:') && type === 'movie') {
            return buildIndycarMeta(id).then(meta => sendJson(res, 200, { meta }));
        }
        if (id.startsWith('f1:') && type === 'movie') {
            return buildF1Meta(id).then(meta => sendJson(res, 200, { meta }));
        }
        if (id.startsWith('sportzx:') && type === 'movie') {
            return buildSportzxMeta(id).then(meta => sendJson(res, 200, { meta }));
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
        if (id.startsWith('f1:')) {
            return buildF1StreamResponse(id).then(body => sendJson(res, 200, body));
        }
        if (id.startsWith('sportzx:')) {
            return buildSportzxStreamResponse(id).then(body => sendJson(res, 200, body));
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

    // Both crawls' own stale-while-revalidate cache only blocks a request on
    // a true cold start - the very first crawl after this process boots -
    // and that first crawl takes several to a dozen-plus seconds even
    // fetched concurrently. Confirmed live this was long enough that Nuvio's
    // own catalog-fetch timeout gave up before it finished, so the F1
    // catalogs existed and worked (a patient curl got a real answer) but
    // never actually appeared in the app. Kicking both crawls off here,
    // right at startup, means that cold start happens during server boot
    // instead of during a real user's first request - by the time Nuvio
    // gets around to asking for either catalog, the cache is normally
    // already warm.
    indycar.listVideos(null).catch((err) => console.error(`[addon-server] IndyCar cache warm-up failed: ${err.message}`));
    f1.listVideos(null).catch((err) => console.error(`[addon-server] F1 cache warm-up failed: ${err.message}`));
    // Same reasoning as the two crawls above - SportzX's cold start is a
    // Firebase Remote Config round trip plus a decrypt, not a multi-page
    // crawl, but it's still real network latency (and, confirmed live
    // during development, this specific backend can be slow or transiently
    // unreachable) that a real user's first catalog open shouldn't have to
    // wait through.
    sportzx.listEvents().catch((err) => console.error(`[addon-server] SportzX cache warm-up failed: ${err.message}`));
});
