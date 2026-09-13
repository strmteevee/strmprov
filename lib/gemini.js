// AI-powered recommendations for the "For You" catalog in addon-server.js.
//
// TMDB's own /recommendations and /similar only ever take one title at a
// time (confirmed directly - passing multiple ids doesn't change the
// result), so a catalog built from them is really N independent
// single-title lookups merged together, not a read of the profile's overall
// taste. This asks an LLM to reason across the WHOLE watch history in one
// prompt instead - it can notice something like "unreliable narrators and
// morally ambiguous protagonists" spanning several watched titles, which no
// per-title similarity endpoint can surface.
//
// The model is asked for title+year+mediaType, never a direct TMDB/IMDb id -
// an LLM can state a specific id with total confidence and still be wrong,
// but naming a real, specific title it's actually seen enough about to
// discuss is a much more reliable task. Every suggestion still gets resolved
// against a real TMDB search afterward (see resolveSuggestions below), and
// anything that doesn't resolve to a real match is dropped rather than
// guessed at.
//
// Requires GEMINI_API_KEY (see .env.example). Model list order matters here:
// gemini-2.5-flash is what this was actually verified against; the -latest
// alias is tried first since it should stay current as Google's lineup
// moves on, with the pinned version as a fallback for exactly the kind of
// "current model is temporarily overloaded" 503 seen while building this.
const MODEL_CANDIDATES = ['gemini-flash-latest', 'gemini-2.5-flash'];
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const RECOMMENDATION_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            title: { type: 'STRING' },
            year: { type: 'INTEGER' },
            mediaType: { type: 'STRING', enum: ['movie', 'series'] }
        },
        required: ['title', 'year', 'mediaType']
    }
};

function isConfigured() {
    return !!process.env.GEMINI_API_KEY;
}

// historyItems can be a different media type than what's being recommended
// (e.g. seeding a movie catalog from a profile that's only ever watched
// series) - TMDB's /recommendations and /similar can't do that (they only
// ever suggest more of the same type), which is exactly why this cross-type
// case is only handled here, not in the TMDB fallback path. The prompt
// names the watched titles' own kind explicitly so the model doesn't assume
// they're the same kind as what it's asked to recommend.
function buildPrompt(historyItems, mediaType) {
    const targetKind = mediaType === 'tv' ? 'TV series' : 'movies';
    const seedIsTv = historyItems.length > 0 && historyItems[0].mediaType === 'tv';
    const seedKind = seedIsTv ? 'TV series' : 'movies';
    const list = historyItems
        .map(h => `- ${h.title || 'Unknown'}${h.year ? ` (${h.year})` : ''}`)
        .join('\n');
    return `A viewer has watched the following ${seedKind}, most recent first:\n${list}\n\n` +
        `Considering the overall pattern across ALL of these together (recurring themes, tone, ` +
        `storytelling style) rather than treating each one independently, recommend 40 ${targetKind} ` +
        `this viewer would likely enjoy next. Do not recommend anything already in the list above. ` +
        `Respond with real, existing titles only.`;
}

function callModel(model, prompt) {
    const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RECOMMENDATION_SCHEMA
        }
    };
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(res => {
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
        return res.json();
    }).then(data => {
        const text = data.candidates && data.candidates[0] && data.candidates[0].content.parts[0].text;
        if (!text) throw new Error('Empty Gemini response');
        return JSON.parse(text);
    });
}

// Tries each candidate model in turn (Gemini's hosted models occasionally
// return a transient 503 "high demand" error - seen directly while building
// this - so a single-model attempt isn't reliable enough on its own).
function callGeminiWithFallback(prompt) {
    let chain = Promise.reject(new Error('no models tried'));
    for (const model of MODEL_CANDIDATES) {
        chain = chain.catch(() => callModel(model, prompt).catch(err => {
            console.log(`[gemini] ${model} failed: ${err.message}`);
            throw err;
        }));
    }
    return chain;
}

// Resolves each {title, year, mediaType} suggestion against a real TMDB
// search, in parallel, dropping anything that doesn't resolve to a real
// title (hallucinated or mistyped) or is already in the exclude set.
function resolveSuggestions(suggestions, tmdb, excludeIds) {
    return Promise.all(suggestions.map(s =>
        tmdb.searchTitle(s.title, s.year, s.mediaType).then(result => {
            if (!result) return null;
            if (excludeIds.has(String(result.id))) return null;
            return { item: result, mediaType: s.mediaType === 'series' ? 'tv' : 'movie' };
        }).catch(() => null)
    )).then(resolved => resolved.filter(Boolean));
}

// historyItems: [{ tmdbId, title, year }], most recent first, already
// filtered to one mediaType by the caller. Returns [{ item, mediaType }] in
// the same shape lib/tmdb.js's getRecommendations/getSimilar items use, so
// addon-server.js can feed either source through the same meta-building step.
function getAiRecommendations(historyItems, mediaType, tmdb, excludeIds) {
    if (!isConfigured()) return Promise.resolve(null);
    if (historyItems.length === 0) return Promise.resolve(null);

    const prompt = buildPrompt(historyItems, mediaType);
    return callGeminiWithFallback(prompt)
        .then(suggestions => {
            if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
            return resolveSuggestions(suggestions, tmdb, excludeIds);
        })
        .catch(err => {
            console.log(`[gemini] All models failed, falling back to TMDB similarity: ${err.message}`);
            return null;
        });
}

module.exports = {
    isConfigured,
    getAiRecommendations
};
