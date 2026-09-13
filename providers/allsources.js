// AllSources - combines every scraper in this repo into one Nuvio plugin.
//
// GENERATED FILE - do not hand-edit. Run `node build-combined.js` from the
// repo root to regenerate after changing any of the individual provider
// files listed at the top of build-combined.js.
//
// Nuvio loads each scraper as an independent script with no cross-file
// require() between plugins, so the only way to combine sources is to
// physically inline all of their code into one file - each source below is
// wrapped in its own IIFE so its internal helpers (getTmdbInfo, USER_AGENT,
// makeRequest, etc. - names reused across nearly every source file) stay
// scoped to that source and never collide with another source's identically
// named internals.
"use strict";

const PeachifySource = (function () {
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

function fetchFromProvider(provider, tmdbId, mediaType, season, episode, mediaInfo) {
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
      const label = mediaInfo.title
        ? `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`
        : 'Auto Quality Stream';

      return data.sources
        .filter(s => s && s.url)
        .map(s => ({
          name: `Peachify - ${provider}${s.dub ? ' [' + s.dub + ']' : ''}`,
          title: label,
          url: s.url,
          quality: s.quality ? `${s.quality}p` : 'Auto',
          type: 'direct',
          headers: REQUEST_HEADERS,
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

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    return Promise.all(
      PROVIDERS.map(p => fetchFromProvider(p, tmdbId, mediaType, season, episode, mediaInfo))
    ).then(results => {
      const streams = results.flat();
      console.log(`[Peachify] Found ${streams.length} stream(s) across ${PROVIDERS.length} providers, validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
        if (dead.length) console.log(`[Peachify] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[Peachify] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    });
  }).catch(err => {
    console.log(`[Peachify] getStreams failed: ${err.message}`);
    return [];
  });
}
  return { getStreams: getStreams };
})();

const VidrockSource = (function () {
// Vidrock scraper for Nuvio Local Scrapers
//
// The site dropped the old scheme this provider used (AES-CBC encrypting the
// TMDB id as a request param, via a now-dead helper at aesdec.nuvioapp.space)
// and flipped it around: requests are now plain -
//
//   GET https://vidrock.net/api/movie/{tmdbId}
//   GET https://vidrock.net/api/tv/{tmdbId}/{season}/{episode}
//   -> { "<Server>": { "url": "<base64url ciphertext>", "language", "flag", "type" }, ... }
//
// - and it's the RESPONSE urls that are now encrypted, with AES-256-GCM this
// time. Traced through the site's own Vite bundle (assets/index-*.js) to find
// the scheme: base64url-decode the token, first 12 bytes are the IV, last 16
// bytes of the remainder are the GCM auth tag (unused here - we don't verify
// it, just decrypt), and the AES-256 key is a hardcoded hex string in that
// same bundle. crypto-js has no native GCM mode, so this reimplements GCM's
// counter-mode keystream (AES-ECB-encrypt IV||counter, XOR into ciphertext)
// by hand - verified byte-for-byte against Node's built-in `crypto` GCM
// implementation before shipping.
//
// One server ("Astra") is different: its decrypted URL is itself a JSON
// playlist of {resolution, url} direct MP4 links rather than a single video
// URL, so it's expanded into one stream per resolution.

const CryptoJS = require('crypto-js');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const VIDROCK_BASE_URL = 'https://vidrock.net';
// AES-256 key (hex) pulled from vidrock.net's own client bundle.
const GCM_KEY_HEX = '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': `${VIDROCK_BASE_URL}/`,
  'Origin': VIDROCK_BASE_URL,
  'Accept': 'application/json'
};
const PLAYBACK_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': `${VIDROCK_BASE_URL}/`
};

// vidrock.net's own backend always advertises the same handful of named
// servers (Nova, Luna, Orion, Astra, Atlas, ...), but which of them are
// actually reachable varies day to day - some sit behind a Cloudflare
// bot-challenge, some 403 outright, some time out at the origin. Rather than
// serve a pile of dead links that all fail the moment a user taps them,
// validate each one and only return the ones that actually respond. There's
// no JS-level timeout available in this sandbox (no setTimeout), so a hung
// check is bounded only by the native fetch bridge's own ~30s timeout rather
// than a tighter one - slower in the worst case, but still correct.
//
// A plain HEAD/ranged-GET on the stream URL isn't enough for HLS (.m3u8)
// streams: the manifest itself (and any nested variant playlist under it)
// is served by vidrock's own always-up routing layer, so it loads fine even
// when the actual video segments it points to - hosted on a separate,
// less reliable CDN - are dead or blocked (seen in practice: "Atlas"'s
// master.m3u8 and its variant playlist both returned 200, while every
// segment inside 403'd). So for .m3u8 URLs, walk the manifest chain down to
// a real segment reference and validate that instead of the manifest.
function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

// Astra's per-resolution URLs route through a v1.streamrk.site proxy in
// front of hakunaymatata.com - the same backend already found unreliable
// behind Vidlink (rate-limited there). Here it doesn't fail fast: measured
// directly, it takes ~19-20 seconds to return a Cloudflare 522 (origin
// connection timeout) rather than erroring out quickly. Since validation
// runs every candidate in parallel and waits for all of them, that one slow
// host was single-handedly stretching every Vidrock call to ~20+ seconds
// even when a fast, valid stream (e.g. Nova, usually ready in ~1-2s) was
// already available - there's no JS timer in this sandbox to cut a single
// slow request short, so the only fix is to not make the request at all for
// a host already proven to hang this long.
function isKnownSlowHost(url) {
  return /hakunaymatata\.com/i.test(url);
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
  if (isKnownSlowHost(url)) {
    return Promise.resolve(false);
  }
  return fetch(url, { headers })
    .then(res => {
      if (!res.ok) return false;
      return res.text().then(text => {
        const next = firstManifestRef(text, url);
        if (!next) return true; // nothing to follow - manifest itself is the only signal we have
        if (isKnownSlowHost(next)) return false;
        if (isM3u8Url(next) && hopsLeft > 0) {
          return validateM3u8Chain(next, headers, hopsLeft - 1);
        }
        // `next` is an actual media segment - this is the real reachability check.
        return rangedValidateUrl(next, headers);
      });
    })
    .catch(() => false);
}

function validateStreamUrl(stream) {
  if (isKnownSlowHost(stream.url)) {
    return Promise.resolve(false);
  }
  if (isM3u8Url(stream.url)) {
    return validateM3u8Chain(stream.url, stream.headers, 2);
  }
  // A HEAD response that comes back with a definitive status (403, 522, ...)
  // is conclusive - retrying with GET won't change a Cloudflare challenge or
  // an origin timeout. Only fall back to a ranged GET when HEAD itself fails
  // outright (some CDNs reject the method with a hard connection error
  // rather than a clean status code).
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

// ---- byte/WordArray helpers (crypto-js WordArrays are big-endian words) ----

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

// Decrypts an AES-256-GCM token (base64url IV(12) || ciphertext || tag(16))
// using manual CTR-mode keystream generation. Auth tag is not verified.
function gcmDecryptToken(token, keyHex) {
  const data = base64UrlToBytes(token);
  const iv = data.slice(0, 12);
  const rest = data.slice(12);
  const ciphertext = rest.slice(0, rest.length - 16);
  const key = CryptoJS.enc.Hex.parse(keyHex);

  const plain = new Uint8Array(ciphertext.length);
  const numBlocks = Math.ceil(ciphertext.length / 16) || 0;
  for (let b = 0; b < numBlocks; b++) {
    const counter = b + 2; // GCM keystream starts at counter=2 (counter=1 is reserved for the tag)
    const counterBlock = new Uint8Array(16);
    counterBlock.set(iv, 0);
    counterBlock[12] = (counter >>> 24) & 0xff;
    counterBlock[13] = (counter >>> 16) & 0xff;
    counterBlock[14] = (counter >>> 8) & 0xff;
    counterBlock[15] = counter & 0xff;

    const keystream = aesEcbEncryptBlock(key, counterBlock);
    const start = b * 16;
    const end = Math.min(start + 16, ciphertext.length);
    for (let i = start; i < end; i++) {
      plain[i] = ciphertext[i] ^ keystream[i - start];
    }
  }

  let str = '';
  for (let i = 0; i < plain.length; i++) str += String.fromCharCode(plain[i]);
  try {
    return decodeURIComponent(escape(str));
  } catch (e) {
    return str;
  }
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[Vidrock] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

function expandAstraPlaylist(playlistUrl, mediaInfo) {
  return fetch(playlistUrl, { headers: PLAYBACK_HEADERS })
    .then(res => res.json())
    .then(list => {
      if (!Array.isArray(list)) return [];
      const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;
      return list
        .filter(item => item && item.url && item.resolution)
        .map(item => ({
          name: `Vidrock - Astra ${item.resolution}p`,
          title: label,
          url: item.url,
          quality: `${item.resolution}p`,
          type: 'direct',
          headers: PLAYBACK_HEADERS,
          provider: 'vidrock'
        }));
    })
    .catch(err => {
      console.log(`[Vidrock] Astra playlist fetch failed: ${err.message}`);
      return [];
    });
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[Vidrock] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[Vidrock] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  const path = mediaType === 'tv' ? `tv/${tmdbId}/${season}/${episode}` : `movie/${tmdbId}`;
  const apiUrl = `${VIDROCK_BASE_URL}/api/${path}`;

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    console.log(`[Vidrock] Requesting: ${apiUrl}`);
    return fetch(apiUrl, { headers: REQUEST_HEADERS })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (!data || typeof data !== 'object') return [];
        const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;
        const astraExpansions = [];
        const streams = [];

        for (const [server, info] of Object.entries(data)) {
          if (!info || !info.url) continue;
          let decryptedUrl;
          try {
            decryptedUrl = gcmDecryptToken(info.url, GCM_KEY_HEX);
          } catch (e) {
            console.log(`[Vidrock] ${server}: decrypt failed - ${e.message}`);
            continue;
          }
          if (!decryptedUrl || !decryptedUrl.startsWith('http')) continue;

          if (server === 'Astra' && decryptedUrl.includes('/playlist/')) {
            astraExpansions.push(expandAstraPlaylist(decryptedUrl, mediaInfo));
            continue;
          }

          const langTag = info.language ? ` [${info.language}]` : '';
          streams.push({
            name: `Vidrock - ${server}${langTag}`,
            title: label,
            url: decryptedUrl,
            quality: info.type === 'hls' ? 'Auto' : 'Unknown',
            type: 'direct',
            headers: PLAYBACK_HEADERS,
            provider: 'vidrock'
          });
        }

        return Promise.all(astraExpansions).then(expanded => {
          const all = streams.concat(expanded.flat());
          console.log(`[Vidrock] Found ${all.length} stream(s), validating...`);
          return Promise.all(all.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(results => {
            const valid = results.filter(r => r.ok).map(r => r.stream);
            const dead = results.filter(r => !r.ok).map(r => r.stream.name);
            if (dead.length) console.log(`[Vidrock] Dropping unreachable: ${dead.join(', ')}`);
            console.log(`[Vidrock] ${valid.length}/${all.length} stream(s) validated OK`);
            return valid;
          });
        });
      });
  }).catch(err => {
    console.log(`[Vidrock] getStreams failed: ${err.message}`);
    return [];
  });
}
  return { getStreams: getStreams };
})();

const MovieBoxSource = (function () {
// MovieBox scraper for Nuvio Local Scrapers
//
// The previous moviebox.js targeted the native-app API (api3.aoneroom.com),
// which requires a per-request HMAC signature ("x-tr-signature") whose secret
// keys went stale and started returning 441 "miss token" for every request.
//
// This rewrite instead targets MovieBox's H5 (mobile web) API
// (h5-api.aoneroom.com/wefeed-h5api-bff), which a community CloudStream/API
// project (github.com/walterwhite-69/Moviebox-API) showed uses much simpler
// auth: a guest JWT handed back in the `x-user` response header of any GET
// to /home - no signing at all. Flow, confirmed working live:
//
//   1. GET  /home?host=moviebox.ph                 -> x-user header has the JWT
//   2. POST /subject/search {keyword,page,perPage}  -> candidates incl. detailPath
//   3. GET  /detail?detailPath=X                    -> canonical subjectId
//      (search results are split per-season/per-dub; /detail's subject is the
//      canonical multi-season entry, which is what /subject/play expects)
//   4. GET  /media-player/get-domain                -> current play domain (rotates)
//   5. GET  {domain}/wefeed-h5api-bff/subject/play?subjectId=&se=&ep=&detailPath=
//      with a Referer that mimics the real player page
//      -> direct MP4 sources (+ hls/dash if present)
//
// Gotcha found while testing: for movies, se/ep MUST be 0/0 - sending 1/1 (a
// reasonable-looking default) makes the API report hasResource:false even
// when the title genuinely has a resource. TV shows use real season/episode
// numbers against the single canonical (multi-season) subjectId.

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': 'https://moviebox.ph/',
  'Origin': 'https://moviebox.ph',
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};

let cachedToken = null;

function getBearerToken() {
  if (cachedToken) return Promise.resolve(cachedToken);
  return fetch(`${API_BASE}/home?host=moviebox.ph`, { headers: BASE_HEADERS })
    .then(res => {
      const xUser = res.headers.get('x-user');
      if (xUser) {
        try {
          cachedToken = JSON.parse(xUser).token || null;
        } catch (e) {}
      }
      return cachedToken;
    })
    .catch(err => {
      console.log(`[MovieBox] Failed to acquire guest token: ${err.message}`);
      return null;
    });
}

function authHeaders(token, extra) {
  return Object.assign({}, BASE_HEADERS, { 'Authorization': token ? `Bearer ${token}` : '' }, extra || {});
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[MovieBox] TMDB Info: "${title}" (${year})`);
      return { title, year };
    });
}

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/[:\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

// Below this, the match is a loose substring hit (e.g. "Fortnite x the
// Simpsons" containing "simpsons") rather than the actual title - reject it
// instead of confidently serving the wrong content.
const MIN_MATCH_SCORE = 25;
function findBestMatch(items, mediaInfo, mediaType) {
  const wantType = mediaType === 'tv' ? 2 : 1;
  const normTarget = normalizeTitle(mediaInfo.title);
  let best = null;
  let bestScore = -1;
  for (const item of items) {
    if (item.subjectType !== wantType) continue;
    const normTitle = normalizeTitle(item.title);
    let score = 0;
    if (normTitle === normTarget) score += 50;
    else if (normTitle.startsWith(normTarget) || normTarget.startsWith(normTitle)) score += 25;
    else if (normTitle.includes(normTarget)) score += 10;
    else continue;
    const itemYear = (item.releaseDate || '').substring(0, 4);
    if (mediaInfo.year && itemYear === mediaInfo.year) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (best && bestScore < MIN_MATCH_SCORE) {
    console.log(`[MovieBox] Best candidate "${best.title}" scored ${bestScore} (below ${MIN_MATCH_SCORE}) - treating as no match`);
    return null;
  }
  return best;
}

function search(token, keyword) {
  return fetch(`${API_BASE}/subject/search`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ keyword, page: 1, perPage: 20 })
  })
    .then(res => res.json())
    .then(json => (json && json.data && json.data.items) || []);
}

function getCanonicalSubject(token, detailPath) {
  return fetch(`${API_BASE}/detail?detailPath=${encodeURIComponent(detailPath)}`, { headers: authHeaders(token) })
    .then(res => res.json())
    .then(json => (json && json.data && json.data.subject) || null);
}

function getPlayDomain(token) {
  return fetch(`${API_BASE}/media-player/get-domain`, { headers: authHeaders(token) })
    .then(res => res.json())
    .then(json => (json && json.data ? String(json.data).replace(/\/$/, '') : 'https://netfilm.world'));
}

function fetchPlayData(token, domain, subjectId, detailPath, se, ep) {
  const referer = `${domain}/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`;
  const playUrl = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${detailPath}`;
  return fetch(playUrl, { headers: authHeaders(token, { Referer: referer }) })
    .then(res => res.json())
    .then(json => (json && json.data) || null);
}

function fetchCaptions(token, subjectId, detailPath, firstStream) {
  if (!firstStream) return Promise.resolve([]);
  const format = firstStream.format || 'MP4';
  const capUrl = `${API_BASE}/subject/caption?format=${format}&id=${firstStream.id}&subjectId=${subjectId}&detailPath=${detailPath}`;
  return fetch(capUrl, { headers: authHeaders(token) })
    .then(res => res.json())
    .then(json => {
      const captions = (json && json.data && json.data.captions) || [];
      return captions
        .filter(c => c && c.url)
        .map(c => ({ url: c.url, language: c.lanName || c.lan || 'Unknown', name: c.lanName || c.lan || 'Unknown' }));
    })
    .catch(() => []);
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[MovieBox] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[MovieBox] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    return getBearerToken().then(token => {
      if (!token) {
        console.log('[MovieBox] Could not acquire guest token');
        return [];
      }
      return search(token, mediaInfo.title).then(items => {
        const match = findBestMatch(items, mediaInfo, mediaType);
        if (!match) {
          console.log(`[MovieBox] No match found for "${mediaInfo.title}"`);
          return [];
        }
        console.log(`[MovieBox] Matched: "${match.title}" (${match.detailPath})`);

        return getCanonicalSubject(token, match.detailPath).then(subject => {
          const subjectId = (subject && subject.subjectId) || match.subjectId;
          const detailPath = (subject && subject.detailPath) || match.detailPath;

          return getPlayDomain(token).then(domain => {
            const se = mediaType === 'tv' ? season : 0;
            const ep = mediaType === 'tv' ? episode : 0;
            return fetchPlayData(token, domain, subjectId, detailPath, se, ep).then(playData => {
              if (!playData || !playData.hasResource || !Array.isArray(playData.streams) || playData.streams.length === 0) {
                console.log('[MovieBox] No playable resource for this title');
                return [];
              }

              return fetchCaptions(token, subjectId, detailPath, playData.streams[0]).then(subtitles => {
                const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;
                const streams = playData.streams.map(s => ({
                  name: 'MovieBox',
                  title: `${label} - ${s.resolutions}p`,
                  url: s.url,
                  quality: `${s.resolutions}p`,
                  size: s.size ? `${(Number(s.size) / (1024 * 1024)).toFixed(0)} MB` : undefined,
                  type: 'direct',
                  headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://moviebox.ph/' },
                  subtitles,
                  provider: 'moviebox'
                }));
                console.log(`[MovieBox] Successfully processed ${streams.length} streams`);
                return streams;
              });
            });
          });
        });
      });
    });
  }).catch(err => {
    console.log(`[MovieBox] getStreams failed: ${err.message}`);
    return [];
  });
}
  return { getStreams: getStreams };
})();

const RiveStreamSource = (function () {
// RiveStream scraper for Nuvio Local Scrapers
//
// RiveStream (rivestream.app / www.rivestream.app) is a Next.js streaming
// site whose source is partly open (github.com/BytesGaming/rive). Its player
// calls a "scrapper" backend directly by TMDB id:
//
//   GET https://scrapper.rivestream.app/api/providers
//     -> {"data": ["apex","pulse","solstice","quasar","horizon",
//                  "primevids","asiacloud","citadel","guru"]}
//   GET https://scrapper.rivestream.app/api/provider?provider={name}&id={tmdbId}
//     (+ &season=&episode= for TV)
//     -> {"data": {"sources": [{quality,url,source,format}], "captions": [...]}}
//
// No auth/session/signing of any kind is needed - this is a plain public
// JSON API discovered by reading the site's own Next.js bundle. In testing,
// only "citadel" and "primevids" reliably returned sources (the rest replied
// {"data":null} or an error for every title tried), but all services are
// queried in parallel here since that costs nothing and some may only carry
// specific titles. "asiacloud" is excluded: it consistently takes ~15s to
// respond (vs <1s for every other service) and has never once returned a
// usable source in testing, so it was just adding 15s of dead latency to
// every single call (Promise.all waits on the slowest member).

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://scrapper.rivestream.app';
const SERVICES = ['citadel', 'primevids', 'apex', 'pulse', 'solstice', 'quasar', 'horizon', 'guru'];
const SERVICE_TIMEOUT_MS = 10000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[RiveStream] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(err => {
      console.log(`[RiveStream] TMDB lookup failed: ${err.message}`);
      return { title: '', year: '' };
    });
}

function mapSubtitles(captions) {
  if (!Array.isArray(captions)) return [];
  return captions
    .filter(c => c && c.file)
    .map(c => ({
      url: c.file,
      language: c.language || c.label || 'Unknown',
      name: c.label || c.language || 'Unknown'
    }));
}

// Service labels vary: "720p | English", "1080p", "tcloud", "dcloud", etc.
function parseQualityLabel(label) {
  if (!label) return { quality: 'Auto', language: null };
  const parts = String(label).split('|').map(p => p.trim());
  const resMatch = parts[0].match(/\d{3,4}p/i);
  return {
    quality: resMatch ? resMatch[0] : 'Auto',
    language: parts[1] || null
  };
}

function fetchFromService(service, tmdbId, mediaType, season, episode, mediaInfo) {
  let apiUrl = `${API_BASE}/api/provider?provider=${service}&id=${tmdbId}`;
  if (mediaType === 'tv') {
    apiUrl += `&season=${season}&episode=${episode}`;
  }

  return fetch(apiUrl, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } })
    .then(res => {
      if (!res.ok) return [];
      return res.json();
    })
    .then(body => {
      const data = body && body.data;
      if (!data || !Array.isArray(data.sources) || data.sources.length === 0) {
        return [];
      }
      const subtitles = mapSubtitles(data.captions);
      const label = mediaInfo.title
        ? `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`
        : 'Auto Quality Stream';

      return data.sources
        .filter(s => s && s.url)
        .map(s => {
          const { quality, language } = parseQualityLabel(s.quality);
          const sourceName = s.source || service;
          return {
            name: `RiveStream - ${sourceName}`,
            title: language ? `${label} - ${language}` : label,
            url: s.url,
            quality,
            type: 'direct',
            headers: { 'User-Agent': USER_AGENT },
            subtitles,
            provider: 'rivestream'
          };
        });
    })
    .catch(err => {
      console.log(`[RiveStream] ${service} failed: ${err.message}`);
      return [];
    });
}

