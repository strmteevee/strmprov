// VegaMovies scraper for Nuvio Local Scrapers
//
// Ported from the open-source CloudStream extension (SaurabhKaperwan/CSX,
// VegaMovies/src/main/kotlin/com/megix/VegaMoviesProvider.kt + Extractors.kt -
// real Kotlin source, no decompilation needed this time) with one deliberate
// change: the original's primary resolver, "V-Cloud" (vcloud.fit), is now
// behind a real Cloudflare managed challenge ("Just a moment...") - verified
// directly, not assumed - which no plain HTTP client can solve without a
// browser executing JS. This scraper instead uses the same download page's
// "G-Direct [Instant]" button, which isn't Cloudflare-protected: its embed
// page contains a plain `var reurl = "https://fastdl.zip/dl.php?link=<real
// googleusercontent.com URL>"` in static HTML, no JS execution required to
// read it. Verified end-to-end: HEAD on the extracted URL returns a real
// video/mkv file. "Filepress" is also Cloudflare-gated; "DropGalaxy" needs a
// JS-execution-proof redirect dance that isn't worth chasing when G-Direct
// already works cleanly.
//
//   current domain -> https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json ["vegamovies"]
//   search         -> GET {baseUrl}/search.php?q={query}&page=1  (Typesense-style JSON, no auth)
//   movie page     -> one "Download Now" button per quality, each leading to a
//                     nexdrive.fit-style hub page with a "G-Direct" link
//   series page    -> one "Episode Links" hub per (season, quality) pair; that
//                     hub lists one "G-Direct" link per episode, in order, so
//                     the Nth G-Direct link is episode N for that quality

const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_CONFIG_URL = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
const DEFAULT_BASE_URL = 'https://vegamovies.mq';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedBaseUrl = null;
let cachedBaseUrlAt = 0;
const BASE_URL_CACHE_TTL = 1000 * 60 * 30;

function getBaseUrl() {
  if (cachedBaseUrl && Date.now() - cachedBaseUrlAt < BASE_URL_CACHE_TTL) {
    return Promise.resolve(cachedBaseUrl);
  }
  return fetch(DOMAINS_CONFIG_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(cfg => {
      const url = (cfg && cfg.vegamovies) ? cfg.vegamovies.replace(/\/+$/, '') : DEFAULT_BASE_URL;
      cachedBaseUrl = url;
      cachedBaseUrlAt = Date.now();
      console.log(`[VegaMovies] Using domain: ${url}`);
      return url;
    })
    .catch(() => DEFAULT_BASE_URL);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  return fetch(url, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      const imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || null;
      console.log(`[VegaMovies] TMDB Info: "${title}" (${year}) imdb=${imdbId || 'none'}`);
      return { title, year, imdbId };
    })
    .catch(() => ({ title: '', year: '', imdbId: null }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Prefers an exact IMDb id match (the search index carries one per hit) since
// that's unambiguous; falls back to word-overlap scoring against the title
// (and a bonus for the release year appearing in the post title) when the
// site's own imdb_id field is missing for a given hit.
function findBestMatch(hits, mediaInfo) {
  if (!hits.length) return null;
  if (mediaInfo.imdbId) {
    const exact = hits.find(h => h.document.imdb_id === mediaInfo.imdbId);
    if (exact) return exact.document;
  }
  const targetWords = new Set(normalize(mediaInfo.title).split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const hit of hits) {
    const doc = hit.document;
    const titleWords = normalize(doc.post_title).split(' ').filter(Boolean);
    const overlap = titleWords.filter(w => targetWords.has(w)).length;
    let score = targetWords.size ? overlap / targetWords.size : 0;
    if (mediaInfo.year && doc.post_title.includes(mediaInfo.year)) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = doc;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function getIndexQuality(str) {
  if (!str) return 'Unknown';
  const m = String(str).match(/(\d{3,4})\s*[pP]/);
  if (m) return `${m[1]}p`;
  const lower = str.toLowerCase();
  if (lower.includes('8k')) return '8K';
  if (lower.includes('4k') || lower.includes('2160')) return '4K';
  return 'Unknown';
}

function getSizeLabel(str) {
  const m = String(str || '').match(/([\d.]+\s*(?:GB|MB|TB))/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

// The G-Direct embed page is a plain "redirecting..." shell containing
// `var reurl = "https://fastdl.zip/dl.php?link=<real file URL>"` in static
// HTML - no JS execution needed, just read the value straight out of the
// page text. The rest of that page is browser/ad-blocker detection noise
// unrelated to the redirect itself.
function extractGDirectFinalUrl(embedUrl) {
  return fetch(embedUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const m = html.match(/var\s+reurl\s*=\s*"([^"]+)"/);
      if (!m) return null;
      const reurl = m[1];
      const linkMatch = reurl.match(/[?&]link=(.+)$/);
      return linkMatch ? linkMatch[1] : reurl;
    })
    .catch(() => null);
}

function findLinkByText($, root, pattern) {
  let href = null;
  root.find('a').each((i, el) => {
    if (href) return;
    if (pattern.test($(el).text())) href = $(el).attr('href');
  });
  return href;
}

// A hub page (reached via a movie's "Download Now" button, or one entry in a
// series' "Episode Links" list) offers several resolvers (G-Direct, V-Cloud,
// Filepress, DropGalaxy, ...) for the same file - only G-Direct is usable
// here (see file header), so that's the only one this looks for.
function resolveHubToUrl(hubUrl) {
  return fetch(hubUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const gdirect = findLinkByText($, $.root(), /G-Direct/i);
      if (!gdirect) return null;
      return extractGDirectFinalUrl(gdirect);
    })
    .catch(() => null);
}

function isSeriesPage($) {
  return $('h3, h5').filter((i, el) => /Series[\s-]*SYNOPSIS\/PLOT|Series Info/i.test($(el).text())).length > 0;
}

function extractMovieTargets($) {
  const targets = [];
  $('main h3, main h5').each((i, el) => {
    const text = $(el).text().trim();
    if (!/\d{3,4}\s*[pP]|4K/i.test(text)) return;
    const hubUrl = findLinkByText($, $(el).next(), /Download Now/i) || findLinkByText($, $(el).next(), /.+/);
    if (hubUrl) targets.push({ qualityText: text, hubUrl });
  });
  return targets;
}

function extractSeriesTargets($, season) {
  const targets = [];
  $('main h3, main h5').each((i, el) => {
    const text = $(el).text().trim();
    const seasonMatch = text.match(/Season\s*(\d+)/i);
    if (!seasonMatch || parseInt(seasonMatch[1], 10) !== season) return;
    if (!/\d{3,4}\s*[pP]|4K/i.test(text)) return;
    const listUrl = findLinkByText($, $(el).next(), /Episode Links/i);
    if (listUrl) targets.push({ qualityText: text, listUrl });
  });
  return targets;
}

function buildStream(url, qualityText, label) {
  return {
    name: 'VegaMovies',
    title: label,
    url,
    quality: getIndexQuality(qualityText),
    size: getSizeLabel(qualityText),
    type: 'direct',
    headers: HEADERS,
    provider: 'vegamovies'
  };
}

function validateStreamUrl(stream) {
  return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => fetch(stream.url, { method: 'GET', headers: Object.assign({}, stream.headers, { Range: 'bytes=0-2048' }) })
      .then(res => res.ok || res.status === 206)
      .catch(() => false));
}

function getMoviePageStreams($, label) {
  const targets = extractMovieTargets($);
  return Promise.all(targets.map(t =>
    resolveHubToUrl(t.hubUrl).then(url => url ? buildStream(url, t.qualityText, label) : null)
  )).then(streams => streams.filter(Boolean));
}

function getSeriesPageStreams($, season, episode, label) {
  const targets = extractSeriesTargets($, season);
  return Promise.all(targets.map(t =>
    fetch(t.listUrl, { headers: HEADERS })
      .then(res => res.text())
      .then(html => {
        const $$ = cheerio.load(html);
        const gdirectLinks = [];
        $$('a').each((i, el) => {
          if (/G-Direct/i.test($$(el).text())) gdirectLinks.push($$(el).attr('href'));
        });
        const episodeUrl = gdirectLinks[episode - 1];
        if (!episodeUrl) return null;
        return extractGDirectFinalUrl(episodeUrl).then(url => url ? buildStream(url, t.qualityText, `${label} S${season}E${episode}`) : null);
      })
      .catch(() => null)
  )).then(streams => streams.filter(Boolean));
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[VegaMovies] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[VegaMovies] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getBaseUrl(), getTmdbInfo(tmdbId, mediaType)]).then(([baseUrl, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return fetch(`${baseUrl}/search.php?q=${encodeURIComponent(mediaInfo.title)}&page=1`, { headers: HEADERS })
      .then(res => res.json())
      .then(data => {
        const hits = Array.isArray(data.hits) ? data.hits : [];
        const match = findBestMatch(hits, mediaInfo);
        if (!match) {
          console.log('[VegaMovies] No matching title found');
          return [];
        }
        console.log(`[VegaMovies] Matched: "${match.post_title}"`);
        const pageUrl = new URL(match.permalink, baseUrl).toString();
        return fetch(pageUrl, { headers: HEADERS })
          .then(res => res.text())
          .then(html => {
            const $ = cheerio.load(html);
            return mediaType === 'tv'
              ? getSeriesPageStreams($, season, episode, label)
              : getMoviePageStreams($, label);
          });
      })
      .then(streams => {
        console.log(`[VegaMovies] Found ${streams.length} stream(s), validating...`);
        return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
          const valid = validated.filter(v => v.ok).map(v => v.stream);
          const dead = validated.filter(v => !v.ok).map(v => v.stream.name + ' ' + v.stream.quality);
          if (dead.length) console.log(`[VegaMovies] Dropping unreachable: ${dead.join(', ')}`);
          console.log(`[VegaMovies] ${valid.length}/${streams.length} stream(s) validated OK`);
          return valid;
        });
      });
  }).catch(err => {
    console.log(`[VegaMovies] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
