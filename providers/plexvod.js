// Plex's free movies and shows ("Movies & Shows on Plex"), as catalogs of this
// addon: what Plex offers in the Netherlands (asked directly) and in the US
// and the UK (each asked through the WireGuard tunnel assigned to "Plex (US)"
// / "Plex (UK)" on the admin dashboard, lib/wireguard.js; left out while
// there is none), shown as one. A title has the same id everywhere, so one
// that several countries have is there once, from the first that has it
// (the Netherlands, then the US). In the rows on 2026-11-16 the UK had 769
// free movies neither of the others had. Tested 2026-11-15 (NL) and 2026-11-16 (US):
//   session  -> POST clients.plex.tv/api/v2/users/anonymous: an anonymous
//               token, like Plex's website gets without a login. The same
//               token works in both countries: the address a request comes
//               from decides what Plex offers.
//   rows     -> vod.provider.plex.tv/hubs: 55 rows in NL, 72 in the US ("Plex
//               Picks", "Western" ...), each a mix of at most 50 movies and
//               shows.
//   titles   -> /library/metadata/{id}, a show's seasons and a season's
//               episodes as /children. A US-only title is a 404 from NL.
//   search   -> discover.provider.plex.tv/library/search finds any title;
//               the ones that are on Plex for free are those the vod
//               provider knows (2 of 30 for "western").
//   playing  -> each title's HLS playlist (/library/parts/...-hls.m3u8) with
//               the session token. A US-only title's playlist is a 404 from
//               NL too, but the playlists and video it points to play from
//               anywhere: so only that first playlist comes through this
//               server and the tunnel (playlist(), served at /plex/hls).
//               Some titles are DRM-protected (Widevine/FairPlay, 9 of 30 in
//               one row): those are left out, a player can't play them
//               without Plex's own licence service.
//
// Ids: plexvod:movie:<id>, plexvod:series:<id>, an episode's video id
// plexvod:ep:<id>. (Live channels are plex:live:, providers/plexlive.js.)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const wireguard = require('../lib/wireguard');
const { tunnelFetch } = require('../lib/tunnelFetch');
const { mergedPage } = require('../lib/mergedPages');

// In order of preference. `source`: the name its tunnel is assigned under; none = asked directly.
const REGIONS = [
    { code: 'nl', source: null },
    { code: 'us', source: 'plex-us' },
    { code: 'uk', source: 'plex-uk' }
];

const VOD = 'https://vod.provider.plex.tv';
const DISCOVER = 'https://discover.provider.plex.tv';
const ACCOUNTS = 'https://clients.plex.tv/api/v2';
const PRODUCT = 'Plex Mediaverse';
const VERSION = '4.145.1';
const SESSION_PATH = path.join(__dirname, '..', 'data', 'plex-session.json');
const PAGE = 30;
const HUBS_TTL_MS = 6 * 60 * 60 * 1000;
const ITEMS_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 600;
const FEATURED_ROWS = 3;
const SEARCH_LOOKUPS = 5;
// Shows of a catalog page checked for a playable episode at once, and how long that answer is kept.
const SHOW_CHECKS = 10;
// How far a catalog is read for one page (lib/mergedPages.js).
const MAX_ROUNDS = 12;
const SHOW_CHECK_TTL_MS = 12 * 60 * 60 * 1000;
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

function timedFetch(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => clearTimeout(timer));
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

// ---- requests, per country -------------------------------------------------------

function available(region) {
    return !region.source || !!wireguard.proxyFor(region.source);
}

function activeRegions() {
    return REGIONS.filter(available);
}

// -> { status, json() } from [region]: directly, or through its tunnel.
function request(url, region, s) {
    if (!region.source) return timedFetch(url, { headers: headers(s) }).then(r => ({ status: r.status, json: () => r.json() }));
    const proxy = wireguard.proxyFor(region.source);
    if (!proxy) return Promise.reject(new Error(`Plex (${region.code.toUpperCase()}) has no running VPN tunnel`));
    return tunnelFetch(proxy, url, { headers: headers(s), timeoutMs: REQUEST_TIMEOUT_MS })
        .then(r => ({ status: r.status, json: () => Promise.resolve(JSON.parse(r.text())) }));
}

// A Plex API answer (null = Plex doesn't have it there); with a new session once when Plex no longer knows the kept one.
function get(url, region, renewed) {
    return getSession().then(s => request(url, region, s)).then(r => {
        if (r.status === 401 && !renewed) return newSession().then(() => get(url, region, true));
        if (r.status === 404) return null;
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
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

// A protected version a player with Widevine of its own can play: DASH, with
// Plex's licence service (tested 2026-11-16: it answers an anonymous session).
// Not a title Plex rents out: in the US its catalogue lists those too, with a
// price and protected versions only ("The Hunger Games": rentalPrice "$3.99"),
// and they don't play without paying (tested 2026-11-17: a 404).
function widevineDash(item) {
    if (item.price != null || item.rentalPrice != null) return undefined;
    return (item.Media || []).find(m => m.protocol === 'dash' && (m.Part || []).some(p => p.drm === 'widevine' && p.key && p.license));
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

// The titles of [type] in some lists of items, each once.
function unique(lists, type) {
    const seen = new Set();
    return [].concat(...lists).map(toMeta).filter(m => m && m.type === type && !seen.has(m.id) && seen.add(m.id));
}

function hubs(region) {
    return cached(`hubs|${region.code}`, HUBS_TTL_MS, () => get(`${VOD}/hubs`, region).then(j => ((j && j.MediaContainer && j.MediaContainer.Hub) || [])
        .filter(h => h.key && h.title).map(h => ({ title: h.title, key: h.key }))));
}

// The country each listed title came from first (a row's items don't say), for the checks below.
const listedIn = new Map(); // ratingKey -> region
// A row's titles. A row is a fixed set of at most 50, handed out whole and in
// another order at every request, whatever start or size is asked for
// (checked 2026-11-17: six requests, the same 50 titles each time). So it is
// asked once and kept as long as the list of rows, which keeps a catalog's
// order - and with it its paging - the same in between.
function hubItems(region, hub) {
    return cached(`hub|${region.code}|${hub.key}`, HUBS_TTL_MS, () => get(`${VOD}${hub.key}`, region)
        .then(j => (j && j.MediaContainer && j.MediaContainer.Metadata) || [])).then(items => {
        if (listedIn.size > 5000) listedIn.clear();
        items.forEach(it => { if (it.ratingKey && !listedIn.has(it.ratingKey)) listedIn.set(it.ratingKey, region); });
        return items;
    });
}

// Whether a show has an episode that plays without DRM: a row lists shows
// without saying, and whole shows are protected (in one US row 5 of 8 were).
// Judged on its first season that has episodes; unknown (a failed request)
// counts as playable.
function showPlays(ratingKey, region) {
    return cached(`plays|${ratingKey}`, SHOW_CHECK_TTL_MS, () => children(ratingKey, region).then(seasons => {
        const tryNext = (i) => {
            if (i >= seasons.length) return Promise.resolve(false);
            return children(seasons[i].ratingKey, region).then(eps => (eps.length ? eps.some(freeHls) : tryNext(i + 1)));
        };
        return tryNext(0);
    })).catch(() => true);
}

// Whether a catalog title plays: a movie in a catalog already does (toMeta), a show is checked.
function plays(m) {
    if (m.type !== 'series') return Promise.resolve(true);
    const key = m.id.slice(m.id.lastIndexOf(':') + 1);
    const region = listedIn.get(key);
    return region ? showPlays(key, region) : metadata(key).then(hit => (hit ? showPlays(key, hit.region) : false));
}

// [metas] without the shows that have nothing playable, checked a few at a time.
function playableOnly(metas) {
    const out = [];
    const next = (i) => {
        if (i >= metas.length) return Promise.resolve(out);
        return Promise.all(metas.slice(i, i + SHOW_CHECKS).map(plays))
            .then(ok => { metas.slice(i, i + SHOW_CHECKS).forEach((m, n) => { if (ok[n]) out.push(m); }); return next(i + SHOW_CHECKS); });
    };
    return next(0);
}

// One country's k-th helping (from 0) of [type] from the rows [pick] chooses
// by name (all of them without one): its next few rows. null when it has no
// rows left: the country has no more.
function regionPage(region, type, pick, k) {
    return hubs(region).then(list => {
        const rows = (pick ? list.filter(h => pick(h.title)) : list).slice(k * FEATURED_ROWS, (k + 1) * FEATURED_ROWS);
        if (!rows.length) return null;
        return Promise.all(rows.map(row => hubItems(region, row).catch(() => []))).then(lists => unique(lists, type));
    });
}

// What every country gives for [ask], in the countries' order; one that fails is left out.
function fromRegions(ask) {
    return Promise.all(activeRegions().map(region => ask(region).catch(err => {
        console.error(`[PlexVOD] ${region.code.toUpperCase()}: ${err.message}`);
        return [];
    }))).then(lists => [].concat(...lists));
}

// The genre names the manifest offers (Plex's rows, of every country), known
// ones at once and looked up again in the background when old or the
// countries with a tunnel changed.
let knownRows = { titles: [], at: 0, regions: '' };
function genreOptions() {
    const active = activeRegions().map(r => r.code).join(',');
    if (Date.now() - knownRows.at > HUBS_TTL_MS || knownRows.regions !== active) {
        knownRows.at = Date.now();
        knownRows.regions = active;
        // A country that gave nothing (its tunnel still starting) is asked again at the next call.
        Promise.all(activeRegions().map(r => hubs(r).catch(() => []))).then(lists => {
            knownRows = { titles: Array.from(new Set([].concat(...lists).map(h => h.title))), at: lists.every(l => l.length) ? Date.now() : 0, regions: active };
        })
            .catch(err => { knownRows.at = 0; console.error(`[PlexVOD] Rows failed: ${err.message}`); });
    }
    return knownRows.titles;
}

// type 'movie' | 'series'; extra { genre, search, skip, match }: `genre` is
// one of Plex's own rows by name, `match` a function choosing rows by name
// (a genre catalog, lib/genreRows.js).
function catalog(type, extra) {
    const e = extra || {};
    if (e.search) return search(type, e.search);
    const pick = e.match || (e.genre ? (name) => name === e.genre : null);
    return mergedPage({
        regions: activeRegions(),
        loadPage: (region, k) => regionPage(region, type, pick, k),
        keys: (m) => [m.id],
        accept: (metas) => Promise.all(metas.map(plays)),
        skip: Number(e.skip) || 0,
        size: PAGE,
        maxRounds: MAX_ROUNDS
    });
}

// A title where Plex has it: { item, region }, in the countries' order; null
// when nowhere. A movie or episode one country only has DRM-protected is
// looked for in the next (an episode of "Borgen" was known in the Netherlands
// but only played in the UK); when none plays it, the first that has it.
function metadata(ratingKey) {
    return cached(`meta|${ratingKey}`, ITEMS_TTL_MS, () => {
        const list = activeRegions();
        const tryRegion = (i, firstHit) => {
            if (i >= list.length) return Promise.resolve(firstHit);
            return get(`${VOD}/library/metadata/${ratingKey}`, list[i])
                .then(j => (j && j.MediaContainer && (j.MediaContainer.Metadata || [])[0]) || null)
                .catch(() => null)
                .then(item => {
                    if (!item) return tryRegion(i + 1, firstHit);
                    const hit = { item, region: list[i] };
                    const playable = item.type === 'show' || item.type === 'season' || !!freeHls(item);
                    return playable ? hit : tryRegion(i + 1, firstHit || hit);
                });
        };
        return tryRegion(0, null);
    });
}

function children(ratingKey, region) {
    return cached(`children|${region.code}|${ratingKey}`, ITEMS_TTL_MS, () => get(`${VOD}/library/metadata/${ratingKey}/children`, region)
        .then(j => (j && j.MediaContainer && j.MediaContainer.Metadata) || []));
}

// Plex's search covers every title anywhere; the free ones are those its
// free catalogue knows (in either country), looked up a few at a time.
function search(type, query) {
    const searchType = type === 'movie' ? 'movies' : 'tv';
    return get(`${DISCOVER}/library/search?query=${encodeURIComponent(query)}&limit=30&searchTypes=${searchType}&searchProviders=discover,vod&includeMetadata=1`, REGIONS[0])
        .then(j => {
            const keys = ((j && j.MediaContainer && j.MediaContainer.SearchResults) || [])
                .flatMap(g => g.SearchResult || []).map(r => r.Metadata && r.Metadata.ratingKey).filter(Boolean);
            const wanted = Array.from(new Set(keys));
            const found = [];
            const next = (i) => {
                if (i >= wanted.length) return Promise.resolve(found);
                return Promise.all(wanted.slice(i, i + SEARCH_LOOKUPS).map(k => metadata(k).catch(() => null)))
                    .then(hits => { hits.forEach(hit => { const m = hit && toMeta(hit.item); if (m && m.type === type) found.push(m); }); return next(i + SEARCH_LOOKUPS); });
            };
            return next(0).then(playableOnly);
        });
}

function parseId(id) {
    const m = /^plexvod:(movie|series|ep):([\w-]+)$/.exec(id || '');
    return m ? { kind: m[1], id: m[2] } : null;
}

function meta(id) {
    const p = parseId(id);
    if (!p || p.kind === 'ep') return Promise.resolve(null);
    return metadata(p.id).then(hit => {
        if (!hit) return null;
        const base = toMeta(hit.item);
        if (!base || p.kind === 'movie') return base;
        return children(p.id, hit.region).then(seasons => Promise.all(seasons.map(season => children(season.ratingKey, hit.region).catch(() => [])
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

// [relayBase]: this server's address as the client used it, for a title that
// only plays through a tunnel.
function streams(id, relayBase) {
    const p = parseId(id);
    if (!p || p.kind === 'series') return Promise.resolve([]);
    return Promise.all([metadata(p.id), getSession()]).then(([hit, s]) => (hit ? streamOf(hit.item, hit.region, s, relayBase) : []));
}

// What a playlist address carries of the session [s].
function sessionQuery(s) {
    return new URLSearchParams({ 'X-Plex-Token': s.token, 'X-Plex-Client-Identifier': s.client, 'X-Plex-Product': PRODUCT, 'X-Plex-Version': VERSION }).toString();
}

// The stream of a movie or episode [item] as [region] has it; none when it only has it DRM-protected.
function streamOf(item, region, s, relayBase) {
    const media = freeHls(item);
    if (!media) return protectedStreamOf(item, region, s, relayBase);
    const direct = `${VOD}${media.Part[0].key}?${sessionQuery(s)}`;
    const quality = /^\d+$/.test(media.videoResolution || '') ? `${media.videoResolution}p` : null;
    return [{
        name: 'Plex',
        // The stream is the film itself: Plex's adverts come from its own player, not the stream.
        title: [quality, 'Free on Plex'].filter(Boolean).join(' | '),
        quality: quality || undefined,
        url: region.source ? relayUrl(relayBase, region.code, direct) : direct,
        provider: 'plex',
        // The service's own stream of the title (see addon-server.js: clients can put those first).
        official: true,
        behaviorHints: { notWebReady: true }
    }];
}

// The stream of a title [region] only has protected: its DASH version with
// the address of Plex's Widevine licence service, for a client whose player
// asks for the licence itself (`drm`, not a Stremio field: OmniStream reads
// it; nothing is decrypted here). A title of a country that is asked through
// a tunnel has both its DASH description and its licence request come
// through this server and that tunnel (dash(), licence(): the request and
// the answer are passed on as they are, sealed between the player's Widevine
// and Plex's licence service); the video itself plays straight from Plex.
function protectedStreamOf(item, region, s, relayBase) {
    const media = widevineDash(item);
    if (!media) return [];
    const part = media.Part.find(p => p.drm === 'widevine' && p.key && p.license);
    const quality = /^\d+$/.test(media.videoResolution || '') ? `${media.videoResolution}p` : null;
    const description = `${VOD}${part.key}?${sessionQuery(s)}`;
    const licence = `${VOD}${part.license}?${sessionQuery(s)}&X-Plex-DRM=widevine`;
    const through = (what, address) => `${relayBase}/plex/${what}?r=${region.code}&u=${encodeURIComponent(address)}`;
    const drm = { widevine: { licenseUrl: region.source ? through('licence', licence) : licence } };
    return [{
        name: 'Plex',
        title: [quality, 'Free on Plex'].filter(Boolean).join(' | '),
        quality: quality || undefined,
        // (Named .mpd: a player goes by that to know it is DASH.)
        url: region.source ? through('dash.mpd', description) : description,
        provider: 'plex',
        official: true,
        drm,
        behaviorHints: { notWebReady: true, drm }
    }];
}

// ---- as a source for ordinary titles (providers/plex.js) ----------------------------------

// The Plex stream of the title TMDB knows as [tmdbId] ('movie' | 'tv', with
// season and episode numbers), or none. Plex's own index says which of its
// titles that is; the free catalogue of each country says whether it plays.
function streamsForTmdb(tmdbId, mediaType, season, episode, relayBase) {
    const type = mediaType === 'tv' ? 2 : 1;
    return get(`${DISCOVER}/library/metadata/matches?type=${type}&guid=${encodeURIComponent(`tmdb://${tmdbId}`)}`, REGIONS[0]).then(j => {
        const match = j && j.MediaContainer && (j.MediaContainer.Metadata || [])[0];
        if (!match || !match.ratingKey) return [];
        if (mediaType !== 'tv') return streams(`${PREFIX}movie:${match.ratingKey}`, relayBase);
        if (!season || !episode) return [];
        // The episode, in the first country whose copy of it plays.
        const list = activeRegions();
        const tryRegion = (i) => {
            if (i >= list.length) return Promise.resolve([]);
            const region = list[i];
            return children(match.ratingKey, region)
                .then(seasons => {
                    const s = seasons.find(x => Number(x.index) === Number(season));
                    return s ? children(s.ratingKey, region) : [];
                })
                .then(episodes => episodes.find(e => Number(e.index) === Number(episode) && (freeHls(e) || widevineDash(e))))
                .catch(() => null)
                .then(ep => (ep ? getSession().then(s => streamOf(ep, region, s, relayBase)) : tryRegion(i + 1)));
        };
        return tryRegion(0);
    });
}

// ---- playlists through the tunnel ----------------------------------------------------

// Only Plex's own hosts are fetched for a client: /plex/hls must not be an open proxy.
const RELAY_HOSTS = /(^|\.)plex\.tv$/i;

function relayUrl(base, regionCode, url) {
    return `${base}/plex/hls?r=${regionCode}&u=${encodeURIComponent(url)}`;
}

// A playlist fetched through its country's tunnel. The playlists it points
// to on Plex's own API host come through this server as well; everything
// else (the video's playlists and segments on Plex's video hosts) is made
// absolute and plays straight from Plex. -> { status, body } or throws.
function playlist(url, relayBase, regionCode) {
    const region = REGIONS.find(r => r.code === regionCode && r.source);
    let target;
    try { target = new URL(url); } catch (e) { return Promise.resolve({ status: 400, body: 'Bad address' }); }
    if (!region) return Promise.resolve({ status: 400, body: 'Unknown region' });
    if (target.protocol !== 'https:' || !RELAY_HOSTS.test(target.hostname)) return Promise.resolve({ status: 403, body: 'Not a Plex address' });
    const proxy = wireguard.proxyFor(region.source);
    if (!proxy) return Promise.resolve({ status: 502, body: 'No VPN tunnel' });
    return tunnelFetch(proxy, target.href, { timeoutMs: REQUEST_TIMEOUT_MS }).then(r => {
        if (r.status !== 200) return { status: r.status, body: r.text() };
        const point = (ref) => {
            const abs = new URL(ref, r.url || target.href);
            return /\.m3u8$/i.test(abs.pathname) && RELAY_HOSTS.test(abs.hostname) ? relayUrl(relayBase, region.code, abs.href) : abs.href;
        };
        const body = r.text().split(/\r?\n/).map(line => {
            if (!line) return line;
            if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${point(ref)}"`);
            return point(line.trim());
        }).join('\n');
        return { status: 200, body };
    });
}

// ---- a protected title of another country: its description and its licence through the tunnel ----

// The tunnel of [regionCode] and [url] as one of Plex's own addresses, or what is wrong: { proxy, target } | { status, body }.
function throughTunnel(url, regionCode) {
    const region = REGIONS.find(r => r.code === regionCode && r.source);
    let target;
    try { target = new URL(url); } catch (e) { return { status: 400, body: 'Bad address' }; }
    if (!region) return { status: 400, body: 'Unknown region' };
    if (target.protocol !== 'https:' || !RELAY_HOSTS.test(target.hostname)) return { status: 403, body: 'Not a Plex address' };
    const proxy = wireguard.proxyFor(region.source);
    return proxy ? { proxy, target } : { status: 502, body: 'No VPN tunnel' };
}

// A title's DASH description as its country gives it (it names where the video is: that plays from anywhere). -> { status, body }.
function dash(url, regionCode) {
    const t = throughTunnel(url, regionCode);
    if (!t.proxy) return Promise.resolve(t);
    return tunnelFetch(t.proxy, t.target.href, { timeoutMs: REQUEST_TIMEOUT_MS }).then(r => ({ status: r.status, body: r.text() }));
}

// A player's Widevine licence request ([body], a Buffer) passed on to Plex's licence service from
// the title's country, and the service's answer as it is. -> { status, type, body: Buffer }.
function licence(url, regionCode, body) {
    const t = throughTunnel(url, regionCode);
    if (!t.proxy) return Promise.resolve(t);
    return tunnelFetch(t.proxy, t.target.href, {
        method: 'POST', body, timeoutMs: REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }
    }).then(r => ({ status: r.status, type: r.headers['content-type'], body: r.buffer() }));
}

module.exports = {
    PREFIX, catalog, genreOptions, meta, streams, streamsForTmdb, playlist, dash, licence, parseId,
    // For Plex's live channels (providers/plexlive.js): the same session and countries.
    get, getSession, sessionQuery, activeRegions, relayUrl
};
