// Vidzee (player.vidzee.wtf) - movies and TV.
//
//   api      -> the player (a TanStack Start app) asks https://core.vidzee.wtf
//               (checked 2026-11-08):
//                 GET /streams/languages/{movie/ID | tv/ID/S/E} -> {languages:[...]}
//                 GET /streams/{movie/ID | tv/ID/S/E}?s={server}&e={0|1}
//               e=1 answers {"c": ...} for the page's WebAssembly decoder;
//               e=0 answers the same thing as plain JSON:
//                 {"language":"English","url":"https://.../x.m3u8","headers":{...}}
//               A server without the title answers 404 {"error":"No stream"}.
//   servers  -> as the player's own menu names them: "peak" and "dcloud"
//               (Peak / Dcloud), and per audio language "v4:{lang}" (Acme)
//               and "v6:{lang}" (TCloud). The languages call doesn't list every
//               language a server has (v6 has English for titles it lists only
//               Hindi for), so English and Hindi are always tried as well.
//   stream   -> HLS; the master needs a browser User-Agent and the player as
//               Referer, unless the answer brings its own headers (those win).

const API = 'https://core.vidzee.wtf';
const PLAYER = 'https://player.vidzee.wtf';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE_HEADERS = { 'User-Agent': USER_AGENT, Referer: `${PLAYER}/`, Origin: PLAYER };
const SERVER_NAMES = { peak: 'Peak', dcloud: 'Dcloud', v4: 'Acme', v6: 'TCloud' };
const ALWAYS_LANGUAGES = ['English', 'Hindi'];
const REQUEST_TIMEOUT_MS = 10000;

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
function getJson(url, headers) {
    return get(url, headers).then(r => { try { return JSON.parse(r.text); } catch (e) { return null; } }).catch(() => null);
}

function qualityOf(playlist) {
    let h = 0, w = 0;
    playlist.replace(/RESOLUTION=(\d+)x(\d+)/g, (m, rw, rh) => { w = Math.max(w, +rw); h = Math.max(h, +rh); return m; });
    if (!h) return null;
    if (w >= 3800 || h >= 2100) return '2160p';
    if (w >= 1900 || h >= 1000) return '1080p';
    if (w >= 1260 || h >= 700) return '720p';
    if (w >= 840 || h >= 460) return '480p';
    return `${h}p`;
}
// A media playlist names no resolution; its path often does (".../720/index.m3u8").
function qualityFromUrl(url) {
    const m = /\/(2160|1080|720|480|360)p?\//.exec(url);
    return m ? `${m[1]}p` : null;
}

function resolveServer(path, server) {
    const url = `${API}/streams/${path}?s=${encodeURIComponent(server)}&e=0`;
    return getJson(url, BASE_HEADERS).then(json => {
        if (!json || typeof json.url !== 'string' || !/^https?:\/\//.test(json.url)) return null;
        const own = json.headers && typeof json.headers === 'object' ? json.headers : {};
        const headers = Object.assign({}, BASE_HEADERS, own);
        // A host that names its own Referer gets no Origin of the player's beside it.
        if (own.Referer && !own.Origin) delete headers.Origin;
        return get(json.url, headers).then(r => {
            if (r.status !== 200 || !/#EXTM3U/.test(r.text)) return null;
            return { server, language: json.language || '', url: json.url, headers, quality: qualityOf(r.text) || qualityFromUrl(json.url) || 'Unknown' };
        }).catch(() => null);
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Vidzee] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);
    const path = mediaType === 'tv' ? `tv/${tmdbId}/${season}/${episode}` : `movie/${tmdbId}`;

    return getJson(`${API}/streams/languages/${path}`, BASE_HEADERS).then(json => {
        const listed = json && Array.isArray(json.languages) ? json.languages.filter(l => typeof l === 'string' && l) : [];
        const languages = ALWAYS_LANGUAGES.concat(listed.filter(l => ALWAYS_LANGUAGES.indexOf(l) < 0));
        const servers = ['peak', 'dcloud'];
        ['v6', 'v4'].forEach(v => languages.forEach(l => servers.push(`${v}:${l}`)));
        return Promise.all(servers.map(s => resolveServer(path, s)));
    }).then(results => {
        const seen = new Set();
        const streams = results.filter(r => r && !seen.has(r.url) && seen.add(r.url)).map(r => {
            const [kind, lang] = r.server.split(':');
            const label = [SERVER_NAMES[kind] || kind, lang || ''].filter(Boolean).join(' ');
            return {
                name: `Vidzee ${label}`,
                title: [mediaType === 'tv' ? `S${season}E${episode}` : '', r.language && r.language !== 'Auto' ? r.language : '', r.quality !== 'Unknown' ? r.quality : '']
                    .filter(Boolean).join(' - ') || 'Vidzee',
                url: r.url,
                quality: r.quality,
                headers: r.headers,
                provider: 'vidzee'
            };
        });
        console.log(`[Vidzee] ${streams.length} stream(s)`);
        return streams;
    }).catch(err => {
        console.log(`[Vidzee] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams };
