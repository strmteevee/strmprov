// FullRaces (fullraces.com) race-replay scraper.
//
// NOT a TMDB-based provider - like providers/indycar.js and providers/f1.js,
// this has no tmdbId/mediaType/season/episode interface, since race replays
// have no TMDB entries. Used directly by addon-server.js's dedicated
// "FullRaces" catalog, not through lib/aggregate.js, and intentionally left
// out of manifest.json's scrapers list for the same reason - which also means
// this file only ever runs server-side in plain Node (never distributed as a
// standalone Nuvio local-scraper plugin), so setTimeout is safe to use here
// unlike providers/ files that do ship that way.
//
// Ported from the open-source CloudStream extension "FullRaces"
// (github.com/Kraptor123/Cs-Karma, com.kerimmkirac package) at the user's
// pointer that it works - same category/site structure confirmed live
// 2026-09-22, re-implemented fresh in JS rather than translated line-by-line.
//
// Site structure (Ucoz CMS): each category page (e.g. /f1-race-replays,
// /nascar, /2026) lists `div.short_item` cards - title+link in
// `div.short_content h3 a`, poster in `div.poster img`. A video's own detail
// page embeds its actual playable mirrors two ways, both confirmed live on
// real pages: `nav.gp-bar a.gp-src` (labelled via a nested <b>) and
// `a.su-button` (labelled by its own link text) - collected and deduped by
// href regardless of which of the two carried it. The mirrors themselves are
// a mix of ok.ru, Dailymotion, and various whitelabel "filemoon-family"
// domains (vidara.to, bysesukior.com, ... - the underlying embed page/JS
// shape is the same regardless of the specific domain currently in use, so
// unrecognized hosts fall back to a generic packed-JS/m3u8 extraction attempt
// rather than a hardcoded domain list that would go stale the moment the site
// rotates mirrors again).

const cheerio = require('cheerio-without-node-native');

const BASE_URL = 'https://fullraces.com';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Mirrors the site's own category list (confirmed live) - only page 1 of
// each is crawled, not deeper pagination, which is enough to surface recent
// races without a much larger request budget; a category's older races are
// still reachable individually via search if ever needed later.
const CATEGORIES = [
    { path: '/f1-race-replays', name: 'All F1 Races' },
    { path: '/2026', name: 'Formula 1 2026' },
    { path: '/2025', name: 'Formula 1 2025' },
    { path: '/f1-2023', name: 'Formula 1 2023' },
    { path: '/formula1-2022', name: 'Formula 1 2022' },
    { path: '/formula1-2021', name: 'Formula 1 2021' },
    { path: '/f1-2020', name: 'Formula 1 2020' },
    { path: '/f1-2019', name: 'Formula 1 2019' },
    { path: '/f1-archive-races', name: 'F1 Archive Races 2000-2018' },
    { path: '/f2-full-races', name: 'F2 Races' },
    { path: '/f3-full-races', name: 'F3 Races' },
    { path: '/nascar', name: 'Nascar Races' },
    { path: '/indycar', name: 'Indycar Races' },
    { path: '/formula-e', name: 'Formula E Races' },
    { path: '/other', name: 'Others' }
];

const CACHE_TTL_MS = 1000 * 60 * 60;

function fetchHtml(path) {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    return fetch(url, { headers: HEADERS }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.text();
    });
}

// Same "a couple of retries survives a transient failure" reasoning as
// indycar.js's own fetchHtmlWithRetries - crawling 15 category pages
// concurrently can have one or two fail transiently without the whole crawl
// needing to be treated as broken.
function fetchHtmlWithRetries(path, attemptsLeft = 2) {
    return fetchHtml(path).catch((err) => {
        if (attemptsLeft <= 0) throw err;
        return new Promise((resolve) => setTimeout(resolve, 1000))
            .then(() => fetchHtmlWithRetries(path, attemptsLeft - 1));
    });
}

// The listing description's own leading date ("September 13, 2026 - RACE -
// ...") is the only real date signal available on the category page itself -
// used purely for newest-first sorting, same purpose dateFromPath serves in
// indycar.js.
function parseDate(text) {
    const m = (text || '').match(/([A-Z][a-z]+ \d{1,2},\s*\d{4})/);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return Number.isNaN(t) ? null : t;
}

