// DaddyLive (DLHD) live-sport provider.
//
// Like providers/f1.js / providers/fullraces.js this is NOT a TMDB-based
// provider: it has no tmdbId/season/episode interface and is not run through
// lib/aggregate.js. addon-server.js uses it directly for a dedicated live
// catalog ('tv' type) with its own `daddylive:` id scheme, so it only ever
// runs server-side in plain Node.
//
// WHAT IT DOES
//   - Scrapes DaddyLive's homepage schedule (today's live sport events, each
//     carrying one or more channel feeds) for the catalog.
//   - Resolves a channel to a direct HLS (.m3u8) URL by walking the player
//     embed chain and decrypting whichever embed family the page uses.
//
// SCOPE (deliberate): only the embed families that yield a DIRECTLY PLAYABLE
// m3u8 with plain request headers are ported - tiestep (_econfig), epiembeds
// (XOR), wideiptv, cdnlivetv, ignite and daddy3. The `dembed` family needs a
// per-request playlist token minted from the edge (a stateful proxy), and the
// hub / livelive24 families are WebM; none of those play from a bare Stremio
// stream URL, so channels that only expose them simply won't resolve here.
// Decrypt logic ported from the maintained TypeScript resolver
// github.com/Lunatic16/daddylive-stream-resolver (MIT), confirmed against the
// live site Nov 2026.
//
// DOMAIN: DaddyLive hops domains often. We follow a stable redirector
// (dlive.sx / thedaddy.pk) to the current canonical host at runtime and cache
// it. Override with the DLHD_BASE env var to pin a specific domain.

const https = require('https');
const http = require('http');
const dns = require('dns');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEED_BASES = ['https://dlive.sx', 'https://thedaddy.pk', 'https://thedaddy.li'];
const BASE_OVERRIDE = (process.env.DLHD_BASE || '').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = 15000;
const BASE_TTL_MS = 1000 * 60 * 60;        // re-discover the live domain hourly
const SCHEDULE_TTL_MS = 1000 * 60 * 2;     // schedule refreshes every 2 min
// Direct-play players only (see SCOPE above). Order = resolve preference.
// casting/player take bare requests; cast needs the embed page as Referer.
const SERVERS = [
    { id: 'casting', label: 'PLAYER 5', referer: false },
    { id: 'player', label: 'PLAYER 6', referer: false },
    { id: 'cast', label: 'PLAYER 2', referer: true }
];

// --- HTTP + DNS bypass -----------------------------------------------------
// DaddyLive's current canonical host (thedaddy.li) is NXDOMAIN on some ISP /
// router resolvers even though it resolves fine on public DNS. So we resolve
// every DaddyLive host ourselves through a public resolver (Cloudflare, then
// Google) and hand the IP to the TLS socket via the `lookup` option. This is
// a DNS override, NOT a TLS bypass: the SNI and certificate are still checked
// against the real hostname. Override the resolver list with DLHD_DNS (comma-
// separated), or set DLHD_DNS=system to fall back to the OS resolver.

const DNS_SERVERS = (process.env.DLHD_DNS || '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean);
const USE_SYSTEM_DNS = (process.env.DLHD_DNS || '').toLowerCase() === 'system';
const resolver = new dns.Resolver();
if (!USE_SYSTEM_DNS) { try { resolver.setServers(DNS_SERVERS); } catch (e) { /* keep defaults */ } }
const dnsCache = new Map();
const DNS_TTL_MS = 1000 * 60 * 30;

function customLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    if (USE_SYSTEM_DNS) return dns.lookup(hostname, options, cb);
    // Honour Node's `all` contract: when set, the callback takes an array of
    // { address, family }; otherwise (address, family). Getting this wrong
    // yields "Invalid IP address: undefined" from the socket layer.
    const deliver = (address, family) => (options.all ? cb(null, [{ address, family }]) : cb(null, address, family));
    const hit = dnsCache.get(hostname);
    if (hit && Date.now() - hit.at < DNS_TTL_MS) return process.nextTick(() => deliver(hit.address, hit.family));
    resolver.resolve4(hostname, (e4, a4) => {
        if (!e4 && a4 && a4.length) { dnsCache.set(hostname, { address: a4[0], family: 4, at: Date.now() }); return deliver(a4[0], 4); }
        resolver.resolve6(hostname, (e6, a6) => {
            if (!e6 && a6 && a6.length) { dnsCache.set(hostname, { address: a6[0], family: 6, at: Date.now() }); return deliver(a6[0], 6); }
            dns.lookup(hostname, options, cb); // last resort: OS resolver
        });
    });
}

