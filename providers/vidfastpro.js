// VidFastPro scraper for Nuvio Local Scrapers
//
// Ported from the open-source CloudStream extension (SaurabhKaperwan/CSX,
// CineStream/.../CineStreamExtractors.kt, invokeVidFastPro). Verified live,
// end to end, including a real 2160p variant. TMDB-id based - no title
// search needed:
//
//   GET https://vidfast.vc/movie/{tmdbId}/  (or /tv/{tmdbId}/{season}/{episode}/)
//     -> page HTML embeds an encrypted token: \"token\":\"<token>\"
//   GET https://enc-dec.app/api/enc-vidfast?text={token}
//     -> { result: { servers, stream, token } }  (servers/stream are URLs, token is a CSRF value)
//   POST {servers}  (header X-CSRF-Token: token)
//     -> encrypted text
//   POST https://enc-dec.app/api/dec-vidfast  { text: <encrypted> }
//     -> { result: [ { name, description, data }, ... ] }  one entry per server
//   POST {stream}/{server.data}  (same X-CSRF-Token)
//     -> encrypted text
//   POST https://enc-dec.app/api/dec-vidfast  { text: <encrypted> }
//     -> { result: { url, tracks, is4kAvailable, ... } }  the actual stream
//
// enc-dec.app is a shared, third-party encrypt/decrypt-as-a-service already
// relied on by vidlink.js in this repo (same host, different route) - this
// reuses that same trust, not a new dependency category.

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://vidfast.vc';
const ENC_DEC_API = 'https://enc-dec.app/api';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': `${API_BASE}/`
};

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[VidFastPro] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

function decDec(text) {
  return fetch(`${ENC_DEC_API}/dec-vidfast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  }).then(res => res.json()).then(body => body.result);
}

// A plain HEAD/ranged-GET on the stream URL isn't enough for HLS (.m3u8)
// streams (seen repeatedly in this repo - the manifest itself often loads
// fine from a stable routing layer even when the segments it points to are
// dead), so for .m3u8 URLs walk the manifest chain down to a real segment
// reference and validate that instead of the manifest.
function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

function firstManifestRef(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length === 0) return null;
  try {
    return new URL(lines[0], baseUrl).toString();
  } catch (e) {
    return null;
  }
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

function resolveServer(streamBaseUrl, server, headers, label) {
  const finalUrl = `${streamBaseUrl}/${server.data}`;
  return fetch(finalUrl, { method: 'POST', headers })
    .then(res => res.text())
    .then(encrypted => {
      if (!encrypted) return null;
      return decDec(encrypted).then(streamData => {
        if (!streamData || !streamData.url) return null;
        const is4k = streamData.is4kAvailable === true || (server.description || '').includes('4K');
        return {
          name: `VidFastPro - ${server.name || 'Server'}`,
          title: label,
          url: streamData.url,
          quality: is4k ? '4K' : '1080p',
          type: 'direct',
          headers: REQUEST_HEADERS,
          provider: 'vidfastpro'
        };
      });
    })
    .catch(() => null);
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[VidFastPro] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[VidFastPro] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  const pageUrl = mediaType === 'tv'
    ? `${API_BASE}/tv/${tmdbId}/${season}/${episode}/`
    : `${API_BASE}/movie/${tmdbId}/`;

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return fetch(pageUrl, { headers: REQUEST_HEADERS })
      .then(res => res.text())
      .then(html => {
        const m = html.match(/\\"(?:en|token)\\":\\"(.*?)\\"/);
        if (!m) {
          console.log('[VidFastPro] No token found on page');
          return [];
        }
        return fetch(`${ENC_DEC_API}/enc-vidfast?text=${encodeURIComponent(m[1])}`)
          .then(res => res.json())
          .then(body => {
            const result = body && body.result;
            if (!result || !result.servers || !result.stream) return [];
            const headers = Object.assign({}, REQUEST_HEADERS, { 'X-CSRF-Token': result.token });

            return fetch(result.servers, { method: 'POST', headers })
              .then(res => res.text())
              .then(encrypted => decDec(encrypted))
              .then(servers => {
                if (!Array.isArray(servers)) return [];
                console.log(`[VidFastPro] Found ${servers.length} server(s), resolving...`);
                return Promise.all(servers.map(s => resolveServer(result.stream, s, headers, label)))
                  .then(results => results.filter(Boolean));
              });
          });
      })
      .then(streams => {
        console.log(`[VidFastPro] Resolved ${streams.length} stream(s), validating...`);
        return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
          const valid = validated.filter(v => v.ok).map(v => v.stream);
          const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
          if (dead.length) console.log(`[VidFastPro] Dropping unreachable: ${dead.join(', ')}`);
          console.log(`[VidFastPro] ${valid.length}/${streams.length} stream(s) validated OK`);
          return valid;
        });
      });
  }).catch(err => {
    console.log(`[VidFastPro] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
