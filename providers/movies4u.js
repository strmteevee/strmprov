// Movies4u scraper for Nuvio Local Scrapers
//
// Indian movie/series blog whose downloads run through a m4ulinks hub to
// HubCloud. Re-checked live 2026-11-05:
//   domain  -> phisher98's shared domains.json ["movies4u"]; the entry has at
//              times been a Google search link for the real domain
//   search  -> GET {domain}/lookup.php?q={query}&page=1&per_page=20
//              -> {"hits":[{"post_title","permalink"}]} - the endpoint the
//              site's own search page calls. WordPress's /wp-json search and
//              ?s= no longer work: the first answers one fixed post whatever
//              you ask, the second redirects to that JavaScript search page.
//   movie   -> post page -> first m4ulinks link -> "1080p [3GB]"-style headings
//              each followed by a HubCloud link
//   series  -> post page -> "Season N Single Episodes 720p" headings each
//              followed by a m4ulinks link -> "-:Episodes: N:-" headings each
//              followed by a HubCloud link
// A title can have several posts (a dual-audio and an English one), so every
// post that matches is used.

const cheerio = require('cheerio');
const hubcloud = require('../lib/hubcloudExtract');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://new5.movies4u.garden';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;
const MAX_POSTS = 3;
const PROBE_TIMEOUT_MS = 6000;

let cachedDomain = null;
let cachedDomainAt = 0;

function normalizeListedDomain(value) {
    let domain = String(value).trim();
    try {
        const url = new URL(domain);
        const query = url.searchParams.get('q');
        if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && query) {
            domain = /^https?:\/\//i.test(query) ? query : `https://${query}`;
        }
    } catch (e) { /* not a URL - keep as is */ }
    return domain.replace(/\/+$/, '');
}

function getDomain() {
    if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
    return fetch(DOMAINS_URL, { headers: HEADERS })
        .then(res => res.json())
        .then(data => {
            const domain = normalizeListedDomain((data && data.movies4u) || DEFAULT_DOMAIN);
            cachedDomain = domain;
            cachedDomainAt = Date.now();
            console.log(`[Movies4u] Using domain: ${domain}`);
            return domain;
        })
        .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    return fetch(`${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`, { headers: HEADERS })
        .then(res => res.json())
        .then(data => ({
            title: mediaType === 'tv' ? data.name : data.title,
            year: ((mediaType === 'tv' ? data.first_air_date : data.release_date) || '').substring(0, 4)
        }))
        .catch(() => ({ title: '', year: '' }));
}

function search(domain, query) {
    const url = `${domain}/lookup.php?q=${encodeURIComponent(query)}&page=1&per_page=20`;
    return fetch(url, { headers: Object.assign({ Referer: `${domain}/search.html` }, HEADERS) })
        .then(res => (res.ok ? res.json() : null))
        .then(data => (data && Array.isArray(data.hits) ? data.hits : []))
        .catch(() => []);
}

function normalize(text) {
    return String(text || '')
        .replace(/^\s*\[[^\]]*\]\s*/, '') // "[18+] Breaking Bad ..."
        .toLowerCase()
        .replace(/&#?\w+;/g, ' ')
        .replace(/[^a-z0-9()]+/g, ' ')
        .trim();
}

// The post title has to be the title itself, followed by its year or season:
// "Breaking Bad (Season 1-5)", not "El Camino: A Breaking Bad Movie", and a
// movie's year may be at most one off (remakes share their name).
function isMatch(hit, info, mediaType) {
    const target = normalize(info.title);
    const title = normalize(hit.post_title);
    if (!target || !title.startsWith(target)) return false;
    const rest = title.slice(target.length).trim();
    if (mediaType === 'tv') return /^\(?\s*season\b/.test(rest);
    const year = rest.match(/^\(?\s*((?:19|20)\d{2})\b/);
    if (!year) return false;
    return !info.year || Math.abs(Number(year[1]) - Number(info.year)) <= 1;
}

function extractQuality(text) {
    const m = /(\d{3,4})\s*p/i.exec(text || '');
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 2160) return '4K';
        return `${n}p`;
    }
    return /4K|UHD/i.test(text || '') ? '4K' : 'Unknown';
}

// The link a heading is about sits in one of the next few siblings.
function linkAfter($, heading, selector) {
    let sib = $(heading).next();
    for (let hops = 0; sib.length && hops < 4; hops++) {
        const href = sib.is(selector) ? sib.attr('href') : sib.find(selector).first().attr('href');
        if (href) return href;
        if (/^h[1-6]$/i.test(sib.prop('tagName') || '')) return null; // the next section starts
        sib = sib.next();
    }
    return null;
}

function fetchPage(url, referer) {
    return fetch(url, { headers: Object.assign({ Referer: referer }, HEADERS) }).then(res => res.text());
}

// Movie: every quality heading on the m4ulinks hub with its HubCloud link.
function movieTargets(html, pageUrl) {
    const $ = cheerio.load(html);
    const hub = $('a[href*="m4ulinks."]').first().attr('href');
    if (!hub) return Promise.resolve([]);
    return fetchPage(hub, pageUrl).then(hubHtml => {
        const $$ = cheerio.load(hubHtml);
        const targets = [];
        $$('h1, h2, h3, h4, h5').each((_, el) => {
            const heading = $$(el).text().trim();
            if (!/\d{3,4}\s*p/i.test(heading)) return;
            const href = linkAfter($$, el, 'a[href*="hubcloud."]');
            if (href) targets.push({ heading, href });
        });
        return targets;
    });
}

// Series: the season's "Single Episodes" hubs, one per quality; on each hub the
// episode's own heading and HubCloud link.
function episodeTargets(html, pageUrl, season, episode) {
    const $ = cheerio.load(html);
    const seasonRe = new RegExp(`season\\s*0*${season}\\b`, 'i');
    const episodeRe = new RegExp(`episodes?\\s*:?\\s*0*${episode}\\b`, 'i');
    const hubs = [];
    $('h1, h2, h3, h4, h5').each((_, el) => {
        const heading = $(el).text().trim();
        if (!seasonRe.test(heading) || !/single\s*episodes?/i.test(heading)) return;
        const href = linkAfter($, el, 'a[href*="m4ulinks."]');
        if (href) hubs.push({ heading, href });
    });
    return Promise.all(hubs.map(hub => fetchPage(hub.href, pageUrl).then(hubHtml => {
        const $$ = cheerio.load(hubHtml);
        let target = null;
        $$('h1, h2, h3, h4, h5').each((_, el) => {
            if (target || !episodeRe.test($$(el).text())) return;
            const href = linkAfter($$, el, 'a[href*="hubcloud."]');
            if (href) target = { heading: hub.heading, href };
        });
        return target;
    }).catch(() => null))).then(found => found.filter(Boolean));
}

function isReachable(stream) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    return fetch(stream.url, { headers: { Range: 'bytes=0-1024' }, signal: controller.signal })
        .then(res => {
            if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
            return res.ok && !/text\/html/i.test(res.headers.get('content-type') || '');
        })
        .catch(() => false)
        .then(ok => { clearTimeout(timer); return ok; });
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    console.log(`[Movies4u] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);

    return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, info]) => {
        if (!info.title) return [];
        return search(domain, info.title).then(hits => {
            const posts = hits.filter(hit => isMatch(hit, info, mediaType)).slice(0, MAX_POSTS);
            if (!posts.length) {
                console.log(`[Movies4u] No matching title found for "${info.title}"`);
                return [];
            }
            const label = mediaType === 'tv'
                ? `${info.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
                : `${info.title}${info.year ? ` (${info.year})` : ''}`;

            return Promise.all(posts.map(post => {
                const pageUrl = /^https?:/.test(post.permalink) ? post.permalink : `${domain}${post.permalink}`;
                return fetchPage(pageUrl, `${domain}/`)
                    .then(html => (mediaType === 'tv' ? episodeTargets(html, pageUrl, season, episode) : movieTargets(html, pageUrl)))
                    .then(targets => Promise.all(targets.map(t =>
                        hubcloud.extractHubCloud(t.href, { height: 0, title: label, bytes: 0 }, {
                            userAgent: USER_AGENT,
                            log: m => console.log(`[Movies4u] ${m}`)
                        }).then(results => results.map(r => ({
                            name: `Movies4u - ${r.source}`,
                            title: `${r.meta.title}\n${hubcloud.formatBytes(r.meta.bytes || 0)}`,
                            url: r.url,
                            quality: extractQuality(t.heading),
                            // The post title names the audio ("Dual Audio [Hindi + English]");
                            // read by lib/languageFilter.js.
                            filename: post.post_title,
                            provider: 'movies4u'
                        })))
                    )))
                    .catch(err => {
                        console.log(`[Movies4u] ${pageUrl} failed: ${err.message}`);
                        return [];
                    });
            })).then(perPost => {
                const seen = new Set();
                const streams = perPost.flat(2).filter(s => (seen.has(s.url) ? false : seen.add(s.url)));
                return Promise.all(streams.map(isReachable)).then(ok => {
                    const working = streams.filter((_, i) => ok[i]);
                    console.log(`[Movies4u] ${working.length}/${streams.length} stream(s) reachable`);
                    return working;
                });
            });
        });
    }).catch(err => {
        console.log(`[Movies4u] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams };
