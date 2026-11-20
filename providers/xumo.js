// Xumo Play (US, free with adverts) as a stream source for movies and
// series: when Xumo has the title, its stream is one of the title's sources.
// Looked at 2026-11-20, from the Netherlands, without a tunnel:
//   site     -> play.xumo.com sends Europe to a "geo-block" page, but the API
//               its player uses (valencia-app-mds.xumo.com/v2) answers from
//               anywhere, and so do the streams.
//   finding  -> there is no search. What Xumo has on demand hangs off its
//               channels: 207 of its 455 channels have categories ("Most
//               Popular", "Hell's Kitchen Season 1"), each a list of titles
//               (3,251 categories, 47,292 titles: 3,797 films, 39,405
//               episodes, 4,090 short clips). That is read once every few
//               days into a file (data/xumo-index.txt, INDEX_TTL_MS), some
//               3,500 requests, and looked up there by the title's name.
//   a film   -> Xumo gives no year, only a name and a running time: a film
//               counts when its name is the asked one's and its length is
//               (RUNTIME_SLACK), which tells "Annie" (1982, 127 min) from
//               "Annie" (2014, 118 min).
//   a series -> its episodes in the lists carry their season, number and
//               title; the episode is found the way Pluto's are
//               (lib/titleMatch.js). Not every episode of a long series is in
//               a list ("Hell's Kitchen": 200 of 345).
//   playing  -> a title's own data (/assets/asset/<id>.json?f=providers) has
//               its streams: most a plain HLS one (720p at best) that plays
//               from anywhere. Subtitles come with the title (WebVTT).
//   protected-> some (742 of the 47,292, "Sony Pictures - Licensed (DRM)")
//               only have protected streams: DASH for Widevine, whose licence
//               service (widevine-dash.ezdrm.com, named in Xumo's player)
//               wants a "CustomData" value Xumo's player adds. Tried on the
//               emulator 2026-11-20 without it: the service answers "{}", no
//               licence. What the player sends is in a part of its site that
//               only opens in the US; until that is known these titles are
//               left out (no stream rather than one that fails).
//   catalog  -> the same lists are Xumo's own catalog (data/xumo-catalog.json,
//               written with the index): every film and series it has, with
//               Xumo's ids ("xumo:m:<id>" a film, "xumo:s:<id>" a series,
//               "xumo:e:<id>" an episode), so a title in the catalog is one
//               Xumo plays - no guessing by name in between. The rows of its
//               "Movies" and "TV Shows" pages ("Most Popular", "Crime TV",
//               "Westerns"...) are the genres, and the order: what those pages
//               show first comes first. A title that surely is an ordinary
//               one is handed out as that (lib/regularTitle.js) and found
//               again by the id it was listed under (getStreams).

const fs = require('fs');
const path = require('path');
const tmdb = require('../lib/tmdb');
const { normalize, pickEpisode } = require('../lib/titleMatch');
const regularTitle = require('../lib/regularTitle');

const API = 'https://valencia-app-mds.xumo.com/v2';
// Xumo Play's channel list for the US, as its own site asks for it.
const CHANNEL_LIST = '10006';
// The site's "Movies" and "TV Shows" pages: channels of their own, not in the list.
const HUB_CHANNELS = ['99991334', '9999699'];
const PREFIX = 'xumo:';
const IMAGES = 'https://image.xumo.com/v1/assets/asset/';
const INDEX_PATH = path.join(__dirname, '..', 'data', 'xumo-index.txt');
const CATALOG_PATH = path.join(__dirname, '..', 'data', 'xumo-catalog.json');
const PAGE = 20;
const INDEX_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const INDEX_RETRY_MS = 30 * 60 * 1000;
const AT_ONCE = 6;
// How far a film's length may be from the asked one's: release cuts and rounding differ a little.
const RUNTIME_SLACK = (seconds) => Math.max(5 * 60, seconds * 0.06);
// Films with the asked name whose data is looked at for one title.
const MAX_CANDIDATES = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function get(p, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    return fetch(`${API}${p}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
        .finally(() => clearTimeout(timer));
}

// ---- what Xumo has: its channels' lists, kept in a file -------------------------

let building = null;
let lastFailedAt = 0;

// How old the lists are: the older of the two files (Infinity while one is missing).
function indexAge() {
    try { return Date.now() - Math.min(fs.statSync(INDEX_PATH).mtimeMs, fs.statSync(CATALOG_PATH).mtimeMs); } catch (e) { return Infinity; }
}

function hasIndex() {
    return fs.existsSync(INDEX_PATH);
}

// One line per title: "m:<name>\t<id>\t<seconds>" for a film,
// "e:<series name>\t<id>\t<season>\t<episode>\t<title>\t<series id>" for an episode (names as normalize() makes them).
function lineOf(a) {
    const name = normalize(a.title);
    if (!name || !a.id) return null;
    const clean = (s) => String(s || '').replace(/[\t\n\r]/g, ' ');
    if (a.contentType === 'MOVIE') return `m:${name}\t${a.id}\t${Number(a.runtime) || 0}`;
    if (a.contentType === 'EPISODIC' && a.season && a.episode) return `e:${name}\t${a.id}\t${a.season}\t${a.episode}\t${clean(a.episodeTitle)}\t${a.connectorId && a.connectorId !== a.id ? a.connectorId : ''}`;
    return null;
}

// A title Xumo only has protected (see the top): its supplier's name in the lists says so
// ("Sony Pictures - Licensed (DRM)"). Left out of the lists: it would be a title without a stream.
function onlyProtected(a) {
    const suppliers = (a && a.providers) || [];
    return suppliers.length > 0 && suppliers.every(p => /\(DRM\)/i.test(String((p && p.title) || '')));
}

// What a list's title adds to the catalog ({ titles: { id: [kind, name] }, order: [ids] }): a film,
// a series, or the series an episode is of. -> the id it goes by there, or null.
function noteTitle(catalog, a) {
    if (!a || !a.id || !a.title) return null;
    const kind = a.contentType === 'MOVIE' ? 'm' : a.contentType === 'SERIES' || a.contentType === 'EPISODIC' ? 's' : null;
    const id = a.contentType === 'EPISODIC' ? (a.connectorId && a.connectorId !== a.id ? a.connectorId : null) : a.id;
    if (!kind || !id) return null;
    if (!catalog.titles[id]) { catalog.titles[id] = [kind, String(a.title)]; catalog.order.push(id); }
    return id;
}

function buildIndex() {
    if (building) return building;
    const startedAt = Date.now();
    building = get(`/channels/list/${CHANNEL_LIST}.json?geoId=unknown`, 30000).then(list => {
        const channels = ((list && list.channel && list.channel.item) || [])
            .filter(c => c.properties && c.properties.has_vod === 'true')
            .map(c => c.guid && c.guid.value).filter(Boolean);
        if (!channels.length) throw new Error('Xumo listed no channels with titles');
        const seen = new Set();
        const lines = [];
        const counted = { m: 0, e: 0 };
        const catalog = { rows: [], titles: {}, order: [] };
        const fields = ['title', 'runtime', 'season', 'episode', 'episodeTitle', 'connectorId', 'providers'].map(f => `f=asset.${f}`).join('&');
        // One channel: its categories one by one. Those of a hub (the site's own pages) are the catalog's rows.
        const readChannel = (channel, hub) => get(`/channels/channel/${channel}/categories.json`).then(c => {
            const categories = ((c && c.categories) || []).filter(cat => cat && cat.categoryId);
            const nextCategory = (i) => {
                if (i >= categories.length) return Promise.resolve();
                return get(`/categories/category/${categories[i].categoryId}.json?${fields}`).then(r => {
                    const row = { m: [], s: [] };
                    ((r && r.results) || []).filter(a => a && !onlyProtected(a)).forEach(a => {
                        const id = noteTitle(catalog, a);
                        if (id && hub && !row[catalog.titles[id][0]].includes(id)) row[catalog.titles[id][0]].push(id);
                        if (seen.has(a.id)) return;
                        seen.add(a.id);
                        const line = lineOf(a);
                        if (line) { lines.push(line); counted[line[0]]++; }
                    });
                    const name = String(categories[i].title || '').trim();
                    if (hub && name) ['m', 's'].forEach(kind => { if (row[kind].length) catalog.rows.push({ name, kind, ids: row[kind] }); });
                    return nextCategory(i + 1);
                });
            };
            return nextCategory(0);
        });
        // The hubs first, one after the other (their order is the catalog's); then a few workers for the channels.
        const queue = channels.filter(c => !HUB_CHANNELS.includes(c));
        const worker = () => {
            const channel = queue.shift();
            return channel ? readChannel(channel, false).then(worker) : Promise.resolve();
        };
        return HUB_CHANNELS.reduce((before, hub) => before.then(() => readChannel(hub, true)), Promise.resolve())
            .then(() => Promise.all(Array.from({ length: AT_ONCE }, worker))).then(() => {
                if (!counted.m) throw new Error('Xumo\'s lists had no films');
                fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
                const write = (file, text) => { fs.writeFileSync(`${file}.tmp`, text); fs.renameSync(`${file}.tmp`, file); };
                write(INDEX_PATH, '\n' + lines.join('\n') + '\n');
                write(CATALOG_PATH, JSON.stringify(catalog));
                const series = catalog.order.filter(id => catalog.titles[id][0] === 's').length;
                console.log(`[Xumo] ${counted.m} films, ${series} series and ${counted.e} episodes listed from ${channels.length} channels, ${catalog.rows.length} rows, in ${Math.round((Date.now() - startedAt) / 1000)} s`);
            });
    }).catch(err => {
        lastFailedAt = Date.now();
        console.log(`[Xumo] Listing its titles failed: ${err.message}`);
    }).finally(() => { building = null; });
    return building;
}

// The list file's bytes, read once and kept until the file is written anew (searched as bytes).
let listed = null; // { mtimeMs, bytes }
function listing() {
    return fs.promises.stat(INDEX_PATH).then(st => {
        if (listed && listed.mtimeMs === st.mtimeMs) return listed.bytes;
        return fs.promises.readFile(INDEX_PATH).then(bytes => { listed = { mtimeMs: st.mtimeMs, bytes }; return bytes; });
    });
}

// The lines for [names] of kind [mark] ('m' or 'e'), split into their fields after the name; [] while there is no list yet.
function linesFor(mark, names) {
    if (indexAge() > INDEX_TTL_MS && Date.now() - lastFailedAt > INDEX_RETRY_MS) buildIndex();
    if (!hasIndex()) return Promise.resolve([]);
    return listing().then(list => {
        const found = [];
        new Set(names.map(normalize).filter(Boolean)).forEach(name => {
            const key = Buffer.from(`\n${mark}:${name}\t`, 'utf8');
            let at = list.indexOf(key);
            while (at !== -1) {
                const end = list.indexOf('\n', at + key.length);
                found.push(list.toString('utf8', at + key.length, end === -1 ? list.length : end).split('\t'));
                at = list.indexOf(key, at + key.length);
            }
        });
        return found;
    }).catch(() => []);
}

// ---- Xumo's own catalog ---------------------------------------------------------

// The catalog file, read once and kept until it is written anew: { rows, titles, order } (see noteTitle); empty while there is none.
let catalogKept = null; // { mtimeMs, catalog }
const NO_CATALOG = { rows: [], titles: {}, order: [] };
function loadCatalog() {
    if (indexAge() > INDEX_TTL_MS && Date.now() - lastFailedAt > INDEX_RETRY_MS) buildIndex();
    return fs.promises.stat(CATALOG_PATH).then(st => {
        if (catalogKept && catalogKept.mtimeMs === st.mtimeMs) return catalogKept.catalog;
        return fs.promises.readFile(CATALOG_PATH, 'utf8').then(text => {
            catalogKept = { mtimeMs: st.mtimeMs, catalog: JSON.parse(text) };
            return catalogKept.catalog;
        });
    }).catch(() => NO_CATALOG);
}

// The row names the manifest offers as genres, which has to be built at once: the last ones known.
function genreOptions() {
    loadCatalog();
    return catalogKept ? Array.from(new Set(catalogKept.catalog.rows.map(r => r.name))) : [];
}

function metaOf(catalog, id) {
    const [kind, name] = catalog.titles[id];
    return {
        id: `${PREFIX}${kind}:${id}`,
        type: kind === 's' ? 'series' : 'movie',
        name,
        poster: `${IMAGES}${id}/600x900.webp`,
        background: `${IMAGES}${id}/1280x720.jpg`,
        genres: Array.from(new Set(catalog.rows.filter(r => r.ids.includes(id)).map(r => r.name))).slice(0, 4)
    };
}

// The ids of [kind] ('m' | 's') a catalog request stands for ([e]: { genre, search, match }), in
// the catalog's order: the rows of Xumo's own pages first, then everything else it has.
function catalogIds(catalog, kind, e) {
    const ofKind = (id) => catalog.titles[id] && catalog.titles[id][0] === kind;
    const unique = (ids) => Array.from(new Set(ids)).filter(ofKind);
    const rows = catalog.rows.filter(r => r.kind === kind);
    if (e.search) {
        const words = normalize(e.search).split(' ').filter(Boolean);
        if (!words.length) return [];
        const hit = (id) => { const name = ` ${normalize(catalog.titles[id][1])}`; return words.every(w => name.includes(` ${w}`)); };
        return unique(rows.flatMap(r => r.ids).concat(catalog.order)).filter(hit);
    }
    const pick = e.match || (e.genre ? (name) => name === e.genre : null);
    if (pick) return unique(rows.filter(r => pick(r.name)).flatMap(r => r.ids));
    return unique(rows.flatMap(r => r.ids).concat(catalog.order));
}

// type 'movie' | 'series'; extra { genre, search, skip, match }: `genre` is one of Xumo's rows by
// name, `match` a function choosing rows by name (a genre catalog, lib/genreRows.js).
function catalog(type, extra) {
    const e = extra || {};
    const skip = Number(e.skip) || 0;
    return loadCatalog().then(c => catalogIds(c, type === 'series' ? 's' : 'm', e).slice(skip, skip + PAGE).map(id => metaOf(c, id)));
}

function parseId(id) {
    const m = /^xumo:(m|s|e):([A-Za-z0-9]+)$/.exec(id || '');
    return m ? { kind: m[1], id: m[2] } : null;
}

// A series' episodes as the lists have them ([{ id, season, episode, title }], in order): those of
// the series with this id, or - lists written before episodes carried it - of the series by name.
function episodesOf(seriesId, name) {
    return linesFor('e', [name]).then(lines => {
        const own = lines.filter(f => f[4] === seriesId);
        return (own.length ? own : lines.filter(f => !f[4])).map(([id, s, e, title]) => ({ id, season: Number(s), episode: Number(e), title }))
            .sort((a, b) => a.season - b.season || a.episode - b.episode);
    });
}

// A film's or series' page: Xumo's description, and a series' episodes.
function meta(fullId) {
    const p = parseId(fullId);
    if (!p || p.kind === 'e') return Promise.resolve(null);
    return loadCatalog().then(c => {
        if (!c.titles[p.id] || c.titles[p.id][0] !== p.kind) return null;
        const base = metaOf(c, p.id);
        return get(`/assets/asset/${p.id}.json?f=title&f=descriptions&f=runtime`).then(a => {
            const d = (a && a.descriptions) || {};
            const m = Object.assign(base, { description: d.large || d.medium || d.small || d.tiny || undefined });
            if (p.kind === 'm') return Object.assign(m, { runtime: a && a.runtime ? `${Math.round(a.runtime / 60)} min` : undefined });
            return episodesOf(p.id, base.name).then(episodes => Object.assign(m, {
                videos: episodes.map(e => ({ id: `${PREFIX}e:${e.id}`, title: e.title || `Episode ${e.episode}`, season: e.season, episode: e.episode, thumbnail: `${IMAGES}${e.id}/600x340.webp` }))
            }));
        });
    });
}

// The stream of a film or episode by Xumo's own id (as a provider gives them: the answerer makes Stremio streams of them).
function streams(fullId) {
    const p = parseId(fullId);
    return p && p.kind !== 's' ? streamsOf(p.id) : Promise.resolve([]);
}

// ---- a title's streams -------------------------------------------------------------

// The stream of a film or episode from its own data: its plain HLS one (none when it only has protected ones, see the top).
function streamsOf(id) {
    return get(`/assets/asset/${id}.json?f=providers&f=title`).then(a => {
        const provider = ((a && a.providers) || []).find(p => (p.sources || []).length);
        if (!provider) return [];
        const sources = provider.sources;
        const chosen = sources.find(s => s.produces === 'application/x-mpegURL' && !s.drm && s.uri);
        if (!chosen) return [];
        const subtitles = (provider.captions || [])
            .filter(c => c.type === 'text/vtt' && c.url)
            .map(c => ({ url: c.url, lang: String(c.lang || 'en').slice(0, 2) }));
        const quality = chosen.height ? `${chosen.height}p` : null;
        return [{
            name: 'Xumo Play',
            // The stream is the title itself: Xumo's adverts come from its own player.
            title: [quality, 'Free on Xumo Play'].filter(Boolean).join(' | '),
            quality: quality || undefined,
            url: chosen.uri,
            provider: 'xumo',
            // The service's own stream of the title (see addon-server.js: clients can put those first).
            official: true,
            subtitles: subtitles.length ? subtitles : undefined,
            behaviorHints: { notWebReady: true }
        }];
    });
}

// What is asked, as TMDB knows it: its names and length, and for an episode its title and its season's episodes.
function wantedTitle(tmdbId, mediaType, season, episode) {
    return tmdb.getDetails(tmdbId, mediaType).then(d => {
        const w = {
            titles: [d.title, d.name, d.original_title, d.original_name].filter(Boolean),
            seconds: (Number(d.runtime) || 0) * 60
        };
        if (mediaType !== 'tv') return w;
        return tmdb.getSeasonEpisodes(tmdbId, season).then(s => {
            const siblings = ((s && s.episodes) || []).map(e => ({ episode: e.episode_number, title: e.name }));
            const own = siblings.find(e => Number(e.episode) === Number(episode));
            return Object.assign(w, { season, episode, episodeTitle: own ? own.title : null, siblings });
        });
    });
}

// Of the films with the asked name, the ids whose length is the asked one's (all of them when either length is unknown).
function filmIds(lines, wanted) {
    return lines.filter(([, seconds]) => {
        const s = Number(seconds) || 0;
        return !s || !wanted.seconds || Math.abs(s - wanted.seconds) <= RUNTIME_SLACK(wanted.seconds);
    }).map(([id]) => id).slice(0, MAX_CANDIDATES);
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Xumo] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);
    // The ids Xumo's own catalog listed this very title under (it was handed out as an ordinary
    // title from there): those are it, whatever its name and length say.
    const listed = regularTitle.listedIds(tmdbId, mediaType, PREFIX).map(parseId).filter(Boolean);
    return wantedTitle(tmdbId, mediaType, season, episode).then(wanted => {
        const tryNext = (ids) => (ids.length ? streamsOf(ids[0]).then(s => (s.length ? s : tryNext(ids.slice(1)))) : Promise.resolve([]));
        const asked = { season: wanted.season, episode: wanted.episode, title: wanted.episodeTitle };
        if (mediaType !== 'tv') {
            return tryNext(listed.filter(p => p.kind === 'm').map(p => p.id).reverse())
                .then(found => (found.length ? found : linesFor('m', wanted.titles).then(lines => tryNext(filmIds(lines, wanted)))));
        }
        const series = listed.filter(p => p.kind === 's').pop();
        const fromCatalog = !series ? Promise.resolve(null) : loadCatalog()
            .then(c => (c.titles[series.id] ? episodesOf(series.id, c.titles[series.id][1]) : []))
            .then(videos => pickEpisode(videos, asked, wanted.siblings));
        return fromCatalog.then(found => found || linesFor('e', wanted.titles).then(lines => {
            const videos = lines.map(([id, s, e, title]) => ({ id, season: Number(s), episode: Number(e), title }))
                .sort((a, b) => a.season - b.season || a.episode - b.episode);
            return pickEpisode(videos, asked, wanted.siblings);
        })).then(found => (found ? streamsOf(found.id) : []));
    }).then(streams => {
        console.log(`[Xumo] ${streams.length} stream(s)`);
        return streams;
    }).catch(err => {
        console.log(`[Xumo] getStreams failed: ${err.message}`);
        return [];
    });
}

// At the server's start: the lists of Xumo's titles are looked up when there are none or they are old, so the first search needn't wait for them.
function warmUp() {
    if (indexAge() > INDEX_TTL_MS && Date.now() - lastFailedAt > INDEX_RETRY_MS) buildIndex();
    loadCatalog();
}

module.exports = { PREFIX, getStreams, warmUp, buildIndex, catalog, genreOptions, meta, streams, parseId, lineOf, filmIds, noteTitle, catalogIds, onlyProtected };
