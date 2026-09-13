// Shared provider-aggregation logic, used by both server.js (the existing
// custom /api/streams endpoint) and addon-server.js (the Stremio/Nuvio addon
// protocol server). Extracted out so both stay in sync automatically instead
// of maintaining two copies of the same provider-loading/ranking logic.

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const PROVIDERS_DIR = path.join(ROOT_DIR, 'providers');
const MANIFEST_PATH = path.join(ROOT_DIR, 'manifest.json');
// Was 20s - too tight for the heavier multi-step HTML scrapers (HDHub4u,
// 4KHDHub) especially on weaker hardware (a Raspberry Pi) or under variable
// network/site-load conditions, where they occasionally exceed it and get
// silently dropped from the aggregate even though they'd have returned
// good results given a bit more time. Providers run in parallel here, so
// raising this only extends the WORST case (when that one slow provider is
// genuinely the last to finish) - it doesn't add to every request.
const PROVIDER_TIMEOUT_MS = 40000;

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

// Not every provider puts the size in its own field - some (e.g. 4KHDHub)
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
//
// video-downloads.googleusercontent.com links (a Google Drive delivery
// format several scrapers here can end up resolving to via
// driveseed/HubCloud-style chains) are a second, cross-provider case of the
// same idea: confirmed live that this host doesn't support HTTP Range
// requests at all - a ranged request gets the full multi-GB file back, 200
// not 206 - which breaks players that need random access just to start
// (ExoPlayer/Android TV confirmed, "links visible but not playable"). Any
// other source, including a different link from the very same provider,
// beats one of these regardless of quality tier, for the same reason Castle
// does.
function isNonSeekableGoogleDriveLink(stream) {
    return typeof stream.url === 'string' && stream.url.includes('googleusercontent.com');
}

function preferredRank(stream, tierFn) {
    return [
        stream.source === 'castle' ? 1 : 0,
        isNonSeekableGoogleDriveLink(stream) ? 1 : 0,
        tierFn(stream.quality)
    ];
}

function rankIsBetter(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
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
        return require(filePath);
    } catch (e) {
        console.error(`[aggregate] Failed to load provider "${id}": ${e.message}`);
        return null;
    }
}

// streamapi.js is a thin client for this same repo's own /api/streams
// endpoint (via global.SCRAPER_SETTINGS.serverUrl, which Nuvio provides but
// a plain Node process never does) - querying it here can never return
// anything, so it's excluded from the default list. allsources.js already
// wraps every individual provider and applies its own preferred-tagging
// internally - including it here too would query every provider twice and,
// worse, let its already-[PREFERRED]-tagged pick get re-tagged by the outer
// applyPreferredLogic below, producing a "[PREFERRED] [PREFERRED] ..." name.
const SELF_REFERENTIAL_PROVIDERS = ['streamapi', 'allsources'];

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
// further. The real tradeoff: a provider that genuinely hangs (not just
// runs long) rather than erroring out will now stall this whole request
// indefinitely, since Promise.all below waits for every provider to settle.
function aggregateStreams(tmdbId, mediaType, season, episode, options) {
    const opts = options || {};
    const requestedIds = opts.providerIds && opts.providerIds.length ? opts.providerIds : getEnabledProviderIds();
    const wantPreferred = opts.preferred !== false;
    const startedAt = Date.now();
    const perProvider = {};

    const work = requestedIds.map(id => {
        const mod = loadProvider(id);
        if (!mod || typeof mod.getStreams !== 'function') {
            perProvider[id] = { error: 'provider not found or not enabled' };
            return Promise.resolve([]);
        }
        const providerStart = Date.now();
        return Promise.resolve(mod.getStreams(tmdbId, mediaType, season, episode))
            .then(streams => {
                const list = Array.isArray(streams) ? streams : [];
                perProvider[id] = { count: list.length, ms: Date.now() - providerStart };
                return list.map(s => Object.assign({}, s, { source: id }));
            })
            .catch(err => {
                perProvider[id] = { error: err.message, ms: Date.now() - providerStart };
                return [];
            });
    });

    return Promise.all(work).then(results => {
        const streams = results.flat();
        const finalStreams = wantPreferred ? applyPreferredLogic(streams, mediaType) : streams;
        return {
            streams: finalStreams,
            perProvider,
            totalMs: Date.now() - startedAt
        };
    });
}

module.exports = {
    MANIFEST_PATH,
    PROVIDERS_DIR,
    readManifest,
    loadProvider,
    getEnabledProviderIds,
    applyPreferredLogic,
    aggregateStreams
};
