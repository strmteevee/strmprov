// Shared HubCloud extraction logic. HubCloud (hubcloud.ist and its many
// domain aliases - hubcloud.cx/.fans/etc, all the same backend) is a common
// download intermediate that several Indian movie-site scrapers in this repo
// route through. Originally implemented only inside providers/4khdhub.js;
// factored out here once a second and third provider (movies4u, hindmoviez)
// needed the identical logic, rather than copy-pasting it a third time.
//
// Two page shapes were confirmed live to both funnel into the same final
// "download options" page:
//   - hubcloud.ist/drive/<id>  - embeds a `var url = '...'` JS redirect
//   - hubcloud.ist/video/<id>  - has a plain <a href> to a *ıhubcloud.php
//     gateway (domain rotates: gamerxyt.com, sportverse.cc, ... confirmed
//     both live) instead of a JS variable
// findFinalLinksUrl tries both so callers don't need to know which shape
// they're looking at.
//
// The final "download options" page itself was confirmed live (movies4u,
// 2026-09-18) to consistently offer some subset of: "Download [Server :
// 10Gbps]" (a gamerxyt.com/dl.php?link=<real-url> redirect - often landing
// on a video-downloads.googleusercontent.com Google Drive link, which
// lib/aggregate.js's dropUnplayable already live-probes for real seekability
// rather than assuming), "Download [PixelServer:N]" (a pixeldrain.dev direct
// link), and "Download [FSLv2 Server]" (a pre-signed Cloudflare R2 URL,
// confirmed live to answer a ranged GET with a real 206 even though a HEAD
// request 403s - the signed URL only permits the methods it was signed for).

const cheerio = require('cheerio');

function parseBytes(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const match = String(val).match(/^([0-9.]+)\s*([a-zA-Z]+)$/);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    let multiplier = 1;
    if (unit.indexOf('k') === 0) multiplier = 1024;
    else if (unit.indexOf('m') === 0) multiplier = 1024 * 1024;
    else if (unit.indexOf('g') === 0) multiplier = 1024 * 1024 * 1024;
    else if (unit.indexOf('t') === 0) multiplier = 1024 * 1024 * 1024 * 1024;
    return num * multiplier;
}

function formatBytes(val) {
    if (!val) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(val) / Math.log(k));
    return parseFloat((val / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function findFinalLinksUrl(redirectHtml) {
    const varMatch = redirectHtml.match(/var url ?= ?'(.*?)'/);
    if (varMatch) return varMatch[1];
    const $ = cheerio.load(redirectHtml);
    return $('a[href*="hubcloud.php"]').attr('href') || null;
}

function resolveHubCloudFinalLink(url, userAgent) {
    return fetch(url, { headers: { 'User-Agent': userAgent } })
        .then(response => {
            const finalUrl = response.url || url;
            try {
                const link = new URL(finalUrl).searchParams.get('link');
                if (link) return link;
            } catch (e) { /* not a URL with a link= param - fall through */ }
            return finalUrl;
        })
        .catch(() => null);
}

// hubCloudUrl: a hubcloud.* /drive/<id> or /video/<id> URL.
// baseMeta: {bytes, height, title} carried through from the caller's own
// page scrape - overridden by whatever the download-options page itself
// states (its own title/size are more likely to match the exact file).
function extractHubCloud(hubCloudUrl, baseMeta, opts) {
    const options = opts || {};
    const userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const log = options.log || (() => {});
    if (!hubCloudUrl) return Promise.resolve([]);

    return fetch(hubCloudUrl, { headers: { 'User-Agent': userAgent, Referer: hubCloudUrl } })
        .then(res => res.text())
        .catch(() => null)
        .then(redirectHtml => {
            if (!redirectHtml) return [];
            const finalLinksUrl = findFinalLinksUrl(redirectHtml);
            if (!finalLinksUrl) {
                log(`No redirect target found on ${hubCloudUrl}`);
                return [];
            }
            return fetch(finalLinksUrl, { headers: { 'User-Agent': userAgent, Referer: hubCloudUrl } })
                .then(res => res.text())
                .catch(() => null)
                .then(linksHtml => {
                    if (!linksHtml) return [];
                    const $ = cheerio.load(linksHtml);
                    const results = [];
                    const sizeText = $('#size').text();
                    const titleText = $('title').text().trim();
                    const currentMeta = Object.assign({}, baseMeta, {
                        bytes: parseBytes(sizeText) || baseMeta.bytes,
                        title: titleText || baseMeta.title
                    });
                    $('a').each((_, el) => {
                        const text = $(el).text().trim();
                        const href = $(el).attr('href');
                        if (!href) return;
                        if (text.includes('10Gbps') || text.includes('PixelServer')) {
                            results.push({ source: text.includes('PixelServer') ? 'PixelServer' : 'HubCloud 10Gbps', url: href, meta: currentMeta });
                        } else if (text.includes('Download File') || href.includes('r2.dev')) {
                            results.push({ source: 'Direct R2', url: href, meta: currentMeta });
                        } else if (text.includes('FSL')) {
                            results.push({ source: 'FSL', url: href, meta: currentMeta });
                        } else if (href.includes('r2.cloudflarestorage.com')) {
                            results.push({ source: 'FSL', url: href, meta: currentMeta });
                        }
                    });
                    return Promise.all(results.map(r => {
                        if (r.source !== 'HubCloud 10Gbps') return r;
                        return resolveHubCloudFinalLink(r.url, userAgent).then(link => {
                            if (!link) {
                                log('Could not resolve final link for HubCloud 10Gbps, dropping');
                                return null;
                            }
                            return Object.assign({}, r, { url: link });
                        });
                    })).then(resolved => resolved.filter(Boolean));
                });
        });
}

module.exports = { extractHubCloud, resolveHubCloudFinalLink, findFinalLinksUrl, parseBytes, formatBytes };
