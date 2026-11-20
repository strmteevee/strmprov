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

const fs = require('fs');
const path = require('path');
const tmdb = require('../lib/tmdb');
const { normalize, pickEpisode } = require('../lib/titleMatch');

const API = 'https://valencia-app-mds.xumo.com/v2';
// Xumo Play's channel list for the US, as its own site asks for it.
const CHANNEL_LIST = '10006';
// The site's "Movies" and "TV Shows" pages: channels of their own, not in the list.
const HUB_CHANNELS = ['99991334', '9999699'];
const INDEX_PATH = path.join(__dirname, '..', 'data', 'xumo-index.txt');
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

function indexAge() {
    try { return Date.now() - fs.statSync(INDEX_PATH).mtimeMs; } catch (e) { return Infinity; }
}

// One line per title: "m:<name>\t<id>\t<seconds>" for a film, "e:<series name>\t<id>\t<season>\t<episode>\t<title>" for an episode (names as normalize() makes them).
function lineOf(a) {
    const name = normalize(a.title);
    if (!name || !a.id) return null;
    const clean = (s) => String(s || '').replace(/[\t\n\r]/g, ' ');
    if (a.contentType === 'MOVIE') return `m:${name}\t${a.id}\t${Number(a.runtime) || 0}`;
    if (a.contentType === 'EPISODIC' && a.season && a.episode) return `e:${name}\t${a.id}\t${a.season}\t${a.episode}\t${clean(a.episodeTitle)}`;
    return null;
}

function buildIndex() {
    if (building) return building;
    const startedAt = Date.now();
    building = get(`/channels/list/${CHANNEL_LIST}.json?geoId=unknown`, 30000).then(list => {
        const channels = ((list && list.channel && list.channel.item) || [])
            .filter(c => c.properties && c.properties.has_vod === 'true')
            .map(c => c.guid && c.guid.value).filter(Boolean);
        if (!channels.length) throw new Error('Xumo listed no channels with titles');
        const queue = HUB_CHANNELS.concat(channels.filter(c => !HUB_CHANNELS.includes(c)));
        const seen = new Set();
        const lines = [];
        const counted = { m: 0, e: 0 };
        const fields = ['title', 'runtime', 'season', 'episode', 'episodeTitle'].map(f => `f=asset.${f}`).join('&');
        // A few workers, each a channel at a time and its categories one by one.
        const worker = () => {
            const channel = queue.shift();
            if (!channel) return Promise.resolve();
            return get(`/channels/channel/${channel}/categories.json`).then(c => {
                const categories = ((c && c.categories) || []).map(cat => cat.categoryId).filter(Boolean);
                const nextCategory = (i) => {
                    if (i >= categories.length) return Promise.resolve();
                    return get(`/categories/category/${categories[i]}.json?${fields}`).then(r => {
                        ((r && r.results) || []).forEach(a => {
                            if (seen.has(a.id)) return;
                            seen.add(a.id);
                            const line = lineOf(a);
                            if (line) { lines.push(line); counted[line[0]]++; }
                        });
                        return nextCategory(i + 1);
                    });
                };
                return nextCategory(0);
            }).then(worker);
        };
        return Promise.all(Array.from({ length: AT_ONCE }, worker)).then(() => {
            if (!counted.m) throw new Error('Xumo\'s lists had no films');
            fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
            const tmp = `${INDEX_PATH}.tmp`;
            fs.writeFileSync(tmp, '\n' + lines.join('\n') + '\n');
            fs.renameSync(tmp, INDEX_PATH);
            console.log(`[Xumo] ${counted.m} films and ${counted.e} episodes listed from ${channels.length} channels in ${Math.round((Date.now() - startedAt) / 1000)} s`);
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
    if (indexAge() === Infinity) return Promise.resolve([]);
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
    return wantedTitle(tmdbId, mediaType, season, episode).then(wanted => {
        if (mediaType !== 'tv') {
            return linesFor('m', wanted.titles).then(lines => {
                const tryNext = (ids) => (ids.length ? streamsOf(ids[0]).then(s => (s.length ? s : tryNext(ids.slice(1)))) : Promise.resolve([]));
                return tryNext(filmIds(lines, wanted));
            });
        }
        return linesFor('e', wanted.titles).then(lines => {
            const videos = lines.map(([id, s, e, title]) => ({ id, season: Number(s), episode: Number(e), title }))
                .sort((a, b) => a.season - b.season || a.episode - b.episode);
            const found = pickEpisode(videos, { season: wanted.season, episode: wanted.episode, title: wanted.episodeTitle }, wanted.siblings);
            return found ? streamsOf(found.id) : [];
        });
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
}

module.exports = { getStreams, warmUp, buildIndex, lineOf, filmIds };
