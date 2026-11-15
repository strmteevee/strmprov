// Finding a title, and an episode of it, at a service that doesn't go by the
// ids the rest of this addon uses (Pluto TV knows names only).
//
// A title is the same when its name is, and - where both sides say one - its
// year. An episode can't go by its numbers alone: services cut a long series
// into seasons their own way (TMDB has "One Piece" in 22 seasons, Pluto in 13
// that start counting again nine times). So an episode found at the asked
// season and number only counts when its title is the asked one's; otherwise
// the episode with that title is looked for in the whole series; and only
// when the asked episode has no title of its own ("Episode 5") do the numbers
// decide.

// A name as it is compared: lower case, accents and punctuation gone, "&" as
// "and", without a year in brackets at the end ("A Star Is Born (2018)").
function normalize(name) {
    return String(name || '')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\(\s*(19|20)\d{2}\s*\)\s*$/, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// The year a name ends with in brackets, or null.
function yearInName(name) {
    const m = /\(\s*((?:19|20)\d{2})\s*\)\s*$/.exec(String(name || ''));
    return m ? Number(m[1]) : null;
}

// The candidates ({ name, year? }) that are the wanted title ({ titles: [names
// it goes by], year? }): same name, and no other year than the wanted one (a
// year off by one still counts: release dates differ by country). Those that
// say the right year first, then in the order given.
function matchingTitles(candidates, wanted) {
    const names = new Set((wanted.titles || []).map(normalize).filter(Boolean));
    const year = Number(wanted.year) || null;
    const yearOf = (c) => Number(c.year) || yearInName(c.name);
    const fits = candidates.filter(c => names.has(normalize(c.name)))
        .filter(c => { const y = yearOf(c); return !year || !y || Math.abs(y - year) <= 1; });
    return fits.filter(c => yearOf(c)).concat(fits.filter(c => !yearOf(c)));
}

// The first of them, or null.
function pickTitle(candidates, wanted) {
    return matchingTitles(candidates, wanted)[0] || null;
}

// An episode title that says nothing ("Episode 5", "Aflevering 5", "5", none).
function isPlaceholderTitle(title) {
    const t = normalize(title);
    return !t || /^(episode|aflevering|ep|folge|episodio|chapter|part)?\s*\d+$/.test(t);
}

function sameEpisodeTitle(a, b) {
    const x = normalize(a);
    const y = normalize(b);
    if (!x || !y) return false;
    if (x === y) return true;
    // One side cut short, or with a subtitle added: the shorter one is how the longer one starts.
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 12 && long.startsWith(short);
}

// The one video with this title, or null (none, or several: a two-parter, a recap).
function onlyWithTitle(videos, title) {
    const found = videos.filter(v => sameEpisodeTitle(v.title, title));
    return found.length === 1 ? found[0] : null;
}

// The video ({ season, episode, title }, in the service's own order) that is
// the wanted episode ({ season, episode, title }) - see the top. null when it
// can't be told.
//
// [siblings]: the other episodes of the wanted one's season as the asker has
// them ([{ episode, title }]). A title translated differently on both sides
// isn't found by itself ("...Will Become the Pirate King!" / "...Gonna Be
// King of the Pirates!", 96 of 475 One Piece episodes), but its neighbours
// are: when the two nearest ones that are found agree on where the wanted one
// then sits between them, that's it.
function pickEpisode(videos, wanted, siblings) {
    const atNumbers = videos.find(v => Number(v.season) === Number(wanted.season) && Number(v.episode) === Number(wanted.episode));
    if (isPlaceholderTitle(wanted.title)) return atNumbers || null;
    if (atNumbers && (sameEpisodeTitle(atNumbers.title, wanted.title) || isPlaceholderTitle(atNumbers.title))) return atNumbers;
    const byTitle = videos.filter(v => sameEpisodeTitle(v.title, wanted.title));
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1 || !siblings) return null;

    const number = Number(wanted.episode);
    // Where the wanted episode would sit, going by each neighbour that is found.
    const guesses = siblings
        .filter(s => Number(s.episode) !== number && !isPlaceholderTitle(s.title))
        .sort((a, b) => Math.abs(Number(a.episode) - number) - Math.abs(Number(b.episode) - number))
        .slice(0, NEIGHBOURS_TRIED)
        .map(s => { const v = onlyWithTitle(videos, s.title); return v ? videos.indexOf(v) + (number - Number(s.episode)) : null; })
        .filter(i => i !== null)
        .slice(0, 2);
    if (guesses.length < 2 || guesses[0] !== guesses[1]) return null;
    return videos[guesses[0]] || null;
}

// How many of the nearest neighbours are looked for before giving up.
const NEIGHBOURS_TRIED = 8;

module.exports = { normalize, yearInName, matchingTitles, pickTitle, pickEpisode, sameEpisodeTitle, isPlaceholderTitle };
