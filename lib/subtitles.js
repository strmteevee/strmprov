// Subtitle lookup for addon-server.js: OpenSubtitles (hash-matched to the
// exact file when possible) + SubDL (release-name matched, far more generous
// free quota), merged and ordered by the admin-configured first/second
// preferred language.
//
// Both sources are entirely optional - SUBDL_API_KEY/OPENSUBTITLES_API_KEY
// are read straight from process.env (already loaded from .env by whichever
// server required this module first), same isConfigured()-guarded pattern as
// lib/gemini.js's GEMINI_API_KEY. Missing either key just means that source
// contributes nothing, never an error surfaced to the caller.

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

// Every fetch in this file goes either to a real, arbitrary provider stream
// URL (computeMovieHash - the same kind of "shows up but won't play or is
// just slow" host lib/aggregate.js's own probeStream already has to guard
// against) or a third-party API. Plain fetch() has no built-in timeout, so a
// hung host would otherwise hang the whole /stream response indefinitely -
// confirmed live as the cause of Nuvio's autoplay-next-episode retrying in a
// loop, since each retry re-triggered the same unbounded hash-computation
// fetch server-side. Same timeout used by lib/aggregate.js's own probeStream,
// for consistency.
const NETWORK_TIMEOUT_MS = 6000;

function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    return fetch(url, Object.assign({}, options, { signal: controller.signal }))
        .finally(() => clearTimeout(timer));
}
const SUBTITLES_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'subtitles.json');

const DEFAULT_SUBTITLES_CONFIG = { firstLanguage: 'en', secondLanguage: '' };

function readSubtitlesConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(SUBTITLES_CONFIG_PATH, 'utf8'));
        return Object.assign({}, DEFAULT_SUBTITLES_CONFIG, raw);
    } catch (e) {
        return DEFAULT_SUBTITLES_CONFIG;
    }
}

function isSubDlConfigured() {
    return !!process.env.SUBDL_API_KEY;
}

function isOpenSubtitlesConfigured() {
    return !!process.env.OPENSUBTITLES_API_KEY;
}

// ---- OpenSubtitles "moviehash" - public, documented algorithm ----
// hash = file_size + sum(first 64KB as LE uint64s) + sum(last 64KB as LE
// uint64s), all wrapping unsigned 64-bit arithmetic, formatted as 16 hex
// chars. Computed from two cheap Range GETs (128KB total) against the
// stream's own URL - confirmed elsewhere in this codebase
// (lib/aggregate.js's dropUnplayable) that non-Range-capable hosts are
// already filtered out of anything that could become the [PREFERRED] stream,
// so this should succeed for most streams that reach here.
const HASH_CHUNK = 65536; // 64KB
const MIN_HASHABLE_SIZE = 128 * 1024;
const UINT64_MASK = 0xFFFFFFFFFFFFFFFFn;

function sumUint64LE(buf) {
    let sum = 0n;
    for (let i = 0; i + 8 <= buf.length; i += 8) {
        sum = (sum + buf.readBigUInt64LE(i)) & UINT64_MASK;
    }
    return sum;
}

function fetchRange(url, start, end) {
    return fetchWithTimeout(url, { headers: { Range: `bytes=${start}-${end}` } }).then(res =>
        res.arrayBuffer().then(buf => ({ buffer: Buffer.from(buf), status: res.status, contentRange: res.headers.get('content-range') }))
    );
}

// Returns { hash, size } on success, or null (not an error) when the host
// doesn't support Range or the file is under the minimum hashable size -
// hash-matching is a bonus signal, never a requirement for subtitles to work.
function computeMovieHash(url) {
    return fetchRange(url, 0, HASH_CHUNK - 1).then(first => {
        if (first.status !== 206 || first.buffer.length < HASH_CHUNK) return null;
        const m = first.contentRange && first.contentRange.match(/\/(\d+)$/);
        const size = m ? parseInt(m[1], 10) : null;
        if (!size || size < MIN_HASHABLE_SIZE) return null;
        return fetchRange(url, size - HASH_CHUNK, size - 1).then(last => {
            if (last.buffer.length < HASH_CHUNK) return null;
            const hash = (BigInt(size) + sumUint64LE(first.buffer) + sumUint64LE(last.buffer)) & UINT64_MASK;
            return { hash: hash.toString(16).padStart(16, '0'), size };
        });
    }).catch(() => null);
}

// ---- SubDL ----
// Confirmed live against the real endpoint while planning this: every
// subtitles[] entry's own `url` is a zip (even for a single movie, not just
// season packs) - unpack=1 additionally returns unpack_files[], confirmed
// live to hold direct, already-unzipped .srt urls in that same case, so
// unpack=1 + reading unpack_files is used unconditionally. SubDL also bakes
// the caller's own api_key back into every url it returns - stripped here
// before a url ever reaches the Stremio client, since the actual
// dl.subdl.com download needs no key at all (anonymous limit: 300/day,
// charged to whichever IP downloads it - the end viewer's device, not ours).
const SUBDL_BASE = 'https://api.subdl.com/api/v1/subtitles';

function stripApiKey(urlStr) {
    try {
        const u = new URL(urlStr);
        u.searchParams.delete('api_key');
        return u.toString();
    } catch (e) {
        return urlStr;
    }
}

function querySubDl({ imdbId, mediaType, season, episode, languages }) {
    if (!isSubDlConfigured()) return Promise.resolve([]);

    const params = new URLSearchParams({
        api_key: process.env.SUBDL_API_KEY,
        imdb_id: imdbId,
        type: mediaType === 'tv' ? 'tv' : 'movie',
        unpack: '1',
        client: 'custom_integration'
    });
    if (languages && languages.length) params.set('languages', languages.map(l => l.toUpperCase()).join(','));
    if (mediaType === 'tv' && season) params.set('season_number', String(season));
    if (mediaType === 'tv' && episode) params.set('episode_number', String(episode));
    // Deliberately NOT passing file_name as a match hint - confirmed live
    // that SubDL treats it as an additional filter, not just a bias:
    // combined with imdb_id, a file_name that isn't a real release filename
    // (e.g. a provider's own decorative display name, which is all this
    // codebase's providers actually have) makes the whole search return zero
    // results instead of just deprioritizing weaker matches.

    return fetchWithTimeout(`${SUBDL_BASE}?${params.toString()}`).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }).then(data => {
        if (!data || data.status !== true || !Array.isArray(data.subtitles)) return [];
        const results = [];
        for (const sub of data.subtitles) {
            const files = Array.isArray(sub.unpack_files) ? sub.unpack_files : [];
            for (const file of files) {
                if (!file.url) continue;
                // season_number/episode_number in the request only narrows
                // which season PACKS come back - confirmed live that each
                // pack's own unpack_files still lists every episode in it
                // (a single "Season 1 Complete" search for one episode came
                // back with 127 files across 10 packs, not ~10). The actual
                // per-episode filter has to happen here, against each file's
                // own season/episode fields.
                if (mediaType === 'tv' && season && episode &&
                    !(Number(file.season) === Number(season) && Number(file.episode) === Number(episode))) {
                    continue;
                }
                results.push({
                    url: stripApiKey(`https://dl.subdl.com${file.url}`),
                    lang: (file.language || sub.language || '').toLowerCase(),
                    releaseName: file.release_name || sub.release_name,
                    hashMatched: false,
                    source: 'SubDL'
                });
            }
        }
        return results;
    }).catch(err => {
        console.error(`[subtitles] SubDL query failed: ${err.message}`);
        return [];
    });
}

// ---- OpenSubtitles ----
// Search itself is unlimited but download is tightly capped (see this
// file's plan for the exact quotas), so only the single best match per
// requested language is ever resolved through the second /download call.
const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const OS_USER_AGENT = 'strmprov v1.0.0';

function queryOpenSubtitles({ imdbId, mediaType, season, episode, languages, movieHash }) {
    if (!isOpenSubtitlesConfigured()) return Promise.resolve([]);

    const numericId = imdbId.replace(/^tt/i, '');
    const params = new URLSearchParams({ type: mediaType === 'tv' ? 'episode' : 'movie' });
    if (languages && languages.length) params.set('languages', languages.join(','));
    if (mediaType === 'tv') {
        params.set('parent_imdb_id', numericId);
        if (season) params.set('season_number', String(season));
        if (episode) params.set('episode_number', String(episode));
    } else {
        params.set('imdb_id', numericId);
    }
    if (movieHash && movieHash.hash) {
        params.set('moviehash', movieHash.hash);
        params.set('moviebytesize', String(movieHash.size));
    }

    const headers = { 'Api-Key': process.env.OPENSUBTITLES_API_KEY, 'User-Agent': OS_USER_AGENT, Accept: 'application/json' };

    return fetchWithTimeout(`${OS_BASE}/subtitles?${params.toString()}`, { headers }).then(res => {
        if (!res.ok) throw new Error(`search HTTP ${res.status}`);
        return res.json();
    }).then(data => {
        const items = Array.isArray(data.data) ? data.data : [];
        const byLang = new Map();
        for (const item of items) {
            const attrs = item.attributes || {};
            const lang = (attrs.language || '').toLowerCase();
            const file = attrs.files && attrs.files[0];
            if (!lang || !file || byLang.has(lang)) continue;
            byLang.set(lang, { fileId: file.file_id, hashMatched: !!(movieHash && attrs.moviehash_match) });
        }
        return Promise.all(Array.from(byLang.entries()).map(([lang, info]) =>
            fetchWithTimeout(`${OS_BASE}/download`, {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
                body: JSON.stringify({ file_id: info.fileId })
            }).then(res => {
                if (!res.ok) throw new Error(`download HTTP ${res.status}`);
                return res.json();
            }).then(d => (d.link ? { url: d.link, lang, hashMatched: info.hashMatched, source: 'OpenSubtitles' } : null))
              .catch(() => null)
        ));
    }).then(results => results.filter(Boolean))
      .catch(err => {
          console.error(`[subtitles] OpenSubtitles query failed: ${err.message}`);
          return [];
      });
}

// Nuvio's own subtitle object (see DOCUMENTATION.md's "Subtitle Support"
// section) has a dedicated `name` field for exactly this - "The label shown
// to the user in the subtitle selector" - separate from `language`. This was
// originally built assuming the bare Stremio-protocol shape (`lang` only,
// no separate label field) and folded the source/count into `lang` itself;
// confirmed live that's wrong for Nuvio specifically, which ignored that and
// showed every subtitle with the same fallback label instead. `lang` now
// stays a real short code, and this decorated, de-duplicated string goes in
// `name` - still needed even with a real `name` field, since SubDL alone can
// return 10 different English releases for one movie that would otherwise
// all show up identically in the picker.
const LANGUAGE_NAMES = {
    en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
    pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
    zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', pl: 'Polish', sv: 'Swedish'
};

function languageName(code) {
    return LANGUAGE_NAMES[(code || '').toLowerCase()] || (code || 'Unknown').toUpperCase();
}

// Builds the final, uniquely-labeled `name` for each result - source first
// (SubDL/OpenSubtitles), then a running "#2", "#3", ... suffix for any
// further result that still collides after that, so every entry a client
// ever renders is distinguishable no matter how many releases exist for the
// same language and source. `lang` is left as the real short code.
function labelSubtitles(results) {
    const counts = new Map();
    return results.map(s => {
        const base = `${languageName(s.lang)} (${s.source})`;
        const count = (counts.get(base) || 0) + 1;
        counts.set(base, count);
        return { url: s.url, lang: s.lang, name: count > 1 ? `${base} #${count}` : base };
    });
}

// videoUrl is optional - Stremio's own subtitles route asks for this with
// nothing to hash yet (see addon-server.js's /subtitles route), while the
// per-[PREFERRED]-stream call from buildStreamResponse supplies the real
// stream URL for a hash-matched OpenSubtitles lookup on top.
function getSubtitles({ imdbId, mediaType, season, episode, videoUrl }) {
    const config = readSubtitlesConfig();
    const languages = [config.firstLanguage, config.secondLanguage].filter(Boolean);

    const hashPromise = videoUrl ? computeMovieHash(videoUrl) : Promise.resolve(null);

    return hashPromise.then(movieHash => Promise.all([
        queryOpenSubtitles({ imdbId, mediaType, season, episode, languages, movieHash }),
        querySubDl({ imdbId, mediaType, season, episode, languages })
    ])).then(([openSubtitlesResults, subDlResults]) => {
        const merged = [];
        const seen = new Set();
        for (const s of [...openSubtitlesResults, ...subDlResults]) {
            const key = `${s.lang}|${s.url}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(s);
        }
        const firstLang = (config.firstLanguage || '').toLowerCase();
        const secondLang = (config.secondLanguage || '').toLowerCase();
        const rank = (s) => {
            if (s.hashMatched) return 0;
            if (firstLang && s.lang === firstLang) return 1;
            if (secondLang && s.lang === secondLang) return 2;
            return 3;
        };
        merged.sort((a, b) => rank(a) - rank(b));
        return labelSubtitles(merged);
    });
}

module.exports = {
    SUBTITLES_CONFIG_PATH,
    DEFAULT_SUBTITLES_CONFIG,
    readSubtitlesConfig,
    isSubDlConfigured,
    isOpenSubtitlesConfigured,
    computeMovieHash,
    querySubDl,
    queryOpenSubtitles,
    getSubtitles,
    languageName
};
