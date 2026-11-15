// Pluto TV (free, with adverts): live channels, and movies and series on
// demand, as catalogs of this addon. Pluto only answers from the countries it
// runs in, so each of its regions here (REGIONS: US and UK) is asked through
// the WireGuard tunnel assigned to it on the admin dashboard
// (lib/wireguard.js); a region without a tunnel is simply left out. The
// regions are shown as one: what a later region has under the same name as an
// earlier one (a channel, a movie, a series) is left out.
// Tested 2026-11-15 (US) and 2026-11-16 (UK):
//   session  -> GET boot.pluto.tv/v4/start: from the Netherlands it gives no
//               region and nothing plays; through a tunnel it gives the
//               service addresses, a session token (JWT, good for
//               refreshInSec = 8h) and the stitcher parameters.
//   live     -> {channels}/v2/guide/channels (+ /v2/guide/categories)
//   on demand-> {vod}/v4/vod/categories, /categories/{id}/items (paged),
//               /series/{id}/seasons, and {search}/v1/search?q=
//   playing  -> {stitcher}/v2/stitch/hls/{channel|episode}/{id}/master.m3u8
//               with the session's parameters and token. Only the session
//               needs the region's address; but from the home network the
//               playlists' host (the stitcher, on CloudFront) failed its TLS
//               handshake now and then (5 of 6 tries on a good moment, none on
//               a bad one) while the video segments' host always answered. So
//               the playlists go through this server and the tunnel
//               (playlist(), served at /pluto/hls), and the segments in them
//               are left pointing straight at Pluto.
//
// Ids: pluto:ch:<channel>, pluto:movie:<id>, pluto:series:<id>, and an
// episode's video id pluto:ep:<id> for the US; the same with the region in
// front for the others (pluto:uk:ch:<channel>).

const crypto = require('crypto');
const wireguard = require('../lib/wireguard');
const { tunnelFetch } = require('../lib/tunnelFetch');
const { mergedPage } = require('../lib/mergedPages');

// In order of preference: of two titles with the same name, the earlier region's is shown.
// `source` is the name the tunnel is assigned under (lib/wireguard.js SOURCES).
const REGIONS = [
    { code: 'us', source: 'plutotv', idPart: '' },
    { code: 'uk', source: 'plutotv-uk', idPart: 'uk:' }
];

const BOOT = 'https://boot.pluto.tv/v4/start';
const PAGE = 30;
const CHANNELS_TTL_MS = 60 * 60 * 1000;
const CATEGORIES_TTL_MS = 6 * 60 * 60 * 1000;
const ITEMS_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 300;
// Movie and series rows that open the catalogs when no genre is picked, taken this many at a time.
const FEATURED_ROWS = 4;
// How far a catalog is read for one page (lib/mergedPages.js).
const MAX_ROUNDS = 12;

const PREFIX = 'pluto:';

function image(images, type) {
    const found = (images || []).find(i => i.type === type);
    return found ? found.url : undefined;
}
function cover(covers, ratio) {
    const found = (covers || []).find(c => c.aspectRatio === ratio);
    return found ? found.url : undefined;
}

// A name as it is compared between regions ("Pluto TV Movies" = "pluto tv movies").
function sameName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---- one region --------------------------------------------------------------------

