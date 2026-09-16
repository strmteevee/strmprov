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

// Returns [{ id, requests, success, empty, error, successRate, lastSeen }],
// summed across the retained window, sorted worst-success-rate first so a
// chronically broken provider surfaces at the top rather than needing to be
// hunted for.
function getHealth() {
    const data = readHealth();
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

module.exports = { recordRequest, getHealth, HEALTH_PATH, RETENTION_DAYS };
