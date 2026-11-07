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
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEED_BASES = ['https://dlive.sx', 'https://thedaddy.pk', 'https://thedaddy.li'];
const BASE_OVERRIDE = (process.env.DLHD_BASE || '').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = 15000;
const BASE_TTL_MS = 1000 * 60 * 60;        // re-discover the live domain hourly
const SCHEDULE_TTL_MS = 1000 * 60 * 2;     // schedule refreshes every 2 min
// DaddyLive lists schedule times in UK (Europe/London) wall-clock. We convert
// to a target timezone for display - defaults to Europe/Amsterdam, override
// with env DLHD_TZ (e.g. the Pi's own zone). Handles DST on both sides.
const SRC_TZ = 'Europe/London';
const TARGET_TZ = process.env.DLHD_TZ || process.env.STRMPROV_TZ || 'Europe/Amsterdam';
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

// Stream hosts answer bursts with 429 (tossequip.net did, confirmed 2026-11-07),
// and an event can have 30 feeds of 3 players each. So: a few at a time per host.
const HOST_LIMIT = 6;
const hostSlots = new Map(); // host -> { active, waiting: [run] }
function withHostSlot(host, fn) {
    if (!hostSlots.has(host)) hostSlots.set(host, { active: 0, waiting: [] });
    const slot = hostSlots.get(host);
    return new Promise((resolve, reject) => {
        const run = () => {
            slot.active++;
            fn().then(resolve, reject).then(() => {
                slot.active--;
                const next = slot.waiting.shift();
                if (next) next();
            });
        };
        if (slot.active < HOST_LIMIT) run(); else slot.waiting.push(run);
    });
}

// One raw request (no redirect following). Resolves { status, headers, body }.
function request(url, referer) {
    let host;
    try { host = new URL(url).hostname; } catch (e) { return Promise.reject(e); }
    return withHostSlot(host, () => rawRequest(url, referer));
}

function rawRequest(url, referer) {
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

const RETRY_429_MAX_S = 4;

// GET with redirect following; throws on a non-2xx final response.
async function fetchText(url, referer) {
    let current = url, ref = referer, res, retried = false;
    for (let i = 0; i < 6; i++) {
        res = await request(current, ref);
        if (res.status === 429 && !retried) {
            retried = true;
            const waitS = Math.min(Number(res.headers['retry-after']) || 1.5, RETRY_429_MAX_S);
            await new Promise((done) => setTimeout(done, waitS * 1000));
            i--;
            continue;
        }
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
        // A blocked/erroring hop (e.g. a 403 from a filter) is not a usable
        // base - fail so discovery tries the next seed instead of caching it.
        if (res.status >= 400) throw new Error(`HTTP ${res.status} at ${url}`);
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

function parseEvents(slice, date) {
    const events = [];
    for (const block of sliceBlocks(slice, /<div class="schedule__event["\s]/g)) {
        const time = ((block.match(/data-time="([^"]*)"/i) || [])[1] || '').trim();
        const title = cleanText((block.match(/class="schedule__eventTitle"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '');
        if (!time && !title) continue;
        const channels = parseChannels(block);
        if (channels.length) events.push({ time, date, title, channels });
    }
    return events;
}

function parseCategories(slice, date) {
    const cats = [];
    for (const block of sliceBlocks(slice, /<div class="schedule__category["\s]/g)) {
        const events = parseEvents(block, date);
        if (!events.length) continue;
        const name = cleanText((block.match(/class="[^"]*card__meta[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
        cats.push({ name: name || 'Events', events });
    }
    return cats;
}

function parseScheduleDays(html) {
    const days = [];
    for (const block of sliceBlocks(html, /<div class="schedule__day["\s]/g)) {
        const title = cleanText((block.match(/class="schedule__dayTitle"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
        const date = parseDayDate(title);
        const categories = parseCategories(block, date);
        if (categories.length) days.push({ date, categories });
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

// --- Timezone conversion (UK schedule time -> TARGET_TZ) -------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "Saturday 7th Nov 2026 - Schedule Time UK GMT" / "Saturday, November 7, 2026"
// -> "2026-11-07". Returns null when no date is recognisable.
function parseDayDate(title) {
    const iso = (y, m, d) => (m >= 0 && d >= 1 && d <= 31 && y >= 2000)
        ? `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
    let m = String(title || '').match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?\s+(\d{4})/);
    if (m) return iso(Number(m[3]), MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)), Number(m[1]));
    m = String(title || '').match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
    if (m) return iso(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)), Number(m[2]));
    return null;
}

// Offset (ms) of `tz` relative to UTC at a given instant.
function tzOffsetMs(instantMs, tz) {
    const parts = {};
    new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(instantMs)).forEach((p) => { parts[p.type] = p.value; });
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return asUtc - instantMs;
}

// UTC instant of a wall-clock time in `tz` (two passes cover DST edges).
function wallTimeToUtc(y, mo, d, h, mi, tz) {
    const guess = Date.UTC(y, mo, d, h, mi);
    const first = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(first, tz);
}

// UK "HH:MM" on `dateStr` (YYYY-MM-DD, or today when missing) -> { time, ts }
// in TARGET_TZ. Unparseable times pass through unchanged.
function convertUkTime(dateStr, hhmm) {
    const tm = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
    if (!tm) return { time: hhmm || '', ts: 0 };
    let y, mo, d;
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (dm) { y = +dm[1]; mo = +dm[2] - 1; d = +dm[3]; } else {
        // "today" as seen in the UK, so a late-evening event isn't shifted a day.
        const p = {};
        new Intl.DateTimeFormat('en-US', { timeZone: SRC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
        y = +p.year; mo = +p.month - 1; d = +p.day;
    }
    const ts = wallTimeToUtc(y, mo, d, +tm[1], +tm[2], SRC_TZ);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: TARGET_TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
        .format(new Date(ts));
    return { time, ts };
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
                const byKey = new Map();
                perSection.forEach((days) => {
                    days.forEach((day) => {
                        day.categories.forEach((cat) => {
                            if (SKIP_CATEGORY_RE.test(cat.name)) return;
                            cat.events.forEach((ev) => {
                                // Stable per-event key: one channel carries many
                                // events a day, so the channel alone can't be the id.
                                const key = crypto.createHash('sha1')
                                    .update(`${ev.date || ''}|${ev.time}|${ev.title}`).digest('hex').slice(0, 10);
                                if (byKey.has(key)) return;
                                const local = convertUkTime(ev.date, ev.time);
                                const entry = {
                                    key,
                                    time: local.time,       // display time in TARGET_TZ
                                    ts: local.ts,           // UTC start instant (0 if unknown)
                                    ukTime: ev.time,        // original schedule value
                                    title: ev.title,
                                    category: cat.name,
                                    channels: ev.channels
                                };
                                events.push(entry);
                                byKey.set(key, entry);
                                ev.channels.forEach((ch) => {
                                    if (!byChannel.has(ch.channel)) byChannel.set(ch.channel, { event: entry, channelName: ch.name });
                                });
                            });
                        });
                    });
                });
                return { events, byChannel, byKey };
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
        scheduleCache = { at: Date.now(), byChannel: data.byChannel, byKey: data.byKey, events: data.events, inflight: null };
        return scheduleCache;
    }).catch((err) => {
        scheduleCache.inflight = null;
        baseCache = { url: null, at: 0, inflight: null }; // re-discover next time
        console.log(`[DaddyLive] Schedule crawl failed: ${err.message}`);
        // Serve stale data if we have any, else empty.
        return scheduleCache.byChannel ? scheduleCache : { events: [], byChannel: new Map(), byKey: new Map() };
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

// An event usually has several feeds (channels, often different broadcasters
// or languages); each feed has up to three direct-play players. All
// (feed, player) pairs are resolved in parallel, capped at MAX_FEEDS feeds,
// and whatever has resolved by STREAM_DEADLINE_MS is returned.
const MAX_FEEDS = 30;
const STREAM_DEADLINE_MS = 20000;

// One player of one channel -> { url, headers }, or null when it has no playable
// stream. Rejects when the lookup itself failed.
function playerStream(base, channelId, srv) {
    const watch = `${base}/watch.php?id=${channelId}`;
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
            if (!url) return null;
            const headers = { 'User-Agent': UA };
            if (srv.referer) {
                headers.Referer = referer;
                try { headers.Origin = new URL(referer).origin; } catch { /* ignore */ }
            }
            return { url, headers };
        });
}

function resolvePlayer(base, channelId, srv) {
    return playerStream(base, channelId, srv)
        .catch((err) => { console.log(`[DaddyLive] ${srv.id} ch${channelId}: ${err.message}`); return null; });
}

// feeds: [{ channel, name }] -> streams, ordered by feed then player.
function resolveFeeds(feeds) {
    return discoverBase().then((base) => {
        const found = [];
        const jobs = [];
        feeds.slice(0, MAX_FEEDS).forEach((feed, fi) => {
            SERVERS.forEach((srv, si) => {
                jobs.push(resolvePlayer(base, feed.channel, srv).then((r) => {
                    if (r) found.push({ order: fi * SERVERS.length + si, feed, srv, r });
                }));
            });
        });
        let timer;
        const deadline = new Promise((res) => { timer = setTimeout(res, STREAM_DEADLINE_MS); });
        return Promise.race([Promise.all(jobs), deadline]).then(() => {
            clearTimeout(timer);
            const seen = new Set();
            return found.sort((a, b) => a.order - b.order)
                .filter((x) => (seen.has(x.r.url) ? false : (seen.add(x.r.url), true)))
                .map((x) => ({
                    name: `DaddyLive ${x.srv.label}`,
                    url: x.r.url,
                    quality: [x.feed.name, 'Live (HLS)'].filter(Boolean).join(' · '),
                    headers: x.r.headers
                }));
        });
    }).catch((err) => {
        console.log(`[DaddyLive] resolveFeeds failed: ${err.message}`);
        return [];
    });
}

// What's live on `channel` now: if several, the one that started last.
function liveEventOn(sched, channel) {
    const now = Date.now();
    return (sched.events || [])
        .filter((ev) => ev.channels && ev.channels.some((f) => f.channel === channel))
        .map((ev) => withStatus(ev, now))
        .filter((ev) => ev.status === 'live')
        .sort((a, b) => b.start - a.start)[0] || null;
}

// A channel only shows an event from around its start until the next event
// scheduled on that same channel begins. Before that it shows something else,
// often another sport, so its stream isn't a source for this event yet.
const PRE_START_MS = 15 * 60 * 1000; // pre-match build-up
function feedsOnAir(ev, events, now) {
    const channels = ev.channels || [];
    if (!ev.ts) return channels; // no known start: nothing to go on
    if (ev.ts > now + PRE_START_MS || now >= ev.ts + eventLengthMs(ev)) return [];
    return channels.filter((feed) => !events.some((other) => other.ts > ev.ts && other.ts <= now
        && (other.channels || []).some((c) => c.channel === feed.channel)));
}

// id part "<channel>:<eventKey>" -> streams for the feeds that can be showing
// that event now; falls back to just the channel if the event is gone. A bare
// "<channel>" (a channel in
// the guide) -> that channel first, then the other feeds of what's live on it.
function getChannelStreams(idPart) {
    const [chStr, key] = String(idPart).split(':');
    const channel = parseInt(chStr, 10);
    return getSchedule().then((sched) => {
        const ev = key ? (sched.byKey ? sched.byKey.get(key) : null) : liveEventOn(sched, channel);
        // An event picked by id only offers what can be showing it right now.
        if (key && ev) {
            const onAir = feedsOnAir(ev, sched.events || [], Date.now());
            return onAir.length ? resolveFeeds(onAir) : [];
        }
        let feeds = ev && ev.channels && ev.channels.length ? ev.channels.slice() : [];
        if (!key) feeds.sort((a, b) => (b.channel === channel) - (a.channel === channel));
        if (Number.isFinite(channel) && channel > 0 && !feeds.some((f) => f.channel === channel)) {
            const known = sched.byChannel && sched.byChannel.get(channel);
            feeds.unshift({ channel, name: known ? known.channelName : '' });
        }
        if (!feeds.length) return [];
        return resolveFeeds(feeds);
    });
}

// DaddyLive only gives a start time, so how long an event runs is an estimate:
// past it the channel has usually moved on, often to another sport, even with
// nothing else scheduled on it. A session type in the title goes first, then
// the sport (the title's leading emoji if it has one, else the category), else
// DEFAULT_LENGTH_MS.
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LENGTH_MS = 3 * HOUR_MS;
const SESSION_LENGTHS = [
    [/\bfree practice\b|\bpractice\b|\bfp\d\b|warm[- ]?up/i, 1 * HOUR_MS],
    [/\bqualifying\b/i, 1.25 * HOUR_MS],
    [/\bsprint\b/i, 1 * HOUR_MS]
];
const SPORT_LENGTHS = [
    [/⚽|soccer/i, 2.5 * HOUR_MS],
    [/🏀|basketball/i, 2.5 * HOUR_MS],
    [/🏉|rugby/i, 2.5 * HOUR_MS]
];
function eventLengthMs(ev) {
    const title = String(ev.title || '');
    const session = SESSION_LENGTHS.find(([pattern]) => pattern.test(title));
    if (session) return session[1];
    const lead = (title.match(/^[^\p{L}\p{N}]+/u) || [''])[0];
    const sportText = /\p{Extended_Pictographic}/u.test(lead) ? lead : String(ev.category || '');
    const sport = SPORT_LENGTHS.find(([pattern]) => pattern.test(sportText));
    return sport ? sport[1] : DEFAULT_LENGTH_MS;
}

// Whether a channel has a stream we can play is found out in the background, so
// the guide can leave out what has none. A channel that wasn't checked yet, or
// whose check failed (site down, blocked), counts as playable: only a definite
// "no stream" hides anything.
const PROBE_CONCURRENCY = 4;
const PROBE_HORIZON_MS = 24 * HOUR_MS;
const PROBE_OK_TTL_MS = 6 * HOUR_MS;
const PROBE_NONE_TTL_MS = 1 * HOUR_MS;
const PROBE_RETRY_MS = 5 * 60 * 1000;
// Embeds of the dembed family, which needs a token proxy (see SCOPE above), the
// dead path some channels point at, and embedsports.me, whose "Tennis Stream"
// pages only said "Starting Soon", about another match: no stream we can offer.
const UNSUPPORTED_EMBED = /ksohls\.ru|\/premiumtv\/|embedsports\.me/i;
const channelProbes = new Map(); // channel -> { playable: true|false|null, until }
let probing = false;

// true / false, or null when it couldn't be determined. Only looks at DaddyLive's
// own player pages for an embed we can use: checking hundreds of channels on the
// stream hosts themselves gets us rate limited, and then playing fails too.
function usableEmbed(html, pageUrl) {
    const embed = extractEmbedUrl(html);
    if (!embed) return false;
    try { return !UNSUPPORTED_EMBED.test(new URL(embed, pageUrl).href); } catch { return false; }
}

function probeChannel(base, channel) {
    let unsure = false;
    const watch = `${base}/watch.php?id=${channel}`;
    const tryPlayer = (i) => {
        if (i >= SERVERS.length) return unsure ? null : false;
        const pageUrl = `${base}/${SERVERS[i].id}/stream-${channel}.php`;
        return fetchText(pageUrl, watch).then((html) => (usableEmbed(html, pageUrl) ? true : tryPlayer(i + 1)), (err) => {
            if (!/HTTP 404/.test(err.message)) unsure = true;
            return tryPlayer(i + 1);
        });
    };
    return tryPlayer(0);
}

// Channels of what is on or starts soon and has no fresh verdict; soonest first.
function probeInBackground(events, now) {
    if (probing) return;
    const fresh = (channel) => { const p = channelProbes.get(channel); return p && p.until > now; };
    const due = [...new Set(events
        .filter((ev) => ev.ts && ev.ts < now + PROBE_HORIZON_MS && now < ev.ts + eventLengthMs(ev))
        .sort((a, b) => a.ts - b.ts)
        .flatMap((ev) => (ev.channels || []).map((c) => c.channel)))].filter((channel) => !fresh(channel));
    if (!due.length) return;
    probing = true;
    const started = Date.now();
    const total = due.length;
    discoverBase().then((base) => {
        const worker = () => {
            const channel = due.shift();
            if (channel === undefined) return Promise.resolve();
            return probeChannel(base, channel).catch(() => null).then((playable) => {
                const ttl = playable === true ? PROBE_OK_TTL_MS : playable === false ? PROBE_NONE_TTL_MS : PROBE_RETRY_MS;
                channelProbes.set(channel, { playable, until: Date.now() + ttl });
            }).then(worker);
        };
        return Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
    }).catch((err) => console.log(`[DaddyLive] Channel check failed: ${err.message}`)).then(() => {
        probing = false;
        console.log(`[DaddyLive] Checked ${total} channels in ${Math.round((Date.now() - started) / 1000)}s`);
    });
}

// Is there something to play for this event: now if it's on, else (before and
// after) on its channels in general.
function hasStream(ev, events, now, probes = channelProbes) {
    const on = ev.ts && ev.ts <= now + PRE_START_MS && now < ev.ts + eventLengthMs(ev);
    const feeds = on ? feedsOnAir(ev, events, now) : (ev.channels || []);
    return feeds.some((c) => { const p = probes.get(c.channel); return !p || p.playable !== false; });
}

function withStatus(ev, now) {
    const start = ev.ts || 0;
    const end = start ? start + eventLengthMs(ev) : 0;
    const status = !start ? 'unknown' : now < start ? 'upcoming' : now < end ? 'live' : 'ended';
    return Object.assign({}, ev, { start, end, status });
}

// Every event in the schedule, finished ones too, with its status.
function listAllEvents() {
    const now = Date.now();
    return getSchedule().then(({ events }) => {
        probeInBackground(events || [], now);
        return (events || [])
            .filter((ev) => ev.channels && ev.channels.length)
            .map((ev) => {
                const primary = ev.channels[0];
                return withStatus({
                    id: `${primary.channel}:${ev.key}`,
                    title: ev.title || primary.name,
                    time: ev.time,
                    ts: ev.ts,
                    category: ev.category,
                    channels: ev.channels,
                    playable: hasStream(ev, events, now)
                }, now);
            });
    });
}

// Catalog: one entry per scheduled sport event (keyed by its primary channel),
// live first, then upcoming by start time; finished events are left out.
function listSportEvents() {
    const rank = { live: 0, upcoming: 1, unknown: 2 };
    return listAllEvents().then((events) => events
        .filter((ev) => ev.status !== 'ended' && ev.playable)
        .sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.start || Infinity) - (b.start || Infinity))));
}

// Meta for one id part "<channel>:<eventKey>" (bare "<channel>" still works
// for ids from before the per-event key, via the channel's first event).
function getEvent(idPart) {
    const [chStr, key] = String(idPart).split(':');
    return getSchedule().then(({ byChannel, byKey }) => {
        let event = key && byKey ? byKey.get(key) : null;
        if (!event) {
            const hit = byChannel && byChannel.get(Number(chStr));
            event = hit ? hit.event : null;
        }
        if (!event) return null;
        return withStatus({
            id: String(idPart),
            title: event.title,
            time: event.time,
            ts: event.ts,
            category: event.category,
            channels: event.channels
        }, Date.now());
    });
}

module.exports = {
    discoverBase,
    listAllEvents,
    listSportEvents,
    getEvent,
    getChannelStreams,
    // exported for isolated testing against saved HTML:
    _parse: { parseHomeSections, parseScheduleDays, extractPlayable, extractEmbedUrl, decryptEconfig, convertUkTime, parseDayDate, feedsOnAir, hasStream, eventLengthMs, usableEmbed }
};
