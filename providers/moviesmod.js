// MoviesMod scraper.
//
// Ported from the CloudStream "StreamPlay" plugin's decompiled
// invokeMoviesmod/invokeModflix functions (com.phisher98.StreamPlayExtractor,
// StreamPlay.cs3 build) - that decompile came out badly garbled (JADX
// couldn't fully rebuild the coroutine state machine, lots of "Code
// duplicated" warnings and dead-looking branches), so rather than
// transliterate it, the actual shape below was reconstructed by live-testing
// the real site end-to-end and cross-checking each step against what the
// decompile still made out: quality headings, the "Download"/"Episode"
// anchor in the next sibling, and a final "Moviesmod" extractor hand-off.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["moviesmod"]
//                     (confirmed live 2026-09-28: still the doc's last-known
//                     https://moviesmod.ai.in, no rotation this time)
//   search         -> GET {domain}/search/{title}  - a plain WordPress theme
//                     search page, one <article> per hit under #content_box
//                     .post-cards, title/href in h2.title.front-view-title>a
//   movie page     -> div.thecontent has one h4 heading per quality (e.g.
//                     "Download X Dual Audio 1080p Bluray [3.2GB]"); a
//                     handful of decorative h3/h4 headings also exist and are
//                     excluded by filtering out any heading whose own text
//                     contains "MoviesMod" (confirmed live - matches the
//                     decompile's own exclusion). The heading's next sibling
//                     <p> holds one <a class=maxbutton...> to a
//                     links.modpro.blog / posts.modpro.blog archive page.
//   series page    -> div.thecontent has one h3 heading per (season,
//                     quality) pair (e.g. "Season 1 {Hindi-English} 720p
//                     [370MB]"); next sibling <p> holds TWO links - "Episode
//                     Links" (episodes.modpro.blog, what we want) and
//                     "Batch/Zip File" (a separate archive id, not used here).
//   modpro.blog    -> movie archive page: one <a class=maxbutton> per
//                     resolver ("Fast Server (G-Drive)", "Google Drive
//                     (Server 2)", sometimes a CSS-hidden "G-Direct"/
//                     "OneDrive", sometimes an "Other Download Links" to
//                     urlflix.xyz). CONFIRMED LIVE (2026-09-28) this splits
//                     by which modpro.blog subdomain a given quality's link
//                     uses, independent of how old the post is: quality
//                     groups on links.modpro.blog (the majority - plain
//                     480p/720p/1080p entries) route through
//                     en.thenaukriadda.in, a domain that's been repurposed
//                     into a completely unrelated WordPress job-listings blog
//                     ("The Naukri Adda") - its sid token's own form#landing
//                     auto-submits and lands on that blog's homepage, both
//                     via a raw HTTP replay of the form post and via a real
//                     browser executing the page's JS, so that subdomain is
//                     a dead end today. Quality groups on posts.modpro.blog
//                     (seen for HEVC-labelled entries specifically, but nothing
//                     here assumes that's the only case) route through
//                     cloud.unblockedgames.world instead, which IS confirmed
//                     live working end-to-end. Nothing below hardcodes this
//                     split - it just follows whatever modpro.blog link a
//                     quality heading actually has and lets bypassGateway()
//                     (which only succeeds against the form#landing shape)
//                     and live validation sort out which ones are alive, so
//                     a movie post can validly return some quality groups
//                     and not others, and this keeps working automatically
//                     if MoviesMod's own mix of subdomains shifts again.
//                     "G-Direct" (gdrivepro.xyz) is dead (NXDOMAIN) and
//                     "Other Download Links" (urlflix.xyz) only ever offers
//                     long-defunct anonfiles.com/bayfiles.com links plus a
//                     1fichier/gofile pair that need a paid/captcha flow, so
//                     neither is used here - only the first maxbutton link is
//                     followed per quality group.
//                     episodes.modpro.blog page (series): one
//                     <h3><a>Episode N</a></h3> per episode, each one's href
//                     a cloud.unblockedgames.world sid link - confirmed live
//                     working the same way.
//   unblockedgames.world -> the exact same "bypassHrefli" ad-gate chain
//                     already implemented in uhdmovies.js for the same
//                     domain family (form#landing -> POST -> form#landing ->
//                     POST -> a script's own "?go=" token -> meta-refresh ->
//                     drive URL -> a final JS "replace(...)" redirect).
//                     Confirmed live here too, end to end.
//   driveseed.org  -> the resolved drive URL lands on either
//                     driveseed.org/file/<id> directly, or (confirmed live
//                     for one of several sibling episode links, not a
//                     universal rule) driveseed.org/list/<id> - a season-pack
//                     listing of every episode's own /file/<id> link in
//                     order, matched here by SxxExx filename first and by
//                     list position as a fallback. Either way the /file/<id>
//                     page offers "Cloud Download" (a pub-*.r2.dev direct
//                     link - confirmed live this one now 403s, kept as a
//                     candidate anyway since live validation below drops
//                     whatever's actually dead rather than hard-coding that
//                     assumption) and "Instant Download"/"Instant Download
//                     V2" (a video-gen.xyz-family token gateway). Confirmed
//                     live that following "Instant Download" with a normal
//                     redirect-following fetch lands on video-seed.dev's own
//                     "?url=<real file URL>" - already the final, playable
//                     link, no decrypt needed (this is the same shortcut
//                     uhdmovies.js's own extractVideoSeed comment already
//                     documents for this exact gateway). Confirmed live with
//                     a real HTTP 200, Content-Type: video/mkv, correct
//                     filename and byte size on a googleusercontent.com URL.

