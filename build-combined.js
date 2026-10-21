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
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');

// id: manifest id / filename (providers/<id>.js)
// varName: JS identifier for this source's IIFE result (must be a valid
//   identifier - several ids aren't: "4khdhub" starts with a digit,
//   "anime-dekho"/"kickassanime" would need dashes stripped anyway)
// name: display name used in logging and the `source` field on streams
// external: true for sources that relay another Stremio addon via the
//   shared providers/external-addon.js factory instead of having their own
//   provider file - see buildSourceBlocks() below for how these are inlined.
const SOURCES = [
  { id: 'vidrock', varName: 'Vidrock', name: 'Vidrock' },
  { id: 'moviebox', varName: 'MovieBox', name: 'MovieBox' },
  { id: 'rivestream', varName: 'RiveStream', name: 'RiveStream' },
  { id: '4khdhub', varName: 'FourKHdHub', name: '4KHDHub' },
  { id: 'vixsrc', varName: 'VixSrc', name: 'Vixsrc' },
  { id: 'vidlink', varName: 'VidLink', name: 'Vidlink' },
  { id: 'castle', varName: 'Castle', name: 'Castle' },
  { id: 'hdhub4u', varName: 'HdHub4u', name: 'HDHub4u', external: true },
  { id: 'penguplay', varName: 'PenguPlay', name: 'PenguPlay', external: true },
  // movieblast removed entirely (2026-09-20, not just excluded from this
  // bundle) - its own CDN's TLS/domain setup was confirmed broken across
  // every hostname it uses (a generic Fastly default-SNI cert instead of one
  // for its own domain, 421 Misdirected Request even bypassing that), with
  // no fix possible client-side.
  { id: 'kickassanime', varName: 'KickassAnime', name: 'KickassAnime' },
  { id: 'allmovieland', varName: 'AllMovieLand', name: 'AllMovieLand' },
  { id: 'cinejoy', varName: 'Cinejoy', name: 'Cinejoy' },
  { id: 'filmyfiy', varName: 'Filmyfiy', name: 'Filmyfiy' },
  { id: 'moviesdrive', varName: 'MoviesDrive', name: 'MoviesDrive' },
  { id: 'hdmovie2', varName: 'HdMovie2', name: 'HdMovie2' },
  { id: 'moviesmod', varName: 'MoviesMod', name: 'MoviesMod' },
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

// Sources that relay another addon (providers/external-addon.js, driven by
// manifest.json's per-entry `config`) share ONE inlined copy of that file
// regardless of how many such sources exist, wrapped in a factory IIFE - the
// config itself is read out of manifest.json at generation time (the same
// file lib/aggregate.js reads server-side) and baked into the generated
// output as a literal object, since the standalone plugin has no filesystem
// access to manifest.json at runtime. This keeps manifest.json - editable
// from the admin UI - as the single place these are configured; re-running
// `node build-combined.js` after an edit picks up the new value.
function buildExternalAddonFactoryBlock() {
  const filePath = path.join(PROVIDERS_DIR, 'external-addon.js');
  const content = fs.readFileSync(filePath, 'utf8');
  const { body } = stripExport(content);
  return `const ExternalAddonFactory = (function () {\n${body}\n  return { createProvider };\n})();\n`;
}

function buildSourceBlocks() {
  const hasExternal = SOURCES.some(src => src.external);
  const manifest = hasExternal ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : null;
  const blocks = [];
  if (hasExternal) blocks.push(buildExternalAddonFactoryBlock());

  for (const src of SOURCES) {
    if (src.external) {
      const entry = manifest.scrapers.find(s => s.id === src.id);
      if (!entry || !entry.config) {
        throw new Error(`build-combined.js: manifest.json has no config for external source "${src.id}"`);
      }
      blocks.push(`const ${src.varName}Source = ExternalAddonFactory.createProvider(${JSON.stringify(entry.config)});\n`);
      continue;
    }
    const filePath = path.join(PROVIDERS_DIR, `${src.id}.js`);
    const content = fs.readFileSync(filePath, 'utf8');
    const { body, exportedName } = stripExport(content);
    blocks.push(`const ${src.varName}Source = (function () {\n${body}\n  return { getStreams: ${exportedName} };\n})();\n`);
  }
  return blocks.join('\n');
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
  const guard = fetch(\`https://httpbin.org/delay/\${PROBE_TIMEOUT_SECONDS}\`).then(() => 'TIMED_OUT').catch(() => 'GUARD_UNAVAILABLE');
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
      name: \`[PREFERRED] \${best.name || best.source}\`.trim(),
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
    return applyPreferredLogic(collected, type).then(ranked => {
      console.log(\`[AllSources] Returning \${ranked.length} stream(s) after ranking (from \${collected.length} collected)\`);
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