function extractListingCards(html, categoryName) {
    const $ = cheerio.load(html);
    const videos = [];
    $('div.short_item').each((i, el) => {
        const anchor = $(el).find('div.short_content h3 a').first();
        const title = anchor.text().trim();
        const href = anchor.attr('href');
        if (!title || !href) return;
        const path = href.startsWith('http') ? new URL(href).pathname : href;
        const id = `fullraces:${path.replace(/^\//, '')}`;
        const posterSrc = $(el).find('div.poster img').attr('src') || '';
        const description = $(el).find('div.short_descr').text().trim();
        videos.push({
            id,
            path,
            title,
            category: categoryName,
            poster: posterSrc ? (posterSrc.startsWith('http') ? posterSrc : `${BASE_URL}${posterSrc}`) : undefined,
            description,
            timestamp: parseDate(description)
        });
    });
    return videos;
}

function crawlAllVideos() {
    return Promise.all(CATEGORIES.map(({ path, name }) =>
        fetchHtmlWithRetries(path).then((html) => extractListingCards(html, name)).catch((err) => {
            console.error(`[FullRaces] Failed to fetch category ${path} after retries: ${err.message}`);
            return null;
        })
    )).then((lists) => {
        const failedCount = lists.filter((l) => l === null).length;
        if (failedCount > 0) {
            console.warn(`[FullRaces] ${failedCount}/${lists.length} category page(s) failed to fetch this crawl`);
        }
        const seen = new Set();
        const all = [];
        for (const video of lists.filter(Boolean).flat()) {
            if (seen.has(video.id)) continue;
            seen.add(video.id);
            all.push(video);
        }
        all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return { videos: all, failedCount, totalPages: lists.length };
    });
}

let cache = { videos: null, timestamp: 0 };
let inFlightColdStart = null;

// Same stale-while-revalidate shape as indycar.js/f1.js's own caches - a
// 15-page crawl is cheap enough not to need it for correctness, but it still
// means the catalog opens instantly on every request after the first,
// instead of occasionally paying the full crawl's latency when the 1-hour
// cache happens to have just expired.
function isTrustworthy(failedCount, totalPages) {
    return failedCount <= totalPages / 2;
}

function getAllVideos() {
    const now = Date.now();
    if (cache.videos && now - cache.timestamp < CACHE_TTL_MS) {
        return Promise.resolve(cache.videos);
    }
    if (cache.videos) {
        crawlAllVideos().then(({ videos, failedCount, totalPages }) => {
            if (!isTrustworthy(failedCount, totalPages)) {
                console.warn(`[FullRaces] Background refresh too incomplete (${failedCount}/${totalPages} pages failed) - keeping the previous cache instead of replacing it`);
                return;
            }
            cache = { videos, timestamp: Date.now() };
            console.log(`[FullRaces] Refreshed ${videos.length} race(s) in the background`);
        }).catch((err) => console.error(`[FullRaces] Background refresh failed: ${err.message}`));
        return Promise.resolve(cache.videos);
    }
    if (!inFlightColdStart) {
        inFlightColdStart = crawlAllVideos().then(({ videos, failedCount, totalPages }) => {
            inFlightColdStart = null;
            if (failedCount > 0) {
                console.warn(`[FullRaces] Initial crawl was incomplete (${failedCount}/${totalPages} pages failed) - caching what was found anyway since there's no earlier result to fall back on`);
            }
            cache = { videos, timestamp: now };
            console.log(`[FullRaces] Crawled ${videos.length} race(s)`);
            return videos;
        }).catch((err) => {
            inFlightColdStart = null;
            console.error(`[FullRaces] Crawl failed: ${err.message}`);
            return cache.videos || [];
        });
    }
    return inFlightColdStart;
}

function listVideos() {
    return getAllVideos();
}

function getVideo(id) {
    return getAllVideos().then((videos) => videos.find((v) => v.id === id) || null);
}

// ---- Per-mirror stream extraction ----
//
// The generic packer format ("eval(function(p,a,c,k,e,d){...}(...))") used by
// the site's various whitelabel filemoon-family mirrors - a widely
// reimplemented, publicly documented deobfuscation algorithm (Dean Edwards'
// "packer"), not specific to any one of them.
function unpack(packed) {
    const dq = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\).*?return\s+p\s*}\s*\(\s*"(.*?)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"(.*?)"\s*\.split\("\|"\)/s;
    const sq = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\).*?return\s+p\s*}\s*\(\s*'(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*?)'\s*\.split\('\|'\)/s;
    const match = packed.match(dq) || packed.match(sq);
    if (!match) return null;
    let p = match[1];
    const a = parseInt(match[2], 10);
    let c = parseInt(match[3], 10);
    const k = match[4].split('|');
    function e(c2) {
        return (c2 < a ? '' : e(Math.floor(c2 / a))) + (c2 % a > 35 ? String.fromCharCode((c2 % a) + 29) : (c2 % a).toString(36));
    }
    while (c--) {
        if (k[c]) p = p.replace(new RegExp(`\\b${e(c)}\\b`, 'g'), k[c]);
    }
    return p;
}

