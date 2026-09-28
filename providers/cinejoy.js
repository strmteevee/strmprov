// Cinejoy scraper - ported from the CloudStream "StreamPlay" plugin
// (com.phisher98.StreamPlayExtractor#invokeCinejoy, decompiled from the
// StreamPlay.cs3 build at github.com/phisher98/cloudstream-extensions-phisher,
// builds branch), then verified live end-to-end against the real site.
//
// Cinejoy (cinejoy.to / cinejoy.pk) fronts several named upstream "servers"
// (Lisbon, Nebula, Solara, Athens - fetched live from /servers, since the set
// changes over time) behind a custom encrypted API at api.wing.st: every
// request/response body is an ECDH(P-256) + HKDF-SHA256 + AES-256-GCM sealed
// binary blob, and the server's own static public key rotates (confirmed
// live: the CS3 app's own key generation is embedded as raw bytecode array
// data that neither jadx nor a plain string scan could recover).
//
// The CloudStream plugin itself doesn't implement that crypto - it delegates
// to a public helper API, enc-dec.app, that performs the ECDH handshake and
// AES-GCM seal/open on the app's behalf and hands back the encrypted request
// bytes (plus a small `state` token needed to decrypt the response) or takes
// the raw response bytes and returns the decrypted JSON. This provider calls
// that same helper the same way, so no crypto is implemented here at all.
// Confirmed live end-to-end (The Godfather, tmdb 238, Solara server): a real
// application/vnd.apple.mpegurl HLS playlist came back playable.
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const ENC_DEC_BASE = 'https://enc-dec.app/api';
const CINEJOY_API_BASE = 'https://api.wing.st';
const CINEJOY_SITE = 'https://cinejoy.to';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
  'Accept': '*/*',
  'Origin': CINEJOY_SITE,
  'Referer': CINEJOY_SITE + '/',
  'User-Agent': USER_AGENT
};

// Only used if the live /servers call fails outright.
const FALLBACK_SERVERS = [
  { name: 'Lisbon', is4k: true },
  { name: 'Nebula', is4k: false },
  { name: 'Solara', is4k: false },
  { name: 'Athens', is4k: false }
];

function base64UrlToBuffer(s) {
  let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

function bufferToBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => ({
      title: mediaType === 'tv' ? data.name : data.title,
      year: parseInt(((mediaType === 'tv' ? data.first_air_date : data.release_date) || '').substring(0, 4), 10) || '',
      imdbId: (data.external_ids && data.external_ids.imdb_id) || null
    }))
    .catch(() => ({ title: null, year: '', imdbId: null }));
}

function getServerList() {
  return fetch(`${CINEJOY_API_BASE}/servers`, { headers: REQUEST_HEADERS })
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      const servers = data && Array.isArray(data.servers) ? data.servers : [];
      const active = servers
        .filter(s => s && s.name && s.status !== 'disabled')
        .map(s => ({ name: s.name, is4k: s['4k'] === true }));
      return active.length ? active : FALLBACK_SERVERS;
    })
    .catch(() => FALLBACK_SERVERS);
}

function buildPlainUrl({ title, type, year, imdbId, tmdbId, server, season, episode }) {
  let url = `${CINEJOY_API_BASE}/?title=${title}&type=${type}&year=${year}&imdb=${imdbId}&tmdb=${tmdbId}&server=${server}`;
  if (type === 'series') url += `&season=${season}&episode=${episode}`;
  return url;
}

