// Usenet provider - real-time progressive streaming over NNTP.
//
// Unlike every other provider here, a "stream" isn't an external hotlink:
// discovery (this file) just searches free public indexers (NZBKing,
// Binsearch - no account needed) for a single directly-playable video file
// matching the title, the same filtering/matching logic as the standalone
// usenet-search tool this was built from. Actually fetching the video needs
// the user's own NNTP provider credentials (Admin panel -> Usenet), and is
// served live, segment by segment, by lib/usenet/streamSession.js via
// addon-server.js's /usenet/stream route - nothing is ever written to disk.
// Only tried as a last resort when every other provider comes up empty (see
// lib/aggregate.js's LAST_RESORT_PROVIDERS), since even a successful match
// here starts playing noticeably slower than an instant CDN link.

const nzbking = require('../lib/usenet/nzbking');
const binsearch = require('../lib/usenet/binsearch');
const { classify, sizeToBytes } = require('../lib/usenet/filter');
const { matchesTitle } = require('../lib/usenet/titleMatch');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// How many distinct results become stream entries - a popular title can
// have dozens of near-duplicate reposts across both indexers; showing all
// of them is noise, not choice, since they're already sorted best-first.
const MAX_RESULTS = 8;

function getTmdbInfo(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        .then(res => res.json())
        .then(data => {
            const title = mediaType === 'tv' ? data.name : data.title;
            const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
            return { title, year };
        });
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function buildQuery({ title, year, season, episode }) {
    let q = (title || '').trim();
    if (season && episode) q += ` S${pad2(season)}E${pad2(episode)}`;
    else if (year) q += ` ${year}`;
    return q.trim();
}

function extractQuality(filename) {
    const m = /(\d{3,4})[pP]\b/.exec(filename);
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 2160) return '4K';
        if (n >= 1080) return '1080p';
        if (n >= 720) return '720p';
        if (n >= 480) return '480p';
        return `${n}p`;
    }
    if (/\b4K|UHD\b/i.test(filename)) return '4K';
    return 'Unknown';
}

// The addon server builds the real, absolute stream URL itself (it needs
// the incoming request's own Host header - this module has no way to know
// its own externally-reachable address) - all that needs to survive the
// round trip is enough to re-fetch the NZB later, so it's base64url-encoded
// straight into the token rather than kept server-side in a lookup table
// that could be lost on a restart mid-playback.
function makeToken(nzbUrl) {
    return Buffer.from(JSON.stringify({ n: nzbUrl }), 'utf8').toString('base64url');
}

function decodeToken(token) {
    try {
        const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
        return parsed && parsed.n ? parsed : null;
    } catch (e) {
        return null;
    }
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Usenet] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

    if (mediaType === 'tv' && (!season || !episode)) {
        console.log('[Usenet] Missing season/episode for TV lookup');
        return Promise.resolve([]);
    }

    return getTmdbInfo(tmdbId, mediaType).then(info => {
        if (!info || !info.title) return [];
        const query = buildQuery({ title: info.title, year: info.year, season, episode });
        console.log(`[Usenet] Searching: "${query}"`);

        return Promise.allSettled([nzbking.search(query), binsearch.search(query, { max: 100 })]).then(([nzbkingResult, binsearchResult]) => {
            const raw = [];
            if (nzbkingResult.status === 'fulfilled') raw.push(...nzbkingResult.value);
            else console.log(`[Usenet] nzbking search failed: ${nzbkingResult.reason.message}`);
            if (binsearchResult.status === 'fulfilled') raw.push(...binsearchResult.value);
            else console.log(`[Usenet] binsearch search failed: ${binsearchResult.reason.message}`);

            const seen = new Set();
            const results = [];
            for (const item of raw) {
                const playable = classify(item.subject, item.filetypes);
                if (!playable) continue;
                if (!matchesTitle(playable.filename, { title: info.title, year: info.year, season, episode })) continue;

                const bytes = sizeToBytes(item.size);
                const dedupeKey = `${playable.filename.toLowerCase()}::${bytes}`;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);

                results.push({ filename: playable.filename, size: item.size, sizeBytes: bytes, source: item.source, nzbUrl: item.nzbUrl });
            }

            results.sort((a, b) => b.sizeBytes - a.sizeBytes);
            console.log(`[Usenet] Found ${results.length} playable result(s) across ${raw.length} raw hit(s)`);

            return results.slice(0, MAX_RESULTS).map(r => ({
                name: `Usenet [${r.source}]`,
                title: `${r.filename}\n${r.size || 'Unknown size'}`,
                quality: extractQuality(r.filename),
                size: r.size,
                provider: 'usenet',
                // No real url yet - see makeToken's comment and
                // addon-server.js's buildStreamResponse.
                usenetToken: makeToken(r.nzbUrl),
                usenetFilename: r.filename
            }));
        });
    }).catch(err => {
        console.log(`[Usenet] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams, decodeToken };
