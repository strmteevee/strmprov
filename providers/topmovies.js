// TopMovies scraper.
//
// Ported from the CloudStream "StreamPlay" plugin's invokeTopMovies
// (decompiled from StreamPlay.cs3 - normal-mode decompilation FAILED for
// this specific method and fell back to raw register-level pseudo-code,
// which was read directly), then verified live end-to-end against the real
// site and adapted where the live site no longer matched the decompiled
// assumptions.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["topMovies"]
//                     (re-fetched at runtime; last confirmed live value:
//                     https://moviesleech.club - the on-site branding now
//                     reads "Movies Leech", but files served still carry a
//                     "TopMovies.quest" tag in their own filenames,
//                     confirming this is the same backend/content, just
//                     under a rotated domain+brand)
//   search         -> GET {domain}/?s={query}  (plain WordPress search,
//                     redirects to /search/{query}; both confirmed live with
//                     no Cloudflare challenge) - "#content_box article" holds
//                     one entry per matching post
//   movie page     -> one "Download Links" button per quality
//                     (a.maxbutton-download-links), with the quality+size
//                     heading sitting right above each one
//   series page    -> one "G-Drive" button per quality (a.maxbutton-g-drive)
//                     leading to an episode-list hub page with one
//                     "Episode N" link (plus a duplicate <strong>) per
//                     episode
//   quality page   -> a leechpro.blog/archives/{id} page with one "Fast
//                     Server (G-Drive)" button whose href is a
//                     cloud.unblockedgames.world/?sid=... redirect gate
//   unblockedgames -> a 3-step hidden-form POST dance (the exact same
//                     mechanism as uhdmovies.js's own bypassHrefli, same
//                     gate site) that ends on a driveseed.org/file/{id} page
//   driveseed page -> "Instant Download" routes through a video-seed-family
//                     gateway (video-gen.xyz confirmed live) that 302s to
//                     video-seed.dev/?url=<real file URL> - confirmed live
//                     the URL there is already a directly playable
//                     video-downloads.googleusercontent.com link, no further
//                     decryption needed for that particular gateway host.
//                     "Resume Cloud" is skipped - same site family as
//                     uhdmovies.js, confirmed gated behind a real Cloudflare
//                     Turnstile challenge with no available bypass.
//
// Verified live end-to-end (2026-09-28): Animal (2023, tmdb 1011477),
// "FHD 1080p" quality -> a real video/mkv, ~4.7GB, HTTP 200 direct download
// from video-downloads.googleusercontent.com. Series flow (Mirzapur S3,
// tmdb 210265) confirmed live through the same episode-hub -> gate ->
// driveseed chain up to the point of finding the per-episode link.

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://moviesleech.club';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

// The gate/driveseed/video-seed chain below is several sequential hops deep
// per quality item, against third-party sites this provider doesn't control
// - a bounded per-request timeout with one retry keeps a single hung hop
// from stalling the whole request indefinitely. Feature-detected (rather
// than assumed) since some CloudStream-derived JS runtimes have neither
// AbortController nor setTimeout, matching the same defensive pattern used
// in uhdmovies.js/4khdhub.js in this repo.
const FETCH_TIMEOUT_MS = 12000;
const HAS_ABORT_TIMER = typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined';

function fetchWithTimeout(url, options, attemptsLeft) {
  if (attemptsLeft === undefined) attemptsLeft = 1;
  if (!HAS_ABORT_TIMER) {
    return fetch(url, options).catch(err => {
      if (attemptsLeft <= 0) throw err;
      return fetchWithTimeout(url, options, attemptsLeft - 1);
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(res => { clearTimeout(timer); return res; })
    .catch(err => {
      clearTimeout(timer);
      if (attemptsLeft <= 0) throw err;
      return fetchWithTimeout(url, options, attemptsLeft - 1);
    });
}

function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetchWithTimeout(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const domain = ((data && data.topMovies) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[TopMovies] Using domain: ${domain}`);
      return domain;
    })
    .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetchWithTimeout(url, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[TopMovies] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

// Matches the site's own search-query cleanup confirmed in the decompiled
// source: strip quote characters, normalize dash/colon/underscore separators
// to spaces, collapse whitespace.
function cleanQuery(title) {
  return String(title || '')
    .replace(/['’]/g, '')
    .replace(/[:\-–_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/&#8[0-9]{3};/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Confirmed live: GET {domain}/?s={query} 302s to {domain}/search/{query}
// with no Cloudflare challenge either way - fetch() follows that redirect on
// its own, so this just reads whichever page comes back.
function search(domain, query) {
  const url = `${domain}/?s=${encodeURIComponent(query)}`;
  return fetchWithTimeout(url, { headers: HEADERS })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      const results = [];
      const seen = new Set();
      $('#content_box article, #content_box .post-cards article').each((_, el) => {
        const $el = $(el);
        const href = $el.find('a[href]').first().attr('href');
        const title = $el.find('h2.title, .title').first().text().trim()
          || $el.find('a[title]').first().attr('title')
          || $el.find('a').first().text().trim();
        if (!href || !title || seen.has(href)) return;
        seen.add(href);
        results.push({ href, title });
      });
      return results;
    })
    .catch(() => []);
}

// Post titles are always "Download <name> ..." - word-overlap scored against
// the TMDB title, with a year check for movies and a season-number check
// (extracted from the post title, e.g. "(Season 3)") for TV, since a plain
// title search returns every season's post together.
function findBestMatch(posts, mediaInfo, mediaType, season) {
  const targetTitle = normalize(mediaInfo.title);
  if (!targetTitle) return null;
  const targetWords = targetTitle.split(' ').filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const post of posts) {
    const postNorm = normalize(post.title).replace(/^download\s+/, '');
    const postWords = postNorm.split(' ').filter(Boolean);
    const overlap = targetWords.filter(w => postWords.includes(w)).length;
    let score = targetWords.length ? overlap / targetWords.length : 0;
    if (score < 0.6) continue;

    if (mediaType === 'tv') {
      const seasonMatch = /season\s*(\d+)/i.exec(post.title);
      if (season && seasonMatch) {
        if (parseInt(seasonMatch[1], 10) !== parseInt(season, 10)) continue;
        score += 0.5;
      } else if (season && !seasonMatch) {
        score -= 0.1;
      }
    } else {
      const yearMatch = /\b(19|20)\d{2}\b/.exec(post.title);
      if (mediaInfo.year && yearMatch) {
        if (Math.abs(parseInt(yearMatch[0], 10) - parseInt(mediaInfo.year, 10)) > 1) continue;
        score += 0.5;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = post;
    }
  }
  return best;
}

function getIndexQuality(str) {
  if (!str) return 'Unknown';
  const m = String(str).match(/(\d{3,4})\s*[pP]/);
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 2000 ? '2160p' : `${n}p`;
  }
  if (/4K|UHD/i.test(str)) return '2160p';
  return 'Unknown';
}

function getSizeLabel(str) {
  const m = String(str || '').match(/([\d.]+\s*(?:GB|MB|TB))/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

const QUALITY_RANK = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, Unknown: 0 };
// Each item below costs roughly 8-10 sequential network hops (quality page,
// fast-server page, the 5-hop gate bypass, driveseed page, video-seed
// gateway) - fanning out to every quality on a page (up to 6+ confirmed
// live) would make a single request very slow for little benefit once the
// top few qualities are covered, so only the best-ranked few are resolved.
const MAX_ITEMS = 3;

// Movie page: one "Download Links" button per quality; series page: one
// "G-Drive" button per quality leading to an episode hub. Both sit right
// after their own quality/size heading - confirmed live by walking up to
// the nearest preceding h1-h6.
function extractQualityItems($, selector) {
  const items = [];
  $(selector).each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let cur = $(el).closest('p, div, li, h1, h2, h3, h4, h5, h6');
    let heading = null;
    let hops = 0;
    while (cur.length && !heading && hops < 8) {
      const prev = cur.prev();
      if (prev.length && /^h[1-6]$/i.test(prev.get(0).tagName)) heading = prev.text().trim();
      else if (cur.get(0) && /^h[1-6]$/i.test(cur.get(0).tagName)) heading = cur.text().trim();
      cur = prev.length ? prev : cur.parent();
      hops++;
    }
    items.push({ href, heading: heading || '' });
  });
  return items;
}

function topItemsByQuality(items) {
  return items
    .slice()
    .sort((a, b) => (QUALITY_RANK[getIndexQuality(b.heading)] || 0) - (QUALITY_RANK[getIndexQuality(a.heading)] || 0))
    .slice(0, MAX_ITEMS);
}

const BYPASS_MARKERS = ['unblockedgames', 'thenaukriadda', 'href.li'];

function needsBypass(url) {
  return BYPASS_MARKERS.some(m => url.includes(m));
}

function getBaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return '';
  }
}

function fixUrl(url, domain) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return domain + url;
  return `${domain}/${url}`;
}

// A hidden-form 3-step POST dance used by cloud.unblockedgames.world (and
// its sibling gate domains) to land on the real driveseed/driveleech page -
// the exact same mechanism as uhdmovies.js's own bypassHrefli (same gate
// site), confirmed live end-to-end here too.
function bypassGate(url) {
  const host = getBaseUrl(url);
  return fetchWithTimeout(url, { headers: HEADERS })
    .then(res => res.text())
    .then(html1 => {
      const $1 = cheerio.load(html1);
      const formUrl1 = $1('form#landing').attr('action');
      if (!formUrl1) return null;
      const formData1 = {};
      $1('form#landing input').each((_, el) => { formData1[$1(el).attr('name')] = $1(el).attr('value') || ''; });
      return fetchWithTimeout(formUrl1, {
        method: 'POST',
        headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: new URLSearchParams(formData1).toString()
      })
        .then(res => res.text())
        .then(html2 => {
          const $2 = cheerio.load(html2);
          const formUrl2 = $2('form#landing').attr('action');
          if (!formUrl2) return null;
          const formData2 = {};
          $2('form#landing input').each((_, el) => { formData2[$2(el).attr('name')] = $2(el).attr('value') || ''; });
          return fetchWithTimeout(formUrl2, {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }),
            body: new URLSearchParams(formData2).toString()
          })
            .then(res => res.text())
            .then(html3 => {
              const $3 = cheerio.load(html3);
              const script = $3('script:contains(?go=)').html() || '';
              const skTokenMatch = script.match(/\?go=([^"]+)/);
              if (!skTokenMatch) return null;
              const skToken = skTokenMatch[1];
              const wpHttp2 = formData2._wp_http2 || '';
              return fetchWithTimeout(`${host}?go=${skToken}`, {
                headers: Object.assign({}, HEADERS, { Cookie: `${skToken}=${wpHttp2}` })
              })
                .then(res => res.text())
                .then(html4 => {
                  const $4 = cheerio.load(html4);
                  const metaRefresh = $4('meta[http-equiv="refresh"]').attr('content') || '';
                  const driveUrlMatch = metaRefresh.match(/url=(.+)/);
                  if (!driveUrlMatch) return null;
                  const driveUrl = driveUrlMatch[1];
                  return fetchWithTimeout(driveUrl, { headers: HEADERS })
                    .then(res => res.text())
                    .then(html5 => {
                      const pathMatch = html5.match(/replace\("([^"]+)"\)/);
                      if (!pathMatch || pathMatch[1] === '/404') return null;
                      return fixUrl(pathMatch[1], getBaseUrl(driveUrl));
                    });
                });
            });
        });
    })
    .catch(() => null);
}

// A gateway landing on its own ?url=<real file URL> (video-seed.dev,
// confirmed live) hands back an already-playable link directly. Other
// gateway hosts in the same family instead put an encrypted token in the
// path/query that needs one more POST to that host's own /api to decrypt -
// same fallback uhdmovies.js uses for this identical gateway family.
function extractVideoSeedToken(finalLink) {
  return Promise.resolve()
    .then(() => {
      const urlObj = new URL(finalLink);
      const host = urlObj.host;
      const token = finalLink.includes('url=') ? finalLink.split('url=')[1] : (urlObj.pathname || '').replace(/^\//, '');
      if (!token) return null;
      return fetchWithTimeout(`https://${host}/api`, {
        method: 'POST',
        headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded', 'x-token': host, Referer: finalLink }),
        body: `keys=${encodeURIComponent(token)}`
      })
        .then(res => res.text())
        .then(text => {
          const m = text.match(/url":"([^"]+)"/);
          return m ? m[1].replace(/\\\//g, '/') : null;
        });
    })
    .catch(() => null);
}

function extractDriveseedStream(pageUrl, meta) {
  return fetchWithTimeout(pageUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const sizeText = $('li.list-group-item').eq(2).text().replace(/^Size\s*:/i, '').trim();
      const titleText = $('li.list-group-item').first().text().replace(/^Name\s*:/i, '').trim();
      const instantHref = $('div.text-center > a')
        .filter((_, el) => /instant download/i.test($(el).text()))
        .attr('href');
      if (!instantHref) return null;
      return fetchWithTimeout(instantHref, { headers: HEADERS, redirect: 'follow' })
        .then(res => {
          const landedUrl = res.url || instantHref;
          const afterUrlParam = landedUrl.includes('url=') ? landedUrl.split('url=')[1] : '';
          if (afterUrlParam && afterUrlParam.startsWith('http')) return afterUrlParam;
          return extractVideoSeedToken(landedUrl);
        })
        .then(finalUrl => {
          if (!finalUrl) return null;
          return {
            url: finalUrl,
            title: titleText || meta.title,
            size: getSizeLabel(sizeText) || meta.size,
            quality: meta.quality
          };
        });
    })
    .catch(() => null);
}

function resolveQualityItem(item, referer) {
  return fetchWithTimeout(item.href, { headers: Object.assign({}, HEADERS, { Referer: referer }) })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const fastServerHref = $("a.maxbutton-fast-server-gdrive, a[class*='fast-server-gdrive'], a[class*='maxbutton']:contains(Fast Server)").first().attr('href');
      if (!fastServerHref) return null;
      const resolved = needsBypass(fastServerHref) ? bypassGate(fastServerHref) : Promise.resolve(fastServerHref);
      return resolved.then(driveseedUrl => {
        if (!driveseedUrl) return null;
        return extractDriveseedStream(driveseedUrl, {
          title: item.heading,
          size: getSizeLabel(item.heading),
          quality: getIndexQuality(item.heading)
        });
      });
    })
    .catch(() => null);
}

function resolveSeriesQualityItem(item, referer, episode) {
  return fetchWithTimeout(item.href, { headers: Object.assign({}, HEADERS, { Referer: referer }) })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const episodeRegex = new RegExp(`.*Episode\\s+${episode}\\b.*`, 'i');
      let episodeHref = null;
      $('span strong, p, a').each((_, el) => {
        if (episodeHref) return;
        const $el = $(el);
        if (!episodeRegex.test($el.text().trim())) return;
        if (el.tagName && el.tagName.toLowerCase() === 'a') {
          episodeHref = $el.attr('href');
        } else {
          const parentA = $el.parent().closest('a');
          episodeHref = parentA.length ? parentA.attr('href') : $el.closest('a').attr('href');
        }
      });
      if (!episodeHref) return null;
      const resolved = needsBypass(episodeHref) ? bypassGate(episodeHref) : Promise.resolve(episodeHref);
      return resolved.then(driveseedUrl => {
        if (!driveseedUrl) return null;
        return extractDriveseedStream(driveseedUrl, {
          title: item.heading,
          size: getSizeLabel(item.heading),
          quality: getIndexQuality(item.heading)
        });
      });
    })
    .catch(() => null);
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

// Dead/expired links get filtered out here automatically rather than being
// handed back as "working" streams - a live HEAD/ranged-GET check, plus a
// real #EXTM3U body check for .m3u8 links (status alone isn't reliable),
// matching the approach in cinejoy.js/peachify.js in this repo.
function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return fetchWithTimeout(stream.url, { headers: stream.headers })
      .then(res => {
        if (!res.ok) return false;
        return res.text().then(text => /^#EXTM3U/.test(text.trim()));
      })
      .catch(() => false);
  }
  return fetchWithTimeout(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => fetchWithTimeout(stream.url, { method: 'GET', headers: Object.assign({}, stream.headers, { Range: 'bytes=0-2048' }) })
      .then(res => res.ok || res.status === 206)
      .catch(() => false));
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[TopMovies] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[TopMovies] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)])
    .then(([domain, mediaInfo]) => {
      if (!mediaInfo.title) return [];
      const query = cleanQuery(mediaInfo.title);

      return search(domain, query).then(posts => {
        const match = findBestMatch(posts, mediaInfo, mediaType, season);
        if (!match) {
          console.log(`[TopMovies] No matching title found for "${mediaInfo.title}"`);
          return [];
        }
        console.log(`[TopMovies] Matched: "${match.title}"`);

        return fetchWithTimeout(match.href, { headers: HEADERS }).then(res => res.text()).then(html => {
          const $ = cheerio.load(html);
          const referer = `${domain}/`;

          if (mediaType === 'tv') {
            const items = topItemsByQuality(extractQualityItems($, "a.maxbutton-g-drive, a[class*='maxbutton']:contains(G-Drive)"));
            if (!items.length) {
              console.log('[TopMovies] No G-Drive quality links found on series page');
              return [];
            }
            console.log(`[TopMovies] ${items.length} quality item(s) found, resolving episode ${episode}`);
            return Promise.all(items.map(item => resolveSeriesQualityItem(item, referer, episode)));
          }

          const items = topItemsByQuality(extractQualityItems($, "a.maxbutton-download-links, a[class*='maxbutton']:contains(Download)"));
          if (!items.length) {
            console.log('[TopMovies] No download quality links found on movie page');
            return [];
          }
          console.log(`[TopMovies] ${items.length} quality item(s) found, resolving`);
          return Promise.all(items.map(item => resolveQualityItem(item, referer)));
        });
      });
    })
    .then(results => {
      const streams = (results || []).filter(Boolean).map(r => ({
        name: `TopMovies - ${r.quality}`,
        title: `${r.title}${r.size ? `\n${r.size}` : ''}`,
        url: r.url,
        quality: r.quality,
        headers: HEADERS,
        provider: 'topmovies'
      }));
      if (!streams.length) return [];
      console.log(`[TopMovies] Found ${streams.length} candidate stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
        if (dead.length) console.log(`[TopMovies] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[TopMovies] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    })
    .catch(err => {
      console.log(`[TopMovies] getStreams failed: ${err.message}`);
      return [];
    });
}

module.exports = { getStreams };
