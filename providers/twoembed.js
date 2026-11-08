// 2Embed (www.2embed.cc) - movies and TV.
//
//   player   -> 2embed.cc's embed page only frames https://vidsrc.buzz/embed/...
//               (checked 2026-11-08), so this goes to that player directly:
//                 GET /embed/movie/{tmdbId}
//                 GET /embed/tv/{tmdbId}/{season}/{episode}
//               The page needs a browser User-Agent and a Referer (403 without).
//               It carries a `var Q = {...}` object: the title's IMDb id, a
//               signed page token `t`, and usually the server list (`ssr`).
//   servers  -> GET /pl/api.php?a=sources&type=..&id=..&s=..&e=..&t=..
//               -> {servers:[{ref, name}]} (only needed when the page has no list)
//   play     -> GET /pl/api.php?a=play&ref={ref}&t={t}
//               -> {url:"/_stream?id=...", type:"hls"}; a server without a
//               copy of the title answers 502 {"error":"unavailable"}.
//   stream   -> an HLS master on vidsrc.buzz itself; playlists and segments
//               need the same browser User-Agent and a vidsrc.buzz Referer.

const BASE_URL = 'https://vidsrc.buzz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_HEADERS = { 'User-Agent': USER_AGENT, Referer: 'https://www.2embed.cc/' };
const STREAM_HEADERS = { 'User-Agent': USER_AGENT, Referer: `${BASE_URL}/`, Origin: BASE_URL };
const REQUEST_TIMEOUT_MS = 15000;

const HAS_ABORT_TIMER = typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined';
function timedFetch(url, options) {
    if (!HAS_ABORT_TIMER) return fetch(url, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return fetch(url, Object.assign({}, options, { signal: controller.signal }))
        .then(res => res.text().then(text => { clearTimeout(timer); return { status: res.status, text }; }))
        .catch(err => { clearTimeout(timer); throw err; });
}
// One retry: the host now and then drops a connection before answering.
function get(url, headers, retried) {
    const once = HAS_ABORT_TIMER ? timedFetch(url, { headers })
        : fetch(url, { headers }).then(res => res.text().then(text => ({ status: res.status, text })));
    return retried ? once : once.catch(() => get(url, headers, true));
}
function getJson(url, headers) {
    return get(url, headers).then(r => { try { return JSON.parse(r.text); } catch (e) { return null; } });
}

// The object literal after `var Q =`, read up to its matching brace (strings may hold braces).
function readPageObject(html) {
    const start = html.indexOf('{', Math.max(0, html.search(/var\s+Q\s*=\s*\{/)));
    if (!/var\s+Q\s*=\s*\{/.test(html) || start < 0) return null;
    let depth = 0, inString = false;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inString) {
            if (c === '\\') i++;
            else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
            try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
        }
    }
    return null;
}

// Highest RESOLUTION in a master playlist, as "1080p"; null when it lists none.
function bestQuality(playlist) {
    const heights = [];
    playlist.replace(/RESOLUTION=\d+x(\d+)/g, (_, h) => { heights.push(parseInt(h, 10)); return _; });
    if (!heights.length) return null;
    const h = Math.max.apply(null, heights);
    // Widescreen films are letterboxed (1920x800): name them by width class instead.
    const widths = [];
    playlist.replace(/RESOLUTION=(\d+)x\d+/g, (_, w) => { widths.push(parseInt(w, 10)); return _; });
    const w = Math.max.apply(null, widths);
    if (w >= 3800 || h >= 2100) return '2160p';
    if (w >= 1900 || h >= 1000) return '1080p';
    if (w >= 1260 || h >= 700) return '720p';
    if (w >= 840 || h >= 460) return '480p';
    return `${h}p`;
}

function resolveServer(server, token) {
    const url = `${BASE_URL}/pl/api.php?a=play&ref=${encodeURIComponent(server.ref)}&t=${encodeURIComponent(token)}`;
    return getJson(url, PAGE_HEADERS).then(play => {
        if (!play || !play.url) return null;
        const streamUrl = new URL(play.url, `${BASE_URL}/`).href;
        if (play.type && play.type !== 'hls') return { server, url: streamUrl, quality: 'Unknown', hdr: false };
        // Fetching the master both proves the copy plays and tells its quality.
        return get(streamUrl, STREAM_HEADERS).then(r => {
            if (r.status !== 200 || !/#EXTM3U/.test(r.text)) return null;
            return { server, url: streamUrl, quality: bestQuality(r.text) || 'Unknown', hdr: /VIDEO-RANGE=(PQ|HLG)/.test(r.text) };
        });
    }).catch(() => null);
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[2Embed] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);
    const path = mediaType === 'tv' ? `tv/${tmdbId}/${season}/${episode}` : `movie/${tmdbId}`;

    return get(`${BASE_URL}/embed/${path}`, PAGE_HEADERS).then(page => {
        const Q = page.status === 200 ? readPageObject(page.text) : null;
        if (!Q || !Q.t) {
            console.log(`[2Embed] No player data (HTTP ${page.status})`);
            return [];
        }
        const listed = Q.ssr && Array.isArray(Q.ssr.servers) ? Q.ssr.servers : null;
        const servers = listed && listed.length ? Promise.resolve(listed)
            : getJson(`${BASE_URL}/pl/api.php?a=sources&type=${Q.type}&id=${encodeURIComponent(Q.id)}&s=${Q.s}&e=${Q.e}&t=${encodeURIComponent(Q.t)}`, PAGE_HEADERS)
                .then(json => (json && Array.isArray(json.servers) ? json.servers : []));
        return servers.then(list => {
            console.log(`[2Embed] ${list.length} server(s): ${list.map(s => s.name).join(', ')}`);
            return Promise.all(list.filter(s => s && s.ref).map(s => resolveServer(s, Q.t)));
        }).then(results => {
            const title = (Q.ssr && Q.ssr.title) || '';
            // The site's own TV title already names the episode ("... Season 1 Episode 1").
            const label = title && mediaType === 'tv' && !/episode/i.test(title) ? `${title} S${season}E${episode}` : title;
            return results.filter(Boolean).map(r => ({
                name: `2Embed ${String(r.server.name || '').replace(/^Server\s+/i, '')}`.trim(),
                title: [label, [r.quality !== 'Unknown' ? r.quality : '', r.hdr ? 'HDR' : ''].filter(Boolean).join(' ')].filter(Boolean).join(' - '),
                url: r.url,
                quality: r.quality,
                headers: STREAM_HEADERS,
                provider: 'twoembed'
            }));
        });
    }).then(streams => {
        console.log(`[2Embed] ${streams.length} stream(s)`);
        return streams;
    }).catch(err => {
        console.log(`[2Embed] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams };
