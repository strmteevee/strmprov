// MoviesDrive scraper - ported from the decompiled CloudStream "StreamPlay"
// plugin (com.phisher98.StreamPlayExtractor#invokeMoviesdrive, decompiled
// this session from the StreamPlay.cs3 build), then verified live end-to-end
// against the real site (2026-09-28) rather than trusted blindly - the
// decompiled Kotlin is a coroutine-state-machine mess that jadx could only
// partially decompile (the per-item resolver lambdas needed the register-
// level fallback decompile to read at all), and this plugin's other sources
// have already been confirmed to drift from reality twice this session.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["moviesdrive"]
//   search         -> GET {domain}/search.php?q={query}&page=1  (Typesense-style
//                     JSON, same shape as vegamovies.js's search.php - each hit's
//                     "document" has imdb_id/post_title/permalink)
//   movie page     -> one "h5 > a" link per quality, each pointing to an
//                     mdrive.lol "archive" intermediate page - confirmed live
//                     (Inception, tmdb 27205) that page embeds exactly one
//                     hubcloud.ist/drive/<id> link
//   series page    -> one "Season N [...]" h5 per (season, quality) with NO
//                     link of its own - the link lives on the immediately
//                     following h5 ("{q}p Single Episode"), confirmed live
//                     (Breaking Bad) to point at a SECOND mdrive.lol page
//                     listing "EpNN– {q}p [size]" headers, each followed by
//                     a "HubCloud" h5 whose <a> is the final hubcloud.ist link
//   hubcloud.ist   -> resolved via the shared lib/hubcloudExtract.js helper
//                     (already used by 4khdhub.js/hindmoviez.js) rather than
//                     reimplementing that extraction - confirmed live it hands
//                     back a real googleusercontent.com direct link (200,
//                     video/mkv) and, sometimes, a PixelServer link that was
//                     confirmed live to already be dead (404) for this same
//                     title - exactly the kind of stale link this file's own
//                     validateStreamUrl step is meant to filter out.
//
// Only hubcloud.ist links were seen live across every quality tried (movie:
// 480p/1080p/4K; series: S1E5). The decompiled extractMdrive() also matches
// gdflix/gdlink hosts, but neither was observed live and no gdflix handling
// exists elsewhere in this repo to model - if a future title routes through
// one, resolveTargetToStreams below logs and skips it rather than guessing.

const cheerio = require('cheerio');
const { extractHubCloud, formatBytes } = require('../lib/hubcloudExtract');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://new4.moviesdrive.christmas';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

// domains.json's value can itself be a stale alias that only redirects to the
// real site - re-verified live 2026-10-06: "new5.moviesdrive.christmas" 302s
// to "new1.moviesdrive.beer/?utm=2", and that redirect drops the request PATH,
// so "{alias}/search.php?q=..." landed on the homepage HTML instead of the
// JSON search API (no match, silently zero streams). Follow the redirect once
// on the root URL and use the final origin for everything after.
function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetch(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => ((data && data.moviesdrive) || DEFAULT_DOMAIN).replace(/\/+$/, ''))
    .catch(() => DEFAULT_DOMAIN)
    .then(domain => fetch(domain + '/', { headers: HEADERS })
      .then(res => {
        let resolved = domain;
        try { resolved = new URL(res.url || domain).origin; } catch (e) { /* keep the alias */ }
        cachedDomain = resolved;
        cachedDomainAt = Date.now();
        console.log(`[MoviesDrive] Using domain: ${resolved}`);
        return resolved;
      })
      .catch(() => domain));
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
      console.log(`[MoviesDrive] TMDB Info: "${title}" (${year}) imdb=${imdbId || 'none'}`);
      return { title, year, imdbId };
    })
    .catch(() => ({ title: null, year: '', imdbId: null }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Same matching strategy as vegamovies.js (same underlying site template -
// the search.php document schema is identical field-for-field): prefer an
// exact imdb_id hit, else score by title word-overlap with a year bonus, and
// require a year that doesn't outright conflict with a post's own stated year.
function findBestMatch(hits, mediaInfo) {
  if (!hits || !hits.length) return null;
  if (mediaInfo.imdbId) {
    const exact = hits.find(h => h.document && h.document.imdb_id === mediaInfo.imdbId);
    if (exact) return exact.document;
  }
  const targetWords = new Set(normalize(mediaInfo.title).split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const hit of hits) {
    const doc = hit.document;
    if (!doc || !doc.post_title) continue;
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

function search(domain, query) {
  const url = `${domain}/search.php?q=${encodeURIComponent(query)}&page=1`;
  return fetch(url, { headers: Object.assign({}, HEADERS, { Referer: domain + '/' }) })
    .then(res => (res.ok ? res.json() : null))
    .then(data => (data && Array.isArray(data.hits) ? data.hits : []))
    .catch(() => []);
}

function extractQuality(str) {
  const m = /(\d{3,4})\s*[pP]/.exec(str || '');
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 2160) return '4K';
    if (n >= 1080) return '1080p';
    if (n >= 720) return '720p';
    if (n >= 480) return '480p';
    return `${n}p`;
  }
  if (/4K|UHD/i.test(str || '')) return '4K';
  return 'Unknown';
}

// One h5>a per quality on a movie page - confirmed live the anchor's own
// enclosing h5 carries the quality/size label directly (e.g. "1080p 10bit
// HEVC [2.3GB]"), each pointing to an mdrive.lol intermediate page.
function extractMovieQualityLinks($) {
  const groups = [];
  $('h5 > a').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).closest('h5').text().trim();
    groups.push({ label, mdriveHref: href });
  });
  return groups;
}

