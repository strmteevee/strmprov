// Shared provider-aggregation logic, used by both server.js (the existing
// custom /api/streams endpoint) and addon-server.js (the Stremio/Nuvio addon
// protocol server). Extracted out so both stay in sync automatically instead
// of maintaining two copies of the same provider-loading logic.

const fs = require('fs');
const path = require('path');

const providerHealth = require('./providerHealth');
const tmdb = require('./tmdb');
const { filterByLanguage } = require('./languageFilter');

const ROOT_DIR = path.join(__dirname, '..');
const PROVIDERS_DIR = path.join(ROOT_DIR, 'providers');
const MANIFEST_PATH = path.join(ROOT_DIR, 'manifest.json');

// video-downloads.googleusercontent.com links (a Google Drive delivery
// format several scrapers here can end up resolving to via
// driveseed/HubCloud-style chains) used to be dropped outright by URL
// pattern alone - this host was confirmed live to never honor HTTP Range at
// all (a ranged request got the full multi-GB file back, 200 not 206), and a
// proxy that faked Range support by discarding leading bytes
// (lib/rangeProxy.js) didn't help either: a range near the end of a real
// movie file - what a player needs immediately for many MKVs, whose seek
// index sits at the very end - took over 4 minutes over a Pi's real upload
// bandwidth. Re-verified live (2026-09-17): that's no longer uniformly true.
// Some of these links now return a genuine 206 with a fast (~500ms even on a
// 23GB file) end-of-file seek, but far from all of them - roughly half the
// links returned for the very same title in the same request still silently
// ignore Range and hand back a 200 with the full body. A blanket keep would
// let the still-broken half back in and reproduce the original disaster; a
// blanket drop throws away the half that now works fine. Each one needs an
// actual live check instead of a domain-wide assumption either way.
function isGoogleDriveLink(stream) {
    return typeof stream.url === 'string' && stream.url.includes('googleusercontent.com');
}

const PROBE_TIMEOUT_MS = 6000;

// A genuine 206 (not just an ok status - a 200 to a Range request means the
// host ignored it and is about to hand back the entire file) is the actual
// signal that matters here, checked with a small ranged GET.
function probeGoogleDriveSeekable(stream) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const headers = Object.assign({ Range: 'bytes=0-1024' }, stream.headers || {});
    return fetch(stream.url, { method: 'GET', headers, signal: controller.signal })
        .then(res => {
            if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
            return res.status === 206;
        })
        .catch(() => false)
        .then(ok => { clearTimeout(timer); return ok; });
}

// A non-seekable link isn't something worth ever handing to a player. Only the
// Google Drive links actually need the live check; everything else passes
// straight through.
function dropUnplayable(streams) {
    const driveLinks = streams.filter(isGoogleDriveLink);
    if (driveLinks.length === 0) return Promise.resolve(streams);
    return Promise.all(driveLinks.map(probeGoogleDriveSeekable)).then(results => {
        const seekable = new Set(driveLinks.filter((_, i) => results[i]));
        return streams.filter(s => !isGoogleDriveLink(s) || seekable.has(s));
    });
}

function readManifest() {
    try {
        return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } catch (e) {
        return { scrapers: [] };
    }
}

function loadProvider(id) {
    // Only allow ids that are actually registered in the manifest, and only
    // resolve inside providers/ - callers of this may be driven by public
    // HTTP request params, so a raw id must never reach require()/the
    // filesystem directly.
    const manifest = readManifest();
    const entry = manifest.scrapers.find(s => s.id === id);
    if (!entry) return null;
    const filePath = path.join(ROOT_DIR, entry.filename);
    if (!filePath.startsWith(PROVIDERS_DIR)) return null;
    try {
        delete require.cache[require.resolve(filePath)];
        const mod = require(filePath);
        // Config-driven providers (providers/external-addon.js, used by
        // multiple manifest entries at once) export createProvider(config)
        // instead of a bare getStreams, so the same file can back many
        // differently-configured relays - the manifest entry's own `config`
        // says which one this particular id means. Every other provider is
        // untouched by this branch since it only fires when both conditions
        // hold.
        if (typeof mod.createProvider === 'function' && entry.config) {
            return mod.createProvider(entry.config);
        }
        return mod;
    } catch (e) {
        console.error(`[aggregate] Failed to load provider "${id}": ${e.message}`);
        return null;
    }
}