function createRegion(def) {
    const idPrefix = `${PREFIX}${def.idPart}`;
    const clientId = crypto.randomUUID();

    function available() {
        return !!wireguard.proxyFor(def.source);
    }

    function proxy() {
        const p = wireguard.proxyFor(def.source);
        if (!p) throw new Error(`Pluto TV (${def.code.toUpperCase()}) has no running VPN tunnel (admin dashboard → VPN tunnels)`);
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

    let session = null; // { at, ttlMs, servers, token, params }
    let sessionPending = null;

    function getSession() {
        if (session && Date.now() - session.at < session.ttlMs) return Promise.resolve(session);
        if (sessionPending) return sessionPending;
        const q = new URLSearchParams({
            appName: 'web', appVersion: '9.0.0', deviceVersion: '120.0.0', deviceModel: 'web', deviceMake: 'chrome',
            deviceType: 'web', clientID: clientId, clientModelNumber: '1.0.0', serverSideAds: 'false'
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
                id: `${idPrefix}ch:${c.id}`,
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
            id: `${idPrefix}${type}:${item._id || item.id}`,
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

    // The titles of [type] in some lists of items.
    function metas(lists, type) {
        return [].concat(...lists).map(toMeta).filter(m => m && m.type === type);
    }

    // type 'movie' | 'series'; this region's k-th page (from 0) of a genre, or
    // without one of Pluto's own rows: the first page of its next few categories.
    function page(type, genre, k) {
        return vodCategories().then(cats => {
            const picked = genre ? cats.filter(c => c.name === genre) : cats.slice(k * FEATURED_ROWS, (k + 1) * FEATURED_ROWS);
            return Promise.all(picked.map(c => categoryItems(c.id, genre ? k + 1 : 1).catch(() => []))).then(lists => metas(lists, type));
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

    function meta(kind, rawId, id) {
        if (kind === 'ch') return channels().then(list => list.find(c => c.id === id) || null);
        if (kind === 'movie') {
            return api('vod', `/v4/vod/items?ids=${rawId}`).then(items => {
                const m = toMeta((Array.isArray(items) ? items : [])[0] || {});
                return m ? Object.assign(m, { id }) : null;
            });
        }
        if (kind === 'series') {
            return api('vod', `/v4/vod/series/${rawId}/seasons?offset=1000&page=1`).then(s => {
                const base = toMeta(Object.assign({ type: 'series' }, s)) || { id, type: 'series', name: s.name };
                const videos = [];
                (s.seasons || []).forEach(season => (season.episodes || []).forEach((ep, i) => videos.push({
                    id: `${idPrefix}ep:${ep._id || ep.id}`,
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

    // The playlist address of a channel, movie or episode for this region's session.
    function streamUrl(kind, rawId) {
        return getSession().then(s => `${s.servers.stitcher}/v2/stitch/hls/${kind === 'ch' ? 'channel' : 'episode'}/${rawId}/master.m3u8?${s.params}&jwt=${s.token}&masterJWTPassthrough=true`);
    }

    return { def, available, proxy, channels, liveCategories, vodCategories, page, search, meta, streamUrl };
}

const regions = REGIONS.map(createRegion);
const regionByCode = (code) => regions.find(r => r.def.code === code);

// ---- the regions as one --------------------------------------------------------------

// What a title goes by: its id, and its name and type (the same film from another region).
function titleKeys(m) {
    return [m.id, `${m.type}|${sameName(m.name)}`];
}

// Each title once.
function unique(list) {
    const seen = new Set();
    return list.filter(m => {
        const keys = titleKeys(m);
        if (keys.some(k => seen.has(k))) return false;
        keys.forEach(k => seen.add(k));
        return true;
    });
}

// What every region with a tunnel gives for [ask], in the regions' order; one that fails is left out.
function fromRegions(ask) {
    return Promise.all(regions.filter(r => r.available()).map(r => ask(r).catch(err => {
        console.error(`[PlutoTV] ${r.def.code.toUpperCase()}: ${err.message}`);
        return [];
    }))).then(lists => [].concat(...lists));
}

// Live channels, optionally of one genre.
function liveCatalog(extra) {
    const genre = extra && extra.genre;
    return fromRegions(r => r.channels()).then(list => unique(genre ? list.filter(c => (c.genres || []).includes(genre)) : list));
}

// type 'movie' | 'series'; extra { genre, search, skip }.
function catalog(type, extra) {
    const e = extra || {};
    if (e.search) return fromRegions(r => r.search(type, e.search)).then(unique);
    return mergedPage({
        regions: regions.filter(r => r.available()),
        loadPage: (r, k) => r.page(type, e.genre, k),
        keys: titleKeys,
        skip: Number(e.skip) || 0,
        size: PAGE,
        maxRounds: MAX_ROUNDS
    });
}

// The genre names the manifest offers, which has to be built at once: the
// last ones known (on-demand categories, which mix movies and series - one
// without any of the asked type simply shows nothing - and the live ones, of
// every region), looked up again in the background when they're old or the
// regions with a tunnel changed.
let knownGenres = { vod: [], live: [], at: 0, regions: '' };
function genreOptions() {
    const active = regions.filter(r => r.available()).map(r => r.def.code).join(',');
    if (active && (Date.now() - knownGenres.at > CATEGORIES_TTL_MS || knownGenres.regions !== active)) {
        knownGenres.at = Date.now();
        knownGenres.regions = active;
        const names = (list) => Array.from(new Set(list.map(c => c.name)));
        Promise.all([fromRegions(r => r.vodCategories()), fromRegions(r => r.liveCategories())])
            // Nothing found (a tunnel still starting) is asked again at the next call.
            .then(([vod, live]) => { knownGenres = { vod: names(vod), live: names(live), at: vod.length && live.length ? Date.now() : 0, regions: active }; })
            .catch(err => { knownGenres.at = 0; console.error(`[PlutoTV] Categories failed: ${err.message}`); });
    }
    return knownGenres;
}

// ---- meta and streams --------------------------------------------------------------

function parseId(id) {
    const m = /^pluto:(?:([a-z]{2}):)?(ch|movie|series|ep):([\w-]+)$/.exec(id || '');
    if (!m) return null;
    const region = regionByCode(m[1] || REGIONS[0].code);
    return region ? { region, kind: m[2], id: m[3] } : null;
}

function meta(id) {
    const p = parseId(id);
    return p ? p.region.meta(p.kind, p.id, id) : Promise.resolve(null);
}

// The stream of a channel, movie or episode: its playlist through this
// server ([relayBase] is this server's address as the client used it).
function streams(id, relayBase) {
    const p = parseId(id);
    if (!p || p.kind === 'series') return Promise.resolve([]);
    return p.region.streamUrl(p.kind, p.id).then(url => [{
        name: 'Pluto TV',
        title: p.kind === 'ch' ? 'Live' : 'Free with adverts',
        url: relayUrl(relayBase, p.region.def.code, url),
        behaviorHints: { notWebReady: true }
    }]);
}

// ---- playlists through the tunnel ----------------------------------------------------

// Only Pluto's own hosts are fetched for a client: /pluto/hls must not be an open proxy.
const RELAY_HOSTS = /(^|\.)(pluto\.tv|plutotv\.net)$/i;

function relayUrl(base, regionCode, url) {
    return `${base}/pluto/hls?r=${regionCode}&u=${encodeURIComponent(url)}`;
}

// A playlist fetched through its region's tunnel, with every playlist it
// points to sent through this server too and everything else (segments, keys,
// subtitles files) made absolute so the player fetches it straight from Pluto.
// -> { status, body } or throws.
function playlist(url, relayBase, regionCode) {
    const region = regionByCode(regionCode || REGIONS[0].code);
    let target;
    try { target = new URL(url); } catch (e) { return Promise.resolve({ status: 400, body: 'Bad address' }); }
    if (!region) return Promise.resolve({ status: 400, body: 'Unknown region' });
    if (!/^https?:$/.test(target.protocol) || !RELAY_HOSTS.test(target.hostname)) return Promise.resolve({ status: 403, body: 'Not a Pluto TV address' });
    return tunnelFetch(region.proxy(), target.href, { timeoutMs: 15000 }).then(r => {
        if (r.status !== 200) return { status: r.status, body: r.text() };
        const point = (ref) => {
            const abs = new URL(ref, target.href);
            return /\.m3u8$/i.test(abs.pathname) && RELAY_HOSTS.test(abs.hostname) ? relayUrl(relayBase, region.def.code, abs.href) : abs.href;
        };
        const body = r.text().split(/\r?\n/).map(line => {
            if (!line) return line;
            if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${point(ref)}"`);
            return point(line.trim());
        }).join('\n');
        return { status: 200, body };
    });
}

module.exports = { PREFIX, catalog, liveCatalog, genreOptions, meta, streams, playlist, parseId };
