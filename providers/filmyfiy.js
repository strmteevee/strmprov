// Filmyfiy scraper.
//
// Ported from the CloudStream "StreamPlay" plugin's invokeFilmyfiy (decompiled
// from com.phisher98.StreamPlayExtractor, StreamPlay.cs3 build), then
// re-verified live end-to-end against the real site rather than trusted
// as-is - the plugin's own scraping logic drifts from the live site over
// time (confirmed twice already this session for two other sources in that
// same plugin).
//
// Confirmed live (2026-09-28):
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json
//                      ["filmyfiy"] - the site itself rebranded away from the
//                      "filmyfiy" name (its own <meta name="generator"> and
//                      page titles now say "FilmyFly"), only the JSON key
//                      still uses the old plugin name.
//   search         -> the decompiled Kotlin's GET
//                      "{domain}/site-1.html?to-search={query}" no longer
//                      does a search at all - confirmed live it returns the
//                      exact same fixed article regardless of the query
//                      string. The site's real search (visible from its own
//                      <form method="post"> on every page) is a plain DLE
//                      (DataLife Engine) search: POST {domain}/index.php?do=search
//                      with do=search&subaction=search&story={query}.
//   search results -> one `div.A10` per hit (NOT the decompiled code's
//                     `div.A2 > a:nth-child(2)` - that selector matches
//                     nothing live, and a previous partial attempt's
//                     from-scratch re-check of it was also stale, confirmed
//                     by re-deriving the real markup here). Each `div.A10`
//                     holds `a.row-thumb-link[href]` (the movie page link)
//                     and a `.row-title` div with the full title text.
//   movie page     -> `div.dlbtn a[href]` matches the decompiled code as-is:
//                      one "go_link" redirector link (a Cloudflare 302 to a
//                      linkmake.in "Link Protector" interstitial).
//   go_link page   -> `div.dlink a[href]` also matches the decompiled code
//                      as-is: one link per quality, each a
//                      `filesdl.in/cloud/<id>` short link.
//   filesdl link   -> redirects to a filesdl.top/.in "cloud" page offering
//                      several parallel options. Two were confirmed live to
//                      be immediately usable without any browser/JS step:
//                        - "Direct Download (10Gbps)" (fffast.filesdl.in/
//                          zdownload.php?...&token=...) - the token is baked
//                          into the server-rendered HTML already (only the
//                          page's OTHER "Cloud Direct" button gets a fresh
//                          token injected by client-side JS - that one 403s
//                          without it and is skipped here); this one 302s
//                          straight to a video-downloads.googleusercontent.com
//                          link. Confirmed live: a real 200 with
//                          Content-Type: video/mkv and a Content-Length
//                          matching the page's own stated file size.
//                        - "Download - HubCloud" (hubcloud.*) - resolved via
//                          this repo's shared lib/hubcloudExtract.js rather
//                          than reimplementing that logic a third time.
//                          Confirmed live: its FSL (r2.cloudflarestorage.com)
//                          option answers a ranged GET with a real 206
//                          (though, like other HubCloud FSL links elsewhere
//                          in this repo, it 403s on a plain HEAD - the
//                          signed URL only permits the method it was signed
//                          for, which is why validation below falls back to
//                          a ranged GET rather than trusting HEAD alone).
//                      A "Login To Download - GDFLIX" option also appears
//                      but requires an account, so it's skipped; likewise
//                      GoFile.io, a Telegram bot link, and a "Buzz Download"
//                      (fuckingfast.net) option are left unused to keep the
//                      per-title request count bounded.
//
// Per the CloudStream plugin's own listing, this source is movies-only (its
// invokeFilmyfiy only ever takes a plain title, no season/episode), so TV
// requests short-circuit immediately below.

const cheerio = require('cheerio');
const { extractHubCloud } = require('../lib/hubcloudExtract');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://filmyhok.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
    if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
    return fetch(DOMAINS_URL, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => {
            const domain = ((data && data.filmyfiy) || DEFAULT_DOMAIN).replace(/\/+$/, '');
            cachedDomain = domain;
            cachedDomainAt = Date.now();
            console.log(`[Filmyfiy] Using domain: ${domain}`);
            return domain;
        })
        .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => {
            const title = mediaType === 'tv' ? data.name : data.title;
            const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
            console.log(`[Filmyfiy] TMDB Info: "${title}" (${year})`);
            return { title, year };
        })
        .catch(() => ({ title: null, year: '' }));
}