const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://moviesmod.ai.in';

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
      const domain = ((data && data.moviesmod) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[MoviesMod] Using domain: ${domain}`);
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
      console.log(`[MoviesMod] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/&#8[0-9]{3};/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Post titles are formatted "Download {Title} (Season N) ..." or
// "Download {Title} (YEAR) ...", occasionally "Download {Title} {Lang} ...".
// Cutting at the first "(", "{" or a bare year/"Season" token isolates just
// the title part, so "The Scandal" doesn't loosely word-overlap-match
// "The Scandal of Chunhwa" the way a simple substring/overlap check would.
function extractCoreTitle(rawTitle) {
  const stripped = String(rawTitle || '').replace(/^download\s+/i, '');
  const m = stripped.match(/^(.*?)(?:\s*[({]|\s+(?:19|20)\d{2}\b|\s+season\b)/i);
  return (m ? m[1] : stripped).trim();
}

function findBestMatch(candidates, mediaInfo) {
  const targetCore = normalize(extractCoreTitle(mediaInfo.title));
  if (!targetCore) return null;

  const exact = candidates.find(c => normalize(extractCoreTitle(c.title)) === targetCore);
  if (exact) return exact;

  // Fall back to word-overlap + year bonus for titles this site formats
  // unusually (e.g. missing a "(...)" delimiter altogether).
  const targetWords = new Set(targetCore.split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    const normTitle = normalize(c.title);
    const postYearMatch = c.title.match(/\b(19|20)\d{2}\b/);
    if (mediaInfo.year && postYearMatch && Math.abs(parseInt(postYearMatch[0], 10) - parseInt(mediaInfo.year, 10)) > 1) continue;
    const words = normalize(extractCoreTitle(c.title)).split(' ').filter(Boolean);
    const overlap = words.filter(w => targetWords.has(w)).length;
    let score = targetWords.size ? overlap / targetWords.size : 0;
    if (mediaInfo.year && normTitle.includes(mediaInfo.year)) score += 0.3;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.6 ? best : null;
}

function search(domain, query) {
  const url = `${domain}/search/${encodeURIComponent(query)}`;
  return fetch(url, { headers: HEADERS })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      const candidates = [];
      $('#content_box article').each((_, el) => {
        const a = $(el).find('h2.title a').first();
        const href = a.attr('href');
        const title = a.text().trim();
        if (href && title) candidates.push({ href, title });
      });
      return candidates;
    })
    .catch(() => []);
}

function extractQuality(str) {
  const m = /(\d{3,4})[pP]/.exec(str || '');
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 2160) return '4K';
    return `${n}p`;
  }
  if (/4K|UHD/i.test(str || '')) return '4K';
  return 'Unknown';
}

function getSizeLabel(str) {
  const m = String(str || '').match(/([\d.]+\s*(?:GB|MB|TB))/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

// Finds each quality (movie) / season+quality (tv) heading in div.thecontent
// and returns, per heading, the modpro.blog gateway href sitting in its next
// sibling <p> - "Download"-labelled for a movie, "Episode Links"-labelled
// (never the sibling "Batch/Zip File" link) for a season's episode index.
function extractHeadingTargets($, mediaType, season) {
  const headingTag = mediaType === 'tv' ? 'h3' : 'h4';
  const seasonRe = mediaType === 'tv' && season ? new RegExp(`(s0*${season}\\b|season\\s*${season}\\b)`, 'i') : null;
  const targets = [];
  $(`div.thecontent ${headingTag}`).each((_, el) => {
    const text = $(el).text().trim();
    if (!text || /moviesmod/i.test(text)) return;
    if (extractQuality(text) === 'Unknown') return;
    if (seasonRe && !seasonRe.test(text)) return;
    let sib = $(el).next();
    let hops = 0;
    while (sib.length && sib.get(0).tagName !== 'p' && hops < 4) { sib = sib.next(); hops++; }
    if (!sib.length) return;
    const link = mediaType === 'tv'
      ? sib.find('a[href*="modpro.blog"]').filter((i, a) => /episode/i.test($(a).text())).first()
      : sib.find('a.maxbutton[href*="modpro.blog"]').first();
    const href = link.attr('href');
    if (href) targets.push({ heading: text, gatewayPageUrl: href, quality: extractQuality(text), size: getSizeLabel(text) });
  });
  return targets;
}

// Movie archive page -> first maxbutton link inside a <p> ("Fast Server
// (G-Drive)" today). Series episode archive page -> the specific numbered
// "Episode N" <h3><a> link (never "Episode 1N" etc - anchored to the exact
// number via \b boundaries).
function extractGatewayLink($, mediaType, episode) {
  if (mediaType === 'tv') {
    const re = new RegExp(`^episode\\s*0*${episode}\\b`, 'i');
    let found = null;
    $('h3 a').each((_, el) => {
      if (found) return;
      if (re.test($(el).text().trim())) found = $(el).attr('href');
    });
    return found;
  }
  return $('p a.maxbutton').first().attr('href') || null;
}

function getBaseUrl(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch (e) { return ''; }
}
function fixUrl(url, domain) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return domain + url;
  return `${domain}/${url}`;
}

// Same ad-gate chain as uhdmovies.js's own bypassHrefli, confirmed live to
// also cover MoviesMod's unblockedgames.world links (see file header).
// Returns null (rather than throwing) for anything that doesn't match the
// expected form#landing shape - e.g. MoviesMod's dead thenaukriadda.in movie
// gateway, which lands on an unrelated blog homepage with no such form.
// The same gateway family also serves a newer three-stage shape (re-verified
// live 2026-10-12; see providers/uhdmovies.js's bypassLpGateway for the full
// walk-through): form#lp-land -> POST -> form#lp-s* hop -> POST -> a script
// carrying `?lp_go=lp-<id>` plus the cookie JS would set for it -> GET with
// that cookie -> `replace("<destination>")`. The client-side countdowns in
// between aren't enforced server-side, and no session cookies are needed.
function bypassLpGateway($1, landingForm, host) {
  const formBody = (form) => {
    const data = {};
    form.find('input').each((_, el) => { data[el.attribs.name] = el.attribs.value || ''; });
    return new URLSearchParams(data).toString();
  };
  const postForm = (action, body) => fetch(action, { method: 'POST', headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }), body });
  return postForm(landingForm.attr('action'), formBody(landingForm))
    .then(res => res.text())
    .then(html2 => {
      const hopForm = cheerio.load(html2)('form[id^="lp-s"]').first();
      if (!hopForm.length) return null;
      return postForm(hopForm.attr('action'), formBody(hopForm))
        .then(res => res.text())
        .then(html3 => {
          const goMatch = html3.match(/\?lp_go=(lp-[a-z0-9]+)/);
          const cookieMatch = html3.match(/sc\("(lp-[a-z0-9]+)","([^"]+)"/);
          if (!goMatch || !cookieMatch) return null;
          return fetch(`${host}?lp_go=${goMatch[1]}`, { headers: Object.assign({}, HEADERS, { Cookie: `${cookieMatch[1]}=${cookieMatch[2].replace(/\\\//g, '/')}` }) })
            .then(res => res.text())
            .then(html4 => {
              const m = html4.match(/replace\("([^"]+)"\)/);
              if (!m) return null;
              // The destination is driveseed's own "/r?key=..." redirector,
              // whose page in turn holds the real /file/ or /list/ path -
              // the same last hop the older flow below already does.
              const driveUrl = m[1].replace(/\\\//g, '/');
              return fetch(driveUrl, { headers: HEADERS })
                .then(res => res.text())
                .then(html5 => {
                  const pathMatch = html5.match(/replace\("([^"]+)"\)/);
                  if (!pathMatch || pathMatch[1] === '/404') return null;
                  return fixUrl(pathMatch[1].replace(/\\\//g, '/'), getBaseUrl(driveUrl));
                });
            });
        });
    });
}

function bypassGateway(url) {
  const host = getBaseUrl(url);
  return fetch(url, { headers: HEADERS })
    .then(res => res.text())
    .then(html1 => {
      const $1 = cheerio.load(html1);
      const lpLanding = $1('form#lp-land');
      if (lpLanding.length) return bypassLpGateway($1, lpLanding, host);
      const formUrl1 = $1('form#landing').attr('action');
      if (!formUrl1) return null;
      const formData1 = {};
      $1('form#landing input').each((_, el) => { formData1[$1(el).attr('name')] = $1(el).attr('value') || ''; });

      return fetch(formUrl1, { method: 'POST', headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }), body: new URLSearchParams(formData1).toString() })
        .then(res => res.text())
        .then(html2 => {
          const $2 = cheerio.load(html2);
          const formUrl2 = $2('form#landing').attr('action');
          if (!formUrl2) return null;
          const formData2 = {};
          $2('form#landing input').each((_, el) => { formData2[$2(el).attr('name')] = $2(el).attr('value') || ''; });

          return fetch(formUrl2, { method: 'POST', headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }), body: new URLSearchParams(formData2).toString() })
            .then(res => res.text())
            .then(html3 => {
              const $3 = cheerio.load(html3);
              const script = $3('script:contains(?go=)').html() || '';
              const skTokenMatch = script.match(/\?go=([^"]+)/);
              if (!skTokenMatch) return null;
              const skToken = skTokenMatch[1];
              const wpHttp2 = formData2['_wp_http2'] || '';

              return fetch(`${host}?go=${skToken}`, { headers: Object.assign({}, HEADERS, { Cookie: `${skToken}=${wpHttp2}` }) })
                .then(res => res.text())
                .then(html4 => {
                  const $4 = cheerio.load(html4);
                  const metaRefresh = $4('meta[http-equiv="refresh"]').attr('content') || '';
                  const driveUrlMatch = metaRefresh.match(/url=(.+)/);
                  if (!driveUrlMatch) return null;
                  const driveUrl = driveUrlMatch[1];

                  return fetch(driveUrl, { headers: HEADERS })
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

// A driveseed "/file/<id>" page's own quality/size are more authoritative
// than the heading text (the heading only states the group's nominal
// quality, the file page states the exact encode).
function extractDriveseedFilePage(fileUrl, fallbackMeta) {
  return fetch(fileUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const items = $('li.list-group-item');
      let name = '';
      let size = fallbackMeta.size;
      items.each((_, el) => {
        const text = $(el).text().trim();
        if (/^name\s*:/i.test(text)) name = text.replace(/^name\s*:\s*/i, '').trim();
        else if (/^size\s*:/i.test(text)) size = text.replace(/^size\s*:\s*/i, '').trim() || size;
      });
      const quality = extractQuality(name) !== 'Unknown' ? extractQuality(name) : fallbackMeta.quality;
      const candidates = [];
      $('.text-center a, div a.btn').each((_, el) => {
        const text = $(el).text().trim();
        const href = $(el).attr('href');
        if (!href) return;
        if (/cloud download/i.test(text)) candidates.push({ source: 'Cloud', url: href });
        else if (/instant download/i.test(text)) candidates.push({ source: /v2/i.test(text) ? 'InstantV2' : 'Instant', url: href });
      });
      return { name: name || fallbackMeta.title, size, quality, candidates };
    })
    .catch(() => null);
}

// "Instant Download" buttons route through a video-gen.xyz-family gateway.
// Confirmed live: a plain redirect-following fetch lands on video-seed.dev's
// own "?url=<real file>" - already final and playable, no decrypt needed.
function resolveInstantDownload(href) {
  return fetch(href, { headers: HEADERS, redirect: 'follow' })
    .then(res => {
      try {
        const landed = new URL(res.url || href);
        const inner = landed.searchParams.get('url');
        if (inner && inner.startsWith('http')) return inner;
      } catch (e) { /* fall through */ }
      return null;
    })
    .catch(() => null);
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

// Status alone isn't reliable here (the r2.dev "Cloud Download" links, for
// one, 403 while still returning a normal-looking error page) - HEAD/ranged
// GET first, and for an .m3u8 confirm the body is a real playlist.
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

function sourceLabel(source) {
  if (source === 'Cloud') return 'Cloud';
  if (source === 'InstantV2') return 'Instant V2';
  return 'Instant';
}

function resolveDriveseedCandidates(filePage, label) {
  return Promise.all(filePage.candidates.map(c => {
    const meta = { name: `MoviesMod - ${filePage.quality}${filePage.size ? ` [${filePage.size}]` : ''}`, provider: 'moviesmod', quality: filePage.quality, headers: HEADERS };
    if (c.source === 'Cloud') {
      return Object.assign({}, meta, { name: `MoviesMod - ${sourceLabel(c.source)}`, title: `${label} - ${filePage.quality}`, url: c.url });
    }
    return resolveInstantDownload(c.url).then(url => url ? Object.assign({}, meta, { name: `MoviesMod - ${sourceLabel(c.source)}`, title: `${label} - ${filePage.quality}`, url }) : null);
  })).then(list => list.filter(Boolean));
}

// The resolved driveseed URL can land on a single file page directly, or
// (confirmed live for one specific episode link, not a fixed rule) a
// "/list/<id>" season-pack page listing every episode's own /file/<id> href
// in order - handled by matching the target SxxExx filename first, falling
// back to plain list position.
function resolveDriveseedUrl(driveUrl, mediaType, season, episode) {
  if (!/\/list\//.test(driveUrl)) return Promise.resolve(driveUrl);
  return fetch(driveUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const origin = getBaseUrl(driveUrl);
      const entries = [];
      $('li.list-group-item a[href^="/file/"]').each((_, el) => {
        entries.push({ text: $(el).text().trim(), href: $(el).attr('href') });
      });
      if (!entries.length) return null;
      if (mediaType === 'tv' && season && episode) {
        const re = new RegExp(`s0*${season}e0*${episode}\\b`, 'i');
        const match = entries.find(e => re.test(e.text));
        if (match) return origin + match.href;
        if (entries[episode - 1]) return origin + entries[episode - 1].href;
      }
      return origin + entries[0].href;
    })
    .catch(() => null);
}

function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType === 'tv' ? 'tv' : 'movie';
  console.log(`[MoviesMod] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[MoviesMod] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ` (${mediaInfo.year})` : ''}`;

    return search(domain, mediaInfo.title).then(candidates => {
      const match = findBestMatch(candidates, mediaInfo);
      if (!match) {
        console.log(`[MoviesMod] No matching title found for "${mediaInfo.title}"`);
        return [];
      }
      console.log(`[MoviesMod] Matched: "${match.title}"`);

      return fetch(match.href, { headers: HEADERS })
        .then(res => res.text())
        .then(html => {
          const $ = cheerio.load(html);
          const targets = extractHeadingTargets($, mediaType, season);
          if (!targets.length) {
            console.log('[MoviesMod] No matching quality/season heading found on page');
            return [];
          }
          console.log(`[MoviesMod] ${targets.length} quality group(s) found`);

          return Promise.all(targets.map(target =>
            fetch(target.gatewayPageUrl, { headers: Object.assign({}, HEADERS, { Referer: match.href }) })
              .then(res => res.text())
              .then(gatewayHtml => {
                const $$ = cheerio.load(gatewayHtml);
                const gatewayLink = extractGatewayLink($$, mediaType, episode);
                if (!gatewayLink) return [];
                return bypassGateway(gatewayLink).then(driveUrl => {
                  if (!driveUrl) return [];
                  return resolveDriveseedUrl(driveUrl, mediaType, season, episode).then(fileUrl => {
                    if (!fileUrl) return [];
                    return extractDriveseedFilePage(fileUrl, target).then(filePage => {
                      if (!filePage || !filePage.candidates.length) return [];
                      return resolveDriveseedCandidates(filePage, label);
                    });
                  });
                });
              })
              .catch(() => [])
          )).then(perGroup => perGroup.flat());
        });
    }).then(streams => {
      if (!streams.length) return streams;
      console.log(`[MoviesMod] Found ${streams.length} candidate stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
        if (dead.length) console.log(`[MoviesMod] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[MoviesMod] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    });
  }).catch(err => {
    console.log(`[MoviesMod] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
