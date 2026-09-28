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

const ExternalAddonFactory = (function () {
// Generic, config-driven relay for an external Stremio-protocol addon -
// the single implementation behind every "just relay another addon's own
// results" provider in this repo (hdhub4u, penguplay, and anything added
// later through the admin UI), instead of a hand-written copy per addon.
//
// Exports createProvider(config), not a bare getStreams - lib/aggregate.js's
// loadProvider() calls createProvider(entry.config) for any manifest entry
// that points its filename here, so one file can back many differently
// configured providers at once. See admin-server.js for how a manifest
// entry's config gets created/edited.
//
// config shape: { addonBaseUrl: string, configJson?: object, tmdbApiKey?: string, namePrefix?: string }
// - addonBaseUrl: the addon's own base URL (e.g. "https://pengu.uk"). Some
//   addons bake their whole config into this URL already (hdhub4u) and need
//   nothing else; others expect a URL-encoded JSON config path segment
//   appended after the base (penguplay's auth_token/disable_direct).
// - configJson: when present, JSON-encoded and appended as that path
//   segment. Omit/null for addons that don't use one.
// - tmdbApiKey: optional override; every provider in this repo already
//   shares one publicly-used TMDB key, reused here by default so most
//   configs don't need to specify it.
// - namePrefix: prepended to each returned stream's own name. Some addons'
//   stream names are already self-branded (PenguPlay's "🐧 PenguPlay ...")
//   and don't need one; others (HDHub4u's) aren't, so this repo has
//   historically added "HDHub4u " itself - kept configurable rather than
//   hardcoded so either style works without new code.
const DEFAULT_TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

function getImdbId(tmdbId, mediaType, tmdbApiKey) {
  const endpoint = mediaType === "tv" ? "tv" : "movie";
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${tmdbApiKey}&append_to_response=external_ids`;
  return fetch(url, { headers: { "Accept": "application/json" } })
    .then((res) => {
      if (!res.ok) throw new Error(`TMDB API error: ${res.status}`);
      return res.json();
    })
    .then((data) => (data.external_ids && data.external_ids.imdb_id) || null);
}

function parseQuality(name) {
  const text = name || "";
  if (/\b4k\b|2160/i.test(text)) return "4K";
  const m = text.match(/(\d{3,4})p/i);
  return m ? `${m[1]}p` : "Unknown";
}

function parseSize(description) {
  // Descriptions sometimes also carry a bitrate line ("~55.9 Mbps") - a
  // plain /(GB|MB)/i match grabs "Mb" out of "Mbps" instead of a real size
  // line, since both start with the same two letters. A word boundary after
  // the unit rules that out: "Mbps" has no boundary between "b" and "p".
  const m = (description || "").match(/([\d.]+)\s*(GB|MB)\b/i);
  return m ? `${m[1]} ${m[2].toUpperCase()}` : undefined;
}

// Confirmed live (while building this repo's own hdhub4u/penguplay relays):
// "HubCloud"-style gateway links (hubcloud.cx/.ist/.dad) need their own
// multi-hop resolution before it's known whether they land on a real file or
// a non-seekable Google Drive link / dead Telegram-bot redirect. Not worth
// reproducing that chain for a third-party addon we don't control, so these
// are skipped; already-direct links (PixelDrain, R2, etc.) pass through.
function isUsableStream(s) {
  if (!s.url) return false;
  try {
    return !new URL(s.url).hostname.includes("hubcloud");
  } catch (e) {
    return false;
  }
}

// By request: PenguPlay's MovieBox-sourced entries sometimes offer the same
// title re-dubbed into another language entirely (Arabic, French, Kurdish,
// Russian, Tamil, Telugu, ...) - confirmed live in MovieBox's own
// descriptions, two ways: most say so explicitly with a "<language> sub
// audio"/"<language> dub audio" phrase (MovieBox's own confusing term for a
// substitute/dubbed audio track, not an actual burned-in visual subtitle -
// there's no separate subtitle file or hardsub involved at all), but Hindi
// variants specifically only carry a trailing "Audio: Hindi" line with no
// "dub audio" phrasing at all - confirmed live this second pattern would
// otherwise slip through the first check alone. The original/default-audio
// variants never carry either pattern, so both are reliable signals without
// needing to enumerate every language they might show up as.
function isForeignDubbedAudio(description) {
  const text = description || "";
  if (/\b(?:sub|dub) audio\b/i.test(text)) return true;
  const audioLine = text.match(/Audio:\s*([^\n]+)/i);
  return !!audioLine && !/\benglish\b/i.test(audioLine[1]);
}

function createProvider(config) {
  const addonBaseUrl = (config && config.addonBaseUrl || "").replace(/\/+$/, "");
  const configJson = config && config.configJson;
  const tmdbApiKey = (config && config.tmdbApiKey) || DEFAULT_TMDB_API_KEY;
  const providerLabel = (config && config.name) || "ExternalAddon";
  const namePrefix = (config && config.namePrefix) || "";
  const configSegment = configJson ? `/${encodeURIComponent(JSON.stringify(configJson))}` : "";

  function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
    console.log(`[${providerLabel}] Fetching streams for TMDB: ${tmdbId}, Type: ${mediaType}`);
    return getImdbId(tmdbId, mediaType, tmdbApiKey).then((imdbId) => {
      if (!imdbId) {
        console.log(`[${providerLabel}] No IMDb id found for this TMDB id`);
        return [];
      }
      const type = mediaType === "tv" ? "series" : "movie";
      if (type === "series" && (!season || !episode)) return [];
      const id = type === "series" ? `${imdbId}:${season}:${episode}` : imdbId;

      return fetch(`${addonBaseUrl}${configSegment}/stream/${type}/${id}.json`, { headers: { "User-Agent": "Mozilla/5.0" } })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          const raw = Array.isArray(data.streams) ? data.streams : [];
          const seenUrls = new Set();
          const streams = [];
          for (const s of raw) {
            if (!isUsableStream(s) || seenUrls.has(s.url) || isForeignDubbedAudio(s.description)) continue;
            seenUrls.add(s.url);
            const rawName = (s.name || "").replace(/\n/g, " ").trim();
            const name = `${namePrefix}${rawName}`.trim();
            const description = (s.description || "").replace(/\n/g, " ").trim();
            streams.push({
              name,
              title: description,
              url: s.url,
              quality: parseQuality(name),
              size: parseSize(description)
            });
          }
          console.log(`[${providerLabel}] Got ${streams.length} usable stream(s)`);
          return streams;
        });
    }).catch((err) => {
      console.error(`[${providerLabel}] Error: ${err.message}`);
      return [];
    });
  }

  return { getStreams };
}
  return { createProvider };
})();

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
// Missing Origin here (unlike REQUEST_HEADERS above) meant every stream/proxy
// host - the workers.dev fronts for Luna, the standalone domain Orion uses,
// all of them - came back a hard Cloudflare 403 on every single validation
// and playback attempt, confirmed live across 5 different titles: not one
// candidate ever passed validateStreamUrl, so getStreams always returned
// empty regardless of how many servers vidrock.net's own API actually
// offered. Adding just this one header (confirmed live, isolating it from
// Accept/sec-fetch-*, which made no difference on their own) was enough to
// turn a 403 into a real 200 on both proxy hosts tested.
const PLAYBACK_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': `${VIDROCK_BASE_URL}/`,
  'Origin': VIDROCK_BASE_URL
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
    // MovieBox's search splits one multi-season show into one result row
    // PER SEASON (or season range) - "The Office S1", "The Office S9",
    // "The Office S1-S8" - all sharing the same underlying subjectId.
    // Left un-stripped, a correctly season-matched row only ever qualifies
    // for the weaker "starts with" score below (since "office s1" !==
    // "office"), while a same-named but unrelated adaptation with no season
    // suffix in its title gets the full exact-match score instead - even
    // with a year that doesn't match at all. Confirmed live: this is
    // exactly why "The Office" (2005, US) S1E1 played a different
    // same-titled adaptation entirely. Stripping the suffix first makes
    // every season-row of the right show compare equal to a bare title, so
    // the year check below can actually do its job.
    .replace(/\s+s\d+(\s*-\s*s\d+)?\s*$/i, '')
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
    const itemYear = (item.releaseDate || '').substring(0, 4);
    // A same/exact-titled but wrong-year candidate is worse than no match at
    // all - confirmed live: MovieBox's only movie-type "Supergirl" result is
    // dated 2016, a decade off the 2026 reboot actually requested (which
    // isn't in MovieBox's own catalog yet, too new), and an exact title
    // match's score alone was already above the acceptance threshold with
    // zero year bonus - it should never have been offered as a candidate at
    // all. Only disqualifies when both years are actually known; a
    // candidate with no releaseDate at all still gets the benefit of the
    // doubt, same as before.
    if (mediaInfo.year && itemYear && Math.abs(parseInt(itemYear, 10) - parseInt(mediaInfo.year, 10)) > 1) continue;
    const normTitle = normalizeTitle(item.title);
    let score = 0;
    if (normTitle === normTarget) score += 50;
    else if (normTitle.startsWith(normTarget) || normTarget.startsWith(normTitle)) score += 25;
    else if (normTitle.includes(normTarget)) score += 10;
    else continue;
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
// Confirmed live (2026-09-22): fanning out to extractHubCloud for every item
// on a movie's page (up to a dozen, all in parallel) is only as fast as the
// single slowest hubcloud.ist link - one title took 17s total when 10 of 12
// links resolved in under 2s and the last one alone ate the other 15,
// occasionally enough to blow past aggregateStreams's own 25s overall
// deadline and return zero streams for a title this provider actually has.
// A per-request timeout (like vidfastpro.js's/uhdmovies.js's own fixes for
// the same shape of problem) treats a slow link like any other failed one -
// this file is also distributed as a standalone Nuvio local-scraper plugin,
// and Nuvio's sandbox has neither setTimeout nor AbortController, so both are
// feature-detected the same way those fixes are, degrading to the old
// no-timeout retry behavior there instead of throwing and failing every
// request.
const FETCH_TEXT_TIMEOUT_MS = 10000;
const HAS_ABORT_TIMER = typeof AbortController !== "undefined" && typeof setTimeout !== "undefined";
function fetchText(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    const retries = options.retries !== void 0 ? options.retries : 2;
    for (let i = 0; i <= retries; i++) {
      const controller = HAS_ABORT_TIMER ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), FETCH_TEXT_TIMEOUT_MS) : null;
      try {
        const fetchOptions = __spreadValues({
          headers: __spreadValues({
            "User-Agent": USER_AGENT
          }, options.headers)
        }, controller ? { signal: controller.signal } : {});
        const response = yield fetch(url, fetchOptions);
        if (timer) clearTimeout(timer);
        return yield response.text();
      } catch (err) {
        if (timer) clearTimeout(timer);
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
      const normalizedCard = movieCardTitle.toLowerCase();
      const normalizedName = name.toLowerCase();
      const distance = levenshteinDistance(normalizedCard, normalizedName);
      // Some cards append a franchise/collection label straight onto the
      // title with no bracket or separator (e.g. "Guardians of the Galaxy
      // Vol. 2  Marvel Phase 3"), which the year filter above has already
      // narrowed down - a plain distance check rejects these since the
      // added text pushes it well past the threshold, so also accept a
      // clean prefix match.
      const match = distance < 5 || normalizedCard.startsWith(normalizedName + " ") || normalizedCard === normalizedName;
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
    const controller = HAS_ABORT_TIMER ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FETCH_TEXT_TIMEOUT_MS) : null;
    try {
      const fetchOptions = __spreadValues({ headers: { "User-Agent": USER_AGENT } }, controller ? { signal: controller.signal } : {});
      const response = yield fetch(url, fetchOptions);
      if (timer) clearTimeout(timer);
      const finalUrl = response.url || url;
      try {
        const link = new URL(finalUrl).searchParams.get("link");
        if (link)
          return link;
      } catch (e) {
      }
      return finalUrl;
    } catch (err) {
      if (timer) clearTimeout(timer);
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
// The URLs built below point at Vidlink's actual CDN (bcdn.hakunaymatata.com
// or similar), not vidlink.pro itself - confirmed live that this CDN returns
// 429/428 when the request carries vidlink.pro's own Referer/User-Agent
// (VIDLINK_HEADERS, used elsewhere in this file for the vidlink.pro API
// calls that produce these URLs) but 200/206 with no headers at all. These
// stream objects intentionally carry no `headers` field - Nuvio only
// attaches proxyHeaders when a stream has one, so omitting it here sends the
// plain request the CDN actually wants, both for this file's own validation
// and for real playback.
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
      if (!data) {
        // Confirmed live: vidlink.pro's API returns a bare JSON `null` body
        // (not an object with empty fields) for at least one real title with
        // no available stream - processVidlinkResponse assumes an object and
        // throws reading `data.subtitles` off it, which the outer try/catch
        // does paper over, but only after an exception rather than the clean
        // "no streams" result this genuinely is.
        console.log("[Vidlink] API returned no data for this title");
        return [];
      }
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
      // Only accept a "<title>: <subtitle>" style match here (e.g. a
      // reboot/special named "X: The Reunion"). A bare startsWith(`${searchTitle} `)
      // is too loose - it previously matched unrelated shows like "Friends from
      // College" or "Friends and Family" when searching for "Friends", silently
      // serving the wrong show's video.
      best = candidates.find((item) => (item.title || item.name || "").toLowerCase().startsWith(`${searchTitle}:`));
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

const HdHub4uSource = ExternalAddonFactory.createProvider({"name":"HDHub4u","addonBaseUrl":"https://hdhub.thevolecitor.qzz.io/eyJ0b3Jib3giOiJ1bnNldCIsInF1YWxpdGllcyI6IjEwODBwLDcyMHAiLCJzb3J0IjoiZGVzYyIsImNhdGFsb2dzIjoiIn0","namePrefix":"HDHub4u "});

const PenguPlaySource = ExternalAddonFactory.createProvider({"name":"PenguPlay","addonBaseUrl":"https://pengu.uk","configJson":{"auth_token":"CwgTS317M83kEQR4ErRaW_IOI0hJIU00Y91Umm97ZC0","disable_direct":true}});

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
      const epNum = episode || 1;
      const wantSeason = season || 1;
      if (seasonItems.length > 0) {
        mediaType2 = 2;
        // Despite the "seasons-lst" name, this list is actually flat and
        // per-episode - each item is labeled "S{season}-E{episode}" with its
        // own distinct episode deep link (confirmed live: One Piece's list
        // has one entry per episode, e.g. "S1-E1".."S1-E25", not one per
        // season). Matching on the season digit alone and letting later
        // items keep overwriting targetUrl - the previous behavior - always
        // ended up on that season's *last* episode, regardless of which
        // episode was actually requested.
        seasonItems.each((_, el) => {
          const label = $2(el).find("h3.title > span").text();
          const m = label.match(/S(\d+)-E(\d+)/i);
          const href = $2(el).find("a").attr("href");
          if (href && m && parseInt(m[1], 10) === wantSeason && parseInt(m[2], 10) === epNum) {
            targetUrl = href;
          }
        });
      }
      const targetPage = yield (yield fetch(targetUrl, { headers: HEADERS, skipSizeCheck: true })).text();
      const $3 = cheerio.load(targetPage);
      const targetBodyClass = $3("body").attr("class") || "";
      const targetTermMatch = targetBodyClass.match(/(?:term|postid)-(\d+)/);
      const targetTerm = targetTermMatch?.[1] || term;
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
function searchKickassAnime(query) {
  return fetch(`${BASE_URL}/api/fsearch`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ page: "1", query }),
    skipSizeCheck: true
  }).then((res) => res.json());
}
function findExactShowMatch(results, title) {
  const norm = (title || "").toLowerCase().trim();
  return (results || []).find((r) => (r.title_en || r.title || "").toLowerCase().trim() === norm) || null;
}
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
      const mediaInfo = yield (yield fetch(tmdbUrl, { skipSizeCheck: true })).json();
      const title = mediaInfo.title || mediaInfo.name;
      if (!title)
        return [];
      const searchData = yield searchKickassAnime(title);
      let match = findExactShowMatch(searchData && searchData.result, title);
      // kaa.lt indexes each season/arc/movie of a franchise as its own show
      // entry, prefixed with the base name - a loose substring match against
      // the full "Base: Subtitle" TMDB title (e.g. "Demon Slayer: Kimetsu no
      // Yaiba") can match an unrelated arc/movie whose title happens to
      // start with that same string (confirmed live: querying that exact
      // title never even returns the base show, only its arcs/movies, one
      // of which "includes" the query as a prefix). If nothing matched
      // exactly, retry with just the part before the colon, which reliably
      // surfaces the actual base entry as its own exact match.
      if (!match && title.includes(":")) {
        const baseTitle = title.split(":")[0].trim();
        if (baseTitle && baseTitle.toLowerCase() !== title.toLowerCase()) {
          const retryData = yield searchKickassAnime(baseTitle);
          match = findExactShowMatch(retryData && retryData.result, baseTitle);
        }
      }
      if (!match) {
        const candidates = (searchData && searchData.result) || [];
        match = candidates.find(
          (r) => (r.title_en || r.title || "").toLowerCase().includes(title.toLowerCase())
        ) || candidates[0];
      }
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
    // A post title carrying its own distinct release year that conflicts
    // with the target's is a hard mismatch, not just a missed bonus below -
    // otherwise a same-named but unrelated title (e.g. "The Office" (2005)
    // vs. an unrelated 2024 remake also called "The Office") wins purely on
    // word overlap, since short common titles overlap 100% either way.
    const postYearMatch = doc.post_title.match(/\b(19|20)\d{2}\b/);
    if (mediaInfo.year && postYearMatch && Math.abs(parseInt(postYearMatch[0], 10) - parseInt(mediaInfo.year, 10)) > 1) {
      continue;
    }
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
    // Most posts label the per-episode hub link "Episode Links", but some
    // (e.g. older season-pack posts) skip that label and put the hub link
    // directly under "G-Direct" instead - confirmed live that link's target
    // page lists one "G-Direct [Instant]" link per episode either way, so
    // it's the same kind of hub, just unlabeled.
    const listUrl = findLinkByText($, $(el).next(), /Episode Links/i) || findLinkByText($, $(el).next(), /G-Direct/i);
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

const CinejoySource = (function () {
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
  return { getStreams: getStreams };
})();

const FilmyfiySource = (function () {
// Filmyfiy scraper.
//
// Ported from the CloudStream "StreamPlay" plugin's invokeFilmyfiy (decompiled
// from com.phisher98.StreamPlayExtractor, StreamPlay.cs3 build), then
// re-verified live end-to-end against the real site rather than trusted
// as-is - the plugin's own scraping logic drifts from the live site over
// time (confirmed twice already this session for two other sources in that
// same plugin).
//
// Confirmed live (2026-09-28):
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json
//                      ["filmyfiy"] - the site itself rebranded away from the
//                      "filmyfiy" name (its own <meta name="generator"> and
//                      page titles now say "FilmyFly"), only the JSON key
//                      still uses the old plugin name.
//   search         -> the decompiled Kotlin's GET
//                      "{domain}/site-1.html?to-search={query}" no longer
//                      does a search at all - confirmed live it returns the
//                      exact same fixed article regardless of the query
//                      string. The site's real search (visible from its own
//                      <form method="post"> on every page) is a plain DLE
//                      (DataLife Engine) search: POST {domain}/index.php?do=search
//                      with do=search&subaction=search&story={query}.
//   search results -> one `div.A10` per hit (NOT the decompiled code's
//                     `div.A2 > a:nth-child(2)` - that selector matches
//                     nothing live, and a previous partial attempt's
//                     from-scratch re-check of it was also stale, confirmed
//                     by re-deriving the real markup here). Each `div.A10`
//                     holds `a.row-thumb-link[href]` (the movie page link)
//                     and a `.row-title` div with the full title text.
//   movie page     -> `div.dlbtn a[href]` matches the decompiled code as-is:
//                      one "go_link" redirector link (a Cloudflare 302 to a
//                      linkmake.in "Link Protector" interstitial).
//   go_link page   -> `div.dlink a[href]` also matches the decompiled code
//                      as-is: one link per quality, each a
//                      `filesdl.in/cloud/<id>` short link.
//   filesdl link   -> redirects to a filesdl.top/.in "cloud" page offering
//                      several parallel options. Two were confirmed live to
//                      be immediately usable without any browser/JS step:
//                        - "Direct Download (10Gbps)" (fffast.filesdl.in/
//                          zdownload.php?...&token=...) - the token is baked
//                          into the server-rendered HTML already (only the
//                          page's OTHER "Cloud Direct" button gets a fresh
//                          token injected by client-side JS - that one 403s
//                          without it and is skipped here); this one 302s
//                          straight to a video-downloads.googleusercontent.com
//                          link. Confirmed live: a real 200 with
//                          Content-Type: video/mkv and a Content-Length
//                          matching the page's own stated file size.
//                        - "Download - HubCloud" (hubcloud.*) - resolved via
//                          this repo's shared lib/hubcloudExtract.js rather
//                          than reimplementing that logic a third time.
//                          Confirmed live: its FSL (r2.cloudflarestorage.com)
//                          option answers a ranged GET with a real 206
//                          (though, like other HubCloud FSL links elsewhere
//                          in this repo, it 403s on a plain HEAD - the
//                          signed URL only permits the method it was signed
//                          for, which is why validation below falls back to
//                          a ranged GET rather than trusting HEAD alone).
//                      A "Login To Download - GDFLIX" option also appears
//                      but requires an account, so it's skipped; likewise
//                      GoFile.io, a Telegram bot link, and a "Buzz Download"
//                      (fuckingfast.net) option are left unused to keep the
//                      per-title request count bounded.
//
// Per the CloudStream plugin's own listing, this source is movies-only (its
// invokeFilmyfiy only ever takes a plain title, no season/episode), so TV
// requests short-circuit immediately below.

const cheerio = require('cheerio');
const { extractHubCloud } = require('../lib/hubcloudExtract');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://filmyhok.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
    if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
    return fetch(DOMAINS_URL, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => {
            const domain = ((data && data.filmyfiy) || DEFAULT_DOMAIN).replace(/\/+$/, '');
            cachedDomain = domain;
            cachedDomainAt = Date.now();
            console.log(`[Filmyfiy] Using domain: ${domain}`);
            return domain;
        })
        .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
        .then(res => res.json())
        .then(data => {
            const title = mediaType === 'tv' ? data.name : data.title;
            const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
            console.log(`[Filmyfiy] TMDB Info: "${title}" (${year})`);
            return { title, year };
        })
        .catch(() => ({ title: null, year: '' }));
}

function normalize(str) {
    return String(str || '').toLowerCase().replace(/&#8[0-9]{3};/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function search(domain, query) {
    const body = new URLSearchParams({ do: 'search', subaction: 'search', story: query }).toString();
    return fetch(`${domain}/index.php?do=search`, {
        method: 'POST',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': `${domain}/`
        },
        body
    })
        .then(res => (res.ok ? res.text() : ''))
        .catch(() => '');
}

function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const results = [];
    $('div.A10').each((_, el) => {
        const href = $(el).find('a.row-thumb-link').attr('href');
        const title = $(el).find('.row-title').text().trim();
        if (href && title) results.push({ href, title });
    });
    return results;
}

function findBestMatch(results, mediaInfo) {
    const targetTitle = normalize(mediaInfo.title);
    if (!targetTitle) return null;
    if (mediaInfo.year) {
        const withYear = results.find(r => normalize(r.title).startsWith(targetTitle) && r.title.includes(String(mediaInfo.year)));
        if (withYear) return withYear;
    }
    return results.find(r => normalize(r.title).startsWith(targetTitle)) || null;
}

function extractQuality(str) {
    const m = /(\d{3,4})[pP]/.exec(str || '');
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 2160) return '4K';
        if (n >= 1080) return '1080p';
        if (n >= 720) return '720p';
        if (n >= 480) return '480p';
        return `${n}p`;
    }
    if (/4K|UHD/i.test(str || '')) return '4K';
    return 'Unknown';
}

function heightFromQuality(quality) {
    if (quality === '4K') return 2160;
    const m = /^(\d{3,4})p$/.exec(quality || '');
    return m ? parseInt(m[1], 10) : 0;
}

function extractGoLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const hrefs = [];
    $('div.dlbtn a[href]').each((_, el) => {
        let href = $(el).attr('href');
        if (!href) return;
        if (!/^https?:\/\//i.test(href)) {
            try { href = new URL(href, baseUrl).toString(); } catch (e) { return; }
        }
        hrefs.push(href);
    });
    return Array.from(new Set(hrefs));
}

function extractDlinks(html) {
    const $ = cheerio.load(html);
    const items = [];
    $('div.dlink a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const label = $(el).text().replace(/\s+/g, ' ').trim();
        if (href) items.push({ url: href, label });
    });
    return items;
}

// Each MAX_DLINKS quality tier costs its own filesdl.top fetch plus (when it
// has a HubCloud option) two more hops through extractHubCloud - capped the
// same way hindmoviez.js caps its own quality groups, to keep total latency
// for a single getStreams call bounded.
const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
const MAX_DLINKS = 3;

function resolveFilesdlPage(dlink, fallbackTitle) {
    return fetch(dlink.url, { headers: { 'User-Agent': USER_AGENT, Referer: dlink.url } })
        .then(res => res.text())
        .then(html => {
            const $ = cheerio.load(html);
            const pageTitle = $('.title').first().text().trim() || fallbackTitle;
            const labelQuality = extractQuality(dlink.label);
            const quality = labelQuality !== 'Unknown' ? labelQuality : extractQuality(pageTitle);
            const height = heightFromQuality(quality);

            let directHref = null;
            $('a.button').each((_, el) => {
                if (directHref) return;
                if (/direct download/i.test($(el).text())) directHref = $(el).attr('href');
            });

            const streams = [];
            if (directHref) {
                streams.push({
                    name: `Filmyfiy - Direct${quality !== 'Unknown' ? ` ${quality}` : ''}`,
                    title: pageTitle,
                    url: directHref,
                    quality,
                    headers: { 'User-Agent': USER_AGENT },
                    subtitles: [],
                    provider: 'filmyfiy'
                });
            }

            let hubCloudHref = null;
            $('a[href]').each((_, el) => {
                if (hubCloudHref) return;
                const href = $(el).attr('href') || '';
                if (href.includes('hubcloud.')) hubCloudHref = href;
            });

            const hubCloudPromise = hubCloudHref
                ? extractHubCloud(
                    hubCloudHref,
                    { title: pageTitle, height, bytes: 0 },
                    { userAgent: USER_AGENT, log: msg => console.log(`[Filmyfiy] ${msg}`) }
                ).then(results => results.map(r => ({
                    name: `Filmyfiy - ${r.source}${height ? ` ${height}p` : ''}`,
                    title: r.meta.title || pageTitle,
                    url: r.url,
                    quality,
                    headers: { 'User-Agent': USER_AGENT },
                    subtitles: [],
                    provider: 'filmyfiy'
                }))).catch(() => [])
                : Promise.resolve([]);

            return hubCloudPromise.then(hubStreams => streams.concat(hubStreams));
        })
        .catch(err => {
            console.log(`[Filmyfiy] Failed to resolve ${dlink.url}: ${err.message}`);
            return [];
        });
}

// Direct file links get a cheap HEAD; a HubCloud FSL (r2.cloudflarestorage.com)
// link is confirmed live to 403 on HEAD even though it 206s a ranged GET
// (the pre-signed URL only permits the method it was signed for), so a
// failed HEAD falls back to a ranged GET rather than being trusted as dead -
// same approach as providers/cinejoy.js and providers/peachify.js.
function isM3u8Url(url) {
    return /\.m3u8(\?|$)/i.test(url);
}

function rangedValidateUrl(url, headers) {
    const rangedHeaders = Object.assign({}, headers, { Range: 'bytes=0-2048' });
    return fetch(url, { method: 'GET', headers: rangedHeaders })
        .then(res => res.ok || res.status === 206)
        .catch(() => false);
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
        .then(res => (res.ok || res.status === 206 ? true : rangedValidateUrl(stream.url, stream.headers)))
        .catch(() => rangedValidateUrl(stream.url, stream.headers));
}

function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[Filmyfiy] getStreams start tmdbId=${tmdbId} type=${mediaType}`);

    if (mediaType === 'tv') {
        console.log('[Filmyfiy] Movies only, skipping TV');
        return Promise.resolve([]);
    }

    return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)])
        .then(([domain, mediaInfo]) => {
            if (!mediaInfo.title) return [];
            return search(domain, mediaInfo.title).then(html => {
                if (!html) return [];
                const results = parseSearchResults(html);
                const match = findBestMatch(results, mediaInfo);
                if (!match) {
                    console.log(`[Filmyfiy] No matching title found for "${mediaInfo.title}"`);
                    return [];
                }
                console.log(`[Filmyfiy] Matched: "${match.title}"`);

                return fetch(match.href, { headers: { 'User-Agent': USER_AGENT } })
                    .then(res => res.text())
                    .then(movieHtml => {
                        const goLinks = extractGoLinks(movieHtml, domain);
                        if (!goLinks.length) {
                            console.log('[Filmyfiy] No download button found on movie page');
                            return [];
                        }
                        return Promise.all(goLinks.map(goLink =>
                            fetch(goLink, { headers: { 'User-Agent': USER_AGENT, Referer: match.href } })
                                .then(res => res.text())
                                .then(extractDlinks)
                                .catch(() => [])
                        )).then(perLink => {
                            let dlinks = perLink.flat().filter(d => d.url);
                            const seen = new Set();
                            dlinks = dlinks.filter(d => {
                                if (seen.has(d.url)) return false;
                                seen.add(d.url);
                                return true;
                            });
                            dlinks.sort((a, b) => (QUALITY_RANK[extractQuality(b.label)] || 0) - (QUALITY_RANK[extractQuality(a.label)] || 0));
                            dlinks = dlinks.slice(0, MAX_DLINKS);
                            console.log(`[Filmyfiy] Resolving ${dlinks.length} quality link(s)`);
                            return Promise.all(dlinks.map(d => resolveFilesdlPage(d, match.title))).then(r => r.flat());
                        });
                    });
            });
        })
        .then(streams => {
            console.log(`[Filmyfiy] Found ${streams.length} candidate stream(s), validating...`);
            return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
                const valid = validated.filter(v => v.ok).map(v => v.stream);
                const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
                if (dead.length) console.log(`[Filmyfiy] Dropping unreachable: ${dead.join(', ')}`);
                console.log(`[Filmyfiy] ${valid.length}/${streams.length} stream(s) validated OK`);
                return valid;
            });
        })
        .catch(err => {
            console.log(`[Filmyfiy] getStreams failed: ${err.message}`);
            return [];
        });
}
  return { getStreams: getStreams };
})();

const MoviesDriveSource = (function () {
// MoviesDrive scraper - ported from the decompiled CloudStream "StreamPlay"
// plugin (com.phisher98.StreamPlayExtractor#invokeMoviesdrive, decompiled
// this session from the StreamPlay.cs3 build), then verified live end-to-end
// against the real site (2026-09-28) rather than trusted blindly - the
// decompiled Kotlin is a coroutine-state-machine mess that jadx could only
// partially decompile (the per-item resolver lambdas needed the register-
// level fallback decompile to read at all), and this plugin's other sources
// have already been confirmed to drift from reality twice this session.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["moviesdrive"]
//   search         -> GET {domain}/search.php?q={query}&page=1  (Typesense-style
//                     JSON, same shape as vegamovies.js's search.php - each hit's
//                     "document" has imdb_id/post_title/permalink)
//   movie page     -> one "h5 > a" link per quality, each pointing to an
//                     mdrive.lol "archive" intermediate page - confirmed live
//                     (Inception, tmdb 27205) that page embeds exactly one
//                     hubcloud.ist/drive/<id> link
//   series page    -> one "Season N [...]" h5 per (season, quality) with NO
//                     link of its own - the link lives on the immediately
//                     following h5 ("{q}p Single Episode"), confirmed live
//                     (Breaking Bad) to point at a SECOND mdrive.lol page
//                     listing "EpNN– {q}p [size]" headers, each followed by
//                     a "HubCloud" h5 whose <a> is the final hubcloud.ist link
//   hubcloud.ist   -> resolved via the shared lib/hubcloudExtract.js helper
//                     (already used by 4khdhub.js/hindmoviez.js) rather than
//                     reimplementing that extraction - confirmed live it hands
//                     back a real googleusercontent.com direct link (200,
//                     video/mkv) and, sometimes, a PixelServer link that was
//                     confirmed live to already be dead (404) for this same
//                     title - exactly the kind of stale link this file's own
//                     validateStreamUrl step is meant to filter out.
//
// Only hubcloud.ist links were seen live across every quality tried (movie:
// 480p/1080p/4K; series: S1E5). The decompiled extractMdrive() also matches
// gdflix/gdlink hosts, but neither was observed live and no gdflix handling
// exists elsewhere in this repo to model - if a future title routes through
// one, resolveTargetToStreams below logs and skips it rather than guessing.

const cheerio = require('cheerio');
const { extractHubCloud, formatBytes } = require('../lib/hubcloudExtract');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://new4.moviesdrive.christmas';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetch(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const domain = ((data && data.moviesdrive) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[MoviesDrive] Using domain: ${domain}`);
      return domain;
    })
    .catch(() => DEFAULT_DOMAIN);
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
      console.log(`[MoviesDrive] TMDB Info: "${title}" (${year}) imdb=${imdbId || 'none'}`);
      return { title, year, imdbId };
    })
    .catch(() => ({ title: null, year: '', imdbId: null }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Same matching strategy as vegamovies.js (same underlying site template -
// the search.php document schema is identical field-for-field): prefer an
// exact imdb_id hit, else score by title word-overlap with a year bonus, and
// require a year that doesn't outright conflict with a post's own stated year.
function findBestMatch(hits, mediaInfo) {
  if (!hits || !hits.length) return null;
  if (mediaInfo.imdbId) {
    const exact = hits.find(h => h.document && h.document.imdb_id === mediaInfo.imdbId);
    if (exact) return exact.document;
  }
  const targetWords = new Set(normalize(mediaInfo.title).split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const hit of hits) {
    const doc = hit.document;
    if (!doc || !doc.post_title) continue;
    const postYearMatch = doc.post_title.match(/\b(19|20)\d{2}\b/);
    if (mediaInfo.year && postYearMatch && Math.abs(parseInt(postYearMatch[0], 10) - parseInt(mediaInfo.year, 10)) > 1) {
      continue;
    }
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

function search(domain, query) {
  const url = `${domain}/search.php?q=${encodeURIComponent(query)}&page=1`;
  return fetch(url, { headers: Object.assign({}, HEADERS, { Referer: domain + '/' }) })
    .then(res => (res.ok ? res.json() : null))
    .then(data => (data && Array.isArray(data.hits) ? data.hits : []))
    .catch(() => []);
}

function extractQuality(str) {
  const m = /(\d{3,4})\s*[pP]/.exec(str || '');
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 2160) return '4K';
    if (n >= 1080) return '1080p';
    if (n >= 720) return '720p';
    if (n >= 480) return '480p';
    return `${n}p`;
  }
  if (/4K|UHD/i.test(str || '')) return '4K';
  return 'Unknown';
}

// One h5>a per quality on a movie page - confirmed live the anchor's own
// enclosing h5 carries the quality/size label directly (e.g. "1080p 10bit
// HEVC [2.3GB]"), each pointing to an mdrive.lol intermediate page.
function extractMovieQualityLinks($) {
  const groups = [];
  $('h5 > a').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).closest('h5').text().trim();
    groups.push({ label, mdriveHref: href });
  });
  return groups;
}

// A series page has one "Season N [...]" h5 per (season, quality) group with
// no link of its own - confirmed live the link lives on the immediately
// following h5 ("{q}p Single Episode"). Headers for other seasons/qualities
// are skipped by the season-number match; "Single Episode"/"Zip" sub-headers
// never themselves match the season pattern so they're naturally excluded.
function extractSeasonQualityGroups($, season) {
  const seasonPatterns = [
    new RegExp('season\\s*' + season + '\\b', 'i'),
    new RegExp('\\bs0?' + season + '\\b', 'i')
  ];
  const groups = [];
  $('h5').each((_, el) => {
    const text = $(el).text().trim();
    if (!text || /single episode|zip/i.test(text)) return;
    if (!seasonPatterns.some(re => re.test(text))) return;
    let href = $(el).find('a').first().attr('href');
    if (!href) {
      const next = $(el).next();
      if (next.length) href = next.find('a').first().attr('href');
    }
    if (href) groups.push({ label: text, epListHref: href });
  });
  return groups;
}

// The "{q}p Single Episode" link leads to a second mdrive.lol page listing
// one "EpNN– {q}p [size]" heading per episode, each immediately followed by
// a "HubCloud" heading holding the final link - confirmed live (Breaking Bad
// S1E5) this exact regex/walk finds precisely the one hubcloud.ist href that
// belongs to the requested episode, stopping before the next episode heading.
function resolveEpisodeMdriveLinks(epListHref, season, episode) {
  return fetch(epListHref, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const sepRegex = new RegExp(
        '\\b(?:ep|episode|e)\\s*0?' + episode + '\\b|s0?' + season + '\\s*e0?' + episode + '\\b',
        'i'
      );
      const nextEpRegex = /^\s*(EP\s*\d+|Episode\s*\d+|S\d+E\d+)/i;
      const headings = $('h5, h4, h3, p').toArray();
      let matchIdx = -1;
      for (let i = 0; i < headings.length; i++) {
        if (sepRegex.test($(headings[i]).text())) { matchIdx = i; break; }
      }
      if (matchIdx === -1) return [];
      const links = [];
      let sib = $(headings[matchIdx]).next();
      while (sib.length && !nextEpRegex.test(sib.text().trim())) {
        sib.find('a[href]').each((_, a) => {
          const href = $(a).attr('href');
          if (href) links.push(href);
        });
        sib = sib.next();
      }
      return links;
    })
    .catch(() => []);
}

function isFinalHostUrl(url) {
  return /hubcloud\.|gdflix\.|gdlink\.|hubdrive\./i.test(url);
}

// Mirrors the decompiled extractMdrive()'s core behavior: an mdrive.lol page
// embeds one (occasionally more) hubcloud/gdflix/gdlink link - scan its
// anchors for one. If the url handed in is already one of those hosts (as
// happens directly on the episode-list page), skip the extra fetch.
function resolveMdriveTargets(url) {
  if (!url) return Promise.resolve([]);
  if (isFinalHostUrl(url)) return Promise.resolve([url]);
  return fetch(url, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const targets = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && isFinalHostUrl(href) && targets.indexOf(href) === -1) targets.push(href);
      });
      return targets;
    })
    .catch(() => []);
}

