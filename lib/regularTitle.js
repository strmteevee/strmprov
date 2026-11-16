// A service's own title (Pluto TV and Plex list theirs by name, under ids of
// their own) as the title everything else knows it by: its IMDb id. A catalog
// can then hand it out as an ordinary title, which gives it what ordinary
// titles have - a rating, "more like this", every provider's streams, the
// service's own among them.
//
// The title is looked up at TMDB by name and kind, and by year where the
// service says one. Only a sure match counts: the same name (lib/titleMatch.js),
// no other year, and when several titles share the name, one that stands out -
// an animated one for a title the service files under anime or animation ("One
// Piece": the 1999 series, not the 2023 live-action one), else one with at
// least CLEAR_LEAD times the votes of the next. A series that still shares its
// name with others ("Ghosts": the British one and the American one, and Pluto
// gives no year) is the one whose episodes have the titles the service's
// have. Anything else stays the service's own title.
//
// Names are compared without what a service adds in brackets ("Survivor
// (Latest Episodes)") and without a leading article ("Black Hamptons" is "The
// Black Hamptons").

const tmdb = require('./tmdb');
const { normalize, yearInName } = require('./titleMatch');

const CLEAR_LEAD = 3;
const MIN_VOTES_TO_LEAD = 50;
const ANIMATION_GENRE = 16; // TMDB's id for Animation, movies and series alike
const MAX_KEPT = 5000;
const LOOKUPS_AT_ONCE = 8;

// How many of the service's titled episodes of a season have to be found in a candidate's season.
const EPISODES_SHARE = 0.4;
const EPISODES_MIN = 2;
const CANDIDATES_CHECKED = 4;

// A name without the remark a service put behind it in brackets; a year or a
// country code there ("(2018)", "(CA)") says which title it is and stays.
function plainName(name) {
    return String(name || '').replace(/\s*\((?!\s*(?:19|20)\d{2}\s*\))[^()]{4,}\)\s*$/, '').trim();
}

// A name as two titles are compared here.
function nameKey(name) {
    return normalize(plainName(name)).replace(/^(the|a|an) (?=\S)/, '');
}

function saysAnimation(genres) {
    return (genres || []).some(g => /\banime\b|\banimat|\bcartoons?\b/i.test(String(g)));
}

// The TMDB search results that could be the wanted title ({ name, year?, genres? }): the same
// name, no other year, the animated ones for a title filed under animation. Most votes first.
function candidates(results, wanted) {
    const name = nameKey(wanted.name);
    if (!name) return [];
    const year = Number(wanted.year) || yearInName(wanted.name);
    const yearOf = (r) => Number(String(r.release_date || r.first_air_date || '').slice(0, 4)) || null;
    let same = (results || []).filter(r => [r.title, r.name, r.original_title, r.original_name].some(n => n && nameKey(n) === name));
    if (year) same = same.filter(r => { const y = yearOf(r); return !y || Math.abs(y - year) <= 1; });
    if (same.length > 1 && saysAnimation(wanted.genres)) {
        const animated = same.filter(r => (r.genre_ids || []).includes(ANIMATION_GENRE));
        if (animated.length) same = animated;
    }
    return same.slice().sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
}

// The TMDB search result that surely is the wanted title, or null.
function choose(results, wanted) {
    const same = candidates(results, wanted);
    if (same.length <= 1) return same[0] || null;
    const [first, second] = same;
    return (first.vote_count || 0) >= MIN_VOTES_TO_LEAD && (first.vote_count || 0) >= CLEAR_LEAD * (second.vote_count || 0) ? first : null;
}

// An episode title as it is compared; none for one that only says its number ("Episode 5").
function episodeKey(title) {
    const key = normalize(title);
    return /^(episode|aflevering|ep|part|chapter)? ?\d+$/.test(key) ? '' : key;
}

// Whether a candidate's season ([{ name }], TMDB's episodes) is the service's ([{ title }]):
// enough of the service's episode titles are in it.
function sameSeason(serviceEpisodes, tmdbEpisodes) {
    const theirs = new Set((tmdbEpisodes || []).map(e => episodeKey(e.name)).filter(Boolean));
    const ours = Array.from(new Set(serviceEpisodes.map(e => episodeKey(e.title)).filter(Boolean)));
    if (!ours.length || !theirs.size) return false;
    const shared = ours.filter(t => theirs.has(t)).length;
    return shared >= Math.max(EPISODES_MIN, Math.ceil(EPISODES_SHARE * Math.min(ours.length, theirs.size)));
}

