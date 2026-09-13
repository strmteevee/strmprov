// Daily health-check for every scraper in this repo.
//
//   node test-providers.js
//
// Tests each enabled provider (read live from manifest.json, so this list
// stays in sync automatically as providers are added/removed) against one
// representative movie/TV/anime title, reports timing and stream counts, and
// flags anything that looks like a regression:
//   - a provider that THROWS (a real bug - every provider here is supposed to
//     catch its own errors internally and resolve to [], never reject)
//   - a provider that hangs past a generous timeout (a real bug - see the
//     Vidrock/hakunaymatata.com incident this repo already hit once)
//   - a provider returning 0 across all three categories (worth a look, but
//     not necessarily broken - a title's absence from one site isn't a bug)
//
// This is a smoke test, not a correctness oracle: a single 0-result run for
// one provider on one title doesn't prove anything is wrong (upstream sites
// genuinely don't carry every title, and some transient network hiccups are
// normal) - it's meant to catch the "used to return results, now doesn't" or
// "used to take 2s, now takes 45s" class of regression at a glance, the same
// way the Vidrock and StreamFlix bugs were actually found this session.
//
// Every run appends a one-line JSON summary to test-results.log so you can
// diff today's run against yesterday's without re-running anything.

const fs = require('fs');
const path = require('path');

const PROVIDERS_DIR = path.join(__dirname, 'providers');
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const LOG_PATH = path.join(__dirname, 'test-results.log');

const PER_PROVIDER_TIMEOUT_MS = 60000;
const SLOW_THRESHOLD_MS = 15000;

// Self-referential (calls back into this same repo's own server.js) - never
// returns anything on its own and isn't a real scraper, so it's not useful
// to include here the way server.js already excludes it from aggregation.
const SKIP_IDS = ['streamapi'];

// One representative title per category. Change these here if you want to
// track a different title over time - what matters for a daily check is
// consistency (comparing today's run against yesterday's for the SAME
// titles), not covering every possible title.
const TITLES = [
  { label: 'Movie', tmdbId: '550', type: 'movie' },                          // Fight Club
  { label: 'TV', tmdbId: '1396', type: 'tv', season: 1, episode: 1 },        // Breaking Bad S1E1
  { label: 'Anime', tmdbId: '1429', type: 'tv', season: 1, episode: 1 }      // Attack on Titan S1E1
];

function getEnabledProviderIds() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return manifest.scrapers
    .filter(s => s.enabled && !SKIP_IDS.includes(s.id))
    .map(s => s.id);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).then(
    value => { clearTimeout(timer); return value; },
    err => { clearTimeout(timer); throw err; }
  );
}

function testProvider(id, title) {
  const t0 = Date.now();
  return Promise.resolve()
    .then(() => {
      const modulePath = path.join(PROVIDERS_DIR, `${id}.js`);
      delete require.cache[require.resolve(modulePath)];
      const mod = require(modulePath);
      return withTimeout(
        Promise.resolve(mod.getStreams(title.tmdbId, title.type, title.season || null, title.episode || null)),
        PER_PROVIDER_TIMEOUT_MS
      );
    })
    .then(streams => ({
      id,
      ms: Date.now() - t0,
      count: Array.isArray(streams) ? streams.length : -1,
      error: null
    }))
    .catch(err => ({
      id,
      ms: Date.now() - t0,
      count: 0,
      error: err.message
    }));
}

async function run() {
  const ids = getEnabledProviderIds();
  console.log(`Testing ${ids.length} enabled provider(s) across ${TITLES.length} categories...\n`);

  const results = {};
  for (const id of ids) results[id] = {};

  for (const title of TITLES) {
    console.log(`===== ${title.label} =====`);
    // Suppress each provider's own console.log/error noise here - we only
    // want this script's own summary lines in the output.
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    const rows = await Promise.all(ids.map(id => testProvider(id, title)));
    console.log = originalLog;
    console.error = originalError;

    rows.sort((a, b) => b.ms - a.ms);
    for (const r of rows) {
      results[r.id][title.label] = r;
      const status = r.error ? 'ERROR' : (r.count > 0 ? 'OK' : 'EMPTY');
      const slowFlag = (!r.error && r.ms >= SLOW_THRESHOLD_MS) ? '  [SLOW]' : '';
      const line = `${String(r.ms).padStart(7)}ms  ${status.padEnd(6)} count=${String(r.count).padStart(3)}  ${r.id}${slowFlag}`;
      console.log(r.error ? `${line}  (${r.error})` : line);
    }
    console.log('');
  }

  console.log('===== Summary =====');
  const errored = [];
  const alwaysEmpty = [];
  const slow = [];
  for (const id of ids) {
    const perTitle = results[id];
    const values = Object.values(perTitle);
    if (values.some(r => r.error)) errored.push(id);
    if (values.every(r => !r.error && r.count === 0)) alwaysEmpty.push(id);
    if (values.some(r => !r.error && r.ms >= SLOW_THRESHOLD_MS)) slow.push(id);
  }

  if (errored.length) {
    console.log(`THREW AN ERROR (real bug - providers should never throw): ${errored.join(', ')}`);
  }
  if (alwaysEmpty.length) {
    console.log(`ZERO RESULTS across all 3 categories (may be broken, or may just not carry these specific titles): ${alwaysEmpty.join(', ')}`);
  }
  if (slow.length) {
    console.log(`SLOW (>= ${SLOW_THRESHOLD_MS / 1000}s on at least one category): ${slow.join(', ')}`);
  }
  if (!errored.length && !alwaysEmpty.length && !slow.length) {
    console.log('Everything looks healthy.');
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    providerCount: ids.length,
    errored,
    alwaysEmpty,
    slow,
    results
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(logEntry) + '\n');
  console.log(`\nAppended run summary to ${path.basename(LOG_PATH)}`);

  process.exitCode = errored.length ? 1 : 0;
}

run();
