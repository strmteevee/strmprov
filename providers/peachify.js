// Peachify scraper for Nuvio Local Scrapers
//
// peachify.top is a Next.js CSR site (same "vidsrc-clone" family listed in
// yflix.ws's own source list) whose data fetch is invisible in a plain fetch
// of the page - it's all client-side JS. Traced the actual mechanism by
// downloading and reading its Turbopack chunks directly:
//
//   GET https://none.eat-peach.sbs/{provider}/movie/{tmdbId}
//   GET https://none.eat-peach.sbs/{provider}/tv/{tmdbId}/{season}/{episode}
//   (with Origin/Referer: https://peachify.top - required, plain requests get 403)
//
// {provider} is one of "air", "holly", "multi" (a 4th, "moviebox", 404s -
// looks retired). Response is usually plain JSON ({sources:[], subtitles:[]}),
// but the client also handles an encrypted form: {isEncrypted:true, data:
// "ivB64url.part1B64url.part2B64url"}, AES-256-GCM with a hardcoded key -
// implemented here the same hand-rolled way as vidrock.js (crypto-js has no
// native GCM), in case a given provider/title returns that form.
//
// The stream URLs themselves route through peachify's own CDN proxy
// (a.eat-peach.sbs/m3u8-proxy?url=...&headers=...) which also requires the
// Origin/Referer headers above - without them it 403s even though the proxy
// URL already encodes the real upstream's own required headers.

const CryptoJS = require('crypto-js');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://none.eat-peach.sbs';
const SITE_URL = 'https://peachify.top';
const PROVIDERS = ['air', 'holly', 'multi'];

// AES-256 key (hex) pulled from peachify.top's own client bundle.
const GCM_KEY_HEX = 'd8f2a1b5e9c470814f6b2c3a5d8e7f901a2b3c4d5e3f7a8b9c0d1e2f3a4d5c6d';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  'Origin': SITE_URL,
  'Referer': SITE_URL + '/',
  'Accept': 'application/json'
};

// ---- crypto-js WordArray <-> byte helpers ----

function bytesToWordArray(bytes) {
  const words = [];
  for (let i = 0; i < bytes.length; i++) {
    words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8);
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length);
}

function wordArrayToBytes(wordArray) {
  const { words, sigBytes } = wordArray;
  const bytes = new Uint8Array(sigBytes);
  for (let i = 0; i < sigBytes; i++) {
    bytes[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return bytes;
}

function base64UrlToBytes(base64url) {
  let b64 = String(base64url).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return wordArrayToBytes(CryptoJS.enc.Base64.parse(b64));
}

function aesEcbEncryptBlock(keyWordArray, blockBytes) {
  const encrypted = CryptoJS.AES.encrypt(bytesToWordArray(blockBytes), keyWordArray, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.NoPadding
  });
  return wordArrayToBytes(encrypted.ciphertext);
}

// AES-256-GCM decrypt via manual CTR keystream (crypto-js has no GCM mode).
// Auth tag is not verified - we only care about recovering the plaintext.
function gcmDecrypt(ivBytes, ciphertextBytes, keyHex) {
  const key = CryptoJS.enc.Hex.parse(keyHex);
  const plain = new Uint8Array(ciphertextBytes.length);
  const numBlocks = Math.ceil(ciphertextBytes.length / 16) || 0;
  for (let b = 0; b < numBlocks; b++) {
    const counter = b + 2; // GCM keystream starts at counter=2
    const counterBlock = new Uint8Array(16);
    counterBlock.set(ivBytes, 0);
    counterBlock[12] = (counter >>> 24) & 0xff;
    counterBlock[13] = (counter >>> 16) & 0xff;
    counterBlock[14] = (counter >>> 8) & 0xff;
    counterBlock[15] = counter & 0xff;

    const keystream = aesEcbEncryptBlock(key, counterBlock);
    const start = b * 16;
    const end = Math.min(start + 16, ciphertextBytes.length);
    for (let i = start; i < end; i++) {
      plain[i] = ciphertextBytes[i] ^ keystream[i - start];
    }
  }
  let str = '';
  for (let i = 0; i < plain.length; i++) str += String.fromCharCode(plain[i]);
  try {
    return JSON.parse(decodeURIComponent(escape(str)));
  } catch (e) {
    return null;
  }
}

// Encrypted payload format: "ivB64url.part1B64url.part2B64url" - parts are
// concatenated (ciphertext||tag), tag (last 16 bytes) is discarded.
function decryptPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const iv = base64UrlToBytes(parts[0]);
  const a = base64UrlToBytes(parts[1]);
  const b = base64UrlToBytes(parts[2]);
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  const ciphertext = combined.slice(0, combined.length - 16);
  return gcmDecrypt(iv, ciphertext, GCM_KEY_HEX);
}

// Peachify's providers sometimes return dead/expired links (the upstream
// CDN a given provider proxies to changes without peachify's own API
// noticing) - validate each one live and only return what's actually
// reachable, rather than showing a stream that 404s the moment it's tapped.
// No JS-level timeout exists in this sandbox (no setTimeout), so a hung
// check is bounded only by the native fetch bridge's own ~30s timeout.
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

// HLS manifests are often served by a stable routing layer even when the
// actual segments behind them are dead, so a plain HEAD/GET on the .m3u8
// itself isn't a reliable check - walk the chain down to a real segment.
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

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[Peachify] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

function mapSubtitles(subtitles) {
  if (!Array.isArray(subtitles)) return [];
  return subtitles
    .filter(s => s && s.url)
    .map(s => ({ url: s.url, language: s.label || s.lang || 'Unknown', name: s.label || s.lang || 'Unknown' }));
}

// Doesn't depend on mediaInfo (the display label is attached afterward, once
// the parallel TMDB lookup below also resolves) - see getStreams for why that
// split matters here specifically.
function fetchFromProvider(provider, tmdbId, mediaType, season, episode) {
  let apiUrl = `${API_BASE}/${provider}/${mediaType}/${tmdbId}`;
  if (mediaType === 'tv') apiUrl += `/${season}/${episode}`;

  return fetch(apiUrl, { headers: REQUEST_HEADERS })
    .then(res => {
      if (!res.ok) return null;
      return res.json();
    })
    .then(body => {
      if (!body) return [];
      let data = body;
      if (body.isEncrypted && body.data) {
        data = decryptPayload(body.data);
        if (!data) return [];
      }
      if (!data || !Array.isArray(data.sources) || data.sources.length === 0) return [];

      const subtitles = mapSubtitles(data.subtitles);

      return data.sources
        .filter(s => s && s.url)
        .map(s => ({
          name: `Peachify - ${provider}${s.dub ? ' [' + s.dub + ']' : ''}`,
          url: s.url,
          quality: s.quality ? `${s.quality}p` : 'Auto',
          type: 'direct',
          // Confirmed live the CDN these actually point to (mendx437sim.com)
          // doesn't enforce Origin/Referer either way, so this wasn't itself
          // the bug behind low success - but each source DOES carry its own
          // real per-source headers (a different origin/referer than
          // peachify.top's own, confirmed live in the raw API response) that
          // were being silently discarded in favor of the generic
          // REQUEST_HEADERS regardless. Using them when present is still the
          // correct behavior in general - other providers/titles routed
          // through a CDN that does check these would have failed exactly
          // the way vidrock.js's missing Origin header did.
          headers: s.headers || REQUEST_HEADERS,
          subtitles,
          provider: 'peachify'
        }));
    })
    .catch(err => {
      console.log(`[Peachify] ${provider} failed: ${err.message}`);
      return [];
    });
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[Peachify] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[Peachify] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  // Peachify's own signed stream URLs are valid for only a few minutes from
  // the moment its API generates them - confirmed live, one real source's own
  // embedded expiry timestamp left as little as ~3 minutes of headroom at the
  // moment it was returned. The TMDB lookup only feeds the display `title`
  // below, not the provider requests that actually mint those URLs, but it
  // used to run FIRST and block them - burning a whole extra round trip off
  // an already-tight budget before validation (itself multiple sequential
  // hops per candidate, for m3u8 chains) even gets to start. Running both in
  // parallel instead gets the clock-sensitive provider fetches underway
  // immediately.
  const tmdbInfoPromise = getTmdbInfo(tmdbId, mediaType);
  const providerResultsPromise = Promise.all(
    PROVIDERS.map(p => fetchFromProvider(p, tmdbId, mediaType, season, episode))
  );

  return Promise.all([tmdbInfoPromise, providerResultsPromise]).then(([mediaInfo, results]) => {
    const label = mediaInfo.title
      ? `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`
      : 'Auto Quality Stream';
    const streams = results.flat().map(s => Object.assign({}, s, { title: label }));
    console.log(`[Peachify] Found ${streams.length} stream(s) across ${PROVIDERS.length} providers, validating...`);
    return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
      const valid = validated.filter(v => v.ok).map(v => v.stream);
      const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
      if (dead.length) console.log(`[Peachify] Dropping unreachable: ${dead.join(', ')}`);
      console.log(`[Peachify] ${valid.length}/${streams.length} stream(s) validated OK`);
      return valid;
    });
  }).catch(err => {
    console.log(`[Peachify] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