// The one of [same] (TMDB series with the same name) whose episodes are the
// service's ([{ season, title }]), or null: judged on the service's first
// season that has titled episodes. Only when exactly one of them fits.
function chooseByEpisodes(same, episodes) {
    const titled = (episodes || []).filter(e => e && e.season > 0 && episodeKey(e.title));
    if (!titled.length) return Promise.resolve(null);
    const season = Math.min(...titled.map(e => Number(e.season)));
    const ours = titled.filter(e => Number(e.season) === season);
    return Promise.all(same.slice(0, CANDIDATES_CHECKED).map(r => tmdb.getSeasonEpisodes(r.id, season)
        .then(s => (sameSeason(ours, s && s.episodes) ? r : null)).catch(() => null)))
        .then(found => { const fits = found.filter(Boolean); return fits.length === 1 ? fits[0] : null; });
}

const kept = new Map(); // "type|name|year" -> Promise of { imdbId, tmdbId, rating, year } | null
// The service ids a title was listed under, by "tv|<tmdb id>": a provider asked for that title finds it there at once.
const listedAs = new Map();

// wanted: { name, year?, type: 'movie' | 'series', genres? } -> { imdbId, tmdbId, rating, year } or null.
// [episodesOf]: () -> Promise of the service's episodes of the series ([{ season, title }]),
// asked only when its name alone doesn't say which series it is.
function resolve(wanted, episodesOf) {
    const mediaType = wanted.type === 'series' ? 'tv' : 'movie';
    const year = Number(wanted.year) || yearInName(wanted.name) || '';
    const key = `${mediaType}|${normalize(wanted.name)}|${year}|${saysAnimation(wanted.genres) ? 'a' : ''}`;
    if (kept.has(key)) return kept.get(key);
    const found = tmdb.searchTitles(mediaType, plainName(wanted.name).replace(/\(\s*(19|20)\d{2}\s*\)\s*$/, '').trim())
        .then(results => {
            const sure = choose(results, wanted);
            if (sure || mediaType !== 'tv' || !episodesOf) return sure;
            const same = candidates(results, wanted);
            return same.length > 1 ? episodesOf().then(episodes => chooseByEpisodes(same, episodes)).catch(() => null) : null;
        })
        .then(hit => {
            if (!hit) return null;
            return tmdb.getImdbId(hit.id, mediaType).then(imdbId => (imdbId ? {
                imdbId,
                tmdbId: hit.id,
                rating: hit.vote_average ? Number(hit.vote_average).toFixed(1) : undefined,
                year: String(hit.release_date || hit.first_air_date || '').slice(0, 4) || undefined
            } : null));
        })
        .catch(() => { kept.delete(key); return null; });
    kept.set(key, found);
    while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
    return found;
}

// [metas] of a service (Stremio metas with ids of its own) with every title
// that surely is an ordinary one handed out as that: its IMDb id, TMDB's
// rating and year. The others stay as they are. Each title once.
// [episodesOf]: (meta) -> Promise of that series' episodes at the service
// ([{ season, title }]), to tell series with the same name apart.
function asRegularTitles(metas, episodesOf) {
    const out = new Array(metas.length);
    const next = (i) => {
        if (i >= metas.length) return Promise.resolve();
        return Promise.all(metas.slice(i, i + LOOKUPS_AT_ONCE).map((m, n) => resolve({ name: m.name, year: m.releaseInfo, type: m.type, genres: m.genres }, episodesOf && (() => episodesOf(m)))
            .then(hit => {
                if (!hit) { out[i + n] = m; return; }
                const mediaType = m.type === 'series' ? 'tv' : 'movie';
                const listKey = `${mediaType}|${hit.tmdbId}`;
                const ids = listedAs.get(listKey) || [];
                if (!ids.includes(m.id)) listedAs.set(listKey, ids.concat(m.id));
                while (listedAs.size > MAX_KEPT) listedAs.delete(listedAs.keys().next().value);
                out[i + n] = Object.assign({}, m, { id: hit.imdbId, imdbRating: hit.rating || m.imdbRating, releaseInfo: m.releaseInfo || hit.year });
            }))).then(() => next(i + LOOKUPS_AT_ONCE));
    };
    return next(0).then(() => {
        const seen = new Set();
        return out.filter(m => m && !seen.has(m.id) && seen.add(m.id));
    });
}

// The ids (starting with [prefix]) a service listed the title under, most recent last; [] when it wasn't.
function listedIds(tmdbId, mediaType, prefix) {
    return (listedAs.get(`${mediaType === 'tv' ? 'tv' : 'movie'}|${tmdbId}`) || []).filter(id => id.startsWith(prefix));
}

module.exports = { choose, sameSeason, resolve, asRegularTitles, listedIds };