// Round-trips one server through the enc-dec.app helper: seal the plaintext
// request, POST the sealed bytes to Cinejoy's own API, then have the helper
// open the sealed response. Returns the server's raw CinejoyStream[] (or []).
function queryServer(params) {
  const encodedUrl = encodeURIComponent(buildPlainUrl(params));

  return fetch(`${ENC_DEC_BASE}/enc-cinejoy?url=${encodedUrl}`)
    .then(res => res.json())
    .then(encJson => {
      const result = encJson && encJson.status === 200 ? encJson.result : null;
      if (!result || !result.data) return null;
      const reqBytes = base64UrlToBuffer(result.data);
      const state = result.state;

      return fetch(`${CINEJOY_API_BASE}/g`, {
        method: 'POST',
        headers: Object.assign({}, REQUEST_HEADERS, { 'Content-Type': 'application/octet-stream' }),
        body: reqBytes
      })
        .then(res => res.arrayBuffer())
        .then(buf => {
          const respB64 = bufferToBase64Url(Buffer.from(buf));
          return fetch(`${ENC_DEC_BASE}/dec-cinejoy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: respB64, state })
          });
        })
        .then(res => res.json());
    })
    .then(decJson => {
      const data = decJson && decJson.status === 200 && decJson.result ? decJson.result.data : null;
      return data && Array.isArray(data.stream) ? data.stream : [];
    })
    .catch(err => {
      console.log(`[Cinejoy] ${params.server} failed: ${err.message}`);
      return [];
    });
}

// Confirmed live: a server can return a stale/dead link for a given title
// (Nebula did, for "The Godfather") that still 200s but serves a tiny
// unrelated image instead of a real manifest - HTTP status alone doesn't
// catch this, so m3u8 links are GET-checked for real playlist content
// (matching peachify.js's approach). Direct file links only get a cheap
// HEAD, since a full GET would download the whole video just to validate it.
function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return fetch(stream.url, { headers: stream.headers })
      .then(res => {
        if (!res.ok) return false;
        return res.text().then(text => /^#EXTM3U/.test(text.trim()));
      })
      .catch(() => false);
  }
  return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => false);
}

function mapCaptions(captions) {
  if (!Array.isArray(captions)) return [];
  return captions
    .filter(c => c && c.url)
    .map(c => ({ url: c.url, language: c.language || c.label || 'Unknown', name: c.label || c.language || 'Unknown' }));
}

function streamsFromServer(serverName, is4k, cinejoyStreams) {
  const out = [];
  for (const stream of cinejoyStreams) {
    if (!stream || typeof stream !== 'object') continue;
    const subtitles = mapCaptions(stream.captions);

    if (stream.type === 'hls' && stream.playlist) {
      out.push({
        name: `Cinejoy - ${serverName}`,
        title: `Cinejoy - ${serverName}`,
        url: stream.playlist,
        quality: is4k ? '4K' : 'Auto',
        headers: REQUEST_HEADERS,
        subtitles,
        provider: 'cinejoy'
      });
    } else if (stream.type === 'file' && stream.qualities && typeof stream.qualities === 'object') {
      for (const qualityKey of Object.keys(stream.qualities)) {
        const qualityData = stream.qualities[qualityKey];
        if (!qualityData || !qualityData.url) continue;
        const quality = /p$/i.test(qualityKey) || qualityKey.toLowerCase() === '4k' ? qualityKey : `${qualityKey}p`;
        out.push({
          name: `Cinejoy - ${serverName}`,
          title: `Cinejoy - ${serverName} ${quality}`,
          url: qualityData.url,
          quality,
          headers: REQUEST_HEADERS,
          subtitles,
          provider: 'cinejoy'
        });
      }
    }
  }
  return out;
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const isSeries = mediaType === 'tv';
  const type = isSeries ? 'series' : 'movie';
  if (isSeries && (!season || !episode)) {
    console.log('[Cinejoy] Missing season/episode for series lookup');
    return Promise.resolve([]);
  }

  console.log(`[Cinejoy] getStreams start tmdbId=${tmdbId} type=${type}`);

  return Promise.all([getTmdbInfo(tmdbId, mediaType), getServerList()])
    .then(([info, servers]) => {
      if (!info.title || !info.imdbId) {
        console.log('[Cinejoy] Could not resolve title/imdb id from TMDB');
        return [];
      }

      return Promise.all(
        servers.map(server =>
          queryServer({
            title: info.title,
            type,
            year: info.year,
            imdbId: info.imdbId,
            tmdbId,
            server: server.name,
            season,
            episode
          }).then(cinejoyStreams => streamsFromServer(server.name, server.is4k, cinejoyStreams))
        )
      ).then(results => {
        const seenUrls = new Set();
        const streams = [];
        for (const s of results.flat()) {
          if (seenUrls.has(s.url)) continue;
          seenUrls.add(s.url);
          streams.push(s);
        }
        console.log(`[Cinejoy] Found ${streams.length} candidate stream(s) across ${servers.length} server(s), validating...`);
        return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
          const valid = validated.filter(v => v.ok).map(v => v.stream);
          const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
          if (dead.length) console.log(`[Cinejoy] Dropping unreachable: ${dead.join(', ')}`);
          console.log(`[Cinejoy] ${valid.length}/${streams.length} stream(s) validated OK`);
          return valid;
        });
      });
    })
    .catch(err => {
      console.log(`[Cinejoy] getStreams failed: ${err.message}`);
      return [];
    });
}

module.exports = { getStreams };