// Which of these services actually return a working URL (vs. a 403, a dead
// CDN, or a link-shortener page) drifts over time - "primevids" used to be
// one of the two reliable ones (see comment above) and has since started
// 403ing consistently. Rather than hardcode/update an exclusion list every
// time a service degrades, validate each URL live and only return the ones
// that actually respond.
function validateStreamUrl(stream) {
  return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => rangedValidate(stream));
}

function rangedValidate(stream) {
  const headers = Object.assign({}, stream.headers, { Range: 'bytes=0-2048' });
  return fetch(stream.url, { method: 'GET', headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => false);
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[RiveStream] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[RiveStream] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    return Promise.all(
      SERVICES.map(service => fetchFromService(service, tmdbId, mediaType, season, episode, mediaInfo))
    ).then(results => {
      const streams = results.flat();
      console.log(`[RiveStream] Found ${streams.length} stream(s) across ${SERVICES.length} services, validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
        if (dead.length) console.log(`[RiveStream] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[RiveStream] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    });
  }).catch(err => {
    console.log(`[RiveStream] getStreams failed: ${err.message}`);
    return [];
  });
}
  return { getStreams: getStreams };
})();

const FourKHdHubSource = (function () {
"use strict";
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};
var BASE_URL = "https://4khdhub.click";
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
var DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
var domainCache = { url: BASE_URL, ts: 0 };
function fetchLatestDomain() {
  return __async(this, null, function* () {
    const now = Date.now();
    if (now - domainCache.ts < 36e5)
      return domainCache.url;
    try {
      const response = yield fetch(DOMAINS_URL);
      const data = yield response.json();
      if (data && data["4khdhub"]) {
        domainCache.url = data["4khdhub"];
        domainCache.ts = now;
      }
    } catch (e) {
    }
    return domainCache.url;
  });
}
function fetchText(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    const retries = options.retries !== void 0 ? options.retries : 2;
    const delay = options.delay !== void 0 ? options.delay : 1e3;
    for (let i = 0; i <= retries; i++) {
      try {
        const response = yield fetch(url, {
          headers: __spreadValues({
            "User-Agent": USER_AGENT
          }, options.headers)
        });
        return yield response.text();
      } catch (err) {
        console.log(`[4KHDHub] Request failed for ${url}: ${err.message}${i < retries ? `, retrying (${i + 1}/${retries})...` : ""}`);
      }
    }
    return null;
  });
}
function getTmdbDetails(tmdbId, type) {
  return __async(this, null, function* () {
    const isSeries = type === "series" || type === "tv";
    const endpoint = isSeries ? "tv" : "movie";
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    console.log(`[4KHDHub] Fetching TMDB details from: ${url}`);
    try {
      const response = yield fetch(url);
      const data = yield response.json();
      if (isSeries) {
        return {
          title: data.name,
          year: data.first_air_date ? parseInt(data.first_air_date.split("-")[0]) : 0
        };
      } else {
        return {
          title: data.title,
          year: data.release_date ? parseInt(data.release_date.split("-")[0]) : 0
        };
      }
    } catch (error) {
      console.log(`[4KHDHub] TMDB request failed: ${error.message}`);
      return null;
    }
  });
}
function atob(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let str = String(input).replace(/=+$/, "");
  if (str.length % 4 === 1) {
    throw new Error("'atob' failed: The string to be decoded is not correctly encoded.");
  }
  let output = "";
  for (let bc = 0, bs, buffer, i = 0; buffer = str.charAt(i++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
    buffer = chars.indexOf(buffer);
  }
  return output;
}
function rot13Cipher(str) {
  return str.replace(/[a-zA-Z]/g, function(c) {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}
function levenshteinDistance(s, t) {
  if (s === t)
    return 0;
  const n = s.length;
  const m = t.length;
  if (n === 0)
    return m;
  if (m === 0)
    return n;
  const d = [];
  for (let i = 0; i <= n; i++) {
    d[i] = [];
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j++) {
    d[0][j] = j;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s.charAt(i - 1) === t.charAt(j - 1) ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[n][m];
}
function parseBytes(val) {
  if (typeof val === "number")
    return val;
  if (!val)
    return 0;
  const match = val.match(/^([0-9.]+)\s*([a-zA-Z]+)$/);
  if (!match)
    return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  let multiplier = 1;
  if (unit.indexOf("k") === 0)
    multiplier = 1024;
  else if (unit.indexOf("m") === 0)
    multiplier = 1024 * 1024;
  else if (unit.indexOf("g") === 0)
    multiplier = 1024 * 1024 * 1024;
  else if (unit.indexOf("t") === 0)
    multiplier = 1024 * 1024 * 1024 * 1024;
  return num * multiplier;
}
function formatBytes(val) {
  if (val === 0)
    return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let i = Math.floor(Math.log(val) / Math.log(k));
  if (i < 0)
    i = 0;
  return parseFloat((val / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
var cheerio = require("cheerio-without-node-native");
function fetchPageUrl(name, year, isSeries) {
  return __async(this, null, function* () {
    const domain = yield fetchLatestDomain();
    const searchUrl = `${domain}/?s=${encodeURIComponent(name + " " + year)}`;
    console.log(`[4KHDHub] Search Request URL: ${searchUrl}`);
    const html = yield fetchText(searchUrl);
    if (!html) {
      console.log("[4KHDHub] Search failed: No HTML response");
      return null;
    }
    const $ = cheerio.load(html);
    const targetType = isSeries ? "Series" : "Movies";
    console.log(`[4KHDHub] Parsing search results for type: ${targetType}`);
    const matchingCards = $(".movie-card").filter((_, el) => {
      const hasFormat = $(el).find(`.movie-card-format:contains("${targetType}")`).length > 0;
      if (!hasFormat) {
      }
      return hasFormat;
    }).filter((_, el) => {
      const metaText = $(el).find(".movie-card-meta").text();
      const movieCardYear = parseInt(metaText);
      const yearMatch = !isNaN(movieCardYear) && Math.abs(movieCardYear - year) <= 1;
      if (!yearMatch) {
        console.log(`[4KHDHub] Skip: Year mismatch (${movieCardYear} vs ${year}) - ${$(el).find(".movie-card-title").text().trim()}`);
      }
      return yearMatch;
    }).filter((_, el) => {
      const movieCardTitle = $(el).find(".movie-card-title").text().replace(/\[.*?]/g, "").trim();
      const distance = levenshteinDistance(movieCardTitle.toLowerCase(), name.toLowerCase());
      const match = distance < 5;
      console.log(`[4KHDHub] Checking: "${movieCardTitle}" (Dist: ${distance}) vs "${name}"`);
      return match;
    }).map((_, el) => {
      let href = $(el).attr("href");
      if (href && !href.startsWith("http")) {
        href = domain + (href.startsWith("/") ? "" : "/") + href;
      }
      return href;
    }).get();
    if (matchingCards.length === 0) {
      console.log("[4KHDHub] No matching cards found after filtering");
    } else {
      console.log(`[4KHDHub] Found ${matchingCards.length} matching cards`);
    }
    return matchingCards.length > 0 ? matchingCards[0] : null;
  });
}
var cheerio2 = require("cheerio-without-node-native");
function resolveRedirectUrl(redirectUrl) {
  return __async(this, null, function* () {
    if (redirectUrl.includes("hubcloud.") || redirectUrl.includes("hubdrive.")) {
      return redirectUrl;
    }
    const redirectHtml = yield fetchText(redirectUrl);
    if (!redirectHtml)
      return redirectUrl;
    try {
      const redirectDataMatch = redirectHtml.match(/'o','(.*?)'/);
      if (!redirectDataMatch)
        return redirectUrl;
      const step1 = atob(redirectDataMatch[1]);
      const step2 = atob(step1);
      const step3 = rot13Cipher(step2);
      const step4 = atob(step3);
      const redirectData = JSON.parse(step4);
      if (redirectData && redirectData.o) {
        return atob(redirectData.o);
      }
    } catch (e) {
      console.log(`[4KHDHub] Error resolving redirect: ${e.message}`);
    }
    return redirectUrl;
  });
}
function extractSourceResults($, el) {
  return __async(this, null, function* () {
    const localHtml = $(el).html();
    const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/);
    const heightMatch = localHtml.match(/\d{3,}p/);
    const title = $(el).find(".file-title, .episode-file-title").text().trim();
    let height = heightMatch ? parseInt(heightMatch[0]) : 0;
    if (height === 0 && (title.includes("4K") || title.includes("4k") || localHtml.includes("4K") || localHtml.includes("4k"))) {
      height = 2160;
    }
    const meta = {
      bytes: sizeMatch ? parseBytes(sizeMatch[1]) : 0,
      height,
      title
    };
    const hubCloudLink = $(el).find("a").filter((_, a) => {
      const text = $(a).text();
      const href = $(a).attr("href") || "";
      return text.includes("HubCloud") || href.includes("hubcloud.") || href.includes("hubcloud/");
    }).attr("href");
    if (hubCloudLink) {
      const resolved = yield resolveRedirectUrl(hubCloudLink);
      return { url: resolved, meta };
    }
    const hubDriveLink = $(el).find("a").filter((_, a) => {
      const text = $(a).text();
      const href = $(a).attr("href") || "";
      return text.includes("HubDrive") || href.includes("hubdrive.") || href.includes("hubdrive/");
    }).attr("href");
    if (hubDriveLink) {
      const resolvedDrive = yield resolveRedirectUrl(hubDriveLink);
      if (resolvedDrive) {
        const hubDriveHtml = yield fetchText(resolvedDrive);
        if (hubDriveHtml) {
          const $2 = cheerio2.load(hubDriveHtml);
          const innerCloudLink = $2('a:contains("HubCloud")').attr("href") || $2("a").filter((_, a) => {
            const text = $2(a).text();
            const href = $2(a).attr("href") || "";
            return text.includes("HubCloud") || href.includes("hubcloud.") || href.includes("hubcloud/");
          }).attr("href");
          if (innerCloudLink) {
            return { url: innerCloudLink, meta };
          }
        }
      }
    }
    return null;
  });
}
function extractHubCloud(hubCloudUrl, baseMeta) {
  return __async(this, null, function* () {
    if (!hubCloudUrl)
      return [];
    const redirectHtml = yield fetchText(hubCloudUrl, { headers: { Referer: hubCloudUrl } });
    if (!redirectHtml)
      return [];
    const redirectUrlMatch = redirectHtml.match(/var url ?= ?'(.*?)'/);
    if (!redirectUrlMatch)
      return [];
    const finalLinksUrl = redirectUrlMatch[1];
    const linksHtml = yield fetchText(finalLinksUrl, { headers: { Referer: hubCloudUrl } });
    if (!linksHtml)
      return [];
    const $ = cheerio2.load(linksHtml);
    const results = [];
    const sizeText = $("#size").text();
    const titleText = $("title").text().trim();
    const currentMeta = __spreadProps(__spreadValues({}, baseMeta), {
      bytes: parseBytes(sizeText) || baseMeta.bytes,
      title: titleText || baseMeta.title
    });
    $("a").each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href");
      if (!href)
        return;
      if (text.includes("10Gbps") || text.includes("PixelServer")) {
        results.push({
          source: "HubCloud 10Gbps",
          url: href,
          meta: currentMeta
        });
      } else if (text.includes("Download File") || href.includes("r2.dev")) {
        results.push({
          source: "Direct R2",
          url: href,
          meta: currentMeta
        });
      } else if (text.includes("ZipDisk") || href.includes("workers.dev")) {
        results.push({
          source: "ZipDisk Server",
          url: href,
          meta: currentMeta
        });
      } else if (text.includes("FSL")) {
        results.push({
          source: "FSL",
          url: href,
          meta: currentMeta
        });
      }
    });
    const resolved = yield Promise.all(results.map((r) => __async(this, null, function* () {
      if (r.source !== "HubCloud 10Gbps")
        return r;
      const link = yield resolveHubCloudFinalLink(r.url);
      if (!link) {
        console.log(`[4KHDHub] Could not resolve final link for HubCloud 10Gbps, dropping`);
        return null;
      }
      return __spreadProps(__spreadValues({}, r), { url: link });
    })));
    return resolved.filter(Boolean);
  });
}
function resolveHubCloudFinalLink(url) {
  return __async(this, null, function* () {
    try {
      const response = yield fetch(url, { headers: { "User-Agent": USER_AGENT } });
      const finalUrl = response.url || url;
      try {
        const link = new URL(finalUrl).searchParams.get("link");
        if (link)
          return link;
      } catch (e) {
      }
      return finalUrl;
    } catch (err) {
      console.log(`[4KHDHub] Failed to resolve HubCloud final link: ${err.message}`);
      return null;
    }
  });
}
var cheerio3 = require("cheerio-without-node-native");
function getStreams(tmdbId, type, season, episode) {
  return __async(this, null, function* () {
    const tmdbDetails = yield getTmdbDetails(tmdbId, type);
    if (!tmdbDetails)
      return [];
    const { title, year } = tmdbDetails;
    console.log(`[4KHDHub] Search: ${title} (${year})`);
    const isSeries = type === "series" || type === "tv";
    const pageUrl = yield fetchPageUrl(title, year, isSeries);
    if (!pageUrl) {
      console.log("[4KHDHub] Page not found");
      return [];
    }
    console.log(`[4KHDHub] Found page: ${pageUrl}`);
    const html = yield fetchText(pageUrl);
    if (!html)
      return [];
    const $ = cheerio3.load(html);
    const itemsToProcess = [];
    if (isSeries && season && episode) {
      const seasonStr = "S" + String(season).padStart(2, "0");
      const episodeStr = "Episode-" + String(episode).padStart(2, "0");
      $(".episode-item").each((_, el) => {
        if ($(".episode-title", el).text().includes(seasonStr)) {
          const downloadItems = $(".episode-download-item", el).filter((_2, item) => $(item).text().includes(episodeStr));
          downloadItems.each((_2, item) => {
            itemsToProcess.push(item);
          });
        }
      });
    } else {
      $(".download-item").each((_, el) => {
        itemsToProcess.push(el);
      });
    }
    console.log(`[4KHDHub] Processing ${itemsToProcess.length} items`);
    const streamPromises = itemsToProcess.map((item) => __async(this, null, function* () {
      try {
        const sourceResult = yield extractSourceResults($, item);
        if (sourceResult && sourceResult.url) {
          console.log(`[4KHDHub] Extracting from HubCloud: ${sourceResult.url}`);
          const extractedLinks = yield extractHubCloud(sourceResult.url, sourceResult.meta);
          return extractedLinks.map((link) => ({
            name: `4KHDHub - ${link.source}${sourceResult.meta.height ? ` ${sourceResult.meta.height}p` : ""}`,
            title: `${link.meta.title}
${formatBytes(link.meta.bytes || 0)}`,
            url: link.url,
            quality: sourceResult.meta.height ? `${sourceResult.meta.height}p` : void 0,
            behaviorHints: {
              bingeGroup: `4khdhub-${link.source}`
            }
          }));
        }
        return [];
      } catch (err) {
        console.log(`[4KHDHub] Item processing error: ${err.message}`);
        return [];
      }
    }));
    const results = yield Promise.all(streamPromises);
    return results.reduce((acc, val) => acc.concat(val), []);
  });
}
  return { getStreams: getStreams };
})();

const UhdMoviesSource = (function () {
/**
 * uhdmovies - Built from src/uhdmovies/
 * Generated: 2026-09-11T16:50:57.642Z
 */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/uhdmovies/index.js
var import_cheerio_without_node_native2 = __toESM(require("cheerio-without-node-native"));

// src/uhdmovies/constants.js
var DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
var FALLBACK_DOMAIN = "https://uhdmovies.pink";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "max-age=0",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1"
};

// src/uhdmovies/utils.js
var import_cheerio_without_node_native = __toESM(require("cheerio-without-node-native"));
var cachedDomain = "";
function fetchWithTimeout(url, options) {
  return fetch(url, options);
}
function getMainUrl() {
  return __async(this, null, function* () {
    if (cachedDomain)
      return cachedDomain;
    try {
      const response = yield fetchWithTimeout(DOMAINS_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = yield response.json();
      cachedDomain = data["UHDMovies"] || FALLBACK_DOMAIN;
      return cachedDomain;
    } catch (e) {
      return FALLBACK_DOMAIN;
    }
  });
}
function getBaseUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}`;
  } catch (e) {
    return "";
  }
}
function fixUrl(url, domain) {
  if (!url)
    return "";
  if (url.startsWith("http"))
    return url;
  if (url.startsWith("//"))
    return `https:${url}`;
  if (url.startsWith("/"))
    return domain + url;
  return `${domain}/${url}`;
}
function bypassHrefli(url) {
  return __async(this, null, function* () {
    const host = getBaseUrl(url);
    try {
      const res1 = yield fetchWithTimeout(url, { headers: HEADERS });
      const html1 = yield res1.text();
      const $1 = import_cheerio_without_node_native.default.load(html1);
      const formUrl1 = $1("form#landing").attr("action");
      const formData1 = {};
      $1("form#landing input").each((_, el) => {
        formData1[$1(el).attr("name")] = $1(el).attr("value") || "";
      });
      const res2 = yield fetchWithTimeout(formUrl1, {
        method: "POST",
        headers: __spreadProps(__spreadValues({}, HEADERS), { "Content-Type": "application/x-www-form-urlencoded" }),
        body: new URLSearchParams(formData1).toString()
      });
      const html2 = yield res2.text();
      const $2 = import_cheerio_without_node_native.default.load(html2);
      const formUrl2 = $2("form#landing").attr("action");
      const formData2 = {};
      $2("form#landing input").each((_, el) => {
        formData2[$2(el).attr("name")] = $2(el).attr("value") || "";
      });
      const res3 = yield fetchWithTimeout(formUrl2, {
        method: "POST",
        headers: __spreadProps(__spreadValues({}, HEADERS), { "Content-Type": "application/x-www-form-urlencoded" }),
        body: new URLSearchParams(formData2).toString()
      });
      const html3 = yield res3.text();
      const $3 = import_cheerio_without_node_native.default.load(html3);
      const script = $3("script:contains(?go=)").html() || "";
      const skTokenMatch = script.match(/\?go=([^"]+)/);
      if (!skTokenMatch)
        return null;
      const skToken = skTokenMatch[1];
      const wpHttp2 = formData2["_wp_http2"] || "";
      const res4 = yield fetchWithTimeout(`${host}?go=${skToken}`, {
        headers: __spreadProps(__spreadValues({}, HEADERS), { "Cookie": `${skToken}=${wpHttp2}` })
      });
      const html4 = yield res4.text();
      const $4 = import_cheerio_without_node_native.default.load(html4);
      const metaRefresh = $4('meta[http-equiv="refresh"]').attr("content") || "";
      const driveUrlMatch = metaRefresh.match(/url=(.+)/);
      if (!driveUrlMatch)
        return null;
      const driveUrl = driveUrlMatch[1];
      const res5 = yield fetchWithTimeout(driveUrl, { headers: HEADERS });
      const html5 = yield res5.text();
      const pathMatch = html5.match(/replace\("([^"]+)"\)/);
      if (!pathMatch || pathMatch[1] === "/404")
        return null;
      return fixUrl(pathMatch[1], getBaseUrl(driveUrl));
    } catch (e) {
      return null;
    }
  });
}
function fetchTmdbDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var _a;
    try {
      const url = `${TMDB_BASE_URL}/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
      const res = yield fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json"
        }
      });
      const data = yield res.json();
      return {
        title: mediaType === "movie" ? data.title || data.original_title : data.name || data.original_name,
        year: (data.release_date || data.first_air_date || "").substring(0, 4),
        imdbId: (_a = data.external_ids) == null ? void 0 : _a.imdb_id
      };
    } catch (e) {
      return null;
    }
  });
}
function getIndexQuality(str) {
  if (!str)
    return "Unknown";
  const match = str.match(/(\d{3,4})[pP]/);
  if (match)
    return match[1] + "p";
  if (str.toUpperCase().includes("4K") || str.toUpperCase().includes("UHD"))
    return "2160p";
  return "Unknown";
}
function extractVideoSeed(finallink) {
  return __async(this, null, function* () {
    try {
      const urlObj = new URL(finallink);
      const host = urlObj.host || "video-seed.xyz";
      // Driveseed rotates through several gateway domains that all use this
      // same decrypt-the-token flow (video-seed.dev, video-plex.xyz,
      // video-gen.xyz confirmed live) - most put the token in a ?url= query
      // param, but at least one (video-gen.xyz) puts it bare in the path
      // instead, with no query string at all.
      const token = finallink.includes("url=") ? finallink.split("url=")[1] : (urlObj.pathname || "").replace(/^\//, "");
      if (!token)
        return null;
      const res = yield fetchWithTimeout(`https://${host}/api`, {
        method: "POST",
        headers: __spreadProps(__spreadValues({}, HEADERS), {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-token": host,
          "Referer": finallink
        }),
        body: `keys=${encodeURIComponent(token)}`
      });
      const text = yield res.text();
      const urlMatch = text.match(/url":"([^"]+)"/);
      return urlMatch ? urlMatch[1].replace(/\\\//g, "/") : null;
    } catch (e) {
      return null;
    }
  });
}
function extractDriveseedPage(url) {
  return __async(this, null, function* () {
    const streams = [];
    try {
      let pageUrl = url;
      if (url.includes("r?key=")) {
        const res2 = yield fetchWithTimeout(url, { headers: HEADERS });
        const html2 = yield res2.text();
        const redirectMatch = html2.match(/replace\("([^"]+)"\)/);
        if (redirectMatch) {
          pageUrl = getBaseUrl(url) + redirectMatch[1];
        }
      }
      const res = yield fetchWithTimeout(pageUrl, { headers: HEADERS });
      const html = yield res.text();
      const $ = import_cheerio_without_node_native.default.load(html);
      const baseDomain = getBaseUrl(pageUrl);
      const qualityText = $("li.list-group-item").first().text() || "";
      const size = $("li:nth-child(3)").text().replace("Size : ", "").trim();
      const quality = getIndexQuality(qualityText);
      const elements = $("div.text-center > a").get();
      const buttonResults = yield Promise.all(elements.map((el) => __async(this, null, function* () {
        const text = $(el).text().toLowerCase();
        const href = $(el).attr("href");
        if (!href)
          return null;
        if (text.includes("instant download")) {
          const instantRes = yield fetchWithTimeout(href, { headers: HEADERS, redirect: "follow" });
          const landedUrl = instantRes.url || "";
          const afterUrlParam = landedUrl.includes("url=") ? landedUrl.split("url=")[1] : "";
          // "Instant Download" lands on one of several gateway domains
          // (confirmed live: video-seed.dev, video-plex.xyz, video-gen.xyz) -
          // video-seed.dev happens to put the real, already-playable URL
          // straight in ?url=, but the others put an encrypted token there
          // (or bare in the path) that still needs decrypting through that
          // gateway's own /api endpoint. Treating every gateway's ?url= value
          // as a final URL - the previous behavior - returned raw undecrypted
          // tokens as "streams" for the latter, which obviously never played.
          if (afterUrlParam && afterUrlParam.startsWith("http")) {
            return { name: "Driveseed Instant", url: afterUrlParam, quality, size };
          }
          const resolvedUrl = yield extractVideoSeed(landedUrl);
          return resolvedUrl ? { name: "Driveseed Instant", url: resolvedUrl, quality, size } : null;
        } else if (text.includes("resume cloud")) {
          const cloudRes = yield fetchWithTimeout(baseDomain + href, { headers: HEADERS });
          const cloudHtml = yield cloudRes.text();
          const link = import_cheerio_without_node_native.default.load(cloudHtml)("a.btn-success").first().attr("href");
          return link ? { name: "Driveseed Cloud", url: link, quality, size } : null;
        } else if (text.includes("cloud download")) {
          return { name: "Driveseed Cloud", url: href, quality, size };
        }
        return null;
      })));
      streams.push(...buttonResults.filter(Boolean));
    } catch (e) {
    }
    return streams;
  });
}

// src/uhdmovies/index.js
function getStreams(tmdbId, mediaType, seasonNum = 1, episodeNum = 1) {
  return __async(this, null, function* () {
    console.log(`[UHDMovies] Querying streams for TMDB: ${tmdbId}, Type: ${mediaType}`);
    const details = yield fetchTmdbDetails(tmdbId, mediaType);
    if (!details)
      return [];
    const mainUrl = yield getMainUrl();
    const query = details.title;
    const searchUrl = `${mainUrl}/?s=${encodeURIComponent(query)}`;
    try {
      const searchRes = yield fetchWithTimeout(searchUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }) });
      const searchHtml = yield searchRes.text();
      const $search = import_cheerio_without_node_native2.default.load(searchHtml);
      let targetUrl = "";
      $search("article.gridlove-post, article.latestPost").each((i, el) => {
        const title = $search(el).find("h1.sanket, h2.title a").text() || $search(el).find("a").attr("title") || "";
        const href = $search(el).find("div.entry-image > a, h2.title a, a").first().attr("href");
        if (href && (title.toLowerCase().includes(details.title.toLowerCase()) || details.imdbId && title.includes(details.imdbId))) {
          targetUrl = href;
          return false;
        }
      });
      if (!targetUrl) {
        console.log("[UHDMovies] No search result found");
        return [];
      }
      const pageRes = yield fetchWithTimeout(targetUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }) });
      const pageHtml = yield pageRes.text();
      const $ = import_cheerio_without_node_native2.default.load(pageHtml);
      const allStreams = [];
      if (mediaType === "movie") {
        const iframeRegex = /\[.*\]/;
        $("div.entry-content > p, div.entry-content > div").each((i, el) => {
          const text = $(el).text();
          if (iframeRegex.test(text)) {
            const quality = getIndexQuality(text);
            const nextHref = $(el).next().find("a.maxbutton-1, a.maxbutton").attr("href") || $(el).find("a.maxbutton-1, a.maxbutton").attr("href");
            if (nextHref) {
              allStreams.push({ url: nextHref, quality });
            }
          }
        });
      } else {
        const episodesMap = {};
        let currentSeason = seasonNum;
        $("pre, p, a, h3").each((i, el) => {
          const text = $(el).text().trim();
          const seasonMatch = text.match(/(?:season\s*|S)(\d+)/i);
          if (seasonMatch && text.length < 20) {
            currentSeason = parseInt(seasonMatch[1]);
          }
          if (($(el).is("a") || $(el).find("a").length > 0) && text.toLowerCase().includes("episode")) {
            if (text.toLowerCase().includes("zip"))
              return;
            const epMatch = text.match(/Episode\s*(\d+)/i);
            if (epMatch) {
              const realEp = parseInt(epMatch[1]);
              const epUrl = $(el).is("a") ? $(el).attr("href") : $(el).find("a").attr("href");
              if (epUrl) {
                const key = `${currentSeason}-${realEp}`;
                if (!episodesMap[key])
                  episodesMap[key] = [];
                episodesMap[key].push(epUrl);
              }
            }
          }
        });
        const targetKey = `${seasonNum}-${episodeNum}`;
        const urls = episodesMap[targetKey] || [];
        urls.forEach((url) => {
          allStreams.push({ url, quality: "Unknown" });
        });
      }
      const resultGroups = yield Promise.all(allStreams.map((item) => __async(this, null, function* () {
        let finalLink = item.url;
        if (finalLink.includes("unblockedgames")) {
          finalLink = yield bypassHrefli(finalLink);
        }
        if (!finalLink)
          return [];
        if (finalLink.includes("driveseed") || finalLink.includes("driveleech")) {
          const streams = yield extractDriveseedPage(finalLink);
          return streams.map((s) => __spreadProps(__spreadValues({}, s), {
            name: "UHDMovies [Driveseed]",
            title: `UHDMovies - ${s.quality} ${s.size ? `[${s.size}]` : ""}`,
            quality: s.quality || item.quality,
            provider: "uhdmovies"
          }));
        } else if (finalLink.includes("video-seed")) {
          const streamUrl = yield extractVideoSeed(finalLink);
          if (!streamUrl)
            return [];
          return [{
            name: "UHDMovies [VideoSeed]",
            title: `UHDMovies - ${item.quality}`,
            url: streamUrl,
            quality: item.quality,
            provider: "uhdmovies"
          }];
        }
        return [{
          name: "UHDMovies",
          title: `UHDMovies - ${item.quality}`,
          url: finalLink,
          quality: item.quality,
          provider: "uhdmovies"
        }];
      })));
      return resultGroups.flat();
    } catch (e) {
      console.error("[UHDMovies] Error:", e.message);
      return [];
    }
  });
}
  return { getStreams: getStreams };
})();

const NetMirrorSource = (function () {
// NetMirror Scraper for Nuvio Local Scrapers
//
// IMPORTANT: netmirror's original target (Netflix/Prime/Hotstar/Disney+ mirrors,
// backed by the MovieBox/"aoneroom" catalog) is no longer scrapable over plain
// HTTP. The current site (net27.cc, rebranded around the "CNCVerse" family of
// mirrors) resolves titles against MovieBox's h5-api.aoneroom.com just fine
// (GET /wefeed-h5api-bff/detail?detailPath=...), but the actual play/stream
// URL fetch is deliberately stubbed out in the public site bundle:
//
//   async function O(e,t,i,r,n){return null}   // "Server 1" stream fetch
//   async function R(e){return null}            // companion lookup
//
// The site's own UI says "Server 1 won't play without the extension" - the
// real stream URLs are only ever supplied by NetMirror's proprietary browser
// extension (presumably injected client-side), not by any discoverable REST
// endpoint. "Server 2" (their own fallback for extension-less users) is just
// an iframe to peachify.top, one of the many generic vidsrc-clone aggregators
// - the same class of site listed under yflix.ws's own source list, and one
// that (like most of that ecosystem) hides its stream fetch behind a Next.js
// server action with no client-visible API.
//
// Since there's no way left to reach netmirror's actual unique catalog, this
// rewrite falls back to the same verified-working aggregator yflix.js uses
// (moviesapi.to's "vidora" API - a plain JSON endpoint gated only by a static
// header baked into moviesapi.to's own JS bundle). This means netmirror and
// yflix can return the same underlying stream when both are enabled; that's
// a real limitation of what's left to scrape, not an oversight.
//
// This file is intentionally NOT generated from src/netmirror/ - there is no
// src/netmirror/ directory. Running `node build.js` with no arguments will
// NOT touch this file (only providers with a matching src/<name>/ folder get
// regenerated), so hand edits here are safe.

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://moviesapi.to';
// Static key read out of moviesapi.to's own frontend bundle (assets/index-*.js).
const PLAYER_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const STREAM_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': API_BASE + '/',
  'Origin': API_BASE
};

function apiHeaders(referer) {
  return {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
    'Origin': API_BASE,
    'Referer': referer,
    'x-player-key': PLAYER_KEY
  };
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[NetMirror] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(err => {
      console.log(`[NetMirror] TMDB lookup failed: ${err.message}`);
      return { title: '', year: '' };
    });
}

function mapSubtitles(tracks) {
  if (!Array.isArray(tracks)) return [];
  return tracks
    .filter(t => t && t.file)
    .map(t => ({
      url: t.file,
      language: t.label || 'Unknown',
      name: t.label || 'Unknown',
      headers: STREAM_HEADERS
    }));
}

function fetchStreams(tmdbId, mediaType, season, episode, mediaInfo) {
  const path = mediaType === 'tv'
    ? `/tv/${tmdbId}/${season}/${episode}`
    : `/movie/${tmdbId}`;
  const apiUrl = `${API_BASE}/api/vidora/v1${path}`;
  const pageUrl = `${API_BASE}${path}`;

  console.log(`[NetMirror] Requesting: ${apiUrl}`);
  return fetch(apiUrl, { headers: apiHeaders(pageUrl) })
    .then(res => {
      if (!res.ok) {
        return res.json().catch(() => null).then(body => {
          const reason = body && (body.message || body.error);
          console.log(`[NetMirror] Stream request failed: ${res.status}${reason ? ' - ' + reason : ''}`);
          return [];
        });
      }
      return res.json().then(data => {
        if (!data || !data.result || !Array.isArray(data.sources) || data.sources.length === 0) {
          console.log('[NetMirror] No sources returned for this title');
          return [];
        }
        const label = mediaInfo.title
          ? `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`
          : (data.title || 'Auto Quality Stream');

        return data.sources
          .filter(s => s && s.url)
          .map((s, idx) => ({
            name: 'NetMirror',
            title: data.sources.length > 1 ? `${label} - Server ${idx + 1}` : label,
            url: s.url,
            quality: 'Auto',
            type: 'direct',
            headers: STREAM_HEADERS,
            subtitles: mapSubtitles(s.tracks),
            provider: 'netmirror'
          }));
      });
    })
    .catch(err => {
      console.log(`[NetMirror] Error fetching streams: ${err.message}`);
      return [];
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[NetMirror] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[NetMirror] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    return fetchStreams(tmdbId, mediaType, season, episode, mediaInfo).then(streams => {
      console.log(`[NetMirror] Found ${streams.length} stream(s)`);
      return streams;
    });
  }).catch(err => {
    console.log(`[NetMirror] getStreams failed: ${err.message}`);
    return [];
  });
}
  return { getStreams: getStreams };
})();

const VixSrcSource = (function () {
/**
 * vixsrc - Built from src/vixsrc/
 * Generated: 2025-12-31T21:23:16.687Z
 */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/vixsrc/constants.js
var TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
var BASE_URL = "https://vixsrc.to";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// src/vixsrc/http.js
function makeRequest(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    const defaultHeaders = __spreadValues({
      "User-Agent": USER_AGENT,
      "Accept": "application/json,*/*",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate",
      "Connection": "keep-alive"
    }, options.headers);
    try {
      const response = yield fetch(url, __spreadValues({
        method: options.method || "GET",
        headers: defaultHeaders
      }, options));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      console.error(`[Vixsrc] Request failed for ${url}: ${error.message}`);
      throw error;
    }
  });
}

// src/vixsrc/tmdb.js
function getTmdbInfo(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var _a, _b;
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const response = yield makeRequest(url);
    const data = yield response.json();
    const title = mediaType === "tv" ? data.name : data.title;
    const year = mediaType === "tv" ? (_a = data.first_air_date) == null ? void 0 : _a.substring(0, 4) : (_b = data.release_date) == null ? void 0 : _b.substring(0, 4);
    if (!title) {
      throw new Error("Could not extract title from TMDB response");
    }
    console.log(`[Vixsrc] TMDB Info: "${title}" (${year})`);
    return { title, year, data };
  });
}

