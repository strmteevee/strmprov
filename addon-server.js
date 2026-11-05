// Stremio/Nuvio addon protocol server for this repo's providers.
//
// This is a DIFFERENT thing from server.js's /api/streams: that's a custom
// JSON API meant for StreamAPI's local Nuvio plugin. This instead speaks the
// real Stremio addon protocol (manifest.json + /catalog + /stream), so it
// can be installed directly as an addon in Nuvio (or Stremio itself) with no
// local plugin file needed at all.
//
// Routes: GET /manifest.json, /catalog/:type/:id.json, /meta/:type/:id.json,
// /stream/:type/:id.json and /subtitles/:type/:id.json. Ranking the streams is
// left to the client (OmniStream does its own).

try { process.loadEnvFile('.env'); } catch (e) { /* no .env file - fine, the subtitle keys are optional */ }

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
const subtitles = require('./lib/subtitles');
const indycar = require('./providers/indycar');
const f1 = require('./providers/f1');
const youtubeChannel = require('./providers/youtube-channel');

const PORT = 3100;

// Plain TMDB browse catalogs (genres, streaming services, popular/new/
// featured), built once and cached.
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

function buildManifest() {
    return {
        id: 'com.strmprov.addon',
        // Bumped whenever the manifest's own shape changes (new catalogs,
        // resources, etc.) - some Stremio-protocol clients key their cached
        // manifest/catalog data on this and won't notice new catalogs on an
        // existing install (even after a reinstall) unless it changes.
        version: manifestVersion(MANIFEST_BASE_VERSION),
        name: 'StrmProv',
        description: 'Self-hosted multi-source streaming addon with subtitles.',
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
            // The live catalogs (GT World Live, iRacing Live) are
            // Stremio 'tv', by request (2026-10-19), so clients with a separate
            // live page put them there. Before that they were 'movie' because
            // it was unconfirmed whether Nuvio shows 'tv' catalogs at all.
            // 'tt' ids added by request 2026-09-21: Cinemeta (and every other
            // public meta addon tried) had no metadata at all for a real,
            // valid, recently-released title (tt8814476 - confirmed live via
            // TMDB's own /find that it's a real movie, just too new for those
            // addons' own databases to have caught up on yet). This addon
            // already has full TMDB access for every stream lookup, so it can
            // fill that gap itself - a TMDB-backed fallback for any movie/
            // series 'tt' id, not just this addon's own custom catalogs.
            { name: 'meta', types: ['movie', 'series', 'tv'], idPrefixes: ['tt', 'indycar:', 'f1:', 'ytlive:'] },
            // Scoped to real tt-id content only - neither IndyCar's nor
            // F1/F2/F3/Academy's own custom id schemes have a
            // subtitle concept, and Cinemeta already handles meta for the
            // tt-id ones, so there's nothing for this resource to add there.
            { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }
        ],
        types: ['movie', 'series', 'tv'],
        catalogs: buildCatalogs(),
        idPrefixes: ['tt', 'indycar:', 'f1:', 'ytlive:'],
        behaviorHints: { configurable: false, configurationRequired: false }
    };
}

function buildCatalogs() {
    return [
        // Plain TMDB browse catalogs (see the DISCOVER_CATALOG_* constants/
        // builders above).
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
        // YouTube channel catalogs - only the channels switched on in the
        // admin dashboard (see YOUTUBE_CATALOGS below).
        ...enabledYoutubeCatalogs().map(({ type, id, name }) => ({ type, id, name }))
    ];
}

// YouTube channels' "Live" tabs (providers/youtube-channel.js): what is live /
// scheduled right now, and the channel's finished race broadcasts as a
// replay catalog. Each channel can be switched off from the admin dashboard,
// which drops its catalogs from the manifest and empties them.
const YOUTUBE_CATALOGS = [
    { type: 'tv', id: 'gtworld-live', name: 'GT World Live', kind: 'live', channel: 'gtworld' },
    { type: 'movie', id: 'gtworld-races', name: 'GT World Races', kind: 'races', channel: 'gtworld' },
    { type: 'tv', id: 'iracing-live', name: 'iRacing Live', kind: 'live', channel: 'iracing' },
    { type: 'movie', id: 'iracing-races', name: 'iRacing Races', kind: 'races', channel: 'iracing' },
    // DTM has no live streams, only highlight videos.
    { type: 'movie', id: 'dtm-highlights', name: 'DTM Highlights', kind: 'highlights', channel: 'dtm' }
];
function enabledYoutubeCatalogs() {
    return YOUTUBE_CATALOGS.filter((c) => youtubeChannel.isChannelEnabled(c.channel));
}
// Clients cache a manifest by version, so switching a channel on/off has to
// change it: the patch number is the switch file's revision counter.
const MANIFEST_BASE_VERSION = '1.16';
function manifestVersion(base) {
    return `${base}.${youtubeChannel.settingsRevision()}`;
}

