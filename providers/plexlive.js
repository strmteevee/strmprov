// Plex's free live channels, as a catalog of this addon: the ones Plex offers
// in the Netherlands (asked directly) and in the US and the UK (through the
// tunnels of "Plex (US)" / "Plex (UK)", like providers/plexvod.js, whose
// anonymous session and countries this uses). A channel has the same id
// everywhere: one that several countries have is there once, from the first
// that has it. Tested 2026-11-16 from the Netherlands (229 channels):
//   channels -> epg.provider.plex.tv/lineups/plex/channels, and the same with
//               ?genre=<slug> for the channels of one of Plex's categories
//               (a channel only names its categories by key).
//   playing  -> the channel's HLS playlist (/library/parts/<id>.m3u8) with the
//               session token; the playlists it points to are on the same
//               host. A country's own channels are asked through its tunnel
//               (plexvod.playlist, served at /plex/hls).
// The streams are the channels as Plex sends them, adverts included.
//
// Ids: plex:live:<channel> (the ids OmniStream's own Plex source had).

const plexvod = require('./plexvod');

const EPG = 'https://epg.provider.plex.tv';
const PREFIX = 'plex:live:';
const CHANNELS_TTL_MS = 60 * 60 * 1000;
// Plex's channel categories (as its website lists them): what it asks for, and their names.
const GENRES = [
    ['movies', 'Movies'], ['bingeworthy', 'Bingeworthy'], ['crime', 'True Crime'], ['news', 'News'], ['sports', 'Sports'],
    ['reality', 'Reality'], ['classic-tv', 'Classics'], ['adrenaline-sci-fi', 'Adrenaline & Sci-Fi'], ['comedy', 'Comedy'],
    ['daytime-tv-games', 'Daytime TV & Games'], ['explore', 'Explore'], ['food-home-culture', 'Food, Home & Culture'],
    ['kids-family', 'Kids & Family'], ['en-espanol', 'En Español'], ['global', 'Global'], ['music', 'Music']
];
// Category requests to one country at once.
const GENRE_REQUESTS = 4;

function lineup(region, genre) {
    return plexvod.get(`${EPG}/lineups/plex/channels${genre ? `?genre=${encodeURIComponent(genre)}` : ''}`, region)
        .then(j => (j && j.MediaContainer && j.MediaContainer.Channel) || []);
}

// channel id -> the names of its categories, in [region]. A category that fails is left out.
function genresOf(region) {
    const found = new Map();
    const next = (i) => {
        if (i >= GENRES.length) return Promise.resolve(found);
        return Promise.all(GENRES.slice(i, i + GENRE_REQUESTS).map(([slug, name]) => lineup(region, slug).catch(() => [])
            .then(list => list.forEach(c => { if (c.id) found.set(c.id, (found.get(c.id) || []).concat(name)); }))))
            .then(() => next(i + GENRE_REQUESTS));
    };
    return next(0);
}

function partKey(channel) {
    const media = (channel.Media || []).find(m => m.protocol === 'hls' && !m.drm && (m.Part || []).some(p => p.key));
    return media ? media.Part.find(p => p.key).key : null;
}

// One country's channels that play: [{ meta, path, region }].
function regionChannels(region) {
    return Promise.all([lineup(region), genresOf(region)]).then(([list, genres]) => list
        .filter(c => c.id && c.title && c.hidden !== true && partKey(c))
        .map(c => ({
            region,
            path: partKey(c),
            meta: {
                id: `${PREFIX}${c.id}`,
                type: 'tv',
                name: c.title,
                poster: c.thumb,
                logo: c.thumb,
                background: c.art,
                description: c.summary,
                genres: genres.get(c.id) || [],
                language: c.language ? String(c.language).toLowerCase() : undefined
            }
        })));
}

let kept = null; // { at, regions, channels: Promise of [{ meta, path, region }] }

// Every country's channels, each once; a country that fails is left out (and the list then asked again next time).
function channels() {
    const regions = plexvod.activeRegions();
    const codes = regions.map(r => r.code).join(',');
    if (kept && kept.regions === codes && Date.now() - kept.at < CHANNELS_TTL_MS) return kept.channels;
    const mine = { at: Date.now(), regions: codes };
    mine.channels = Promise.all(regions.map(region => regionChannels(region).catch(err => {
        console.error(`[PlexLive] ${region.code.toUpperCase()}: ${err.message}`);
        return null;
    }))).then(lists => {
        if (lists.some(l => !l || !l.length)) mine.at = 0;
        const seen = new Set();
        return [].concat(...lists.map(l => l || [])).filter(c => !seen.has(c.meta.id) && seen.add(c.meta.id));
    });
    mine.channels.catch(() => { if (kept === mine) kept = null; });
    kept = mine;
    return mine.channels;
}

// Live channels, optionally of one category.
function liveCatalog(extra) {
    const genre = extra && extra.genre;
    return channels().then(list => list.map(c => c.meta).filter(m => !genre || m.genres.includes(genre)));
}

// The categories some channel is in, in Plex's order: known ones at once, looked up in the background.
let knownGenres = [];
function genreOptions() {
    channels().then(list => {
        const used = new Set([].concat(...list.map(c => c.meta.genres)));
        knownGenres = GENRES.map(g => g[1]).filter(name => used.has(name));
    }).catch(err => console.error(`[PlexLive] Channels failed: ${err.message}`));
    return knownGenres;
}

function find(id) {
    return channels().then(list => list.find(c => c.meta.id === id) || null);
}

function meta(id) {
    return find(id).then(c => (c ? c.meta : null));
}

// The channel's stream ([relayBase]: this server's address as the client used
// it, for a channel that is asked through a tunnel).
function streams(id, relayBase) {
    return Promise.all([find(id), plexvod.getSession()]).then(([c, s]) => {
        if (!c) return [];
        const direct = `${EPG}${c.path}?${plexvod.sessionQuery(s)}`;
        return [{
            name: 'Plex',
            title: 'Live',
            url: c.region.source ? plexvod.relayUrl(relayBase, c.region.code, direct) : direct,
            provider: 'plex',
            behaviorHints: { notWebReady: true }
        }];
    });
}

module.exports = { PREFIX, liveCatalog, genreOptions, meta, streams };
