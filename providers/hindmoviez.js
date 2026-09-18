// HindMoviez scraper.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["hindmoviez"]
//   search         -> GET {domain}/wp-json/wp/v2/posts?search={query} -
//                     WordPress's own standard REST API, same as
//                     providers/movies4u.js.
//   movie page     -> one mvlink.blog link per quality (used exactly as
//                     embedded - confirmed live that inserting a "/web/"
//                     path segment, which some other mvlink.blog links
//                     already embed, is NOT a general normalization: a
//                     stale (13-month-old) post's bare link 404'd while its
//                     "/web/" form resolved to a completely different,
//                     unrelated show - i.e. that id had simply been reused
//                     for other content over time, not a URL-format issue.
//                     Fresh posts' bare links resolve correctly as-is. This
//                     is an inherent site-side link-rot risk on old posts,
//                     not something fixable client-side - matches this
//                     site's own "report broken links" disclaimer.
//   mvlink page    -> one "hshare.lol/?id=<filename>" link (per quality for
//                     movies; one per "Episode NN" for a season pack, plus a
//                     "Batch Episode" zip - not used here, movies only)
//   hshare page    -> several simultaneous options: a decoy Google Photos
//                     share link (skipped), an embedded workers.dev direct
//                     link (kept as a bonus candidate, but confirmed live
//                     these can 500 intermittently - lib/aggregate.js's own
//                     reachability probing handles a dead one), and a
//                     gdshine.org link (the reliable one - see below)
//   gdshine.org    -> a Next.js app, no static download link on the page
//                     itself. Confirmed live via the browser network panel:
//                     GET  /api/files/s/{shortId}             -> {data:{id}}
//                     POST /api/downloads/{id}/via-worker     -> {data:{copyUrl}}
//                     copyUrl is a fresh, anonymous-accessible
//                     *.workers.dev direct link - confirmed live with a real
//                     206 Partial Content + video/x-matroska content-type.

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://hindmovie.fit';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
    if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
    return fetch(DOMAINS_URL, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => {
            const domain = ((data && data.hindmoviez) || DEFAULT_DOMAIN).replace(/\/+$/, '');
            cachedDomain = domain;
            cachedDomainAt = Date.now();
            console.log(`[HindMoviez] Using domain: ${domain}`);
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
            console.log(`[HindMoviez] TMDB Info: "${title}" (${year})`);
            return { title, year };
        });
}

function normalize(str) {
    return String(str || '').toLowerCase().replace(/&#8[0-9]{3};/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

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

// Each mvlink.blog link on the movie page sits right after its own quality
// heading (e.g. "... 1080p Web-DL [2.3GB]") - confirmed live by walking up
// to the nearest preceding h1-h6 from the link's containing block.
function extractMvlinkGroups($) {
    const groups = [];
    $('a[href*="mvlink."]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        let cur = $(el).closest('p, div, li');
        let heading = null;
        let hops = 0;
        while (cur.length && !heading && hops < 6) {
            const prev = cur.prev();
            if (prev.length && /^h[1-6]$/i.test(prev.get(0).tagName)) heading = prev.text().trim();
            else if (cur.get(0) && /^h[1-6]$/i.test(cur.get(0).tagName)) heading = cur.text().trim();
            cur = prev.length ? prev : cur.parent();
            hops++;
        }
        groups.push({ heading: heading || '', mvlinkHref: href });
    });
    return groups;
}

function resolveHshareToStreams(hshareUrl, meta) {
    return fetch(hshareUrl, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.text())
        .then(html => {
            const $ = cheerio.load(html);
            const streams = [];
            let workerHref = null;
            let gdshineHref = null;
            $('a').each((_, el) => {
                const href = $(el).attr('href') || '';
                if (href.includes('workers.dev') && !workerHref) workerHref = href;
                else if (href.includes('gdshine.') && !gdshineHref) gdshineHref = href;
            });
            const work = [];
            if (workerHref) {
                // Kept as a bonus candidate even though these embedded links
                // are confirmed live to sometimes 500 - lib/aggregate.js's
                // own reachability probing already handles a dead one, same
                // as any other provider's occasionally-stale link.
                streams.push({ name: 'HindMoviez - HCloud', title: `${meta.title}\n${meta.size || ''}`, url: workerHref, quality: meta.quality, provider: 'hindmoviez' });
            }
            if (gdshineHref) {
                const shortIdMatch = gdshineHref.match(/\/s\/([^/?#]+)/);
                if (shortIdMatch) {
                    work.push(resolveGdshine(gdshineHref, shortIdMatch[1], meta).then(s => { if (s) streams.push(s); }));
                }
            }
            return Promise.all(work).then(() => streams);
        })
        .catch(() => []);
}

// See this file's header comment for the confirmed-live API shape.
function resolveGdshine(pageUrl, shortId, meta) {
    const origin = new URL(pageUrl).origin;
    return fetch(`${origin}/api/files/s/${shortId}`, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(json => {
            const id = json && json.data && json.data.id;
            if (!id) return null;
            return fetch(`${origin}/api/downloads/${id}/via-worker`, { method: 'POST', headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' } })
                .then(res => res.json())
                .then(dl => {
                    const copyUrl = dl && dl.data && dl.data.copyUrl;
                    if (!copyUrl) return null;
                    return { name: 'HindMoviez - GDShine', title: `${meta.title}\n${meta.size || ''}`, url: copyUrl, quality: meta.quality, provider: 'hindmoviez' };
                });
        })
        .catch(() => null);
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[HindMoviez] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

    if (mediaType === 'tv') {
        console.log('[HindMoviez] TV not supported yet, skipping');
        return Promise.resolve([]);
    }

    return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
        if (!mediaInfo.title) return [];
        return search(domain, mediaInfo.title).then(posts => {
            const match = findBestMatch(posts, mediaInfo);
            if (!match) {
                console.log(`[HindMoviez] No matching title found for "${mediaInfo.title}"`);
                return [];
            }
            console.log(`[HindMoviez] Matched: "${match.title.rendered}"`);

            return fetch(match.link, { headers: { 'User-Agent': USER_AGENT } })
                .then(res => res.text())
                .then(html => {
                    const groups = extractMvlinkGroups(cheerio.load(html));
                    if (!groups.length) {
                        console.log('[HindMoviez] No mvlink.blog links found on movie page');
                        return [];
                    }
                    return Promise.all(groups.map(g =>
                        fetch(g.mvlinkHref, { headers: { 'User-Agent': USER_AGENT, Referer: match.link } })
                            .then(res => res.text())
                            .then(mvHtml => {
                                const $$ = cheerio.load(mvHtml);
                                const title = $$('title').text().trim() || match.title.rendered;
                                const sizeMatch = /\(([\d.]+\s*[KMGT]B)\)/i.exec(title);
                                const hshareHref = $$('a[href*="hshare."]').attr('href');
                                if (!hshareHref) return [];
                                return resolveHshareToStreams(hshareHref, {
                                    title,
                                    size: sizeMatch ? sizeMatch[1] : '',
                                    quality: extractQuality(g.heading) !== 'Unknown' ? extractQuality(g.heading) : extractQuality(title)
                                });
                            })
                            .catch(() => [])
                    )).then(perGroup => perGroup.flat());
                });
        });
    }).catch(err => {
        console.log(`[HindMoviez] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams };
