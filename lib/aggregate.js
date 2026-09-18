// Shared provider-aggregation logic, used by both server.js (the existing
// custom /api/streams endpoint) and addon-server.js (the Stremio/Nuvio addon
// protocol server). Extracted out so both stay in sync automatically instead
// of maintaining two copies of the same provider-loading/ranking logic.

const fs = require('fs');
const path = require('path');

const providerHealth = require('./providerHealth');

const ROOT_DIR = path.join(__dirname, '..');
const PROVIDERS_DIR = path.join(ROOT_DIR, 'providers');
const MANIFEST_PATH = path.join(ROOT_DIR, 'manifest.json');
const RANKING_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'ranking.json');

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

// Buckets a stream's raw quality string ("2160p", "4K", "1080p 10bit", ...)
// into one of a handful of canonical labels used to look up points in
// config/ranking.json's qualityPoints. Anything unrecognized falls to
// 'Unknown' rather than being dropped, so a mislabeled stream still gets
// ranked (typically low, via qualityPoints.Unknown) instead of vanishing.
function normalizeQuality(quality) {
    const q = (quality || '').toString().toLowerCase();
    if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) return '4K';
    if (q.includes('1080')) return '1080p';
    if (q.includes('720')) return '720p';
    if (q.includes('480')) return '480p';
    return 'Unknown';
}

const DEFAULT_RANKING_CONFIG = {
    movie: { providerPoints: { castle: -10 }, qualityPoints: { '4K': 8, '1080p': 6, '720p': 3, '480p': 1, Unknown: 0 }, threshold: 11, minQuality: '1080p', maxSizeGB: 30 },
    series: { providerPoints: { castle: -10 }, qualityPoints: { '1080p': 6, '4K': 5, '720p': 3, '480p': 1, Unknown: 0 }, threshold: 11, maxSizeGB: 30 }
};

// CloudStream-style: every provider and every quality has a point value: a
// stream's score is just the sum of the two. Reproduces today's behavior out
// of the box (see DEFAULT_RANKING_CONFIG) while making it fully editable
// from the admin UI instead of hardcoded - a provider that used to be
// hardcoded-excluded (Castle) is just given very low points instead, which
// naturally preserves "still wins if it's genuinely the only option" as a
// consequence of the scoring rather than a special case.
function scoreStream(stream, typeConfig) {
    const providerPoints = (typeConfig.providerPoints && typeConfig.providerPoints[stream.source]) || 0;
    const qualityPoints = (typeConfig.qualityPoints && typeConfig.qualityPoints[normalizeQuality(stream.quality)]) || 0;
    return providerPoints + qualityPoints;
}

function readRankingConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(RANKING_CONFIG_PATH, 'utf8'));
        return {
            movie: Object.assign({}, DEFAULT_RANKING_CONFIG.movie, raw.movie, {
                providerPoints: Object.assign({}, DEFAULT_RANKING_CONFIG.movie.providerPoints, raw.movie && raw.movie.providerPoints),
                qualityPoints: Object.assign({}, DEFAULT_RANKING_CONFIG.movie.qualityPoints, raw.movie && raw.movie.qualityPoints)
            }),
            series: Object.assign({}, DEFAULT_RANKING_CONFIG.series, raw.series, {
                providerPoints: Object.assign({}, DEFAULT_RANKING_CONFIG.series.providerPoints, raw.series && raw.series.providerPoints),
                qualityPoints: Object.assign({}, DEFAULT_RANKING_CONFIG.series.qualityPoints, raw.series && raw.series.qualityPoints)
            })
        };
    } catch (e) {
        return DEFAULT_RANKING_CONFIG;
    }
}

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

// A genuine 206 (not just an ok status - a 200 to a Range request means the
// host ignored it and is about to hand back the entire file) is the actual
// signal that matters here, checked with the same small ranged GET
// probeStream below uses - deliberately not reused as one function since
// this one only cares about the status/headers, not the body content.
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