// One raw request (no redirect following). Resolves { status, headers, body }.
function request(url, referer) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { return reject(e); }
        const mod = u.protocol === 'http:' ? http : https;
        const headers = {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/json,*/*',
            'Accept-Encoding': 'identity'
        };
        if (referer) headers.Referer = referer;
        const req = mod.request({
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: (u.pathname || '/') + (u.search || ''),
            method: 'GET',
            headers,
            servername: u.hostname,
            lookup: customLookup
        }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`timeout for ${url}`)));
        req.end();
    });
}

// GET with redirect following; throws on a non-2xx final response.
async function fetchText(url, referer) {
    let current = url, ref = referer, res;
    for (let i = 0; i < 6; i++) {
        res = await request(current, ref);
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
            ref = current;
            current = new URL(res.headers.location, current).href;
            continue;
        }
        break;
    }
    if (!res || res.status < 200 || res.status >= 400) throw new Error(`HTTP ${res ? res.status : '?'} for ${current}`);
    return res.body;
}

// --- Live-domain discovery -------------------------------------------------

let baseCache = { url: null, at: 0, inflight: null };

function followRedirects(url, depth) {
    if (depth > 5) return Promise.resolve(url);
    return request(url).then((res) => {
        const loc = res.headers.location;
        if (res.status >= 300 && res.status < 400 && loc) {
            return followRedirects(new URL(loc, url).href, depth + 1);
        }
        return url;
    });
}

function discoverBase() {
    if (BASE_OVERRIDE) return Promise.resolve(BASE_OVERRIDE);
    if (baseCache.url && Date.now() - baseCache.at < BASE_TTL_MS) return Promise.resolve(baseCache.url);
    if (baseCache.inflight) return baseCache.inflight;
    const trySeed = (i) => {
        if (i >= SEED_BASES.length) throw new Error('no reachable DaddyLive domain');
        return followRedirects(SEED_BASES[i] + '/', 0)
            .then((finalUrl) => new URL(finalUrl).origin)
            .catch(() => trySeed(i + 1));
    };
    baseCache.inflight = trySeed(0).then((origin) => {
        baseCache = { url: origin, at: Date.now(), inflight: null };
        return origin;
    }).catch((err) => { baseCache.inflight = null; throw err; });
    return baseCache.inflight;
}

// --- Schedule scraping -----------------------------------------------------
// The homepage holds schedule__day > schedule__category > schedule__event
// blocks; some categories are lazy-loaded from a data-endpoint that returns
// { html }. Ported from the resolver's events/parse.ts.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
    return String(text || '')
        .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
        .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
        .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] || m);
}
const stripTags = (h) => String(h || '').replace(/<[^>]+>/g, '');
const cleanText = (h) => decodeEntities(stripTags(h)).replace(/\s+/g, ' ').trim();

function sliceBlocks(html, re) {
    const starts = [];
    for (const m of html.matchAll(re)) starts.push(m.index || 0);
    return starts.map((s, i) => html.slice(s, i + 1 < starts.length ? starts[i + 1] : undefined));
}

function parseChannels(block) {
    const channels = [];
    for (const m of block.matchAll(/<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const path = m[1];
        const name = cleanText(m[2]) || cleanText((m[0].match(/\btitle="([^"]*)"/i) || [])[1] || '');
        if (!name) continue;
        const idm = path.match(/\/watch\.php\?id=(\d+)/i);
        const cid = idm ? Number(idm[1]) : 0;
        if (cid > 0) channels.push({ name, channel: cid }); // id 0 = placeholder
    }
    return channels;
}

function parseEvents(slice) {
    const events = [];
    for (const block of sliceBlocks(slice, /<div class="schedule__event["\s]/g)) {
        const time = ((block.match(/data-time="([^"]*)"/i) || [])[1] || '').trim();
        const title = cleanText((block.match(/class="schedule__eventTitle"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '');
        if (!time && !title) continue;
        const channels = parseChannels(block);
        if (channels.length) events.push({ time, title, channels });
    }
    return events;
}

function parseCategories(slice) {
    const cats = [];
    for (const block of sliceBlocks(slice, /<div class="schedule__category["\s]/g)) {
        const events = parseEvents(block);
        if (!events.length) continue;
        const name = cleanText((block.match(/class="[^"]*card__meta[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
        cats.push({ name: name || 'Events', events });
    }
    return cats;
}

function parseScheduleDays(html) {
    const days = [];
    for (const block of sliceBlocks(html, /<div class="schedule__day["\s]/g)) {
        const categories = parseCategories(block);
        if (categories.length) days.push({ categories });
    }
    return days;
}

function parseHomeSections(html) {
    const sections = [];
    for (const block of sliceBlocks(html, /<section\b[^>]*>/g)) {
        const endpoint = (block.match(/data-endpoint="([^"]*)"/i) || [])[1] || null;
        sections.push({ endpoint, days: parseScheduleDays(block) });
    }
    return sections;
}

function parseSchedulePayload(text) {
    let payload;
    try { payload = JSON.parse(text); } catch { return []; }
    const html = payload && payload.html;
    if (typeof html !== 'string' || !html.includes('schedule__day')) return [];
    return parseScheduleDays(html);
}

// Categories that aren't live sport feeds we want to surface.
const SKIP_CATEGORY_RE = /tv shows?|24\/?7/i;

let scheduleCache = { at: 0, byChannel: null, events: null, inflight: null };

function crawlSchedule() {
    return discoverBase().then((base) =>
        fetchText(base + '/', base + '/').then((home) => {
            const sections = parseHomeSections(home);
            return Promise.all(sections.map((s) =>
                s.endpoint
                    ? fetchText(base + s.endpoint, base + '/').then(parseSchedulePayload).catch(() => [])
                    : Promise.resolve(s.days)
            )).then((perSection) => {
                // Flatten into a de-duplicated list of events; keep each
                // event's channel feeds, and index channelId -> event.
                const events = [];
                const byChannel = new Map();
                const seenEvent = new Set();
                perSection.forEach((days) => {
                    days.forEach((day) => {
                        day.categories.forEach((cat) => {
                            if (SKIP_CATEGORY_RE.test(cat.name)) return;
                            cat.events.forEach((ev) => {
                                const key = `${ev.time}|${ev.title}`;
                                if (seenEvent.has(key)) return;
                                seenEvent.add(key);
                                const entry = { time: ev.time, title: ev.title, category: cat.name, channels: ev.channels };
                                events.push(entry);
                                ev.channels.forEach((ch) => {
                                    if (!byChannel.has(ch.channel)) byChannel.set(ch.channel, { event: entry, channelName: ch.name });
                                });
                            });
                        });
                    });
                });
                return { events, byChannel };
            });
        })
    );
}

function getSchedule() {
    if (scheduleCache.byChannel && Date.now() - scheduleCache.at < SCHEDULE_TTL_MS) {
        return Promise.resolve(scheduleCache);
    }
    if (scheduleCache.inflight) return scheduleCache.inflight;
    scheduleCache.inflight = crawlSchedule().then((data) => {
        scheduleCache = { at: Date.now(), byChannel: data.byChannel, events: data.events, inflight: null };
        return scheduleCache;
    }).catch((err) => {
        scheduleCache.inflight = null;
        console.log(`[DaddyLive] Schedule crawl failed: ${err.message}`);
        // Serve stale data if we have any, else empty.
        return scheduleCache.byChannel ? scheduleCache : { events: [], byChannel: new Map() };
    });
    return scheduleCache.inflight;
}

// --- Embed decrypt (direct-play families) ----------------------------------

function tryBuffer(b64, enc) { try { return Buffer.from(b64, enc).toString('utf8'); } catch { return null; } }

// tiestep: window._econfig = '<b64>' -> reordered base64 JSON { stream_url }.
function decryptEconfig(b64) {
    if (!b64) return null;
    const raw = Buffer.from(b64, 'base64').toString('binary');
    const PARTS = 4, ORDER = [2, 0, 3, 1];
    const chunkSize = Math.ceil(raw.length / PARTS);
    const chunks = [];
    for (let i = 0, off = 0; i < PARTS; i++, off += chunkSize) chunks.push(raw.slice(off, off + chunkSize));
    const reordered = [];
    for (let i = 0; i < ORDER.length; i++) {
        const piece = chunks[i].slice(0, 3) + chunks[i].slice(4);
        reordered[ORDER[i]] = Buffer.from(piece, 'base64').toString('binary');
    }
    try {
        const json = Buffer.from(reordered.join(''), 'base64').toString('utf8');
        const cfg = JSON.parse(json);
        if (!cfg.stream_url && !cfg.stream_url_nop2p) return null;
        return cfg;
    } catch { return null; }
}
function econfigUrl(cfg) {
    if (cfg.p2p === false || cfg.url_nop2p) return cfg.stream_url_nop2p || cfg.stream_url;
    return cfg.stream_url || cfg.stream_url_nop2p || '';
}
function extractTiestep(html) {
    const b64 = (html.match(/window\._econfig\s*=\s*'([^']+)'/) || [])[1];
    if (!b64) return null;
    const cfg = decryptEconfig(b64);
    if (!cfg) return null;
    const url = econfigUrl(cfg);
    return url.includes('.m3u8') ? url : null;
}

// epiembeds: XOR-encoded char arrays, or plain SIGNED_URL/url in the script.
function deobfuscateXor(html) {
    const dec = (nums, xor, sub) => nums.map((n) => String.fromCharCode(((n ^ xor) - sub + 256) & 255)).join('');
    let m = html.match(/var\s+_gr\w+=\[([0-9,\s]+)\],_mz\d+=(\d+),_mz\d+=(\d+)/);
    if (m) return dec(m[1].split(',').map((n) => Number(n.trim())), Number(m[2]), Number(m[3]));
    m = html.match(/var\s+_\w+=\[([^\]]+)\],_\w+=(\d+),_\w+=(\d+)/);
    if (!m) return null;
    return dec(m[1].split(',').map((n) => Number(n.trim())), Number(m[2]), Number(m[3]));
}
function m3u8FromText(src) {
    return (src.match(/SIGNED_URL\s*=\s*"([^"]+\.m3u8[^"]*)"/) || [])[1]
        || (src.match(/url\s*=\s*"([^"]+\.m3u8[^"]*)"/) || [])[1]
        || (src.match(/https:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/) || [])[0] || null;
}
function extractEpiembeds(html) {
    return m3u8FromText(deobfuscateXor(html) || html);
}

// wideiptv: streamUrl: "..." (escaped slashes).
function extractWideiptv(html) {
    const raw = (html.match(/streamUrl:\s*"((?:\\\/|[^"])+)"/) || [])[1];
    return raw ? raw.replace(/\\\//g, '/') : null;
}

// cdnlivetv: url assembled from atob() of several var chunks.
function extractCdnLiveTv(html) {
    const decoder = (html.match(/function (\w+)\(s\)\{[^}]*atob/) || [])[1];
    if (!decoder) return null;
    const assign = html.match(new RegExp(`var (\\w+)=((?:${decoder}\\(\\w+\\)\\+?)+);\\s*var _p2pMode`));
    if (!assign) return null;
    const vars = new Map();
    for (const m of html.matchAll(/var (\w+)='([A-Za-z0-9+/=_-]+)'/g)) vars.set(m[1], m[2]);
    const decodeChunk = (v) => {
        const padded = v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '=');
        return Buffer.from(padded, 'base64').toString('utf8');
    };
    const url = [...assign[2].matchAll(new RegExp(`${decoder}\\((\\w+)\\)`, 'g'))]
        .map((p) => decodeChunk(vars.get(p[1]) || '')).join('');
    return url.includes('.m3u8') ? url : null;
}

// ignite: player.load({source: fn()}) where fn() returns a char array + span.
function extractIgnite(html) {
    const fn = (html.match(/player\.load\(\{source:\s*(\w+)\(\)/) || [])[1];
    if (!fn) return null;
    const body = (html.match(new RegExp(`function ${fn}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`)) || [])[1];
    if (!body) return null;
    const chars = (body.match(/return\(\[([^\]]+)\]/) || [])[1];
    if (!chars) return null;
    const base = [...chars.matchAll(/"([^"]*)"/g)].map((p) => p[1]).join('');
    const spanId = (body.match(/getElementById\("([^"]+)"\)/) || [])[1];
    const span = spanId ? ((html.match(new RegExp(`id=["']${spanId}["'][^>]*>([^<]*)`)) || [])[1] || '') : '';
    const url = (base + span).replace(/\\\//g, '/');
    return url.startsWith('http') && url.includes('.m3u8') ? url : null;
}

// daddy3: atob('<b64 url>') or a /three/secure/.../index.m3u8 literal.
function extractDaddy3(html) {
    const b64 = (html.match(/atob\('([^']+)'\)/) || [])[1];
    if (b64) {
        const url = tryBuffer(b64, 'base64');
        if (url && url.startsWith('http') && url.includes('.m3u8')) return url;
    }
    return (html.match(/https:\/\/[^"'`\s]+\/three\/secure\/[0-9a-f]{32}\/\d+\/premium\d+\/index\.m3u8/) || [])[0] || null;
}

function extractPlayable(html) {
    return extractTiestep(html) || extractEpiembeds(html) || extractWideiptv(html)
        || extractCdnLiveTv(html) || extractIgnite(html) || extractDaddy3(html) || null;
}

function htmlMayContainPlayable(html) {
    return /#EXTM3U|SIGNED_URL|window\._econfig|streamUrl:|var _\w+=\[|var\s+_gr\w+=\[|function \w+\(s\)\{[^}]*atob|player\.load\(\{source:|https:\/\/[^"'`\s]+\.m3u8/.test(html);
}

function extractEmbedUrl(html) {
    const m = html.match(/<iframe[^>]+id="thatframe"[^>]+src="([^"]+)"|<iframe[^>]+src="([^"]+)"[^>]+id="thatframe"/i);
    if (m) return m[1] || m[2] || null;
    const vids = [...html.matchAll(/<iframe[^>]+class="[^"]*video[^"]*"[^>]+src="([^"]+)"|<iframe[^>]+src="([^"]+)"[^>]+class="[^"]*video[^"]*"/gi)];
    if (!vids.length) return null;
    const last = vids[vids.length - 1];
    return last[1] || last[2] || null;
}

function innerFrameUrl(html, baseUrl) {
    const src = ((html.match(/<iframe[^>]+src="([^"]+)"/i) || [])[1] || '').trim();
    if (!src || /\+|'|window\.|javascript:|about:|data:/i.test(src)) return null;
    try {
        const url = new URL(src, baseUrl);
        return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
    } catch { return null; }
}

// Walk the embed -> inner-iframe chain until a page that may hold a playable.
function followEmbedChain(embedUrl, html) {
    let current = html, referer = embedUrl, depth = 0;
    const step = () => {
        if (htmlMayContainPlayable(current) || depth >= 6) return Promise.resolve({ html: current, referer });
        const frame = innerFrameUrl(current, referer);
        if (!frame) return Promise.resolve({ html: current, referer });
        depth++;
        return fetchText(frame, referer).then((next) => { current = next; referer = frame; return step(); });
    };
    return step();
}

// --- Public API ------------------------------------------------------------

// Resolve one channelId to direct-play HLS streams (one per working player).
function getChannelStreams(channelId) {
    return discoverBase().then((base) => {
        const watch = `${base}/watch.php?id=${channelId}`;
        const results = [];
        const seenUrls = new Set();
        const tryServer = (i) => {
            if (i >= SERVERS.length) return results;
            const srv = SERVERS[i];
            const pageUrl = `${base}/${srv.id}/stream-${channelId}.php`;
            return fetchText(pageUrl, watch)
                .then((pageHtml) => {
                    const embed = extractEmbedUrl(pageHtml);
                    if (!embed) throw new Error('no embed iframe');
                    const embedUrl = new URL(embed, pageUrl).href;
                    return fetchText(embedUrl, pageUrl).then((embedHtml) => followEmbedChain(embedUrl, embedHtml));
                })
                .then(({ html, referer }) => {
                    const url = extractPlayable(html);
                    if (url && !seenUrls.has(url)) {
                        seenUrls.add(url);
                        const headers = { 'User-Agent': UA };
                        if (srv.referer) {
                            headers.Referer = referer;
                            try { headers.Origin = new URL(referer).origin; } catch { /* ignore */ }
                        }
                        results.push({ name: `DaddyLive ${srv.label}`, url, quality: 'Live (HLS)', headers });
                    }
                })
                .catch((err) => { console.log(`[DaddyLive] ${srv.id} ch${channelId}: ${err.message}`); })
                .then(() => tryServer(i + 1));
        };
        return Promise.resolve(tryServer(0)).then(() => results);
    }).catch((err) => {
        console.log(`[DaddyLive] getChannelStreams(${channelId}) failed: ${err.message}`);
        return [];
    });
}

// Catalog: one entry per scheduled sport event (keyed by its primary channel).
function listSportEvents() {
    return getSchedule().then(({ events }) =>
        (events || [])
            .filter((ev) => ev.channels && ev.channels.length)
            .map((ev) => {
                const primary = ev.channels[0];
                return {
                    id: primary.channel,
                    title: ev.title || primary.name,
                    time: ev.time,
                    category: ev.category,
                    channels: ev.channels
                };
            })
    );
}

// Meta for one channelId (looked up in the cached schedule).
function getEvent(channelId) {
    return getSchedule().then(({ byChannel }) => {
        const hit = byChannel && byChannel.get(Number(channelId));
        if (!hit) return null;
        return {
            id: Number(channelId),
            title: hit.event.title || hit.channelName,
            time: hit.event.time,
            category: hit.event.category,
            channelName: hit.channelName
        };
    });
}

module.exports = {
    discoverBase,
    listSportEvents,
    getEvent,
    getChannelStreams,
    // exported for isolated testing against saved HTML:
    _parse: { parseHomeSections, parseScheduleDays, extractPlayable, extractEmbedUrl, decryptEconfig }
};
