// Movies4u scraper.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["movies4u"]
//   search         -> GET {domain}/wp-json/wp/v2/posts?search={query} - the
//                     site's own /search.html returns identical content
//                     regardless of query (confirmed live - it's rendered
//                     client-side from something else, not server-side
//                     search), but WordPress's own standard REST API works
//                     cleanly and returns clean, structured JSON.
//   movie page     -> one m4ulinks.site hub link covering every quality
//   hub page       -> per quality: "Hub-Cloud [DD]" (hubcloud.ist/video/<id>),
//                     "Direct-[Drive-link]" (filebee.xyz - confirmed live
//                     this one is Cloudflare-challenge-gated, skipped
//                     entirely), "GDFlix" (gdlink.dev - not yet wired up,
//                     HubCloud alone already gives real, working links)
//   hubcloud       -> lib/hubcloudExtract.js (shared with 4khdhub.js) -
//                     confirmed live end-to-end: FSL yields a Cloudflare R2
//                     presigned URL (206 on a ranged GET), PixelServer
//                     yields a pixeldrain.dev direct link, and 10Gbps
//                     resolves through a gamerxyt.com-style gateway to a
//                     Google Drive link (lib/aggregate.js's dropUnplayable
//                     already live-probes those for real seekability).

const cheerio = require('cheerio');
const hubcloud = require('../lib/hubcloudExtract');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://new6.movies4u.clinic';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
    if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
    return fetch(DOMAINS_URL, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => {
            const domain = ((data && data.movies4u) || DEFAULT_DOMAIN).replace(/\/+$/, '');
            cachedDomain = domain;
            cachedDomainAt = Date.now();
            console.log(`[Movies4u] Using domain: ${domain}`);
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
            console.log(`[Movies4u] TMDB Info: "${title}" (${year})`);
            return { title, year };
        });
}

function normalize(str) {
    return String(str || '').toLowerCase().replace(/&#8[0-9]{3};/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Post titles here are formatted like "Inception (2010) BluRay Dual Audio
// [...] Full Movie 480p [...] | 720p [...]" - the real title+year sit right
// at the front, so requiring the (normalized) post title to start with the
// target title, plus the release year appearing somewhere in it, is a
// reliable match without needing fuzzy scoring.
function findBestMatch(posts, mediaInfo) {
    const targetTitle = normalize(mediaInfo.title);
    if (!targetTitle) return null;
    for (const post of posts) {
        const postTitle = normalize(post.title && post.title.rendered);
        if (!postTitle.startsWith(targetTitle)) continue;
        if (mediaInfo.year && !postTitle.includes(mediaInfo.year)) continue;
        return post;
    }
    return null;
}

function search(domain, query) {
    const url = `${domain}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.ok ? res.json() : [])
        .catch(() => []);
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

// Each quality heading (e.g. "1080p [3GB]") is followed by a sibling
// carrying the actual buttons - confirmed live via the rendered DOM that
// this can be 1-2 siblings away, not always the very next one.
function extractQualityGroups($) {
    const groups = [];
    $('h1, h2, h3, h4, h5').each((_, el) => {
        const heading = $(el).text().trim();
        if (!/\d{3,4}\s*p/i.test(heading)) return;
        let sib = $(el).next();
        let hops = 0;
        let hubcloudHref = null;
        while (sib.length && hops < 4 && !hubcloudHref) {
            hubcloudHref = sib.find('a[href*="hubcloud."]').attr('href') || null;
            sib = sib.next();
            hops++;
        }
        if (hubcloudHref) groups.push({ heading, hubcloudHref });
    });
    return groups;
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Movies4u] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

    if (mediaType === 'tv') {
        // Confirmed live this site is movies-only (no season/episode post
        // structure found) - degrade to empty rather than searching blind.
        console.log('[Movies4u] TV not supported by this site, skipping');
        return Promise.resolve([]);
    }

    return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
        if (!mediaInfo.title) return [];
        return search(domain, mediaInfo.title).then(posts => {
            const match = findBestMatch(posts, mediaInfo);
            if (!match) {
                console.log(`[Movies4u] No matching title found for "${mediaInfo.title}"`);
                return [];
            }
            console.log(`[Movies4u] Matched: "${match.title.rendered}"`);

            return fetch(match.link, { headers: { 'User-Agent': USER_AGENT } })
                .then(res => res.text())
                .then(html => {
                    const $ = cheerio.load(html);
                    const hubLink = $('a[href*="m4ulinks."]').first().attr('href');
                    if (!hubLink) {
                        console.log('[Movies4u] No m4ulinks hub link found on movie page');
                        return [];
                    }
                    return fetch(hubLink, { headers: { 'User-Agent': USER_AGENT, Referer: match.link } })
                        .then(res => res.text())
                        .then(hubHtml => {
                            const $$ = cheerio.load(hubHtml);
                            const groups = extractQualityGroups($$);
                            if (!groups.length) {
                                console.log('[Movies4u] No quality/hubcloud groups found on m4ulinks page');
                                return [];
                            }
                            const baseTitle = (match.title.rendered || '').replace(/&#8[0-9]{3};/g, '-');
                            return Promise.all(groups.map(g =>
                                hubcloud.extractHubCloud(g.hubcloudHref, { height: 0, title: baseTitle }, {
                                    userAgent: USER_AGENT,
                                    log: (m) => console.log(`[Movies4u] ${m}`)
                                }).then(results => results.map(r => ({
                                    name: `Movies4u - ${r.source}`,
                                    title: `${r.meta.title}\n${hubcloud.formatBytes(r.meta.bytes || 0)}`,
                                    url: r.url,
                                    quality: extractQuality(g.heading) !== 'Unknown' ? extractQuality(g.heading) : extractQuality(r.meta.title),
                                    provider: 'movies4u'
                                })))
                            )).then(perGroup => perGroup.flat());
                        });
                });
        });
    }).catch(err => {
        console.log(`[Movies4u] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams };
