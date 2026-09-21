// Rolling, day-bucketed record of how each provider actually performs on
// real aggregateStreams() calls, so the admin panel can surface a provider
// that's chronically returning nothing or erroring - the kind of thing this
// project has repeatedly only found by hand, after a specific movie/show
// happened to fail in front of a viewer (Castle's wrong-language bug,
// StreamFlix's dead CDN hosts, UHDMovies' broken driveseed links).
//
// One JSON file, same read-modify-write-on-disk pattern as
// lib/profileStore.js - this runs at the scale of a single self-hosted
// server with occasional requests, not something that needs a real database.

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const HEALTH_PATH = path.join(ROOT_DIR, 'data', 'provider-health.json');
const MANIFEST_PATH = path.join(ROOT_DIR, 'manifest.json');

// How many days of daily buckets to keep per provider - old enough to show
// a real trend, short enough that the file never grows unbounded.
const RETENTION_DAYS = 14;

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function readHealth() {
    try {
        return JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function writeHealth(data) {
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(data, null, 2));
}

function pruneOldDays(days) {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const day of Object.keys(days)) {
        if (Date.parse(day) < cutoff) delete days[day];
    }
}

// perProvider: the same { [id]: {count, ms} | {error, ms} } object
// lib/aggregate.js's aggregateStreams() already builds for every request -
// called once after each real call resolves. Deliberately does its own
// try/catch at the call site (see aggregate.js) and runs off the response's
// own critical path - this project already learned the hard way this
// session that adding synchronous disk I/O (or anything else) to
// buildStreamResponse's path costs real, user-visible latency.
function recordRequest(perProvider) {
    const data = readHealth();
    const day = todayKey();
    for (const [id, info] of Object.entries(perProvider)) {
        if (!data[id]) data[id] = {};
        if (!data[id][day]) data[id][day] = { requests: 0, success: 0, empty: 0, error: 0 };
        const bucket = data[id][day];
        bucket.requests += 1;
        if (info.error) bucket.error += 1;
        else if (info.count > 0) bucket.success += 1;
        else bucket.empty += 1;
        pruneOldDays(data[id]);
    }
    writeHealth(data);
}

// Every id manifest.json currently declares a scraper for, enabled or not -
// a provider that's just disabled should keep its history; one that's been
// deleted from this repo entirely (movieblast, streamflix, etc.) shouldn't
// still be occupying a row in this file forever, since recordRequest only
// ever adds entries and nothing else ever prunes one on its own.
function getKnownProviderIds() {
    try {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        return new Set((manifest.scrapers || []).map(s => s.id));
    } catch (e) {
        return null; // manifest unreadable - don't prune anything based on a guess
    }
}

// Returns [{ id, requests, success, empty, error, successRate, lastSeen }],
// summed across the retained window, sorted worst-success-rate first so a
// chronically broken provider surfaces at the top rather than needing to be
// hunted for. Also drops (and persists the drop of) any tracked id that no
// longer corresponds to a real provider in manifest.json - see
// getKnownProviderIds above.
function getHealth() {
    const data = readHealth();
    const knownIds = getKnownProviderIds();
    if (knownIds) {
        let changed = false;
        for (const id of Object.keys(data)) {
            if (!knownIds.has(id)) { delete data[id]; changed = true; }
        }
        if (changed) writeHealth(data);
    }
    const rows = [];
    for (const [id, days] of Object.entries(data)) {
        let requests = 0, success = 0, empty = 0, error = 0, lastSeen = null;
        for (const [day, bucket] of Object.entries(days)) {
            requests += bucket.requests;
            success += bucket.success;
            empty += bucket.empty;
            error += bucket.error;
            if (!lastSeen || day > lastSeen) lastSeen = day;
        }
        rows.push({ id, requests, success, empty, error, successRate: requests ? success / requests : null, lastSeen });
    }
    rows.sort((a, b) => {
        const ar = a.successRate === null ? 1 : a.successRate;
        const br = b.successRate === null ? 1 : b.successRate;
        return ar - br;
    });
    return rows;
}

// By request: a manual "start fresh" action for the admin dashboard - wipes
// every tracked provider's history outright rather than zeroing counts
// in-place, which also takes care of the other half of the request for free:
// a provider removed from manifest.json since its stats were last recorded
// (movieblast, streamflix, etc. - actually removed from this repo, not just
// disabled) would otherwise sit in this file indefinitely with no code path
// that ever prunes it, since recordRequest only ever adds entries and
// getHealth reads back whatever's on disk without checking it against the
// current manifest.
function resetHealth() {
    writeHealth({});
}

module.exports = { recordRequest, getHealth, resetHealth, HEALTH_PATH, RETENTION_DAYS };