// TMDB list items don't carry an imdb_id (only the movie/tv detail and
// external_ids endpoints do), so each one needs its own follow-up lookup -
// getImdbId() caches those across catalog rebuilds so this isn't a full
// N-lookup cost every single time.
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

// TMDB's own genre_ids on a discover result are ordered, with the first one
// generally the title's most defining genre (confirmed live: "Spider-Man:
// Brand New Day" matches an Action|Adventure query via genre 28, but its own
// genre_ids are [878, 28, 12] - Sci-Fi is actually listed first). By request:
// used to limit a title showing up in every genre catalog it happens to
// match (a genre-soup blockbuster could otherwise appear in Action &
// Adventure AND Sci-Fi & Fantasy AND Comedy simultaneously) - only kept in a
// genre category when that category's own genre set contains the title's
// PRIMARY (first-listed) genre, so it lands in whichever one it's really
// mainly about.
//
// Only applies where every filter dimension for this mediaType is a real
// TMDB genre (with_genres) - a category mixing in a keyword (with_keywords),
// like Sport, Teen, or history-war's TV fallback, has candidates with no
// matching "genre" concept to check primacy against at all, so those are
// left unfiltered rather than wrongly excluding legitimate matches.
function extractGenreIds(paramSets) {
    const ids = new Set();
    for (const p of paramSets) {
        if (p && p.with_genres) {
            for (const id of String(p.with_genres).split('|')) ids.add(id.trim());
        }
    }
    return ids;
}
function isPrimaryGenreMatch(item, genreIds) {
    return Array.isArray(item.genre_ids) && item.genre_ids.length > 0 && genreIds.has(String(item.genre_ids[0]));
}

// Genre/keyword browse catalog (see GENRE_CATALOGS above). Fetches triple the
// target count up front for genre categories (double for keyword-only ones)
// since the primary-genre filter above, the original_language filter, and
// tmdbItemToMeta's own imdb-lookup attrition (some TMDB titles have no
// imdb_id at all) can all drop items after the fact - same "aim higher than
// the minimum" reasoning as regenerateCatalog's own comment below.
function buildDiscoverGenreCatalog(def, mediaType, type) {
    // Most categories are one /discover call; a few (see history-war's tv
    // entry above) need two separate calls merged together because they mix
    // filter dimensions that can't be OR'd in a single request.
    const rawParamSets = mediaType === 'tv' ? def.tv : def.movie;
    const paramSets = Array.isArray(rawParamSets) ? rawParamSets : [rawParamSets];
    const hasKeywordParam = paramSets.some(p => p && p.with_keywords);
    const ownGenreIds = hasKeywordParam ? null : extractGenreIds(paramSets);
    const poolMultiplier = ownGenreIds && ownGenreIds.size > 0 ? 3 : 2;
    return Promise.all(paramSets.map(p =>
        tmdb.discoverMany(mediaType, Object.assign({}, p, WESTERN_REGION_PARAMS), DISCOVER_CATALOG_MAX_ITEMS * poolMultiplier)
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
        let filtered = ownGenreIds && ownGenreIds.size > 0
            ? merged.filter(item => isPrimaryGenreMatch(item, ownGenreIds))
            : merged;
        if (def.excludeOriginalLanguage) {
            filtered = filtered.filter(item => item.original_language !== def.excludeOriginalLanguage);
        }
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

// IndyCar videos have no TMDB entry - this is a plain, static catalog.
// `releaseInfo`
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
function withStreamNames(streams, fallbackName) {
    return streams.map((s) => Object.assign({}, s, { name: s.name || fallbackName }));
}

function buildIndycarStreamResponse(id) {
    const videoPath = `/videos/${id.slice('indycar:'.length)}`;
    return indycar.getVideoStreams(videoPath).then((streams) => ({
        streams: withStreamNames(streams, 'IndyCar').map((s) => {
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
        streams: withStreamNames(streams, 'F1').map((s) => ({ name: s.name, title: s.quality || '', url: s.url }))
    })).catch((err) => {
        console.error(`[addon-server] F1 stream error for ${id}: ${err.message}`);
        return { streams: [] };
    });
}

// TMDB-backed meta fallback for real 'tt' ids - added by request after
// Cinemeta (and every other public meta addon tried) came up empty for a
// genuinely real, recently-released movie (tt8814476) that just hadn't been
// indexed by those addons' own databases yet. Cached for a few hours since a
// series' episode list (buildSeriesVideos below) costs one TMDB request per
// season - no reason to redo that on every meta request for the same show.
const TMDB_META_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const tmdbMetaCache = new Map(); // "type:imdbId" -> { meta, timestamp }

function tmdbCreditNames(details, job) {
    const list = job === 'cast' ? (details.credits && details.credits.cast) : (details.credits && details.credits.crew);
    if (!Array.isArray(list)) return [];
    if (job === 'cast') return list.slice(0, 10).map(c => c.name).filter(Boolean);
    return list.filter(c => c.job === 'Director').map(c => c.name).filter(Boolean);
}

// A series meta with no `videos` array gives Stremio no way to pick an
// episode at all, so this fetches every season's episode list (in parallel -
// most shows have few enough seasons that this is cheap) and flattens them
// into Stremio's own video-id convention ("tt...:season:episode", the same
// shape buildStreamResponse already expects on the way back in).
function buildSeriesVideos(tmdbId, imdbId, details) {
    const seasons = Array.isArray(details.seasons) ? details.seasons.filter(s => s.season_number > 0) : [];
    return Promise.all(seasons.map(s => tmdb.getSeasonEpisodes(tmdbId, s.season_number))).then(seasonResults => {
        const videos = [];
        seasonResults.forEach((seasonData, i) => {
            if (!seasonData || !Array.isArray(seasonData.episodes)) return;
            const seasonNum = seasons[i].season_number;
            for (const ep of seasonData.episodes) {
                videos.push({
                    id: `${imdbId}:${seasonNum}:${ep.episode_number}`,
                    title: ep.name || `Episode ${ep.episode_number}`,
                    season: seasonNum,
                    episode: ep.episode_number,
                    released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
                    overview: ep.overview || undefined,
                    thumbnail: ep.still_path ? tmdb.posterUrl(ep.still_path) : undefined
                });
            }
        });
        return videos;
    });
}

function buildTmdbFallbackMeta(imdbId, type) {
    const cacheKey = `${type}:${imdbId}`;
    const cached = tmdbMetaCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TMDB_META_CACHE_TTL_MS) {
        return Promise.resolve(cached.meta);
    }
    const mediaType = type === 'series' ? 'tv' : 'movie';
    return tmdb.findByImdbId(imdbId).then(found => {
        // found.mediaType comes from TMDB's own /find, independent of the
        // `type` the client asked with - if they disagree, this imdbId isn't
        // actually the type being requested (e.g. a movie id requested as a
        // series), and there's nothing real to return.
        if (!found || found.mediaType !== mediaType) return null;
        return tmdb.getDetailsWithCredits(found.tmdbId, mediaType).then(details => {
            const meta = {
                id: imdbId,
                type,
                name: mediaType === 'tv' ? details.name : details.title,
                poster: tmdb.posterUrl(details.poster_path),
                background: tmdb.backdropUrl(details.backdrop_path) || undefined,
                description: details.overview || undefined,
                releaseInfo: (details.release_date || details.first_air_date || '').substring(0, 4) || undefined,
                imdbRating: details.vote_average ? details.vote_average.toFixed(1) : undefined,
                genres: Array.isArray(details.genres) ? details.genres.map(g => g.name) : undefined,
                runtime: mediaType === 'movie' && details.runtime ? `${details.runtime} min` : undefined,
                director: mediaType === 'movie' ? tmdbCreditNames(details, 'director') : undefined,
                cast: tmdbCreditNames(details, 'cast')
            };
            const withVideos = mediaType === 'tv'
                ? buildSeriesVideos(found.tmdbId, imdbId, details).then(videos => Object.assign(meta, { videos }))
                : Promise.resolve(meta);
            return withVideos.then(finalMeta => {
                tmdbMetaCache.set(cacheKey, { meta: finalMeta, timestamp: Date.now() });
                return finalMeta;
            });
        });
    }).catch(err => {
        console.error(`[addon-server] TMDB meta fallback failed for ${imdbId}: ${err.message}`);
        return null;
    });
}

// YouTube channel catalogs (providers/youtube-channel.js) - live / upcoming
// streams, finished race broadcasts and highlight videos. Same Meta Object
// shape as the other custom catalogs; ids are `ytlive:<videoId>`.
function formatDuration(seconds) {
    if (!seconds) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

function youtubeItemToMeta(item) {
    const channel = (youtubeChannel.CHANNELS[item.channel] || {}).label;
    const meta = {
        id: `ytlive:${item.id}`,
        // Live and scheduled streams are Stremio 'tv' (clients with a live page
        // list them there); finished races and highlights are on-demand 'movie'.
        type: item.status === 'live' || item.status === 'upcoming' ? 'tv' : 'movie',
        poster: item.thumbnail,
        posterShape: 'landscape'
    };
    if (item.status === 'live') {
        meta.name = `\u{1F534} ${item.title}`;
        meta.description = [channel, item.viewers ? `${item.viewers.toLocaleString('en-US')} watching` : 'Live now'].filter(Boolean).join('\n');
    } else if (item.status === 'upcoming') {
        meta.name = `\u{1F51C} ${item.title}`;
        meta.description = [channel, item.scheduledText].filter(Boolean).join('\n');
    } else {
        meta.name = youtubeChannel.cleanTitle(item.title);
        meta.description = [channel, formatDuration(item.durationSeconds)].filter(Boolean).join('\n') || undefined;
        if (item.timestamp) meta.releaseInfo = new Date(item.timestamp).toISOString().substring(0, 10);
        if (item.durationSeconds) meta.runtime = formatDuration(item.durationSeconds);
    }
    return meta;
}

function buildYoutubeCatalog(kind, channelKey) {
    const list = kind === 'live' ? youtubeChannel.listLive(channelKey)
        : kind === 'highlights' ? youtubeChannel.listHighlights(channelKey)
            : youtubeChannel.listRaces(channelKey);
    return list.then((items) => items.map(youtubeItemToMeta));
}

function buildYoutubeMeta(id) {
    return youtubeChannel.getItem(id.slice('ytlive:'.length)).then((item) => (item ? youtubeItemToMeta(item) : null));
}

function buildYoutubeStreamResponse(id) {
    return youtubeChannel.getStreams(id.slice('ytlive:'.length)).then((streams) => ({ streams })).catch((err) => {
        console.error(`[addon-server] YouTube stream error for ${id}: ${err.message}`);
        return { streams: [] };
    });
}

// Stremio requests this resource independently of any specific stream: SubDL
// + OpenSubtitles, ordered by language preference.
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

// Catalog dispatch. Resolves to `null`, not an empty array,
// when `id`/`type` doesn't match anything known here.
function resolveCatalog(type, id) {
    if (id === 'indycar-videos' && type === 'movie') {
        return buildIndycarCatalog();
    }
    const f1CatalogSeries = { 'f1-highlights': 'f1', 'f2-highlights': 'f2', 'f3-highlights': 'f3', 'f1academy-highlights': 'academy' }[id];
    if (f1CatalogSeries && type === 'movie') {
        return buildF1Catalog(f1CatalogSeries);
    }
    const youtubeCatalog = YOUTUBE_CATALOGS.find((c) => c.id === id && c.type === type);
    if (youtubeCatalog) {
        // A client still holding an older manifest may ask for a switched-
        // off channel's catalog; it just gets nothing.
        if (!youtubeChannel.isChannelEnabled(youtubeCatalog.channel)) return Promise.resolve([]);
        return buildYoutubeCatalog(youtubeCatalog.kind, youtubeCatalog.channel);
    }
    const newCatalogType = { 'strmprov-new-movie': 'movie', 'strmprov-new-series': 'series' }[id];
    if (newCatalogType && type === newCatalogType) {
        const mediaType = type === 'series' ? 'tv' : 'movie';
        return getOrBuildDiscoverCatalog(id, () => buildNewCatalog(mediaType, type));
    }
    const streamingMatch = STREAMING_SERVICES.find(s => id === `streaming-${s.slug}-${type}`);
    if (streamingMatch && (type === 'movie' || type === 'series')) {
        const mediaType = type === 'series' ? 'tv' : 'movie';
        return getOrBuildDiscoverCatalog(id, () => buildStreamingServiceCatalog(streamingMatch, mediaType, type));
    }
    const genreMatch = GENRE_CATALOGS.find(g => id === `genre-${g.slug}-${type}`);
    if (genreMatch && (type === 'movie' || type === 'series')) {
        const mediaType = type === 'series' ? 'tv' : 'movie';
        return getOrBuildDiscoverCatalog(id, () => buildDiscoverGenreCatalog(genreMatch, mediaType, type));
    }
    return null;
}

function resolveMeta(type, id) {
    if (id.startsWith('indycar:') && type === 'movie') {
        return buildIndycarMeta(id);
    }
    if (id.startsWith('f1:') && type === 'movie') {
        return buildF1Meta(id);
    }
    if (id.startsWith('ytlive:') && (type === 'tv' || type === 'movie')) {
        return buildYoutubeMeta(id);
    }
    if (id.startsWith('tt') && (type === 'movie' || type === 'series')) {
        return buildTmdbFallbackMeta(id, type);
    }
    return Promise.resolve(null);
}

// The custom-catalog id prefixes (indycar:/f1:/ytlive:) have their own stream
// builders. Returns `null`, not a Promise, when `id` isn't one of these
// prefixes, so callers can synchronously fall through to the tt-id handler.
function resolveCustomStreamResponse(id) {
    if (id.startsWith('indycar:')) return buildIndycarStreamResponse(id);
    if (id.startsWith('f1:')) return buildF1StreamResponse(id);
    if (id.startsWith('ytlive:')) return buildYoutubeStreamResponse(id);
    return null;
}

// The stream list. A provider's own embedded subtitles
// (Castle/MovieBox/VidLink/...) are passed along: they're guaranteed to ship
// with this exact release. Nuvio shows a subtitle's `name` as its selector
// label, and providers vary in whether their language value is a short code
// ("en") or a full word ("English"), so a longer value is assumed readable.
function buildStreamResponse(type, rawId) {
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
                if (Array.isArray(s.subtitles) && s.subtitles.length) {
                    const embedded = s.subtitles
                        .filter(sub => sub && sub.url)
                        .map(sub => {
                            const lang = sub.lang || sub.language || 'unknown';
                            const name = lang.length <= 3
                                ? subtitles.languageName(lang)
                                : lang.charAt(0).toUpperCase() + lang.slice(1);
                            return { url: sub.url, lang, language: lang, name };
                        });
                    if (embedded.length) stream.subtitles = embedded;
                }
                return stream;
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
            'Install this as a Nuvio/Stremio addon:\n' +
            `  http://${ip}:${PORT}/manifest.json\n`
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

    // Installs made when this server still had profiles point at
    // /profile/<n>/...; those URLs serve the same addon, so they keep working
    // without a reinstall.
    const route = parts[0] === 'profile' && parts.length >= 3 ? parts.slice(2) : parts;
    const resource = route[0];

    if (resource === 'manifest.json' && route.length === 1) {
        return sendJson(res, 200, buildManifest());
    }

    if (resource === 'catalog' && route.length >= 3) {
        const type = route[1];
        const id = route[2].replace(/\.json$/, '');
        return Promise.resolve(resolveCatalog(type, id)).then(metas => sendJson(res, 200, { metas: metas || [] }));
    }

    if (resource === 'meta' && route.length >= 3) {
        const type = route[1];
        const id = decodeURIComponent(route[2]).replace(/\.json$/, '');
        return resolveMeta(type, id).then(meta => sendJson(res, 200, { meta }));
    }

    if (resource === 'subtitles' && route.length >= 3) {
        const type = route[1];
        const idWithExt = decodeURIComponent(route.slice(2).join('/'));
        const id = idWithExt.replace(/\.json$/, '');
        if (type !== 'movie' && type !== 'series') {
            return sendJson(res, 200, { subtitles: [] });
        }
        return buildSubtitlesResponse(type, id).then(body => sendJson(res, 200, body));
    }

    if (resource === 'stream' && route.length >= 3) {
        const type = route[1];
        const idWithExt = decodeURIComponent(route.slice(2).join('/'));
        const id = idWithExt.replace(/\.json$/, '');
        const custom = resolveCustomStreamResponse(id);
        if (custom) return custom.then(body => sendJson(res, 200, body));
        if (type !== 'movie' && type !== 'series') {
            return sendJson(res, 200, { streams: [] });
        }
        return buildStreamResponse(type, id).then(body => sendJson(res, 200, body));
    }

    return notFound(res);
});

server.listen(PORT, () => {
    const ip = getLocalIp();
    console.log(`\n🚀 StrmProv addon server running at: http://${ip}:${PORT}/`);
    console.log('Install this as a Nuvio/Stremio addon:');
    console.log(`  http://${ip}:${PORT}/manifest.json`);
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
});
