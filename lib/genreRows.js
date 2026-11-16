// Genre catalogs for services that have no genres to ask for, only rows of
// their own with names ("Featured Action Movies", "Comedy Gold", "Classic TV
// Westerns"): a genre's catalog is filled from the rows whose name says that
// genre. The genres are the ones this addon's other catalogs use.
//
// A row's name also often says what is in it ("... Movies", "... TV Shows"):
// such a row only counts for that type; one that doesn't say counts for both.
// Rows in another language than the catalogs are meant for ("Anime en
// español") are left out, like dubbed streams are elsewhere.

const GENRES = [
    { slug: 'action-adventure', label: 'Action & Adventure', words: /\baction\b|\badventure/i },
    { slug: 'scifi-fantasy', label: 'Sci-Fi & Fantasy', words: /\bsci-?fi\b|science fiction|\bfantasy\b/i },
    { slug: 'animation-family', label: 'Animation & Family', words: /\banimat|\banime\b|\bcartoons?\b|\bfamily\b|\bkids?\b/i },
    { slug: 'comedy', label: 'Comedy', words: /\bcomed|\bsitcoms?\b/i },
    { slug: 'crime-mystery', label: 'Crime & Mystery', words: /\bcrime\b|\bmyster|\bdetectives?\b/i },
    { slug: 'drama', label: 'Drama', words: /\bdramas?\b/i },
    { slug: 'horror-thriller', label: 'Horror & Thriller', words: /\bhorror\b|\bthrillers?\b/i },
    { slug: 'history-war', label: 'History & War', words: /\bhistor|\bwar\b|\bmilitary\b/i },
    { slug: 'sport', label: 'Sport', words: /\bsports?\b|\bsporting\b/i },
    { slug: 'western', label: 'Western', words: /\bwesterns?\b/i },
    { slug: 'documentary', label: 'Documentary', words: /\bdocumentar|\bdocs?\b|\bdocuseries\b/i },
    { slug: 'reality', label: 'Reality', words: /\breality\b|\btalk shows?\b|\bgame shows?\b/i }
];

const SAYS_MOVIES = /\b(movies?|films?|cinema)\b/i;
const SAYS_SERIES = /\b(tv|series|shows?|sitcoms?|telenovelas?)\b/i;
// Spanish rows: named so ("Kids en español"), or in Spanish themselves ("Películas de drama").
// Checked against Pluto's and Plex's 512 row names on 2026-11-17: 28 rows, all Spanish.
const OTHER_LANGUAGE = /espa[ñn]ol|\blatino\b|\bpel[ií]culas?\b|\b(de|del|las|los|y)\b/i;

// 'movie' or 'series' when the row's name says so, null when it doesn't (or says both).
function rowType(name) {
    const movies = SAYS_MOVIES.test(name);
    const series = SAYS_SERIES.test(name);
    if (movies === series) return null;
    return movies ? 'movie' : 'series';
}

// (row name) -> whether the row belongs in the genre's catalog of [type] ('movie' | 'series'); null for an unknown genre.
function matcher(slug, type) {
    const genre = GENRES.find(g => g.slug === slug);
    if (!genre) return null;
    return (name) => {
        const text = String(name || '');
        if (!genre.words.test(text) || OTHER_LANGUAGE.test(text)) return false;
        const says = rowType(text);
        return says === null || says === type;
    };
}

// The genre catalogs a service can fill, going by its row names: [{ slug, label, type }].
// While the names aren't known yet (just started, a tunnel down) that is all of
// them: a catalog a client already shows as a row mustn't drop out of the
// manifest over that.
function available(rowNames) {
    const out = [];
    GENRES.forEach(g => ['movie', 'series'].forEach(type => {
        const match = matcher(g.slug, type);
        if (!rowNames.length || rowNames.some(match)) out.push({ slug: g.slug, label: g.label, type });
    }));
    return out;
}

module.exports = { GENRES, matcher, available, rowType };
