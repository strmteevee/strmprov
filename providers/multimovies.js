// MultiMovies scraper.
//
// Ported from the CloudStream "StreamPlay" plugin
// (com.phisher98.StreamPlayExtractor#invokeMultimovies, decompiled from the
// StreamPlay.cs3 build), then verified live end-to-end against the real site
// and adapted where the decompile no longer matched reality (see below) -
// this session already confirmed twice that other sources in that same
// decompiled plugin had rotated domains/markup, so nothing here was trusted
// without a live check.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["MultiMovies"]
//   search         -> GET {domain}/?s={query} - dooplay-theme WordPress site;
//                     confirmed live the exact-title hit uses a different
//                     markup (.title a / .meta .year) than the rest of the
//                     grid (.data h3 / .wdate), so both shapes are read.
//   movie page     -> {domain}/movies/{slug}/  (slug taken from the matched
//                     search result's own href, not reconstructed from the
//                     TMDB title - the decompiled plugin's own createSlug()
//                     approach risks mismatching the site's real slugging)
//   tv episode     -> {domain}/episodes/{slug}-{season}x{episode}/ - matches
//                     the decompiled plugin's URL pattern, confirmed live
//                     (Game of Thrones S1E1, Stranger Things S1E1); {slug}
//                     is the show's own slug taken from its /tvshows/ search
//                     hit, not the movie slug pattern.
//   player options -> ul#playeroptionsul li elements, each with data-post/
//                     data-nume/data-type - confirmed live, matches decompile
//                     exactly. Each option is a different upstream "server";
//                     only the one labeled "Cineverse" is implemented here
//                     (see below for why).
//   resolve option -> POST {domain}/wp-admin/admin-ajax.php
//                     (action=doo_player_ajax, post, nume, type) -> JSON
//                     {embed_url, type:"iframe"}. Confirmed live the site's
//                     own embed_url sometimes carries a literal "&amp;" HTML
//                     entity instead of "&" in its query string (e.g. a TV
//                     episode's "...?id=X&amp;s=1&amp;e=1") - fetching that
//                     URL as-is silently mis-parses the season/episode and
//                     the embed serves the WRONG episode (confirmed live:
//                     landed on "Stranger Things S05E08" instead of the
//                     requested S1E1). Un-escaping "&amp;" -> "&" before the
//                     request fixes this.
//   Cineverse embed -> rozgarlelo.modiplay.xyz/embed/... - a small wrapper
//                     page whose only job is an <iframe id="playerFrame">
//                     pointing at modiplay's own /proxy.php?p={platform}&c={code}.
//   proxy.php page  -> a full HLS.js player page. Confirmed live this page's
//                     inline script embeds `var src="https://multiai.modiplay.xyz/
//                     stream_proxy.php?url=<upstream master.m3u8>&ref=...&tok=..."`
//                     directly in static HTML when the backing file lives on
//                     "streamhg" (var platform="streamhg") - no JS execution
//                     needed, just read it out. That stream_proxy.php URL is
//                     itself the final, directly playable master playlist
//                     (confirmed live: real #EXTM3U content, multiple
//                     quality variants, multi-language audio tracks).
//                     Confirmed live this does NOT hold for every backing
//                     platform: some files are hosted on "rpmshare" (and
//                     presumably others), where `var src=""` stays empty and
//                     the real source is only discoverable by letting the
//                     page's own JS run (it loads a hidden second iframe and
//                     exchanges postMessage with it) - not something a plain
//                     HTTP client can do. Confirmed live streamhg is the
//                     common case (3/4 titles sampled); items landing on an
//                     unextractable platform are simply skipped, the same
//                     way vegamovies.js skips Cloudflare-gated V-Cloud and
//                     uhdmovies.js skips Turnstile-gated Resume Cloud rather
//                     than fabricating a stream that doesn't work.
//
// Other player options seen live (GDMIRROR/filesforever.link - a heavily
// obfuscated character-shift-cipher page; screenscape.me, Nxsha, Vidout,
// nhdapi - each its own Next.js CSR app or gated API) were not implemented:
// each would need its own from-scratch reverse-engineering effort and none
// were confirmed extractable with a plain HTTP client in the time available.

const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://multimovies.casa';
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
      const domain = ((data && data.MultiMovies) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[MultiMovies] Using domain: ${domain}`);
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
      console.log(`[MultiMovies] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// dooplay's search results page mixes two markups for the same result grid -
// confirmed live the single "exact slug match" hit renders as
// `.title a` + `.meta .year`, while every other card renders as
// `.data h3` + `.wdate`. Reading both shapes generically also picks up the
// media type (movie vs tv show) straight from the href path.
function search(domain, query) {
  const url = `${domain}/?s=${encodeURIComponent(query)}`;
  return fetch(url, { headers: HEADERS })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      const results = [];
      $('article').each((_, el) => {
        const $el = $(el);
        const href = $el.find('a[href*="/movies/"], a[href*="/tvshows/"]').first().attr('href');
        if (!href) return;
        const title = $el.find('.title, .data h3').first().text().trim() || $el.find('img').attr('alt') || '';
        if (!title) return;
        const yearText = $el.find('.year, .wdate').first().text().trim();
        const yearMatch = yearText.match(/(19|20)\d{2}/);
        const mediaType = href.includes('/tvshows/') ? 'tv' : 'movie';
        results.push({ href, title, year: yearMatch ? yearMatch[0] : '', mediaType });
      });
      return results;
    })
    .catch(() => []);
}

function findBestMatch(results, mediaInfo, mediaType) {
  const candidates = results.filter(r => r.mediaType === mediaType);
  if (!candidates.length) return null;
  const targetWords = new Set(normalize(mediaInfo.title).split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const item of candidates) {
    // A same-named but unrelated title is a hard mismatch when both sides
    // state a year that disagrees, not just a missed bonus below - otherwise
    // short common titles can win purely on word overlap.
    if (mediaInfo.year && item.year && Math.abs(parseInt(item.year, 10) - parseInt(mediaInfo.year, 10)) > 1) continue;
    const itemWords = normalize(item.title).split(' ').filter(Boolean);
    const overlap = itemWords.filter(w => targetWords.has(w)).length;
    let score = targetWords.size ? overlap / targetWords.size : 0;
    if (mediaInfo.year && item.year === mediaInfo.year) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function slugFromHref(href) {
  const m = href.match(/\/(?:movies|tvshows)\/([^/]+)\/?/);
  return m ? m[1] : null;
}

function fetchPlayerOptions(pageUrl) {
  return fetch(pageUrl, { headers: HEADERS })
    .then(res => {
      if (!res.ok) return null;
      return res.text();
    })
    .then(html => {
      if (!html) return [];
      if (/Just a moment/i.test(html)) {
        console.log('[MultiMovies] Cloudflare challenge encountered, aborting');
        return [];
      }
      const $ = cheerio.load(html);
      const options = [];
      $('ul#playeroptionsul li').each((_, el) => {
        const $el = $(el);
        options.push({
          post: $el.attr('data-post'),
          nume: $el.attr('data-nume'),
          type: $el.attr('data-type'),
          label: $el.text().trim()
        });
      });
      return options;
    })
    .catch(() => []);
}

function ajaxResolveEmbed(domain, pageUrl, option) {
  const body = new URLSearchParams({ action: 'doo_player_ajax', post: option.post, nume: option.nume, type: option.type });
  return fetch(`${domain}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: pageUrl }),
    body: body.toString()
  })
    .then(res => (res.ok ? res.json() : null))
    .then(json => {
      if (!json || !json.embed_url) return null;
      // See file header - the site's own JSON sometimes carries a literal
      // "&amp;" instead of "&", which breaks season/episode parsing
      // downstream if left as-is.
      return String(json.embed_url).replace(/&amp;/g, '&');
    })
    .catch(() => null);
}

function extractSubtitles($, proxyUrl) {
  const subs = [];
  $('track').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    let url;
    try { url = new URL(src, proxyUrl).toString(); } catch (e) { return; }
    const lang = $(el).attr('srclang') || $(el).attr('label') || 'Unknown';
    subs.push({ url, language: $(el).attr('label') || lang, name: $(el).attr('label') || lang });
  });
  return subs;
}

// Resolves the "Cineverse" player option (modiplay.xyz) all the way down to
// a final playable HLS URL. Returns null when the backing platform isn't one
// that embeds its source statically (see file header) rather than throwing.
function resolveCineverse(domain, pageUrl, option) {
  return ajaxResolveEmbed(domain, pageUrl, option).then(embedUrl => {
    if (!embedUrl) return null;
    return fetch(embedUrl, { headers: Object.assign({}, HEADERS, { Referer: pageUrl }) })
      .then(res => (res.ok ? res.text() : null))
      .then(embedHtml => {
        if (!embedHtml) return null;
        const $ = cheerio.load(embedHtml);
        const frameSrc = $('#playerFrame').attr('src') || $('iframe').attr('src');
        if (!frameSrc) return null;
        let proxyUrl;
        try { proxyUrl = new URL(frameSrc, embedUrl).toString(); } catch (e) { return null; }
        return fetch(proxyUrl, { headers: Object.assign({}, HEADERS, { Referer: embedUrl }) })
          .then(res => (res.ok ? res.text() : null))
          .then(proxyHtml => {
            if (!proxyHtml) return null;
            const m = proxyHtml.match(/var src\s*=\s*"([^"]*)"/);
            const rawSrc = m ? m[1].replace(/\\\//g, '/') : '';
            if (!rawSrc) {
              const platformMatch = proxyHtml.match(/var platform\s*=\s*"([^"]*)"/);
              console.log(`[MultiMovies] No static source for platform "${platformMatch ? platformMatch[1] : 'unknown'}", skipping`);
              return null;
            }
            let finalUrl;
            try { finalUrl = new URL(rawSrc, proxyUrl).toString(); } catch (e) { return null; }
            const $$ = cheerio.load(proxyHtml);
            const subtitles = extractSubtitles($$, proxyUrl);
            return { url: finalUrl, referer: proxyUrl, subtitles };
          });
      });
  }).catch(() => null);
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url) || /stream_proxy\.php/i.test(url);
}

function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return fetch(stream.url, { headers: stream.headers })
      .then(res => {
        if (!res.ok) return false;
        return res.text().then(text => /^#EXTM3U/.test(text.trim()));
      })
      .catch(() => false);
  }
  return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => false);
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[MultiMovies] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[MultiMovies] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return search(domain, mediaInfo.title).then(results => {
      const match = findBestMatch(results, mediaInfo, mediaType);
      if (!match) {
        console.log(`[MultiMovies] No matching title found for "${mediaInfo.title}"`);
        return [];
      }
      console.log(`[MultiMovies] Matched: "${match.title}" (${match.href})`);

      let pageUrl = match.href;
      if (mediaType === 'tv') {
        const slug = slugFromHref(match.href);
        if (!slug) return [];
        pageUrl = `${domain}/episodes/${slug}-${season}x${episode}/`;
      }

      return fetchPlayerOptions(pageUrl).then(options => {
        if (!options.length) {
          console.log('[MultiMovies] No player options found on page');
          return [];
        }
        const cineverse = options.find(o => /cineverse/i.test(o.label));
        if (!cineverse) {
          console.log('[MultiMovies] No Cineverse option available for this title');
          return [];
        }
        return resolveCineverse(domain, pageUrl, cineverse).then(resolved => {
          if (!resolved) return [];
          return [{
            name: 'MultiMovies - Cineverse',
            title: label,
            url: resolved.url,
            quality: 'Auto',
            headers: { 'User-Agent': USER_AGENT, Referer: resolved.referer },
            subtitles: resolved.subtitles,
            provider: 'multimovies'
          }];
        });
      });
    });
  }).then(streams => {
    if (!streams.length) return streams;
    console.log(`[MultiMovies] Found ${streams.length} candidate stream(s), validating...`);
    return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
      const valid = validated.filter(v => v.ok).map(v => v.stream);
      const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
      if (dead.length) console.log(`[MultiMovies] Dropping unreachable: ${dead.join(', ')}`);
      console.log(`[MultiMovies] ${valid.length}/${streams.length} stream(s) validated OK`);
      return valid;
    });
  }).catch(err => {
    console.log(`[MultiMovies] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
