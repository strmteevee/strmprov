// Per-profile watch-history storage for addon-server.js.
//
// Stremio's addon protocol has no "report watch progress" callback back to
// addons - a catalog is a read-only listing, nothing tells an addon what the
// viewer actually watched afterward. The only signal this addon can observe
// at all is "this profile requested a stream for this title", so that's what
// gets recorded here: every /stream request is treated as a watch event.
// That's a real protocol constraint, not a design shortcut - there's no
// richer signal available to a self-hosted addon than that.
//
// One JSON file per profile (data/profiles/<profileId>.json), each holding a
// capped, most-recent-first array of { tmdbId, mediaType, watchedAt }. A
// single self-hosted server with a handful of profiles making occasional
// requests doesn't need a real database or write-locking - plain
// read-modify-write is fine at this scale.

const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, '..', 'data', 'profiles');
const MAX_HISTORY_PER_PROFILE = 200;

function ensureDir() {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

function profilePath(profileId) {
    // profileId reaches here from a URL path segment - keep it to safe
    // filename characters so it can never escape PROFILES_DIR.
    const safeId = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(PROFILES_DIR, `${safeId}.json`);
}

function getHistory(profileId) {
    try {
        const raw = fs.readFileSync(profilePath(profileId), 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

// Records a watch event, most-recent-first, deduping so re-watching a title
// moves it back to the front instead of creating a second entry. title/year
// are stored alongside the id so building an AI recommendation prompt later
// doesn't need a round trip back to TMDB just to name what was watched.
function recordWatch(profileId, entry) {
    ensureDir();
    const history = getHistory(profileId);
    const deduped = history.filter(h => !(String(h.tmdbId) === String(entry.tmdbId) && h.mediaType === entry.mediaType));
    deduped.unshift({
        tmdbId: entry.tmdbId,
        mediaType: entry.mediaType,
        title: entry.title || null,
        year: entry.year || null,
        watchedAt: Date.now()
    });
    const capped = deduped.slice(0, MAX_HISTORY_PER_PROFILE);
    try {
        fs.writeFileSync(profilePath(profileId), JSON.stringify(capped, null, 2));
    } catch (e) {
        console.error(`[profileStore] Failed to save history for profile "${profileId}": ${e.message}`);
    }
}

function cachePath(profileId, cacheKey) {
    const safeId = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
    const safeKey = String(cacheKey).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(PROFILES_DIR, `${safeId}-${safeKey}.json`);
}

// A generic per-profile cache slot, used to avoid re-generating the AI
// recommendation list (a real API call with latency and quota, unlike a free
// TMDB GET) on every single catalog request - see addon-server.js's
// buildCatalog for the actual invalidation policy (regenerate when the
// watch-history seed set changes, or after a day, whichever comes first).
function getCache(profileId, cacheKey) {
    try {
        return JSON.parse(fs.readFileSync(cachePath(profileId, cacheKey), 'utf8'));
    } catch (e) {
        return null;
    }
}

function setCache(profileId, cacheKey, data) {
    ensureDir();
    try {
        fs.writeFileSync(cachePath(profileId, cacheKey), JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[profileStore] Failed to write cache "${cacheKey}" for profile "${profileId}": ${e.message}`);
    }
}

module.exports = {
    PROFILES_DIR,
    getHistory,
    recordWatch,
    getCache,
    setCache
};
