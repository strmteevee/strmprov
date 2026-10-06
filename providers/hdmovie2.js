// HdMovie2 scraper.
//
// Reference: the CloudStream "StreamPlay" plugin's decompiled Kotlin
// (com.phisher98.StreamPlayExtractor#invokeHdmovie2) was read for background,
// but confirmed LIVE (2026-09-28) to have drifted on every load-bearing point:
//   - It builds a guessed detail URL "{domain}/movies/{slug(title)}-{year}/"
//     with no search step at all. Live, that guess almost never matches: older
//     posts prefix the slug with the WP numeric post ID
//     ("/movies/40228-roy-2015-hindi-hd/"), newer ones don't
//     ("/movies/snake-woman-2025-hindi-dubbed/"), and none of them follow a
//     plain "{slug}-{year}" shape. A real search is required.
//   - The standard WordPress "?s=" search query is behind a real Cloudflare
//     Managed Challenge ("Just a moment...") - confirmed live to 403
//     consistently. This is a narrow WAF rule on the literal "s=" query
//     string, not general bot management: "/?foo=bar" and "/genre/action/"
//     both 200 fine, only "?s=" 403s. The theme's own pretty-permalink search
//     route, "/search/{query}/" (same WP search under the hood, but no
//     literal "s=" in the request URI), is NOT covered by that rule and
//     returns real results - confirmed live, e.g. /search/Inception/ finds
//     "movies/85962-inception-2010-hindi-dubbed/".
//   - Each player "server" option's own `<a data-source="...">` already IS
//     the final embed URL - the page's own JS just swaps an iframe's src on
//     click. There's no admin-ajax.php POST (action=doo_player_ajax,
//     data-post/data-nume) round trip to make at all anymore.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["hdmovie2"]
//   search         -> GET {domain}/search/{query}/  (see above - sidesteps the ?s= WAF rule)
//   search result  -> .search-results-list .result-item: a.result-thumb[href],
//                     h2.result-title a text ("Title (Year) tags..."). The
//                     site's "movies" post type is used for both movies and
//                     TV (a season is one "... Season N Complete" post) - the
//                     result list never distinguishes the two, so matching has
//                     to be done from the title text.
//   detail page    -> #video-sources.dooplay_player .options li.dooplay_player_option
//                     a[data-source], one per "server". A season-pack post
//                     labels each episode's option "... EP01".."EP10" etc
//                     (confirmed live, Mirzapur S3, zero-padded); a movie's
//                     options are unlabeled server names ("Ultra Stream V2/V3",
//                     "Ultra Stream 2", "Fast Player", ...). "Watch trailer"
//                     (YouTube) options are always skipped.
//   own stream host -> the site's own player domain rotates too (hdm2.biz,
//                     molop.art confirmed live, both labeled "Ultra Stream
//                     Vx") - not tracked in domains.json, just taken as-is
//                     from data-source each time. It's a self-hosted JWPlayer
//                     embed: a `<script id="player-loader"
//                     data-stream-url="/playlist/<token>?v=..&tok=<jwt>">` tag
//                     on the embed page. That data-stream-url, resolved
//                     against the embed page's own origin, IS the final
//                     signed HLS master playlist - confirmed live with a real
//                     "#EXTM3U" body, and no special headers are needed (the
//                     JWT alone authorizes it; ~3h expiry observed).
//   other hosts    -> "Ultra Stream 2" (prvs.top) was confirmed live
//                     UNREACHABLE (TLS handshake failure from both curl and
//                     Node) at scrape time. "Fast Player" (ok.ru embed) has no
//                     player-loader script at all. Both fall through the
//                     generic player-loader extraction below and are simply
//                     dropped, same as any other unrecognized host - no
//                     per-host guessing is attempted for them.

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://hdmovie2a.biz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetch(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const domain = ((data && data.hdmovie2) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[HdMovie2] Using domain: ${domain}`);
      return domain;
    })
    .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[HdMovie2] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: null, year: '' }));
}

function normalizeWords(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function titleOverlapScore(candidateTitle, targetWords) {
  if (!targetWords.length) return 0;
  const candSet = new Set(normalizeWords(candidateTitle));
  const overlap = targetWords.filter(w => candSet.has(w)).length;
  return overlap / targetWords.length;
}

// The pretty-permalink search route - see file header for why this is used
// instead of the theme's own "?s=" query var.
function search(domain, query) {
  const url = `${domain}/search/${encodeURIComponent(query)}/`;
  return fetch(url, { headers: HEADERS })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      const results = [];
      $('.search-results-list .result-item').each((_, el) => {
        const href = $(el).find('a.result-thumb').attr('href') || $(el).find('h2.result-title a').attr('href');
        const title = $(el).find('h2.result-title a').text().trim();
        if (href && title) results.push({ href, title });
      });
      return results;
    })
    .catch(() => []);
}

function findBestMovieMatch(results, mediaInfo) {
  const targetWords = normalizeWords(mediaInfo.title);
  if (!targetWords.length) return null;
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    if (/season\s*0*\d+/i.test(r.title)) continue; // a TV season pack, not a movie
    const yearMatch = r.title.match(/\((\d{4})\)/);
    let score = titleOverlapScore(r.title, targetWords);
    if (mediaInfo.year && yearMatch) {
      score += yearMatch[1] === String(mediaInfo.year) ? 0.5 : -0.3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

// TV shows are posted as one "... Season N Complete" post per season - year
// in the title tracks that season's own air year, not TMDB's first_air_date,
// so season number (not year) is what disambiguates here.
function findBestSeriesMatch(results, mediaInfo, season) {
  const targetWords = normalizeWords(mediaInfo.title);
  if (!targetWords.length) return null;
  const candidates = results.filter(r => titleOverlapScore(r.title, targetWords) >= 0.6 && !/\bmovie\b/i.test(r.title));
  if (!candidates.length) return null;
  const seasonPat = new RegExp(`season\\s*0*${season}\\b`, 'i');
  const withSeason = candidates.filter(r => seasonPat.test(r.title));
  let pool = withSeason;
  if (!pool.length && season === 1 && !candidates.some(r => /season\s*0*\d+/i.test(r.title))) {
    // Single-season shows sometimes never bother labeling a season at all.
    pool = candidates;
  }
  if (!pool.length) return null;
  let best = null;
  let bestScore = -1;
  for (const r of pool) {
    const score = titleOverlapScore(r.title, targetWords);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

function extractPlayerOptions($) {
  const options = [];
  $('#video-sources .dooplay_player_option, .dooplay_player .dooplay_player_option').each((_, el) => {
    const a = $(el).find('a[data-source]');
    const src = a.attr('data-source');
    const label = a.find('.title').text().trim() || a.text().trim();
    const server = a.find('.server').text().trim();
    if (!src) return;
    if (/trailer/i.test(label) || /youtube/i.test(server) || /youtube\.com/i.test(src)) return;
    options.push({ label, src: src.startsWith('//') ? `https:${src}` : src });
  });
  return options;
}

// A season pack labels each episode's option "... EP01".."EP10" (zero-padded)
// - confirmed live, Mirzapur S3. Match both the zero-padded and bare forms.
function optionsForEpisode(options, episode) {
  const padded = `EP${String(episode).padStart(2, '0')}`;
  const bare = new RegExp(`EP\\s*0*${episode}\\b`, 'i');
  return options.filter(o => o.label.toUpperCase().includes(padded) || bare.test(o.label));
}

// See file header: the site's own "Ultra Stream" embed is a self-hosted
// JWPlayer page whose #player-loader script's data-stream-url attribute,
// resolved against the embed page's own origin, is already the final signed
// HLS master playlist. Any other embed shape (no such script) is left
// unsupported and resolves to null.
//
// Re-verified live (2026-10-06): the embed URL on the site's own domain now
// 302-redirects to the player's real origin ("/hdm2-player/<id>" ->
// "https://hdm2.biz/play?v=<id>&auth=<jwt>"), so data-stream-url has to be
// resolved against the FINAL (post-redirect) page URL, not the URL that was
// requested - resolving against the original sends the playlist request to
// the wrong host (404). The playlist itself also now rejects requests whose
// Referer isn't the player's own origin ("Forbidden (Token/Referer
// Invalid)"), and its token is bound to the User-Agent that loaded the player
// page, so the returned stream carries both.
function resolveEmbedToStream(embedUrl, refererUrl) {
  return fetch(embedUrl, { headers: Object.assign({}, HEADERS, { Referer: refererUrl }) })
    .then(res => {
      if (!res.ok) return null;
      const finalUrl = res.url || embedUrl;
      return res.text().then(html => {
        const $ = cheerio.load(html);
        const dataStreamUrl = $('#player-loader').attr('data-stream-url');
        if (!dataStreamUrl) return null;
        return {
          url: new URL(dataStreamUrl, finalUrl).toString(),
          referer: `${new URL(finalUrl).origin}/`
        };
      });
    })
    .catch(() => null);
}

// Confirmed live: the resolved URL is always a real HLS master playlist for
// this provider (it only ever comes from the player-loader extraction above),
// so status alone isn't enough - require the body to actually start with
// #EXTM3U, same standard as cinejoy.js/peachify.js.
function validateStreamUrl(stream) {
  return fetch(stream.url, { headers: stream.headers })
    .then(res => {
      if (!res.ok) return false;
      return res.text().then(text => /^#EXTM3U/.test(text.trim()));
    })
    .catch(() => false);
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[HdMovie2] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[HdMovie2] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)])
    .then(([domain, mediaInfo]) => {
      if (!mediaInfo.title) return [];
      return search(domain, mediaInfo.title).then(results => {
        if (!results.length) {
          console.log(`[HdMovie2] No search results for "${mediaInfo.title}"`);
          return [];
        }
        const match = mediaType === 'tv'
          ? findBestSeriesMatch(results, mediaInfo, season)
          : findBestMovieMatch(results, mediaInfo);
        if (!match) {
          console.log(`[HdMovie2] No matching title found for "${mediaInfo.title}"`);
          return [];
        }
        console.log(`[HdMovie2] Matched: "${match.title}" -> ${match.href}`);

        return fetch(match.href, { headers: HEADERS })
          .then(res => res.text())
          .then(html => {
            const $ = cheerio.load(html);
            let options = extractPlayerOptions($);
            if (mediaType === 'tv') options = optionsForEpisode(options, episode);
            if (!options.length) {
              console.log('[HdMovie2] No usable player options found on detail page');
              return [];
            }
            return Promise.all(options.map(opt =>
              resolveEmbedToStream(opt.src, match.href).then(resolved => {
                if (!resolved) return null;
                return {
                  name: 'HdMovie2',
                  title: `${match.title}${opt.label ? ' - ' + opt.label : ''}`,
                  url: resolved.url,
                  quality: 'Auto',
                  headers: Object.assign({}, HEADERS, { Referer: resolved.referer }),
                  provider: 'hdmovie2'
                };
              }).catch(() => null)
            )).then(streams => streams.filter(Boolean));
          });
      });
    })
    .then(streams => {
      if (!streams.length) return streams;
      console.log(`[HdMovie2] Found ${streams.length} candidate stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => v.stream.title);
        if (dead.length) console.log(`[HdMovie2] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[HdMovie2] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    })
    .catch(err => {
      console.log(`[HdMovie2] getStreams failed: ${err.message}`);
      return [];
    });
}

module.exports = { getStreams };
