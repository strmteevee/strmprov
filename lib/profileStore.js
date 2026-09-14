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

// Lists every profile that has a history file, for the admin UI's profiles
// panel. Cache files (data/profiles/<id>-<cacheKey>.json) are excluded by
// only matching filenames with no extra hyphenated suffix.
function listProfiles() {
    ensureDir();
    let files;
    try {
        files = fs.readdirSync(PROFILES_DIR);
    } catch (e) {
        return [];
    }
    return files
        .filter(f => /^[a-zA-Z0-9_-]+\.json$/.test(f) && !/-/.test(f.replace(/\.json$/, '')) )
        .map(f => {
            const profileId = f.replace(/\.json$/, '');
            const history = getHistory(profileId);
            return {
                profileId,
                historyCount: history.length,
                lastWatchedAt: history.length ? history[0].watchedAt : null,
                // Most-recent-first, matching history's own order. A title
                // can be null for an older entry recorded before
                // addon-server.js started forwarding it - filtered out here
                // rather than showing a blank in the admin UI.
                titles: history.map(h => h.title).filter(Boolean)
            };
        });
}

// Deletes a profile's watch history and any cache slots it has (data/profiles/
// <id>.json and <id>-<cacheKey>.json) - used by the admin UI's "reset For
// You" action. Missing files are not an error; the end state (nothing left
// for this profile) is what matters. Deliberately leaves <id>-base.json
// alone - a base profile is a manually curated setting, not derived watch
// data, so resetting history shouldn't also erase it.
function resetProfile(profileId) {
    const safeId = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
    let files;
    try {
        files = fs.readdirSync(PROFILES_DIR);
    } catch (e) {
        return;
    }
    const toDelete = files.filter(f => (f === `${safeId}.json` || f.startsWith(`${safeId}-`)) && f !== `${safeId}-base.json`);
    for (const f of toDelete) {
        try {
            fs.unlinkSync(path.join(PROFILES_DIR, f));
        } catch (e) {
            console.error(`[profileStore] Failed to delete "${f}" while resetting profile "${profileId}": ${e.message}`);
        }
    }
}

function basePath(profileId) {
    const safeId = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(PROFILES_DIR, `${safeId}-base.json`);
}

// A free-text description of this profile's taste ("loves gritty sci-fi and
// slow-burn horror, not into rom-coms"), set from the admin UI. Exists
// alongside real watch history, not instead of it - lib/gemini.js's prompt
// includes both when both are present, and this alone is what lets a
// profile with zero watch history so far still get a seeded "For You"
// catalog (see addon-server.js's buildCatalog) instead of coming back empty.
function getBaseProfile(profileId) {
    try {
        const data = JSON.parse(fs.readFileSync(basePath(profileId), 'utf8'));
        return (data && data.text) || '';
    } catch (e) {
        return '';
    }
}

// Empty/whitespace-only text deletes the file rather than storing an empty
// one, so listProfiles()/getBaseProfile() and a plain "does this exist"
// check on disk agree with each other.
function setBaseProfile(profileId, text) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
        try { fs.unlinkSync(basePath(profileId)); } catch (e) { /* already absent */ }
        return;
    }
    ensureDir();
    try {
        fs.writeFileSync(basePath(profileId), JSON.stringify({ text: trimmed }, null, 2));
    } catch (e) {
        console.error(`[profileStore] Failed to save base profile for "${profileId}": ${e.message}`);
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
    setCache,
    listProfiles,
    resetProfile,
    getBaseProfile,
    setBaseProfile
};
