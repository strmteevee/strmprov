// Pluto TV (free, with adverts): live channels, and movies and series on
// demand, as catalogs of this addon. Pluto only answers from the countries it
// runs in, so its API is asked through the WireGuard tunnel assigned to it on
// the admin dashboard (lib/wireguard.js; a US one). Tested 2026-11-15:
//   session  -> GET boot.pluto.tv/v4/start: from the Netherlands it gives no
//               region and nothing plays; through a US tunnel it gives the
//               service addresses, a session token (JWT, good for
//               refreshInSec = 8h) and the stitcher parameters.
//   live     -> {channels}/v2/guide/channels (+ /v2/guide/categories)
//   on demand-> {vod}/v4/vod/categories, /categories/{id}/items (paged),
//               /series/{id}/seasons, and {search}/v1/search?q=
//   playing  -> {stitcher}/v2/stitch/hls/{channel|episode}/{id}/master.m3u8
//               with the session's parameters and token. Only the session
//               needs the US address; but from the home network the
//               playlists' host (the stitcher, on CloudFront) failed its TLS
//               handshake now and then (5 of 6 tries on a good moment, none on
//               a bad one) while the video segments' host always answered. So
//               the playlists go through this server and the tunnel
//               (playlist(), served at /pluto/hls), and the segments in them
//               are left pointing straight at Pluto.
//
// Ids: pluto:ch:<channel>, pluto:movie:<id>, pluto:series:<id>, and an
// episode's video id pluto:ep:<id>.

const crypto = require('crypto');
const wireguard = require('../lib/wireguard');
const { tunnelFetch } = require('../lib/tunnelFetch');

const SOURCE = 'plutotv';
const BOOT = 'https://boot.pluto.tv/v4/start';
const PAGE = 30;
const CHANNELS_TTL_MS = 60 * 60 * 1000;
const CATEGORIES_TTL_MS = 6 * 60 * 60 * 1000;
const ITEMS_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 300;
// Movie and series rows that open the catalogs when no genre is picked.
const FEATURED_ROWS = 4;

const PREFIX = 'pluto:';
const CLIENT_ID = crypto.randomUUID();

// ---- requests through the tunnel ------------------------------------------------

function proxy() {
    const p = wireguard.proxyFor(SOURCE);
    if (!p) throw new Error('Pluto TV has no running VPN tunnel (admin dashboard → VPN tunnels)');
    return p;
}

// GET a JSON answer through the tunnel; once more on a dropped connection (a
// large answer through the tunnel now and then is cut off halfway).
function getJson(url, headers, attempt) {
    return tunnelFetch(proxy(), url, { headers: Object.assign({ Accept: 'application/json' }, headers || {}), timeoutMs: 30000 })
        .then(r => {
            if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
            return JSON.parse(r.text());
        })
        .catch(err => {
            if ((attempt || 0) >= 1 || /HTTP \d/.test(err.message)) throw err;
            return getJson(url, headers, 1);
        });
}

// ---- session -------------------------------------------------------------------

let session = null; // { at, ttlMs, servers, token, params }
let sessionPending = null;

function getSession() {
    if (session && Date.now() - session.at < session.ttlMs) return Promise.resolve(session);
    if (sessionPending) return sessionPending;
    const q = new URLSearchParams({
        appName: 'web', appVersion: '9.0.0', deviceVersion: '120.0.0', deviceModel: 'web', deviceMake: 'chrome',
        deviceType: 'web', clientID: CLIENT_ID, clientModelNumber: '1.0.0', serverSideAds: 'false'
    });
    sessionPending = getJson(`${BOOT}?${q}`).then(j => {
        if (!j.sessionToken || !j.servers || !(j.session && j.session.activeRegion)) {
            throw new Error(`Pluto TV gave no session for ${(j.session && j.session.countryCode) || 'this address'} (is the tunnel in a country Pluto runs in?)`);
        }
        // Renewed well before the token runs out (refreshInSec, 8h).
        session = { at: Date.now(), ttlMs: Math.max(60, (j.refreshInSec || 3600) * 0.75) * 1000, servers: j.servers, token: j.sessionToken, params: j.stitcherParams };
        return session;
    }).finally(() => { sessionPending = null; });
    return sessionPending;
}

function api(serverKey, pathAndQuery) {
    return getSession().then(s => getJson(`${s.servers[serverKey]}${pathAndQuery}`, { Authorization: `Bearer ${s.token}` }));
}

// ---- small cache ---------------------------------------------------------------

const cache = new Map(); // key -> { at, value }
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

// ---- images --------------------------------------------------------------------

function image(images, type) {
    const found = (images || []).find(i => i.type === type);
    return found ? found.url : undefined;
}
function cover(covers, ratio) {
    const found = (covers || []).find(c => c.aspectRatio === ratio);
    return found ? found.url : undefined;
}

// ---- live ------------------------------------------------------------------------

function liveCategories() {
    return cached('live-categories', CHANNELS_TTL_MS, () => api('channels', '/v2/guide/categories').then(j => (j.data || []).map(c => ({ id: c.id, name: c.name }))));
}

function channels() {
    return cached('channels', CHANNELS_TTL_MS, () => Promise.all([
        api('channels', '/v2/guide/channels?channelIds=&offset=0&limit=1000&sort=number:asc'),
        liveCategories()
    ]).then(([j, cats]) => {
        const names = new Map(cats.map(c => [c.id, c.name]));
        return (j.data || []).filter(c => c.isStitched !== false && !c.plutoOfficeOnly).map(c => ({
            id: `${PREFIX}ch:${c.id}`,
            type: 'tv',
            name: c.name,
            poster: image(c.images, 'colorLogoPNG') || image(c.images, 'logo'),
            logo: image(c.images, 'colorLogoPNG'),
            background: image(c.images, 'featuredImage'),
            description: c.summary,
            genres: (c.categoryIDs || []).map(id => names.get(id)).filter(Boolean),
            // Channel number, for clients that list by it.
            number: c.number
        }));
    }));
}

// ---- on demand -------------------------------------------------------------------

function vodCategories() {
    return cached('vod-categories', CATEGORIES_TTL_MS, () => api('vod', '/v4/vod/categories?includeItems=false&offset=1000&page=1')
        .then(j => (j.categories || []).map(c => ({ id: c._id, name: c.name }))));
}

function categoryItems(categoryId, page) {
    return cached(`items|${categoryId}|${page}`, ITEMS_TTL_MS, () => api('vod', `/v4/vod/categories/${categoryId}/items?offset=${PAGE}&page=${page}`)
        .then(j => j.items || []));
}

function toMeta(item) {
    const type = item.type === 'series' ? 'series' : item.type === 'movie' ? 'movie' : null;
    if (!type) return null;
    return {
        id: `${PREFIX}${type}:${item._id || item.id}`,
        type,
        name: item.name,
        poster: cover(item.covers, '347:500') || cover(item.covers, '16:9'),
        background: cover(item.covers, '16:9') || (item.featuredImage && item.featuredImage.path),
        description: item.description || item.summary,
        genres: item.genre ? [item.genre] : undefined,
        runtime: type === 'movie' && item.duration ? `${Math.round(item.duration / 60000)} min` : undefined,
        releaseInfo: (item.originalReleaseDate || '').slice(0, 4) || undefined
    };
}

// The genre names the manifest offers, which has to be built at once: the
// last ones known (on-demand categories, which mix movies and series - one
// without any of the asked type simply shows nothing - and the live ones),
// looked up again in the background when they're old or not there yet.
let knownGenres = { vod: [], live: [], at: 0 };
function genreOptions() {
    if (Date.now() - knownGenres.at > CATEGORIES_TTL_MS && wireguard.proxyFor(SOURCE)) {
        knownGenres.at = Date.now();
        Promise.all([vodCategories(), liveCategories()])
            .then(([vod, live]) => { knownGenres = { vod: vod.map(c => c.name), live: live.map(c => c.name), at: Date.now() }; })
            .catch(err => { knownGenres.at = 0; console.error(`[PlutoTV] Categories failed: ${err.message}`); });
    }
    return knownGenres;
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
    const page = Math.floor((Number(e.skip) || 0) / PAGE) + 1;
    return vodCategories().then(cats => {
        if (e.genre) return Promise.all(cats.filter(c => c.name === e.genre).map(c => categoryItems(c.id, page).catch(() => []))).then(lists => unique(lists, type));
        // No genre: Pluto's first categories, as many as it takes to fill a page with this type (they mix both).
        return fillFrom(cats, c => categoryItems(c.id, page), type);
    });
}

function search(type, query) {
    return api('search', `/v1/search?q=${encodeURIComponent(query)}&limit=100`).then(j => {
        // Pluto US has Spanish-language copies of many titles ("Star Trek X: némesis"): English ones only.
        const ids = (j.data || []).filter(r => r.type === type && (!r.language || r.language.toUpperCase() === 'EN')).map(r => r.id);
        if (!ids.length) return [];
        // The search answer is short (no pictures), the items are looked up whole.
        return api('vod', `/v4/vod/items?ids=${ids.slice(0, 40).join(',')}`).then(items => (Array.isArray(items) ? items : []).map(toMeta).filter(Boolean));
    });
}

// ---- meta and streams --------------------------------------------------------------

function parseId(id) {
    const m = /^pluto:(ch|movie|series|ep):([\w-]+)$/.exec(id || '');
    return m ? { kind: m[1], id: m[2] } : null;
}

function meta(id) {
    const p = parseId(id);
    if (!p) return Promise.resolve(null);
    if (p.kind === 'ch') return channels().then(list => list.find(c => c.id === id) || null);
    if (p.kind === 'movie') {
        return api('vod', `/v4/vod/items?ids=${p.id}`).then(items => {
            const m = toMeta((Array.isArray(items) ? items : [])[0] || {});
            return m ? Object.assign(m, { id }) : null;
        });
    }
    if (p.kind === 'series') {
        return api('vod', `/v4/vod/series/${p.id}/seasons?offset=1000&page=1`).then(s => {
            const base = toMeta(Object.assign({ type: 'series' }, s)) || { id, type: 'series', name: s.name };
            const videos = [];
            (s.seasons || []).forEach(season => (season.episodes || []).forEach((ep, i) => videos.push({
                id: `${PREFIX}ep:${ep._id || ep.id}`,
                title: ep.name,
                season: season.number,
                episode: ep.number || i + 1,
                overview: ep.description || undefined,
                thumbnail: cover(ep.covers, '16:9'),
                released: ep.originalReleaseDate || undefined
            })));
            return Object.assign(base, { id, videos });
        });
    }
    return Promise.resolve(null);
}

// The stream of a channel, movie or episode: its playlist through this
// server ([relayBase] is this server's address as the client used it).
function streams(id, relayBase) {
    const p = parseId(id);
    if (!p || p.kind === 'series') return Promise.resolve([]);
    return getSession().then(s => {
        const kind = p.kind === 'ch' ? 'channel' : 'episode';
        const url = `${s.servers.stitcher}/v2/stitch/hls/${kind}/${p.id}/master.m3u8?${s.params}&jwt=${s.token}&masterJWTPassthrough=true`;
        return [{ name: 'Pluto TV', title: p.kind === 'ch' ? 'Live' : 'Free with adverts', url: relayUrl(relayBase, url), behaviorHints: { notWebReady: true } }];
    });
}

// ---- playlists through the tunnel ----------------------------------------------------

// Only Pluto's own hosts are fetched for a client: /pluto/hls must not be an open proxy.
const RELAY_HOSTS = /(^|\.)(pluto\.tv|plutotv\.net)$/i;

function relayUrl(base, url) {
    return `${base}/pluto/hls?u=${encodeURIComponent(url)}`;
}

// A playlist fetched through the tunnel, with every playlist it points to
// sent through this server too and everything else (segments, keys, subtitles
// files) made absolute so the player fetches it straight from Pluto.
// -> { status, body } or throws.
function playlist(url, relayBase) {
    let target;
    try { target = new URL(url); } catch (e) { return Promise.resolve({ status: 400, body: 'Bad address' }); }
    if (!/^https?:$/.test(target.protocol) || !RELAY_HOSTS.test(target.hostname)) return Promise.resolve({ status: 403, body: 'Not a Pluto TV address' });
    return tunnelFetch(proxy(), target.href, { timeoutMs: 15000 }).then(r => {
        if (r.status !== 200) return { status: r.status, body: r.text() };
        const point = (ref) => {
            const abs = new URL(ref, target.href).href;
            return /\.m3u8(\?|$)/i.test(new URL(abs).pathname + new URL(abs).search) && RELAY_HOSTS.test(new URL(abs).hostname) ? relayUrl(relayBase, abs) : abs;
        };
        const body = r.text().split(/\r?\n/).map(line => {
            if (!line) return line;
            if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${point(ref)}"`);
            return point(line.trim());
        }).join('\n');
        return { status: 200, body };
    });
}

// Live channels, optionally of one genre.
function liveCatalog(extra) {
    const genre = extra && extra.genre;
    return channels().then(list => (genre ? list.filter(c => (c.genres || []).includes(genre)) : list));
}

function isConfigured() {
    return !!wireguard.readState().uses[SOURCE];
}

module.exports = { PREFIX, catalog, liveCatalog, channels, genreOptions, meta, streams, playlist, parseId, isConfigured };
