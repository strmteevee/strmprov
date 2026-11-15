// Plex's free movies and shows as a stream source for ordinary titles: when
// Plex has the title for free (in the Netherlands, or in the US or UK through
// their tunnels - see providers/plexvod.js, which does the work and also
// offers them as catalogs), its stream is one of the title's sources. The
// video is the film itself: Plex's adverts are added by Plex's own player,
// not in the stream (checked 2026-11-16: a 114-minute film's playlist is 114
// minutes, without breaks).

const plexvod = require('./plexvod');
const { PLACEHOLDER } = require('../lib/relayAddress');

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Plex] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    return plexvod.streamsForTmdb(tmdbId, mediaType, season, episode, PLACEHOLDER)
        .then(streams => {
            console.log(`[Plex] ${streams.length} stream(s)`);
            return streams;
        })
        .catch(err => {
            console.log(`[Plex] getStreams failed: ${err.message}`);
            return [];
        });
}

module.exports = { getStreams };