// Applied unconditionally (even when the caller asked for raw/unranked
// results via preferred:false) - a non-seekable link isn't a ranking
// preference, it's not something worth ever handing to a player. Only the
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

// Worst-to-best order used only for the movie minQuality floor below -
// 'Unknown' ranks below everything named, so an unrecognized quality is
// hidden by any real minQuality setting, same as today's hardcoded behavior.
const QUALITY_RANK = { Unknown: -1, '480p': 0, '720p': 1, '1080p': 2, '4K': 3 };

// How many of the best-ranked candidates get actually test-fetched before
// settling on one to tag [PREFERRED] - bounded rather than "probe everything"
// so a title with many dead sources doesn't turn every request into a long
// serial chain of timeouts. Probed concurrently (not one at a time), so the
// added latency is roughly one probe's worth, not this number's worth.
const PREFERRED_PROBE_CANDIDATES = 5;
const PROBE_TIMEOUT_MS = 6000;

// A 200/206 status doesn't prove the body is actually video - confirmed live
// this is a real, distinct failure mode from the ones below: a host can
// return a genuine 200 OK carrying an HTML "file not found"/interstitial
// page (e.g. Google Drive's "can't scan this file for viruses" page for a
// programmatic request) instead of the real file. The status-only probe
// tagged that [PREFERRED] anyway, and ExoPlayer then tried to demux HTML as
// a media container and failed with an opaque error
// ("No valid varint length mask found") instead of the stream simply not
// being picked. Reading just the first chunk of the body (not the whole
// file - `reader.cancel()` stops the rest, so this stays cheap even against
// a host that ignores the Range header and would otherwise stream back a
// multi-GB response) and checking it isn't obviously markup catches this
// without materially changing the probe's cost.
function looksLikeHtml(buffer) {
    const text = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).trimStart().toLowerCase();
    return text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<?xml');
}

function readFirstChunk(body) {
    if (!body || typeof body.getReader !== 'function') return Promise.resolve(null);
    const reader = body.getReader();
    return reader.read()
        .then(({ value }) => { reader.cancel().catch(() => {}); return value ? Buffer.from(value) : null; })
        .catch(() => { reader.cancel().catch(() => {}); return null; });
}

