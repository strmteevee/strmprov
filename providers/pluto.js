// Pluto TV's movies and series as a stream source for ordinary titles: when
// Pluto has the title (in the US or the UK, through their tunnels - see
// providers/plutotv.js, which does the work and also offers them as
// catalogs), its stream is one of the title's sources, without the advert
// breaks.
//
// Pluto knows titles by name only, so the title is looked up by the names
// TMDB has for it, and an episode by its title rather than its numbers
// (lib/titleMatch.js): Pluto cuts long series into seasons its own way.

const tmdb = require('../lib/tmdb');
const plutotv = require('./plutotv');
const { PLACEHOLDER } = require('../lib/relayAddress');
const regularTitle = require('../lib/regularTitle');

// What is asked for, as Pluto can be searched for it.
function wanted(tmdbId, mediaType, season, episode) {
    return tmdb.getDetails(tmdbId, mediaType).then(d => {
        const w = {
            mediaType,
            titles: [d.title, d.name, d.original_title, d.original_name].filter(Boolean),
            year: Number((d.release_date || d.first_air_date || '').slice(0, 4)) || null,
            // The Pluto titles a catalog handed out as this one: tried before looking by name.
            knownIds: regularTitle.listedIds(tmdbId, mediaType, plutotv.PREFIX)
        };
        if (mediaType !== 'tv') return w;
        return tmdb.getSeasonEpisodes(tmdbId, season).then(s => {
            const episodes = ((s && s.episodes) || []).map(e => ({ episode: e.episode_number, title: e.name }));
            const own = episodes.find(e => Number(e.episode) === Number(episode));
            return Object.assign(w, { season, episode, episodeTitle: own ? own.title : null, siblings: episodes });
        });
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Pluto] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);
    if (!plutotv.isAvailable()) return Promise.resolve([]);
    return wanted(tmdbId, mediaType, season, episode)
        .then(w => plutotv.streamsForTitle(w, PLACEHOLDER))
        .then(streams => {
            console.log(`[Pluto] ${streams.length} stream(s)`);
            return streams;
        })
        .catch(err => {
            console.log(`[Pluto] getStreams failed: ${err.message}`);
            return [];
        });
}

module.exports = { getStreams };
