// RogMovies scraper.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json
//                     ["rogmovies"] - confirmed live (2026-09-28) that even
//                     this always-rotating value is already stale by the
//                     time it's read: new2.rogmovies.click answers with a
//                     Cloudflare 301 chain (new2.rogmovies.click ->
//                     n1.rogmovies.best -> rogmovies.best). fetch() follows
//                     redirects by default, so requests built from the
//                     domains.json value still land correctly - but the
//                     final resolved origin (from response.url) is cached
//                     instead of the pre-redirect one, so later requests
//                     skip paying for two redirect hops every time.
//   search         -> GET {domain}/search.php?q={query} - a Typesense-style
//                     JSON index (facet_counts/hits/found) whose per-hit
//                     "document" shape (id, imdb_id, permalink, post_title,
//                     post_thumbnail) is identical to VegaMovies's own
//                     search.php - confirmed live these two sites share the
//                     same backend (a resolved RogMovies download even
//                     carried a "-Vegamovies.to.mkv" filename suffix).
//                     Confirmed live the index is typo-tolerant enough to
//                     return unrelated hits for a query with no real match
//                     (searching "Inception" fuzzy-matched "...The
//                     Deception..." titles, zero actual hits) - matching on
//                     imdb_id/word-overlap below is required, not optional.
//   movie page     -> one nexdrive.fit hub link per quality: an h5 heading
//                     carrying the quality text (e.g. "... 1080p 10Bit
//                     WEB-DL x265 [2GB]"), immediately followed by a
//                     `<p><a href="hub"><button class="dwd-button">Download
//                     Now</button></a></p>` - confirmed live via direct HTML
//                     inspection, matching the decompiled StreamPlay
//                     extension's `button.dwd-button` selector.
//   series page    -> one nexdrive.fit hub link per (season, quality) pair:
//                     an h3 heading like "Season 2 (Episode 1 - 3 Added)
//                     {HiNDi-Series} 720p WEB-DL x264 [1GB/E]" followed by a
//                     "G-Direct [Instant]" button in the same <p>. That hub
//                     page lists every episode for that (season, quality),
//                     each under its own "-:Episode: N:-" h4 heading with
//                     its own G-Direct link right after - so an episode is
//                     found by matching heading text, not by position in a
//                     list (confirmed live: RogMovies's own headings don't
//                     guarantee episode 1 is listed first-and-only-once the
//                     way VegaMovies's flat "Episode Links" list does).
//   nexdrive.fit   -> "G-Direct [Instant]" is a fastdl.zip/embed(.php) link
//                     containing a plain `var reurl = "https://fastdl.zip/dl.php?link=<real
//                     googleusercontent.com URL>"` in static HTML - the
//                     exact same mechanism vegamovies.js already documented
//                     for its own G-Direct handling, no JS execution needed.
//                     "V-Cloud" (vcloud.fit) is confirmed live behind a real
//                     Cloudflare managed challenge (plain HTTP request gets
//                     a 403 "Just a moment..." page), and "Filepress"
//                     (filebee.xyz, which itself 301s to a rt.filepress.baby
//                     mirror) failed to even establish a connection in
//                     testing - both skipped, matching vegamovies.js's own
//                     documented reasoning for the same two resolvers.

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://new2.rogmovies.click';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

// Reads domains.json, then follows that value's own redirect chain once
// (confirmed live: two Cloudflare 301 hops as of 2026-09-28) so every
// subsequent request in this run starts from the actually-final origin
// instead of paying for the same two redirects every time.
function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetch(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => ((data && data.rogmovies) || DEFAULT_DOMAIN).replace(/\/+$/, ''))
    .catch(() => DEFAULT_DOMAIN)
    .then(domain => fetch(domain + '/', { headers: HEADERS })
      .then(res => {
        const resolved = (res.url || domain).replace(/\/+$/, '');
        cachedDomain = resolved;
        cachedDomainAt = Date.now();
        console.log(`[RogMovies] Using domain: ${resolved}`);
        return resolved;
      })
      .catch(() => {
        cachedDomain = domain;
        cachedDomainAt = Date.now();
        return domain;
      }));
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
      console.log(`[RogMovies] TMDB Info: "${title}" (${year}) imdb=${imdbId || 'none'}`);
      return { title, year, imdbId };
    })
    .catch(() => ({ title: '', year: '', imdbId: null }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function search(domain, query) {
  return fetch(`${domain}/search.php?q=${encodeURIComponent(query)}`, { headers: HEADERS })
    .then(res => res.ok ? res.json() : null)
    .then(data => (data && Array.isArray(data.hits)) ? data.hits.map(h => h.document).filter(Boolean) : [])
    .catch(() => []);
}

// Same two-tier strategy vegamovies.js uses against this same search index
// shape: an exact imdb_id hit is unambiguous, otherwise fall back to
// word-overlap scoring with a hard reject on a conflicting release year (a
// same-named unrelated title otherwise wins purely on word overlap for
// short common titles).
function findBestMatch(docs, mediaInfo) {
  if (!docs.length) return null;
  if (mediaInfo.imdbId) {
    const exact = docs.find(d => d.imdb_id && d.imdb_id === mediaInfo.imdbId);
    if (exact) return exact;
  }
  const targetWords = new Set(normalize(mediaInfo.title).split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const doc of docs) {
    if (!doc.post_title) continue;
    const postYearMatch = doc.post_title.match(/\b(19|20)\d{2}\b/);
    if (mediaInfo.year && postYearMatch && Math.abs(parseInt(postYearMatch[0], 10) - parseInt(mediaInfo.year, 10)) > 1) {
      continue;
    }
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
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 2160 ? '4K' : `${n}p`;
  }
  const lower = str.toLowerCase();
  if (lower.includes('4k') || lower.includes('uhd')) return '4K';
  return 'Unknown';
}

function getSizeLabel(str) {
  const m = String(str || '').match(/([\d.]+\s*(?:GB|MB|TB))/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

function findLinkByText($, root, pattern) {
  let href = null;
  root.find('a').each((i, el) => {
    if (href) return;
    if (pattern.test($(el).text())) href = $(el).attr('href');
  });
  return href;
}

// The G-Direct embed page (either /embed?download= on a movie hub or
// /embed.php?download= on an episode hub - confirmed live both resolve the
// same way) is a plain "redirecting..." shell containing
// `var reurl = "https://fastdl.zip/dl.php?link=<real file URL>"` in static
// HTML - no JS execution needed.
function extractGDirectFinalUrl(embedUrl) {
  return fetch(embedUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const m = html.match(/var\s+reurl\s*=\s*"([^"]+)"/);
      if (!m) return null;
      const linkMatch = m[1].match(/[?&]link=(.+)$/);
      return linkMatch ? linkMatch[1] : m[1];
    })
    .catch(() => null);
}

// A movie's download hub (reached via its "Download Now" / dwd-button link)
// offers several resolvers - only G-Direct is usable here (see file header).
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

function extractMovieTargets($) {
  const targets = [];
  $('h3, h4, h5').each((i, el) => {
    const text = $(el).text().trim();
    if (!/\d{3,4}\s*[pP]|4K/i.test(text)) return;
    const hubUrl = $(el).next().find('button.dwd-button').parent('a').attr('href')
      || findLinkByText($, $(el).next(), /.+/);
    if (hubUrl) targets.push({ qualityText: text, hubUrl });
  });
  return targets;
}

function extractSeriesTargets($, season) {
  const targets = [];
  $('h3, h4, h5').each((i, el) => {
    const text = $(el).text().trim();
    const seasonMatch = text.match(/Season\s*(\d+)/i);
    if (!seasonMatch || parseInt(seasonMatch[1], 10) !== season) return;
    if (!/\d{3,4}\s*[pP]|4K/i.test(text)) return;
    const hubUrl = findLinkByText($, $(el).next(), /G-Direct/i);
    if (hubUrl) targets.push({ qualityText: text, hubUrl });
  });
  return targets;
}

// The episode-list hub gives one "-:Episode: N:-" heading per episode, each
// immediately followed by its own G-Direct link - matched by heading text
// rather than position, since a season pack can be added to incrementally
// (e.g. "Episode 1 - 3 Added") and there's no guarantee episode order in the
// markup lines up with a plain index.
function extractEpisodeHubUrl($, episode) {
  const episodeRegex = new RegExp(`Episode:?\\s*${episode}\\b`, 'i');
  let hubUrl = null;
  $('h3, h4, h5').each((i, el) => {
    if (hubUrl) return;
    if (!episodeRegex.test($(el).text())) return;
    hubUrl = findLinkByText($, $(el).next(), /G-Direct/i);
  });
  return hubUrl;
}

function buildStream(url, qualityText, label) {
  return {
    name: 'RogMovies',
    title: `${label}\n${qualityText.replace(/\s+/g, ' ').trim()}`,
    url,
    quality: getIndexQuality(qualityText),
    size: getSizeLabel(qualityText),
    headers: HEADERS,
    provider: 'rogmovies'
  };
}

// Status alone isn't reliable (a dead resolver can still answer 200 with an
// error page instead of the file) - an .m3u8 link is GET-checked for a real
// playlist body, matching cinejoy.js/peachify.js; a direct file link only
// gets a cheap HEAD (falling back to a tiny ranged GET for hosts that
// reject HEAD), matching vegamovies.js.
function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return fetch(stream.url, { headers: stream.headers })
      .then(res => (res.ok ? res.text().then(text => /^#EXTM3U/.test(text.trim())) : false))
      .catch(() => false);
  }
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
    fetch(t.hubUrl, { headers: HEADERS })
      .then(res => res.text())
      .then(html => {
        const $$ = cheerio.load(html);
        const episodeGDirect = extractEpisodeHubUrl($$, episode);
        if (!episodeGDirect) return null;
        return extractGDirectFinalUrl(episodeGDirect).then(url => url ? buildStream(url, t.qualityText, `${label} S${season}E${episode}`) : null);
      })
      .catch(() => null)
  )).then(streams => streams.filter(Boolean));
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[RogMovies] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[RogMovies] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return search(domain, mediaInfo.title).then(docs => {
      const match = findBestMatch(docs, mediaInfo);
      if (!match || !match.permalink) {
        console.log(`[RogMovies] No matching title found for "${mediaInfo.title}"`);
        return [];
      }
      console.log(`[RogMovies] Matched: "${match.post_title}"`);
      const pageUrl = new URL(match.permalink, domain).toString();

      return fetch(pageUrl, { headers: HEADERS })
        .then(res => res.text())
        .then(html => {
          const $ = cheerio.load(html);
          return mediaType === 'tv'
            ? getSeriesPageStreams($, season, episode, label)
            : getMoviePageStreams($, label);
        });
    }).then(streams => {
      if (!streams.length) return streams;
      console.log(`[RogMovies] Found ${streams.length} stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => `${v.stream.name} ${v.stream.quality}`);
        if (dead.length) console.log(`[RogMovies] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[RogMovies] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    });
  }).catch(err => {
    console.log(`[RogMovies] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