// hubcloud.* is the only final host confirmed live this session - see the
// file header. Anything else (gdflix/gdlink/hubdrive) is logged and skipped
// rather than guessed at with unverified extraction logic.
function resolveTargetToStreams(target, meta) {
  if (/hubcloud\./i.test(target)) {
    return extractHubCloud(target, { title: meta.title, bytes: 0 }, { userAgent: USER_AGENT, log: console.log })
      .then(results => results.map(r => ({
        name: `MoviesDrive [${r.source}]`,
        title: `${r.meta.title || meta.title}\n${formatBytes(r.meta.bytes || 0)}`,
        url: r.url,
        quality: meta.quality,
        headers: HEADERS,
        provider: 'moviesdrive'
      })));
  }
  console.log(`[MoviesDrive] Unsupported final-link host, skipping: ${target}`);
  return Promise.resolve([]);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(item => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function getMovieStreams($, label) {
  const groups = extractMovieQualityLinks($);
  if (!groups.length) {
    console.log('[MoviesDrive] No quality links found on movie page');
    return Promise.resolve([]);
  }
  const seen = new Set();
  return Promise.all(groups.map(g =>
    resolveMdriveTargets(g.mdriveHref).then(targets => {
      const fresh = targets.filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
      return Promise.all(fresh.map(t => resolveTargetToStreams(t, { title: label, quality: extractQuality(g.label) })));
    })
  )).then(nested => nested.flat(2));
}

function getTvStreams($, season, episode, label) {
  const groups = extractSeasonQualityGroups($, season);
  if (!groups.length) {
    console.log(`[MoviesDrive] No quality groups found for season ${season}`);
    return Promise.resolve([]);
  }
  const seen = new Set();
  const episodeLabel = `${label} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return Promise.all(groups.map(g =>
    resolveEpisodeMdriveLinks(g.epListHref, season, episode)
      .then(rawLinks => Promise.all(dedupe(rawLinks).map(l => resolveMdriveTargets(l))).then(nested => nested.flat()))
      .then(targets => {
        const fresh = targets.filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
        return Promise.all(fresh.map(t => resolveTargetToStreams(t, { title: episodeLabel, quality: extractQuality(g.label) })));
      })
  )).then(nested => nested.flat(2));
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

// Confirmed live that a HubCloud "PixelServer" link can be stale (404 on
// both HEAD and a ranged GET) even when the sibling "10Gbps"
// googleusercontent link from the very same page is a real, playable 200 -
// HTTP status from the resolver alone isn't reliable, so every stream this
// provider returns is independently probed here before being handed back.
function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return fetch(stream.url, { headers: stream.headers })
      .then(res => (res.ok ? res.text().then(text => /^#EXTM3U/.test(text.trim())) : false))
      .catch(() => false);
  }
  return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => fetch(stream.url, { method: 'GET', headers: Object.assign({}, stream.headers, { Range: 'bytes=0-2048' }) })
      .then(res => res.ok || res.status === 206)
      .catch(() => false));
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[MoviesDrive] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[MoviesDrive] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return search(domain, mediaInfo.title).then(hits => {
      const match = findBestMatch(hits, mediaInfo);
      if (!match) {
        console.log('[MoviesDrive] No matching title found');
        return [];
      }
      console.log(`[MoviesDrive] Matched: "${match.post_title}"`);
      const pageUrl = match.permalink && match.permalink.startsWith('http')
        ? match.permalink
        : new URL(match.permalink, domain).toString();

      return fetch(pageUrl, { headers: HEADERS })
        .then(res => res.text())
        .then(html => {
          const $ = cheerio.load(html);
          return mediaType === 'tv'
            ? getTvStreams($, season, episode, label)
            : getMovieStreams($, label);
        });
    });
  })
    .then(streams => {
      console.log(`[MoviesDrive] Found ${streams.length} candidate stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => `${v.stream.name} ${v.stream.quality}`);
        if (dead.length) console.log(`[MoviesDrive] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[MoviesDrive] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    })
    .catch(err => {
      console.log(`[MoviesDrive] getStreams failed: ${err.message}`);
      return [];
    });
}
  return { getStreams: getStreams };
})();

const RogMoviesSource = (function () {
// RogMovies scraper.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json
//                     ["rogmovies"] - confirmed live (2026-09-28) that even
//                     this always-rotating value is already stale by the
//                     time it's read: new2.rogmovies.click answers with a
//                     Cloudflare 301 chain (new2.rogmovies.click ->
//                     n1.rogmovies.best -> rogmovies.best). fetch() follows
//                     redirects by default, so requests built from the
//                     domains.json value still land correctly - but the
//                     final resolved origin (from response.url) is cached
//                     instead of the pre-redirect one, so later requests
//                     skip paying for two redirect hops every time.
//   search         -> GET {domain}/search.php?q={query} - a Typesense-style
//                     JSON index (facet_counts/hits/found) whose per-hit
//                     "document" shape (id, imdb_id, permalink, post_title,
//                     post_thumbnail) is identical to VegaMovies's own
//                     search.php - confirmed live these two sites share the
//                     same backend (a resolved RogMovies download even
//                     carried a "-Vegamovies.to.mkv" filename suffix).
//                     Confirmed live the index is typo-tolerant enough to
//                     return unrelated hits for a query with no real match
//                     (searching "Inception" fuzzy-matched "...The
//                     Deception..." titles, zero actual hits) - matching on
//                     imdb_id/word-overlap below is required, not optional.
//   movie page     -> one nexdrive.fit hub link per quality: an h5 heading
//                     carrying the quality text (e.g. "... 1080p 10Bit
//                     WEB-DL x265 [2GB]"), immediately followed by a
//                     `<p><a href="hub"><button class="dwd-button">Download
//                     Now</button></a></p>` - confirmed live via direct HTML
//                     inspection, matching the decompiled StreamPlay
//                     extension's `button.dwd-button` selector.
//   series page    -> one nexdrive.fit hub link per (season, quality) pair:
//                     an h3 heading like "Season 2 (Episode 1 - 3 Added)
//                     {HiNDi-Series} 720p WEB-DL x264 [1GB/E]" followed by a
//                     "G-Direct [Instant]" button in the same <p>. That hub
//                     page lists every episode for that (season, quality),
//                     each under its own "-:Episode: N:-" h4 heading with
//                     its own G-Direct link right after - so an episode is
//                     found by matching heading text, not by position in a
//                     list (confirmed live: RogMovies's own headings don't
//                     guarantee episode 1 is listed first-and-only-once the
//                     way VegaMovies's flat "Episode Links" list does).
//   nexdrive.fit   -> "G-Direct [Instant]" is a fastdl.zip/embed(.php) link
//                     containing a plain `var reurl = "https://fastdl.zip/dl.php?link=<real
//                     googleusercontent.com URL>"` in static HTML - the
//                     exact same mechanism vegamovies.js already documented
//                     for its own G-Direct handling, no JS execution needed.
//                     "V-Cloud" (vcloud.fit) is confirmed live behind a real
//                     Cloudflare managed challenge (plain HTTP request gets
//                     a 403 "Just a moment..." page), and "Filepress"
//                     (filebee.xyz, which itself 301s to a rt.filepress.baby
//                     mirror) failed to even establish a connection in
//                     testing - both skipped, matching vegamovies.js's own
//                     documented reasoning for the same two resolvers.

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://new2.rogmovies.click';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

// Reads domains.json, then follows that value's own redirect chain once
// (confirmed live: two Cloudflare 301 hops as of 2026-09-28) so every
// subsequent request in this run starts from the actually-final origin
// instead of paying for the same two redirects every time.
function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetch(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => ((data && data.rogmovies) || DEFAULT_DOMAIN).replace(/\/+$/, ''))
    .catch(() => DEFAULT_DOMAIN)
    .then(domain => fetch(domain + '/', { headers: HEADERS })
      .then(res => {
        const resolved = (res.url || domain).replace(/\/+$/, '');
        cachedDomain = resolved;
        cachedDomainAt = Date.now();
        console.log(`[RogMovies] Using domain: ${resolved}`);
        return resolved;
      })
      .catch(() => {
        cachedDomain = domain;
        cachedDomainAt = Date.now();
        return domain;
      }));
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
      console.log(`[RogMovies] TMDB Info: "${title}" (${year}) imdb=${imdbId || 'none'}`);
      return { title, year, imdbId };
    })
    .catch(() => ({ title: '', year: '', imdbId: null }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function search(domain, query) {
  return fetch(`${domain}/search.php?q=${encodeURIComponent(query)}`, { headers: HEADERS })
    .then(res => res.ok ? res.json() : null)
    .then(data => (data && Array.isArray(data.hits)) ? data.hits.map(h => h.document).filter(Boolean) : [])
    .catch(() => []);
}

// Same two-tier strategy vegamovies.js uses against this same search index
// shape: an exact imdb_id hit is unambiguous, otherwise fall back to
// word-overlap scoring with a hard reject on a conflicting release year (a
// same-named unrelated title otherwise wins purely on word overlap for
// short common titles).
function findBestMatch(docs, mediaInfo) {
  if (!docs.length) return null;
  if (mediaInfo.imdbId) {
    const exact = docs.find(d => d.imdb_id && d.imdb_id === mediaInfo.imdbId);
    if (exact) return exact;
  }
  const targetWords = new Set(normalize(mediaInfo.title).split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const doc of docs) {
    if (!doc.post_title) continue;
    const postYearMatch = doc.post_title.match(/\b(19|20)\d{2}\b/);
    if (mediaInfo.year && postYearMatch && Math.abs(parseInt(postYearMatch[0], 10) - parseInt(mediaInfo.year, 10)) > 1) {
      continue;
    }
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
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 2160 ? '4K' : `${n}p`;
  }
  const lower = str.toLowerCase();
  if (lower.includes('4k') || lower.includes('uhd')) return '4K';
  return 'Unknown';
}

function getSizeLabel(str) {
  const m = String(str || '').match(/([\d.]+\s*(?:GB|MB|TB))/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

function findLinkByText($, root, pattern) {
  let href = null;
  root.find('a').each((i, el) => {
    if (href) return;
    if (pattern.test($(el).text())) href = $(el).attr('href');
  });
  return href;
}

// The G-Direct embed page (either /embed?download= on a movie hub or
// /embed.php?download= on an episode hub - confirmed live both resolve the
// same way) is a plain "redirecting..." shell containing
// `var reurl = "https://fastdl.zip/dl.php?link=<real file URL>"` in static
// HTML - no JS execution needed.
function extractGDirectFinalUrl(embedUrl) {
  return fetch(embedUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const m = html.match(/var\s+reurl\s*=\s*"([^"]+)"/);
      if (!m) return null;
      const linkMatch = m[1].match(/[?&]link=(.+)$/);
      return linkMatch ? linkMatch[1] : m[1];
    })
    .catch(() => null);
}

// A movie's download hub (reached via its "Download Now" / dwd-button link)
// offers several resolvers - only G-Direct is usable here (see file header).
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

function extractMovieTargets($) {
  const targets = [];
  $('h3, h4, h5').each((i, el) => {
    const text = $(el).text().trim();
    if (!/\d{3,4}\s*[pP]|4K/i.test(text)) return;
    const hubUrl = $(el).next().find('button.dwd-button').parent('a').attr('href')
      || findLinkByText($, $(el).next(), /.+/);
    if (hubUrl) targets.push({ qualityText: text, hubUrl });
  });
  return targets;
}

function extractSeriesTargets($, season) {
  const targets = [];
  $('h3, h4, h5').each((i, el) => {
    const text = $(el).text().trim();
    const seasonMatch = text.match(/Season\s*(\d+)/i);
    if (!seasonMatch || parseInt(seasonMatch[1], 10) !== season) return;
    if (!/\d{3,4}\s*[pP]|4K/i.test(text)) return;
    const hubUrl = findLinkByText($, $(el).next(), /G-Direct/i);
    if (hubUrl) targets.push({ qualityText: text, hubUrl });
  });
  return targets;
}

// The episode-list hub gives one "-:Episode: N:-" heading per episode, each
// immediately followed by its own G-Direct link - matched by heading text
// rather than position, since a season pack can be added to incrementally
// (e.g. "Episode 1 - 3 Added") and there's no guarantee episode order in the
// markup lines up with a plain index.
function extractEpisodeHubUrl($, episode) {
  const episodeRegex = new RegExp(`Episode:?\\s*${episode}\\b`, 'i');
  let hubUrl = null;
  $('h3, h4, h5').each((i, el) => {
    if (hubUrl) return;
    if (!episodeRegex.test($(el).text())) return;
    hubUrl = findLinkByText($, $(el).next(), /G-Direct/i);
  });
  return hubUrl;
}

function buildStream(url, qualityText, label) {
  return {
    name: 'RogMovies',
    title: `${label}\n${qualityText.replace(/\s+/g, ' ').trim()}`,
    url,
    quality: getIndexQuality(qualityText),
    size: getSizeLabel(qualityText),
    headers: HEADERS,
    provider: 'rogmovies'
  };
}

// Status alone isn't reliable (a dead resolver can still answer 200 with an
// error page instead of the file) - an .m3u8 link is GET-checked for a real
// playlist body, matching cinejoy.js/peachify.js; a direct file link only
// gets a cheap HEAD (falling back to a tiny ranged GET for hosts that
// reject HEAD), matching vegamovies.js.
function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return fetch(stream.url, { headers: stream.headers })
      .then(res => (res.ok ? res.text().then(text => /^#EXTM3U/.test(text.trim())) : false))
      .catch(() => false);
  }
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
    fetch(t.hubUrl, { headers: HEADERS })
      .then(res => res.text())
      .then(html => {
        const $$ = cheerio.load(html);
        const episodeGDirect = extractEpisodeHubUrl($$, episode);
        if (!episodeGDirect) return null;
        return extractGDirectFinalUrl(episodeGDirect).then(url => url ? buildStream(url, t.qualityText, `${label} S${season}E${episode}`) : null);
      })
      .catch(() => null)
  )).then(streams => streams.filter(Boolean));
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[RogMovies] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[RogMovies] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return search(domain, mediaInfo.title).then(docs => {
      const match = findBestMatch(docs, mediaInfo);
      if (!match || !match.permalink) {
        console.log(`[RogMovies] No matching title found for "${mediaInfo.title}"`);
        return [];
      }
      console.log(`[RogMovies] Matched: "${match.post_title}"`);
      const pageUrl = new URL(match.permalink, domain).toString();

      return fetch(pageUrl, { headers: HEADERS })
        .then(res => res.text())
        .then(html => {
          const $ = cheerio.load(html);
          return mediaType === 'tv'
            ? getSeriesPageStreams($, season, episode, label)
            : getMoviePageStreams($, label);
        });
    }).then(streams => {
      if (!streams.length) return streams;
      console.log(`[RogMovies] Found ${streams.length} stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => `${v.stream.name} ${v.stream.quality}`);
        if (dead.length) console.log(`[RogMovies] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[RogMovies] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    });
  }).catch(err => {
    console.log(`[RogMovies] getStreams failed: ${err.message}`);
    return [];
  });
}
  return { getStreams: getStreams };
})();

const TopMoviesSource = (function () {
// TopMovies scraper.
//
// Ported from the CloudStream "StreamPlay" plugin's invokeTopMovies
// (decompiled from StreamPlay.cs3 - normal-mode decompilation FAILED for
// this specific method and fell back to raw register-level pseudo-code,
// which was read directly), then verified live end-to-end against the real
// site and adapted where the live site no longer matched the decompiled
// assumptions.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["topMovies"]
//                     (re-fetched at runtime; last confirmed live value:
//                     https://moviesleech.club - the on-site branding now
//                     reads "Movies Leech", but files served still carry a
//                     "TopMovies.quest" tag in their own filenames,
//                     confirming this is the same backend/content, just
//                     under a rotated domain+brand)
//   search         -> GET {domain}/?s={query}  (plain WordPress search,
//                     redirects to /search/{query}; both confirmed live with
//                     no Cloudflare challenge) - "#content_box article" holds
//                     one entry per matching post
//   movie page     -> one "Download Links" button per quality
//                     (a.maxbutton-download-links), with the quality+size
//                     heading sitting right above each one
//   series page    -> one "G-Drive" button per quality (a.maxbutton-g-drive)
//                     leading to an episode-list hub page with one
//                     "Episode N" link (plus a duplicate <strong>) per
//                     episode
//   quality page   -> a leechpro.blog/archives/{id} page with one "Fast
//                     Server (G-Drive)" button whose href is a
//                     cloud.unblockedgames.world/?sid=... redirect gate
//   unblockedgames -> a 3-step hidden-form POST dance (the exact same
//                     mechanism as uhdmovies.js's own bypassHrefli, same
//                     gate site) that ends on a driveseed.org/file/{id} page
//   driveseed page -> "Instant Download" routes through a video-seed-family
//                     gateway (video-gen.xyz confirmed live) that 302s to
//                     video-seed.dev/?url=<real file URL> - confirmed live
//                     the URL there is already a directly playable
//                     video-downloads.googleusercontent.com link, no further
//                     decryption needed for that particular gateway host.
//                     "Resume Cloud" is skipped - same site family as
//                     uhdmovies.js, confirmed gated behind a real Cloudflare
//                     Turnstile challenge with no available bypass.
//
// Verified live end-to-end (2026-09-28): Animal (2023, tmdb 1011477),
// "FHD 1080p" quality -> a real video/mkv, ~4.7GB, HTTP 200 direct download
// from video-downloads.googleusercontent.com. Series flow (Mirzapur S3,
// tmdb 210265) confirmed live through the same episode-hub -> gate ->
// driveseed chain up to the point of finding the per-episode link.

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://moviesleech.club';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

// The gate/driveseed/video-seed chain below is several sequential hops deep
// per quality item, against third-party sites this provider doesn't control
// - a bounded per-request timeout with one retry keeps a single hung hop
// from stalling the whole request indefinitely. Feature-detected (rather
// than assumed) since some CloudStream-derived JS runtimes have neither
// AbortController nor setTimeout, matching the same defensive pattern used
// in uhdmovies.js/4khdhub.js in this repo.
const FETCH_TIMEOUT_MS = 12000;
const HAS_ABORT_TIMER = typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined';

function fetchWithTimeout(url, options, attemptsLeft) {
  if (attemptsLeft === undefined) attemptsLeft = 1;
  if (!HAS_ABORT_TIMER) {
    return fetch(url, options).catch(err => {
      if (attemptsLeft <= 0) throw err;
      return fetchWithTimeout(url, options, attemptsLeft - 1);
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(res => { clearTimeout(timer); return res; })
    .catch(err => {
      clearTimeout(timer);
      if (attemptsLeft <= 0) throw err;
      return fetchWithTimeout(url, options, attemptsLeft - 1);
    });
}

function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetchWithTimeout(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const domain = ((data && data.topMovies) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[TopMovies] Using domain: ${domain}`);
      return domain;
    })
    .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetchWithTimeout(url, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[TopMovies] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

// Matches the site's own search-query cleanup confirmed in the decompiled
// source: strip quote characters, normalize dash/colon/underscore separators
// to spaces, collapse whitespace.
function cleanQuery(title) {
  return String(title || '')
    .replace(/['’]/g, '')
    .replace(/[:\-–_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/&#8[0-9]{3};/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Confirmed live: GET {domain}/?s={query} 302s to {domain}/search/{query}
// with no Cloudflare challenge either way - fetch() follows that redirect on
// its own, so this just reads whichever page comes back.
function search(domain, query) {
  const url = `${domain}/?s=${encodeURIComponent(query)}`;
  return fetchWithTimeout(url, { headers: HEADERS })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      const results = [];
      const seen = new Set();
      $('#content_box article, #content_box .post-cards article').each((_, el) => {
        const $el = $(el);
        const href = $el.find('a[href]').first().attr('href');
        const title = $el.find('h2.title, .title').first().text().trim()
          || $el.find('a[title]').first().attr('title')
          || $el.find('a').first().text().trim();
        if (!href || !title || seen.has(href)) return;
        seen.add(href);
        results.push({ href, title });
      });
      return results;
    })
    .catch(() => []);
}

// Post titles are always "Download <name> ..." - word-overlap scored against
// the TMDB title, with a year check for movies and a season-number check
// (extracted from the post title, e.g. "(Season 3)") for TV, since a plain
// title search returns every season's post together.
function findBestMatch(posts, mediaInfo, mediaType, season) {
  const targetTitle = normalize(mediaInfo.title);
  if (!targetTitle) return null;
  const targetWords = targetTitle.split(' ').filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const post of posts) {
    const postNorm = normalize(post.title).replace(/^download\s+/, '');
    const postWords = postNorm.split(' ').filter(Boolean);
    const overlap = targetWords.filter(w => postWords.includes(w)).length;
    let score = targetWords.length ? overlap / targetWords.length : 0;
    if (score < 0.6) continue;

    if (mediaType === 'tv') {
      const seasonMatch = /season\s*(\d+)/i.exec(post.title);
      if (season && seasonMatch) {
        if (parseInt(seasonMatch[1], 10) !== parseInt(season, 10)) continue;
        score += 0.5;
      } else if (season && !seasonMatch) {
        score -= 0.1;
      }
    } else {
      const yearMatch = /\b(19|20)\d{2}\b/.exec(post.title);
      if (mediaInfo.year && yearMatch) {
        if (Math.abs(parseInt(yearMatch[0], 10) - parseInt(mediaInfo.year, 10)) > 1) continue;
        score += 0.5;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = post;
    }
  }
  return best;
}

function getIndexQuality(str) {
  if (!str) return 'Unknown';
  const m = String(str).match(/(\d{3,4})\s*[pP]/);
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 2000 ? '2160p' : `${n}p`;
  }
  if (/4K|UHD/i.test(str)) return '2160p';
  return 'Unknown';
}

function getSizeLabel(str) {
  const m = String(str || '').match(/([\d.]+\s*(?:GB|MB|TB))/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

const QUALITY_RANK = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, Unknown: 0 };
// Each item below costs roughly 8-10 sequential network hops (quality page,
// fast-server page, the 5-hop gate bypass, driveseed page, video-seed
// gateway) - fanning out to every quality on a page (up to 6+ confirmed
// live) would make a single request very slow for little benefit once the
// top few qualities are covered, so only the best-ranked few are resolved.
const MAX_ITEMS = 3;

// Movie page: one "Download Links" button per quality; series page: one
// "G-Drive" button per quality leading to an episode hub. Both sit right
// after their own quality/size heading - confirmed live by walking up to
// the nearest preceding h1-h6.
function extractQualityItems($, selector) {
  const items = [];
  $(selector).each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let cur = $(el).closest('p, div, li, h1, h2, h3, h4, h5, h6');
    let heading = null;
    let hops = 0;
    while (cur.length && !heading && hops < 8) {
      const prev = cur.prev();
      if (prev.length && /^h[1-6]$/i.test(prev.get(0).tagName)) heading = prev.text().trim();
      else if (cur.get(0) && /^h[1-6]$/i.test(cur.get(0).tagName)) heading = cur.text().trim();
      cur = prev.length ? prev : cur.parent();
      hops++;
    }
    items.push({ href, heading: heading || '' });
  });
  return items;
}

function topItemsByQuality(items) {
  return items
    .slice()
    .sort((a, b) => (QUALITY_RANK[getIndexQuality(b.heading)] || 0) - (QUALITY_RANK[getIndexQuality(a.heading)] || 0))
    .slice(0, MAX_ITEMS);
}

const BYPASS_MARKERS = ['unblockedgames', 'thenaukriadda', 'href.li'];

function needsBypass(url) {
  return BYPASS_MARKERS.some(m => url.includes(m));
}

function getBaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return '';
  }
}

function fixUrl(url, domain) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return domain + url;
  return `${domain}/${url}`;
}

// A hidden-form 3-step POST dance used by cloud.unblockedgames.world (and
// its sibling gate domains) to land on the real driveseed/driveleech page -
// the exact same mechanism as uhdmovies.js's own bypassHrefli (same gate
// site), confirmed live end-to-end here too.
function bypassGate(url) {
  const host = getBaseUrl(url);
  return fetchWithTimeout(url, { headers: HEADERS })
    .then(res => res.text())
    .then(html1 => {
      const $1 = cheerio.load(html1);
      const formUrl1 = $1('form#landing').attr('action');
      if (!formUrl1) return null;
      const formData1 = {};
      $1('form#landing input').each((_, el) => { formData1[$1(el).attr('name')] = $1(el).attr('value') || ''; });
      return fetchWithTimeout(formUrl1, {
        method: 'POST',
        headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: new URLSearchParams(formData1).toString()
      })
        .then(res => res.text())
        .then(html2 => {
          const $2 = cheerio.load(html2);
          const formUrl2 = $2('form#landing').attr('action');
          if (!formUrl2) return null;
          const formData2 = {};
          $2('form#landing input').each((_, el) => { formData2[$2(el).attr('name')] = $2(el).attr('value') || ''; });
          return fetchWithTimeout(formUrl2, {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }),
            body: new URLSearchParams(formData2).toString()
          })
            .then(res => res.text())
            .then(html3 => {
              const $3 = cheerio.load(html3);
              const script = $3('script:contains(?go=)').html() || '';
              const skTokenMatch = script.match(/\?go=([^"]+)/);
              if (!skTokenMatch) return null;
              const skToken = skTokenMatch[1];
              const wpHttp2 = formData2._wp_http2 || '';
              return fetchWithTimeout(`${host}?go=${skToken}`, {
                headers: Object.assign({}, HEADERS, { Cookie: `${skToken}=${wpHttp2}` })
              })
                .then(res => res.text())
                .then(html4 => {
                  const $4 = cheerio.load(html4);
                  const metaRefresh = $4('meta[http-equiv="refresh"]').attr('content') || '';
                  const driveUrlMatch = metaRefresh.match(/url=(.+)/);
                  if (!driveUrlMatch) return null;
                  const driveUrl = driveUrlMatch[1];
                  return fetchWithTimeout(driveUrl, { headers: HEADERS })
                    .then(res => res.text())
                    .then(html5 => {
                      const pathMatch = html5.match(/replace\("([^"]+)"\)/);
                      if (!pathMatch || pathMatch[1] === '/404') return null;
                      return fixUrl(pathMatch[1], getBaseUrl(driveUrl));
                    });
                });
            });
        });
    })
    .catch(() => null);
}

// A gateway landing on its own ?url=<real file URL> (video-seed.dev,
// confirmed live) hands back an already-playable link directly. Other
// gateway hosts in the same family instead put an encrypted token in the
// path/query that needs one more POST to that host's own /api to decrypt -
// same fallback uhdmovies.js uses for this identical gateway family.
function extractVideoSeedToken(finalLink) {
  return Promise.resolve()
    .then(() => {
      const urlObj = new URL(finalLink);
      const host = urlObj.host;
      const token = finalLink.includes('url=') ? finalLink.split('url=')[1] : (urlObj.pathname || '').replace(/^\//, '');
      if (!token) return null;
      return fetchWithTimeout(`https://${host}/api`, {
        method: 'POST',
        headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded', 'x-token': host, Referer: finalLink }),
        body: `keys=${encodeURIComponent(token)}`
      })
        .then(res => res.text())
        .then(text => {
          const m = text.match(/url":"([^"]+)"/);
          return m ? m[1].replace(/\\\//g, '/') : null;
        });
    })
    .catch(() => null);
}

function extractDriveseedStream(pageUrl, meta) {
  return fetchWithTimeout(pageUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const sizeText = $('li.list-group-item').eq(2).text().replace(/^Size\s*:/i, '').trim();
      const titleText = $('li.list-group-item').first().text().replace(/^Name\s*:/i, '').trim();
      const instantHref = $('div.text-center > a')
        .filter((_, el) => /instant download/i.test($(el).text()))
        .attr('href');
      if (!instantHref) return null;
      return fetchWithTimeout(instantHref, { headers: HEADERS, redirect: 'follow' })
        .then(res => {
          const landedUrl = res.url || instantHref;
          const afterUrlParam = landedUrl.includes('url=') ? landedUrl.split('url=')[1] : '';
          if (afterUrlParam && afterUrlParam.startsWith('http')) return afterUrlParam;
          return extractVideoSeedToken(landedUrl);
        })
        .then(finalUrl => {
          if (!finalUrl) return null;
          return {
            url: finalUrl,
            title: titleText || meta.title,
            size: getSizeLabel(sizeText) || meta.size,
            quality: meta.quality
          };
        });
    })
    .catch(() => null);
}

function resolveQualityItem(item, referer) {
  return fetchWithTimeout(item.href, { headers: Object.assign({}, HEADERS, { Referer: referer }) })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const fastServerHref = $("a.maxbutton-fast-server-gdrive, a[class*='fast-server-gdrive'], a[class*='maxbutton']:contains(Fast Server)").first().attr('href');
      if (!fastServerHref) return null;
      const resolved = needsBypass(fastServerHref) ? bypassGate(fastServerHref) : Promise.resolve(fastServerHref);
      return resolved.then(driveseedUrl => {
        if (!driveseedUrl) return null;
        return extractDriveseedStream(driveseedUrl, {
          title: item.heading,
          size: getSizeLabel(item.heading),
          quality: getIndexQuality(item.heading)
        });
      });
    })
    .catch(() => null);
}

function resolveSeriesQualityItem(item, referer, episode) {
  return fetchWithTimeout(item.href, { headers: Object.assign({}, HEADERS, { Referer: referer }) })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const episodeRegex = new RegExp(`.*Episode\\s+${episode}\\b.*`, 'i');
      let episodeHref = null;
      $('span strong, p, a').each((_, el) => {
        if (episodeHref) return;
        const $el = $(el);
        if (!episodeRegex.test($el.text().trim())) return;
        if (el.tagName && el.tagName.toLowerCase() === 'a') {
          episodeHref = $el.attr('href');
        } else {
          const parentA = $el.parent().closest('a');
          episodeHref = parentA.length ? parentA.attr('href') : $el.closest('a').attr('href');
        }
      });
      if (!episodeHref) return null;
      const resolved = needsBypass(episodeHref) ? bypassGate(episodeHref) : Promise.resolve(episodeHref);
      return resolved.then(driveseedUrl => {
        if (!driveseedUrl) return null;
        return extractDriveseedStream(driveseedUrl, {
          title: item.heading,
          size: getSizeLabel(item.heading),
          quality: getIndexQuality(item.heading)
        });
      });
    })
    .catch(() => null);
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

// Dead/expired links get filtered out here automatically rather than being
// handed back as "working" streams - a live HEAD/ranged-GET check, plus a
// real #EXTM3U body check for .m3u8 links (status alone isn't reliable),
// matching the approach in cinejoy.js/peachify.js in this repo.
function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return fetchWithTimeout(stream.url, { headers: stream.headers })
      .then(res => {
        if (!res.ok) return false;
        return res.text().then(text => /^#EXTM3U/.test(text.trim()));
      })
      .catch(() => false);
  }
  return fetchWithTimeout(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => fetchWithTimeout(stream.url, { method: 'GET', headers: Object.assign({}, stream.headers, { Range: 'bytes=0-2048' }) })
      .then(res => res.ok || res.status === 206)
      .catch(() => false));
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[TopMovies] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[TopMovies] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)])
    .then(([domain, mediaInfo]) => {
      if (!mediaInfo.title) return [];
      const query = cleanQuery(mediaInfo.title);

      return search(domain, query).then(posts => {
        const match = findBestMatch(posts, mediaInfo, mediaType, season);
        if (!match) {
          console.log(`[TopMovies] No matching title found for "${mediaInfo.title}"`);
          return [];
        }
        console.log(`[TopMovies] Matched: "${match.title}"`);

        return fetchWithTimeout(match.href, { headers: HEADERS }).then(res => res.text()).then(html => {
          const $ = cheerio.load(html);
          const referer = `${domain}/`;

          if (mediaType === 'tv') {
            const items = topItemsByQuality(extractQualityItems($, "a.maxbutton-g-drive, a[class*='maxbutton']:contains(G-Drive)"));
            if (!items.length) {
              console.log('[TopMovies] No G-Drive quality links found on series page');
              return [];
            }
            console.log(`[TopMovies] ${items.length} quality item(s) found, resolving episode ${episode}`);
            return Promise.all(items.map(item => resolveSeriesQualityItem(item, referer, episode)));
          }

          const items = topItemsByQuality(extractQualityItems($, "a.maxbutton-download-links, a[class*='maxbutton']:contains(Download)"));
          if (!items.length) {
            console.log('[TopMovies] No download quality links found on movie page');
            return [];
          }
          console.log(`[TopMovies] ${items.length} quality item(s) found, resolving`);
          return Promise.all(items.map(item => resolveQualityItem(item, referer)));
        });
      });
    })
    .then(results => {
      const streams = (results || []).filter(Boolean).map(r => ({
        name: `TopMovies - ${r.quality}`,
        title: `${r.title}${r.size ? `\n${r.size}` : ''}`,
        url: r.url,
        quality: r.quality,
        headers: HEADERS,
        provider: 'topmovies'
      }));
      if (!streams.length) return [];
      console.log(`[TopMovies] Found ${streams.length} candidate stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
        if (dead.length) console.log(`[TopMovies] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[TopMovies] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    })
    .catch(err => {
      console.log(`[TopMovies] getStreams failed: ${err.message}`);
      return [];
    });
}
  return { getStreams: getStreams };
})();

const HdMovie2Source = (function () {
// HdMovie2 scraper.
//
// Reference: the CloudStream "StreamPlay" plugin's decompiled Kotlin
// (com.phisher98.StreamPlayExtractor#invokeHdmovie2) was read for background,
// but confirmed LIVE (2026-09-28) to have drifted on every load-bearing point:
//   - It builds a guessed detail URL "{domain}/movies/{slug(title)}-{year}/"
//     with no search step at all. Live, that guess almost never matches: older
//     posts prefix the slug with the WP numeric post ID
//     ("/movies/40228-roy-2015-hindi-hd/"), newer ones don't
//     ("/movies/snake-woman-2025-hindi-dubbed/"), and none of them follow a
//     plain "{slug}-{year}" shape. A real search is required.
//   - The standard WordPress "?s=" search query is behind a real Cloudflare
//     Managed Challenge ("Just a moment...") - confirmed live to 403
//     consistently. This is a narrow WAF rule on the literal "s=" query
//     string, not general bot management: "/?foo=bar" and "/genre/action/"
//     both 200 fine, only "?s=" 403s. The theme's own pretty-permalink search
//     route, "/search/{query}/" (same WP search under the hood, but no
//     literal "s=" in the request URI), is NOT covered by that rule and
//     returns real results - confirmed live, e.g. /search/Inception/ finds
//     "movies/85962-inception-2010-hindi-dubbed/".
//   - Each player "server" option's own `<a data-source="...">` already IS
//     the final embed URL - the page's own JS just swaps an iframe's src on
//     click. There's no admin-ajax.php POST (action=doo_player_ajax,
//     data-post/data-nume) round trip to make at all anymore.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["hdmovie2"]
//   search         -> GET {domain}/search/{query}/  (see above - sidesteps the ?s= WAF rule)
//   search result  -> .search-results-list .result-item: a.result-thumb[href],
//                     h2.result-title a text ("Title (Year) tags..."). The
//                     site's "movies" post type is used for both movies and
//                     TV (a season is one "... Season N Complete" post) - the
//                     result list never distinguishes the two, so matching has
//                     to be done from the title text.
//   detail page    -> #video-sources.dooplay_player .options li.dooplay_player_option
//                     a[data-source], one per "server". A season-pack post
//                     labels each episode's option "... EP01".."EP10" etc
//                     (confirmed live, Mirzapur S3, zero-padded); a movie's
//                     options are unlabeled server names ("Ultra Stream V2/V3",
//                     "Ultra Stream 2", "Fast Player", ...). "Watch trailer"
//                     (YouTube) options are always skipped.
//   own stream host -> the site's own player domain rotates too (hdm2.biz,
//                     molop.art confirmed live, both labeled "Ultra Stream
//                     Vx") - not tracked in domains.json, just taken as-is
//                     from data-source each time. It's a self-hosted JWPlayer
//                     embed: a `<script id="player-loader"
//                     data-stream-url="/playlist/<token>?v=..&tok=<jwt>">` tag
//                     on the embed page. That data-stream-url, resolved
//                     against the embed page's own origin, IS the final
//                     signed HLS master playlist - confirmed live with a real
//                     "#EXTM3U" body, and no special headers are needed (the
//                     JWT alone authorizes it; ~3h expiry observed).
//   other hosts    -> "Ultra Stream 2" (prvs.top) was confirmed live
//                     UNREACHABLE (TLS handshake failure from both curl and
//                     Node) at scrape time. "Fast Player" (ok.ru embed) has no
//                     player-loader script at all. Both fall through the
//                     generic player-loader extraction below and are simply
//                     dropped, same as any other unrecognized host - no
//                     per-host guessing is attempted for them.

const cheerio = require('cheerio');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://hdmovie2a.biz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetch(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const domain = ((data && data.hdmovie2) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[HdMovie2] Using domain: ${domain}`);
      return domain;
    })
    .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[HdMovie2] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: null, year: '' }));
}

function normalizeWords(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function titleOverlapScore(candidateTitle, targetWords) {
  if (!targetWords.length) return 0;
  const candSet = new Set(normalizeWords(candidateTitle));
  const overlap = targetWords.filter(w => candSet.has(w)).length;
  return overlap / targetWords.length;
}

// The pretty-permalink search route - see file header for why this is used
// instead of the theme's own "?s=" query var.
function search(domain, query) {
  const url = `${domain}/search/${encodeURIComponent(query)}/`;
  return fetch(url, { headers: HEADERS })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      const results = [];
      $('.search-results-list .result-item').each((_, el) => {
        const href = $(el).find('a.result-thumb').attr('href') || $(el).find('h2.result-title a').attr('href');
        const title = $(el).find('h2.result-title a').text().trim();
        if (href && title) results.push({ href, title });
      });
      return results;
    })
    .catch(() => []);
}

function findBestMovieMatch(results, mediaInfo) {
  const targetWords = normalizeWords(mediaInfo.title);
  if (!targetWords.length) return null;
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    if (/season\s*0*\d+/i.test(r.title)) continue; // a TV season pack, not a movie
    const yearMatch = r.title.match(/\((\d{4})\)/);
    let score = titleOverlapScore(r.title, targetWords);
    if (mediaInfo.year && yearMatch) {
      score += yearMatch[1] === String(mediaInfo.year) ? 0.5 : -0.3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

// TV shows are posted as one "... Season N Complete" post per season - year
// in the title tracks that season's own air year, not TMDB's first_air_date,
// so season number (not year) is what disambiguates here.
function findBestSeriesMatch(results, mediaInfo, season) {
  const targetWords = normalizeWords(mediaInfo.title);
  if (!targetWords.length) return null;
  const candidates = results.filter(r => titleOverlapScore(r.title, targetWords) >= 0.6 && !/\bmovie\b/i.test(r.title));
  if (!candidates.length) return null;
  const seasonPat = new RegExp(`season\\s*0*${season}\\b`, 'i');
  const withSeason = candidates.filter(r => seasonPat.test(r.title));
  let pool = withSeason;
  if (!pool.length && season === 1 && !candidates.some(r => /season\s*0*\d+/i.test(r.title))) {
    // Single-season shows sometimes never bother labeling a season at all.
    pool = candidates;
  }
  if (!pool.length) return null;
  let best = null;
  let bestScore = -1;
  for (const r of pool) {
    const score = titleOverlapScore(r.title, targetWords);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

function extractPlayerOptions($) {
  const options = [];
  $('#video-sources .dooplay_player_option, .dooplay_player .dooplay_player_option').each((_, el) => {
    const a = $(el).find('a[data-source]');
    const src = a.attr('data-source');
    const label = a.find('.title').text().trim() || a.text().trim();
    const server = a.find('.server').text().trim();
    if (!src) return;
    if (/trailer/i.test(label) || /youtube/i.test(server) || /youtube\.com/i.test(src)) return;
    options.push({ label, src: src.startsWith('//') ? `https:${src}` : src });
  });
  return options;
}

// A season pack labels each episode's option "... EP01".."EP10" (zero-padded)
// - confirmed live, Mirzapur S3. Match both the zero-padded and bare forms.
function optionsForEpisode(options, episode) {
  const padded = `EP${String(episode).padStart(2, '0')}`;
  const bare = new RegExp(`EP\\s*0*${episode}\\b`, 'i');
  return options.filter(o => o.label.toUpperCase().includes(padded) || bare.test(o.label));
}

// See file header: the site's own "Ultra Stream" embed is a self-hosted
// JWPlayer page whose #player-loader script's data-stream-url attribute,
// resolved against the embed page's own origin, is already the final signed
// HLS master playlist. Any other embed shape (no such script) is left
// unsupported and resolves to null.
function resolveEmbedToStream(embedUrl, refererUrl) {
  return fetch(embedUrl, { headers: Object.assign({}, HEADERS, { Referer: refererUrl }) })
    .then(res => (res.ok ? res.text() : null))
    .then(html => {
      if (!html) return null;
      const $ = cheerio.load(html);
      const dataStreamUrl = $('#player-loader').attr('data-stream-url');
      if (!dataStreamUrl) return null;
      return new URL(dataStreamUrl, embedUrl).toString();
    })
    .catch(() => null);
}

// Confirmed live: the resolved URL is always a real HLS master playlist for
// this provider (it only ever comes from the player-loader extraction above),
// so status alone isn't enough - require the body to actually start with
// #EXTM3U, same standard as cinejoy.js/peachify.js.
function validateStreamUrl(stream) {
  return fetch(stream.url, { headers: stream.headers })
    .then(res => {
      if (!res.ok) return false;
      return res.text().then(text => /^#EXTM3U/.test(text.trim()));
    })
    .catch(() => false);
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[HdMovie2] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[HdMovie2] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)])
    .then(([domain, mediaInfo]) => {
      if (!mediaInfo.title) return [];
      return search(domain, mediaInfo.title).then(results => {
        if (!results.length) {
          console.log(`[HdMovie2] No search results for "${mediaInfo.title}"`);
          return [];
        }
        const match = mediaType === 'tv'
          ? findBestSeriesMatch(results, mediaInfo, season)
          : findBestMovieMatch(results, mediaInfo);
        if (!match) {
          console.log(`[HdMovie2] No matching title found for "${mediaInfo.title}"`);
          return [];
        }
        console.log(`[HdMovie2] Matched: "${match.title}" -> ${match.href}`);

        return fetch(match.href, { headers: HEADERS })
          .then(res => res.text())
          .then(html => {
            const $ = cheerio.load(html);
            let options = extractPlayerOptions($);
            if (mediaType === 'tv') options = optionsForEpisode(options, episode);
            if (!options.length) {
              console.log('[HdMovie2] No usable player options found on detail page');
              return [];
            }
            return Promise.all(options.map(opt =>
              resolveEmbedToStream(opt.src, match.href).then(streamUrl => {
                if (!streamUrl) return null;
                return {
                  name: 'HdMovie2',
                  title: `${match.title}${opt.label ? ' - ' + opt.label : ''}`,
                  url: streamUrl,
                  quality: 'Auto',
                  headers: HEADERS,
                  provider: 'hdmovie2'
                };
              }).catch(() => null)
            )).then(streams => streams.filter(Boolean));
          });
      });
    })
    .then(streams => {
      if (!streams.length) return streams;
      console.log(`[HdMovie2] Found ${streams.length} candidate stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => v.stream.title);
        if (dead.length) console.log(`[HdMovie2] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[HdMovie2] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    })
    .catch(err => {
      console.log(`[HdMovie2] getStreams failed: ${err.message}`);
      return [];
    });
}
  return { getStreams: getStreams };
})();

const MultiMoviesSource = (function () {
// MultiMovies scraper.
//
// Ported from the CloudStream "StreamPlay" plugin
// (com.phisher98.StreamPlayExtractor#invokeMultimovies, decompiled from the
// StreamPlay.cs3 build), then verified live end-to-end against the real site
// and adapted where the decompile no longer matched reality (see below) -
// this session already confirmed twice that other sources in that same
// decompiled plugin had rotated domains/markup, so nothing here was trusted
// without a live check.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["MultiMovies"]
//   search         -> GET {domain}/?s={query} - dooplay-theme WordPress site;
//                     confirmed live the exact-title hit uses a different
//                     markup (.title a / .meta .year) than the rest of the
//                     grid (.data h3 / .wdate), so both shapes are read.
//   movie page     -> {domain}/movies/{slug}/  (slug taken from the matched
//                     search result's own href, not reconstructed from the
//                     TMDB title - the decompiled plugin's own createSlug()
//                     approach risks mismatching the site's real slugging)
//   tv episode     -> {domain}/episodes/{slug}-{season}x{episode}/ - matches
//                     the decompiled plugin's URL pattern, confirmed live
//                     (Game of Thrones S1E1, Stranger Things S1E1); {slug}
//                     is the show's own slug taken from its /tvshows/ search
//                     hit, not the movie slug pattern.
//   player options -> ul#playeroptionsul li elements, each with data-post/
//                     data-nume/data-type - confirmed live, matches decompile
//                     exactly. Each option is a different upstream "server";
//                     only the one labeled "Cineverse" is implemented here
//                     (see below for why).
//   resolve option -> POST {domain}/wp-admin/admin-ajax.php
//                     (action=doo_player_ajax, post, nume, type) -> JSON
//                     {embed_url, type:"iframe"}. Confirmed live the site's
//                     own embed_url sometimes carries a literal "&amp;" HTML
//                     entity instead of "&" in its query string (e.g. a TV
//                     episode's "...?id=X&amp;s=1&amp;e=1") - fetching that
//                     URL as-is silently mis-parses the season/episode and
//                     the embed serves the WRONG episode (confirmed live:
//                     landed on "Stranger Things S05E08" instead of the
//                     requested S1E1). Un-escaping "&amp;" -> "&" before the
//                     request fixes this.
//   Cineverse embed -> rozgarlelo.modiplay.xyz/embed/... - a small wrapper
//                     page whose only job is an <iframe id="playerFrame">
//                     pointing at modiplay's own /proxy.php?p={platform}&c={code}.
//   proxy.php page  -> a full HLS.js player page. Confirmed live this page's
//                     inline script embeds `var src="https://multiai.modiplay.xyz/
//                     stream_proxy.php?url=<upstream master.m3u8>&ref=...&tok=..."`
//                     directly in static HTML when the backing file lives on
//                     "streamhg" (var platform="streamhg") - no JS execution
//                     needed, just read it out. That stream_proxy.php URL is
//                     itself the final, directly playable master playlist
//                     (confirmed live: real #EXTM3U content, multiple
//                     quality variants, multi-language audio tracks).
//                     Confirmed live this does NOT hold for every backing
//                     platform: some files are hosted on "rpmshare" (and
//                     presumably others), where `var src=""` stays empty and
//                     the real source is only discoverable by letting the
//                     page's own JS run (it loads a hidden second iframe and
//                     exchanges postMessage with it) - not something a plain
//                     HTTP client can do. Confirmed live streamhg is the
//                     common case (3/4 titles sampled); items landing on an
//                     unextractable platform are simply skipped, the same
//                     way vegamovies.js skips Cloudflare-gated V-Cloud and
//                     uhdmovies.js skips Turnstile-gated Resume Cloud rather
//                     than fabricating a stream that doesn't work.
//
// Other player options seen live (GDMIRROR/filesforever.link - a heavily
// obfuscated character-shift-cipher page; screenscape.me, Nxsha, Vidout,
// nhdapi - each its own Next.js CSR app or gated API) were not implemented:
// each would need its own from-scratch reverse-engineering effort and none
// were confirmed extractable with a plain HTTP client in the time available.

const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://multimovies.casa';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetch(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const domain = ((data && data.MultiMovies) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[MultiMovies] Using domain: ${domain}`);
      return domain;
    })
    .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[MultiMovies] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// dooplay's search results page mixes two markups for the same result grid -
// confirmed live the single "exact slug match" hit renders as
// `.title a` + `.meta .year`, while every other card renders as
// `.data h3` + `.wdate`. Reading both shapes generically also picks up the
// media type (movie vs tv show) straight from the href path.
function search(domain, query) {
  const url = `${domain}/?s=${encodeURIComponent(query)}`;
  return fetch(url, { headers: HEADERS })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      const results = [];
      $('article').each((_, el) => {
        const $el = $(el);
        const href = $el.find('a[href*="/movies/"], a[href*="/tvshows/"]').first().attr('href');
        if (!href) return;
        const title = $el.find('.title, .data h3').first().text().trim() || $el.find('img').attr('alt') || '';
        if (!title) return;
        const yearText = $el.find('.year, .wdate').first().text().trim();
        const yearMatch = yearText.match(/(19|20)\d{2}/);
        const mediaType = href.includes('/tvshows/') ? 'tv' : 'movie';
        results.push({ href, title, year: yearMatch ? yearMatch[0] : '', mediaType });
      });
      return results;
    })
    .catch(() => []);
}

function findBestMatch(results, mediaInfo, mediaType) {
  const candidates = results.filter(r => r.mediaType === mediaType);
  if (!candidates.length) return null;
  const targetWords = new Set(normalize(mediaInfo.title).split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const item of candidates) {
    // A same-named but unrelated title is a hard mismatch when both sides
    // state a year that disagrees, not just a missed bonus below - otherwise
    // short common titles can win purely on word overlap.
    if (mediaInfo.year && item.year && Math.abs(parseInt(item.year, 10) - parseInt(mediaInfo.year, 10)) > 1) continue;
    const itemWords = normalize(item.title).split(' ').filter(Boolean);
    const overlap = itemWords.filter(w => targetWords.has(w)).length;
    let score = targetWords.size ? overlap / targetWords.size : 0;
    if (mediaInfo.year && item.year === mediaInfo.year) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function slugFromHref(href) {
  const m = href.match(/\/(?:movies|tvshows)\/([^/]+)\/?/);
  return m ? m[1] : null;
}

function fetchPlayerOptions(pageUrl) {
  return fetch(pageUrl, { headers: HEADERS })
    .then(res => {
      if (!res.ok) return null;
      return res.text();
    })
    .then(html => {
      if (!html) return [];
      if (/Just a moment/i.test(html)) {
        console.log('[MultiMovies] Cloudflare challenge encountered, aborting');
        return [];
      }
      const $ = cheerio.load(html);
      const options = [];
      $('ul#playeroptionsul li').each((_, el) => {
        const $el = $(el);
        options.push({
          post: $el.attr('data-post'),
          nume: $el.attr('data-nume'),
          type: $el.attr('data-type'),
          label: $el.text().trim()
        });
      });
      return options;
    })
    .catch(() => []);
}

function ajaxResolveEmbed(domain, pageUrl, option) {
  const body = new URLSearchParams({ action: 'doo_player_ajax', post: option.post, nume: option.nume, type: option.type });
  return fetch(`${domain}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: pageUrl }),
    body: body.toString()
  })
    .then(res => (res.ok ? res.json() : null))
    .then(json => {
      if (!json || !json.embed_url) return null;
      // See file header - the site's own JSON sometimes carries a literal
      // "&amp;" instead of "&", which breaks season/episode parsing
      // downstream if left as-is.
      return String(json.embed_url).replace(/&amp;/g, '&');
    })
    .catch(() => null);
}

function extractSubtitles($, proxyUrl) {
  const subs = [];
  $('track').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    let url;
    try { url = new URL(src, proxyUrl).toString(); } catch (e) { return; }
    const lang = $(el).attr('srclang') || $(el).attr('label') || 'Unknown';
    subs.push({ url, language: $(el).attr('label') || lang, name: $(el).attr('label') || lang });
  });
  return subs;
}

// Resolves the "Cineverse" player option (modiplay.xyz) all the way down to
// a final playable HLS URL. Returns null when the backing platform isn't one
// that embeds its source statically (see file header) rather than throwing.
function resolveCineverse(domain, pageUrl, option) {
  return ajaxResolveEmbed(domain, pageUrl, option).then(embedUrl => {
    if (!embedUrl) return null;
    return fetch(embedUrl, { headers: Object.assign({}, HEADERS, { Referer: pageUrl }) })
      .then(res => (res.ok ? res.text() : null))
      .then(embedHtml => {
        if (!embedHtml) return null;
        const $ = cheerio.load(embedHtml);
        const frameSrc = $('#playerFrame').attr('src') || $('iframe').attr('src');
        if (!frameSrc) return null;
        let proxyUrl;
        try { proxyUrl = new URL(frameSrc, embedUrl).toString(); } catch (e) { return null; }
        return fetch(proxyUrl, { headers: Object.assign({}, HEADERS, { Referer: embedUrl }) })
          .then(res => (res.ok ? res.text() : null))
          .then(proxyHtml => {
            if (!proxyHtml) return null;
            const m = proxyHtml.match(/var src\s*=\s*"([^"]*)"/);
            const rawSrc = m ? m[1].replace(/\\\//g, '/') : '';
            if (!rawSrc) {
              const platformMatch = proxyHtml.match(/var platform\s*=\s*"([^"]*)"/);
              console.log(`[MultiMovies] No static source for platform "${platformMatch ? platformMatch[1] : 'unknown'}", skipping`);
              return null;
            }
            let finalUrl;
            try { finalUrl = new URL(rawSrc, proxyUrl).toString(); } catch (e) { return null; }
            const $$ = cheerio.load(proxyHtml);
            const subtitles = extractSubtitles($$, proxyUrl);
            return { url: finalUrl, referer: proxyUrl, subtitles };
          });
      });
  }).catch(() => null);
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url) || /stream_proxy\.php/i.test(url);
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

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[MultiMovies] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[MultiMovies] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;

    return search(domain, mediaInfo.title).then(results => {
      const match = findBestMatch(results, mediaInfo, mediaType);
      if (!match) {
        console.log(`[MultiMovies] No matching title found for "${mediaInfo.title}"`);
        return [];
      }
      console.log(`[MultiMovies] Matched: "${match.title}" (${match.href})`);

      let pageUrl = match.href;
      if (mediaType === 'tv') {
        const slug = slugFromHref(match.href);
        if (!slug) return [];
        pageUrl = `${domain}/episodes/${slug}-${season}x${episode}/`;
      }

      return fetchPlayerOptions(pageUrl).then(options => {
        if (!options.length) {
          console.log('[MultiMovies] No player options found on page');
          return [];
        }
        const cineverse = options.find(o => /cineverse/i.test(o.label));
        if (!cineverse) {
          console.log('[MultiMovies] No Cineverse option available for this title');
          return [];
        }
        return resolveCineverse(domain, pageUrl, cineverse).then(resolved => {
          if (!resolved) return [];
          return [{
            name: 'MultiMovies - Cineverse',
            title: label,
            url: resolved.url,
            quality: 'Auto',
            headers: { 'User-Agent': USER_AGENT, Referer: resolved.referer },
            subtitles: resolved.subtitles,
            provider: 'multimovies'
          }];
        });
      });
    });
  }).then(streams => {
    if (!streams.length) return streams;
    console.log(`[MultiMovies] Found ${streams.length} candidate stream(s), validating...`);
    return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
      const valid = validated.filter(v => v.ok).map(v => v.stream);
      const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
      if (dead.length) console.log(`[MultiMovies] Dropping unreachable: ${dead.join(', ')}`);
      console.log(`[MultiMovies] ${valid.length}/${streams.length} stream(s) validated OK`);
      return valid;
    });
  }).catch(err => {
    console.log(`[MultiMovies] getStreams failed: ${err.message}`);
    return [];
  });
}
  return { getStreams: getStreams };
})();

const MoviesModSource = (function () {
// MoviesMod scraper.
//
// Ported from the CloudStream "StreamPlay" plugin's decompiled
// invokeMoviesmod/invokeModflix functions (com.phisher98.StreamPlayExtractor,
// StreamPlay.cs3 build) - that decompile came out badly garbled (JADX
// couldn't fully rebuild the coroutine state machine, lots of "Code
// duplicated" warnings and dead-looking branches), so rather than
// transliterate it, the actual shape below was reconstructed by live-testing
// the real site end-to-end and cross-checking each step against what the
// decompile still made out: quality headings, the "Download"/"Episode"
// anchor in the next sibling, and a final "Moviesmod" extractor hand-off.
//
//   current domain -> https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json ["moviesmod"]
//                     (confirmed live 2026-09-28: still the doc's last-known
//                     https://moviesmod.ai.in, no rotation this time)
//   search         -> GET {domain}/search/{title}  - a plain WordPress theme
//                     search page, one <article> per hit under #content_box
//                     .post-cards, title/href in h2.title.front-view-title>a
//   movie page     -> div.thecontent has one h4 heading per quality (e.g.
//                     "Download X Dual Audio 1080p Bluray [3.2GB]"); a
//                     handful of decorative h3/h4 headings also exist and are
//                     excluded by filtering out any heading whose own text
//                     contains "MoviesMod" (confirmed live - matches the
//                     decompile's own exclusion). The heading's next sibling
//                     <p> holds one <a class=maxbutton...> to a
//                     links.modpro.blog / posts.modpro.blog archive page.
//   series page    -> div.thecontent has one h3 heading per (season,
//                     quality) pair (e.g. "Season 1 {Hindi-English} 720p
//                     [370MB]"); next sibling <p> holds TWO links - "Episode
//                     Links" (episodes.modpro.blog, what we want) and
//                     "Batch/Zip File" (a separate archive id, not used here).
//   modpro.blog    -> movie archive page: one <a class=maxbutton> per
//                     resolver ("Fast Server (G-Drive)", "Google Drive
//                     (Server 2)", sometimes a CSS-hidden "G-Direct"/
//                     "OneDrive", sometimes an "Other Download Links" to
//                     urlflix.xyz). CONFIRMED LIVE (2026-09-28) this splits
//                     by which modpro.blog subdomain a given quality's link
//                     uses, independent of how old the post is: quality
//                     groups on links.modpro.blog (the majority - plain
//                     480p/720p/1080p entries) route through
//                     en.thenaukriadda.in, a domain that's been repurposed
//                     into a completely unrelated WordPress job-listings blog
//                     ("The Naukri Adda") - its sid token's own form#landing
//                     auto-submits and lands on that blog's homepage, both
//                     via a raw HTTP replay of the form post and via a real
//                     browser executing the page's JS, so that subdomain is
//                     a dead end today. Quality groups on posts.modpro.blog
//                     (seen for HEVC-labelled entries specifically, but nothing
//                     here assumes that's the only case) route through
//                     cloud.unblockedgames.world instead, which IS confirmed
//                     live working end-to-end. Nothing below hardcodes this
//                     split - it just follows whatever modpro.blog link a
//                     quality heading actually has and lets bypassGateway()
//                     (which only succeeds against the form#landing shape)
//                     and live validation sort out which ones are alive, so
//                     a movie post can validly return some quality groups
//                     and not others, and this keeps working automatically
//                     if MoviesMod's own mix of subdomains shifts again.
//                     "G-Direct" (gdrivepro.xyz) is dead (NXDOMAIN) and
//                     "Other Download Links" (urlflix.xyz) only ever offers
//                     long-defunct anonfiles.com/bayfiles.com links plus a
//                     1fichier/gofile pair that need a paid/captcha flow, so
//                     neither is used here - only the first maxbutton link is
//                     followed per quality group.
//                     episodes.modpro.blog page (series): one
//                     <h3><a>Episode N</a></h3> per episode, each one's href
//                     a cloud.unblockedgames.world sid link - confirmed live
//                     working the same way.
//   unblockedgames.world -> the exact same "bypassHrefli" ad-gate chain
//                     already implemented in uhdmovies.js for the same
//                     domain family (form#landing -> POST -> form#landing ->
//                     POST -> a script's own "?go=" token -> meta-refresh ->
//                     drive URL -> a final JS "replace(...)" redirect).
//                     Confirmed live here too, end to end.
//   driveseed.org  -> the resolved drive URL lands on either
//                     driveseed.org/file/<id> directly, or (confirmed live
//                     for one of several sibling episode links, not a
//                     universal rule) driveseed.org/list/<id> - a season-pack
//                     listing of every episode's own /file/<id> link in
//                     order, matched here by SxxExx filename first and by
//                     list position as a fallback. Either way the /file/<id>
//                     page offers "Cloud Download" (a pub-*.r2.dev direct
//                     link - confirmed live this one now 403s, kept as a
//                     candidate anyway since live validation below drops
//                     whatever's actually dead rather than hard-coding that
//                     assumption) and "Instant Download"/"Instant Download
//                     V2" (a video-gen.xyz-family token gateway). Confirmed
//                     live that following "Instant Download" with a normal
//                     redirect-following fetch lands on video-seed.dev's own
//                     "?url=<real file URL>" - already the final, playable
//                     link, no decrypt needed (this is the same shortcut
//                     uhdmovies.js's own extractVideoSeed comment already
//                     documents for this exact gateway). Confirmed live with
//                     a real HTTP 200, Content-Type: video/mkv, correct
//                     filename and byte size on a googleusercontent.com URL.

const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_DOMAIN = 'https://moviesmod.ai.in';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT };

let cachedDomain = null;
let cachedDomainAt = 0;
const DOMAIN_CACHE_TTL = 1000 * 60 * 30;

function getDomain() {
  if (cachedDomain && Date.now() - cachedDomainAt < DOMAIN_CACHE_TTL) return Promise.resolve(cachedDomain);
  return fetch(DOMAINS_URL, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const domain = ((data && data.moviesmod) || DEFAULT_DOMAIN).replace(/\/+$/, '');
      cachedDomain = domain;
      cachedDomainAt = Date.now();
      console.log(`[MoviesMod] Using domain: ${domain}`);
      return domain;
    })
    .catch(() => DEFAULT_DOMAIN);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: HEADERS })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[MoviesMod] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(() => ({ title: '', year: '' }));
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/&#8[0-9]{3};/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Post titles are formatted "Download {Title} (Season N) ..." or
// "Download {Title} (YEAR) ...", occasionally "Download {Title} {Lang} ...".
// Cutting at the first "(", "{" or a bare year/"Season" token isolates just
// the title part, so "The Scandal" doesn't loosely word-overlap-match
// "The Scandal of Chunhwa" the way a simple substring/overlap check would.
function extractCoreTitle(rawTitle) {
  const stripped = String(rawTitle || '').replace(/^download\s+/i, '');
  const m = stripped.match(/^(.*?)(?:\s*[({]|\s+(?:19|20)\d{2}\b|\s+season\b)/i);
  return (m ? m[1] : stripped).trim();
}

function findBestMatch(candidates, mediaInfo) {
  const targetCore = normalize(extractCoreTitle(mediaInfo.title));
  if (!targetCore) return null;

  const exact = candidates.find(c => normalize(extractCoreTitle(c.title)) === targetCore);
  if (exact) return exact;

  // Fall back to word-overlap + year bonus for titles this site formats
  // unusually (e.g. missing a "(...)" delimiter altogether).
  const targetWords = new Set(targetCore.split(' ').filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    const normTitle = normalize(c.title);
    const postYearMatch = c.title.match(/\b(19|20)\d{2}\b/);
    if (mediaInfo.year && postYearMatch && Math.abs(parseInt(postYearMatch[0], 10) - parseInt(mediaInfo.year, 10)) > 1) continue;
    const words = normalize(extractCoreTitle(c.title)).split(' ').filter(Boolean);
    const overlap = words.filter(w => targetWords.has(w)).length;
    let score = targetWords.size ? overlap / targetWords.size : 0;
    if (mediaInfo.year && normTitle.includes(mediaInfo.year)) score += 0.3;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.6 ? best : null;
}

function search(domain, query) {
  const url = `${domain}/search/${encodeURIComponent(query)}`;
  return fetch(url, { headers: HEADERS })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      const candidates = [];
      $('#content_box article').each((_, el) => {
        const a = $(el).find('h2.title a').first();
        const href = a.attr('href');
        const title = a.text().trim();
        if (href && title) candidates.push({ href, title });
      });
      return candidates;
    })
    .catch(() => []);
}

function extractQuality(str) {
  const m = /(\d{3,4})[pP]/.exec(str || '');
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 2160) return '4K';
    return `${n}p`;
  }
  if (/4K|UHD/i.test(str || '')) return '4K';
  return 'Unknown';
}

function getSizeLabel(str) {
  const m = String(str || '').match(/([\d.]+\s*(?:GB|MB|TB))/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

// Finds each quality (movie) / season+quality (tv) heading in div.thecontent
// and returns, per heading, the modpro.blog gateway href sitting in its next
// sibling <p> - "Download"-labelled for a movie, "Episode Links"-labelled
// (never the sibling "Batch/Zip File" link) for a season's episode index.
function extractHeadingTargets($, mediaType, season) {
  const headingTag = mediaType === 'tv' ? 'h3' : 'h4';
  const seasonRe = mediaType === 'tv' && season ? new RegExp(`(s0*${season}\\b|season\\s*${season}\\b)`, 'i') : null;
  const targets = [];
  $(`div.thecontent ${headingTag}`).each((_, el) => {
    const text = $(el).text().trim();
    if (!text || /moviesmod/i.test(text)) return;
    if (extractQuality(text) === 'Unknown') return;
    if (seasonRe && !seasonRe.test(text)) return;
    let sib = $(el).next();
    let hops = 0;
    while (sib.length && sib.get(0).tagName !== 'p' && hops < 4) { sib = sib.next(); hops++; }
    if (!sib.length) return;
    const link = mediaType === 'tv'
      ? sib.find('a[href*="modpro.blog"]').filter((i, a) => /episode/i.test($(a).text())).first()
      : sib.find('a.maxbutton[href*="modpro.blog"]').first();
    const href = link.attr('href');
    if (href) targets.push({ heading: text, gatewayPageUrl: href, quality: extractQuality(text), size: getSizeLabel(text) });
  });
  return targets;
}

// Movie archive page -> first maxbutton link inside a <p> ("Fast Server
// (G-Drive)" today). Series episode archive page -> the specific numbered
// "Episode N" <h3><a> link (never "Episode 1N" etc - anchored to the exact
// number via \b boundaries).
function extractGatewayLink($, mediaType, episode) {
  if (mediaType === 'tv') {
    const re = new RegExp(`^episode\\s*0*${episode}\\b`, 'i');
    let found = null;
    $('h3 a').each((_, el) => {
      if (found) return;
      if (re.test($(el).text().trim())) found = $(el).attr('href');
    });
    return found;
  }
  return $('p a.maxbutton').first().attr('href') || null;
}

function getBaseUrl(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch (e) { return ''; }
}
function fixUrl(url, domain) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return domain + url;
  return `${domain}/${url}`;
}

// Same ad-gate chain as uhdmovies.js's own bypassHrefli, confirmed live to
// also cover MoviesMod's unblockedgames.world links (see file header).
// Returns null (rather than throwing) for anything that doesn't match the
// expected form#landing shape - e.g. MoviesMod's dead thenaukriadda.in movie
// gateway, which lands on an unrelated blog homepage with no such form.
function bypassGateway(url) {
  const host = getBaseUrl(url);
  return fetch(url, { headers: HEADERS })
    .then(res => res.text())
    .then(html1 => {
      const $1 = cheerio.load(html1);
      const formUrl1 = $1('form#landing').attr('action');
      if (!formUrl1) return null;
      const formData1 = {};
      $1('form#landing input').each((_, el) => { formData1[$1(el).attr('name')] = $1(el).attr('value') || ''; });

      return fetch(formUrl1, { method: 'POST', headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }), body: new URLSearchParams(formData1).toString() })
        .then(res => res.text())
        .then(html2 => {
          const $2 = cheerio.load(html2);
          const formUrl2 = $2('form#landing').attr('action');
          if (!formUrl2) return null;
          const formData2 = {};
          $2('form#landing input').each((_, el) => { formData2[$2(el).attr('name')] = $2(el).attr('value') || ''; });

          return fetch(formUrl2, { method: 'POST', headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }), body: new URLSearchParams(formData2).toString() })
            .then(res => res.text())
            .then(html3 => {
              const $3 = cheerio.load(html3);
              const script = $3('script:contains(?go=)').html() || '';
              const skTokenMatch = script.match(/\?go=([^"]+)/);
              if (!skTokenMatch) return null;
              const skToken = skTokenMatch[1];
              const wpHttp2 = formData2['_wp_http2'] || '';

              return fetch(`${host}?go=${skToken}`, { headers: Object.assign({}, HEADERS, { Cookie: `${skToken}=${wpHttp2}` }) })
                .then(res => res.text())
                .then(html4 => {
                  const $4 = cheerio.load(html4);
                  const metaRefresh = $4('meta[http-equiv="refresh"]').attr('content') || '';
                  const driveUrlMatch = metaRefresh.match(/url=(.+)/);
                  if (!driveUrlMatch) return null;
                  const driveUrl = driveUrlMatch[1];

                  return fetch(driveUrl, { headers: HEADERS })
                    .then(res => res.text())
                    .then(html5 => {
                      const pathMatch = html5.match(/replace\("([^"]+)"\)/);
                      if (!pathMatch || pathMatch[1] === '/404') return null;
                      return fixUrl(pathMatch[1], getBaseUrl(driveUrl));
                    });
                });
            });
        });
    })
    .catch(() => null);
}

// A driveseed "/file/<id>" page's own quality/size are more authoritative
// than the heading text (the heading only states the group's nominal
// quality, the file page states the exact encode).
function extractDriveseedFilePage(fileUrl, fallbackMeta) {
  return fetch(fileUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const items = $('li.list-group-item');
      let name = '';
      let size = fallbackMeta.size;
      items.each((_, el) => {
        const text = $(el).text().trim();
        if (/^name\s*:/i.test(text)) name = text.replace(/^name\s*:\s*/i, '').trim();
        else if (/^size\s*:/i.test(text)) size = text.replace(/^size\s*:\s*/i, '').trim() || size;
      });
      const quality = extractQuality(name) !== 'Unknown' ? extractQuality(name) : fallbackMeta.quality;
      const candidates = [];
      $('.text-center a, div a.btn').each((_, el) => {
        const text = $(el).text().trim();
        const href = $(el).attr('href');
        if (!href) return;
        if (/cloud download/i.test(text)) candidates.push({ source: 'Cloud', url: href });
        else if (/instant download/i.test(text)) candidates.push({ source: /v2/i.test(text) ? 'InstantV2' : 'Instant', url: href });
      });
      return { name: name || fallbackMeta.title, size, quality, candidates };
    })
    .catch(() => null);
}

// "Instant Download" buttons route through a video-gen.xyz-family gateway.
// Confirmed live: a plain redirect-following fetch lands on video-seed.dev's
// own "?url=<real file>" - already final and playable, no decrypt needed.
function resolveInstantDownload(href) {
  return fetch(href, { headers: HEADERS, redirect: 'follow' })
    .then(res => {
      try {
        const landed = new URL(res.url || href);
        const inner = landed.searchParams.get('url');
        if (inner && inner.startsWith('http')) return inner;
      } catch (e) { /* fall through */ }
      return null;
    })
    .catch(() => null);
}

function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

// Status alone isn't reliable here (the r2.dev "Cloud Download" links, for
// one, 403 while still returning a normal-looking error page) - HEAD/ranged
// GET first, and for an .m3u8 confirm the body is a real playlist.
function validateStreamUrl(stream) {
  if (isM3u8Url(stream.url)) {
    return fetch(stream.url, { headers: stream.headers })
      .then(res => (res.ok ? res.text().then(text => /^#EXTM3U/.test(text.trim())) : false))
      .catch(() => false);
  }
  return fetch(stream.url, { method: 'HEAD', headers: stream.headers })
    .then(res => res.ok || res.status === 206)
    .catch(() => fetch(stream.url, { method: 'GET', headers: Object.assign({}, stream.headers, { Range: 'bytes=0-2048' }) })
      .then(res => res.ok || res.status === 206)
      .catch(() => false));
}

function sourceLabel(source) {
  if (source === 'Cloud') return 'Cloud';
  if (source === 'InstantV2') return 'Instant V2';
  return 'Instant';
}

function resolveDriveseedCandidates(filePage, label) {
  return Promise.all(filePage.candidates.map(c => {
    const meta = { name: `MoviesMod - ${filePage.quality}${filePage.size ? ` [${filePage.size}]` : ''}`, provider: 'moviesmod', quality: filePage.quality, headers: HEADERS };
    if (c.source === 'Cloud') {
      return Object.assign({}, meta, { name: `MoviesMod - ${sourceLabel(c.source)}`, title: `${label} - ${filePage.quality}`, url: c.url });
    }
    return resolveInstantDownload(c.url).then(url => url ? Object.assign({}, meta, { name: `MoviesMod - ${sourceLabel(c.source)}`, title: `${label} - ${filePage.quality}`, url }) : null);
  })).then(list => list.filter(Boolean));
}

// The resolved driveseed URL can land on a single file page directly, or
// (confirmed live for one specific episode link, not a fixed rule) a
// "/list/<id>" season-pack page listing every episode's own /file/<id> href
// in order - handled by matching the target SxxExx filename first, falling
// back to plain list position.
function resolveDriveseedUrl(driveUrl, mediaType, season, episode) {
  if (!/\/list\//.test(driveUrl)) return Promise.resolve(driveUrl);
  return fetch(driveUrl, { headers: HEADERS })
    .then(res => res.text())
    .then(html => {
      const $ = cheerio.load(html);
      const origin = getBaseUrl(driveUrl);
      const entries = [];
      $('li.list-group-item a[href^="/file/"]').each((_, el) => {
        entries.push({ text: $(el).text().trim(), href: $(el).attr('href') });
      });
      if (!entries.length) return null;
      if (mediaType === 'tv' && season && episode) {
        const re = new RegExp(`s0*${season}e0*${episode}\\b`, 'i');
        const match = entries.find(e => re.test(e.text));
        if (match) return origin + match.href;
        if (entries[episode - 1]) return origin + entries[episode - 1].href;
      }
      return origin + entries[0].href;
    })
    .catch(() => null);
}

function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType === 'tv' ? 'tv' : 'movie';
  console.log(`[MoviesMod] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[MoviesMod] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return Promise.all([getDomain(), getTmdbInfo(tmdbId, mediaType)]).then(([domain, mediaInfo]) => {
    if (!mediaInfo.title) return [];
    const label = `${mediaInfo.title}${mediaInfo.year ? ` (${mediaInfo.year})` : ''}`;

    return search(domain, mediaInfo.title).then(candidates => {
      const match = findBestMatch(candidates, mediaInfo);
      if (!match) {
        console.log(`[MoviesMod] No matching title found for "${mediaInfo.title}"`);
        return [];
      }
      console.log(`[MoviesMod] Matched: "${match.title}"`);

      return fetch(match.href, { headers: HEADERS })
        .then(res => res.text())
        .then(html => {
          const $ = cheerio.load(html);
          const targets = extractHeadingTargets($, mediaType, season);
          if (!targets.length) {
            console.log('[MoviesMod] No matching quality/season heading found on page');
            return [];
          }
          console.log(`[MoviesMod] ${targets.length} quality group(s) found`);

          return Promise.all(targets.map(target =>
            fetch(target.gatewayPageUrl, { headers: Object.assign({}, HEADERS, { Referer: match.href }) })
              .then(res => res.text())
              .then(gatewayHtml => {
                const $$ = cheerio.load(gatewayHtml);
                const gatewayLink = extractGatewayLink($$, mediaType, episode);
                if (!gatewayLink) return [];
                return bypassGateway(gatewayLink).then(driveUrl => {
                  if (!driveUrl) return [];
                  return resolveDriveseedUrl(driveUrl, mediaType, season, episode).then(fileUrl => {
                    if (!fileUrl) return [];
                    return extractDriveseedFilePage(fileUrl, target).then(filePage => {
                      if (!filePage || !filePage.candidates.length) return [];
                      return resolveDriveseedCandidates(filePage, label);
                    });
                  });
                });
              })
              .catch(() => [])
          )).then(perGroup => perGroup.flat());
        });
    }).then(streams => {
      if (!streams.length) return streams;
      console.log(`[MoviesMod] Found ${streams.length} candidate stream(s), validating...`);
      return Promise.all(streams.map(s => validateStreamUrl(s).then(ok => ({ stream: s, ok })))).then(validated => {
        const valid = validated.filter(v => v.ok).map(v => v.stream);
        const dead = validated.filter(v => !v.ok).map(v => v.stream.name);
        if (dead.length) console.log(`[MoviesMod] Dropping unreachable: ${dead.join(', ')}`);
        console.log(`[MoviesMod] ${valid.length}/${streams.length} stream(s) validated OK`);
        return valid;
      });
    });
  }).catch(err => {
    console.log(`[MoviesMod] getStreams failed: ${err.message}`);
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
  { id: 'vixsrc', name: 'Vixsrc', mod: VixSrcSource },
  { id: 'vidlink', name: 'Vidlink', mod: VidLinkSource },
  { id: 'castle', name: 'Castle', mod: CastleSource },
  { id: 'hdhub4u', name: 'HDHub4u', mod: HdHub4uSource },
  { id: 'penguplay', name: 'PenguPlay', mod: PenguPlaySource },
  { id: 'anime-dekho', name: 'AnimeDekho', mod: AnimeDekhoSource },
  { id: 'kickassanime', name: 'KickassAnime', mod: KickassAnimeSource },
  { id: 'vegamovies', name: 'VegaMovies', mod: VegaMoviesSource },
  { id: 'allmovieland', name: 'AllMovieLand', mod: AllMovieLandSource },
  { id: 'cinejoy', name: 'Cinejoy', mod: CinejoySource },
  { id: 'filmyfiy', name: 'Filmyfiy', mod: FilmyfiySource },
  { id: 'moviesdrive', name: 'MoviesDrive', mod: MoviesDriveSource },
  { id: 'rogmovies', name: 'RogMovies', mod: RogMoviesSource },
  { id: 'topmovies', name: 'TopMovies', mod: TopMoviesSource },
  { id: 'hdmovie2', name: 'HdMovie2', mod: HdMovie2Source },
  { id: 'multimovies', name: 'MultiMovies', mod: MultiMoviesSource },
  { id: 'moviesmod', name: 'MoviesMod', mod: MoviesModSource },
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

// video-downloads.googleusercontent.com links (a Google Drive delivery
// format several of these sources can end up resolving to via
// driveseed/HubCloud-style chains) are dropped outright, not just
// deprioritized - confirmed live that host doesn't support HTTP Range
// requests at all (a ranged request gets the full multi-GB file back, 200
// not 206), and tried proxying around it server-side before concluding that
// doesn't actually help: a request for a range near the end of a real movie
// file - which many MKVs need immediately for their seek index - took over
// 4 minutes over a Pi's real upload bandwidth, far past any player's
// timeout. Worse than no result at all, so excluded even as a last resort.
function isNonSeekableGoogleDriveLink(stream) {
  return typeof stream.url === 'string' && stream.url.includes('googleusercontent.com');
}

// How many of the best-ranked candidates get actually test-fetched before
// settling on one to tag [PREFERRED] - probed concurrently, so the added
// latency is roughly one probe's worth, not this number's worth.
const PREFERRED_PROBE_CANDIDATES = 5;
const PROBE_TIMEOUT_SECONDS = 6;

// Same "no setTimeout in this sandbox" problem as COMBINE_TIMEOUT_SECONDS
// above, solved the same way: race the real probe fetch against a delay
// endpoint instead of a JS timer. If the delay endpoint itself is
// unreachable there's no way to tell how much time has actually passed, so -
// same reasoning as buildTimeoutGuard - the safe fallback is to just wait
// for the real probe to resolve on its own rather than guessing it failed.
function probeStream(stream) {
  const headers = Object.assign({ Range: 'bytes=0-1024' }, stream.headers || {});
  const probeFetch = fetch(stream.url, { method: 'GET', headers }).then(res => res.ok).catch(() => false);
  const guard = fetch(`https://httpbin.org/delay/${PROBE_TIMEOUT_SECONDS}`).then(() => 'TIMED_OUT').catch(() => 'GUARD_UNAVAILABLE');
  return Promise.race([probeFetch, guard]).then(result => {
    if (result === 'GUARD_UNAVAILABLE') return probeFetch;
    if (result === 'TIMED_OUT') return false;
    return result;
  });
}

// Drops anything over MAX_SIZE_GB or backed by a known-non-seekable host,
// hides sub-1080p results for movies, then probes the best-ranked candidates
// and tags the first one that's actually reachable as [PREFERRED], moving it
// to the front - the rest of the (filtered) list is left untouched. Falls
// back to the top-ranked candidate untested if every probe in the batch
// fails, rather than tagging nothing - a small ranged GET confirming a 200/206
// response isn't a full playability guarantee, but it reliably catches the
// "shows up but won't play" failures (dead domains, 404s, already-expired
// signed URLs) that quality-tier ranking alone has no way to see coming.
function applyPreferredLogic(streams, mediaType) {
  let filtered = streams.filter(s => {
    const gb = getStreamSizeGB(s);
    return (gb === null || gb <= MAX_SIZE_GB) && !isNonSeekableGoogleDriveLink(s);
  });

  const tierFn = mediaType === 'tv' ? seriesTier : movieTier;
  if (mediaType !== 'tv') {
    filtered = filtered.filter(s => tierFn(s.quality) !== null);
  }

  if (filtered.length === 0) return Promise.resolve(filtered);

  const ranked = filtered.slice().sort((a, b) => {
    const ra = preferredRank(a, tierFn);
    const rb = preferredRank(b, tierFn);
    if (rankIsBetter(ra, rb)) return -1;
    if (rankIsBetter(rb, ra)) return 1;
    return 0;
  });

  const candidates = ranked.slice(0, PREFERRED_PROBE_CANDIDATES);
  return Promise.all(candidates.map(probeStream)).then(results => {
    let best = ranked[0];
    for (let i = 0; i < candidates.length; i++) {
      if (results[i]) { best = candidates[i]; break; }
    }
    const tagged = Object.assign({}, best, {
      name: `[PREFERRED] ${best.name || best.source}`.trim(),
      isPreferred: true
    });
    const rest = filtered.filter(s => s !== best);
    return [tagged, ...rest];
  });
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
    return applyPreferredLogic(collected, type).then(ranked => {
      console.log(`[AllSources] Returning ${ranked.length} stream(s) after ranking (from ${collected.length} collected)`);
      return ranked;
    });
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
