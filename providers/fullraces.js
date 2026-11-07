// Full-race replay scraper for overtakefans.com (F1, F2, F3).
//
// NOT a TMDB-based provider - like providers/f1.js and providers/indycar.js it
// has no tmdbId/mediaType/season/episode interface, since race replays have no
// TMDB entries. Used directly by addon-server.js's dedicated F1/F2/F3 full-race
// catalogs, not through lib/aggregate.js, so it only ever runs server-side in
// plain Node (setTimeout is safe here, unlike providers that also ship as a
// standalone Nuvio plugin).
//
// Site structure (confirmed live 2026-11-07): the race archive at
// /f1-race-archive/?page=N lists Bootstrap cards, one per Grand Prix weekend:
//   <div class="card">
//     <img class="card-img-top" ...>          poster
//     <h5 class="card-title">Australian Grand Prix 2026</h5>
//     <h5 class="card-sub-title">6 MAR - 8 MAR 2026</h5>
//     <div class="card-text ...">
//       <a href="watch/index.php?race=SLUG"><button ...>Race</button></a>
//       ... one button per session (Practice 1/2/3, Qualifying, Sprint, Race,
//           plus analysis/show/notebook extras this skips)
// The SLUG carries the series ("...-formula-2-..." etc.); the button label is
// the session name. A disabled button has no replay yet and is skipped.
//
// Playback: the watch page embeds a hakunamatata player iframe; that page's
// Clappr setup has `source: '<token>/<token>/<name>.m3u8'`, a path relative to
// the iframe URL. Resolved to an absolute HLS URL, it plays directly (direct
// MPEG-TS segments, no re-encode) but needs the iframe page as its Referer -
// confirmed live, a bare request gets 403.

const BASE_URL = 'https://overtakefans.com';
const ARCHIVE_PATH = '/f1-race-archive/';
const ARCHIVE_PAGES = 2;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };
const CACHE_TTL_MS = 1000 * 60 * 60;
const FETCH_TIMEOUT_MS = 15000;

// Button labels that are an actual on-track session (kept); everything else -
// analysis, notebooks, buildup, shows, result pages, press conferences - is an
// extra, not a race, and skipped.
const SESSION_RE = /\b(race|sprint|qualifying|practice|testing|warm[\s-]?up|feature)\b/i;
const EXTRA_RE = /analysis|notebook|buildup|\bshow\b|result|preview|review|press|paddock|\bteds\b|conference|highlights|onboard|uncut/i;

const SERIES = {
    f1: { label: 'Formula 1', match: (slug) => !/formula-2|formula-3|\bf2\b|\bf3\b/i.test(slug) },
    f2: { label: 'Formula 2', match: (slug) => /formula-2|\bf2\b/i.test(slug) },
    f3: { label: 'Formula 3', match: (slug) => /formula-3|\bf3\b/i.test(slug) }
};

function seriesOf(slug) {
    if (SERIES.f2.match(slug)) return 'f2';
    if (SERIES.f3.match(slug)) return 'f3';
    return 'f1';
}

function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, Object.assign({ headers: HEADERS }, options, { signal: controller.signal }))
        .then((res) => { clearTimeout(timer); return res; }, (err) => { clearTimeout(timer); throw err; });
}

function decodeEntities(text) {
    return String(text || '')
        .replace(/&amp;/g, '&').replace(/&#8211;/g, '-').replace(/&#8217;/g, "'")
        .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

// "6 MAR - 8 MAR 2026" -> the end date as YYYY-MM-DD (used for releaseInfo).
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function parseEndDate(text) {
    const dates = [...String(text || '').matchAll(/(\d{1,2})\s*([A-Za-z]{3})(?:\s*(\d{4}))?/g)];
    if (!dates.length) return null;
    const last = dates[dates.length - 1];
    const year = last[3] || (String(text).match(/\b(\d{4})\b/) || [])[1];
    const month = MONTHS[last[2].toLowerCase()];
    if (!year || !month) return null;
    return `${year}-${month}-${String(last[1]).padStart(2, '0')}`;
}

function parseCards(html) {
    const out = [];
    // Each card is a <div class="card"> ... block; split on the opening tag.
    const cards = html.split(/<div class="card">/i).slice(1);
    for (const card of cards) {
        const titleM = card.match(/class="card-title"[^>]*>([^<]+)/i);
        if (!titleM) continue;
        const gp = decodeEntities(titleM[1]);
        const dateM = card.match(/class="card-sub-title"[^>]*>([^<]+)/i);
        const date = dateM ? parseEndDate(dateM[1]) : null;
        const imgM = card.match(/class="card-img-top"[^>]*src="([^"]+)"|src="([^"]+)"[^>]*class="card-img-top"/i);
        const posterRel = imgM ? (imgM[1] || imgM[2]) : null;
        const poster = posterRel ? new URL(posterRel, BASE_URL + ARCHIVE_PATH).href : undefined;
        // Each session: <a href="watch/index.php?race=SLUG"...><button ...>LABEL</button>
        const linkRe = /<a\s+href="watch\/index\.php\?race=([^"&]+)[^"]*"[^>]*>\s*<button\b([^>]*)>([^<]+)<\/button>/gi;
        let m;
        while ((m = linkRe.exec(card)) !== null) {
            const slug = m[1];
            const disabled = /\bdisabled\b/i.test(m[2]);
            const label = decodeEntities(m[3]);
            if (disabled) continue;
            if (!SESSION_RE.test(label) || EXTRA_RE.test(label)) continue;
            out.push({ slug, gp, label, date, poster, series: seriesOf(slug) });
        }
    }
    // The archive repeats a session under alternate source variants; one per slug.
    const seen = new Set();
    return out.filter((v) => (seen.has(v.slug) ? false : (seen.add(v.slug), true)));
}

let cache = { items: null, at: 0, inflight: null };

function crawl() {
    const pages = [];
    for (let p = 1; p <= ARCHIVE_PAGES; p++) pages.push(p);
    return Promise.all(pages.map((p) => {
        const url = p === 1 ? `${BASE_URL}${ARCHIVE_PATH}` : `${BASE_URL}${ARCHIVE_PATH}?page=${p}`;
        return fetchWithTimeout(url).then((res) => (res.ok ? res.text() : '')).catch(() => '');
    })).then((htmls) => {
        const all = [];
        const seen = new Set();
        for (const html of htmls) {
            // The archive lists a season's weekends oldest-first; reverse each
            // page so the newest sessions come first in the catalog.
            for (const v of parseCards(html).reverse()) {
                if (seen.has(v.slug)) continue;
                seen.add(v.slug);
                all.push(v);
            }
        }
        return all;
    });
}

function getAll() {
    if (cache.items && Date.now() - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.items);
    if (cache.inflight) return cache.inflight;
    cache.inflight = crawl().then((items) => {
        cache.inflight = null;
        if (items.length) { cache.items = items; cache.at = Date.now(); }
        return cache.items || items;
    }).catch((err) => {
        cache.inflight = null;
        console.log(`[FullRaces] Crawl failed: ${err.message}`);
        return cache.items || [];
    });
    return cache.inflight;
}

function toVideo(v) {
    return {
        id: v.slug,
        title: `${v.gp} - ${v.label}`.replace(/\s+/g, ' ').trim(),
        series: v.series,
        poster: v.poster,
        description: [SERIES[v.series].label, v.label].filter(Boolean).join(' - '),
        timestamp: v.date ? Date.parse(v.date + 'T00:00:00Z') : null
    };
}

// All full-race sessions for one series ('f1'|'f2'|'f3'), newest first (archive
// order is already newest-first, so this keeps it).
function listVideos(series) {
    return getAll().then((items) => items.filter((v) => !series || v.series === series).map(toVideo));
}

function getVideo(id) {
    return getAll().then((items) => {
        const v = items.find((x) => x.slug === id);
        return v ? toVideo(v) : null;
    });
}

// watch page -> hakunamatata iframe -> Clappr source -> absolute m3u8.
function getVideoStreams(id) {
    const watchUrl = `${BASE_URL}${ARCHIVE_PATH}watch/index.php?race=${encodeURIComponent(id)}`;
    return fetchWithTimeout(watchUrl, { headers: Object.assign({ Referer: `${BASE_URL}${ARCHIVE_PATH}` }, HEADERS) })
        .then((res) => res.text())
        .then((html) => {
            const iframeM = html.match(/<iframe[^>]*\ssrc="([^"]+)"/i);
            if (!iframeM) throw new Error('no player iframe on watch page');
            const iframeUrl = new URL(decodeEntities(iframeM[1]), watchUrl).href;
            return fetchWithTimeout(iframeUrl, { headers: Object.assign({ Referer: watchUrl }, HEADERS) })
                .then((res) => res.text())
                .then((player) => {
                    const srcM = player.match(/source:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);
                    if (!srcM) throw new Error('no m3u8 source in player');
                    const m3u8 = new URL(srcM[1], iframeUrl).href;
                    return [{
                        name: 'OverTakeFans',
                        url: m3u8,
                        quality: 'Auto (HLS)',
                        headers: { Referer: iframeUrl, Origin: new URL(iframeUrl).origin, 'User-Agent': USER_AGENT }
                    }];
                });
        })
        .catch((err) => {
            console.log(`[FullRaces] Stream resolution failed for ${id}: ${err.message}`);
            return [];
        });
}

module.exports = { listVideos, getVideo, getVideoStreams, SERIES };
