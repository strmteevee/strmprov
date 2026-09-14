// IndyCar highlight-video scraper for https://www.indycar.com/Videos.
//
// This is NOT a TMDB-based provider like everything else in providers/ - it
// has no tmdbId/mediaType/season/episode interface at all, because IndyCar
// race-weekend videos have no TMDB entries to begin with. It's used directly
// by addon-server.js's dedicated "IndyCar Videos" catalog rather than going
// through lib/aggregate.js's multi-provider pipeline, and is intentionally
// left out of manifest.json's scrapers list for the same reason.
//
// Site structure, confirmed live: indycar.com/Videos itself is just a
// recent-activity feed - it never surfaces "Full Race" or "Extended Race
// Highlights" videos at all, since those aren't given homepage placement.
// Each individual race weekend's own /Schedule/<year>/<track> page, though,
// lists every video published for that weekend, all four categories
// included. Crawling the season's race weekends from /Schedule and then each
// one's own page is the only way found to reach the full set.
//
// Playback itself needs no scraping trickery: every video page embeds a JW
// Player iframe (cdn.jwplayer.com/players/<mediaId>-<playerId>.html), and JW
// Player's own public delivery API (cdn.jwplayer.com/v2/media/<mediaId>,
// no key/auth needed) hands back direct HLS + progressive MP4 sources at
// several resolutions.

const cheerio = require('cheerio-without-node-native');

const BASE_URL = 'https://www.indycar.com';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};
// The season schedule and its videos change at most a few times a day even
// during a race weekend - crawling ~18 race-weekend pages on every catalog
// request would be both slow and needless load on indycar.com.
const CACHE_TTL_MS = 1000 * 60 * 60;

// Checked in this order deliberately: "Extended Race Highlights" contains
// "race highlights" as a literal substring ("Extended RACE HIGHLIGHTS: ..."),
// so it must be matched before the plain "Race Highlights" category or every
// extended-highlights video would also get bucketed as a regular one.
const CATEGORY_MATCHERS = [
    { name: 'Qualifying Highlights', test: (t) => t.includes('qualifying highlights') },
    { name: 'Extended Race Highlights', test: (t) => t.includes('extended race highlights') || t.includes('extended highlights') },
    { name: 'Full Race Replay', test: (t) => t.includes('full race') },
    { name: 'Race Highlights', test: (t) => t.includes('race highlights') }
];
const CATEGORIES = CATEGORY_MATCHERS.map((c) => c.name);

function classify(title) {
    const t = title.toLowerCase();
    for (const cat of CATEGORY_MATCHERS) {
        if (cat.test(t)) return cat.name;
    }
    return null;
}

function fetchHtml(path) {
    return fetch(`${BASE_URL}${path}`, { headers: HEADERS }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
        return res.text();
    });
}

// Confirmed live: crawling 18 race-weekend pages concurrently can have some
// of them fail transiently (a specific network's DNS/timeouts/rate-limiting
// - reproduced on one deployment where most of the 18 failed, and the
// resulting mostly-empty crawl got cached as if it were a full, successful
// one, silently dropping the catalog from 13 Extended Race Highlights to 3).
// A couple of retries with a short backoff recovers most transient failures
// before they ever reach the caller.
function fetchHtmlWithRetries(path, attemptsLeft = 2) {
    return fetchHtml(path).catch((err) => {
        if (attemptsLeft <= 0) throw err;
        return new Promise((resolve) => setTimeout(resolve, 1000))
            .then(() => fetchHtmlWithRetries(path, attemptsLeft - 1));
    });
}

