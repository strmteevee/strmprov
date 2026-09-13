// DoFlix scraper for Nuvio Local Scrapers
//
// Reverse-engineered from the DoFlix CloudStream plugin (com.cncverse.DoFlixProvider,
// from cloudstream/DoFlixProvider.cs3). jadx hit a StackOverflowError decompiling
// loadLinks' coroutine state machine; dex2jar + the CFR decompiler succeeded where
// jadx couldn't. The backend is keyed directly by TMDB id - no title search or
// internal-id matching needed, unlike most sites this repo scrapes:
//
//   GET https://panel.watchkaroabhi.com/api/3/movie/{tmdbId}/links?api_key=...
//   GET https://panel.watchkaroabhi.com/api/3/tv/{tmdbId}/season/{s}/episode/{e}/links?api_key=...
//   -> { "links": [...] } for movies, { "results": [...] } for episodes (the
//      plugin uses separate MovieLinksResponse/EpisodeLinksResponse types with
//      different field names for what's otherwise the same [{host,quality,url}]
//      shape) - accept either key so both paths work uniformly.
//
// api_key is a static value baked into the plugin itself, not a per-user secret.
// The four headers below are injected on every metadata-API request by the app's
// own OkHttp interceptor (HeaderReplacementInterceptor); the stream URLs
// themselves only need a plain Referer, set separately per link in the plugin's
// own code (extractorLink.setReferer("https://molop.art/")) - not the same
// headers used for the API call.
//
// NOT verified end-to-end. Every request to panel.watchkaroabhi.com from this
// dev machine - tried via both Node's fetch and curl - was blocked at the TLS
// layer itself: the server demands two TLS renegotiations then closes the
// connection, even on a bare GET / with no custom headers at all, so this isn't
// specific to any header or endpoint here. Nuvio's own fetch is bridged to a
// real Android OkHttp client, the same stack the actual DoFlix app is built on,
// which may negotiate this differently than curl/Node did - this could work in
// Nuvio's real sandbox despite failing every client tried while writing it. If
// the TLS layer itself blocks the request there too, no JS-level change here
// can work around that.

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://panel.watchkaroabhi.com';
const API_KEY = 'qNhKLJiZVyoKdi9NCQGz8CIGrpUijujE';

const API_HEADERS = {
  'Connection': 'Keep-Alive',
  'User-Agent': 'dooflix',
  'X-App-Version': '305',
  'X-Package-Name': 'com.king.moja'
};

const PLAYBACK_HEADERS = {
  'Referer': 'https://molop.art/'
};

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[DoFlix] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

// A plain HEAD/ranged-GET on the stream URL isn't enough for HLS (.m3u8)
// streams - seen twice already in this repo (Vidrock's "Atlas", Peachify) where
// the manifest itself loads fine from a stable routing layer while the actual
// segments it points to are dead - so for .m3u8 URLs, walk the manifest chain
// down to a real segment reference and validate that instead of the manifest.
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

function mapLinksToStreams(links, mediaInfo) {
  if (!Array.isArray(links)) return [];
  const label = mediaInfo.title
    ? `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`
    : 'Auto Quality Stream';
  return links
    .filter(l => l && l.url)
    .map(l => ({
      name: `DoFlix - ${l.host || 'Unknown'}`,
      title: label,
      url: l.url,
      quality: l.quality || 'Auto',
      type: 'direct',
      headers: PLAYBACK_HEADERS,
      provider: 'doflix'
    }));
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[DoFlix] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[DoFlix] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  const apiUrl = mediaType === 'tv'
    ? `${API_BASE}/api/3/tv/${tmdbId}/season/${season}/episode/${episode}/links?api_key=${API_KEY}`
    : `${API_BASE}/api/3/movie/${tmdbId}/links?api_key=${API_KEY}`;

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    console.log(`[DoFlix] Requesting: ${apiUrl}`);
    return fetch(apiUrl, { headers: API_HEADERS })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        const links = data.links || data.results || [];
        const streams = mapLinksToStreams(links, mediaInfo);
        console.log(`[DoFlix] Found ${streams.length} stream(s), validating...`);
        return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
          const valid = validated.filter(v => v.ok).map(v => v.stream);
          const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
          if (dead.length) console.log(`[DoFlix] Dropping unreachable: ${dead.join(', ')}`);
          console.log(`[DoFlix] ${valid.length}/${streams.length} stream(s) validated OK`);
          return valid;
        });
      });
  }).catch(err => {
    console.log(`[DoFlix] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
