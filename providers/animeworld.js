// AnimeWorld (Italian sub) scraper.
//
//   domain   -> https://www.animeworld.so - confirmed live (2026-09-18) this
//               redirects (301 then 302) to https://www.animeworld.ac; kept
//               as the request target rather than hardcoding the .ac alias,
//               since fetch follows redirects by default and the .so name
//               has been the more stable entry point across this domain's
//               past rotations.
//   search   -> GET /search?keyword={query} - plain server-rendered HTML,
//               each result an <a href="/play/{slug}.{id}"> with a sibling
//               .name element carrying the real title text.
//   episode  -> the play page embeds one data-id per episode directly (a
//               short alphanumeric id, e.g. data-id="JmU68" for episode 2)
//               plus a csrfToken JS variable used to authorize the API call:
//                 GET /api/episode/info?id={episodeId}&alt=0
//                 header: CSRF-Token: {csrfToken}
//               -> {"grabber": "https://srvNN-xxx.sweetpixel.org/DDL/..."} -
//               a direct, self-hosted MP4 link. Confirmed live: real 206
//               Partial Content + video/mp4 on a ranged GET, wide-open CORS,
//               no Cloudflare in front of the video host.
//   seasons  -> AnimeWorld has no TMDB-style season concept - a long-running
//               franchise's later "seasons" are usually separate site
//               entries (e.g. "Naruto" vs "Naruto Shippuden"), which a
//               generic TMDB season number can't map to reliably. Only
//               season 1 (or a movie) is handled directly for now; a
//               season > 1 request falls back to appending "season {n}" to
//               the search query as a best-effort, same class of limitation
//               already accepted for kickassanime.js/anime-dekho.js.
//   matching -> the site search is fuzzy and always returns something, so a
//               result has to prove it is the requested work: see findMatches
//               (title) and yearAllowed (the play page's own release date).
//               The site only carries anime, so a TMDB entry without the
//               Animation genre (live action) is never looked up at all.

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const BASE_URL = 'https://www.animeworld.so';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TMDB_ANIMATION_GENRE_ID = 16;

function getTmdbInfo(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => {
            const title = mediaType === 'tv' ? data.name : data.title;
            const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
            console.log(`[AnimeWorld] TMDB Info: "${title}" (${year})`);
            const genres = data.genres || [];
            const couldBeAnime = !genres.length || genres.some(g => g.id === TMDB_ANIMATION_GENRE_ID);
            return { title, year, couldBeAnime };
        });
}

function normalize(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function search(query) {
    const url = `${BASE_URL}/search?keyword=${encodeURIComponent(query)}`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } }).then(res => res.text());
}

// The site's own title variants of one work: a trailing "(ITA)" marks the
// Italian-dubbed entry, and "<title>: <subtitle>" a named part of it. Any other
// extra words make it another work ("Parasite Dolls" is not "Parasite", and
// "Your" is not "Your Name"), so a bare prefix is deliberately not enough.
// Returned best first: the plain entry before its dub, then a subtitled one. A
// later season is usually its own entry ("X 2", "X Season 2"), which goes first.
function findMatches(html, targetTitle, season) {
    const $ = cheerio.load(html);
    const target = normalize(targetTitle);
    if (!target) return [];
    const laterSeason = season > 1
        ? new RegExp(`^${target} (?:season ${season}|${season}(?:st|nd|rd|th) season|${season})(?: |$)`)
        : null;
    const seen = new Set();
    const ranked = [];
    $('a[href^="/play/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || seen.has(href)) return;
        const name = $(el).closest('.item, li, div').find('.name').first().text().trim() || $(el).text().trim();
        if (!name) return;
        seen.add(href);
        const undubbed = name.replace(/\s*\(ITA\)\s*$/i, '');
        const isDub = undubbed !== name;
        const normName = normalize(undubbed);
        let rank = -1;
        if (laterSeason && laterSeason.test(normName)) rank = 0;
        else if (normName === target) rank = isDub ? 2 : 1;
        else if (normalize(undubbed.split(/\s*:\s/)[0]) === target) rank = isDub ? 4 : 3;
        if (rank >= 0) ranked.push({ href, name, rank });
    });
    return ranked.sort((a, b) => a.rank - b.rank);
}

