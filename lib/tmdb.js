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

// tmdbId -> imdbId is looked up often while building a recommendations
// catalog (once per candidate title) and almost never changes, so caching it
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

function getRecommendations(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}/recommendations?api_key=${TMDB_API_KEY}&page=1`;
    return fetchJson(url).then(data => Array.isArray(data.results) ? data.results : []).catch(() => []);
}

function getSimilar(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}/similar?api_key=${TMDB_API_KEY}&page=1`;
    return fetchJson(url).then(data => Array.isArray(data.results) ? data.results : []).catch(() => []);
}

// Resolves a title+year (as an AI recommendation gives us, since it can
// hallucinate a specific id but is far more reliable naming a real title) to
// a real TMDB item. Matches on year when the AI supplied one and a result
// carries a release year, to avoid picking an unrelated same-titled work;
// falls back to the top text-search result otherwise. Returns null when
// nothing in the search results looks like a genuine match - the caller
// treats that as "this suggestion doesn't correspond to a real title" and
// drops it rather than guessing.
function searchTitle(title, year, mediaType) {
    const endpoint = mediaType === 'series' || mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/search/${endpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}${year ? '&year=' + year : ''}`;
    return fetchJson(url).then(data => {
        const results = Array.isArray(data.results) ? data.results : [];
        if (results.length === 0) return null;
        if (!year) return results[0];
        const yearMatch = results.find(r => {
            const ry = (r.release_date || r.first_air_date || '').substring(0, 4);
            return ry && Math.abs(parseInt(ry, 10) - year) <= 1;
        });
        return yearMatch || results[0];
    }).catch(() => null);
}

function posterUrl(posterPath) {
    return posterPath ? `${IMAGE_BASE_URL}${posterPath}` : null;
}

module.exports = {
    TMDB_API_KEY,
    TMDB_BASE_URL,
    findByImdbId,
    getImdbId,
    getDetails,
    getRecommendations,
    getSimilar,
    searchTitle,
    posterUrl
};
