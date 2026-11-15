// Plex's free movies and shows ("Movies & Shows on Plex"), as catalogs of this
// addon. No tunnel: Plex serves them in the Netherlands too (its rows there
// include "Most Popular in Netherlands"). Tested 2026-11-15:
//   session  -> POST clients.plex.tv/api/v2/users/anonymous: an anonymous
//               token, like Plex's website gets without a login.
//   rows     -> vod.provider.plex.tv/hubs: ~55 rows ("Plex Picks", "Western"
//               ...), each a mix of movies and shows, paged.
//   titles   -> /library/metadata/{id}, a show's seasons and a season's
//               episodes as /children.
//   search   -> discover.provider.plex.tv/library/search finds any title;
//               the ones that are on Plex for free are those the vod
//               provider knows (2 of 30 for "western").
//   playing  -> each title's HLS playlist (/library/parts/...-hls.m3u8) with
//               the session token. Some titles are DRM-protected
//               (Widevine/FairPlay, 9 of 30 in one row): those are left out,
//               a player can't play them without Plex's own licence service.
//
// Ids: plexvod:movie:<id>, plexvod:series:<id>, an episode's video id
// plexvod:ep:<id>. (The app's own Plex source has plex:live: for live TV.)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VOD = 'https://vod.provider.plex.tv';
const DISCOVER = 'https://discover.provider.plex.tv';
const ACCOUNTS = 'https://clients.plex.tv/api/v2';
const PRODUCT = 'Plex Mediaverse';
const VERSION = '4.145.1';
const SESSION_PATH = path.join(__dirname, '..', 'data', 'plex-session.json');
const PAGE = 30;
const HUBS_TTL_MS = 6 * 60 * 60 * 1000;
const ITEMS_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 400;
const FEATURED_ROWS = 3;
const SEARCH_LOOKUPS = 5;
const REQUEST_TIMEOUT_MS = 15000;

const PREFIX = 'plexvod:';

// ---- session -------------------------------------------------------------------

let session = null; // { client, token }

function readSession() {
    try {
        const s = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
        return s.client && s.token ? s : null;
    } catch (e) {
        return null;
    }
}

function headers(s) {
    return { 'X-Plex-Client-Identifier': s.client, 'X-Plex-Product': PRODUCT, 'X-Plex-Version': VERSION, 'X-Plex-Platform': 'Chrome', 'X-Plex-Token': s.token || '', Accept: 'application/json' };
}

function newSession() {
    const client = (session && session.client) || crypto.randomUUID();
    return timedFetch(`${ACCOUNTS}/users/anonymous`, { method: 'POST', headers: headers({ client, token: '' }) })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(`Plex session: HTTP ${r.status}`))))
        .then(j => {
            if (!j.authToken) throw new Error('Plex gave no session token');
            session = { client, token: j.authToken };
            try {
                fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
                fs.writeFileSync(SESSION_PATH, JSON.stringify(session) + '\n', { mode: 0o600 });
            } catch (e) { /* kept in memory only */ }
            return session;
        });
}

function getSession() {
    if (!session) session = readSession();
    return session ? Promise.resolve(session) : newSession();
}

function timedFetch(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => clearTimeout(timer));
}

// A Plex API answer; with a new session once when Plex no longer knows the kept one.
function get(url, renewed) {
    return getSession().then(s => timedFetch(url, { headers: headers(s) })).then(r => {
        if (r.status === 401 && !renewed) return newSession().then(() => get(url, true));
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
        return r.json();
    });
}

// ---- small cache ---------------------------------------------------------------

const cache = new Map();
function cached(key, ttlMs, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    return load().then(value => {
        cache.delete(key);
        cache.set(key, { at: Date.now(), value });
        while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
        return value;
    });
}

// ---- titles ------------------------------------------------------------------------

// Playable without DRM: a movie or episode with at least one unprotected HLS version.
function freeHls(item) {
    return (item.Media || []).find(m => m.protocol === 'hls' && !m.drm && (m.Part || []).length);
}

function toMeta(item) {
    const type = item.type === 'movie' ? 'movie' : item.type === 'show' ? 'series' : null;
    if (!type) return null;
    // A show's own entry has no versions to check; its episodes are checked in meta().
    if (type === 'movie' && !freeHls(item)) return null;
    return {
        id: `${PREFIX}${type}:${item.ratingKey}`,
        type,
        name: item.title,
        poster: item.thumb,
        background: item.art,
        description: item.summary,
        genres: (item.Genre || []).map(g => g.tag).filter(Boolean),
        releaseInfo: item.year ? String(item.year) : undefined,
        runtime: type === 'movie' && item.duration ? `${Math.round(item.duration / 60000)} min` : undefined,
        imdbRating: item.audienceRating ? Number(item.audienceRating).toFixed(1) : undefined
    };
}

function hubs() {
    return cached('hubs', HUBS_TTL_MS, () => get(`${VOD}/hubs`).then(j => ((j && j.MediaContainer && j.MediaContainer.Hub) || [])
        .filter(h => h.key && h.title).map(h => ({ title: h.title, key: h.key }))));
}

function hubItems(hub, start) {
    return cached(`hub|${hub.key}|${start}`, ITEMS_TTL_MS, () => {
        const sep = hub.key.includes('?') ? '&' : '?';
        return get(`${VOD}${hub.key}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}&count=${PAGE}`)
            .then(j => (j && j.MediaContainer && j.MediaContainer.Metadata) || []);
    });
}

// The genre names the manifest offers (Plex's rows), known ones at once and
// looked up again in the background when old.
let knownRows = { titles: [], at: 0 };
function genreOptions() {
    if (Date.now() - knownRows.at > HUBS_TTL_MS) {
        knownRows.at = Date.now();
        hubs().then(list => { knownRows = { titles: list.map(h => h.title), at: Date.now() }; })
            .catch(err => { knownRows.at = 0; console.error(`[PlexVOD] Rows failed: ${err.message}`); });
    }
    return knownRows.titles;
}

// The titles of [type] in some lists of items, each once.
function unique(lists, type) {
    const seen = new Set();
    return [].concat(...lists).map(toMeta).filter(m => m && m.type === type && !seen.has(m.id) && seen.add(m.id));
}

// Rows from the start of [rows], a few at a time, until a page of [type] is
// found or FEATURED_ROWS * 3 rows have been looked at.
function fillFrom(rows, load, type) {
    const lists = [];
    const next = (i) => {
        const found = unique(lists, type);
        if (found.length >= PAGE || i >= Math.min(rows.length, FEATURED_ROWS * 3)) return Promise.resolve(found);
        return Promise.all(rows.slice(i, i + FEATURED_ROWS).map(r => load(r).catch(() => []))).then(more => { lists.push(...more); return next(i + FEATURED_ROWS); });
    };
    return next(0);
}

// type 'movie' | 'series'; extra { genre, search, skip }.
function catalog(type, extra) {
    const e = extra || {};
    if (e.search) return search(type, e.search);
    const start = Number(e.skip) || 0;
    return hubs().then(list => {
        if (e.genre) return Promise.all(list.filter(h => h.title === e.genre).map(h => hubItems(h, start).catch(() => []))).then(lists => unique(lists, type));
        // No genre: Plex's first rows, as many as it takes to fill a page with this type (they mix both).
        return fillFrom(list, h => hubItems(h, start), type);
    });
}

function metadata(ratingKey) {
    return cached(`meta|${ratingKey}`, ITEMS_TTL_MS, () => get(`${VOD}/library/metadata/${ratingKey}`)
        .then(j => (j && j.MediaContainer && (j.MediaContainer.Metadata || [])[0]) || null));
}

function children(ratingKey) {
    return cached(`children|${ratingKey}`, ITEMS_TTL_MS, () => get(`${VOD}/library/metadata/${ratingKey}/children`)
        .then(j => (j && j.MediaContainer && j.MediaContainer.Metadata) || []));
}

// Plex's search covers every title anywhere; the free ones are those its
// free catalogue knows, looked up a few at a time.
function search(type, query) {
    const searchType = type === 'movie' ? 'movies' : 'tv';
    return get(`${DISCOVER}/library/search?query=${encodeURIComponent(query)}&limit=30&searchTypes=${searchType}&searchProviders=discover,vod&includeMetadata=1`)
        .then(j => {
            const keys = ((j && j.MediaContainer && j.MediaContainer.SearchResults) || [])
                .flatMap(g => g.SearchResult || []).map(r => r.Metadata && r.Metadata.ratingKey).filter(Boolean);
            const unique = Array.from(new Set(keys));
            const found = [];
            const next = (i) => {
                if (i >= unique.length) return Promise.resolve(found);
                return Promise.all(unique.slice(i, i + SEARCH_LOOKUPS).map(k => metadata(k).catch(() => null)))
                    .then(items => { items.forEach(it => { const m = it && toMeta(it); if (m && m.type === type) found.push(m); }); return next(i + SEARCH_LOOKUPS); });
            };
            return next(0);
        });
}

function parseId(id) {
    const m = /^plexvod:(movie|series|ep):([\w-]+)$/.exec(id || '');
    return m ? { kind: m[1], id: m[2] } : null;
}

function meta(id) {
    const p = parseId(id);
    if (!p || p.kind === 'ep') return Promise.resolve(null);
    return metadata(p.id).then(item => {
        if (!item) return null;
        const base = toMeta(item);
        if (!base || p.kind === 'movie') return base;
        return children(p.id).then(seasons => Promise.all(seasons.map(season => children(season.ratingKey).catch(() => [])
            .then(episodes => episodes.filter(freeHls).map(ep => ({
                id: `${PREFIX}ep:${ep.ratingKey}`,
                title: ep.title,
                season: ep.parentIndex || season.index,
                episode: ep.index,
                overview: ep.summary || undefined,
                thumbnail: ep.thumb,
                released: ep.originallyAvailableAt || undefined
            })))))).then(lists => Object.assign(base, { videos: [].concat(...lists) }));
    });
}

function streams(id) {
    const p = parseId(id);
    if (!p || p.kind === 'series') return Promise.resolve([]);
    return Promise.all([metadata(p.id), getSession()]).then(([item, s]) => {
        const media = item && freeHls(item);
        if (!media) return [];
        const q = new URLSearchParams({ 'X-Plex-Token': s.token, 'X-Plex-Client-Identifier': s.client, 'X-Plex-Product': PRODUCT, 'X-Plex-Version': VERSION });
        return [{
            name: 'Plex',
            title: [/^\d+$/.test(media.videoResolution || '') ? `${media.videoResolution}p` : null, 'Free with adverts'].filter(Boolean).join(' | '),
            url: `${VOD}${media.Part[0].key}?${q}`,
            behaviorHints: { notWebReady: true }
        }];
    });
}

module.exports = { PREFIX, catalog, genreOptions, meta, streams, parseId };
