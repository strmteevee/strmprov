// Tubi (US, free with adverts) as a stream source for movies and series:
// when Tubi has the title and offers it unprotected, its stream is one of the
// title's sources. Tubi shows Europe only a notice, so its site is asked
// through a US tunnel (the one of Plex (US) or Pluto TV (US),
// lib/wireguard.js); none running = no Tubi. Tested 2026-11-16 through the
// tunnel:
//   finding  -> Tubi's own API wants a token its player signs for; that is
//               left alone. Its sitemap (tubitv.com/sitemap.xml) says what it
//               has: 8 lists of up to 10,000 films (some 9 MB each,
//               /movies/<id>/<name-in-the-address>) and 2 of series (11,922,
//               /series/<id>/<name>). That is kept in a file
//               (data/tubi-index.txt, looked up again after INDEX_TTL_MS) and
//               read for a title's name as an address.
//   a film   -> its page (tubitv.com/movies/<id>) carries the film's data for
//               a visitor without an account: its IMDb id (which settles
//               whether it is the asked film), the streams and the subtitles.
//   a series -> its page (tubitv.com/series/<id>) carries its seasons with
//               every episode the same way (an episode's title reads
//               "S01:E01 - Secret Cabin Construction"). The episode is found
//               by its title, like at Pluto (lib/titleMatch.js): services
//               count seasons their own way. Of the later seasons the page
//               only lists the episodes' ids ("Forensic Files": 375 in 14
//               seasons); such an episode's own page
//               (tubitv.com/tv-shows/<id>) carries it like a film's does, and
//               counts when its title is the asked episode's.
//   playing  -> of 16 films picked at random 14 had a plain HLS stream
//               ("hlsv6"), 2 only protected ones (Widevine/PlayReady/FairPlay
//               with a licence service): those are left out. The plain
//               stream's playlists and video load from anywhere, so they are
//               given out as they are. The stream is the film itself (45
//               minutes of film, no breaks): Tubi's adverts come from its own
//               player.

const fs = require('fs');
const path = require('path');
const tmdb = require('../lib/tmdb');
const wireguard = require('../lib/wireguard');
const { tunnelFetch } = require('../lib/tunnelFetch');
const { normalize, pickEpisode } = require('../lib/titleMatch');

const SITE = 'https://tubitv.com';
// The tunnels that come out in the US, in order of preference.
const US_SOURCES = ['plex-us', 'plutotv'];
const INDEX_PATH = path.join(__dirname, '..', 'data', 'tubi-index.txt');
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// After a failed look-up of the lists: not again for a while.
const INDEX_RETRY_MS = 30 * 60 * 1000;
const PAGE_TTL_MS = 60 * 60 * 1000;
const MAX_PAGES_KEPT = 40;
// Titles with the same name as an address that are looked at for one title.
const MAX_CANDIDATES = 6;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// What Tubi calls each kind in its addresses and lists.
const KINDS = {
    movie: { path: 'movies', lists: /<loc>[^<]*\/sitemaps\/movies-\d+\.xml<\/loc>/g, address: /\/movies\/(\d+)\/([^<\s/]+)/g, mark: 'm' },
    series: { path: 'series', lists: /<loc>[^<]*\/sitemaps\/tv-shows-\d+\.xml<\/loc>/g, address: /\/series\/(\d+)\/([^<\s/]+)/g, mark: 's' }
};

function proxy() {
    for (const source of US_SOURCES) {
        const p = wireguard.proxyFor(source);
        if (p) return p;
    }
    return null;
}

function page(url, timeoutMs) {
    const p = proxy();
    if (!p) return Promise.reject(new Error('No running US tunnel'));
    return tunnelFetch(p, url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,*/*' }, timeoutMs: timeoutMs || 20000 }).then(r => {
        if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
        // (Outside the US every address ends at a notice.)
        if (/gdpr\.tubi\.tv/.test(r.url || '')) throw new Error('Tubi does not serve this address (not a US tunnel?)');
        return r.text();
    });
}

// ---- what Tubi has: its sitemap, kept in a file ------------------------------------

let building = null;
let lastFailedAt = 0;

function indexAge() {
    try { return Date.now() - fs.statSync(INDEX_PATH).mtimeMs; } catch (e) { return Infinity; }
}

// Tubi's films and series as lines "<m|s>:<name in the address>\t<id>", written to INDEX_PATH. One list at a time.
function buildIndex() {
    if (building) return building;
    building = page(`${SITE}/sitemap.xml`).then(index => {
        const lists = [];
        Object.keys(KINDS).forEach(kind => (index.match(KINDS[kind].lists) || []).forEach(l => lists.push({ kind, url: l.slice(5, -6) })));
        if (!lists.some(l => l.kind === 'movie')) throw new Error('Tubi\'s sitemap lists no films');
        const tmp = `${INDEX_PATH}.tmp`;
        fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
        fs.writeFileSync(tmp, '\n');
        const counted = { movie: 0, series: 0 };
        const next = (i) => {
            if (i >= lists.length) return Promise.resolve();
            const k = KINDS[lists[i].kind];
            // (A list of films is some 9 MB: it names every film's pictures too.)
            return page(lists[i].url, 120000).then(xml => {
                const lines = [];
                const re = new RegExp(k.address.source, 'g');
                let m;
                while ((m = re.exec(xml))) lines.push(`${k.mark}:${m[2].toLowerCase()}\t${m[1]}`);
                counted[lists[i].kind] += lines.length;
                if (lines.length) fs.appendFileSync(tmp, lines.join('\n') + '\n');
                return next(i + 1);
            });
        };
        return next(0).then(() => {
            if (!counted.movie) throw new Error('Tubi\'s film lists were empty');
            fs.renameSync(tmp, INDEX_PATH);
            console.log(`[Tubi] ${counted.movie} films and ${counted.series} series listed (${lists.length} lists)`);
        });
    }).catch(err => {
        lastFailedAt = Date.now();
        console.log(`[Tubi] Listing its titles failed: ${err.message}`);
    }).finally(() => { building = null; });
    return building;
}

// The ids of the titles of [kind] whose address has one of [names] (see addressNames); [] while there is no list yet.
function idsFor(kind, names) {
    const age = indexAge();
    if (age > INDEX_TTL_MS && Date.now() - lastFailedAt > INDEX_RETRY_MS) {
        const build = buildIndex();
        // No list at all yet: this request waits for it (a stream search allows that); an old one does for now.
        if (age === Infinity) return build.then(() => (indexAge() === Infinity ? [] : idsFor(kind, names)));
    }
    if (age === Infinity) return Promise.resolve([]);
    return fs.promises.readFile(INDEX_PATH, 'utf8').then(text => {
        const ids = [];
        names.forEach(name => {
            const key = `\n${KINDS[kind].mark}:${name}\t`;
            let at = text.indexOf(key);
            while (at !== -1) {
                const end = text.indexOf('\n', at + key.length);
                const id = text.slice(at + key.length, end === -1 ? undefined : end);
                if (id && !ids.includes(id)) ids.push(id);
                at = text.indexOf(key, at + key.length);
            }
        });
        return ids;
    }).catch(() => []);
}

// A title as Tubi writes it in an address ("Dauntless: The Battle of Midway"
// is dauntless-the-battle-of-midway, "The Devil's Party" the-devil-s-party).
// "&" both ways, and an apostrophe too in case not every address has it so.
function addressNames(titles) {
    const out = new Set();
    (titles || []).filter(Boolean).forEach(title => {
        const plain = String(title).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const dashed = (s) => s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        [plain, plain.replace(/['’]/g, '')].forEach(s => {
            out.add(dashed(s));
            out.add(dashed(s.replace(/&/g, ' and ')));
        });
    });
    out.delete('');
    return Array.from(out);
}

// ---- a title's page ------------------------------------------------------------------

// The JSON value (array or object) that starts at [start] in [text], or null.
// The page's data is a script, not strict JSON: a field without a value reads
// `undefined` there, taken as null.
function jsonAt(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === '\\') i++;
            else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') {
            depth--;
            if (depth === 0) {
                const value = text.slice(start, i + 1);
                try { return JSON.parse(value); } catch (e) { /* not strict JSON: below */ }
                try { return JSON.parse(value.replace(/":undefined([,}])/g, '":null$1')); } catch (e) { return null; }
            }
        }
    }
    return null;
}

// What is needed of a film or episode as Tubi describes it.
function playable(data) {
    return {
        needsLogin: data.needs_login === true,
        resources: (Array.isArray(data.video_resources) ? data.video_resources : []).map(r => ({
            type: r && r.type, resolution: r && r.resolution, protected: !!(r && r.license_server), url: r && r.manifest && r.manifest.url
        })),
        subtitles: (Array.isArray(data.subtitles) ? data.subtitles : []).filter(s => s && s.url).map(s => ({ url: s.url, lang: s.lang_alpha3 || s.lang }))
    };
}

function identity(data) {
    return {
        imdbId: /^tt\d+$/.test(data.imdb_id || '') ? data.imdb_id : null,
        title: data.title || null,
        year: Number(data.year) || null
    };
}

// What a film's page says about film [id]: { imdbId, title, year, needsLogin, resources, subtitles }, or null.
function filmIn(html, id) {
    // The page's data keeps every film and episode it shows under its id: the one that is this id's own.
    const prefix = `"${id}":`;
    for (let at = html.indexOf(prefix); at !== -1; at = html.indexOf(prefix, at + prefix.length)) {
        if (html[at + prefix.length] !== '{') continue;
        const data = jsonAt(html, at + prefix.length);
        if (data && typeof data === 'object' && String(data.id) === String(id) && Array.isArray(data.video_resources)) {
            return Object.assign(identity(data), playable(data));
        }
    }
    return null;
}

// "S01:E01 - Secret Cabin Construction" -> the episode's own title.
function episodeTitle(title) {
    return String(title || '').replace(/^\s*S\d+\s*:\s*E\d+\s*[-–:]\s*/i, '').trim();
}

// What a series' page says about series [id]: { imdbId, title, year,
// episodes: [{ id, season, episode, title, needsLogin, resources, subtitles }] }, or null.
function seriesIn(html, id) {
    // (The series is kept under its id with a 0 in front; its episodes under their own.)
    const prefix = `"0${id}":`;
    const at = html.indexOf(prefix);
    if (at === -1) return null;
    const data = jsonAt(html, at + prefix.length);
    if (!data || typeof data !== 'object') return null;
    const episodes = [];
    (Array.isArray(data.seasons) ? data.seasons : []).forEach(season => (season.episodes || []).forEach((ep, i) => {
        if (!ep || !ep.id) return;
        episodes.push(Object.assign({
            id: String(ep.id),
            season: Number(season.number) || 0,
            episode: Number(ep.episode_number) || i + 1,
            title: episodeTitle(ep.title)
        }, playable(ep)));
    }));
    return Object.assign(identity(data), { episodes });
}

// Every episode a series' page lists, of all its seasons: [{ id, season, episode }]. The page
// carries the first season's episodes whole (seriesIn) and of the others only these ids.
function seasonListIn(html) {
    const mark = html.indexOf('"queryKey":["seriesPaginationInfo"');
    const at = mark === -1 ? -1 : html.lastIndexOf('"data":{"seasons":[', mark);
    const data = at === -1 ? null : jsonAt(html, at + '"data":'.length);
    const out = [];
    ((data && data.seasons) || []).forEach(season => (season.episodes || []).forEach(ep => {
        if (ep && ep.id) out.push({ id: String(ep.id), season: Number(season.number) || 0, episode: Number(ep.num) || 0 });
    }));
    return out;
}

const pages = new Map(); // "<kind>|<id>" -> { at, title: Promise }
function titlePage(kind, id) {
    const key = `${kind}|${id}`;
    const kept = pages.get(key);
    if (kept && Date.now() - kept.at < PAGE_TTL_MS) return kept.title;
    const found = kind === 'series'
        ? page(`${SITE}/series/${id}`).then(html => { const s = seriesIn(html, id); return s && Object.assign(s, { listed: seasonListIn(html) }); })
        // A film's page, or an episode's (which carries the episode the same way).
        : page(`${SITE}/${kind === 'episode' ? 'tv-shows' : 'movies'}/${id}`).then(html => filmIn(html, id));
    pages.delete(key);
    pages.set(key, { at: Date.now(), title: found });
    while (pages.size > MAX_PAGES_KEPT) pages.delete(pages.keys().next().value);
    found.catch(() => pages.delete(key));
    return found;
}

// The stream of a film or episode as its page describes it; none when it is only offered protected or to a signed-in viewer.
function streamOf(f) {
    if (f.needsLogin) return [];
    const plain = f.resources.find(r => /^hlsv\d$/.test(r.type || '') && !r.protected && r.url);
    if (!plain) return [];
    const quality = /^\d+p$/i.test(plain.resolution || '') ? plain.resolution.toLowerCase() : null;
    return [{
        name: 'Tubi',
        // The stream is the film itself: Tubi's adverts come from its own player, not the stream.
        title: [quality, 'Free on Tubi'].filter(Boolean).join(' | '),
        quality: quality || undefined,
        url: plain.url,
        provider: 'tubi',
        // The service's own stream of the title (see addon-server.js: clients can put those first).
        official: true,
        subtitles: f.subtitles,
        behaviorHints: { notWebReady: true }
    }];
}

// Whether a title on Tubi ([t]) is the asked one: by its IMDb id when Tubi
// gives one; else by name and year; and a series Tubi gives no year for, by
// name and the asked episode's title being among its episodes'.
function isTitle(t, wanted) {
    if (t.imdbId && wanted.imdbId) return t.imdbId === wanted.imdbId;
    if (!wanted.titles.some(name => normalize(name) === normalize(t.title))) return false;
    if (t.year && wanted.year) return Math.abs(t.year - wanted.year) <= 1;
    const asked = normalize(wanted.episodeTitle);
    return !!asked && (t.episodes || []).some(e => normalize(e.title) === asked);
}

// Whether an episode on Tubi (by its title) is the asked one: the same title, one that only adds
// to it ("Tonight, Tonight" for "Tonight, Tonight (1)"), or an asked episode that has no title of its own.
function sameEpisode(tubiTitle, askedTitle) {
    const asked = normalize(askedTitle);
    if (!asked || /^(episode|aflevering|ep) ?\d+$/.test(asked)) return true;
    const theirs = normalize(episodeTitle(tubiTitle));
    if (!theirs) return false;
    return theirs === asked || (Math.min(theirs.length, asked.length) >= 4 && (theirs.startsWith(asked) || asked.startsWith(theirs)));
}

// The asked episode of a series as its page has it: among the episodes it carries whole, else its
// own page when the series lists one at the asked season and number with the asked title.
function episodeStream(series, wanted) {
    const whole = pickEpisode(series.episodes, { season: wanted.season, episode: wanted.episode, title: wanted.episodeTitle }, wanted.siblings);
    if (whole) return Promise.resolve(streamOf(whole));
    const listed = (series.listed || []).find(e => e.season === Number(wanted.season) && e.episode === Number(wanted.episode));
    if (!listed) return Promise.resolve([]);
    return titlePage('episode', listed.id).then(ep => (ep && sameEpisode(ep.title, wanted.episodeTitle) ? streamOf(ep) : []));
}

// What is asked, as TMDB knows it: the names it goes by, its year and IMDb id, and for an episode its title and its season's episodes.
function wantedTitle(tmdbId, mediaType, season, episode) {
    return Promise.all([tmdb.getDetails(tmdbId, mediaType), tmdb.getImdbId(tmdbId, mediaType)]).then(([d, imdbId]) => {
        const w = {
            imdbId,
            titles: [d.title, d.name, d.original_title, d.original_name].filter(Boolean),
            year: Number((d.release_date || d.first_air_date || '').slice(0, 4)) || null
        };
        if (mediaType !== 'tv') return w;
        return tmdb.getSeasonEpisodes(tmdbId, season).then(s => {
            const siblings = ((s && s.episodes) || []).map(e => ({ episode: e.episode_number, title: e.name }));
            const own = siblings.find(e => Number(e.episode) === Number(episode));
            return Object.assign(w, { season, episode, episodeTitle: own ? own.title : null, siblings });
        });
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Tubi] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);
    if (!proxy()) return Promise.resolve([]);
    const kind = mediaType === 'tv' ? 'series' : 'movie';
    return wantedTitle(tmdbId, mediaType, season, episode).then(wanted => idsFor(kind, addressNames(wanted.titles)).then(ids => {
        const tryNext = (i) => {
            if (i >= ids.length || i >= MAX_CANDIDATES) return Promise.resolve([]);
            return titlePage(kind, ids[i]).catch(() => null).then(t => {
                if (!t || !isTitle(t, wanted)) return tryNext(i + 1);
                return kind === 'movie' ? streamOf(t) : episodeStream(t, wanted);
            });
        };
        return tryNext(0);
    })).then(streams => {
        console.log(`[Tubi] ${streams.length} stream(s)`);
        return streams;
    }).catch(err => {
        console.log(`[Tubi] getStreams failed: ${err.message}`);
        return [];
    });
}

// At the server's start: the lists of Tubi's titles are looked up when there are none or they are old, so the first search needn't wait for them.
function warmUp() {
    if (proxy() && indexAge() > INDEX_TTL_MS && Date.now() - lastFailedAt > INDEX_RETRY_MS) buildIndex();
}

module.exports = { getStreams, warmUp, addressNames, filmIn, seriesIn, seasonListIn, streamOf, isTitle, episodeTitle, sameEpisode };