// src/vixsrc/extractor.js
function extractStreamFromPage(contentType, contentId, seasonNum, episodeNum) {
  return __async(this, null, function* () {
    let apiPath;
    let subtitleApiUrl;
    if (contentType === "movie") {
      apiPath = `/api/movie/${contentId}`;
      subtitleApiUrl = `https://sub.wyzie.ru/search?id=${contentId}`;
    } else {
      apiPath = `/api/tv/${contentId}/${seasonNum}/${episodeNum}`;
      subtitleApiUrl = `https://sub.wyzie.ru/search?id=${contentId}&season=${seasonNum}&episode=${episodeNum}`;
    }
    console.log(`[Vixsrc] Fetching: ${BASE_URL}${apiPath}`);
    const apiResponse = yield makeRequest(`${BASE_URL}${apiPath}`, {
      headers: {
        "Accept": "application/json,*/*"
      }
    });
    const apiData = yield apiResponse.json();
    if (!apiData || !apiData.src) {
      console.log("[Vixsrc] No embed src returned from API");
      return null;
    }
    const embedUrl = apiData.src.startsWith("http") ? apiData.src : `${BASE_URL}${apiData.src}`;
    console.log(`[Vixsrc] Fetching embed: ${embedUrl}`);
    const response = yield makeRequest(embedUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const html = yield response.text();
    console.log(`[Vixsrc] HTML length: ${html.length} characters`);
    let masterPlaylistUrl = null;
    if (html.includes("window.masterPlaylist")) {
      console.log("[Vixsrc] Found window.masterPlaylist");
      const urlMatch = html.match(/url:\s*['"]([^'"]+)['"]/);
      const tokenMatch = html.match(/['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/);
      const expiresMatch = html.match(/['"]?expires['"]?\s*:\s*['"]([^'"]+)['"]/);
      if (urlMatch && tokenMatch && expiresMatch) {
        const baseUrl = urlMatch[1];
        const token = tokenMatch[1];
        const expires = expiresMatch[1];
        console.log("[Vixsrc] Extracted tokens:");
        console.log(`  - Base URL: ${baseUrl}`);
        console.log(`  - Token: ${token.substring(0, 20)}...`);
        console.log(`  - Expires: ${expires}`);
        if (baseUrl.includes("?b=1")) {
          masterPlaylistUrl = `${baseUrl}&token=${token}&expires=${expires}&h=1&lang=en`;
        } else {
          masterPlaylistUrl = `${baseUrl}?token=${token}&expires=${expires}&h=1&lang=en`;
        }
        console.log(`[Vixsrc] Constructed master playlist URL: ${masterPlaylistUrl}`);
      }
    }
    if (!masterPlaylistUrl) {
      const m3u8Match = html.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/);
      if (m3u8Match) {
        masterPlaylistUrl = m3u8Match[1];
        console.log("[Vixsrc] Found direct .m3u8 URL:", masterPlaylistUrl);
      }
    }
    if (!masterPlaylistUrl) {
      const scriptMatches = html.match(new RegExp("<script[^>]*>(.*?)<\\/script>", "gs"));
      if (scriptMatches) {
        for (const script of scriptMatches) {
          const streamMatch = script.match(/['"]?(https?:\/\/[^'"\s]+(?:\.m3u8|playlist)[^'"\s]*)/);
          if (streamMatch) {
            masterPlaylistUrl = streamMatch[1];
            console.log("[Vixsrc] Found stream in script:", masterPlaylistUrl);
            break;
          }
        }
      }
    }
    if (!masterPlaylistUrl) {
      console.log("[Vixsrc] No master playlist URL found");
      return null;
    }
    return { masterPlaylistUrl, subtitleApiUrl };
  });
}

// src/vixsrc/subtitles.js
function getSubtitles(subtitleApiUrl) {
  return __async(this, null, function* () {
    try {
      const response = yield makeRequest(subtitleApiUrl);
      const subtitleData = yield response.json();
      let subtitleTrack = subtitleData.find(
        (track) => track.display.includes("English") && (track.encoding === "ASCII" || track.encoding === "UTF-8")
      );
      if (!subtitleTrack) {
        subtitleTrack = subtitleData.find(
          (track) => track.display.includes("English") && track.encoding === "CP1252"
        );
      }
      if (!subtitleTrack) {
        subtitleTrack = subtitleData.find(
          (track) => track.display.includes("English") && track.encoding === "CP1250"
        );
      }
      if (!subtitleTrack) {
        subtitleTrack = subtitleData.find(
          (track) => track.display.includes("English") && track.encoding === "CP850"
        );
      }
      const subtitles = subtitleTrack ? subtitleTrack.url : "";
      console.log(
        subtitles ? `[Vixsrc] Found subtitles: ${subtitles}` : "[Vixsrc] No English subtitles found"
      );
      return subtitles;
    } catch (error) {
      console.log("[Vixsrc] Subtitle fetch failed:", error.message);
      return "";
    }
  });
}

// src/vixsrc/index.js
function getStreams(tmdbId, mediaType = "movie", seasonNum = null, episodeNum = null) {
  return __async(this, null, function* () {
    console.log(`[Vixsrc] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    try {
      const tmdbInfo = yield getTmdbInfo(tmdbId, mediaType);
      const { title, year } = tmdbInfo;
      console.log(`[Vixsrc] Title: "${title}" (${year})`);
      const streamData = yield extractStreamFromPage(mediaType, tmdbId, seasonNum, episodeNum);
      if (!streamData) {
        console.log("[Vixsrc] No stream data found");
        return [];
      }
      const { masterPlaylistUrl, subtitleApiUrl } = streamData;
      const subtitles = yield getSubtitles(subtitleApiUrl);
      const nuvioStreams = [{
        name: "Vixsrc",
        title: "Auto Quality Stream",
        url: masterPlaylistUrl,
        quality: "Auto",
        type: "direct",
        headers: {
          "Referer": BASE_URL,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        }
      }];
      console.log("[Vixsrc] Successfully processed 1 stream with Auto quality");
      return nuvioStreams;
    } catch (error) {
      console.error(`[Vixsrc] Error in getStreams: ${error.message}`);
      return [];
    }
  });
}
  return { getStreams: getStreams };
})();

const VidLinkSource = (function () {
/**
 * vidlink - Built from src/vidlink/
 * Generated: 2025-12-31T21:23:16.719Z
 */
"use strict";
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/vidlink/constants.js
var TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
var ENC_DEC_API = "https://enc-dec.app/api";
var VIDLINK_API = "https://vidlink.pro/api/b";
var VIDLINK_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Connection": "keep-alive",
  "Referer": "https://vidlink.pro/",
  "Origin": "https://vidlink.pro"
};

// src/vidlink/http.js
function makeRequest(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    const defaultHeaders = __spreadValues({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      "Accept": "application/json,*/*",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate",
      "Connection": "keep-alive"
    }, options.headers);
    try {
      const response = yield fetch(url, __spreadValues({
        method: options.method || "GET",
        headers: defaultHeaders
      }, options));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      console.error(`[Vidlink] Request failed for ${url}: ${error.message}`);
      throw error;
    }
  });
}

// Vidlink's own backend can hand back links to a CDN that's currently
// throttling or dead (e.g. bcdn.hakunaymatata.com returning a plain nginx
// 429) even though vidlink's API itself responded fine - validate each
// resolved URL live and only return what's actually reachable, rather than
// showing a stream that fails the instant it's tapped. No JS-level timeout
// exists in this sandbox (no setTimeout), so a hung check is bounded only
// by the native fetch bridge's own ~30s timeout.
function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}
function firstManifestRef(text, baseUrl) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return null;
  try {
    return new URL(lines[0], baseUrl).toString();
  } catch (e) {
    return null;
  }
}
function validateM3u8Chain(url, headers, hopsLeft) {
  return fetch(url, { headers }).then((res) => {
    if (!res.ok) return false;
    return res.text().then((text) => {
      const next = firstManifestRef(text, url);
      if (!next) return true;
      if (isM3u8Url(next) && hopsLeft > 0) {
        return validateM3u8Chain(next, headers, hopsLeft - 1);
      }
      return rangedValidateUrl(next, headers);
    });
  }).catch(() => false);
}
function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return validateM3u8Chain(stream.url, stream.headers, 2);
  }
  return fetch(stream.url, { method: "HEAD", headers: stream.headers }).then((res) => res.ok || res.status === 206).catch(() => rangedValidateUrl(stream.url, stream.headers));
}
function rangedValidateUrl(url, headers) {
  const rangedHeaders = Object.assign({}, headers, { Range: "bytes=0-2048" });
  return fetch(url, { method: "GET", headers: rangedHeaders }).then((res) => res.ok || res.status === 206).catch(() => false);
}

// src/vidlink/tmdb.js
function getTmdbInfo(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var _a, _b;
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const response = yield makeRequest(url);
    const data = yield response.json();
    const title = mediaType === "tv" ? data.name : data.title;
    const year = mediaType === "tv" ? (_a = data.first_air_date) == null ? void 0 : _a.substring(0, 4) : (_b = data.release_date) == null ? void 0 : _b.substring(0, 4);
    if (!title) {
      throw new Error("Could not extract title from TMDB response");
    }
    console.log(`[Vidlink] TMDB Info: "${title}" (${year})`);
    return { title, year, data };
  });
}
function encryptTmdbId(tmdbId) {
  return __async(this, null, function* () {
    console.log(`[Vidlink] Encrypting TMDB ID: ${tmdbId}`);
    const response = yield makeRequest(`${ENC_DEC_API}/enc-vidlink?text=${tmdbId}`);
    const data = yield response.json();
    if (data && data.result) {
      console.log(`[Vidlink] Successfully encrypted TMDB ID`);
      return data.result;
    } else {
      throw new Error("Invalid encryption response format");
    }
  });
}

// src/vidlink/m3u8.js
function resolveUrl(url, baseUrl) {
  if (url.startsWith("http")) {
    return url;
  }
  try {
    return new URL(url, baseUrl).toString();
  } catch (error) {
    console.error(`[Vidlink] Could not resolve URL: ${url} against ${baseUrl}`);
    return url;
  }
}
function getQualityFromResolution(resolution) {
  if (!resolution)
    return "Auto";
  const [, height] = resolution.split("x").map(Number);
  if (height >= 2160)
    return "4K";
  if (height >= 1440)
    return "1440p";
  if (height >= 1080)
    return "1080p";
  if (height >= 720)
    return "720p";
  if (height >= 480)
    return "480p";
  if (height >= 360)
    return "360p";
  return "240p";
}
function parseM3U8(content, baseUrl) {
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => line);
  const streams = [];
  let currentStream = null;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      currentStream = { bandwidth: null, resolution: null, url: null };
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      if (bandwidthMatch) {
        currentStream.bandwidth = parseInt(bandwidthMatch[1]);
      }
      const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      if (resolutionMatch) {
        currentStream.resolution = resolutionMatch[1];
      }
    } else if (currentStream && !line.startsWith("#")) {
      currentStream.url = resolveUrl(line, baseUrl);
      streams.push(currentStream);
      currentStream = null;
    }
  }
  return streams;
}
function fetchAndParseM3U8(playlistUrl, mediaInfo, subtitles) {
  return __async(this, null, function* () {
    console.log(`[Vidlink] Fetching M3U8 playlist: ${playlistUrl.substring(0, 80)}...`);
    try {
      const response = yield makeRequest(playlistUrl, { headers: VIDLINK_HEADERS });
      const m3u8Content = yield response.text();
      console.log(`[Vidlink] Parsing M3U8 content`);
      const parsedStreams = parseM3U8(m3u8Content, playlistUrl);
      if (parsedStreams.length === 0) {
        console.log("[Vidlink] No quality variants found, returning master playlist");
        return [{
          name: "Vidlink - Auto",
          title: mediaInfo.title,
          url: playlistUrl,
          quality: "Auto",
          size: "Unknown",
          headers: VIDLINK_HEADERS,
          provider: "vidlink",
          subtitles: subtitles || []
        }];
      }
      console.log(`[Vidlink] Found ${parsedStreams.length} quality variants`);
      return parsedStreams.map((stream) => {
        const quality = getQualityFromResolution(stream.resolution);
        return {
          name: `Vidlink - ${quality}`,
          title: mediaInfo.title,
          url: stream.url,
          quality,
          size: "Unknown",
          headers: VIDLINK_HEADERS,
          provider: "vidlink",
          subtitles: subtitles || []
        };
      });
    } catch (error) {
      console.error(`[Vidlink] Error fetching/parsing M3U8: ${error.message}`);
      return [{
        name: "Vidlink - Auto",
        title: mediaInfo.title,
        url: playlistUrl,
        quality: "Auto",
        size: "Unknown",
        headers: VIDLINK_HEADERS,
        provider: "vidlink",
        subtitles: subtitles || []
      }];
    }
  });
}

// src/vidlink/processor.js
function extractQuality(streamData) {
  if (!streamData)
    return "Unknown";
  const qualityFields = ["quality", "resolution", "label", "name"];
  for (const field of qualityFields) {
    if (streamData[field]) {
      const quality = streamData[field].toString().toLowerCase();
      if (quality.includes("2160") || quality.includes("4k"))
        return "4K";
      if (quality.includes("1440") || quality.includes("2k"))
        return "1440p";
      if (quality.includes("1080") || quality.includes("fhd"))
        return "1080p";
      if (quality.includes("720") || quality.includes("hd"))
        return "720p";
      if (quality.includes("480") || quality.includes("sd"))
        return "480p";
      if (quality.includes("360"))
        return "360p";
      if (quality.includes("240"))
        return "240p";
      const match = quality.match(/(\d{3,4})[pP]?/);
      if (match) {
        const resolution = parseInt(match[1]);
        if (resolution >= 2160)
          return "4K";
        if (resolution >= 1440)
          return "1440p";
        if (resolution >= 1080)
          return "1080p";
        if (resolution >= 720)
          return "720p";
        if (resolution >= 480)
          return "480p";
        if (resolution >= 360)
          return "360p";
        return "240p";
      }
    }
  }
  return "Unknown";
}
function createStreamTitle(mediaInfo) {
  if (mediaInfo.mediaType === "tv" && mediaInfo.season && mediaInfo.episode) {
    return `${mediaInfo.title} S${String(mediaInfo.season).padStart(2, "0")}E${String(mediaInfo.episode).padStart(2, "0")}`;
  }
  return mediaInfo.year ? `${mediaInfo.title} (${mediaInfo.year})` : mediaInfo.title;
}
function processVidlinkResponse(data, mediaInfo) {
  const streams = [];
  try {
    console.log(`[Vidlink] Processing response data`);
    const streamTitle = createStreamTitle(mediaInfo);
    const subtitles = [];
    const rawSubtitles = data.subtitles || data.stream && data.stream.subtitles || data.captions || data.stream && data.stream.captions || [];
    if (Array.isArray(rawSubtitles)) {
      rawSubtitles.forEach((sub) => {
        if (sub.url) {
          subtitles.push({
            url: sub.url,
            language: sub.language || sub.lang || sub.label || "Unknown",
            name: sub.name || sub.label || sub.language || sub.lang || "Unknown",
            headers: VIDLINK_HEADERS
          });
        }
      });
    }
    if (data.stream && data.stream.qualities) {
      console.log(`[Vidlink] Processing qualities from stream object`);
      Object.entries(data.stream.qualities).forEach(([qualityKey, qualityData]) => {
        if (qualityData.url) {
          const quality = extractQuality({ quality: qualityKey });
          streams.push({
            name: `Vidlink - ${quality}`,
            title: streamTitle,
            url: qualityData.url,
            quality,
            size: "Unknown",
            headers: VIDLINK_HEADERS,
            provider: "vidlink",
            subtitles
          });
        }
      });
      if (data.stream.playlist) {
        streams.push({
          _isPlaylist: true,
          url: data.stream.playlist,
          mediaInfo: __spreadProps(__spreadValues({}, mediaInfo), { title: streamTitle }),
          subtitles
        });
      }
    } else if (data.stream && data.stream.playlist && !data.stream.qualities) {
      console.log(`[Vidlink] Processing playlist-only response`);
      streams.push({
        _isPlaylist: true,
        url: data.stream.playlist,
        mediaInfo: __spreadProps(__spreadValues({}, mediaInfo), { title: streamTitle }),
        subtitles
      });
    } else if (data.url) {
      const quality = extractQuality(data);
      streams.push({
        name: `Vidlink - ${quality}`,
        title: streamTitle,
        url: data.url,
        quality,
        size: "Unknown",
        headers: VIDLINK_HEADERS,
        provider: "vidlink",
        subtitles
      });
    } else if (data.streams && Array.isArray(data.streams)) {
      data.streams.forEach((stream, index) => {
        if (stream.url) {
          const quality = extractQuality(stream);
          streams.push({
            name: `Vidlink Stream ${index + 1} - ${quality}`,
            title: streamTitle,
            url: stream.url,
            quality,
            size: stream.size || "Unknown",
            headers: VIDLINK_HEADERS,
            provider: "vidlink",
            subtitles
          });
        }
      });
    } else if (data.links && Array.isArray(data.links)) {
      data.links.forEach((link, index) => {
        if (link.url) {
          const quality = extractQuality(link);
          streams.push({
            name: `Vidlink Link ${index + 1} - ${quality}`,
            title: streamTitle,
            url: link.url,
            quality,
            size: link.size || "Unknown",
            headers: VIDLINK_HEADERS,
            provider: "vidlink",
            subtitles
          });
        }
      });
    } else if (typeof data === "object") {
      const findUrls = (obj) => {
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value === "string" && (value.startsWith("http") || value.includes(".m3u8"))) {
            if (value.includes(".srt") || value.includes(".vtt") || value.includes("subtitle") || value.includes("captions") || key.toLowerCase().includes("subtitle") || key.toLowerCase().includes("caption")) {
              continue;
            }
            const quality = extractQuality({ [key]: value });
            streams.push({
              name: `Vidlink ${key} - ${quality}`,
              title: streamTitle,
              url: value,
              quality,
              size: "Unknown",
              headers: VIDLINK_HEADERS,
              provider: "vidlink",
              subtitles
            });
          } else if (typeof value === "object" && value !== null) {
            if (!key.toLowerCase().includes("caption") && !key.toLowerCase().includes("subtitle")) {
              findUrls(value);
            }
          }
        }
      };
      findUrls(data);
    }
    console.log(`[Vidlink] Extracted ${streams.length} streams from response`);
  } catch (error) {
    console.error(`[Vidlink] Error processing response: ${error.message}`);
  }
  return streams;
}

function validateAndFilterStreams(streams) {
  console.log(`[Vidlink] Validating ${streams.length} stream(s)...`);
  return Promise.all(streams.map((s) => validateStreamUrl(s).then((ok) => ({ stream: s, ok })))).then((validated) => {
    const valid = validated.filter((v) => v.ok).map((v) => v.stream);
    const dead = validated.filter((v) => !v.ok).map((v) => v.stream.name);
    if (dead.length) console.log(`[Vidlink] Dropping unreachable: ${dead.join(", ")}`);
    console.log(`[Vidlink] ${valid.length}/${streams.length} stream(s) validated OK`);
    return valid;
  });
}

// src/vidlink/index.js
var QUALITY_ORDER = {
  "4K": 5,
  "1440p": 4,
  "1080p": 3,
  "720p": 2,
  "480p": 1,
  "360p": 0,
  "240p": -1,
  "Auto": -2,
  "Unknown": -3
};
function getStreams(tmdbId, mediaType = "movie", seasonNum = null, episodeNum = null) {
  return __async(this, null, function* () {
    console.log(`[Vidlink] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === "tv" ? `, S:${seasonNum}E:${episodeNum}` : ""}`);
    try {
      const { title, year } = yield getTmdbInfo(tmdbId, mediaType);
      const encryptedId = yield encryptTmdbId(tmdbId);
      let vidlinkUrl;
      if (mediaType === "tv" && seasonNum && episodeNum) {
        vidlinkUrl = `${VIDLINK_API}/tv/${encryptedId}/${seasonNum}/${episodeNum}`;
      } else {
        vidlinkUrl = `${VIDLINK_API}/movie/${encryptedId}`;
      }
      console.log(`[Vidlink] Requesting: ${vidlinkUrl}`);
      const response = yield makeRequest(vidlinkUrl, { headers: VIDLINK_HEADERS });
      const data = yield response.json();
      console.log(`[Vidlink] Received response from Vidlink API`);
      const mediaInfo = {
        title,
        year,
        mediaType,
        season: seasonNum,
        episode: episodeNum
      };
      const streams = processVidlinkResponse(data, mediaInfo);
      if (streams.length === 0) {
        console.log("[Vidlink] No streams found in response");
        return [];
      }
      const playlistStreams = streams.filter((s) => s._isPlaylist);
      const directStreams = streams.filter((s) => !s._isPlaylist);
      if (playlistStreams.length > 0) {
        console.log(`[Vidlink] Processing ${playlistStreams.length} M3U8 playlists`);
        const playlistPromises = playlistStreams.map(
          (ps) => fetchAndParseM3U8(ps.url, ps.mediaInfo, ps.subtitles)
        );
        const parsedStreamArrays = yield Promise.all(playlistPromises);
        const allStreams = directStreams.concat(...parsedStreamArrays);
        allStreams.sort((a, b) => (QUALITY_ORDER[b.quality] || -3) - (QUALITY_ORDER[a.quality] || -3));
        console.log(`[Vidlink] Successfully processed ${allStreams.length} total streams`);
        return yield validateAndFilterStreams(allStreams);
      } else {
        directStreams.sort((a, b) => (QUALITY_ORDER[b.quality] || -3) - (QUALITY_ORDER[a.quality] || -3));
        console.log(`[Vidlink] Successfully processed ${directStreams.length} streams`);
        return yield validateAndFilterStreams(directStreams);
      }
    } catch (error) {
      console.error(`[Vidlink] Error in getStreams: ${error.message}`);
      return [];
    }
  });
}
  return { getStreams: getStreams };
})();

const CastleSource = (function () {
/**
 * castle - Built from src/castle/
 * Generated: 2025-12-31T21:23:16.715Z
 */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/castle/constants.js
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";
var CASTLE_BASE = "https://api.hlowb.com";
var PKG = "com.external.castle";
var CHANNEL = "IndiaA";
var CLIENT = "1";
var LANG = "en-US";
var API_HEADERS = {
  "User-Agent": "okhttp/4.9.3",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "Keep-Alive",
  "Referer": CASTLE_BASE
};
var PLAYBACK_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Accept": "video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Connection": "keep-alive",
  "Sec-Fetch-Dest": "video",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
  "DNT": "1"
};

// src/castle/http.js
function makeRequest(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    try {
      const response = yield fetch(url, {
        method: options.method || "GET",
        headers: __spreadValues(__spreadValues({}, API_HEADERS), options.headers),
        body: options.body
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      console.error(`[Castle] Request failed for ${url}: ${error.message}`);
      throw error;
    }
  });
}
function extractCipherFromResponse(response) {
  return __async(this, null, function* () {
    const text = yield response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Empty response");
    }
    try {
      const json = JSON.parse(trimmed);
      if (json && json.data && typeof json.data === "string") {
        return json.data.trim();
      }
    } catch (e) {
    }
    return trimmed;
  });
}
function extractDataBlock(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    return obj.data;
  }
  return obj || {};
}

// src/castle/tmdb.js
function getTMDBDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const response = yield makeRequest(url);
    const data = yield response.json();
    const title = mediaType === "tv" ? data.name : data.title;
    const releaseDate = mediaType === "tv" ? data.first_air_date : data.release_date;
    const year = releaseDate ? parseInt(releaseDate.split("-")[0]) : null;
    return {
      title,
      year,
      tmdbId
    };
  });
}

// src/castle/decrypt.js
function decryptCastle(encryptedB64, securityKeyB64) {
  return __async(this, null, function* () {
    console.log("[Castle] Starting local AES-CBC decryption...");
    try {
      const CryptoJS = require("crypto-js");
      
      // Monkey-patch to bypass NuvioMobile QuickJS JNI typed array mapping bug
      if (typeof __crypto_aes_decrypt_raw !== 'undefined') {
        const originalDecrypt = CryptoJS.AES.decrypt;
        CryptoJS.AES.decrypt = function(cipher, key, options) {
          try {
            const wordArrayToBytes = (wordArray) => {
              const bytes = new Uint8Array(wordArray.sigBytes);
              for (let i = 0; i < wordArray.sigBytes; i++) {
                bytes[i] = (wordArray.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
              }
              return bytes;
            };
            const toUint8Array = (data) => {
              if (data instanceof Uint8Array) return data;
              if (data instanceof ArrayBuffer) return new Uint8Array(data);
              if (data && typeof data.length === 'number') return new Uint8Array(Array.prototype.slice.call(data));
              return new Uint8Array(0);
            };
            const data = typeof cipher === 'string'
              ? new Uint8Array(Array.from(atob(cipher), c => c.charCodeAt(0)))
              : (cipher.ciphertext ? wordArrayToBytes(cipher.ciphertext) : toUint8Array(cipher));
            const kBytes = wordArrayToBytes(key);
            const ivBytes = (options && options.iv) ? wordArrayToBytes(options.iv) : new Uint8Array(0);
            const mode = (options && options.mode) || 'AES-CBC';
            
            // Map Uint8Array (unsigned) to Int8Array (signed) to match Kotlin ByteArray
            const keyArg = typeof Int8Array !== 'undefined' ? new Int8Array(kBytes.buffer) : kBytes;
            const ivArg = typeof Int8Array !== 'undefined' ? new Int8Array(ivBytes.buffer) : ivBytes;
            const dataArg = typeof Int8Array !== 'undefined' ? new Int8Array(data.buffer) : data;
            
            const resBytes = __crypto_aes_decrypt_raw(mode, keyArg, ivArg, dataArg);
            const plain = new TextDecoder().decode(resBytes);
            return { toString: function() { return plain; } };
          } catch (err) {
            console.error("[Castle JNI Patch] Decrypt failed, falling back:", err);
            return originalDecrypt.call(CryptoJS.AES, cipher, key, options);
          }
        };
      }

      const CASTLE_SUFFIX = "T!BgJB";
      
      const securityKeyWords = CryptoJS.enc.Base64.parse(securityKeyB64);
      const suffixWords = CryptoJS.enc.Utf8.parse(CASTLE_SUFFIX);
      const keyMaterial = securityKeyWords.concat(suffixWords);
      
      let finalKey;
      if (keyMaterial.sigBytes < 16) {
        const padding = CryptoJS.lib.WordArray.create(new Array(16 - keyMaterial.sigBytes).fill(0));
        finalKey = keyMaterial.concat(padding);
      } else if (keyMaterial.sigBytes > 16) {
        finalKey = CryptoJS.lib.WordArray.create(keyMaterial.words.slice(0, 4), 16);
      } else {
        finalKey = keyMaterial;
      }
      
      const iv = finalKey;
      
      const decrypted = CryptoJS.AES.decrypt(encryptedB64, finalKey, {
        iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      });
      
      const result = decrypted.toString(CryptoJS.enc.Utf8);
      if (!result) {
        throw new Error("Decryption resulted in empty string (possible key/IV mismatch)");
      }
      
      console.log("[Castle] Local decryption successful");
      return result;
    } catch (error) {
      console.error(`[Castle] Local decryption failed: ${error.message}`);
      throw error;
    }
  });
}

// src/castle/api.js
function getSecurityKey() {
  return __async(this, null, function* () {
    console.log("[Castle] Fetching security key...");
    const url = `${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`;
    const response = yield makeRequest(url);
    const data = yield response.json();
    if (data.code !== 200 || !data.data) {
      throw new Error(`Security key API error: ${JSON.stringify(data)}`);
    }
    console.log("[Castle] Security key obtained");
    return data.data;
  });
}
function searchCastle(securityKey, keyword, page = 1, size = 30) {
  return __async(this, null, function* () {
    console.log(`[Castle] Searching for: ${keyword}`);
    const params = new URLSearchParams({
      channel: CHANNEL,
      clientType: CLIENT,
      keyword,
      lang: LANG,
      mode: "1",
      packageName: PKG,
      page: page.toString(),
      size: size.toString()
    });
    const url = `${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params.toString()}`;
    const response = yield makeRequest(url);
    const cipher = yield extractCipherFromResponse(response);
    const decrypted = yield decryptCastle(cipher, securityKey);
    return JSON.parse(decrypted);
  });
}
function getDetails(securityKey, movieId) {
  return __async(this, null, function* () {
    console.log(`[Castle] Fetching details for movieId: ${movieId}`);
    const url = `${CASTLE_BASE}/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`;
    const response = yield makeRequest(url);
    const cipher = yield extractCipherFromResponse(response);
    const decrypted = yield decryptCastle(cipher, securityKey);
    return JSON.parse(decrypted);
  });
}
function getVideoV1(securityKey, movieId, episodeId, languageId, resolution = 2) {
  return __async(this, null, function* () {
    console.log(`[Castle] Fetching video (v1) for movieId: ${movieId}, languageId: ${languageId}`);
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    const body = {
      mode: "1",
      appMarket: "GuanWang",
      clientType: CLIENT,
      woolUser: "false",
      apkSignKey: "ED0955EB04E67A1D9F3305B95454FED485261475",
      androidVersion: "13",
      movieId: movieId.toString(),
      episodeId: episodeId.toString(),
      languageId: languageId.toString(),
      isNewUser: "true",
      resolution: resolution.toString(),
      packageName: PKG
    };
    const response = yield makeRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const cipher = yield extractCipherFromResponse(response);
    const decrypted = yield decryptCastle(cipher, securityKey);
    return JSON.parse(decrypted);
  });
}
function getVideo2(securityKey, movieId, episodeId, resolution = 2) {
  return __async(this, null, function* () {
    console.log(`[Castle] Fetching video (v2) for movieId: ${movieId}, episodeId: ${episodeId}`);
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    const body = {
      mode: "1",
      appMarket: "GuanWang",
      clientType: CLIENT,
      woolUser: "false",
      apkSignKey: "ED0955EB04E67A1D9F3305B95454FED485261475",
      androidVersion: "13",
      movieId: movieId.toString(),
      episodeId: episodeId.toString(),
      isNewUser: "true",
      resolution: resolution.toString(),
      packageName: PKG
    };
    const response = yield makeRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const cipher = yield extractCipherFromResponse(response);
    const decrypted = yield decryptCastle(cipher, securityKey);
    return JSON.parse(decrypted);
  });
}
function findCastleMovieId(securityKey, tmdbInfo, mediaType) {
  return __async(this, null, function* () {
    const searchTerm = tmdbInfo.year ? `${tmdbInfo.title} ${tmdbInfo.year}` : tmdbInfo.title;
    const searchResult = yield searchCastle(securityKey, searchTerm);
    const data = extractDataBlock(searchResult);
    const rows = data.rows || [];
    if (rows.length === 0) {
      throw new Error("No search results found");
    }
    // Castle's catalog mixes TV shows (movieType 1) and movies (movieType 2)
    // in the same search results, and titles can share substrings with
    // completely unrelated entries (e.g. a one-off movie titled "X: The Y and
    // the Z" incidentally starting with the show's own name). Restrict to
    // the requested type and require a real title match instead of loose
    // substring containment, which previously picked unrelated content.
    const wantType = mediaType === "tv" ? 1 : 2;
    const searchTitle = tmdbInfo.title.toLowerCase();
    const candidates = rows.filter((item) => item.movieType === wantType);

    let best = candidates.find((item) => (item.title || item.name || "").toLowerCase() === searchTitle);
    if (!best) {
      best = candidates.find((item) => {
        const itemTitle = (item.title || item.name || "").toLowerCase();
        return itemTitle.startsWith(`${searchTitle}:`) || itemTitle.startsWith(`${searchTitle} `) || itemTitle === searchTitle;
      });
    }
    if (!best) {
      throw new Error(`No matching ${mediaType === "tv" ? "TV show" : "movie"} found for "${tmdbInfo.title}"`);
    }
    const movieId2 = best.id || best.redirectId || best.redirectIdStr;
    console.log(`[Castle] Found match: ${best.title || best.name} (id: ${movieId2})`);
    return movieId2.toString();
  });
}

// src/castle/utils.js
function getQualityValue(quality) {
  if (!quality)
    return 0;
  const cleanQuality = quality.toString().toLowerCase().replace(/^(sd|hd|fhd|uhd|4k)\s*/i, "").replace(/p$/, "").trim();
  const qualityMap = {
    "4k": 2160,
    "2160": 2160,
    "1440": 1440,
    "1080": 1080,
    "720": 720,
    "480": 480,
    "360": 360,
    "240": 240
  };
  if (qualityMap[cleanQuality]) {
    return qualityMap[cleanQuality];
  }
  const numQuality = parseInt(cleanQuality);
  if (!isNaN(numQuality) && numQuality > 0) {
    return numQuality;
  }
  return 0;
}
function formatSize(sizeValue) {
  if (typeof sizeValue !== "number" || sizeValue <= 0) {
    return "Unknown";
  }
  if (sizeValue > 1e9) {
    return `${(sizeValue / 1e9).toFixed(2)} GB`;
  }
  return `${(sizeValue / 1e6).toFixed(0)} MB`;
}
function resolutionToQuality(resolution) {
  const qualityMap = {
    1: "480p",
    2: "720p",
    3: "1080p"
  };
  return qualityMap[resolution] || `${resolution}p`;
}

// src/castle/index.js
function processVideoResponse(videoData, mediaInfo, seasonNum, episodeNum, resolution, languageInfo) {
  const streams = [];
  const data = extractDataBlock(videoData);
  const videoUrl = data.videoUrl;
  if (!videoUrl) {
    console.log("[Castle] No videoUrl found in response");
    return streams;
  }
  
  const subtitles = [];
  if (data.subtitles && Array.isArray(data.subtitles)) {
    data.subtitles.forEach((sub) => {
      if (sub.url) {
        subtitles.push({
          url: sub.url,
          language: sub.abbreviate || "Unknown",
          name: sub.title || sub.abbreviate || "Unknown",
          headers: PLAYBACK_HEADERS
        });
      }
    });
  }

  let mediaTitle = mediaInfo.title || "Unknown";
  if (mediaInfo.year) {
    mediaTitle += ` (${mediaInfo.year})`;
  }
  if (seasonNum && episodeNum) {
    mediaTitle = `${mediaInfo.title} S${String(seasonNum).padStart(2, "0")}E${String(episodeNum).padStart(2, "0")}`;
  }
  const quality = resolutionToQuality(resolution);
  if (data.videos && Array.isArray(data.videos)) {
    for (const video of data.videos) {
      let videoQuality = video.resolutionDescription || video.resolution || quality;
      videoQuality = videoQuality.replace(/^(SD|HD|FHD)\s+/i, "");
      const streamName = languageInfo ? `Castle ${languageInfo} - ${videoQuality}` : `Castle - ${videoQuality}`;
      streams.push({
        name: streamName,
        title: mediaTitle,
        url: video.url || videoUrl,
        quality: videoQuality,
        size: formatSize(video.size),
        headers: PLAYBACK_HEADERS,
        provider: "castle",
        subtitles
      });
    }
  } else {
    const streamName = languageInfo ? `Castle ${languageInfo} - ${quality}` : `Castle - ${quality}`;
    streams.push({
      name: streamName,
      title: mediaTitle,
      url: videoUrl,
      quality,
      size: formatSize(data.size),
      headers: PLAYBACK_HEADERS,
      provider: "castle",
      subtitles
    });
  }
  return streams;
}
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  return __async(this, null, function* () {
    console.log(`[Castle] Starting extraction for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === "tv" ? `, S:${seasonNum}E:${episodeNum}` : ""}`);
    try {
      const tmdbInfo = yield getTMDBDetails(tmdbId, mediaType);
      console.log(`[Castle] TMDB Info: "${tmdbInfo.title}" (${tmdbInfo.year || "N/A"})`);
      const securityKey = yield getSecurityKey();
      const movieId = yield findCastleMovieId(securityKey, tmdbInfo, mediaType);
      let details = yield getDetails(securityKey, movieId);
      let currentMovieId = movieId;
      if (mediaType === "tv" && seasonNum && episodeNum) {
        const data = extractDataBlock(details);
        const seasons = data.seasons || [];
        const season = seasons.find((s) => s.number === seasonNum);
        if (season && season.movieId && season.movieId !== movieId) {
          console.log(`[Castle] Fetching season ${seasonNum} details...`);
          details = yield getDetails(securityKey, season.movieId.toString());
          currentMovieId = season.movieId.toString();
        }
      }
      const detailsData = extractDataBlock(details);
      const episodes = detailsData.episodes || [];
      let episodeId = null;
      if (mediaType === "tv" && seasonNum && episodeNum) {
        const episode2 = episodes.find((e) => e.number === episodeNum);
        if (episode2 && episode2.id) {
          episodeId = episode2.id.toString();
        }
      } else if (episodes.length > 0) {
        episodeId = episodes[0].id.toString();
      }
      if (!episodeId) {
        throw new Error("Could not find episode ID");
      }
      const episode = episodes.find((e) => e.id.toString() === episodeId);
      const tracks = episode && episode.tracks || [];
      const resolution = 2;
      // Each language track is an independent request - fetch them all concurrently
      // instead of one at a time. `existIndividualVideo` looks like it should mean
      // "this language has its own separate video file", but Castle's getVideoV1
      // endpoint reliably returns a distinct URL per languageId even when the flag
      // is false (confirmed directly: both Hindi and English tracks below had it
      // false, yet each returned its own working stream). Gating on that flag was
      // skipping every real per-language track and falling through to the "shared"
      // endpoint instead, which just serves whatever Castle marks as its own
      // isDefault track - observed to be Hindi for an English-audience title, with
      // no English option ever surfacing. Only `languageId` itself is required.
      const trackResults = yield Promise.all(tracks.map((track) => __async(this, null, function* () {
        const langName = track.languageName || track.abbreviate || "Unknown";
        if (!track.languageId) return [];
        try {
          console.log(`[Castle] Fetching ${langName} (languageId: ${track.languageId})`);
          const videoData = yield getVideoV1(securityKey, currentMovieId, episodeId, track.languageId, resolution);
          const langStreams = processVideoResponse(videoData, tmdbInfo, seasonNum, episodeNum, resolution, `[${langName}]`);
          if (langStreams.length > 0) {
            console.log(`[Castle] \u2705 ${langName}: Found ${langStreams.length} streams`);
          }
          return langStreams;
        } catch (error) {
          console.log(`[Castle] \u26A0\uFE0F ${langName}: Failed - ${error.message}`);
          return [];
        }
      })));
      const allStreams = trackResults.flat();
      if (allStreams.length === 0) {
        console.log("[Castle] Falling back to shared stream (v2)");
        const videoData = yield getVideo2(securityKey, currentMovieId, episodeId, resolution);
        const sharedStreams = processVideoResponse(videoData, tmdbInfo, seasonNum, episodeNum, resolution, "[Shared]");
        allStreams.push(...sharedStreams);
      }
      // Once every language track is included, several can tie on quality -
      // bias English (or the shared/default track, when no language info
      // exists at all) to the front on a tie so it - not an arbitrary
      // language that happened to load first - is the one aggregate.js picks
      // as [PREFERRED]. Other languages remain in the list, just not first.
      const languagePriority = (name) => {
        if (!name) return 2;
        if (name.includes("[English]")) return 0;
        if (name.includes("[Shared]")) return 1;
        return 2;
      };
      allStreams.sort((a, b) => {
        const byQuality = getQualityValue(b.quality) - getQualityValue(a.quality);
        if (byQuality !== 0) return byQuality;
        return languagePriority(a.name) - languagePriority(b.name);
      });
      console.log(`[Castle] Total streams found: ${allStreams.length}`);
      return allStreams;
    } catch (error) {
      console.error(`[Castle] Error: ${error.message}`);
      return [];
    }
  });
}
  return { getStreams: getStreams };
})();

const HdHub4uSource = (function () {
/**
 * hdhub4u - Built from src/hdhub4u/
 * Generated: 2026-09-11T16:50:57.161Z
 */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/hdhub4u/index.js
var import_cheerio_without_node_native2 = __toESM(require("cheerio-without-node-native"));

// src/hdhub4u/constants.js
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";
var MAIN_URL = "https://new6.hdhub4u.fo";
var DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
var DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1e3;
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Cookie": "xla=s4t",
  "Referer": `${MAIN_URL}/`
};
function updateMainUrl(url) {
  MAIN_URL = url;
  HEADERS.Referer = `${url}/`;
}

// src/hdhub4u/utils.js
var domainCacheTimestamp = 0;
function fetchWithTimeout(url, options) {
  return fetch(url, options);
}
function formatBytes(bytes) {
  if (!bytes || bytes === 0)
    return "Unknown";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
function extractServerName(source) {
  if (!source)
    return "Unknown";
  if (source.startsWith("HubCloud")) {
    const serverMatch = source.match(/HubCloud(?:\s*-\s*([^[\]]+))?/);
    return serverMatch ? serverMatch[1] || "Download" : "HubCloud";
  }
  if (source.startsWith("Pixeldrain"))
    return "Pixeldrain";
  if (source.startsWith("StreamTape"))
    return "StreamTape";
  if (source.startsWith("HubCdn"))
    return "HubCdn";
  if (source.startsWith("HbLinks"))
    return "HbLinks";
  if (source.startsWith("Hubstream"))
    return "Hubstream";
  return source.replace(/^www\./, "").split(".")[0];
}
function rot13(value) {
  return value.replace(/[a-zA-Z]/g, function(c) {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}
var BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function atob(value) {
  if (!value)
    return "";
  let input = String(value).replace(/=+$/, "");
  let output = "";
  let bc = 0, bs, buffer, idx = 0;
  while (buffer = input.charAt(idx++)) {
    buffer = BASE64_CHARS.indexOf(buffer);
    if (~buffer) {
      bs = bc % 4 ? bs * 64 + buffer : buffer;
      if (bc++ % 4) {
        output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
      }
    }
  }
  return output;
}
function cleanTitle(title) {
  let name = title.replace(/\.[a-zA-Z0-9]{2,4}$/, "");
  const normalized = name.replace(/WEB[-_. ]?DL/gi, "WEB-DL").replace(/WEB[-_. ]?RIP/gi, "WEBRIP").replace(/H[ .]?265/gi, "H265").replace(/H[ .]?264/gi, "H264").replace(/DDP[ .]?([0-9]\.[0-9])/gi, "DDP$1");
  const parts = normalized.split(/[\s_.]/);
  const sourceTags = /* @__PURE__ */ new Set(["WEB-DL", "WEBRIP", "BLURAY", "HDRIP", "DVDRIP", "HDTV", "CAM", "TS", "BRRIP", "BDRIP"]);
  const codecTags = /* @__PURE__ */ new Set(["H264", "H265", "X264", "X265", "HEVC", "AVC"]);
  const audioTags = ["AAC", "AC3", "DTS", "MP3", "FLAC", "DD", "DDP", "EAC3"];
  const audioExtras = /* @__PURE__ */ new Set(["ATMOS"]);
  const hdrTags = /* @__PURE__ */ new Set(["SDR", "HDR", "HDR10", "HDR10+", "DV", "DOLBYVISION"]);
  const filtered = parts.map((part) => {
    const p = part.toUpperCase();
    if (sourceTags.has(p))
      return p;
    if (codecTags.has(p))
      return p;
    if (audioTags.some((tag) => p.startsWith(tag)))
      return p;
    if (audioExtras.has(p))
      return p;
    if (hdrTags.has(p))
      return p === "DOLBYVISION" || p === "DV" ? "DOLBYVISION" : p;
    if (p === "NF" || p === "CR")
      return p;
    return null;
  }).filter(Boolean);
  return [...new Set(filtered)].join(" ");
}
function fetchAndUpdateDomain() {
  return __async(this, null, function* () {
    const now = Date.now();
    if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL)
      return;
    console.log("[HDHub4u] Fetching latest domain...");
    try {
      const response = yield fetchWithTimeout(DOMAINS_URL, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
      if (response.ok) {
        const data = yield response.json();
        if (data && data.HDHUB4u) {
          const newDomain = data.HDHUB4u;
          if (newDomain !== MAIN_URL) {
            console.log(`[HDHub4u] Updating domain from ${MAIN_URL} to ${newDomain}`);
            updateMainUrl(newDomain);
            domainCacheTimestamp = now;
          }
        }
      }
    } catch (error) {
      console.error(`[HDHub4u] Failed to fetch latest domains: ${error.message}`);
    }
  });
}
function getCurrentDomain() {
  return __async(this, null, function* () {
    yield fetchAndUpdateDomain();
    return MAIN_URL;
  });
}
function normalizeTitle(title) {
  if (!title)
    return "";
  return title.toLowerCase().replace(/\b(the|a|an)\b/g, "").replace(/[:\-_]/g, " ").replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}
function calculateTitleSimilarity(title1, title2) {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);
  if (norm1 === norm2)
    return 1;
  const words1 = norm1.split(/\s+/).filter((w) => w.length > 0);
  const words2 = norm2.split(/\s+/).filter((w) => w.length > 0);
  if (words1.length === 0 || words2.length === 0)
    return 0;
  const set2 = new Set(words2);
  const matchedCount = words1.filter((w) => set2.has(w)).length;
  let score = matchedCount / words1.length;
  if (matchedCount === words1.length) {
    score += 0.3;
  }
  const extraWordsCount = words2.length - matchedCount;
  score -= Math.min(0.2, extraWordsCount * 0.01);
  return score;
}
function findBestTitleMatch(mediaInfo, searchResults, mediaType, season) {
  if (!searchResults || searchResults.length === 0)
    return null;
  let bestMatch = null;
  let bestScore = 0;
  for (const result of searchResults) {
    let score = calculateTitleSimilarity(mediaInfo.title, result.title);
    if (score <= 0)
      continue;
    if (mediaInfo.year && result.year) {
      const yearDiff = Math.abs(mediaInfo.year - result.year);
      if (yearDiff === 0)
        score += 0.2;
      else if (yearDiff <= 1)
        score += 0.1;
      else if (yearDiff > 5)
        score -= 0.3;
    }
    if (mediaType === "tv" && season) {
      const titleLower = result.title.toLowerCase();
      const seasonPatterns = [
        `season ${season}`,
        `s${season}`,
        `season ${season.toString().padStart(2, "0")}`,
        `s${season.toString().padStart(2, "0")}`
      ];
      const hasSeason = seasonPatterns.some((p) => titleLower.includes(p));
      const otherSeasonMatch = titleLower.match(/season\s*(\d+)|s(\d+)/i);
      if (otherSeasonMatch) {
        const foundSeason = parseInt(otherSeasonMatch[1] || otherSeasonMatch[2]);
        if (foundSeason !== season) {
          score -= 0.8;
        }
      }
      if (hasSeason)
        score += 0.5;
      else
        score -= 0.3;
    }
    if (result.title.toLowerCase().includes("2160p") || result.title.toLowerCase().includes("4k")) {
      score += 0.05;
    }
    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestMatch = result;
    }
  }
  if (bestMatch)
    console.log(`[HDHub4u] Best title match: "${bestMatch.title}" (score: ${bestScore.toFixed(2)})`);
  return bestMatch;
}
function getTMDBDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var _a;
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const response = yield fetchWithTimeout(url, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok)
      throw new Error(`TMDB API error: ${response.status}`);
    const data = yield response.json();
    const title = mediaType === "tv" ? data.name : data.title;
    const releaseDate = mediaType === "tv" ? data.first_air_date : data.release_date;
    const year = releaseDate ? parseInt(releaseDate.split("-")[0]) : null;
    return { title, year, imdbId: ((_a = data.external_ids) == null ? void 0 : _a.imdb_id) || null };
  });
}

// src/hdhub4u/extractors.js
var import_cheerio_without_node_native = __toESM(require("cheerio-without-node-native"));
var import_crypto_js = __toESM(require("crypto-js"));
function getRedirectLinks(url) {
  return __async(this, null, function* () {
    try {
      const response = yield fetchWithTimeout(url, { headers: HEADERS });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const doc = yield response.text();
      const regex = /s\s*\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]|ck\s*\(\s*['"]_wp_http_\d+['"]\s*,\s*['"]([^'"]+)['"]/g;
      let combinedString = "";
      let match;
      while ((match = regex.exec(doc)) !== null) {
        const extractedValue = match[1] || match[2];
        if (extractedValue)
          combinedString += extractedValue;
      }
      if (!combinedString) {
        const redirectMatch = doc.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (redirectMatch && redirectMatch[1]) {
          const newUrl = redirectMatch[1];
          if (newUrl !== url && !newUrl.includes(url)) {
            return yield getRedirectLinks(newUrl);
          }
        }
        return null;
      }
      const decodedString = atob(rot13(atob(atob(combinedString))));
      const jsonObject = JSON.parse(decodedString);
      const encodedUrl = atob(jsonObject.o || "").trim();
      if (encodedUrl)
        return encodedUrl;
      const data = atob(jsonObject.data || "").trim();
      const wpHttp = (jsonObject.blog_url || "").trim();
      if (wpHttp && data) {
        const directLinkResponse = yield fetchWithTimeout(`${wpHttp}?re=${data}`, { headers: HEADERS });
        const html = yield directLinkResponse.text();
        const $ = import_cheerio_without_node_native.default.load(html);
        return ($("body").text() || html).trim();
      }
      return null;
    } catch (e) {
      return null;
    }
  });
}
function vidStackExtractor(url) {
  return __async(this, null, function* () {
    var _a, _b, _c;
    try {
      const hash = url.split("#").pop().split("/").pop();
      const baseUrl = new URL(url).origin;
      const apiUrl = `${baseUrl}/api/v1/video?id=${hash}`;
      const response = yield fetchWithTimeout(apiUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: url }) });
      const encoded = (yield response.text()).trim();
      const key = import_crypto_js.default.enc.Utf8.parse("kiemtienmua911ca");
      const ivs = ["1234567890oiuytr", "0123456789abcdef"];
      for (const ivStr of ivs) {
        try {
          const iv = import_crypto_js.default.enc.Utf8.parse(ivStr);
          const decrypted = import_crypto_js.default.AES.decrypt(
            { ciphertext: import_crypto_js.default.enc.Hex.parse(encoded) },
            key,
            { iv, mode: import_crypto_js.default.mode.CBC, padding: import_crypto_js.default.pad.Pkcs7 }
          );
          const decryptedText = decrypted.toString(import_crypto_js.default.enc.Utf8);
          if (decryptedText && decryptedText.includes("source")) {
            const m3u8 = (_b = (_a = decryptedText.match(/"source":"(.*?)"/)) == null ? void 0 : _a[1]) == null ? void 0 : _b.replace(/\\/g, "");
            const subtitles = [];
            const subtitleSection = (_c = decryptedText.match(/"subtitle":\{(.*?)\}/)) == null ? void 0 : _c[1];
            if (subtitleSection) {
              const subtitlePattern = /"([^"]+)":\s*"([^"]+)"/g;
              let subMatch;
              while ((subMatch = subtitlePattern.exec(subtitleSection)) !== null) {
                const lang = subMatch[1];
                const subPath = subMatch[2].split("#")[0].replace(/\\/g, "");
                if (subPath) {
                  subtitles.push({
                    language: lang,
                    url: subPath.startsWith("http") ? subPath : `${baseUrl}${subPath}`
                  });
                }
              }
            }
            if (m3u8) {
              return [{
                source: "Vidstack Hubstream",
                quality: "M3U8",
                url: m3u8.replace("https:", "http:"),
                headers: {
                  "Referer": url,
                  "Origin": url.split("/").pop()
                },
                subtitles
              }];
            }
          }
        } catch (e) {
        }
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}
function hbLinksExtractor(url) {
  return __async(this, null, function* () {
    try {
      const response = yield fetchWithTimeout(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: url }) });
      const data = yield response.text();
      const $ = import_cheerio_without_node_native.default.load(data);
      const links = $("h3 a, h5 a, div.entry-content p a").map((i, el) => $(el).attr("href")).get();
      const results = yield Promise.all(links.map((l) => loadExtractor(l, url)));
      return results.flat().map((link) => __spreadProps(__spreadValues({}, link), {
        source: `${link.source} Hblinks`
      }));
    } catch (e) {
      return [];
    }
  });
}
function pixelDrainExtractor(link) {
  return __async(this, null, function* () {
    var _a;
    try {
      const urlObj = new URL(link);
      const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      const fileId = ((_a = link.match(/(?:file|u)\/([A-Za-z0-9]+)/)) == null ? void 0 : _a[1]) || link.split("/").pop();
      if (!fileId)
        return [{ source: "Pixeldrain", quality: 0, url: link }];
      const finalUrl = link.includes("?download") ? link : `${baseUrl}/api/file/${fileId}?download`;
      return [{ source: "Pixeldrain", quality: 0, url: finalUrl }];
    } catch (e) {
      return [{ source: "Pixeldrain", quality: 0, url: link }];
    }
  });
}
function streamTapeExtractor(link) {
  return __async(this, null, function* () {
    var _a, _b, _c, _d;
    try {
      const url = new URL(link);
      url.hostname = "streamtape.com";
      const res = yield fetchWithTimeout(url.toString(), { headers: HEADERS });
      const data = yield res.text();
      let videoSrc = (_c = (_b = (_a = data.match(/document\.getElementById\('videolink'\)\.innerHTML = (.*?);/)) == null ? void 0 : _a[1]) == null ? void 0 : _b.match(/'(\/\/streamtape\.com\/get_video[^']+)'/)) == null ? void 0 : _c[1];
      if (!videoSrc) {
        videoSrc = (_d = data.match(/'(\/\/streamtape\.com\/get_video[^']+)'/)) == null ? void 0 : _d[1];
      }
      return videoSrc ? [{ source: "StreamTape", quality: 720, url: "https:" + videoSrc }] : [];
    } catch (e) {
      return [];
    }
  });
}
function hubCloudExtractor(url, referer) {
  return __async(this, null, function* () {
    var _a;
    try {
      let currentUrl = url.replace("hubcloud.ink", "hubcloud.dad");
      const pageResponse = yield fetchWithTimeout(currentUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
      let pageData = yield pageResponse.text();
      let finalUrl = currentUrl;
      if (!currentUrl.includes("hubcloud.php")) {
        let nextHref = "";
        const $first = import_cheerio_without_node_native.default.load(pageData);
        const downloadBtn = $first("#download");
        if (downloadBtn.length) {
          nextHref = downloadBtn.attr("href");
        } else {
          const scriptUrlMatch = pageData.match(/var url = '([^']*)'/);
          if (scriptUrlMatch)
            nextHref = scriptUrlMatch[1];
        }
        if (nextHref) {
          if (!nextHref.startsWith("http")) {
            const urlObj = new URL(currentUrl);
            nextHref = `${urlObj.protocol}//${urlObj.hostname}/${nextHref.replace(/^\//, "")}`;
          }
          finalUrl = nextHref;
          const secondResponse = yield fetchWithTimeout(finalUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: currentUrl }) });
          pageData = yield secondResponse.text();
        }
      }
      const $ = import_cheerio_without_node_native.default.load(pageData);
      const size = $("i#size").text().trim();
      const header = $("div.card-header").text().trim();
      const qualityStr = (_a = header.match(/(\d{3,4})[pP]/)) == null ? void 0 : _a[1];
      const quality = qualityStr ? parseInt(qualityStr) : 1080;
      const headerDetails = cleanTitle(header);
      const labelExtras = (headerDetails ? `[${headerDetails}]` : "") + (size ? `[${size}]` : "");
      const sizeInBytes = (() => {
        const sizeMatch = size.match(/([\d.]+)\s*(GB|MB|KB)/i);
        if (!sizeMatch)
          return 0;
        const multipliers = { GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 };
        return parseFloat(sizeMatch[1]) * (multipliers[sizeMatch[2].toUpperCase()] || 0);
      })();
      const links = [];
      const elements = $("a.btn").get();
      const perButton = yield Promise.all(elements.map((element) => __async(this, null, function* () {
        const link = $(element).attr("href");
        const text = $(element).text().toLowerCase();
        const fileName = header || headerDetails || "Unknown";
        if (text.includes("download file") || text.includes("fsl server") || text.includes("s3 server") || text.includes("fslv2") || text.includes("mega server") || link && link.includes("r2.dev")) {
          let label = "HubCloud";
          if (link && link.includes("r2.dev"))
            label = "Direct R2";
          else if (link && link.includes("workers.dev"))
            label = "ZipDisk Server";
          else if (text.includes("fsl server"))
            label = "HubCloud - FSL";
          else if (text.includes("s3 server"))
            label = "HubCloud - S3";
          else if (text.includes("fslv2"))
            label = "HubCloud - FSLv2";
          else if (text.includes("mega server"))
            label = "HubCloud - Mega";
          return [{ source: `${label} ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName }];
        } else if (text.includes("buzzserver")) {
          try {
            const buzzResp = yield fetchWithTimeout(`${link}/download`, { method: "GET", headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: link }), redirect: "manual" });
            let dlink = buzzResp.headers.get("hx-redirect") || buzzResp.headers.get("HX-Redirect");
            if (!dlink && buzzResp.url && buzzResp.url !== `${link}/download`) {
              dlink = buzzResp.url;
            }
            if (dlink) {
              return [{ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: dlink, size: sizeInBytes, fileName }];
            }
            return [];
          } catch (e) {
            return [];
          }
        } else if (text.includes("10gbps") || link && link.includes("hubcloud.cx")) {
          let targetUrl = link;
          if (link && !link.includes("hubcloud.cx")) {
            try {
              const resp = yield fetchWithTimeout(link, { method: "GET", redirect: "manual" });
              const loc = resp.headers.get("location");
              if (loc && loc.includes("link=")) {
                targetUrl = loc.substring(loc.indexOf("link=") + 5);
              }
            } catch (e) {
            }
          }
          return [{ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: targetUrl, size: sizeInBytes, fileName }];
        } else if (text.includes("zipdisk") || link && link.includes("workers.dev")) {
          return [{ source: `ZipDisk Server ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName }];
        } else if (link && link.includes("pixeldra")) {
          const results = yield pixelDrainExtractor(link);
          return results.map((l) => __spreadProps(__spreadValues({}, l), { source: `${l.source} ${labelExtras}`, size: sizeInBytes, fileName }));
        } else if (link && !link.includes("magnet:") && link.startsWith("http")) {
          const extracted = yield loadExtractor(link, finalUrl);
          return extracted.map((l) => __spreadProps(__spreadValues({}, l), { quality: l.quality || quality }));
        }
        return [];
      })));
      links.push(...perButton.flat());
      return links;
    } catch (e) {
      return [];
    }
  });
}
function hubCdnExtractor(url, referer) {
  return __async(this, null, function* () {
    try {
      const response = yield fetchWithTimeout(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
      const data = yield response.text();
      const $ = import_cheerio_without_node_native.default.load(data);
      let scriptContent = "";
      $("script").each((i, el) => {
        const html = $(el).html();
        if (html && html.includes("reurl")) {
          scriptContent = html;
        }
      });
      if (scriptContent) {
        const match = scriptContent.match(/reurl\s*=\s*["']([^"']+)["']/);
        if (match && match[1]) {
          const reurlVal = match[1];
          if (reurlVal.includes("?r=")) {
            const queryPart = reurlVal.split("?r=").pop();
            try {
              const decoded = atob(queryPart);
              const m3u8Link = decoded.substring(decoded.lastIndexOf("link=") + 5);
              if (m3u8Link && m3u8Link.startsWith("http")) {
                return [{ source: "HubCdn", quality: 1080, url: m3u8Link }];
              }
            } catch (e) {
            }
          } else if (reurlVal.includes("link=")) {
            const m3u8Link = reurlVal.split("link=").pop();
            if (m3u8Link && m3u8Link.startsWith("http")) {
              return [{ source: "HubCdn", quality: 1080, url: m3u8Link }];
            }
          } else if (reurlVal.startsWith("http")) {
            return [{ source: "HubCdn", quality: 1080, url: reurlVal }];
          }
        }
      }
      const encodedMatch = data.match(/r=([A-Za-z0-9+/=]+)/);
      if (encodedMatch && encodedMatch[1]) {
        try {
          const decoded = atob(encodedMatch[1]);
          const m3u8Link = decoded.substring(decoded.lastIndexOf("link=") + 5);
          if (m3u8Link && m3u8Link.startsWith("http")) {
            return [{ source: "HubCdn", quality: 1080, url: m3u8Link }];
          }
        } catch (e) {
        }
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}
function loadExtractor(_0) {
  return __async(this, arguments, function* (url, referer = MAIN_URL) {
    try {
      const hostname = new URL(url).hostname;
      const isRedirect = url.includes("?id=") || hostname.includes("techyboy4u") || hostname.includes("gadgetsweb.xyz") || hostname.includes("cryptoinsights.site") || hostname.includes("bloggingvector") || hostname.includes("ampproject.org");
      if (isRedirect) {
        const finalLink = yield getRedirectLinks(url);
        if (finalLink && finalLink !== url)
          return yield loadExtractor(finalLink, url);
        return [];
      }
      if (hostname.includes("hubcloud"))
        return yield hubCloudExtractor(url, referer);
      if (hostname.includes("hubcdn"))
        return yield hubCdnExtractor(url, referer);
      if (hostname.includes("hblinks") || hostname.includes("hubstream.dad"))
        return yield hbLinksExtractor(url);
      if (hostname.includes("hubstream") || hostname.includes("vidstack"))
        return yield vidStackExtractor(url);
      if (hostname.includes("pixeldrain"))
        return yield pixelDrainExtractor(url);
      if (hostname.includes("streamtape"))
        return yield streamTapeExtractor(url);
      if (hostname.includes("hdstream4u"))
        return [{ source: "HdStream4u", quality: 1080, url }];
      if (hostname.includes("hubdrive")) {
        const res = yield fetchWithTimeout(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
        const data = yield res.text();
        const href = import_cheerio_without_node_native.default.load(data)(".btn.btn-primary.btn-user.btn-success1.m-1").attr("href");
        if (href)
          return yield loadExtractor(href, url);
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}

// src/hdhub4u/index.js
function search(query) {
  return __async(this, null, function* () {
    const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const searchUrl = `https://search.hdhub4u.glass/collections/post/documents/search?q=${encodeURIComponent(query)}&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=15&highlight_fields=none&use_cache=true&page=1&analytics_tag=${today}`;
    const response = yield fetchWithTimeout(searchUrl, { headers: HEADERS });
    const data = yield response.json();
    if (!data || !data.hits)
      return [];
    return data.hits.map((hit) => {
      const doc = hit.document;
      const title = doc.post_title;
      const yearMatch = title.match(/\((\d{4})\)|\b(\d{4})\b/);
      const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2]) : null;
      let url = doc.permalink;
      if (url && url.startsWith("/")) {
        url = `${MAIN_URL}${url}`;
      }
      return {
        title,
        url,
        poster: doc.post_thumbnail,
        year
      };
    });
  });
}
function getDownloadLinks(mediaUrl) {
  return __async(this, null, function* () {
    const domain = yield getCurrentDomain();
    if (mediaUrl.includes("hdhub4u.")) {
      try {
        const urlObj = new URL(mediaUrl);
        const domainObj = new URL(domain);
        urlObj.hostname = domainObj.hostname;
        mediaUrl = urlObj.toString();
      } catch (e) {
      }
    }
    const response = yield fetchWithTimeout(mediaUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: `${domain}/` }) });
    const data = yield response.text();
    const $ = import_cheerio_without_node_native2.default.load(data);
    const typeRaw = $("h1.page-title span").text();
    const isMovie = typeRaw.toLowerCase().includes("movie");
    if (isMovie) {
      const qualityLinks = $("h3 a, h4 a").filter((i, el) => $(el).text().match(/480|720|1080|2160|4K/i));
      const bodyLinks = $(".page-body > div a").filter((i, el) => {
        const href = $(el).attr("href");
        return href && (href.includes("hdstream4u") || href.includes("hubstream"));
      });
      const initialLinks = [.../* @__PURE__ */ new Set([
        ...qualityLinks.map((i, el) => $(el).attr("href")).get(),
        ...bodyLinks.map((i, el) => $(el).attr("href")).get()
      ])];
      const results = yield Promise.all(initialLinks.map((url) => loadExtractor(url, mediaUrl)));
      const allFinalLinks = results.flat();
      const seenUrls = /* @__PURE__ */ new Set();
      const uniqueFinalLinks = allFinalLinks.filter((link) => {
        var _a;
        if (!link.url || link.url.includes(".zip") || ((_a = link.name) == null ? void 0 : _a.toLowerCase().includes(".zip")))
          return false;
        if (seenUrls.has(link.url))
          return false;
        seenUrls.add(link.url);
        return true;
      });
      return { finalLinks: uniqueFinalLinks, isMovie };
    } else {
      const episodeLinksMap = /* @__PURE__ */ new Map();
      const directLinkBlocks = [];
      $("h3, h4").each((i, element) => {
        const $el = $(element);
        const text = $el.text();
        const anchors = $el.find("a");
        const links = anchors.map((i2, a) => $(a).attr("href")).get();
        const isDirectLinkBlock = anchors.get().some((a) => $(a).text().match(/1080|720|4K|2160/i));
        if (isDirectLinkBlock) {
          directLinkBlocks.push(...links);
          return;
        }
        const episodeMatch = text.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
        if (episodeMatch) {
          const epNum = parseInt(episodeMatch[1] || episodeMatch[2]);
          if (!episodeLinksMap.has(epNum))
            episodeLinksMap.set(epNum, []);
          episodeLinksMap.get(epNum).push(...links);
          let nextElement = $el.next();
          while (nextElement.length && nextElement.get(0).tagName !== "hr") {
            const siblingLinks = nextElement.find("a[href]").map((i2, a) => $(a).attr("href")).get();
            episodeLinksMap.get(epNum).push(...siblingLinks);
            nextElement = nextElement.next();
          }
        }
      });
      if (directLinkBlocks.length > 0) {
        yield Promise.all(directLinkBlocks.map((blockUrl) => __async(this, null, function* () {
          try {
            const resolvedUrl = yield getRedirectLinks(blockUrl);
            if (!resolvedUrl)
              return;
            const blockRes = yield fetchWithTimeout(resolvedUrl, { headers: HEADERS });
            const blockData = yield blockRes.text();
            const $$ = import_cheerio_without_node_native2.default.load(blockData);
            $$("h5 a, h4 a, h3 a").each((i, el) => {
              const linkText = $$(el).text();
              const linkHref = $$(el).attr("href");
              const epMatch = linkText.match(/Episode\s*(\d+)/i);
              if (epMatch && linkHref) {
                const epNum = parseInt(epMatch[1]);
                if (!episodeLinksMap.has(epNum))
                  episodeLinksMap.set(epNum, []);
                episodeLinksMap.get(epNum).push(linkHref);
              }
            });
          } catch (e) {
          }
        })));
      }
      const initialLinks = [];
      episodeLinksMap.forEach((links, epNum) => {
        const uniqueLinks = [...new Set(links)];
        initialLinks.push(...uniqueLinks.map((link) => ({ url: link, episode: epNum })));
      });
      const results = yield Promise.all(initialLinks.map((linkInfo) => __async(this, null, function* () {
        try {
          const extracted = yield loadExtractor(linkInfo.url, mediaUrl);
          return extracted.map((ext) => __spreadProps(__spreadValues({}, ext), { episode: linkInfo.episode }));
        } catch (e) {
          return [];
        }
      })));
      const allFinalLinks = results.flat();
      const seenUrls = /* @__PURE__ */ new Set();
      const uniqueFinalLinks = allFinalLinks.filter((link) => {
        if (!link.url || link.url.includes(".zip"))
          return false;
        if (seenUrls.has(link.url))
          return false;
        seenUrls.add(link.url);
        return true;
      });
      return { finalLinks: uniqueFinalLinks, isMovie };
    }
  });
}
function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    console.log(`[HDHub4u] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    try {
      const mediaInfo = yield getTMDBDetails(tmdbId, mediaType);
      console.log(`[HDHub4u] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || "N/A"})`);
      const searchQuery = mediaType === "tv" && season ? `${mediaInfo.title} Season ${season}` : mediaInfo.title;
      const searchResults = yield search(searchQuery);
      if (searchResults.length === 0)
        return [];
      const bestMatch = findBestTitleMatch(mediaInfo, searchResults, mediaType, season);
      if (!bestMatch) {
        console.log(`[HDHub4u] No confident match for "${mediaInfo.title}" - refusing to guess from unrelated search results`);
        return [];
      }
      const selectedMedia = bestMatch;
      console.log(`[HDHub4u] Selected: "${selectedMedia.title}" (${selectedMedia.url})`);
      const result = yield getDownloadLinks(selectedMedia.url);
      const finalLinks = result.finalLinks;
      let filteredLinks = finalLinks;
      if (mediaType === "tv" && episode !== null) {
        filteredLinks = finalLinks.filter((link) => link.episode === episode);
      }
      const streams = filteredLinks.map((link) => {
        let mediaTitle = link.fileName && link.fileName !== "Unknown" ? link.fileName : mediaInfo.title;
        if (mediaType === "tv" && season && episode) {
          mediaTitle = `${mediaInfo.title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
        }
        const serverName = extractServerName(link.source);
        let qualityStr = "Unknown";
        if (typeof link.quality === "number" && link.quality > 0) {
          if (link.quality >= 2160)
            qualityStr = "4K";
          else if (link.quality >= 1080)
            qualityStr = "1080p";
          else if (link.quality >= 720)
            qualityStr = "720p";
          else if (link.quality >= 480)
            qualityStr = "480p";
        } else if (typeof link.quality === "string") {
          qualityStr = link.quality;
        }
        return {
          name: `HDHub4u ${serverName}`,
          title: mediaTitle,
          url: link.url,
          quality: qualityStr,
          size: formatBytes(link.size),
          headers: link.headers || void 0,
          provider: "hdhub4u"
        };
      });
      const qualityOrder = { "4K": 4, "1080p": 2, "720p": 1, "480p": 0, "Unknown": -2 };
      return streams.sort((a, b) => (qualityOrder[b.quality] || -3) - (qualityOrder[a.quality] || -3));
    } catch (error) {
      console.error(`[HDHub4u] Scraping error: ${error.message}`);
      return [];
    }
  });
}
  return { getStreams: getStreams };
})();

