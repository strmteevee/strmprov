// Formula 1/2/3/Academy highlight-video scraper.
//
// Like providers/indycar.js, this has no tmdbId/mediaType/season/episode
// interface - these are motorsport highlight clips with no TMDB entry, used
// directly by addon-server.js's dedicated catalogs rather than going through
// lib/aggregate.js's multi-provider pipeline.
//
// formula1.com's own WEBSITE player was investigated first and rejected: it
// loads video through a dedicated Web Worker whose network activity never
// surfaces on the main thread or in the browser's own network log - a
// deliberate anti-scraping measure, not an oversight, and not something this
// scraper should be defeating.
//
// Instead, this uses F1's OWN OFFICIAL public v1 API - the same one their
// Android app calls - found via the open-source (MIT-licensed)
// jaylinski/kodi-addon-formula1 project and confirmed live independently:
// `GET api.formula1.com/v1/video-assets/videos?limit=&offset=` (an `apikey`
// header, extracted from that public app, is required but needs no
// login/session) lists every published video newest-first, including a
// `caption` to classify by series, an `isProtected` flag (true = F1TV-
// subscriber-only, false = freely playable - only `false` ones are used
// here), and a `videoId`. Resolving a `videoId` into real, direct HLS/MP4
// urls is then just Brightcove's own standard, public Playback API
// (`edge.api.brightcove.com/playback/v1/accounts/<id>/videos/<videoId>`,
// needs only a `BCOV-POLICY` key, also extracted from the same public app) -
// Brightcove is a mainstream third-party video host; this is the normal,
// unauthenticated way any Brightcove-hosted embed is played anywhere on the
// web, the same trust level as providers/indycar.js's JW Player API.

const F1_API_BASE = 'https://api.formula1.com/v1';
const F1_API_KEY = 'b3f7H0DKkuzGXT76hV0RakXWOh28tQqY';
const F1_API_HEADERS = { apikey: F1_API_KEY, locale: 'en' };
const VIDEOS_PATH = '/video-assets/videos';

const BRIGHTCOVE_ACCOUNT_ID = '6057949432001';
const BRIGHTCOVE_POLICY_KEY = 'BCpkADawqM1hQVBuXkSlsl6hUsBZQMmrLbIfOjJQ3_n8zmPOhlNSwZhQBF6d5xggxm0t052' +
    'lQjYyhqZR3FW2eP03YGOER9ihJkUnIhRZGBxuLhnL-QiFpvcDWIh_LvwN5j8zkjTtGKarhsdV';

// Checked in this order deliberately, same reasoning as indycar.js's
// CATEGORY_MATCHERS: "F1 Academy"/"Formula 2"/"Formula 3" captions always
// name their own series explicitly, so those are checked before the bare F1
// "Race Highlights: ..." pattern - confirmed live there's no overlap anyway,
// but this stays defensive against a future caption format change.
// F1 itself is deliberately matched on "Race Highlights" only (not
// Qualifying/FP/Sprint Highlights, which the same feed also publishes) to
// mirror this project's existing IndyCar catalog, which likewise shows only
// race highlights rather than every session type.
const SERIES_MATCHERS = [
    { series: 'academy', name: 'F1 Academy', test: (c) => /f1 academy highlights/i.test(c) },
    { series: 'f2', name: 'Formula 2', test: (c) => /formula 2 highlights/i.test(c) },
    { series: 'f3', name: 'Formula 3', test: (c) => /formula 3 highlights/i.test(c) },
    { series: 'f1', name: 'Formula 1', test: (c) => /^race highlights/i.test(c) }
];
const SERIES = SERIES_MATCHERS.map((m) => m.series);

function classify(caption) {
    const c = (caption || '').trim();
    for (const matcher of SERIES_MATCHERS) {
        if (matcher.test(c)) return matcher.series;
    }
    return null;
}

function fetchJson(path) {
    return fetch(`${F1_API_BASE}${path}`, { headers: F1_API_HEADERS }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
        return res.json();
    });
}

function fetchJsonWithRetries(path, attemptsLeft = 2) {
    return fetchJson(path).catch((err) => {
        if (attemptsLeft <= 0) throw err;
        return new Promise((resolve) => setTimeout(resolve, 1000))
            .then(() => fetchJsonWithRetries(path, attemptsLeft - 1));
    });
}

function thumbnailUrl(video) {
    const thumb = video.thumbnail;
    if (!thumb) return '';
    return (thumb.renditions && thumb.renditions['6col']) || thumb.url || thumb.path || '';
}

// The API's own "total" field is a fixed display cap (confirmed live it
// stays "1000" no matter how far pagination actually goes), not the real
// end of the feed - paging is instead bounded by how far back MONTHS_BACK
// reaches (checked against each item's own publishedAt) and by
// MAX_PAGES as an absolute safety ceiling in case dates are ever malformed.
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MONTHS_BACK = 12;
const CACHE_TTL_MS = 1000 * 60 * 60;

function fetchPage(offset, onFail) {
    return fetchJsonWithRetries(`${VIDEOS_PATH}?limit=${PAGE_SIZE}&offset=${offset}`)
        .then((data) => (Array.isArray(data.videos) ? data.videos : []))
        .catch((err) => {
            onFail();
            console.error(`[F1] Failed to fetch videos page at offset ${offset} after retries: ${err.message}`);
            return [];
        });
}

function offsetsForPages(fromPage, toPage) {
    const offsets = [];
    for (let p = fromPage; p < toPage; p++) offsets.push(p * PAGE_SIZE);
    return offsets;
}

// Confirmed live this feed's date density is roughly steady (not bursty),
// so one probe page's own newest-to-oldest span reliably estimates how many
// pages MONTHS_BACK actually needs, with a 30% margin for the variance
// videos naturally have. Fetching that many pages concurrently (like
// indycar.js already does for its own, differently-shaped weekend crawl)
// turned a ~2.5-minute, 32-page SEQUENTIAL crawl into one bounded by the
// slowest single request instead of the sum of all of them.
function estimatePagesNeeded(firstPage) {
    if (firstPage.length < 2) return MAX_PAGES;
    const newest = Date.parse(firstPage[0].publishedAt || '') || Date.now();
    const oldest = Date.parse(firstPage[firstPage.length - 1].publishedAt || '') || newest;
    const msPerPage = Math.max(newest - oldest, 1);
    const targetMs = MONTHS_BACK * 30 * 24 * 60 * 60 * 1000;
    const estimated = Math.ceil((targetMs / msPerPage) * 1.3);
    return Math.min(Math.max(estimated, 1), MAX_PAGES);
}

// Pages through the video feed (fetched concurrently, then re-sorted
// newest-first since concurrent requests can resolve out of order).
// Collects every freely-playable (isProtected: false) video whose caption
// matches one of the 4 series above, published within MONTHS_BACK.
function crawlHighlights() {
    const cutoff = Date.now() - MONTHS_BACK * 30 * 24 * 60 * 60 * 1000;
    let failedPages = 0;
    const onFail = () => { failedPages++; };

    function extractHighlights(rawVideos) {
        const out = [];
        for (const v of rawVideos) {
            const timestamp = Date.parse(v.publishedAt || '') || 0;
            if (timestamp < cutoff) continue;
            if (v.isProtected || !v.videoId) continue;
            const series = classify(v.caption);
            if (!series) continue;
            out.push({
                id: `f1:${v.videoId}`,
                videoId: v.videoId,
                series,
                title: v.caption,
                description: v.description || '',
                poster: thumbnailUrl(v),
                timestamp
            });
        }
        return out;
    }

    function finalize(rawVideos, pagesFetched) {
        rawVideos.sort((a, b) => (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0));
        return { videos: extractHighlights(rawVideos), failedPages, pagesFetched };
    }

    return fetchPage(0, onFail).then((firstPage) => {
        if (firstPage.length === 0) return { videos: [], failedPages, pagesFetched: 1 };

        const pagesNeeded = estimatePagesNeeded(firstPage);
        return Promise.all(offsetsForPages(1, pagesNeeded).map((o) => fetchPage(o, onFail))).then((restPages) => {
            let allRaw = [firstPage, ...restPages].flat();
            const oldestSoFar = Math.min(...allRaw.map((v) => Date.parse(v.publishedAt || '') || Date.now()));

            // The estimate can undershoot (the feed isn't perfectly steady) -
            // one top-up round, doubling the page count and capped at
            // MAX_PAGES, catches that without falling back to a fully
            // unbounded/sequential crawl.
            if (oldestSoFar > cutoff && pagesNeeded < MAX_PAGES) {
                const topUpTo = Math.min(pagesNeeded * 2, MAX_PAGES);
                return Promise.all(offsetsForPages(pagesNeeded, topUpTo).map((o) => fetchPage(o, onFail))).then((extraPages) => {
                    allRaw = allRaw.concat(extraPages.flat());
                    return finalize(allRaw, topUpTo);
                });
            }
            return finalize(allRaw, pagesNeeded);
        });
    });
}

// A crawl where more than a third of its pages failed isn't trustworthy
// enough to replace an existing cache with - same reasoning as
// providers/indycar.js's isTrustworthy.
function isTrustworthy(failedPages, pagesFetched) {
    return failedPages <= pagesFetched / 3;
}

let cache = { videos: null, timestamp: 0 };
// Shares one in-flight cold-start crawl across every caller that arrives
// before it finishes, instead of each starting its own separate crawl -
// confirmed live this actually happens: addon-server.js now warms this
// cache at startup (see its server.listen callback), and a real request
// from Nuvio can easily land while that warm-up crawl is still running.
// Without this, that request would kick off a second, fully redundant
// ~12-second crawl of its own rather than just waiting on the first one.
let inFlightColdStart = null;

// Stale-while-revalidate, identical policy to providers/indycar.js's
// getAllVideos: a fresh crawl still means a couple dozen real HTTP requests
// (even fired concurrently, latency and retries add up), so only a true
// cold start blocks on it - every later call gets the last-known list
// immediately while a fresh crawl runs in the background for the next call.
function getAllVideos() {
    const now = Date.now();
    if (cache.videos && now - cache.timestamp < CACHE_TTL_MS) {
        return Promise.resolve(cache.videos);
    }
    if (cache.videos) {
        crawlHighlights().then(({ videos, failedPages, pagesFetched }) => {
            if (!isTrustworthy(failedPages, pagesFetched)) {
                console.warn(`[F1] Background refresh too incomplete (${failedPages}/${pagesFetched} pages failed) - keeping the previous cache instead of replacing it`);
                return;
            }
            cache = { videos, timestamp: Date.now() };
            console.log(`[F1] Refreshed ${videos.length} highlight video(s) in the background`);
        }).catch((err) => console.error(`[F1] Background refresh failed: ${err.message}`));
        return Promise.resolve(cache.videos);
    }
    if (!inFlightColdStart) {
        inFlightColdStart = crawlHighlights().then(({ videos, failedPages, pagesFetched }) => {
            inFlightColdStart = null;
            if (failedPages > 0) {
                console.warn(`[F1] Initial crawl was incomplete (${failedPages}/${pagesFetched} pages failed) - caching what was found anyway since there's no earlier result to fall back on`);
            }
            cache = { videos, timestamp: now };
            console.log(`[F1] Crawled ${videos.length} highlight video(s) across ${pagesFetched} page(s)`);
            return videos;
        }).catch((err) => {
            inFlightColdStart = null;
            console.error(`[F1] Crawl failed: ${err.message}`);
            return cache.videos || [];
        });
    }
    return inFlightColdStart;
}

// series: one of SERIES, or falsy to return every series merged (still
// newest-first).
function listVideos(series) {
    return getAllVideos().then((videos) => (series ? videos.filter((v) => v.series === series) : videos));
}

// videoId: the Brightcove video id, same as each item's own `videoId` from
// listVideos().
function getVideoStreams(videoId) {
    const url = `https://edge.api.brightcove.com/playback/v1/accounts/${BRIGHTCOVE_ACCOUNT_ID}/videos/${videoId}`;
    return fetch(url, { headers: { 'BCOV-POLICY': BRIGHTCOVE_POLICY_KEY } }).then((res) => {
        if (!res.ok) throw new Error(`Brightcove HTTP ${res.status}`);
        return res.json();
    }).then((data) => {
        const sources = Array.isArray(data.sources) ? data.sources : [];
        return sources
            // Brightcove lists an http:// and an https:// copy of every
            // rendition - confirmed live these are otherwise identical, and
            // https is the safer choice (some Android/ExoPlayer setups block
            // plain-http "cleartext" playback outright), so the http:// copy
            // is dropped rather than shown as a separate, redundant option.
            .filter((s) => s.src && s.src.startsWith('https://'))
            .map((s) => {
                if (s.type === 'application/x-mpegURL') {
                    return { name: 'F1', quality: 'Auto (HLS)', url: s.src };
                }
                if (s.container === 'MP4') {
                    return { name: 'F1', quality: s.height ? `${s.height}p` : 'Unknown', url: s.src };
                }
                return null;
            })
            .filter(Boolean);
    }).catch((err) => {
        console.error(`[F1] Failed to resolve streams for video ${videoId}: ${err.message}`);
        return [];
    });
}

module.exports = { listVideos, getVideoStreams, SERIES, SERIES_MATCHERS };
