// Xpass (play.xpass.top) - movies and TV.
//
//   page     -> GET /e/movie/{tmdbId} or /e/tv/{tmdbId}/{season}/{episode}
//               carries `var dataUrl="/data/...?token=..."` (checked 2026-11-08).
//   servers  -> GET {dataUrl} answers a base64url AES-256-GCM blob:
//               12-byte IV | ciphertext | 16-byte tag. The key is
//                 SHA-256("spv3-data-response|" + build + "|" + path + "|" + token)
//               where path is dataUrl's pathname, token its `token` parameter,
//               and build a "spv3-build-..." id that ships inside the player
//               script. The plaintext is [{name, url:"/mdata/.../playlist.json"}].
//   build id -> the player script is obfuscated, but its strings sit in a
//               plain table (base64 with a swapped-case alphabet). The page's
//               /static/mainmini.js names the player script (/static/X.js),
//               whose table holds the build id; both are only decoded, never run.
//   playlist -> each playlist.json is JW Player's {playlist:[{sources:[{file}]}]}.
//               A file of "/video/error" is a server without the title. Most
//               files are HLS; some hosts want the page as Referer, one (the
//               site's own list) wants none, so each master is tried with and
//               then without it, and the headers that worked go with the stream.
//   limits   -> a burst of requests gets HTTP 429, so playlists are fetched a
//               few at a time and only until enough servers play (resolveSome).
//
// GCM decryption is done as AES-CTR from counter IV||00000002 (what GCM's
// keystream is for a 12-byte IV) with crypto-js, so it runs wherever crypto-js
// does. The tag isn't checked; a wrong key shows up as plaintext that isn't JSON.

const CryptoJS = require('crypto-js');

const BASE_URL = 'https://play.xpass.top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const KNOWN_BUILD = 'spv3-build-1787821613-50e5fc97c9dce367';
const BUILD_TTL_MS = 60 * 60 * 1000;
// Dead servers are the slow part (each costs its batch a full timeout); the
// live ones answer within a second or two.
const REQUEST_TIMEOUT_MS = 5000;
const BATCH_SIZE = 6;
const WANTED_STREAMS = 6;
const MAX_SERVERS = 24;

const HAS_ABORT_TIMER = typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined';
function get(url, headers) {
    if (!HAS_ABORT_TIMER) return fetch(url, { headers }).then(res => res.text().then(text => ({ status: res.status, text })));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return fetch(url, { headers, signal: controller.signal })
        .then(res => res.text().then(text => { clearTimeout(timer); return { status: res.status, text }; }))
        .catch(err => { clearTimeout(timer); throw err; });
}

// --- the build id -----------------------------------------------------------

const SWAPPED_B64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
function decodeTableString(s) {
    let bytes = '', bc = 0, bs = 0;
    for (let i = 0; i < s.length; i++) {
        const v = SWAPPED_B64.indexOf(s.charAt(i));
        if (v < 0 || v === 64) continue;
        bs = bc % 4 ? bs * 64 + v : v;
        if (bc++ % 4) bytes += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
    }
    try { return decodeURIComponent(bytes.split('').map(c => '%' + ('0' + c.charCodeAt(0).toString(16)).slice(-2)).join('')); } catch (e) { return bytes; }
}
// Every string in an obfuscated script's table(s), decoded.
function tableStrings(script) {
    const out = [];
    const tables = script.match(/=\[('[A-Za-z0-9+\/=]*'(?:,'[A-Za-z0-9+\/=]*')*)\]/g) || [];
    tables.forEach(t => (t.match(/'([A-Za-z0-9+\/=]*)'/g) || []).forEach(q => out.push(decodeTableString(q.slice(1, -1)))));
    return out;
}

let buildCache = { id: KNOWN_BUILD, at: 0 };
function findBuild(pageHtml) {
    const main = (pageHtml.match(/src="(\/static\/mainmini\.js[^"]*)"/) || [])[1];
    if (!main) return Promise.resolve(null);
    const headers = { 'User-Agent': USER_AGENT, Referer: `${BASE_URL}/` };
    return get(`${BASE_URL}${main}`, headers).then(r => {
        const player = tableStrings(r.text).find(s => /^\/static\/\w+\.js/.test(s) && !/mainmini|sdbmini/.test(s));
        if (!player) return null;
        return get(`${BASE_URL}${player}`, headers).then(p => tableStrings(p.text).find(s => /^spv3-build-[\w-]+$/.test(s)) || null);
    }).catch(() => null);
}
function getBuild(pageHtml, force) {
    if (!force && buildCache.at && Date.now() - buildCache.at < BUILD_TTL_MS) return Promise.resolve(buildCache.id);
    return findBuild(pageHtml).then(id => {
        if (id) buildCache = { id, at: Date.now() };
        return id || buildCache.id;
    });
}

// --- the server list ----------------------------------------------------------

function decryptList(blobText, path, token, build) {
    try {
        const key = CryptoJS.SHA256(`spv3-data-response|${build}|${path}|${token}`);
        const b64 = blobText.trim().replace(/-/g, '+').replace(/_/g, '/');
        const all = CryptoJS.enc.Base64.parse(b64 + '==='.slice((b64.length + 3) % 4));
        const hex = all.toString(CryptoJS.enc.Hex);
        if (hex.length < 56) return null;
        const iv = CryptoJS.enc.Hex.parse(hex.slice(0, 24) + '00000002');
        const ciphertext = CryptoJS.enc.Hex.parse(hex.slice(24, hex.length - 32));
        const plain = CryptoJS.AES.decrypt({ ciphertext }, key, { iv, mode: CryptoJS.mode.CTR, padding: CryptoJS.pad.NoPadding });
        const list = JSON.parse(plain.toString(CryptoJS.enc.Utf8));
        return Array.isArray(list) ? list : null;
    } catch (e) {
        return null;
    }
}