function normalize(str) {
    return String(str || '').toLowerCase().replace(/&#8[0-9]{3};/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function search(domain, query) {
    const body = new URLSearchParams({ do: 'search', subaction: 'search', story: query }).toString();
    return fetch(`${domain}/index.php?do=search`, {
        method: 'POST',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': `${domain}/`
        },
        body
    })
        .then(res => (res.ok ? res.text() : ''))
        .catch(() => '');
}

function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const results = [];
    $('div.A10').each((_, el) => {
        const href = $(el).find('a.row-thumb-link').attr('href');
        const title = $(el).find('.row-title').text().trim();
        if (href && title) results.push({ href, title });
    });
    return results;
}

// The year a post's title states: one in brackets, else the last plain 19xx/20xx in it; null when none.
function titleYear(title) {
    const bracketed = /[(\[]((?:19|20)\d{2})[)\]]/.exec(title || '');
    if (bracketed) return parseInt(bracketed[1], 10);
    const all = (title || '').match(/\b(?:19|20)\d{2}\b/g);
    return all ? parseInt(all[all.length - 1], 10) : null;
}

function findBestMatch(results, mediaInfo) {
    const targetTitle = normalize(mediaInfo.title);
    if (!targetTitle) return null;
    const wantYear = parseInt(mediaInfo.year, 10);
    const titled = results.filter(r => normalize(r.title).startsWith(targetTitle));
    if (!wantYear) return titled[0] || null;
    // A remake shares the title (The Lion King 1994 / 2019): the post with the requested year
    // (+-1) first; one stating a clearly different year is another film and never taken.
    const yearOff = (r) => { const y = titleYear(r.title); return y == null ? null : Math.abs(y - wantYear); };
    return titled.find(r => yearOff(r) != null && yearOff(r) <= 1)
        || titled.find(r => yearOff(r) == null)
        || null;
}

function extractQuality(str) {
    const m = /(\d{3,4})[pP]/.exec(str || '');
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

function heightFromQuality(quality) {
    if (quality === '4K') return 2160;
    const m = /^(\d{3,4})p$/.exec(quality || '');
    return m ? parseInt(m[1], 10) : 0;
}

function extractGoLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const hrefs = [];
    $('div.dlbtn a[href]').each((_, el) => {
        let href = $(el).attr('href');
        if (!href) return;
        if (!/^https?:\/\//i.test(href)) {
            try { href = new URL(href, baseUrl).toString(); } catch (e) { return; }
        }
        hrefs.push(href);
    });
    return Array.from(new Set(hrefs));
}

function extractDlinks(html) {
    const $ = cheerio.load(html);
    const items = [];
    $('div.dlink a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const label = $(el).text().replace(/\s+/g, ' ').trim();
        if (href) items.push({ url: href, label });
    });
    return items;
}

// Each MAX_DLINKS quality tier costs its own filesdl.top fetch plus (when it
// has a HubCloud option) two more hops through extractHubCloud - capped the
// same way hindmoviez.js caps its own quality groups, to keep total latency
// for a single getStreams call bounded.
const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
const MAX_DLINKS = 3;

function resolveFilesdlPage(dlink, fallbackTitle) {
    return fetch(dlink.url, { headers: { 'User-Agent': USER_AGENT, Referer: dlink.url } })
        .then(res => res.text())
        .then(html => {
            const $ = cheerio.load(html);
            const pageTitle = $('.title').first().text().trim() || fallbackTitle;
            const labelQuality = extractQuality(dlink.label);
            const quality = labelQuality !== 'Unknown' ? labelQuality : extractQuality(pageTitle);
            const height = heightFromQuality(quality);

            let directHref = null;
            $('a.button').each((_, el) => {
                if (directHref) return;
                if (/direct download/i.test($(el).text())) directHref = $(el).attr('href');
            });

            const streams = [];
            if (directHref) {
                streams.push({
                    name: `Filmyfiy - Direct${quality !== 'Unknown' ? ` ${quality}` : ''}`,
                    title: pageTitle,
                    url: directHref,
                    quality,
                    headers: { 'User-Agent': USER_AGENT },
                    subtitles: [],
                    provider: 'filmyfiy'
                });
            }

            let hubCloudHref = null;
            $('a[href]').each((_, el) => {
                if (hubCloudHref) return;
                const href = $(el).attr('href') || '';
                if (href.includes('hubcloud.')) hubCloudHref = href;
            });

            const hubCloudPromise = hubCloudHref
                ? extractHubCloud(
                    hubCloudHref,
                    { title: pageTitle, height, bytes: 0 },
                    { userAgent: USER_AGENT, log: msg => console.log(`[Filmyfiy] ${msg}`) }
                ).then(results => results.map(r => ({
                    name: `Filmyfiy - ${r.source}${height ? ` ${height}p` : ''}`,
                    title: r.meta.title || pageTitle,
                    url: r.url,
                    quality,
                    headers: { 'User-Agent': USER_AGENT },
                    subtitles: [],
                    provider: 'filmyfiy'
                }))).catch(() => [])
                : Promise.resolve([]);

            return hubCloudPromise.then(hubStreams => streams.concat(hubStreams));
        })
        .catch(err => {
            console.log(`[Filmyfiy] Failed to resolve ${dlink.url}: ${err.message}`);
            return [];
        });
}

