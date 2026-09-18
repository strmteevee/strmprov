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

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const BASE_URL = 'https://www.animeworld.so';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getTmdbInfo(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => {
            const title = mediaType === 'tv' ? data.name : data.title;
            const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
            console.log(`[AnimeWorld] TMDB Info: "${title}" (${year})`);
            return { title, year };
        });
}

function normalize(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function search(query) {
    const url = `${BASE_URL}/search?keyword=${encodeURIComponent(query)}`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } }).then(res => res.text());
}

function findBestMatch(html, targetTitle) {
    const $ = cheerio.load(html);
    const target = normalize(targetTitle);
    const seen = new Set();
    let exact = null;
    let prefix = null;
    $('a[href^="/play/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || seen.has(href)) return;
        const name = $(el).closest('.item, li, div').find('.name').first().text().trim() || $(el).text().trim();
        if (!name) return;
        seen.add(href);
        const normName = normalize(name);
        if (!exact && normName === target) exact = { href, name };
        else if (!prefix && (normName.startsWith(target) || target.startsWith(normName))) prefix = { href, name };
    });
    return exact || prefix;
}

function fetchPlayPage(href) {
    const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } }).then(res => res.text());
}

function extractEpisodes(html) {
    const $ = cheerio.load(html);
    const csrfMatch = html.match(/csrfToken\s*=\s*"([^"]+)"/);
    const episodes = [];
    $('a[data-id]').each((_, el) => {
        const num = parseInt($(el).text().trim(), 10);
        const id = $(el).attr('data-id');
        if (id && !isNaN(num)) episodes.push({ num, id });
    });
    return { csrfToken: csrfMatch ? csrfMatch[1] : null, episodes };
}

function getEpisodeGrabber(episodeId, csrfToken) {
    const url = `${BASE_URL}/api/episode/info?id=${encodeURIComponent(episodeId)}&alt=0`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT, 'CSRF-Token': csrfToken || '' } })
        .then(res => res.ok ? res.json() : null)
        .then(json => (json && json.grabber) || null)
        .catch(() => null);
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[AnimeWorld] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

    if (mediaType === 'tv' && !episode) {
        console.log('[AnimeWorld] Missing episode for TV lookup');
        return Promise.resolve([]);
    }

    return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
        if (!mediaInfo.title) return [];
        const query = (mediaType === 'tv' && season > 1) ? `${mediaInfo.title} season ${season}` : mediaInfo.title;
        return search(query).then(html => {
            const match = findBestMatch(html, mediaInfo.title);
            if (!match) {
                console.log(`[AnimeWorld] No matching title found for "${query}"`);
                return [];
            }
            console.log(`[AnimeWorld] Matched: "${match.name}"`);
            return fetchPlayPage(match.href).then(playHtml => {
                const { csrfToken, episodes } = extractEpisodes(playHtml);
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
