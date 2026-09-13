// AllMovieLand scraper for Nuvio Local Scrapers
//
// Ported from the open-source CloudStream extension (SaurabhKaperwan/CSX,
// CineStream/.../CineStreamExtractors.kt, invokeAllmovieland). Verified live,
// end to end, down to a real playable HLS segment. IMDb-id based:
//
//   GET https://allmovieland.link/player.js?v=60%20128
//     -> page JS embeds the current streaming host: const AwsIndStreamDomain = '<host>';
//   GET {host}/play/{imdbId}                          (Referer: https://allmovieland.one/)
//     -> HTML has a <script> containing a `playlist` reference; the first
//        top-level {...} object literal in it has {file, key} - `file` is a
//        per-title manifest path, `key` doubles as a CSRF token
//   GET {host}{file}                                  (X-CSRF-TOKEN: key)
//     -> JSON array of servers: movies get [{file, title}, ...] directly;
//        series nest it as [{id: "<season>", folder: [{episode, folder:
//        [{file, title}]}]}] - `title` here is the audio language, not a
//        display title
//   POST {host}/playlist/{file}.txt                   (X-CSRF-TOKEN: key)
//     -> plain text response: the final .m3u8 URL, on the same gufin435siv.com
//        CDN family already used by peachify.js in this repo

const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const PLAYER_JS_URL = 'https://allmovieland.link/player.js?v=60%20128';
const SITE_URL = 'https://allmovieland.one';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': `${SITE_URL}/`
};

let cachedHost = null;
let cachedHostAt = 0;
const HOST_CACHE_TTL = 1000 * 60 * 30;

function getStreamHost() {
  if (cachedHost && Date.now() - cachedHostAt < HOST_CACHE_TTL) {
    return Promise.resolve(cachedHost);
  }
  return fetch(PLAYER_JS_URL, { headers: REQUEST_HEADERS })
    .then(res => res.text())
    .then(text => {
      const m = text.match(/const AwsIndStreamDomain\s*=\s*'([^']+)'/);
      if (!m) throw new Error('Could not find streaming host');
      cachedHost = m[1];
      cachedHostAt = Date.now();
      console.log(`[AllMovieLand] Using host: ${cachedHost}`);
      return cachedHost;
    });
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      const imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || null;
      console.log(`[AllMovieLand] TMDB Info: "${title}" (${year}) imdb=${imdbId || 'none'}`);
      return { title, year, imdbId };
    })
    .catch(() => ({ title: '', year: '', imdbId: null }));
}

// The playlist data isn't valid standalone JSON in the page - it's embedded
// as `let <somevar> = {...};` inside a larger script. Extract the first
// top-level {...} object literal after the first "playlist"-mentioning
// script tag, mirroring the original's substringAfter("{")/substringBefore
// approach rather than depending on a specific variable name.
function extractPlaylistJson(html) {
  const $ = cheerio.load(html);
  let scriptText = null;
  $('script').each((i, el) => {
    if (scriptText) return;
    const text = $(el).html() || '';
    if (text.includes('playlist')) scriptText = text;
  });
  if (!scriptText) return null;
  const afterBrace = scriptText.slice(scriptText.indexOf('{'));
  const endSemi = afterBrace.indexOf(';');
  const endParen = afterBrace.indexOf(')');
  let end = endSemi === -1 ? endParen : (endParen === -1 ? endSemi : Math.min(endSemi, endParen));
  if (end === -1) end = afterBrace.length;
  try {
    return JSON.parse(afterBrace.slice(0, end));
  } catch (e) {
    return null;
  }
}

function resolveServerToStream(host, file, key, label) {
  const url = `${host}/playlist/${encodeURIComponent(file)}.txt`;
  return fetch(url, { method: 'POST', headers: Object.assign({}, REQUEST_HEADERS, { 'X-CSRF-TOKEN': key }) })
    .then(res => res.text())
    .then(text => {
      const finalUrl = text.trim();
      if (!finalUrl.startsWith('http')) return null;
      return { url: finalUrl, label };
    })
    .catch(() => null);
}

// Manifest reachability alone isn't a reliable signal on this CDN family
// (already seen with peachify.js on the same gufin435siv.com infrastructure)
// - walk down to a real segment reference before trusting a result.
function firstManifestRef(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length === 0) return null;
  try {
    return new URL(lines[0], baseUrl).toString();
  } catch (e) {
    return null;
  }
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

function validateM3u8Chain(url, headers, hopsLeft) {
  return fetch(url, { headers })
    .then(res => {
      if (!res.ok) return false;
      return res.text().then(text => {
        const next = firstManifestRef(text, url);
        if (!next) return true;
        if (isM3u8Url(next) && hopsLeft > 0) {
          return validateM3u8Chain(next, headers, hopsLeft - 1);
        }
        return rangedValidateUrl(next, headers);
      });
    })
    .catch(() => false);
}

function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return validateM3u8Chain(stream.url, stream.headers, 2);
  }
  return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => rangedValidateUrl(stream.url, stream.headers));
}

function rangedValidateUrl(url, headers) {
  const rangedHeaders = Object.assign({}, headers, { Range: 'bytes=0-2048' });
  return fetch(url, { method: 'GET', headers: rangedHeaders })
    .then(res => res.ok || res.status === 206)
    .catch(() => false);
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[AllMovieLand] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[AllMovieLand] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getStreamHost(), getTmdbInfo(tmdbId, mediaType)]).then(([host, mediaInfo]) => {
    if (!mediaInfo.imdbId) {
      console.log('[AllMovieLand] No IMDb id available for this title');
      return [];
    }
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return fetch(`${host}/play/${mediaInfo.imdbId}`, { headers: REQUEST_HEADERS })
      .then(res => res.text())
      .then(html => {
        const playlist = extractPlaylistJson(html);
        if (!playlist || !playlist.file || !playlist.key) {
          console.log('[AllMovieLand] No playlist data found (title likely not available)');
          return [];
        }
        const fileUrl = new URL(playlist.file, host).toString();
        return fetch(fileUrl, { headers: Object.assign({}, REQUEST_HEADERS, { 'X-CSRF-TOKEN': playlist.key }) })
          .then(res => res.text())
          .then(text => {
            const cleaned = text.replace(/,\s*\[\]/g, '');
            let servers;
            try {
              servers = JSON.parse(cleaned);
            } catch (e) {
              return [];
            }
            let entries;
            if (mediaType === 'tv') {
              const seasonEntry = Array.isArray(servers) ? servers.find(s => String(s.id) === String(season)) : null;
              const episodeEntry = seasonEntry && Array.isArray(seasonEntry.folder)
                ? seasonEntry.folder.find(e => String(e.episode) === String(episode))
                : null;
              entries = (episodeEntry && Array.isArray(episodeEntry.folder)) ? episodeEntry.folder : [];
            } else {
              entries = Array.isArray(servers) ? servers : [];
            }
            console.log(`[AllMovieLand] Found ${entries.length} server(s), resolving...`);
            return Promise.all(entries.map(e => resolveServerToStream(host, e.file, playlist.key, e.title || 'Unknown')))
              .then(results => results.filter(Boolean).map(r => ({
                name: `AllMovieLand [${r.label}]`,
                title: label,
                url: r.url,
                quality: '1080p',
                type: 'direct',
                headers: REQUEST_HEADERS,
                provider: 'allmovieland'
              })));
          });
      });
  }).then(streams => {
    console.log(`[AllMovieLand] Resolved ${streams.length} stream(s), validating...`);
    return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
      const valid = validated.filter(v => v.ok).map(v => v.stream);
      const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
      if (dead.length) console.log(`[AllMovieLand] Dropping unreachable: ${dead.join(', ')}`);
      console.log(`[AllMovieLand] ${valid.length}/${streams.length} stream(s) validated OK`);
      return valid;
    });
  }).catch(err => {
    console.log(`[AllMovieLand] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