function getServerList(pageHtml, pageUrl) {
    const dataUrl = (pageHtml.match(/var\s+dataUrl\s*=\s*"([^"]+)"/) || [])[1];
    if (!dataUrl) return Promise.resolve(null);
    const url = new URL(dataUrl, BASE_URL);
    const token = url.searchParams.get('token');
    if (!token) return Promise.resolve(null);
    return get(url.href, { 'User-Agent': USER_AGENT, Referer: pageUrl }).then(blob => {
        if (blob.status !== 200) return null;
        return getBuild(pageHtml, false).then(build => {
            const list = decryptList(blob.text, url.pathname, token, build);
            if (list) return list;
            // A new player build: look its id up again once.
            return getBuild(pageHtml, true).then(fresh => (fresh !== build ? decryptList(blob.text, url.pathname, token, fresh) : null));
        });
    });
}

// --- the streams ----------------------------------------------------------------

function heightOf(playlist) {
    let best = 0, bestW = 0;
    playlist.replace(/RESOLUTION=(\d+)x(\d+)/g, (m, w, h) => { best = Math.max(best, +h); bestW = Math.max(bestW, +w); return m; });
    if (!best) return 'Unknown';
    if (bestW >= 3800 || best >= 2100) return '2160p';
    if (bestW >= 1900 || best >= 1000) return '1080p';
    if (bestW >= 1260 || best >= 700) return '720p';
    if (bestW >= 840 || best >= 460) return '480p';
    return `${best}p`;
}

// The headers a file plays with (page Referer first, then none), and its quality; null if neither.
function checkFile(file) {
    const tries = [
        { 'User-Agent': USER_AGENT, Referer: `${BASE_URL}/`, Origin: BASE_URL },
        { 'User-Agent': USER_AGENT }
    ];
    const attempt = (i) => {
        if (i >= tries.length) return Promise.resolve(null);
        return get(file, tries[i]).then(r => {
            if (r.status === 200 && /#EXTM3U/.test(r.text)) return { headers: tries[i], quality: heightOf(r.text) };
            // Only a refusal is worth another try with other headers; a dead server stays dead.
            return r.status === 401 || r.status === 403 ? attempt(i + 1) : null;
        }).catch(() => null);
    };
    return attempt(0);
}

function resolveServer(server, pageUrl) {
    if (!server || typeof server.url !== 'string') return Promise.resolve([]);
    return get(new URL(server.url, BASE_URL).href, { 'User-Agent': USER_AGENT, Referer: pageUrl }).then(r => {
        let json; try { json = JSON.parse(r.text); } catch (e) { return []; }
        const items = Array.isArray(json) ? json : (json && json.playlist) || [];
        const files = [];
        items.forEach(item => ((item && item.sources) || []).forEach(s => {
            if (s && typeof s.file === 'string' && /^https?:\/\//.test(s.file)) files.push(s.file);
        }));
        return Promise.all(files.slice(0, 2).map(file => checkFile(file).then(ok => (ok ? { server, file, headers: ok.headers, quality: ok.quality } : null))));
    }).then(list => list.filter(Boolean)).catch(() => []);
}

// The site answers 429 to a burst (a title can list 45 servers, each its own
// playlist request), so servers are asked a few at a time, in the site's order,
// until WANTED_STREAMS of them play.
function resolveSome(servers, pageUrl) {
    const groups = [];
    const next = (i, found) => {
        if (i >= servers.length || found >= WANTED_STREAMS) return Promise.resolve(groups);
        return Promise.all(servers.slice(i, i + BATCH_SIZE).map(s => resolveServer(s, pageUrl))).then(batch => {
            batch.forEach(g => groups.push(g));
            return next(i + BATCH_SIZE, found + batch.reduce((n, g) => n + g.length, 0));
        });
    };
    return next(0, 0);
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Xpass] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);
    const pageUrl = mediaType === 'tv' ? `${BASE_URL}/e/tv/${tmdbId}/${season}/${episode}` : `${BASE_URL}/e/movie/${tmdbId}`;

    return get(pageUrl, { 'User-Agent': USER_AGENT, Referer: `${BASE_URL}/` }).then(page => {
        if (page.status !== 200) {
            console.log(`[Xpass] Page HTTP ${page.status}`);
            return [];
        }
        const title = ((page.text.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim();
        return getServerList(page.text, pageUrl).then(list => {
            if (!list) {
                console.log('[Xpass] Could not read the server list');
                return [];
            }
            console.log(`[Xpass] ${list.length} server(s)`);
            return resolveSome(list.slice(0, MAX_SERVERS), pageUrl).then(groups => {
                // The page title of an episode already names it ("... Season 1 Episode 1").
                const label = title && mediaType === 'tv' && !/episode/i.test(title) ? `${title} S${season}E${episode}` : title;
                return [].concat.apply([], groups).map(r => ({
                    name: `Xpass ${r.server.name || ''}`.trim(),
                    title: [label, r.quality !== 'Unknown' ? r.quality : ''].filter(Boolean).join(' - '),
                    url: r.file,
                    quality: r.quality,
                    headers: r.headers,
                    provider: 'xpass'
                }));
            });
        });
    }).then(streams => {
        console.log(`[Xpass] ${streams.length} stream(s)`);
        return streams;
    }).catch(err => {
        console.log(`[Xpass] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams };
