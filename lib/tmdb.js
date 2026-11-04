// Shared TMDB helpers for addon-server.js.
//
// The Stremio/Nuvio addon protocol identifies all content by IMDb id (e.g.
// "tt0137523", or "tt0903747:1:1" for a series episode) - that's a protocol
// requirement, not a choice made here. Every provider in this repo takes a
// TMDB id instead, so every request through the addon server has to resolve
// IMDb -> TMDB (via TMDB's own /find endpoint) before anything else can run.

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';
const BACKDROP_BASE_URL = 'https://image.tmdb.org/t/p/original';

// tmdbId -> imdbId is looked up often while building a catalog (once per
// title) and almost never changes, so caching it
// for the life of the process avoids re-fetching the same external_ids on
// every catalog rebuild.
const imdbIdCache = new Map();

function fetchJson(url) {
    return fetch(url).then(res => {
        if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
        return res.json();
    });
}

// IMDb id -> { tmdbId, mediaType, title, year }
function findByImdbId(imdbId) {
    const url = `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    return fetchJson(url).then(data => {
        const movie = data.movie_results && data.movie_results[0];
        if (movie) {
            return { tmdbId: movie.id, mediaType: 'movie', title: movie.title, year: (movie.release_date || '').substring(0, 4) };
        }
        const tv = data.tv_results && data.tv_results[0];
        if (tv) {
            return { tmdbId: tv.id, mediaType: 'tv', title: tv.name, year: (tv.first_air_date || '').substring(0, 4) };
        }
        return null;
    });
}

// tmdbId -> "tt..." (or null if this title has no IMDb id on TMDB)
function getImdbId(tmdbId, mediaType) {
    const cacheKey = `${mediaType}:${tmdbId}`;
    if (imdbIdCache.has(cacheKey)) return Promise.resolve(imdbIdCache.get(cacheKey));
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
    return fetchJson(url).then(data => {
        const imdbId = data.imdb_id || null;
        imdbIdCache.set(cacheKey, imdbId);
        return imdbId;
    }).catch(() => null);
}

function getDetails(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    return fetchJson(url);
}

// Same as getDetails, but also bundles cast/crew in on the same request via
// TMDB's append_to_response (one round trip, not two) - used by
// addon-server.js's TMDB-backed meta fallback, which wants director/cast for
// a fuller meta object than the plain catalog-building paths above need.
function getDetailsWithCredits(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=credits`;
    return fetchJson(url);
}

// One season's episode list - used to build a series meta's `videos` array
// (Stremio's per-episode picker), since a series meta with no videos has no
// way for the client to select an episode at all.
function getSeasonEpisodes(tmdbId, seasonNumber) {
    const url = `${TMDB_BASE_URL}/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`;
    return fetchJson(url).catch(() => null);
}

// Per-movie release dates by region, each carrying its own `type` (1=Premiere,
// 2/3=Theatrical, 4=Digital, 5=Physical, 6=TV). Only movies have this
// theatrical-vs-digital distinction - TV has no equivalent endpoint or
// concept. Used by addon-server.js's "New" catalog to tell an
// already-digitally-available movie apart from one still theatrical-only.
function getReleaseDates(tmdbId) {
    const url = `${TMDB_BASE_URL}/movie/${tmdbId}/release_dates?api_key=${TMDB_API_KEY}`;
    return fetchJson(url).then(data => Array.isArray(data.results) ? data.results : []).catch(() => []);
}

function posterUrl(posterPath) {
    return posterPath ? `${IMAGE_BASE_URL}${posterPath}` : null;
}

function backdropUrl(backdropPath) {
    return backdropPath ? `${BACKDROP_BASE_URL}${backdropPath}` : null;
}

// Generic /discover browse - backs the genre/keyword/streaming-service
// catalogs in addon-server.js. `params` is passed straight through as extra
// query params (with_genres, with_keywords, without_keywords,
// with_watch_providers, watch_region, ...); sort_by defaults to
// popularity.desc since these are plain browse lists.
function discoverPage(mediaType, params, page) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const qs = new URLSearchParams(Object.assign({ api_key: TMDB_API_KEY, sort_by: 'popularity.desc', page: String(page) }, params));
    const url = `${TMDB_BASE_URL}/discover/${endpoint}?${qs.toString()}`;
    return fetchJson(url).then(data => Array.isArray(data.results) ? data.results : []).catch(() => []);
}

// Pages until maxItems worth of results are gathered (TMDB returns 20/page)
// or a page comes back empty (a niche genre+keyword combination can
// legitimately have fewer than maxItems results total, e.g. Sport or Teen).
function discoverMany(mediaType, params, maxItems) {
    const pagesNeeded = Math.max(1, Math.ceil(maxItems / 20));
    let chain = Promise.resolve([]);
    for (let page = 1; page <= pagesNeeded; page++) {
        chain = chain.then(acc => {
            if (acc.length >= maxItems) return acc;
            return discoverPage(mediaType, params, page).then(results => results.length ? acc.concat(results) : acc);
        });
    }
    return chain.then(items => items.slice(0, maxItems));
}

// TMDB's own curated lists (not /discover) - 'popular', 'top_rated',
// 'now_playing'/'airing_today' (movie/tv-specific "new" lists) and the
// special 'trending' case (trending/{movie|tv}/week, a different URL shape
// than the others).
function listPage(mediaType, listName, page) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const path = listName === 'trending' ? `trending/${endpoint}/week` : `${endpoint}/${listName}`;
    const url = `${TMDB_BASE_URL}/${path}?api_key=${TMDB_API_KEY}&page=${page}`;
    return fetchJson(url).then(data => Array.isArray(data.results) ? data.results : []).catch(() => []);
}

function getList(mediaType, listName, maxItems) {
    const pagesNeeded = Math.max(1, Math.ceil(maxItems / 20));
    let chain = Promise.resolve([]);
    for (let page = 1; page <= pagesNeeded; page++) {
        chain = chain.then(acc => {
            if (acc.length >= maxItems) return acc;
            return listPage(mediaType, listName, page).then(results => results.length ? acc.concat(results) : acc);
        });
    }
    return chain.then(items => items.slice(0, maxItems));
}

module.exports = {
    TMDB_API_KEY,
    TMDB_BASE_URL,
    findByImdbId,
    getImdbId,
    getDetails,
    getDetailsWithCredits,
    getSeasonEpisodes,
    posterUrl,
    backdropUrl,
    discoverMany,
    getList,
    getReleaseDates
};