// A small ranged GET (not HEAD - some CDNs handle HEAD differently from GET,
// and this whole session's worth of investigation was built on GET+Range
// checks) against the stream's own URL, forwarding whatever headers it
// declares as required for playback. Confirmed live this reliably catches
// exactly the "shows up but won't play" failure modes seen repeatedly this
// session - a dead domain (StreamFlix's NXDOMAIN CDN hosts), a 404 (removed
// files), an already-expired signed URL (PenguPlay's R2 links can arrive
// pre-expired), and an HTML page served with a success status (see
// looksLikeHtml above) - all of which a play-count or quality-tier ranking
// has no way to see coming. Not a full playability guarantee (a real video
// container header still doesn't prove the whole file is undamaged), but a
// real, cheap improvement over tagging [PREFERRED] on nothing but rank.
function probeStream(stream) {
    // usenet.js has no real hotlink to probe here - its "url" only becomes
    // real once a request's own Host header is available (see
    // addon-server.js's buildStreamResponse), and even a real one would mean
    // opening an actual NNTP connection, not a cheap 6-second GET. There's
    // no cheap reachability check available at this stage, so it's treated
    // as reachable rather than unfairly failing every probe and never
    // qualifying for [PREFERRED] no matter how good its score is.
    if (stream.usenetToken) return Promise.resolve(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const headers = Object.assign({ Range: 'bytes=0-1024' }, stream.headers || {});
    return fetch(stream.url, { method: 'GET', headers, signal: controller.signal })
        .then(res => {
            if (!res.ok) {
                if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
                return false;
            }
            return readFirstChunk(res.body).then(chunk => !chunk || !looksLikeHtml(chunk));
        })
        .catch(() => false)
        .then(ok => { clearTimeout(timer); return ok; });
}

// Drops anything over the configured size cap (both types) or below the
// configured minQuality floor (movies only, as today), scores every
// survivor (see scoreStream), then probes the highest-scoring candidates and
// tags the first one that's actually reachable as [PREFERRED] - since
// candidates are already sorted by score, "first reachable" is also "best
// score among the ones checked". Moves it to the front; the rest of the
// (filtered) list is left untouched. Falls back to the single highest-
// scoring candidate untested if every probe in the batch fails, rather than
// tagging nothing - still the best guess available. A pick scoring below
// the configured threshold still gets tagged (nothing else qualifies
// either), just flagged with lowConfidence so a caller can tell the
// difference between "confidently good" and "best of a weak field".
// Shared by applyPreferredLogic and the early-return check below, so the two
// never drift apart on what counts as "in the running" or how it's scored.
// Keyed by object reference (not cloned) in the returned `scores` map, so
// `ranked` stays the exact same objects as `filtered` - needed for the
// `s !== best` identity check both callers do further down.
function filterAndRank(streams, typeConfig, mediaType) {
    let filtered = streams.filter(s => {
        const gb = getStreamSizeGB(s);
        return gb === null || gb <= typeConfig.maxSizeGB;
    });
    if (mediaType !== 'tv' && typeConfig.minQuality) {
        const floor = QUALITY_RANK[typeConfig.minQuality];
        filtered = filtered.filter(s => QUALITY_RANK[normalizeQuality(s.quality)] >= floor);
    }
    const scores = new Map(filtered.map(s => [s, scoreStream(s, typeConfig)]));
    const ranked = filtered.slice().sort((a, b) => scores.get(b) - scores.get(a));
    return { filtered, ranked, scores };
}

function applyPreferredLogic(streams, mediaType) {
    const config = readRankingConfig();
    const typeConfig = mediaType === 'tv' ? config.series : config.movie;
    const { filtered, ranked, scores } = filterAndRank(streams, typeConfig, mediaType);
    if (filtered.length === 0) return Promise.resolve(filtered);

    const candidates = ranked.slice(0, PREFERRED_PROBE_CANDIDATES);
    return Promise.all(candidates.map(probeStream)).then(results => {
        let best = ranked[0];
        for (let i = 0; i < candidates.length; i++) {
            if (results[i]) { best = candidates[i]; break; }
        }
        const bestScore = scores.get(best);
        const tagged = Object.assign({}, best, {
            name: `[PREFERRED] ${best.name || best.source}`.trim(),
            isPreferred: true,
            score: bestScore,
            lowConfidence: bestScore < typeConfig.threshold
        });
        const rest = filtered.filter(s => s !== best);
        return [tagged, ...rest];
    });
}

// How much of the requested provider set has to have answered before a
// merely-decent (not fully confident) candidate is allowed to trigger an
// early return - trades a little extra wait for not basing a response on
// only the 2-3 fastest providers, which skews toward whichever sites happen
// to have the lowest latency rather than the best actual match.
const EARLY_RETURN_MIN_COVERAGE_RATIO = 0.6;
const EARLY_RETURN_MIN_PROVIDERS = 4;

// Checked after every provider settles, on whatever has arrived so far - not
// a lighter-weight version of applyPreferredLogic, the same filtering,
// scoring and reachability probe, just run early and against a partial
// stream list. Returns a tagged result once either:
//  - a candidate clears the real confidence threshold (a genuine, non-
//    lowConfidence pick) and probes as reachable, however few providers
//    have answered yet - always worth returning immediately, or
//  - a solid majority of providers have already answered (see the coverage
//    constants above) and the current best-ranked candidate probes as
//    reachable, even if it's only a lowConfidence pick.
// The second branch matters a lot in practice: under this app's own default
// ranking config, quality points alone cap at 6-8 and the only configured
// providerPoints entry is a -10 penalty, so the "real" confidence threshold
// of 11 is mathematically unreachable for ordinary streams - confirmed live
// while building this, every request fell through to waiting for literally
// every provider. Without the coverage fallback, this whole mechanism would
// quietly never fire for anyone running the defaults.
function tryConfidentPick(streamsSoFar, mediaType, answeredCount, totalCount) {
    return dropUnplayable(streamsSoFar).then(cleaned => {
        const config = readRankingConfig();
        const typeConfig = mediaType === 'tv' ? config.series : config.movie;
        const { filtered, ranked, scores } = filterAndRank(cleaned, typeConfig, mediaType);
        if (!ranked.length) return null;
        const best = ranked[0];
        const bestScore = scores.get(best);
        const confident = bestScore >= typeConfig.threshold;
        const enoughCoverage = answeredCount >= Math.min(EARLY_RETURN_MIN_PROVIDERS, totalCount)
            && answeredCount >= totalCount * EARLY_RETURN_MIN_COVERAGE_RATIO;
        if (!confident && !enoughCoverage) return null;
        return probeStream(best).then(ok => {
            if (!ok) return null;
            const tagged = Object.assign({}, best, {
                name: `[PREFERRED] ${best.name || best.source}`.trim(),
                isPreferred: true,
                score: bestScore,
                lowConfidence: !confident
            });
            const rest = filtered.filter(s => s !== best);
            return [tagged, ...rest];
        });
    });
}

// Short-lived cache of a fully-settled result, populated once every provider
// has answered (whether or not a caller already got an early response - see
// aggregateStreams). Lets a request that arrives shortly after - a player
// retry, a second profile watching the same title, scrolling back to the
// stream list - see the complete set an early return didn't wait for,
// without re-querying every provider again. Only used for the default,
// unscoped, preferred-ranked search (see aggregateStreams's `cacheable`) -
// a scoped provider test or a raw/unranked request always runs fresh.
const RESULT_CACHE_TTL_MS = 3 * 60 * 1000;
const resultCache = new Map();

function cacheKey(tmdbId, mediaType, season, episode) {
    return `${tmdbId}:${mediaType}:${season || ''}:${episode || ''}`;
}

function getCachedResult(tmdbId, mediaType, season, episode) {
    const key = cacheKey(tmdbId, mediaType, season, episode);
    const entry = resultCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { resultCache.delete(key); return null; }
    return entry.result;
}

function setCachedResult(tmdbId, mediaType, season, episode, result) {
    resultCache.set(cacheKey(tmdbId, mediaType, season, episode), { result, expiresAt: Date.now() + RESULT_CACHE_TTL_MS });
}

// Bounds memory on a long-running process - entries also expire lazily on
// read, this just clears out ones nobody happens to re-request.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of resultCache) {
        if (entry.expiresAt <= now) resultCache.delete(key);
    }
}, RESULT_CACHE_TTL_MS).unref();

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
// further. Instead of waiting for literally every provider to settle before
// responding at all, this checks after each one finishes whether a genuinely
// confident (non-lowConfidence), actually-reachable [PREFERRED] pick already
// exists among what's arrived so far (see tryConfidentPick) - if so, it
// returns right then with that partial result, while the rest of the
// providers keep running in the background purely to fill in the fuller
// picture (their eventual full result gets cached - see setCachedResult -
// so a request that lands shortly after can see it without re-querying
// everyone). A provider that genuinely hangs still can't stall a response
// that's already gone out this way; it can only ever affect the (still
// unbounded, as before) background completion and cache population.
function aggregateStreams(tmdbId, mediaType, season, episode, options) {
    const opts = options || {};
    const requestedIds = opts.providerIds && opts.providerIds.length ? opts.providerIds : getEnabledProviderIds();
    const wantPreferred = opts.preferred !== false;
    const startedAt = Date.now();
    const perProvider = {};
    // Only the default, unscoped, preferred-ranked search is eligible for
    // the early-return/cache treatment - a caller that asked for specific
    // provider ids (e.g. the admin panel's per-provider live test) or raw/
    // unranked results wants the real, complete answer for exactly what it
    // asked for, not a partial early guess.
    const cacheable = wantPreferred && !(opts.providerIds && opts.providerIds.length);

    if (cacheable) {
        const cached = getCachedResult(tmdbId, mediaType, season, episode);
        if (cached) {
            return Promise.resolve(Object.assign({}, cached, { totalMs: Date.now() - startedAt, fromCache: true }));
        }
    }

    return new Promise((resolveOuter) => {
        let settled = false;
        const resolveOnce = (result) => {
            if (settled) return;
            settled = true;
            resolveOuter(result);
        };

        const collected = [];
        let earlyCheckInFlight = false;
        let earlyCheckPending = false;

        let answered = 0;
        function checkForConfidentPick() {
            if (settled || !wantPreferred) return;
            if (earlyCheckInFlight) { earlyCheckPending = true; return; }
            earlyCheckInFlight = true;
            tryConfidentPick(collected.slice(), mediaType, answered, requestedIds.length).then(finalStreams => {
                earlyCheckInFlight = false;
                if (finalStreams) {
                    resolveOnce({ streams: finalStreams, perProvider, totalMs: Date.now() - startedAt });
                } else if (earlyCheckPending) {
                    earlyCheckPending = false;
                    checkForConfidentPick();
                }
            });
        }

        let remaining = requestedIds.length;
        const finishOne = () => {
            answered += 1;
            checkForConfidentPick();
            remaining -= 1;
            if (remaining > 0) return;

            // Everyone's answered - compute the real, complete result
            // regardless of whether a partial one already went out above,
            // both to record accurate provider health and so a request
            // that arrives shortly after can be served the fuller set from
            // cache instead of re-querying every provider again.
            dropUnplayable(collected.slice()).then(streams => {
                setImmediate(() => {
                    try {
                        providerHealth.recordRequest(perProvider);
                    } catch (e) {
                        console.error(`[aggregate] provider-health recording failed: ${e.message}`);
                    }
                });
                const finalStreamsPromise = wantPreferred ? applyPreferredLogic(streams, mediaType) : Promise.resolve(streams);
                finalStreamsPromise.then(finalStreams => {
                    const result = { streams: finalStreams, perProvider, totalMs: Date.now() - startedAt };
                    if (cacheable) setCachedResult(tmdbId, mediaType, season, episode, result);
                    resolveOnce(result);
                });
            });
        };

        if (requestedIds.length === 0) {
            finishOne();
            return;
        }

        requestedIds.forEach(id => {
            const mod = loadProvider(id);
            if (!mod || typeof mod.getStreams !== 'function') {
                perProvider[id] = { error: 'provider not found or not enabled' };
                finishOne();
                return;
            }
            const providerStart = Date.now();
            Promise.resolve(mod.getStreams(tmdbId, mediaType, season, episode))
                .then(streams => {
                    const list = Array.isArray(streams) ? streams : [];
                    perProvider[id] = { count: list.length, ms: Date.now() - providerStart };
                    list.forEach(s => collected.push(Object.assign({}, s, { source: id })));
                })
                .catch(err => {
                    perProvider[id] = { error: err.message, ms: Date.now() - providerStart };
                })
                .then(finishOne);
        });
    });
}

module.exports = {
    MANIFEST_PATH,
    PROVIDERS_DIR,
    RANKING_CONFIG_PATH,
    readManifest,
    readRankingConfig,
    DEFAULT_RANKING_CONFIG,
    loadProvider,
    getEnabledProviderIds,
    applyPreferredLogic,
    aggregateStreams
};