// streamapi.js is a thin client for this same repo's own /api/streams
// endpoint (via global.SCRAPER_SETTINGS.serverUrl, which Nuvio provides but
// a plain Node process never does) - querying it here can never return
// anything, so it's excluded from the default list.
const SELF_REFERENTIAL_PROVIDERS = ['streamapi'];

function getEnabledProviderIds() {
    const manifest = readManifest();
    return manifest.scrapers
        .filter(s => s.enabled && !SELF_REFERENTIAL_PROVIDERS.includes(s.id))
        .map(s => s.id);
}

// Queries every requested provider (default: every enabled provider in
// manifest.json) concurrently and returns { streams, perProvider, totalMs } -
// this runs in plain Node, not inside the app's sandboxed engine, so there's
// no size/concurrency ceiling to work around here.
//
// No per-provider timeout: HDHub4u/4KHDHub-style multi-step scrapers were
// being cut off under normal (just slow, not hung) conditions and silently
// dropped from the result - removed by request rather than just raised
// further. But confirmed live (2026-09-21) that with NO ceiling at all,
// two full sweeps running concurrently (e.g. a user opening a second episode
// before the first one's stream finished loading) compete for the same
// network/CPU and can both blow well past what any client will wait for - one
// request's answer wasn't even computed until 103s in, and its
// response was never sent at all (the client had already given up); the same
// content retried in isolation minutes later took a normal 15s. This overall
// deadline is the middle ground: it doesn't cut off any INDIVIDUAL provider's
// work the way the old per-provider timeout did (nothing is aborted, and
// nothing here is a hard content-availability signal), it just stops this one
// response from waiting past a point no client will actually sit through -
// whatever's already collected from the providers that answered in time goes
// out, and any provider still running keeps going in the background purely so
// its real timing/result still reaches provider-health accurately.
const AGGREGATE_OVERALL_DEADLINE_MS = 25000;

// A small, priority-ordered stagger rather than a hard concurrency cap -
// every requested provider always gets queried (nothing is skipped or
// starved), this just spreads out the initial burst of outbound connections
// instead of firing all of them in the exact same instant, which is exactly
// the resource contention already found to slow down concurrent full sweeps
// (see AGGREGATE_OVERALL_DEADLINE_MS's own comment above). A provider with a
// strong track record (high success rate, fast average load time - see
// lib/providerHealth.js's getPriorityOrder) starts with no delay at all; a
// less proven or historically slower one starts a little later, giving the
// providers most likely to answer well first access to network/CPU
// resources without ever denying anyone a turn. Safe
// to use a real setTimeout here (unlike inside providers/ files) - this
// module only ever runs server-side in plain Node, never as a distributed
// Nuvio local-scraper plugin.
const PRIORITY_STAGGER_MS = 150;

function delay(ms) {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

// What the language filter needs to know about a title. Without an answer
// (TMDB unreachable or slow) nothing is filtered: better an extra dub in the
// list than a list emptied on a guess.
const LANGUAGE_LOOKUP_TIMEOUT_MS = 5000;

function getLanguageInfo(tmdbId, mediaType) {
    const lookup = tmdb.getDetails(tmdbId, mediaType).then(details => ({
        originalLanguage: details.original_language,
        titles: [details.title, details.name, details.original_title, details.original_name].filter(Boolean)
    }));
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), LANGUAGE_LOOKUP_TIMEOUT_MS));
    return Promise.race([lookup, timeout]).catch(err => {
        console.error(`[aggregate] Language lookup failed for tmdbId=${tmdbId}: ${err.message}`);
        return null;
    });
}