const MovieBlastSource = (function () {
/**
 * movieblast - Built from src/movieblast/
 * Generated: 2026-09-11T16:50:57.636Z
 */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/movieblast/constants.js
var BASE_URL = "https://app.cloud-mb.xyz";
var TOKEN = "jdvhhjv255vghhghdhvfch2565656jhdcghfdf";
var APP_ID = "com.movieblast";
var HEADERS = {
  "user-agent": "okhttp/5.0.0-alpha.6",
  "x-request-x": APP_ID
};
var SEARCH_HEADERS = __spreadProps(__spreadValues({}, HEADERS), {
  "hash256": "86dc03244adddb3cbedbf0ae36074a736ee293a64774b18e82a6244eafd0df30",
  "packagename": APP_ID
});
var SIGN_SECRET = "GJ8reydarI7Jqat9rvbAJKNQ9gY4DoEQF2H5nfuI1gi";
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";

// src/movieblast/utils.js
var import_crypto_js = __toESM(require("crypto-js"));
function fetchWithTimeout(url, options) {
  return fetch(url, options);
}
function generateSignedUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const path = url.pathname;
    const timestamp = Math.floor(Date.now() / 1e3).toString();
    const hash = import_crypto_js.default.HmacSHA256(path + timestamp, SIGN_SECRET);
    const signature = import_crypto_js.default.enc.Base64.stringify(hash);
    const encodedSignature = encodeURIComponent(signature);
    return `${urlStr}?verify=${timestamp}-${encodedSignature}`;
  } catch (e) {
    console.error("[MovieBlast] Error generating signed URL:", e.message);
    return urlStr;
  }
}
function matchQuality(s) {
  if (!s)
    return "Unknown";
  const v = s.toLowerCase();
  if (v.includes("2160") || v.includes("4k"))
    return "4K";
  if (v.includes("1440"))
    return "2K";
  if (v.includes("1080"))
    return "1080p";
  if (v.includes("720"))
    return "720p";
  if (v.includes("480"))
    return "480p";
  if (v.includes("360"))
    return "360p";
  return "Unknown";
}
function normalizeTitle(title) {
  if (!title)
    return "";
  return title.toLowerCase().replace(/\b(the|a|an)\b/g, "").replace(/[:\-_]/g, " ").replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}
function getTMDBDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const response = yield fetchWithTimeout(url, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok)
      throw new Error(`TMDB API error: ${response.status}`);
    const data = yield response.json();
    const title = mediaType === "tv" ? data.name : data.title;
    const releaseDate = mediaType === "tv" ? data.first_air_date : data.release_date;
    const year = releaseDate ? parseInt(releaseDate.split("-")[0]) : null;
    return { title, year };
  });
}
function calculateTitleSimilarity(title1, title2) {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);
  if (norm1 === norm2)
    return 1;
  const words1 = norm1.split(/\s+/).filter((w) => w.length > 0);
  const words2 = norm2.split(/\s+/).filter((w) => w.length > 0);
  if (words1.length === 0 || words2.length === 0)
    return 0;
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = words1.filter((w) => set2.has(w));
  const union = /* @__PURE__ */ new Set([...words1, ...words2]);
  return intersection.length / union.size;
}
function findBestMatch(mediaInfo, searchResults) {
  if (!searchResults || searchResults.length === 0)
    return null;
  let bestMatch = null;
  let bestScore = 0;
  for (const result of searchResults) {
    let score = calculateTitleSimilarity(mediaInfo.title, result.name);
    if (mediaInfo.year && result.release_date) {
      const resultYear = parseInt(result.release_date.split("-")[0]);
      if (mediaInfo.year === resultYear)
        score += 0.2;
    }
    if (score > bestScore && score > 0.4) {
      bestScore = score;
      bestMatch = result;
    }
  }
  return bestMatch;
}

// src/movieblast/index.js
function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    console.log(`[MovieBlast] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    try {
      const mediaInfo = yield getTMDBDetails(tmdbId, mediaType);
      console.log(`[MovieBlast] Searching for: "${mediaInfo.title}" (${mediaInfo.year})`);
      const safeQuery = encodeURIComponent(mediaInfo.title);
      const searchUrl = `${BASE_URL}/api/search/${safeQuery}/${TOKEN}`;
      const searchRes = yield fetchWithTimeout(searchUrl, { headers: SEARCH_HEADERS });
      if (!searchRes.ok) {
        console.error(`[MovieBlast] Search failed with status: ${searchRes.status}`);
        return [];
      }
      const searchData = yield searchRes.json();
      const searchResults = searchData.search || [];
      const match = findBestMatch(mediaInfo, searchResults);
      if (!match) {
        console.log("[MovieBlast] No confident matches found in MovieBlast.");
        return [];
      }
      const internalId = match.id;
      const isSeries = match.type.toLowerCase().includes("serie") || mediaType === "tv";
      console.log(`[MovieBlast] Match Found: "${match.name}" (ID: ${internalId})`);
      const detailPath = isSeries ? "series/show" : "media/detail";
      const detailUrl = `${BASE_URL}/api/${detailPath}/${internalId}/${TOKEN}`;
      const detailRes = yield fetchWithTimeout(detailUrl, { headers: HEADERS });
      if (!detailRes.ok) {
        console.error(`[MovieBlast] Detail fetch failed: ${detailRes.status}`);
        return [];
      }
      const detailData = yield detailRes.json();
      let targetVideos = [];
      if (isSeries) {
        const seasons = detailData.seasons || [];
        const targetSeason = seasons.find((s) => s.season_number == season);
        if (targetSeason) {
          const targetEpisode = (targetSeason.episodes || []).find((e) => e.episode_number == episode);
          if (targetEpisode) {
            targetVideos = targetEpisode.videos || [];
          } else {
            console.log(`[MovieBlast] Episode ${episode} not found in Season ${season}.`);
          }
        } else {
          console.log(`[MovieBlast] Season ${season} not found.`);
        }
      } else {
        targetVideos = detailData.videos || [];
      }
      if (targetVideos.length === 0) {
        console.log("[MovieBlast] No video links found in details.");
        return [];
      }
      const streams = targetVideos.map((vid) => {
        const rawUrl = vid.link;
        if (!rawUrl)
          return null;
        const httpsUrl = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
        const signedUrl = generateSignedUrl(httpsUrl);
        return {
          name: "MovieBlast",
          title: `MovieBlast - ${vid.server} (${vid.lang || "EN"})`,
          url: signedUrl,
          quality: matchQuality(vid.server),
          headers: {
            "Accept-Encoding": "identity",
            "Connection": "Keep-Alive",
            "Icy-MetaData": "1",
            "Referer": "MovieBlast",
            "User-Agent": "MovieBlast",
            "x-request-x": "com.movieblast"
          },
          provider: "movieblast"
        };
      }).filter((s) => s !== null);
      console.log(`[MovieBlast] Successfully found ${streams.length} streams.`);
      return streams;
    } catch (error) {
      console.error(`[MovieBlast] Error: ${error.message}`);
      return [];
    }
  });
}
  return { getStreams: getStreams };
})();

const AnimeDekhoSource = (function () {
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/utils/extractors.js
var require_extractors = __commonJS({
  "src/utils/extractors.js"(exports2, module2) {
    var cheerio2 = require("cheerio-without-node-native");
    function unpack(packed) {
      const regex = new RegExp('eval\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*d\\s*\\).*?return\\s+p\\s*}\\s*\\(\\s*\\"(.*?)\\"\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*\\"(.*?)\\"\\.split\\(\\"\\|\\"\\)', "s");
      let match = packed.match(regex);
      if (!match) {
        const regexSq = new RegExp("eval\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*d\\s*\\).*?return\\s+p\\s*}\\s*\\(\\s*\\'(.*?)\\'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*\\'(.*?)\\'\\.split\\(\\'\\|\\'\\)", "s");
        match = packed.match(regexSq);
      }
      if (!match)
        return null;
      let p = match[1];
      const a = parseInt(match[2], 10);
      let c = parseInt(match[3], 10);
      const k = match[4].split("|");
      function e(c2) {
        return (c2 < a ? "" : e(Math.floor(c2 / a))) + (c2 % a > 35 ? String.fromCharCode(c2 % a + 29) : (c2 % a).toString(36));
      }
      while (c--) {
        if (k[c]) {
          const pattern = new RegExp("\\b" + e(c) + "\\b", "g");
          p = p.replace(pattern, k[c]);
        }
      }
      return p;
    }
    function extractVidmoly(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const m = html.match(/file:\s*["'](.*?m3u8.*?)["']/);
          if (m)
            return { url: m[1], quality: "Unknown", source: "Vidmoly" };
        } catch (e) {
        }
        return null;
      });
    }
    function extractFilemoon(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const unpacked = unpack(html);
          if (unpacked) {
            const m = unpacked.match(/file:\s*["'](.*?m3u8.*?)["']/);
            if (m)
              return { url: m[1], quality: "Unknown", source: "Filemoon" };
          }
        } catch (e) {
        }
        return null;
      });
    }
    function extractStreamhide(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const unpacked = unpack(html);
          if (unpacked) {
            const m = unpacked.match(/sources:\s*\[\s*{\s*file:\s*["'](.*?m3u8.*?)["']/);
            if (m)
              return { url: m[1], quality: "Unknown", source: "Streamhide" };
          }
        } catch (e) {
        }
        return null;
      });
    }
    function extractVoe(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url);
          const html = yield res.text();
          const m = html.match(/hls':\s*'(.*?)'/);
          if (m)
            return { url: m[1], quality: "Unknown", source: "Voe" };
        } catch (e) {
        }
        return null;
      });
    }
    function extract2(url) {
      return __async(this, null, function* () {
        if (!url)
          return null;
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes("vidmoly")) {
          return yield extractVidmoly(url);
        } else if (lowerUrl.includes("filemoon") || lowerUrl.includes("abyssplayer") || lowerUrl.includes("rubystm")) {
          return yield extractFilemoon(url);
        } else if (lowerUrl.includes("streamhide") || lowerUrl.includes("cloudy.upns") || lowerUrl.includes("gdmirrorbot") || lowerUrl.includes("emturbovid")) {
          return yield extractStreamhide(url);
        } else if (lowerUrl.includes("voe.sx") || lowerUrl.includes("voe.network")) {
          return yield extractVoe(url);
        }
        return null;
      });
    }
    module2.exports = { extract: extract2 };
  }
});

// src/providers/anime-dekho.js
var cheerio = require("cheerio-without-node-native");
var BASE_URL = "https://animedekho.app";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Referer": `${BASE_URL}/`
};
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
      const mediaInfo = yield (yield fetch(tmdbUrl, { skipSizeCheck: true })).json();
      const title = mediaInfo.title || mediaInfo.name;
      if (!title)
        return [];
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(title)}`;
      const searchHtml = yield (yield fetch(searchUrl, { headers: HEADERS, skipSizeCheck: true })).text();
      const $ = cheerio.load(searchHtml);
      let itemUrl = null;
      $("ul[data-results] li article").each((_, el) => {
        if (!itemUrl) {
          const href = $(el).find("a.lnk-blk").attr("href");
          if (href)
            itemUrl = href;
        }
      });
      if (!itemUrl) {
        $("article").each((_, el) => {
          if (!itemUrl) {
            const href = $(el).find("a.lnk-blk").attr("href");
            if (href)
              itemUrl = href;
          }
        });
      }
      if (!itemUrl)
        return [];
      const animePage = yield (yield fetch(itemUrl, { headers: HEADERS, skipSizeCheck: true })).text();
      const $2 = cheerio.load(animePage);
      const bodyClass = $2("body").attr("class") || "";
      const termMatch = bodyClass.match(/(?:term|postid)-(\d+)/);
      const term = termMatch?.[1];
      if (!term)
        return [];
      const seasonItems = $2("ul.seasons-lst li");
      let targetUrl = itemUrl;
      let mediaType2 = 1;
      if (seasonItems.length > 0) {
        mediaType2 = 2;
        seasonItems.each((_, el) => {
          const seasonNum = $2(el).find("h3.title > span").text().match(/S(\d+)/)?.[1];
          const href = $2(el).find("a").attr("href");
          if (href && parseInt(seasonNum) === (season || 1)) {
            targetUrl = href;
          }
        });
      }
      const targetPage = yield (yield fetch(targetUrl, { headers: HEADERS, skipSizeCheck: true })).text();
      const $3 = cheerio.load(targetPage);
      const targetBodyClass = $3("body").attr("class") || "";
      const targetTermMatch = targetBodyClass.match(/(?:term|postid)-(\d+)/);
      const targetTerm = targetTermMatch?.[1] || term;
      const epNum = episode || 1;
      // The 11 track indices are independent lookups (each just asks "does
      // track i exist for this title"), so probing them one at a time was
      // paying their full round-trip latency 11 times over for no reason -
      // running them in parallel cuts this from ~11x that latency to ~1x.
      const iframeUrls = yield Promise.all(
        Array.from({ length: 11 }, (_, i) => {
          const iframePageUrl = `${BASE_URL}/?trdekho=${i}&trid=${targetTerm}&trtype=${mediaType2}`;
          return fetch(iframePageUrl, { headers: HEADERS, skipSizeCheck: true })
            .then(res => res.text())
            .then(html => {
              const $4 = cheerio.load(html);
              const iframeSrc = $4("iframe").attr("src");
              return (iframeSrc && iframeSrc.startsWith("http")) ? iframeSrc : null;
            })
            .catch(() => null);
        })
      );
      const streams = iframeUrls.filter(Boolean).map(iframeSrc => ({
        url: iframeSrc,
        quality: "Unknown",
        title: `AnimeDekho [S${season || 1}E${epNum}]`,
        subtitles: []
      }));
      return streams;
    } catch (e) {
      console.error("[AnimeDekho]", e);
      return [];
    }
  });
}
var { extract } = require_extractors();
function wrappedGetStreams(...args) {
  return __async(this, null, function* () {
    const streams = yield getStreams(...args);
    // Each candidate's extraction is independent of the others (a different
    // embed host per candidate - abyssplayer, rubystm, cloudy, vidmoly,
    // emturbovid, ...), but this used to await them one at a time, so the
    // total wait was the SUM of every host's latency instead of just the
    // slowest one. Running them in parallel preserves the original filtering
    // logic and result order exactly, just without the serial wait.
    const extracted = yield Promise.all(streams.map(s => {
      if (!s.url) return Promise.resolve(null);
      return Promise.resolve(extract(s.url)).then(ext => {
        if (ext) {
          return Object.assign({}, s, {
            url: ext.url,
            quality: ext.quality !== "Unknown" ? ext.quality : s.quality,
            name: "AnimeDekho",
            provider: "anime-dekho",
            headers: HEADERS
          });
        }
        if (s.url.includes(".mp4") || s.url.includes(".m3u8") || s.url.includes(".mkv") || s.url.includes(".avi") || s.url.startsWith("magnet:") || s.url.includes("/api/file/") || s.url.includes(".cloudflarestorage.com")) {
          return Object.assign({}, s, { name: "AnimeDekho", provider: "anime-dekho", headers: HEADERS });
        }
        return null;
      }).catch(() => null);
    }));
    return extracted.filter(Boolean);
  });
}
  return { getStreams: wrappedGetStreams };
})();

const KickassAnimeSource = (function () {
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/utils/extractors.js
var require_extractors = __commonJS({
  "src/utils/extractors.js"(exports2, module2) {
    var cheerio = require("cheerio-without-node-native");
    function unpack(packed) {
      const regex = new RegExp('eval\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*d\\s*\\).*?return\\s+p\\s*}\\s*\\(\\s*\\"(.*?)\\"\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*\\"(.*?)\\"\\.split\\(\\"\\|\\"\\)', "s");
      let match = packed.match(regex);
      if (!match) {
        const regexSq = new RegExp("eval\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*d\\s*\\).*?return\\s+p\\s*}\\s*\\(\\s*\\'(.*?)\\'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*\\'(.*?)\\'\\.split\\(\\'\\|\\'\\)", "s");
        match = packed.match(regexSq);
      }
      if (!match)
        return null;
      let p = match[1];
      const a = parseInt(match[2], 10);
      let c = parseInt(match[3], 10);
      const k = match[4].split("|");
      function e(c2) {
        return (c2 < a ? "" : e(Math.floor(c2 / a))) + (c2 % a > 35 ? String.fromCharCode(c2 % a + 29) : (c2 % a).toString(36));
      }
      while (c--) {
        if (k[c]) {
          const pattern = new RegExp("\\b" + e(c) + "\\b", "g");
          p = p.replace(pattern, k[c]);
        }
      }
      return p;
    }
    function extractVidmoly(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const m = html.match(/file:\s*["'](.*?m3u8.*?)["']/);
          if (m)
            return { url: m[1], quality: "Unknown", source: "Vidmoly" };
        } catch (e) {
        }
        return null;
      });
    }
    function extractFilemoon(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const unpacked = unpack(html);
          if (unpacked) {
            const m = unpacked.match(/file:\s*["'](.*?m3u8.*?)["']/);
            if (m)
              return { url: m[1], quality: "Unknown", source: "Filemoon" };
          }
        } catch (e) {
        }
        return null;
      });
    }
    function extractStreamhide(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const unpacked = unpack(html);
          if (unpacked) {
            const m = unpacked.match(/sources:\s*\[\s*{\s*file:\s*["'](.*?m3u8.*?)["']/);
            if (m)
              return { url: m[1], quality: "Unknown", source: "Streamhide" };
          }
        } catch (e) {
        }
        return null;
      });
    }
    function extractVoe(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url);
          const html = yield res.text();
          const m = html.match(/hls':\s*'(.*?)'/);
          if (m)
            return { url: m[1], quality: "Unknown", source: "Voe" };
        } catch (e) {
        }
        return null;
      });
    }
    function extract2(url) {
      return __async(this, null, function* () {
        if (!url)
          return null;
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes("vidmoly")) {
          return yield extractVidmoly(url);
        } else if (lowerUrl.includes("filemoon") || lowerUrl.includes("abyssplayer") || lowerUrl.includes("rubystm")) {
          return yield extractFilemoon(url);
        } else if (lowerUrl.includes("streamhide") || lowerUrl.includes("cloudy.upns") || lowerUrl.includes("gdmirrorbot") || lowerUrl.includes("emturbovid")) {
          return yield extractStreamhide(url);
        } else if (lowerUrl.includes("voe.sx") || lowerUrl.includes("voe.network")) {
          return yield extractVoe(url);
        }
        return null;
      });
    }
    module2.exports = { extract: extract2 };
  }
});

// src/providers/kickassanime.js
var BASE_URL = "https://kaa.lt";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Content-Type": "application/json",
  "x-origin": "kickass-anime.ru"
};
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
      const mediaInfo = yield (yield fetch(tmdbUrl, { skipSizeCheck: true })).json();
      const title = mediaInfo.title || mediaInfo.name;
      if (!title)
        return [];
      const searchBody = JSON.stringify({ page: "1", query: title });
      const searchResp = yield fetch(`${BASE_URL}/api/fsearch`, {
        method: "POST",
        headers: HEADERS,
        body: searchBody,
        skipSizeCheck: true
      });
      const searchData = yield searchResp.json();
      if (!searchData || !searchData.result || searchData.result.length === 0)
        return [];
      const match = searchData.result.find(
        (r) => (r.title_en || r.title || "").toLowerCase().includes(title.toLowerCase())
      ) || searchData.result[0];
      if (!match)
        return [];
      const showSlug = match.slug || match.watch_uri;
      if (!showSlug)
        return [];
      const showName = showSlug.startsWith("/") ? showSlug : `/${showSlug}`;
      const episodesUrl = `${BASE_URL}/api/show${showName}/episodes?ep=1&lang=ja-JP`;
      const epsResp = yield fetch(episodesUrl, { headers: HEADERS, skipSizeCheck: true });
      const epsData = yield epsResp.json();
      const episodes = epsData && epsData.result ? epsData.result : [];
      let targetEpisode = null;
      if (mediaType === "tv" && episode) {
        targetEpisode = episodes.find((e) => {
          const epNum2 = Math.floor(parseFloat(e.episode_number || 0));
          return epNum2 === parseInt(episode);
        });
      } else if (mediaType === "movie") {
        targetEpisode = episodes[0];
      } else {
        targetEpisode = episodes[0];
      }
      if (!targetEpisode)
        return [];
      const epNum = Math.floor(parseFloat(targetEpisode.episode_number || 1));
      const epSlug = targetEpisode.slug;
      const episodeUrl = `${BASE_URL}/api/show${showName}/episode/ep-${epNum}-${epSlug}`;
      const serversResp = yield fetch(episodeUrl, { headers: HEADERS, skipSizeCheck: true });
      const serversData = yield serversResp.json();
      if (!serversData || !serversData.servers)
        return [];
      const streams = [];
      for (const server of serversData.servers) {
        if (!server.src)
          continue;
        if (server.name && (server.name.includes("VidStreaming") || server.name.includes("CatStream") || server.name.includes("BirdStream"))) {
          try {
            const serverHost = new URL(server.src).origin;
            const serverHeaders = {
              "Origin": serverHost,
              "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            };
            const pageResp = yield fetch(server.src, { headers: serverHeaders, skipSizeCheck: true });
            const pageText = yield pageResp.text();
            const m3u8Match = pageText.match(/(https?:)?\/\/[^\s"'<>]+\.m3u8/i);
            if (m3u8Match) {
              const m3u8Url = m3u8Match[0].startsWith("//") ? "https:" + m3u8Match[0] : m3u8Match[0];
              streams.push({
                name: "KickassAnime",
                url: m3u8Url,
                quality: "1080p",
                title: `KickassAnime ${server.name}`,
                headers: { "Origin": "https://kaa.lt", "Referer": "https://kaa.lt/", "User-Agent": serverHeaders["User-Agent"] },
                subtitles: [],
                provider: "kickassanime"
              });
              continue;
            }
            const propsMatch = pageText.match(/props="([^"]+)"/);
            if (propsMatch) {
              const unescaped = propsMatch[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
              const json = JSON.parse(unescaped);
              const manifests = json.manifest;
              if (manifests && manifests[1]) {
                const videoUrl = "https:" + manifests[1];
                const subtitles = [];
                if (json.subtitles && json.subtitles[1]) {
                  for (const sub of json.subtitles[1]) {
                    if (sub && sub[1]) {
                      const src = sub[1].src && sub[1].src[1];
                      const name = sub[1].name && sub[1].name[1];
                      if (src)
                        subtitles.push({ url: src, lang: name || "Unknown" });
                    }
                  }
                }
                streams.push({
                  name: "KickassAnime",
                  url: videoUrl,
                  quality: "1080p",
                  title: `KickassAnime ${server.name}`,
                  headers: { "Origin": "https://kaa.lt", "Referer": "https://kaa.lt/", "User-Agent": serverHeaders["User-Agent"] },
                  subtitles,
                  provider: "kickassanime"
                });
              }
            }
          } catch (e) {
          }
        }
      }
      return streams;
    } catch (e) {
      console.error("[KickassAnime]", e);
      return [];
    }
  });
}
var { extract } = require_extractors();
function wrappedGetStreams(...args) {
  return __async(this, null, function* () {
    const streams = yield getStreams(...args);
    const finalStreams = [];
    for (const s of streams) {
      if (!s.url)
        continue;
      const ext = yield extract(s.url);
      if (ext) {
        s.url = ext.url;
        if (ext.quality !== "Unknown")
          s.quality = ext.quality;
        finalStreams.push(s);
      } else if (s.url.includes(".mp4") || s.url.includes(".m3u8") || s.url.includes(".mkv") || s.url.includes(".avi") || s.url.startsWith("magnet:") || s.url.includes("/api/file/") || s.url.includes(".cloudflarestorage.com")) {
        finalStreams.push(s);
      }
    }
    return finalStreams;
  });
}
  return { getStreams: wrappedGetStreams };
})();

const VegaMoviesSource = (function () {
// VegaMovies scraper for Nuvio Local Scrapers
//
// Ported from the open-source CloudStream extension (SaurabhKaperwan/CSX,
// VegaMovies/src/main/kotlin/com/megix/VegaMoviesProvider.kt + Extractors.kt -
// real Kotlin source, no decompilation needed this time) with one deliberate
// change: the original's primary resolver, "V-Cloud" (vcloud.fit), is now
// behind a real Cloudflare managed challenge ("Just a moment...") - verified
// directly, not assumed - which no plain HTTP client can solve without a
// browser executing JS. This scraper instead uses the same download page's
// "G-Direct [Instant]" button, which isn't Cloudflare-protected: its embed
// page contains a plain `var reurl = "https://fastdl.zip/dl.php?link=<real
// googleusercontent.com URL>"` in static HTML, no JS execution required to
// read it. Verified end-to-end: HEAD on the extracted URL returns a real
// video/mkv file. "Filepress" is also Cloudflare-gated; "DropGalaxy" needs a
// JS-execution-proof redirect dance that isn't worth chasing when G-Direct
// already works cleanly.
//
//   current domain -> https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json ["vegamovies"]
//   search         -> GET {baseUrl}/search.php?q={query}&page=1  (Typesense-style JSON, no auth)
//   movie page     -> one "Download Now" button per quality, each leading to a
//                     nexdrive.fit-style hub page with a "G-Direct" link
//   series page    -> one "Episode Links" hub per (season, quality) pair; that
//                     hub lists one "G-Direct" link per episode, in order, so
//                     the Nth G-Direct link is episode N for that quality

const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_CONFIG_URL = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
const DEFAULT_BASE_URL = 'https://vegamovies.mq';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedBaseUrl = null;
let cachedBaseUrlAt = 0;
const BASE_URL_CACHE_TTL = 1000 * 60 * 30;

function getBaseUrl() {
  if (cachedBaseUrl && Date.now() - cachedBaseUrlAt < BASE_URL_CACHE_TTL) {
    return Promise.resolve(cachedBaseUrl);
  }
  return fetch(DOMAINS_CONFIG_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(cfg => {
      const url = (cfg && cfg.vegamovies) ? cfg.vegamovies.replace(/\/+$/, '') : DEFAULT_BASE_URL;
      cachedBaseUrl = url;
      cachedBaseUrlAt = Date.now();
      console.log(`[VegaMovies] Using domain: ${url}`);
      return url;
    })
    .catch(() => DEFAULT_BASE_URL);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  return fetch(url, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      const imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || null;
      console.log(`[VegaMovies] TMDB Info: "${title}" (${year}) imdb=${imdbId || 'none'}`);
      return { title, year, imdbId };
    })
    .catch(() => ({ title: '', year: '', imdbId: null }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Prefers an exact IMDb id match (the search index carries one per hit) since
// that's unambiguous; falls back to word-overlap scoring against the title
// (and a bonus for the release year appearing in the post title) when the
// site's own imdb_id field is missing for a given hit.
function findBestMatch(hits, mediaInfo) {
  if (!hits.length) return null;
  if (mediaInfo.imdbId) {
    const exact = hits.find(h => h.document.imdb_id === mediaInfo.imdbId);
    if (exact) return exact.document;
  }
  const targetWords = new Set(normalize(mediaInfo.title).split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const hit of hits) {
    const doc = hit.document;
    const titleWords = normalize(doc.post_title).split(' ').filter(Boolean);
    const overlap = titleWords.filter(w => targetWords.has(w)).length;
    let score = targetWords.size ? overlap / targetWords.size : 0;
    if (mediaInfo.year && doc.post_title.includes(mediaInfo.year)) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = doc;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function getIndexQuality(str) {
  if (!str) return 'Unknown';
  const m = String(str).match(/(\d{3,4})\s*[pP]/);
  if (m) return `${m[1]}p`;
  const lower = str.toLowerCase();
  if (lower.includes('8k')) return '8K';
  if (lower.includes('4k') || lower.includes('2160')) return '4K';
  return 'Unknown';
}

function getSizeLabel(str) {
  const m = String(str || '').match(/([\d.]+\s*(?:GB|MB|TB))/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

// The G-Direct embed page is a plain "redirecting..." shell containing
// `var reurl = "https://fastdl.zip/dl.php?link=<real file URL>"` in static
// HTML - no JS execution needed, just read the value straight out of the
// page text. The rest of that page is browser/ad-blocker detection noise
// unrelated to the redirect itself.
function extractGDirectFinalUrl(embedUrl) {
  return fetch(embedUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const m = html.match(/var\s+reurl\s*=\s*"([^"]+)"/);
      if (!m) return null;
      const reurl = m[1];
      const linkMatch = reurl.match(/[?&]link=(.+)$/);
      return linkMatch ? linkMatch[1] : reurl;
    })
    .catch(() => null);
}

function findLinkByText($, root, pattern) {
  let href = null;
  root.find('a').each((i, el) => {
    if (href) return;
    if (pattern.test($(el).text())) href = $(el).attr('href');
  });
  return href;
}

// A hub page (reached via a movie's "Download Now" button, or one entry in a
// series' "Episode Links" list) offers several resolvers (G-Direct, V-Cloud,
// Filepress, DropGalaxy, ...) for the same file - only G-Direct is usable
// here (see file header), so that's the only one this looks for.
function resolveHubToUrl(hubUrl) {
  return fetch(hubUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const gdirect = findLinkByText($, $.root(), /G-Direct/i);
      if (!gdirect) return null;
      return extractGDirectFinalUrl(gdirect);
    })
    .catch(() => null);
}

function isSeriesPage($) {
  return $('h3, h5').filter((i, el) => /Series[\s-]*SYNOPSIS\/PLOT|Series Info/i.test($(el).text())).length > 0;
}

function extractMovieTargets($) {
  const targets = [];
  $('main h3, main h5').each((i, el) => {
    const text = $(el).text().trim();
    if (!/\d{3,4}\s*[pP]|4K/i.test(text)) return;
    const hubUrl = findLinkByText($, $(el).next(), /Download Now/i) || findLinkByText($, $(el).next(), /.+/);
    if (hubUrl) targets.push({ qualityText: text, hubUrl });
  });
  return targets;
}

function extractSeriesTargets($, season) {
  const targets = [];
  $('main h3, main h5').each((i, el) => {
    const text = $(el).text().trim();
    const seasonMatch = text.match(/Season\s*(\d+)/i);
    if (!seasonMatch || parseInt(seasonMatch[1], 10) !== season) return;
    if (!/\d{3,4}\s*[pP]|4K/i.test(text)) return;
    const listUrl = findLinkByText($, $(el).next(), /Episode Links/i);
    if (listUrl) targets.push({ qualityText: text, listUrl });
  });
  return targets;
}

function buildStream(url, qualityText, label) {
  return {
    name: 'VegaMovies',
    title: label,
    url,
    quality: getIndexQuality(qualityText),
    size: getSizeLabel(qualityText),
    type: 'direct',
    headers: HEADERS,
    provider: 'vegamovies'
  };
}

function validateStreamUrl(stream) {
  return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => fetch(stream.url, { method: 'GET', headers: Object.assign({}, stream.headers, { Range: 'bytes=0-2048' }) })
      .then(res => res.ok || res.status === 206)
      .catch(() => false));
}

function getMoviePageStreams($, label) {
  const targets = extractMovieTargets($);
  return Promise.all(targets.map(t =>
    resolveHubToUrl(t.hubUrl).then(url => url ? buildStream(url, t.qualityText, label) : null)
  )).then(streams => streams.filter(Boolean));
}

function getSeriesPageStreams($, season, episode, label) {
  const targets = extractSeriesTargets($, season);
  return Promise.all(targets.map(t =>
    fetch(t.listUrl, { headers: HEADERS })
      .then(res => res.text())
      .then(html => {
        const $$ = cheerio.load(html);
        const gdirectLinks = [];
        $$('a').each((i, el) => {
          if (/G-Direct/i.test($$(el).text())) gdirectLinks.push($$(el).attr('href'));
        });
        const episodeUrl = gdirectLinks[episode - 1];
        if (!episodeUrl) return null;
        return extractGDirectFinalUrl(episodeUrl).then(url => url ? buildStream(url, t.qualityText, `${label} S${season}E${episode}`) : null);
      })
      .catch(() => null)
  )).then(streams => streams.filter(Boolean));
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[VegaMovies] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[VegaMovies] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getBaseUrl(), getTmdbInfo(tmdbId, mediaType)]).then(([baseUrl, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return fetch(`${baseUrl}/search.php?q=${encodeURIComponent(mediaInfo.title)}&page=1`, { headers: HEADERS })
      .then(res => res.json())
      .then(data => {
        const hits = Array.isArray(data.hits) ? data.hits : [];
        const match = findBestMatch(hits, mediaInfo);
        if (!match) {
          console.log('[VegaMovies] No matching title found');
          return [];
        }
        console.log(`[VegaMovies] Matched: "${match.post_title}"`);
        const pageUrl = new URL(match.permalink, baseUrl).toString();
        return fetch(pageUrl, { headers: HEADERS })
          .then(res => res.text())
          .then(html => {
            const $ = cheerio.load(html);
            return mediaType === 'tv'
              ? getSeriesPageStreams($, season, episode, label)
              : getMoviePageStreams($, label);
          });
      })
      .then(streams => {
        console.log(`[VegaMovies] Found ${streams.length} stream(s), validating...`);
        return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
          const valid = validated.filter(v => v.ok).map(v => v.stream);
          const dead = validated.filter(v => !v.ok).map(v => v.stream.name + ' ' + v.stream.quality);
          if (dead.length) console.log(`[VegaMovies] Dropping unreachable: ${dead.join(', ')}`);
          console.log(`[VegaMovies] ${valid.length}/${streams.length} stream(s) validated OK`);
          return valid;
        });
      });
  }).catch(err => {
    console.log(`[VegaMovies] getStreams failed: ${err.message}`);
    return [];
  });
}
  return { getStreams: getStreams };
})();

const AllMovieLandSource = (function () {
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
  return { getStreams: getStreams };
})();

const SOURCES = [
  { id: 'peachify', name: 'Peachify', mod: PeachifySource },
  { id: 'vidrock', name: 'Vidrock', mod: VidrockSource },
  { id: 'moviebox', name: 'MovieBox', mod: MovieBoxSource },
  { id: 'rivestream', name: 'RiveStream', mod: RiveStreamSource },
  { id: '4khdhub', name: '4KHDHub', mod: FourKHdHubSource },
  { id: 'uhdmovies', name: 'UHDMovies', mod: UhdMoviesSource },
  { id: 'netmirror', name: 'NetMirror', mod: NetMirrorSource },
  { id: 'vixsrc', name: 'Vixsrc', mod: VixSrcSource },
  { id: 'vidlink', name: 'Vidlink', mod: VidLinkSource },
  { id: 'castle', name: 'Castle', mod: CastleSource },
  { id: 'hdhub4u', name: 'HDHub4u', mod: HdHub4uSource },
  { id: 'movieblast', name: 'MovieBlast', mod: MovieBlastSource },
  { id: 'anime-dekho', name: 'AnimeDekho', mod: AnimeDekhoSource },
  { id: 'kickassanime', name: 'KickassAnime', mod: KickassAnimeSource },
  { id: 'vegamovies', name: 'VegaMovies', mod: VegaMoviesSource },
  { id: 'allmovieland', name: 'AllMovieLand', mod: AllMovieLandSource },
];

// ---- Ranking logic, ported verbatim from this repo's server.js aggregator ----

const MAX_SIZE_GB = 30;

// Parses size strings like "40.16 GB", "700 MB", "1.2 TB" into GB.
function parseSizeToGB(sizeStr) {
  if (!sizeStr) return null;
  const m = String(sizeStr).match(/([\d.]+)\s*(TB|GB|MB)/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'TB') return value * 1024;
  if (unit === 'MB') return value / 1024;
  return value;
}

// Not every source puts the size in its own field - some (e.g. 4KHDHub)
// only embed it as trailing text in `title` (".mkv\n40.16 GB"). Check the
// dedicated field first, then fall back to scanning the title, so the size
// cap isn't silently skipped for those. Returns null when there's genuinely
// no size info anywhere, so streams we can't judge are never filtered out.
function getStreamSizeGB(stream) {
  const fromField = parseSizeToGB(stream.size);
  if (fromField !== null) return fromField;
  return parseSizeToGB(stream.title);
}

// Series: rank everything by resolution, don't hide anything.
function seriesTier(quality) {
  const q = (quality || '').toString().toLowerCase();
  if (q.includes('1080')) return 0;
  if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) return 1;
  if (q.includes('720')) return 2;
  if (q.includes('480')) return 3;
  return 4;
}

// Movies: only 4K and 1080p are acceptable - anything else (720p, 480p,
// "Auto", "Unknown", ...) is hidden entirely, not just deprioritized.
function movieTier(quality) {
  const q = (quality || '').toString().toLowerCase();
  if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) return 0;
  if (q.includes('1080')) return 1;
  return null;
}

// Castle's streams have proven unreliable enough in practice that they
// should never be the featured [PREFERRED] pick, even when they happen to
// report the best quality tier - any other source beats a Castle stream
// regardless of tier. It's still allowed to win if it's genuinely the only
// stream available at all, since a Castle pick beats no pick.
function preferredRank(stream, tierFn) {
  return [stream.source === 'castle' ? 1 : 0, tierFn(stream.quality)];
}

function rankIsBetter(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  return a[1] < b[1];
}

// Drops anything over MAX_SIZE_GB, hides sub-1080p results for movies, then
// tags the best remaining stream by resolution tier as [PREFERRED] and moves
// it to the front - the rest of the (filtered) list is left untouched.
function applyPreferredLogic(streams, mediaType) {
  let filtered = streams.filter(s => {
    const gb = getStreamSizeGB(s);
    return gb === null || gb <= MAX_SIZE_GB;
  });

  const tierFn = mediaType === 'tv' ? seriesTier : movieTier;
  if (mediaType !== 'tv') {
    filtered = filtered.filter(s => tierFn(s.quality) !== null);
  }

  if (filtered.length === 0) return filtered;

  let best = filtered[0];
  let bestRank = preferredRank(best, tierFn);
  for (const s of filtered) {
    const r = preferredRank(s, tierFn);
    if (rankIsBetter(r, bestRank)) {
      best = s;
      bestRank = r;
    }
  }

  const tagged = Object.assign({}, best, {
    name: `[PREFERRED] ${best.name || best.source}`.trim(),
    isPreferred: true
  });
  const rest = filtered.filter(s => s !== best);
  return [tagged, ...rest];
}

// ---- Combining ----
//
// Nuvio's sandbox has no timer of any kind - no setTimeout, no setInterval
// (confirmed by reading Nuvio's own PluginRuntime.kt: the only injected
// globals are console, the fetch bridge, __parse_url and the cheerio
// helpers). A JS-level setTimeout-based cutoff isn't just unavailable, it's
// actively dangerous here - this exact repo shipped setTimeout-based
// timeouts in every provider earlier on, and since the function doesn't
// exist in this sandbox every call threw a ReferenceError that got silently
// swallowed, so every single provider returned empty. So a real wall-clock
// deadline can't be built from a timer that doesn't exist.
//
// The only primitive available that reliably takes a real amount of time is
// a network round trip, so the "stop waiting after N seconds" cutoff is
// approximated by racing every source against a fetch() to a public delay
// endpoint that resolves after COMBINE_TIMEOUT_SECONDS. This is inherently
// approximate (N seconds plus however long that request itself takes to
// reach the endpoint and back) rather than exact. If the delay endpoint is
// ever unreachable there's no way to tell whether 0 seconds or the full N
// have actually passed, so the safe fallback in that case is to not cut
// anything off at all and just wait for every source to finish normally.
//
// httpbin.org's own /delay/N endpoint silently clamps N to a maximum of 10
// seconds server-side (confirmed by measuring it directly: requesting
// delay/15 actually returns in ~10.5s) - so reaching a true ~15s requires
// chaining two capped calls (10s then 5s) rather than one delay/15 request.
const COMBINE_TIMEOUT_SECONDS = 15;
const HTTPBIN_MAX_DELAY_SECONDS = 10;

function buildTimeoutGuard(totalSeconds) {
  let remaining = totalSeconds;
  let chain = Promise.resolve();
  while (remaining > 0) {
    const chunk = Math.min(remaining, HTTPBIN_MAX_DELAY_SECONDS);
    chain = chain.then(() => fetch(`https://httpbin.org/delay/${chunk}`));
    remaining -= chunk;
  }
  return chain.then(() => 'TIMED_OUT').catch(() => 'GUARD_UNAVAILABLE');
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  console.log(`[AllSources] getStreams start tmdbId=${tmdbId} type=${type} S=${season || ''} E=${episode || ''}`);

  const collected = [];
  const sourceRuns = SOURCES.map(src => {
    return Promise.resolve()
      .then(() => src.mod.getStreams(tmdbId, type, season, episode))
      .then(streams => {
        const list = Array.isArray(streams) ? streams : [];
        if (list.length) {
          console.log(`[AllSources] ${src.name}: ${list.length} stream(s)`);
          collected.push(...list.map(s => Object.assign({}, s, { source: src.id })));
        }
      })
      .catch(err => {
        console.log(`[AllSources] ${src.name} failed: ${err.message}`);
      });
  });

  function finalize() {
    const ranked = applyPreferredLogic(collected, type);
    console.log(`[AllSources] Returning ${ranked.length} stream(s) after ranking (from ${collected.length} collected)`);
    return ranked;
  }

  const allDone = Promise.all(sourceRuns).then(() => 'ALL_DONE');
  const timeoutGuard = buildTimeoutGuard(COMBINE_TIMEOUT_SECONDS);

  return Promise.race([allDone, timeoutGuard]).then(reason => {
    if (reason === 'GUARD_UNAVAILABLE') {
      console.log('[AllSources] Timeout guard unreachable - waiting for all sources to finish instead of guessing');
      return allDone.then(finalize);
    }
    if (reason === 'TIMED_OUT') {
      console.log(`[AllSources] ${COMBINE_TIMEOUT_SECONDS}s cutoff reached - returning what has been found so far`);
    }
    return finalize();
  });
}

module.exports = { getStreams };
