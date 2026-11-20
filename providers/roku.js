// The Roku Channel (US, free with adverts) as a stream source for movies and
// series: when it has the title for free, its stream is one of the title's
// sources. Its site only answers the US (therokuchannel.roku.com sends
// everyone to app.roku.com, and that the rest of the world away), so it is
// asked through a US tunnel (the one of Plex (US) or Pluto TV (US),
// lib/wireguard.js); none running = no Roku. Looked at 2026-11-20 through the
// tunnel, as a visitor without an account:
//   session  -> /api/v1/csrf hands a visitor a token and cookies; every other
//               request carries them (SESSION_TTL_MS).
//   finding  -> POST /api/v1/search { query } gives titles with their name,
//               year, kind and where they play ("viewOptions"): the free,
//               advert-paid ones are Roku's own "rokuavod". A title counts
//               when its name and year are the asked ones (lib/titleMatch.js).
//   a title  -> /api/v2/homescreen/content/<its address at content.sr.roku.com>
//               has a film's or episode's data, and for a series its episodes
//               by season and number only (no titles: "Monk", 125 of them).
//               So the episode at the asked numbers is looked at, and counts
//               when its title is the asked one's, or when Roku's season is as
//               long as the asked one (then the numbers mean the same).
//   playing  -> POST /api/v3/playback { rokuId, playId, mediaFormat, drmType,
//               quality, providerId } answers with a DASH description and the
//               address of Roku's Widevine licence service with a token in it.
//               Every title is protected. The very same request is refused
//               about every other time (HTTP 451, "not in your region": 6 of
//               10 in a row, whatever headers it carries) - each request is a
//               new connection through the tunnel, which comes out on an IPv4
//               address one time and an IPv6 one the next, and Roku seems to
//               place only one of them in the US. So that request is asked
//               again a few times (PLAY_TRIES) before giving up, through the
//               other US tunnel in turn when two run. (Six refusals in a row
//               were seen too: then there is no stream this time.)
//               The description answers from anywhere, but the video itself
//               (vod.delivery.roku.com) refuses everyone outside the US. So,
//               unlike Tubi's, the whole stream comes through this server and
//               the tunnel:
//                 /roku/dash.mpd?id=  the description, asked for at that moment
//                                     (the token in it is fresh when playing
//                                     starts), its video addresses pointed at
//                 /roku/seg/<host>/…  a piece of video or sound, passed on
//                 /roku/licence?id=   the player's licence request, passed on
//               Nothing is decrypted here: the TV's own Widevine asks Roku's
//               service for the licence (`drm`, not a Stremio field:
//               OmniStream reads it). The stream is the title itself: Roku's
//               adverts come from its own player. Subtitles (WebVTT) answer
//               from anywhere and are given as they are.

const tmdb = require('../lib/tmdb');
const wireguard = require('../lib/wireguard');
const { tunnelFetch } = require('../lib/tunnelFetch');
const { matchingTitles, sameEpisodeTitle, isPlaceholderTitle } = require('../lib/titleMatch');
const { PLACEHOLDER } = require('../lib/relayAddress');

const SITE = 'https://app.roku.com';
const CONTENT = 'https://content.sr.roku.com/content/v1/roku-trc/';
const US_SOURCES = ['plex-us', 'plutotv'];
// Roku's own free, advert-paid offer of a title (the others are subscriptions and shops).
const FREE_PROVIDER = 'rokuavod';
const SESSION_TTL_MS = 30 * 60 * 1000;
// How long a playback answer serves the requests that belong together: the description, then the licence.
const PLAY_TTL_MS = 2 * 60 * 1000;
const MAX_PLAYS_KEPT = 20;
// How often the playback request is asked before a refusal (451) is taken for an answer, and the pause between.
const PLAY_TRIES = 8;
const PLAY_RETRY_MS = 600;
const REQUEST_TIMEOUT_MS = 20000;
const SEGMENT_TIMEOUT_MS = 30000;
// Names a title goes by that are searched for, and search hits that are looked at.
const MAX_NAMES = 2;
const MAX_CANDIDATES = 3;
// The hosts a description's video may be on, and that are passed on.
const VIDEO_HOSTS = /(^|\.)roku\.com$/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The US tunnels that run, the usual one first.
function proxies() {
    return US_SOURCES.map(source => wireguard.proxyFor(source)).filter(Boolean);
}

function proxy() {
    return proxies()[0] || null;
}

// ---- a visitor's session, and requests with it ---------------------------------

let visitor = null; // { at, cookie, csrf } or a Promise of it

function session() {
    if (visitor && (visitor.then || Date.now() - visitor.at < SESSION_TTL_MS)) return Promise.resolve(visitor);
    const p = proxy();
    if (!p) return Promise.reject(new Error('No running US tunnel'));
    visitor = tunnelFetch(p, `${SITE}/api/v1/csrf`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs: REQUEST_TIMEOUT_MS }).then(r => {
        const csrf = r.status === 200 ? (JSON.parse(r.text()).csrf || null) : null;
        if (!csrf) throw new Error(`Roku gave no visitor token (HTTP ${r.status})`);
        const cookie = [].concat(r.headers['set-cookie'] || []).map(c => String(c).split(';')[0]).join('; ');
        visitor = { at: Date.now(), cookie, csrf };
        return visitor;
    }).catch(err => { visitor = null; throw err; });
    return visitor;
}

// One of the site's own API addresses, as its pages ask for it ([through]: the tunnel, the usual
// one unless given). -> the answer as JSON, or throws (the error's `status` is Roku's).
function api(path, body, again, through) {
    return session().then(s => {
        const headers = {
            'User-Agent': UA, Accept: 'application/json', Cookie: s.cookie, 'csrf-token': s.csrf,
            Origin: SITE, Referer: `${SITE}/`, 'x-requested-with': 'XMLHttpRequest',
            // (Its player sends the viewer's time zone.)
            'x-roku-reserved-time-zone-offset': '-05:00'
        };
        const text = body ? JSON.stringify(body) : null;
        if (text) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(text); }
        return tunnelFetch(through || proxy(), `${SITE}${path}`, { method: text ? 'POST' : 'GET', body: text || undefined, headers, timeoutMs: REQUEST_TIMEOUT_MS }).then(r => {
            // A token that ran out: once more with a new visitor.
            if (r.status === 403 && !again) { visitor = null; return api(path, body, true, through); }
            if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status} from Roku (${path.split('?')[0].slice(0, 40)})`), { status: r.status });
            return JSON.parse(r.text());
        });
    });
}

function content(id) {
    return api(`/api/v2/homescreen/content/${encodeURIComponent(CONTENT + id)}`);
}

// ---- reading Roku's answers (no requests in here) ------------------------------

// The titles in a search answer that Roku itself offers for free: [{ id, kind: 'movie' | 'series', name, year }].
function hitsIn(answer) {
    return ((answer && answer.view) || []).map(v => v && v.content).filter(Boolean)
        .filter(c => (c.type === 'movie' || c.type === 'series') && c.meta && c.meta.id && c.title)
        .filter(c => (c.viewOptions || []).some(o => o.providerId === FREE_PROVIDER))
        .map(c => ({ id: c.meta.id, kind: c.type, name: c.title, year: Number(c.releaseYear) || Number(String(c.releaseDate || '').slice(0, 4)) || null }));
}

// A film's or episode's free way of watching, as its data has it: { playId, providerId, quality, subtitles } - or null.
function freeOption(data) {
    const o = ((data && data.viewOptions) || []).find(v => v.providerId === FREE_PROVIDER && v.playId && v.hasMedia !== false && !(Number(v.price) > 0));
    if (!o) return null;
    const subtitles = ((o.media && o.media.captions) || [])
        .filter(c => c && c.url && /\.vtt(\?|$)/i.test(c.url))
        .map(c => ({ url: c.url, lang: String(c.language || 'en').slice(0, 2).toLowerCase() }));
    return { playId: o.playId, providerId: o.providerId, quality: o.in4k ? '2160p' : o.inHd ? '1080p' : '480p', subtitles };
}

// A series' episodes as its data lists them: [{ id, season, episode }].
function episodesIn(data) {
    return ((data && data.episodes) || []).map(e => e && e.meta).filter(m => m && m.id && m.seasonNumber && m.episodeNumber)
        .map(m => ({ id: m.id, season: Number(m.seasonNumber), episode: Number(m.episodeNumber) }));
}

// Whether the episode Roku has at the asked numbers ([data], with [episodes] the series' list) is
// the asked one ({ season, episodeTitle, siblings }): by its title, or - services cut series into
// seasons their own way, and name episodes differently ("Mr. Monk Meets the Candidate, Part 1" for
// "Mr. Monk and the Candidate (1)") - when Roku's season is as long as the asked one.
function isAskedEpisode(data, episodes, wanted) {
    if (isPlaceholderTitle(wanted.episodeTitle) || sameEpisodeTitle(data && data.title, wanted.episodeTitle)) return true;
    const theirs = episodes.filter(e => e.season === Number(wanted.season)).length;
    return theirs > 0 && theirs === (wanted.siblings || []).length;
}

// A DASH description with the addresses of its video and sound pieces pointed at this server's
// /roku/seg/<host>/<path>: the whole ones, a BaseURL, and - when the description has no BaseURL,
// so they are meant beside the description's own address ([mpdUrl]) - the short ones too.
// "$Number$" and the like stay as they are: the player fills them in.
function relayDescription(mpd, mpdUrl, relayBase) {
    const hasBase = /<BaseURL>/.test(mpd);
    const through = (ref) => {
        const text = ref.replace(/&amp;/g, '&');
        const whole = /^https?:\/\//i.test(text);
        // (Beside a BaseURL: that one is pointed here, and these follow it.)
        if (!whole && hasBase) return ref;
        let target;
        try { target = new URL(text, mpdUrl); } catch (e) { return ref; }
        if (target.protocol !== 'https:' || !VIDEO_HOSTS.test(target.hostname)) return ref;
        return `${relayBase}/roku/seg/${target.host}${target.pathname}${target.search}`.replace(/&/g, '&amp;');
    };
    return mpd.replace(/\b(initialization|media|sourceURL)="([^"]+)"/g, (m, name, ref) => `${name}="${through(ref)}"`)
        .replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (m, ref) => `<BaseURL>${through(ref.trim())}</BaseURL>`);
}

// The address a /roku/seg/<host>/<path>?<query> request stands for ([rest]: what follows "/roku/seg/"
// in the request's path, as it came), or null when it isn't one of Roku's.
function segmentAddress(rest, search) {
    const m = /^([a-z0-9.-]+)(\/.+)$/i.exec(String(rest || ''));
    if (!m || !VIDEO_HOSTS.test(m[1])) return null;
    return `https://${m[1]}${m[2]}${search || ''}`;
}

// ---- playing: the description, the video and the licence through the tunnel ----

const plays = new Map(); // id -> { at, play: Promise of { url, licence } }

// Roku's answer to "play this" for a film or episode: where its description is and where the licence is asked.
function play(id) {
    const kept = plays.get(id);
    if (kept && Date.now() - kept.at < PLAY_TTL_MS) return kept.play;
    const asked = content(id).then(data => {
        const option = freeOption(data);
        if (!option) throw new Error('Roku no longer offers this title for free');
        const request = { rokuId: id, playId: option.playId, mediaFormat: 'mpeg-dash', drmType: 'widevine', quality: 'fhd', bifUrl: null, adPolicyId: '', providerId: option.providerId };
        // (Refused every other time for where the connection comes out: see the top.)
        const tunnels = proxies();
        const ask = (n) => api('/api/v3/playback', request, false, tunnels[n % tunnels.length]).catch(err => {
            if (err.status !== 451 || n + 1 >= PLAY_TRIES) throw err;
            return new Promise(resolve => setTimeout(resolve, PLAY_RETRY_MS)).then(() => ask(n + 1));
        });
        return ask(0);
    }).then(answer => {
        const licence = answer && answer.drm && answer.drm.widevine && answer.drm.widevine.licenseServer;
        if (!answer || !answer.url || !licence) throw new Error('Roku gave no stream for this title');
        return { url: answer.url, licence };
    });
    plays.delete(id);
    plays.set(id, { at: Date.now(), play: asked });
    while (plays.size > MAX_PLAYS_KEPT) plays.delete(plays.keys().next().value);
    asked.catch(() => plays.delete(id));
    return asked;
}

const validId = (id) => /^[a-f0-9]{32}$/i.test(String(id || ''));

// /roku/dash.mpd?id= -> { status, body }: the title's description, its pieces pointed at this server ([relayBase]).
function dash(id, relayBase) {
    if (!validId(id)) return Promise.resolve({ status: 400, body: 'Bad id' });
    if (!proxy()) return Promise.resolve({ status: 502, body: 'No VPN tunnel' });
    // (Always a new answer: a description asked for again is a new start of playing.)
    plays.delete(id);
    return play(id).then(p => tunnelFetch(proxy(), p.url, { headers: { 'User-Agent': UA }, timeoutMs: REQUEST_TIMEOUT_MS }).then(r => {
        if (r.status !== 200) return { status: r.status, body: 'Roku gave no description' };
        return { status: 200, body: relayDescription(r.text(), r.url || p.url, relayBase) };
    }));
}

// /roku/seg/<host>/<path> -> { status, type, body: Buffer, range }: a piece of video or sound from Roku, as it is.
function segment(rest, search, range) {
    const address = segmentAddress(rest, search);
    if (!address) return Promise.resolve({ status: 403, body: Buffer.from('Not a Roku address') });
    if (!proxy()) return Promise.resolve({ status: 502, body: Buffer.from('No VPN tunnel') });
    const headers = { 'User-Agent': UA };
    if (range) headers.Range = range;
    return tunnelFetch(proxy(), address, { headers, timeoutMs: SEGMENT_TIMEOUT_MS })
        .then(r => ({ status: r.status, type: r.headers['content-type'], range: r.headers['content-range'], body: r.buffer() }));
}

// POST /roku/licence?id= -> { status, type, body: Buffer }: the player's Widevine licence request ([body]) passed on to Roku's service, and its answer as it is.
function licence(id, body) {
    if (!validId(id)) return Promise.resolve({ status: 400, body: Buffer.from('Bad id') });
    if (!proxy()) return Promise.resolve({ status: 502, body: Buffer.from('No VPN tunnel') });
    return play(id).then(p => tunnelFetch(proxy(), p.licence, {
        method: 'POST', body, timeoutMs: REQUEST_TIMEOUT_MS,
        headers: { 'User-Agent': UA, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, Origin: SITE, Referer: `${SITE}/` }
    })).then(r => ({ status: r.status, type: r.headers['content-type'], body: r.buffer() }));
}

// ---- as a source for ordinary titles ----------------------------------------------

function stream(id, option) {
    const drm = { widevine: { licenseUrl: `${PLACEHOLDER}/roku/licence?id=${id}` } };
    return {
        name: 'Roku Channel',
        // The stream is the title itself: Roku's adverts come from its own player, not the stream.
        title: [option.quality, 'Free on The Roku Channel'].join(' | '),
        quality: option.quality,
        // (Named .mpd: a player goes by that to know it is DASH. This server's address is put in by whoever answers the client, lib/relayAddress.js.)
        url: `${PLACEHOLDER}/roku/dash.mpd?id=${id}`,
        provider: 'roku',
        // The service's own stream of the title (see addon-server.js: clients can put those first).
        official: true,
        subtitles: option.subtitles.length ? option.subtitles : undefined,
        drm,
        behaviorHints: { notWebReady: true, drm }
    };
}

// What is asked, as TMDB knows it: the names it goes by and its year, and for an episode its title and its season's episodes.
function wantedTitle(tmdbId, mediaType, season, episode) {
    return tmdb.getDetails(tmdbId, mediaType).then(d => {
        const w = {
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

// The titles Roku's search has under the asked one's names that are it (same kind, name and year), best first.
function candidates(wanted, kind) {
    const names = Array.from(new Set(wanted.titles)).slice(0, MAX_NAMES);
    return Promise.all(names.map(name => api('/api/v1/search', { query: name }).then(hitsIn).catch(() => []))).then(lists => {
        const seen = new Set();
        const hits = lists.flat().filter(h => h.kind === kind && !seen.has(h.id) && seen.add(h.id));
        return matchingTitles(hits, wanted).slice(0, MAX_CANDIDATES);
    });
}

function streamsOf(hit, wanted) {
    if (hit.kind === 'movie') return content(hit.id).then(data => { const o = freeOption(data); return o ? [stream(hit.id, o)] : []; });
    return content(hit.id).then(series => {
        const episodes = episodesIn(series);
        const at = episodes.find(e => e.season === Number(wanted.season) && e.episode === Number(wanted.episode));
        if (!at) return [];
        return content(at.id).then(data => {
            const o = isAskedEpisode(data, episodes, wanted) ? freeOption(data) : null;
            return o ? [stream(at.id, o)] : [];
        });
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Roku] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);
    if (!proxy()) return Promise.resolve([]);
    return wantedTitle(tmdbId, mediaType, season, episode).then(wanted => candidates(wanted, mediaType === 'tv' ? 'series' : 'movie').then(hits => {
        const tryNext = (i) => (i >= hits.length ? Promise.resolve([]) : streamsOf(hits[i], wanted).catch(() => []).then(s => (s.length ? s : tryNext(i + 1))));
        return tryNext(0);
    })).then(streams => {
        console.log(`[Roku] ${streams.length} stream(s)`);
        return streams;
    }).catch(err => {
        console.log(`[Roku] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams, dash, segment, licence, hitsIn, freeOption, episodesIn, isAskedEpisode, relayDescription, segmentAddress };