function aggregateStreams(tmdbId, mediaType, season, episode, options) {
    const opts = options || {};
    const requestedIds = opts.providerIds && opts.providerIds.length ? opts.providerIds : getEnabledProviderIds();
    const orderedIds = providerHealth.getPriorityOrder(requestedIds);
    const startedAt = Date.now();
    const perProvider = {};
    // Filled in as each provider resolves (not just once everyone has), so a
    // late/slow one can be left running without blocking finalize() below.
    const collected = [];
    const languageInfo = getLanguageInfo(tmdbId, mediaType);

    const work = orderedIds.map((id, rank) => {
        const mod = loadProvider(id);
        if (!mod || typeof mod.getStreams !== 'function') {
            perProvider[id] = { error: 'provider not found or not enabled' };
            return Promise.resolve();
        }
        return delay(rank * PRIORITY_STAGGER_MS).then(() => {
            // Measured from when this provider's own request actually starts
            // (after its stagger delay), not from rank*STAGGER - baking the
            // deliberate stagger into the recorded timing would make a
            // lower-priority provider look artificially slower every single
            // request, permanently entrenching its own low rank.
            const providerStart = Date.now();
            return Promise.resolve(mod.getStreams(tmdbId, mediaType, season, episode))
                .then(streams => {
                    const list = Array.isArray(streams) ? streams : [];
                    perProvider[id] = { count: list.length, ms: Date.now() - providerStart };
                    collected.push(...list.map(s => Object.assign({}, s, { source: id })));
                })
                .catch(err => {
                    perProvider[id] = { error: err.message, ms: Date.now() - providerStart };
                });
        });
    });

    const allDone = Promise.all(work).then(() => 'ALL_DONE');
    // Not tied to finalize()'s own timing below - this fires whenever every
    // provider has actually settled, even if that's well after this request
    // already answered from the deadline branch, so provider-health still
    // reflects each provider's real outcome/timing instead of silently
    // missing entries for whichever ones were still running at the deadline.
    allDone.then(() => {
        setImmediate(() => {
            try {
                providerHealth.recordRequest(perProvider);
            } catch (e) {
                console.error(`[aggregate] provider-health recording failed: ${e.message}`);
            }
        });
    });

    function finalize() {
        // Snapshot via slice() - still-running providers keep pushing into
        // `collected` after this point, and dropUnplayable's own async probing
        // shouldn't be reading from an array that's concurrently mutating out
        // from under it.
        const snapshot = collected.slice();
        return languageInfo.then(info => {
            if (!info || !info.originalLanguage) return snapshot;
            const wanted = filterByLanguage(snapshot, info);
            if (wanted.length < snapshot.length) {
                console.log(`[aggregate] Language filter (original: ${info.originalLanguage}): dropped ${snapshot.length - wanted.length}/${snapshot.length} stream(s) for tmdbId=${tmdbId}`);
            }
            return wanted;
        }).then(dropUnplayable).then(streams => ({
            streams,
            perProvider: Object.assign({}, perProvider),
            totalMs: Date.now() - startedAt
        }));
    }

    const deadline = new Promise(resolve => setTimeout(() => resolve('DEADLINE'), AGGREGATE_OVERALL_DEADLINE_MS));
    return Promise.race([allDone, deadline]).then(reason => {
        if (reason === 'DEADLINE') {
            const stillRunning = requestedIds.filter(id => !perProvider[id]);
            console.log(`[aggregate] Overall ${AGGREGATE_OVERALL_DEADLINE_MS}ms deadline reached for tmdbId=${tmdbId} - responding with ${collected.length} stream(s) from ${requestedIds.length - stillRunning.length}/${requestedIds.length} provider(s); still running in the background: ${stillRunning.join(', ') || 'none'}`);
        }
        return finalize();
    });
}

module.exports = {
    MANIFEST_PATH,
    PROVIDERS_DIR,
    readManifest,
    loadProvider,
    getEnabledProviderIds,
    aggregateStreams
};
