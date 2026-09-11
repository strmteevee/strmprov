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
// servers (Nova, Luna, Orion, Astra, ...), but which of them are actually
// reachable varies day to day - some sit behind a Cloudflare bot-challenge,
// some 403 outright, some time out at the origin. Rather than serve a pile
// of dead links that all fail the moment a user taps them, validate each one
// and only return the ones that actually respond. There's no JS-level
// timeout available in this sandbox (no setTimeout), so a hung check is
// bounded only by the native fetch bridge's own ~30s timeout rather than a
// tighter one - slower in the worst case, but still correct.
function validateStreamUrl(stream) {
  // A HEAD response that comes back with a definitive status (403, 522, ...)
  // is conclusive - retrying with GET won't change a Cloudflare challenge or
  // an origin timeout. Only fall back to a ranged GET when HEAD itself fails
  // outright (some CDNs reject the method with a hard connection error
  // rather than a clean status code).
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

module.exports = { getStreams };