// Same rule as the other title-search providers (see castle.js/filmyfiy.js): a
// same-named entry whose release year is more than a year off is another work
// (a remake or a new adaptation). A later season's entry naturally starts later
// than the show, so the check only covers a film or season 1; an entry stating
// no date gets the benefit of the doubt.
function yearAllowed(entryYear, wantYear, season) {
    if (season > 1 || !entryYear || !wantYear) return true;
    return Math.abs(entryYear - wantYear) <= 1;
}

function fetchPlayPage(href) {
    const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } }).then(res => res.text());
}

function parsePlayPage(html) {
    const $ = cheerio.load(html);
    const csrfMatch = html.match(/csrfToken\s*=\s*"([^"]+)"/);
    const episodes = [];
    $('a[data-id]').each((_, el) => {
        const num = parseInt($(el).text().trim(), 10);
        const id = $(el).attr('data-id');
        if (id && !isNaN(num)) episodes.push({ num, id });
    });
    const released = $('dt').filter((_, el) => /Data di Uscita/i.test($(el).text())).first().next('dd').text();
    const yearMatch = /\b(?:19|20)\d{2}\b/.exec(released);
    return { csrfToken: csrfMatch ? csrfMatch[1] : null, episodes, year: yearMatch ? parseInt(yearMatch[0], 10) : null };
}

function getEpisodeGrabber(episodeId, csrfToken) {
    const url = `${BASE_URL}/api/episode/info?id=${encodeURIComponent(episodeId)}&alt=0`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT, 'CSRF-Token': csrfToken || '' } })
        .then(res => res.ok ? res.json() : null)
        .then(json => (json && json.grabber) || null)
        .catch(() => null);
}

// The first candidate whose play page passes the year check, with that page's data.
function pickCandidate(candidates, wantYear, season) {
    if (!candidates.length) return Promise.resolve(null);
    const [candidate, ...rest] = candidates;
    return fetchPlayPage(candidate.href).then(playHtml => {
        const page = parsePlayPage(playHtml);
        if (yearAllowed(page.year, wantYear, season)) return { match: candidate, page };
        console.log(`[AnimeWorld] Skipping "${candidate.name}": released ${page.year}, wanted ${wantYear}`);
        return pickCandidate(rest, wantYear, season);
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[AnimeWorld] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

    if (mediaType === 'tv' && !episode) {
        console.log('[AnimeWorld] Missing episode for TV lookup');
        return Promise.resolve([]);
    }

    return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
        if (!mediaInfo.title) return [];
        if (!mediaInfo.couldBeAnime) {
            console.log(`[AnimeWorld] "${mediaInfo.title}" is not animation, not searching`);
            return [];
        }
        const wantSeason = mediaType === 'tv' ? season : null;
        const query = wantSeason > 1 ? `${mediaInfo.title} season ${season}` : mediaInfo.title;
        return search(query).then(html => {
            const candidates = findMatches(html, mediaInfo.title, wantSeason);
            return pickCandidate(candidates, parseInt(mediaInfo.year, 10), wantSeason).then(picked => {
                if (!picked) {
                    console.log(`[AnimeWorld] No matching title found for "${query}"`);
                    return [];
                }
                const { match, page: { csrfToken, episodes } } = picked;
                console.log(`[AnimeWorld] Matched: "${match.name}"`);
                const targetNum = mediaType === 'tv' ? episode : 1;
                const target = episodes.find(e => e.num === targetNum) || (mediaType !== 'tv' ? episodes[0] : null);
                if (!target) {
                    console.log(`[AnimeWorld] No episode ${targetNum} found (${episodes.length} episode(s) listed)`);
                    return [];
                }
                return getEpisodeGrabber(target.id, csrfToken).then(grabber => {
                    if (!grabber) {
                        console.log('[AnimeWorld] No grabber URL returned for episode');
                        return [];
                    }
                    return [{
                        name: 'AnimeWorld',
                        title: `${match.name}${mediaType === 'tv' ? ` E${episode}` : ''}`,
                        url: grabber,
                        quality: 'Unknown',
                        provider: 'animeworld'
                    }];
                });
            });
        });
    }).catch(err => {
        console.log(`[AnimeWorld] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams };
