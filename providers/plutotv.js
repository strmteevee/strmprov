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
//   adverts  -> stitched into the stream: a film's playlist is the film in
//               stretches with advert breaks between them (Pretty Woman: 120
//               minutes of film in 13 stretches, 20 minutes of adverts). For
//               movies and episodes the playlists given out have only the
//               film left in (lib/hlsContentOnly.js). Live channels are left
//               as they are: there a left-out break is a hole to wait in.
//
// Ids: pluto:ch:<channel>, pluto:movie:<id>, pluto:series:<id>, and an
// episode's video id pluto:ep:<id> for the US; the same with the region in
// front for the others (pluto:uk:ch:<channel>).

const crypto = require('crypto');
const wireguard = require('../lib/wireguard');
const { tunnelFetch } = require('../lib/tunnelFetch');
const { mergedPage } = require('../lib/mergedPages');
const { contentOnly, programmeRanges } = require('../lib/hlsContentOnly');
const { matchingTitles, pickEpisode } = require('../lib/titleMatch');

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

    // A category's page of titles, with only what toMeta uses: Pluto's own
    // description of a title is many times that, and up to MAX_CACHED pages are kept.
    function categoryItems(categoryId, page) {
        return cached(`items|${categoryId}|${page}`, ITEMS_TTL_MS, () => api('vod', `/v4/vod/categories/${categoryId}/items?offset=${PAGE}&page=${page}`)
            .then(j => (j.items || []).map(slimItem)));
    }

    function slimItem(item) {
        const out = {};
        ['_id', 'id', 'type', 'name', 'description', 'summary', 'genre', 'duration', 'originalReleaseDate']
            .forEach(k => { if (item[k] != null) out[k] = item[k]; });
        if (item.covers) out.covers = item.covers.map(c => ({ aspectRatio: c.aspectRatio, url: c.url }));
        if (item.featuredImage && item.featuredImage.path) out.featuredImage = { path: item.featuredImage.path };
        return out;
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

    // type 'movie' | 'series'; this region's k-th helping (from 0) of the
    // categories [pick] chooses by name (all of them without one): a few
    // category pages at a time, every category's first page before any second.
    // null when those pages had nothing at all: the region has no more.
    function page(type, pick, k) {
        return vodCategories().then(cats => {
            const rows = pick ? cats.filter(c => pick(c.name)) : cats;
            if (!rows.length) return null;
            const turns = [];
            for (let i = k * FEATURED_ROWS; i < (k + 1) * FEATURED_ROWS; i++) turns.push({ row: rows[i % rows.length], page: Math.floor(i / rows.length) + 1 });
            return Promise.all(turns.map(t => categoryItems(t.row.id, t.page).catch(() => [])))
                .then(lists => (lists.some(l => l.length) ? metas(lists, type) : null));
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

// type 'movie' | 'series'; extra { genre, search, skip, match }: `genre` is
// one of Pluto's own categories by name, `match` a function choosing
// categories by name (a genre catalog, lib/genreRows.js).
function catalog(type, extra) {
    const e = extra || {};
    if (e.search) return fromRegions(r => r.search(type, e.search)).then(unique);
    const pick = e.match || (e.genre ? (name) => name === e.genre : null);
    return mergedPage({
        regions: regions.filter(r => r.available()),
        loadPage: (r, k) => r.page(type, pick, k),
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
        title: p.kind === 'ch' ? 'Live' : 'Free on Pluto TV',
        // A movie or episode: without the advert breaks stitched into it.
        url: relayUrl(relayBase, p.region.def.code, url, p.kind !== 'ch'),
        provider: 'pluto',
        // The service's own stream of the title (see addon-server.js: clients can put those first).
        official: p.kind !== 'ch',
        behaviorHints: { notWebReady: true }
    }]);
}

// ---- as a source for ordinary titles (providers/pluto.js) -----------------------------------

function isAvailable() {
    return regions.some(r => r.available());
}

// The Pluto stream of [wanted]: { mediaType 'movie' | 'tv', titles: [names it
// goes by], year, and for an episode season, episode, episodeTitle and
// siblings (its season's episodes, [{ episode, title }]) } - or none. Looked
// for by name in every region (lib/titleMatch.js); of a series the first
// region's copy that has the episode.
function streamsForTitle(wanted, relayBase) {
    const type = wanted.mediaType === 'tv' ? 'series' : 'movie';
    const name = (wanted.titles || [])[0];
    if (!name) return Promise.resolve([]);
    // The first of [hits] ([{ id }]) that gives a stream.
    const tryHits = (hits, i) => {
        if (i >= hits.length) return Promise.resolve([]);
        if (type === 'movie') return streams(hits[i].id, relayBase).catch(() => []).then(s => (s.length ? s : tryHits(hits, i + 1)));
        return meta(hits[i].id)
            .then(m => pickEpisode((m && m.videos) || [], { season: wanted.season, episode: wanted.episode, title: wanted.episodeTitle }, wanted.siblings))
            .catch(() => null)
            .then(ep => (ep ? streams(ep.id, relayBase) : tryHits(hits, i + 1)));
    };
    const byName = () => fromRegions(r => r.search(type, name))
        .then(found => matchingTitles(found.map(m => ({ name: m.name, year: m.releaseInfo, id: m.id })), wanted));
    // The Pluto titles already known to be this one (a catalog listed them as it) first; else the ones found by name.
    const known = (wanted.knownIds || []).map(id => ({ id }));
    return tryHits(known, 0).then(s => (s.length ? s : byName().then(hits => tryHits(hits.filter(h => !known.some(k => k.id === h.id)), 0))));
}

// ---- playlists through the tunnel ----------------------------------------------------

// Only Pluto's own hosts are fetched for a client: /pluto/hls must not be an open proxy.
const RELAY_HOSTS = /(^|\.)(pluto\.tv|plutotv\.net)$/i;

function plutoUrl(url) {
    try {
        const u = new URL(url);
        return /^https?:$/.test(u.protocol) && RELAY_HOSTS.test(u.hostname) ? u : null;
    } catch (e) {
        return null;
    }
}

// [programmeOnly]: the playlist (and the ones it points to) is given out
// without its advert breaks. [picture]: for a sound or subtitle playlist, the
// picture playlist whose breaks it follows.
function relayUrl(base, regionCode, url, programmeOnly, picture) {
    return `${base}/pluto/hls?r=${regionCode}${programmeOnly ? '&c=1' : ''}&u=${encodeURIComponent(url)}${picture ? `&v=${encodeURIComponent(picture)}` : ''}`;
}

// The stretches of a picture playlist that are programme (lib/hlsContentOnly.js),
// kept a while: the sound and subtitle playlists of the same stream ask for them too.
const RANGES_TTL_MS = 10 * 60 * 1000;
const rangesKept = new Map(); // picture playlist address -> { at, ranges: Promise }
function rangesOf(pictureUrl, region) {
    const now = Date.now();
    rangesKept.forEach((v, k) => { if (now - v.at >= RANGES_TTL_MS) rangesKept.delete(k); });
    const kept = rangesKept.get(pictureUrl);
    if (kept) return kept.ranges;
    const ranges = tunnelFetch(region.proxy(), pictureUrl, { timeoutMs: 15000 }).then(r => {
        if (r.status !== 200) throw new Error(`HTTP ${r.status} for the picture playlist`);
        return programmeRanges(r.text(), pictureUrl);
    });
    rangesKept.set(pictureUrl, { at: now, ranges });
    // A failed look-up isn't kept: the next request asks again.
    ranges.catch(() => rangesKept.delete(pictureUrl));
    return ranges;
}

// A playlist fetched through its region's tunnel, with every playlist it
// points to sent through this server too and everything else (segments, keys,
// subtitles files) made absolute so the player fetches it straight from Pluto.
// With [programmeOnly], a picture playlist loses its advert breaks, and a
// sound or subtitle playlist ([pictureUrl] given) the same stretches: when
// those can't be found out it fails rather than play out of step.
// -> { status, body } or throws.
function playlist(url, relayBase, regionCode, programmeOnly, pictureUrl) {
    const region = regionByCode(regionCode || REGIONS[0].code);
    const target = plutoUrl(url);
    if (!region) return Promise.resolve({ status: 400, body: 'Unknown region' });
    if (!target) return Promise.resolve({ status: 403, body: 'Not a Pluto TV address' });
    const picture = pictureUrl ? plutoUrl(pictureUrl) : null;
    if (pictureUrl && !picture) return Promise.resolve({ status: 403, body: 'Not a Pluto TV address' });
    return Promise.all([
        tunnelFetch(region.proxy(), target.href, { timeoutMs: 15000 }),
        programmeOnly && picture ? rangesOf(picture.href, region) : undefined
    ]).then(([r, ranges]) => {
        if (r.status !== 200) return { status: r.status, body: r.text() };
        let text = r.text();
        const master = !/#EXTINF/.test(text);
        if (programmeOnly && !master) {
            const cut = contentOnly(text, target.href, ranges);
            if (cut.removedSeconds > 0 && !picture) console.log(`[PlutoTV] Playlist without its ${cut.breaks} advert break(s): ${Math.round(cut.keptSeconds / 60)} min of programme, ${Math.round(cut.removedSeconds / 60)} min left out`);
            text = cut.text;
        }
        // In a master playlist: the first picture playlist, which the sound and subtitles follow.
        const firstPicture = master && programmeOnly ? (text.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#')) || '').trim() : '';
        const pictureRef = firstPicture ? new URL(firstPicture, target.href).href : null;
        const point = (ref, follows) => {
            const abs = new URL(ref, target.href);
            return /\.m3u8$/i.test(abs.pathname) && RELAY_HOSTS.test(abs.hostname) ? relayUrl(relayBase, region.def.code, abs.href, programmeOnly, follows) : abs.href;
        };
        const body = text.split(/\r?\n/).map(line => {
            if (!line) return line;
            // A tag's address: a sound or subtitle playlist in a master (it follows the picture), a key or map elsewhere.
            if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${point(ref, line.startsWith('#EXT-X-MEDIA') ? pictureRef : null)}"`);
            return point(line.trim(), null);
        }).join('\n');
        return { status: 200, body };
    });
}

module.exports = { PREFIX, catalog, liveCatalog, genreOptions, meta, streams, streamsForTitle, isAvailable, playlist, parseId };