// Direct file links get a cheap HEAD; a HubCloud FSL (r2.cloudflarestorage.com)
// link is confirmed live to 403 on HEAD even though it 206s a ranged GET
// (the pre-signed URL only permits the method it was signed for), so a
// failed HEAD falls back to a ranged GET rather than being trusted as dead -
// same approach as providers/cinejoy.js and providers/peachify.js.
function isM3u8Url(url) {
    return /\.m3u8(\?|$)/i.test(url);
}

function rangedValidateUrl(url, headers) {
    const rangedHeaders = Object.assign({}, headers, { Range: 'bytes=0-2048' });
    return fetch(url, { method: 'GET', headers: rangedHeaders })
        .then(res => res.ok || res.status === 206)
        .catch(() => false);
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
        .then(res => (res.ok || res.status === 206 ? true : rangedValidateUrl(stream.url, stream.headers)))
        .catch(() => rangedValidateUrl(stream.url, stream.headers));
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Filmyfiy] getStreams start tmdbId=${tmdbId} type=${mediaType}`);

    if (mediaType === 'tv') {
        console.log('[Filmyfiy] Movies only, skipping TV');
        return Promise.resolve([]);
    }

    return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)])
        .then(([domain, mediaInfo]) => {
            if (!mediaInfo.title) return [];
            return search(domain, mediaInfo.title).then(html => {
                if (!html) return [];
                const results = parseSearchResults(html);
                const match = findBestMatch(results, mediaInfo);
                if (!match) {
                    console.log(`[Filmyfiy] No matching title found for "${mediaInfo.title}"`);
                    return [];
                }
                console.log(`[Filmyfiy] Matched: "${match.title}"`);

                return fetch(match.href, { headers: { 'User-Agent': USER_AGENT } })
                    .then(res => res.text())
                    .then(movieHtml => {
                        const goLinks = extractGoLinks(movieHtml, domain);
                        if (!goLinks.length) {
                            console.log('[Filmyfiy] No download button found on movie page');
                            return [];
                        }
                        return Promise.all(goLinks.map(goLink =>
                            fetch(goLink, { headers: { 'User-Agent': USER_AGENT, Referer: match.href } })
                                .then(res => res.text())
                                .then(extractDlinks)
                                .catch(() => [])
                        )).then(perLink => {
                            let dlinks = perLink.flat().filter(d => d.url);
                            const seen = new Set();
                            dlinks = dlinks.filter(d => {
                                if (seen.has(d.url)) return false;
                                seen.add(d.url);
                                return true;
                            });
                            dlinks.sort((a, b) => (QUALITY_RANK[extractQuality(b.label)] || 0) - (QUALITY_RANK[extractQuality(a.label)] || 0));
                            dlinks = dlinks.slice(0, MAX_DLINKS);
                            console.log(`[Filmyfiy] Resolving ${dlinks.length} quality link(s)`);
                            return Promise.all(dlinks.map(d => resolveFilesdlPage(d, match.title))).then(r => r.flat());
                        });
                    });
            });
        })
        .then(streams => {
            console.log(`[Filmyfiy] Found ${streams.length} candidate stream(s), validating...`);
            return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
                const valid = validated.filter(v => v.ok).map(v => v.stream);
                const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
                if (dead.length) console.log(`[Filmyfiy] Dropping unreachable: ${dead.join(', ')}`);
                console.log(`[Filmyfiy] ${valid.length}/${streams.length} stream(s) validated OK`);
                return valid;
            });
        })
        .catch(err => {
            console.log(`[Filmyfiy] getStreams failed: ${err.message}`);
            return [];
        });
}

module.exports = { getStreams };
