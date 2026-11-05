// Maps a TMDB title (and season/episode) to its anime ids, for the providers
// that look episodes up by AniList or MyAnimeList id.
//
// The public ARM id-mapping API (arm.haglund.dev) also says which TMDB season
// each anime entry belongs to. Two cases need care:
//   - a TMDB season split over several entries (Attack on Titan S3 part 1 and
//     2): entries are ordered by start date and the episode number is offset by
//     the earlier parts' episode counts (from AniList itself);
//   - a long-running show kept as one entry with absolute numbering (One Piece,
//     no season in ARM): the episode becomes TMDB's absolute number, counted
//     from the earlier seasons' episode counts.

const ARM_BASE = 'https://arm.haglund.dev/api/v2';
const ANILIST_GRAPHQL = 'https://graphql.anilist.co';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15000;

function fetchJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).then(res => {
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`);
        return res.json();
    }, err => {
        clearTimeout(timer);
        throw err;
    });
}

function aniListEpisodeInfo(ids) {
    const query = 'query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id episodes startDate{year month day}}}}';
    return fetchJson(ANILIST_GRAPHQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables: { ids } })
    }).then(json => ((json && json.data && json.data.Page && json.data.Page.media) || []))
        .catch(() => []);
}

function dateKey(d) {
    if (!d || !d.year) return Infinity;
    return d.year * 10000 + (d.month || 1) * 100 + (d.day || 1);
}

function toTarget(entry, episode) {
    return { anilistId: entry.anilist, malId: entry.myanimelist || null, episode };
}

// tmdbSeasons: TMDB's `seasons` array for the show (only used for absolute
// numbering). Resolves to { anilistId, malId, episode, wholeSeason? }, or null
// when the title isn't an anime ARM knows.
function resolveAnime(tmdbId, mediaType, season, episode, tmdbSeasons) {
    return fetchJson(`${ARM_BASE}/themoviedb?id=${tmdbId}`, { headers: { 'User-Agent': USER_AGENT } }).then(entries => {
        const list = (Array.isArray(entries) ? entries : []).filter(e => e && e.anilist);
        if (mediaType !== 'tv') {
            const movie = list.find(e => e.media === 'MOVIE');
            return movie ? toTarget(movie, 1) : null;
        }
        const seasonNum = Number(season);
        const parts = list.filter(e => e.media !== 'MOVIE' && e['themoviedb-season'] === seasonNum);
        if (parts.length) {
            return aniListEpisodeInfo(parts.map(p => p.anilist)).then(media => {
                const byId = new Map(media.map(m => [m.id, m]));
                const ordered = parts.slice().sort((a, b) =>
                    dateKey((byId.get(a.anilist) || {}).startDate) - dateKey((byId.get(b.anilist) || {}).startDate));
                let ep = Number(episode);
                for (let i = 0; i < ordered.length; i++) {
                    const count = (byId.get(ordered[i].anilist) || {}).episodes;
                    if (!count || ep <= count || i === ordered.length - 1) {
                        // Some players keep a split season under its first part,
                        // numbered straight through: offered as a second option.
                        const whole = i > 0 ? { malId: ordered[0].myanimelist || null, episode: Number(episode) } : null;
                        return Object.assign(toTarget(ordered[i], ep), { wholeSeason: whole });
                    }
                    ep -= count;
                }
                return null;
            });
        }
        const whole = list.find(e => e.media === 'TV' && (e['themoviedb-season'] === null || e['themoviedb-season'] === undefined));
        if (!whole) return null;
        const before = (tmdbSeasons || [])
            .filter(s => s.season_number > 0 && s.season_number < seasonNum)
            .reduce((sum, s) => sum + (s.episode_count || 0), 0);
        return toTarget(whole, before + Number(episode));
    });
}

module.exports = { resolveAnime };
