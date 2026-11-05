// AniKoto scraper (anime, subbed and dubbed)
//
// Every server on anikototv.to is a megaplay.buzz embed, so this skips the
// site's own search and episode lists and goes to the player directly, by
// MyAnimeList id. Confirmed live 2026-11-05 for series, films and long shows:
//
//   GET https://megaplay.buzz/stream/mal/{malId}/{episode}/{sub|dub}
//     -> an embed page with data-id="{id}"
//   GET https://megaplay.buzz/stream/getSourcesNew?id={id}&id={id}
//     -> {"tracks":[...captions...],"enc":"<base64url>"}
//
// `enc` is AES-256-CBC of {"file":"<master.m3u8>"}, with the key and IV in the
// player's own script (lib/newclient.min.js, as trustAesKey / trustAesIv). It
// hides an address; the video itself isn't encrypted. Should the key change,
// decryption fails and this provider returns nothing rather than a wrong link.
// Playlists and segments answer 403 without the player's Referer and Origin,
// so those go along as playback headers.

const crypto = require('crypto');
const { resolveAnime } = require('../lib/animeIds');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const PLAYER_BASE = 'https://megaplay.buzz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PLAYBACK_HEADERS = { 'User-Agent': USER_AGENT, Referer: `${PLAYER_BASE}/`, Origin: PLAYER_BASE };
const AES_KEY = "i?LMTAx0Q6,:}50U";
const AES_IV = "W0;27ToaUpl_P%'c";
const REQUEST_TIMEOUT_MS = 10000;

function padded(text, length) {
    const out = Buffer.alloc(length);
    Buffer.from(text).copy(out, 0, 0, length);
    return out;
}

function decryptSource(enc) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', padded(AES_KEY, 32), padded(AES_IV, 16));
    const body = Buffer.from(String(enc).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}

function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).then(
        res => { clearTimeout(timer); return res; },
        err => { clearTimeout(timer); throw err; }
    );
}

function getTmdbInfo(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    return fetchWithTimeout(`${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => ({
            title: mediaType === 'tv' ? data.name : data.title,
            seasons: Array.isArray(data.seasons) ? data.seasons : []
        }))
        .catch(() => ({ title: '', seasons: [] }));
}

function bestQuality(masterPlaylist) {
    const heights = [...String(masterPlaylist).matchAll(/RESOLUTION=\d+x(\d+)/g)].map(m => Number(m[1]));
    return heights.length ? `${Math.max(...heights)}p` : 'Auto';
}

function fetchVariant(malId, episode, audio, label) {
    return fetchWithTimeout(`${PLAYER_BASE}/stream/mal/${malId}/${episode}/${audio}`, { headers: PLAYBACK_HEADERS })
        .then(res => res.text())
        .then(page => {
            const id = (page.match(/\bdata-id=["'](\d+)["']/) || [])[1];
            if (!id) return null;
            const headers = Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, PLAYBACK_HEADERS);
            return fetchWithTimeout(`${PLAYER_BASE}/stream/getSourcesNew?id=${id}&id=${id}`, { headers })
                .then(res => res.json())
                .then(data => {
                    const file = data && data.enc ? decryptSource(data.enc).file : null;
                    if (!file) return null;
                    return fetchWithTimeout(file, { headers: PLAYBACK_HEADERS })
                        .then(res => (res.ok ? res.text() : ''))
                        .then(playlist => {
                            if (!/^#EXTM3U/.test(playlist.trim())) return null;
                            return {
                                name: `AniKoto [${audio.toUpperCase()}]`,
                                title: `${label} - ${audio === 'dub' ? 'English dub' : 'Japanese audio, English subs'}`,
                                url: file,
                                quality: bestQuality(playlist),
                                type: 'hls',
                                headers: PLAYBACK_HEADERS,
                                subtitles: (Array.isArray(data.tracks) ? data.tracks : [])
                                    .filter(t => t && t.file && t.kind === 'captions')
                                    .map(t => ({ url: t.file, language: t.label || 'Unknown', name: t.label || 'Unknown' })),
                                provider: 'anikoto'
                            };
                        });
                });
        })
        .catch(err => {
            console.log(`[AniKoto] ${audio} failed: ${err.message}`);
            return null;
        });
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    console.log(`[AniKoto] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
    if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);

    return getTmdbInfo(tmdbId, mediaType).then(info =>
        resolveAnime(tmdbId, mediaType, season, episode, info.seasons).then(target => {
            if (!target || !target.malId) {
                console.log('[AniKoto] Not an anime known to the id mapping');
                return [];
            }
            const label = mediaType === 'tv'
                ? `${info.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
                : info.title;
            const lookup = (malId, ep) => Promise.all(['sub', 'dub'].map(audio => fetchVariant(malId, ep, audio, label)))
                .then(found => found.filter(Boolean));
            return lookup(target.malId, target.episode).then(found => {
                // A later part of a split season is often only there under the
                // first part, numbered straight through (Attack on Titan S3).
                const whole = target.wholeSeason;
                return found.length || !whole || !whole.malId ? found : lookup(whole.malId, whole.episode);
            });
        })
    ).catch(err => {
        console.log(`[AniKoto] getStreams failed: ${err.message}`);
        return [];
    });
}

module.exports = { getStreams };