// A series page has one "Season N [...]" h5 per (season, quality) group with
// no link of its own - confirmed live the link lives on the immediately
// following h5 ("{q}p Single Episode"). Headers for other seasons/qualities
// are skipped by the season-number match; "Single Episode"/"Zip" sub-headers
// never themselves match the season pattern so they're naturally excluded.
function extractSeasonQualityGroups($, season) {
  const seasonPatterns = [
    new RegExp('season\\s*' + season + '\\b', 'i'),
    new RegExp('\\bs0?' + season + '\\b', 'i')
  ];
  const groups = [];
  $('h5').each((_, el) => {
    const text = $(el).text().trim();
    if (!text || /single episode|zip/i.test(text)) return;
    if (!seasonPatterns.some(re => re.test(text))) return;
    let href = $(el).find('a').first().attr('href');
    if (!href) {
      const next = $(el).next();
      if (next.length) href = next.find('a').first().attr('href');
    }
    if (href) groups.push({ label: text, epListHref: href });
  });
  return groups;
}

// The "{q}p Single Episode" link leads to a second mdrive.lol page listing
// one "EpNN– {q}p [size]" heading per episode, each immediately followed by
// a "HubCloud" heading holding the final link - confirmed live (Breaking Bad
// S1E5) this exact regex/walk finds precisely the one hubcloud.ist href that
// belongs to the requested episode, stopping before the next episode heading.
function resolveEpisodeMdriveLinks(epListHref, season, episode) {
  return fetch(epListHref, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const sepRegex = new RegExp(
        '\\b(?:ep|episode|e)\\s*0?' + episode + '\\b|s0?' + season + '\\s*e0?' + episode + '\\b',
        'i'
      );
      const nextEpRegex = /^\s*(EP\s*\d+|Episode\s*\d+|S\d+E\d+)/i;
      const headings = $('h5, h4, h3, p').toArray();
      let matchIdx = -1;
      for (let i = 0; i < headings.length; i++) {
        if (sepRegex.test($(headings[i]).text())) { matchIdx = i; break; }
      }
      if (matchIdx === -1) return [];
      const links = [];
      let sib = $(headings[matchIdx]).next();
      while (sib.length && !nextEpRegex.test(sib.text().trim())) {
        sib.find('a[href]').each((_, a) => {
          const href = $(a).attr('href');
          if (href) links.push(href);
        });
        sib = sib.next();
      }
      return links;
    })
    .catch(() => []);
}

function isFinalHostUrl(url) {
  return /hubcloud\.|gdflix\.|gdlink\.|hubdrive\./i.test(url);
}