function isM3u8Url(url) {
    return /\.m3u8(\?|$)/i.test(url);
}
function firstManifestRef(text, baseUrl) {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length === 0) return null;
    try {
        return new URL(lines[0], baseUrl).toString();
    } catch (e) {
        return null;
    }
}
function rangedValidateUrl(url, headers) {
    return fetch(url, { method: 'GET', headers: Object.assign({}, headers, { Range: 'bytes=0-2048' }) })
        .then((res) => res.ok || res.status === 206)
        .catch(() => false);
}
// A plain HEAD/GET on the manifest alone isn't reliable (seen repeatedly
// elsewhere in this repo - the manifest route can stay up even when the
// segments behind it are dead), so walk down to a real segment reference.
function validateM3u8Chain(url, headers, hopsLeft) {
    return fetch(url, { headers })
        .then((res) => {
            if (!res.ok) return false;
            return res.text().then((text) => {
                const next = firstManifestRef(text, url);
                if (!next) return true;
                if (isM3u8Url(next) && hopsLeft > 0) return validateM3u8Chain(next, headers, hopsLeft - 1);
                return rangedValidateUrl(next, headers);
            });
        })
        .catch(() => false);
}

// OK.ru: the embed page's `data-options` attribute (or, when jsdom-style
// attribute parsing misses it, a raw regex over the response body) carries a
// `"videos":[{"name":"hd","url":"..."}, ...]` array - a publicly documented
// technique (the same shape yt-dlp and many other open tools already use for
// ok.ru), not anything proprietary to this site.
const OKRU_QUALITY_RANK = { full: 5, hd: 4, sd: 3, low: 2, lowest: 1, mobile: 0 };
function extractOkRu(url) {
    const idMatch = url.match(/(?:videoembed|video)\/(\d+)/);
    if (!idMatch) return Promise.resolve([]);
    const embedUrl = `https://ok.ru/videoembed/${idMatch[1]}`;
    return fetch(embedUrl, {
        headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    }).then((res) => res.text()).then((html) => {
        const optsMatch = html.match(/data-options="([^"]+)"/);
        if (!optsMatch) return [];
        const dataOptions = optsMatch[1].replace(/&quot;/g, '"');
        const originalUrlMatch = dataOptions.match(/"originalUrl":"([^"]+)"/);
        const originalUrl = originalUrlMatch ? originalUrlMatch[1].replace(/\\\//g, '/') : null;
        if (originalUrl && (originalUrl.includes('youtube.com') || originalUrl.includes('youtu.be'))) {
            return []; // not worth chasing a YouTube redirect for a fallback mirror
        }
        const videosJsonMatch = dataOptions.match(/"videos":(\[.*?\])/);
        if (!videosJsonMatch) return [];
        const pairs = [...videosJsonMatch[1].matchAll(/\{"name":"([^"]+)","url":"([^"]+)"/g)];
        const okruHeaders = { Referer: 'https://ok.ru/', Origin: 'https://ok.ru', 'User-Agent': HEADERS['User-Agent'] };
        return pairs
            .map(([, name, rawUrl]) => ({
                name,
                url: rawUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
            }))
            .filter((v) => !v.url.includes('youtube.com') && !v.url.includes('youtu.be'))
            .sort((a, b) => (OKRU_QUALITY_RANK[b.name.toLowerCase()] || 0) - (OKRU_QUALITY_RANK[a.name.toLowerCase()] || 0))
            .map((v) => ({
                name: `FullRaces - OK.ru (${v.name})`,
                url: v.url,
                quality: v.name,
                headers: okruHeaders
            }));
    }).catch((err) => {
        console.log(`[FullRaces] OK.ru extraction failed: ${err.message}`);
        return [];
    });
}

// Dailymotion: the player's own public metadata endpoint (no auth, used the
// same way by yt-dlp and other open tools) hands back an HLS master playlist
// under qualities.auto - one adaptive URL is enough, the manifest itself
// carries every actual resolution.
function extractDailymotion(url) {
    const idMatch = url.match(/video[=/]([a-zA-Z0-9]+)/);
    if (!idMatch) return Promise.resolve([]);
    const videoId = idMatch[1];
    return fetch(`https://www.dailymotion.com/player/metadata/video/${videoId}`, { headers: HEADERS })
        .then((res) => res.json())
        .then((data) => {
            const auto = data && data.qualities && data.qualities.auto;
            const hlsUrl = Array.isArray(auto) && auto[0] && auto[0].url;
            if (!hlsUrl) return [];
            return [{
                name: 'FullRaces - Dailymotion',
                url: hlsUrl,
                quality: 'Auto (HLS)',
                headers: { Referer: 'https://www.dailymotion.com/', 'User-Agent': HEADERS['User-Agent'] }
            }];
        }).catch((err) => {
            console.log(`[FullRaces] Dailymotion extraction failed for ${videoId}: ${err.message}`);
            return [];
        });
}

// Generic fallback for the site's various whitelabel filemoon-family mirrors
// (vidara.to, bysesukior.com, ...) - the domain rotates, the underlying
// packed-JS embed shape doesn't, so this looks for that shape rather than
// matching specific hostnames.
function extractGeneric(url, label) {
    return fetch(url, { headers: { Referer: url, 'User-Agent': HEADERS['User-Agent'] } })
        .then((res) => res.text())
        .then((html) => {
            const unpacked = unpack(html) || html;
            const m = unpacked.match(/file:\s*["'](.*?\.m3u8[^"']*)["']/) || unpacked.match(/sources:\s*\[\s*{\s*file:\s*["'](.*?)["']/);
            if (!m) return [];
            return [{
                name: `FullRaces - ${label}`,
                url: m[1],
                quality: 'Unknown',
                headers: { Referer: url, 'User-Agent': HEADERS['User-Agent'] }
            }];
        }).catch((err) => {
            console.log(`[FullRaces] Generic mirror extraction failed for ${url}: ${err.message}`);
            return [];
        });
}

function extractMirror(url, label) {
    if (url.includes('ok.ru') || url.includes('odnoklassniki.ru')) return extractOkRu(url);
    if (url.includes('dailymotion.com')) return extractDailymotion(url);
    return extractGeneric(url, label);
}

function validateStream(stream) {
    if (isM3u8Url(stream.url)) return validateM3u8Chain(stream.url, stream.headers, 2);
    return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
        .then((res) => res.ok || res.status === 206)
        .catch(() => rangedValidateUrl(stream.url, stream.headers));
}

// Collects every mirror link a video's detail page advertises (both the
// nav-bar and button layouts the site uses interchangeably - confirmed live
// a given page can carry either or both), deduped by href since the same
// mirror sometimes appears in both places.
function extractMirrorLinks(html) {
    const $ = cheerio.load(html);
    const seen = new Set();
    const mirrors = [];
    $('nav.gp-bar a.gp-src').each((i, el) => {
        const href = $(el).attr('href');
        if (!href || seen.has(href)) return;
        seen.add(href);
        const label = $(el).find('b').text().trim() || 'Mirror';
        mirrors.push({ href: href.startsWith('http') ? href : `https:${href}`, label });
    });
    $('a.su-button').each((i, el) => {
        const href = $(el).attr('href');
        if (!href || seen.has(href)) return;
        seen.add(href);
        const text = $(el).text().trim();
        mirrors.push({ href: href.startsWith('http') ? href : `https:${href}`, label: /^watch$/i.test(text) ? 'Mirror' : (text || 'Mirror') });
    });
    return mirrors;
}

function getVideoStreams(path) {
    return fetchHtml(path).then((html) => {
        const mirrors = extractMirrorLinks(html);
        return Promise.all(mirrors.map((m) => extractMirror(m.href, m.label))).then((lists) => {
            const streams = lists.flat();
            return Promise.all(streams.map((s) => validateStream(s).then((ok) => ({ stream: s, ok })))).then((validated) => {
                const valid = validated.filter((v) => v.ok).map((v) => v.stream);
                const dead = validated.filter((v) => !v.ok).map((v) => v.stream.name);
                if (dead.length) console.log(`[FullRaces] Dropping unreachable: ${dead.join(', ')}`);
                return valid;
            });
        });
    }).catch((err) => {
        console.error(`[FullRaces] Failed to resolve streams for ${path}: ${err.message}`);
        return [];
    });
}

module.exports = { listVideos, getVideo, getVideoStreams };
