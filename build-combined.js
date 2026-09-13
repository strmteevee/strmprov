// Assembles providers/allsources.js by inlining every real scraper's full
// source into its own IIFE (Nuvio's sandbox has no cross-file require of
// sibling plugin scripts, so each source's code has to be physically
// present in the one file) and adding a combining/ranking layer on top.
//
// Run this whenever a source provider listed below changes, the same way
// `node build.js` re-bundles the esbuild-based providers - this file is
// generated output, not meant to be hand-edited.
//
// Why a generator instead of a hand-written combined file: a dozen-plus
// providers' worth of scraping/decryption logic pasted and kept in sync by
// hand would
// drift out of date the moment any individual provider file changes (which
// happens often - see this repo's fix history). Regenerating mechanically
// from the current provider files guarantees the combined file never lags
// behind them.

const fs = require('fs');
const path = require('path');

const PROVIDERS_DIR = path.join(__dirname, 'providers');
const OUTPUT_PATH = path.join(PROVIDERS_DIR, 'allsources.js');

// id: manifest id / filename (providers/<id>.js)
// varName: JS identifier for this source's IIFE result (must be a valid
//   identifier - several ids aren't: "4khdhub" starts with a digit,
//   "anime-dekho"/"kickassanime" would need dashes stripped anyway)
// name: display name used in logging and the `source` field on streams
const SOURCES = [
  { id: 'peachify', varName: 'Peachify', name: 'Peachify' },
  { id: 'vidrock', varName: 'Vidrock', name: 'Vidrock' },
  { id: 'moviebox', varName: 'MovieBox', name: 'MovieBox' },
  { id: 'rivestream', varName: 'RiveStream', name: 'RiveStream' },
  { id: '4khdhub', varName: 'FourKHdHub', name: '4KHDHub' },
  { id: 'netmirror', varName: 'NetMirror', name: 'NetMirror' },
  { id: 'vixsrc', varName: 'VixSrc', name: 'Vixsrc' },
  { id: 'vidlink', varName: 'VidLink', name: 'Vidlink' },
  { id: 'castle', varName: 'Castle', name: 'Castle' },
  { id: 'hdhub4u', varName: 'HdHub4u', name: 'HDHub4u' },
  { id: 'penguplay', varName: 'PenguPlay', name: 'PenguPlay' },
  { id: 'movieblast', varName: 'MovieBlast', name: 'MovieBlast' },
  { id: 'anime-dekho', varName: 'AnimeDekho', name: 'AnimeDekho' },
  { id: 'kickassanime', varName: 'KickassAnime', name: 'KickassAnime' },
  { id: 'vegamovies', varName: 'VegaMovies', name: 'VegaMovies' },
  { id: 'allmovieland', varName: 'AllMovieLand', name: 'AllMovieLand' },
];

// Strips a provider file's trailing `module.exports = ...` statement (or,
// for the two files that guard it with a React-Native-style UMD check, the
// whole `if (typeof module !== 'undefined' ...) { ... } else { ... }`
// block) and reports back which internal identifier actually holds the
// getStreams function - most files export `getStreams` directly, but
// anime-dekho.js/kickassanime.js export an aliased `wrappedGetStreams`.
function stripExport(content) {
  const umdIdx = content.indexOf("if (typeof module !== 'undefined'");
  if (umdIdx !== -1) {
    let cut = umdIdx;
    const before = content.slice(0, umdIdx);
    const commentMatch = before.match(/\/\/[^\n]*\n\s*$/);
    if (commentMatch) cut = umdIdx - commentMatch[0].length + commentMatch[0].indexOf('\n') + 1;
    return { body: content.slice(0, cut).trimEnd(), exportedName: 'getStreams' };
  }

  const idx = content.lastIndexOf('module.exports');
  if (idx === -1) {
    throw new Error('No module.exports found');
  }
  const lineStart = content.lastIndexOf('\n', idx) + 1;
  const tail = content.slice(idx);
  const m = tail.match(/module\.exports\s*=\s*\{\s*getStreams(?:\s*:\s*(\w+))?/);
  const exportedName = (m && m[1]) || 'getStreams';
  return { body: content.slice(0, lineStart).trimEnd(), exportedName };
}

function buildSourceBlocks() {
  return SOURCES.map(src => {
    const filePath = path.join(PROVIDERS_DIR, `${src.id}.js`);
    const content = fs.readFileSync(filePath, 'utf8');
    const { body, exportedName } = stripExport(content);
    return `const ${src.varName}Source = (function () {\n${body}\n  return { getStreams: ${exportedName} };\n})();\n`;
  }).join('\n');
}

const HEADER = `// AllSources - combines every scraper in this repo into one Nuvio plugin.
//
// GENERATED FILE - do not hand-edit. Run \`node build-combined.js\` from the
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

`;

const COMBINER = `
const SOURCES = [
${SOURCES.map(s => `  { id: '${s.id}', name: '${s.name}', mod: ${s.varName}Source },`).join('\n')}
];

// ---- Ranking logic, ported verbatim from this repo's server.js aggregator ----

const MAX_SIZE_GB = 30;

// Parses size strings like "40.16 GB", "700 MB", "1.2 TB" into GB.
function parseSizeToGB(sizeStr) {
  if (!sizeStr) return null;
  const m = String(sizeStr).match(/([\\d.]+)\\s*(TB|GB|MB)/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'TB') return value * 1024;
  if (unit === 'MB') return value / 1024;
  return value;
}

// Not every source puts the size in its own field - some (e.g. 4KHDHub)
// only embed it as trailing text in \`title\` (".mkv\\n40.16 GB"). Check the
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

// Drops anything over MAX_SIZE_GB or backed by a known-non-seekable host,
// hides sub-1080p results for movies, then tags the best remaining stream by
// resolution tier as [PREFERRED] and moves it to the front - the rest of the
// (filtered) list is left untouched.
function applyPreferredLogic(streams, mediaType) {
  let filtered = streams.filter(s => {
    const gb = getStreamSizeGB(s);
    return (gb === null || gb <= MAX_SIZE_GB) && !isNonSeekableGoogleDriveLink(s);
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
    name: \`[PREFERRED] \${best.name || best.source}\`.trim(),
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
    chain = chain.then(() => fetch(\`https://httpbin.org/delay/\${chunk}\`));
    remaining -= chunk;
  }
  return chain.then(() => 'TIMED_OUT').catch(() => 'GUARD_UNAVAILABLE');
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  console.log(\`[AllSources] getStreams start tmdbId=\${tmdbId} type=\${type} S=\${season || ''} E=\${episode || ''}\`);

  const collected = [];
  const sourceRuns = SOURCES.map(src => {
    return Promise.resolve()
      .then(() => src.mod.getStreams(tmdbId, type, season, episode))
      .then(streams => {
        const list = Array.isArray(streams) ? streams : [];
        if (list.length) {
          console.log(\`[AllSources] \${src.name}: \${list.length} stream(s)\`);
          collected.push(...list.map(s => Object.assign({}, s, { source: src.id })));
        }
      })
      .catch(err => {
        console.log(\`[AllSources] \${src.name} failed: \${err.message}\`);
      });
  });

  function finalize() {
    const ranked = applyPreferredLogic(collected, type);
    console.log(\`[AllSources] Returning \${ranked.length} stream(s) after ranking (from \${collected.length} collected)\`);
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
      console.log(\`[AllSources] \${COMBINE_TIMEOUT_SECONDS}s cutoff reached - returning what has been found so far\`);
    }
    return finalize();
  });
}

module.exports = { getStreams };
`;

function main() {
  const sourceBlocks = buildSourceBlocks();
  fs.writeFileSync(OUTPUT_PATH, HEADER + sourceBlocks + COMBINER);
  console.log(`Wrote ${OUTPUT_PATH} (${SOURCES.length} sources combined)`);
}

main();
