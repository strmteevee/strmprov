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
//
// The site also publishes "Extended Highlights" (no "Race") for practice and
// qualifying sessions - e.g. "Extended Highlights: 2025 Indianapolis 500 -
// Practice Day 7" or "... Fast Friday Practice" - which the bare
// "extended highlights" substring check used to also catch, flooding the
// catalog with non-race sessions (confirmed live: 8 extra practice-day
// entries for a single Indy 500 weekend alone). Excluding anything
// mentioning "practice" or "qualifying" keeps this to actual race highlights
// only, by request.
const CATEGORY_MATCHERS = [
    { name: 'Qualifying Highlights', test: (t) => t.includes('qualifying highlights') },
    {
        name: 'Extended Race Highlights',
        test: (t) => (t.includes('extended race highlights') || t.includes('extended highlights'))
            && !t.includes('practice') && !t.includes('qualifying')
    },
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

// Every video path is /videos/<year>/<month>/<month-again>-<DD>-<slug...> -
// confirmed live the month is duplicated right before the real day (e.g.
// ".../2026/08/08-09-extended-race-highlights-...-portland" is August 9, not
// August 8). Reading the second number as the day is what actually matches
// the real race dates; capturing the first (redundant) one instead collapsed
// every race in a month down to one identical date, leaving same-month races
// in whatever arbitrary order the schedule page's own markup happened to
// list them rather than true chronological order - confirmed live as the
// cause of races showing up out of order. Reading the date from the URL at
// all (rather than the page's own displayed date) is still worthwhile: that
// display text is sometimes relative ("2 DAYS AGO") and sometimes absolute
// ("JUN 14, 2026") on the very same page.
function dateFromPath(path) {
    const m = path.match(/^\/videos\/(\d{4})\/(\d{2})\/\d{2}-(\d{2})-/);
    if (!m) return null;
    const [, year, month, day] = m;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

// raceNumber is this video's originating race weekend's 1-indexed position
// within its own season's schedule (see getRaceWeekendPathsForYear) - every
// video card on that weekend's page shares the same one, since they're all
// videos FROM that one race.
function extractVideoCards(html, raceNumber) {
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
            raceNumber,
            poster: imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`,
            description: $(el).find('.news-video-card-teaser').text().trim(),
            timestamp: dateFromPath(path)
        });
    });
    return videos;
}

// Race weekends are discovered from the year-scoped schedule view
// (indycar.com/Schedule?year=<Y>), not the bare /Schedule page - confirmed
// live that the bare page silently defaults to whatever season is
// current/upcoming (2026 as of writing) and never lists a prior season's
// races at all, so every one of last season's race weekends - and all of
// their videos - was invisible to this scraper no matter how well the rest
// of the crawl worked. The last 2 calendar years covers the
// currently-airing season plus the most recently completed one, by request.
const SEASONS_TO_CRAWL = 2;

// Returns [{ path, raceNumber }] for one season. raceNumber is NOT derived
// from the schedule page's own link order - confirmed live that the raw
// HTML lists event cards in some internal/carousel order that isn't
// chronological at all (season-opener St. Petersburg showed up 4th in the
// markup, not 1st). Every COMPLETED race's card instead embeds its real,
// INDYCAR-assigned season race number in its winner-image filename -
// confirmed live for both 2025 and 2026 - e.g.
// ".../WinnerImages/IndyCar/2025/06-500-Palou.jpg" is race 6 of the 2025
// season (the Indy 500). A race with no winner image yet (not yet run) has
// no highlights video anyway, so a null raceNumber there never surfaces.
function getRaceWeekendPathsForYear(year) {
    return fetchHtmlWithRetries(`/Schedule?year=${year}`).then((html) => {
        const $ = cheerio.load(html);
        const byPath = new Map();
        $('a.event-card-link').each((i, el) => {
            const href = $(el).attr('href') || '';
            const m = href.match(/^\/Schedule\/(\d{4})\/([^/?#]+)/i);
            if (!m) return;
            const path = `/Schedule/${m[1]}/${m[2]}`;
            if (byPath.has(path)) return;
            const imgSrc = $(el).find('img').filter((j, img) => /WinnerImages\/IndyCar\//.test($(img).attr('src') || '')).first().attr('src') || '';
            const numMatch = imgSrc.match(/WinnerImages\/IndyCar\/\d{4}\/(\d+)-/);
            byPath.set(path, numMatch ? parseInt(numMatch[1], 10) : null);
        });
        return Array.from(byPath, ([path, raceNumber]) => ({ path, raceNumber }));
    }).catch((err) => {
        console.error(`[IndyCar] Failed to fetch ${year} schedule after retries: ${err.message}`);
        return [];
    });
}

function getRaceWeekendPaths() {
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: SEASONS_TO_CRAWL }, (_, i) => currentYear - i);
    return Promise.all(years.map(getRaceWeekendPathsForYear)).then((lists) => {
        const seen = new Set();
        const all = [];
        for (const entry of lists.flat()) {
            if (seen.has(entry.path)) continue;
            seen.add(entry.path);
            all.push(entry);
        }
        return all;
    });
}

// Returns both the videos found and how many of the race-weekend pages
// failed even after retries, so the caller can decide whether this crawl is
// trustworthy enough to actually replace a previous good result with (see
// getAllVideos below) - the crawl itself always resolves, using whatever
// pages did succeed, rather than failing outright over a handful of bad ones.
function crawlAllVideos() {
    return getRaceWeekendPaths().then((entries) => Promise.all(entries.map(({ path, raceNumber }) =>
        fetchHtmlWithRetries(path).then((html) => extractVideoCards(html, raceNumber)).catch((err) => {
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