// Mirrors the decompiled extractMdrive()'s core behavior: an mdrive.lol page
// embeds one (occasionally more) hubcloud/gdflix/gdlink link - scan its
// anchors for one. If the url handed in is already one of those hosts (as
// happens directly on the episode-list page), skip the extra fetch.
function resolveMdriveTargets(url) {
  if (!url) return Promise.resolve([]);
  if (isFinalHostUrl(url)) return Promise.resolve([url]);
  return fetch(url, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const targets = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && isFinalHostUrl(href) && targets.indexOf(href) === -1) targets.push(href);
      });
      return targets;
    })
    .catch(() => []);
}

// hubcloud.* is the only final host confirmed live this session - see the
// file header. Anything else (gdflix/gdlink/hubdrive) is logged and skipped
// rather than guessed at with unverified extraction logic.
function resolveTargetToStreams(target, meta) {
  if (/hubcloud\./i.test(target)) {
    return extractHubCloud(target, { title: meta.title, bytes: 0 }, { userAgent: USER_AGENT, log: console.log })
      .then(results => results.map(r => ({
        name: `MoviesDrive [${r.source}]`,
        title: `${r.meta.title || meta.title}\n${formatBytes(r.meta.bytes || 0)}`,
        url: r.url,
        quality: meta.quality,
        headers: HEADERS,
        provider: 'moviesdrive'
      })));
  }
  console.log(`[MoviesDrive] Unsupported final-link host, skipping: ${target}`);
  return Promise.resolve([]);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(item => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function getMovieStreams($, label) {
  const groups = extractMovieQualityLinks($);
  if (!groups.length) {
    console.log('[MoviesDrive] No quality links found on movie page');
    return Promise.resolve([]);
  }
  const seen = new Set();
  return Promise.all(groups.map(g =>
    resolveMdriveTargets(g.mdriveHref).then(targets => {
      const fresh = targets.filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
      return Promise.all(fresh.map(t => resolveTargetToStreams(t, { title: label, quality: extractQuality(g.label) })));
    })
  )).then(nested => nested.flat(2));
}

function getTvStreams($, season, episode, label) {
  const groups = extractSeasonQualityGroups($, season);
  if (!groups.length) {
    console.log(`[MoviesDrive] No quality groups found for season ${season}`);
    return Promise.resolve([]);
  }
  const seen = new Set();
  const episodeLabel = `${label} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return Promise.all(groups.map(g =>
    resolveEpisodeMdriveLinks(g.epListHref, season, episode)
      .then(rawLinks => Promise.all(dedupe(rawLinks).map(l => resolveMdriveTargets(l))).then(nested => nested.flat()))
      .then(targets => {
        const fresh = targets.filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
        return Promise.all(fresh.map(t => resolveTargetToStreams(t, { title: episodeLabel, quality: extractQuality(g.label) })));
      })
  )).then(nested => nested.flat(2));
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

// Confirmed live that a HubCloud "PixelServer" link can be stale (404 on
// both HEAD and a ranged GET) even when the sibling "10Gbps"
// googleusercontent link from the very same page is a real, playable 200 -
// HTTP status from the resolver alone isn't reliable, so every stream this
// provider returns is independently probed here before being handed back.
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

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[MoviesDrive] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[MoviesDrive] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return search(domain, mediaInfo.title).then(hits => {
      const match = findBestMatch(hits, mediaInfo);
      if (!match) {
        console.log('[MoviesDrive] No matching title found');
        return [];
      }
      console.log(`[MoviesDrive] Matched: "${match.post_title}"`);
      const pageUrl = match.permalink && match.permalink.startsWith('http')
        ? match.permalink
        : new URL(match.permalink, domain).toString();

      return fetch(pageUrl, { headers: HEADERS })
        .then(res => res.text())
        .then(html => {
          const $ = cheerio.load(html);
          return mediaType === 'tv'
            ? getTvStreams($, season, episode, label)
            : getMovieStreams($, label);
        });
    });
  })
    .then(streams => {
      console.log(`[MoviesDrive] Found ${streams.length} candidate stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => `${v.stream.name} ${v.stream.quality}`);
        if (dead.length) console.log(`[MoviesDrive] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[MoviesDrive] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    })
    .catch(err => {
      console.log(`[MoviesDrive] getStreams failed: ${err.message}`);
      return [];
    });
}

module.exports = { getStreams };