// Every video path is /videos/<year>/<month>/<DD>-<slug...> - reading the
// date straight from the URL is far more reliable than the page's own
// displayed date, which (confirmed live) is sometimes relative ("2 DAYS
// AGO") and sometimes absolute ("JUN 14, 2026") on the very same page.
function dateFromPath(path) {
    const m = path.match(/^\/videos\/(\d{4})\/(\d{2})\/(\d{2})-/);
    if (!m) return null;
    const [, year, month, day] = m;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function extractVideoCards(html) {
    const $ = cheerio.load(html);
    const videos = [];
    $('a.news-video-card').each((i, el) => {
        const href = $(el).attr('href');
        const title = ($(el).attr('title') || $(el).find('h3.news-video-card-title').text() || '').trim();
        if (!href || !title) return;
        const category = classify(title);
        if (!category) return;
        const path = href.startsWith('/') ? href : `/${href}`;
        const imgSrc = $(el).find('img').attr('src') || '';
        videos.push({
            id: `indycar:${path.replace(/^\/videos\//, '')}`,
            path,
            title,
            category,
            poster: imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`,
            description: $(el).find('.news-video-card-teaser').text().trim(),
            timestamp: dateFromPath(path)
        });
    });
    return videos;
}

function getRaceWeekendPaths() {
    return fetchHtml('/Schedule').then((html) => {
        const $ = cheerio.load(html);
        const paths = new Set();
        $('a').each((i, el) => {
            const href = $(el).attr('href') || '';
            const m = href.match(/^\/Schedule\/(\d{4})\/([^/?#]+)/i);
            if (m) paths.add(`/Schedule/${m[1]}/${m[2]}`);
        });
        return Array.from(paths);
    });
}

// Returns both the videos found and how many of the race-weekend pages
// failed even after retries, so the caller can decide whether this crawl is
// trustworthy enough to actually replace a previous good result with (see
// getAllVideos below) - the crawl itself always resolves, using whatever
// pages did succeed, rather than failing outright over a handful of bad ones.
function crawlAllVideos() {
    return getRaceWeekendPaths().then((paths) => Promise.all(paths.map((path) =>
        fetchHtmlWithRetries(path).then(extractVideoCards).catch((err) => {
            console.error(`[IndyCar] Failed to fetch ${path} after retries: ${err.message}`);
            return null;
        })
    ))).then((lists) => {
        const failedCount = lists.filter((l) => l === null).length;
        if (failedCount > 0) {
            console.warn(`[IndyCar] ${failedCount}/${lists.length} race-weekend page(s) failed to fetch this crawl`);
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

// Stale-while-revalidate: crawling 18 race-weekend pages takes ~9-10s, which
// was making the catalog itself feel slow to open every time the 1-hour
// cache expired. Only the very first request after the server starts (when
// there's no cache at all yet) still has to wait for that; every later
// request - even once the cache has gone stale - gets the last-known list
// back immediately, while a fresh crawl runs in the background for the NEXT
// request. Same pattern addon-server.js's buildCatalog already uses for the
// AI "For You" catalog.
// A crawl where more than half the pages failed (even after retries) isn't
// trustworthy enough to replace an existing cache with - confirmed live on
// one deployment that a bad network condition made most of the 18 requests
// fail, and the resulting near-empty result got cached as if it were
// complete, silently dropping the catalog from 13 Extended Race Highlights
// to 3 with no visible error. A cold start (no cache at all yet) still uses
// whatever a partial crawl found, since something is better than nothing
// when there's no earlier good result to fall back on.
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
                console.warn(`[IndyCar] Background refresh too incomplete (${failedCount}/${totalPages} pages failed) - keeping the previous cache instead of replacing it`);
                return;
            }
            cache = { videos, timestamp: Date.now() };
            console.log(`[IndyCar] Refreshed ${videos.length} highlight video(s) in the background`);
        }).catch((err) => console.error(`[IndyCar] Background refresh failed: ${err.message}`));
        return Promise.resolve(cache.videos);
    }
    return crawlAllVideos().then(({ videos, failedCount, totalPages }) => {
        if (failedCount > 0) {
            console.warn(`[IndyCar] Initial crawl was incomplete (${failedCount}/${totalPages} pages failed) - caching what was found anyway since there's no earlier result to fall back on`);
        }
        cache = { videos, timestamp: now };
        console.log(`[IndyCar] Crawled ${videos.length} highlight video(s)`);
        return videos;
    }).catch((err) => {
        console.error(`[IndyCar] Crawl failed: ${err.message}`);
        return cache.videos || [];
    });
}

// category: one of CATEGORIES, or falsy to return every category merged
// (sorted newest-first) - used as the catalog's default, unfiltered view.
function listVideos(category) {
    return getAllVideos().then((videos) => (category ? videos.filter((v) => v.category === category) : videos));
}

function extractJwMediaId(html) {
    const m = html.match(/cdn\.jwplayer\.com\/players\/([A-Za-z0-9]+)-[A-Za-z0-9]+\.html/);
    return m ? m[1] : null;
}

// "Full Race Replay" videos (confirmed live) are embedded from YouTube
// instead of JW Player, unlike every other category. Pulling a raw,
// directly-playable file URL out of a YouTube page means reproducing
// YouTube's own signature-cipher extraction (what yt-dlp does) - fragile,
// high-maintenance, and working against access controls YouTube puts there
// deliberately, which is disproportionate here and not something this
// scraper should be doing. Returning the video id as a Stremio-protocol
// `ytId` stream instead lets the client's own native YouTube playback handle
// it - the same mechanism official YouTube-backed Stremio catalogs use - so
// nothing needs to be extracted or circumvented at all.
function extractYouTubeId(html) {
    const m = html.match(/youtube\.com\/embed\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
}

function resolveFromJwPlayer(mediaId) {
    return fetch(`https://cdn.jwplayer.com/v2/media/${mediaId}`).then((res) => {
        if (!res.ok) throw new Error(`JW Player API HTTP ${res.status}`);
        return res.json();
    }).then((data) => {
        const item = data.playlist && data.playlist[0];
        const sources = (item && item.sources) || [];
        return sources
            .filter((s) => s.type === 'video/mp4' || s.type === 'application/vnd.apple.mpegurl')
            .map((s) => {
                const isHls = s.type === 'application/vnd.apple.mpegurl';
                return {
                    name: 'IndyCar',
                    quality: isHls ? 'Auto (HLS)' : (s.label || 'Unknown'),
                    url: s.file
                };
            });
    });
}

// videoPath: the /videos/... path stored on each item from listVideos().
function getVideoStreams(videoPath) {
    return fetchHtml(videoPath).then((html) => {
        const mediaId = extractJwMediaId(html);
        if (mediaId) return resolveFromJwPlayer(mediaId);

        const ytId = extractYouTubeId(html);
        if (ytId) return [{ name: 'IndyCar', quality: 'YouTube', ytId }];

        console.log(`[IndyCar] No JW Player or YouTube embed found for ${videoPath}`);
        return [];
    }).catch((err) => {
        console.error(`[IndyCar] Failed to resolve streams for ${videoPath}: ${err.message}`);
        return [];
    });
}

module.exports = { listVideos, getVideoStreams, CATEGORIES };
