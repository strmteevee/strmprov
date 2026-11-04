// Keeps a stream only when its audio is the title's original language or
// English. By request: dubs in any other language (a Tamil Inception, a Hindi
// Parasite) only clutter the list.
//
// Providers have no shared language field, so the language is read from the
// stream's own text. Forms seen live (2026-11-04):
//   - an explicit audio list: "🎧 Audio: English, Hindi", "🔊 por/en/spa/fre"
//   - a tag: "Castle [Tamil]", "AllMovieLand [Hindi]", "Parasite Dolls (ITA)"
//   - a release name: "[Hindi DDP 5.1 + English DTS]", "Hindi.5.1-Korean.5.1"
// An explicit list wins over anything else in the text. Subtitles are not
// audio ("📝 Subtitles: Spanish", "English subs", "ESub"), and words from the
// title itself don't count (The French Dispatch isn't in French).
//
// A stream without any language information stays: most of them are the
// original version, and dropping those would empty the list for many titles.

const LANGUAGES = [
    // code, full names (any case), codes (accepted in an explicit list)
    ['en', ['english'], ['en', 'eng']],
    ['hi', ['hindi'], ['hi', 'hin']],
    ['ta', ['tamil'], ['ta', 'tam']],
    ['te', ['telugu'], ['te', 'tel']],
    ['ml', ['malayalam'], ['ml', 'mal']],
    ['kn', ['kannada'], ['kn', 'kan']],
    ['bn', ['bengali', 'bangla'], ['bn', 'ben']],
    ['mr', ['marathi'], ['mr', 'mar']],
    ['pa', ['punjabi'], ['pa', 'pan']],
    ['gu', ['gujarati'], ['gu', 'guj']],
    ['ur', ['urdu'], ['ur', 'urd']],
    ['ar', ['arabic'], ['ar', 'ara']],
    ['es', ['spanish', 'espanol', 'español', 'latino', 'castellano'], ['es', 'spa', 'lat']],
    ['fr', ['french', 'francais', 'français', 'truefrench'], ['fr', 'fre', 'fra']],
    ['de', ['german', 'deutsch'], ['de', 'ger', 'deu']],
    ['it', ['italian', 'italiano'], ['it', 'ita']],
    ['pt', ['portuguese', 'portugues', 'português', 'dublado'], ['pt', 'por']],
    ['ru', ['russian'], ['ru', 'rus']],
    ['uk', ['ukrainian'], ['uk', 'ukr']],
    ['pl', ['polish', 'polski'], ['pl', 'pol']],
    ['nl', ['dutch', 'nederlands'], ['nl', 'nld', 'dut']],
    ['tr', ['turkish'], ['tr', 'tur']],
    ['ko', ['korean'], ['ko', 'kor']],
    ['ja', ['japanese'], ['ja', 'jpn', 'jap']],
    ['zh', ['chinese', 'mandarin', 'cantonese'], ['zh', 'chi', 'zho', 'cn', 'cmn', 'yue']],
    ['th', ['thai'], ['th', 'tha']],
    ['vi', ['vietnamese'], ['vi', 'vie']],
    ['id', ['indonesian'], ['id', 'ind']],
    ['ms', ['malay'], ['ms', 'may', 'msa']],
    ['tl', ['filipino', 'tagalog'], ['tl', 'fil', 'tgl']],
    ['fa', ['persian', 'farsi'], ['fa', 'per', 'fas']],
    ['he', ['hebrew'], ['he', 'heb']],
    ['sv', ['swedish'], ['sv', 'swe']],
    ['no', ['norwegian'], ['no', 'nor']],
    ['da', ['danish'], ['da', 'dan']],
    ['fi', ['finnish'], ['fi', 'fin']],
    ['el', ['greek'], ['el', 'gre', 'ell']],
    ['cs', ['czech'], ['cs', 'cze', 'ces']],
    ['ro', ['romanian'], ['ro', 'rum', 'ron']],
    ['hu', ['hungarian'], ['hu', 'hun']]
];

// In running text a three-letter code only counts in capitals, and only these:
// the others collide with ordinary words and release-group names too easily.
const RUNNING_TEXT_CODES = new Set(['ENG', 'HIN', 'TAM', 'TEL', 'KAN', 'ITA', 'SPA', 'FRE', 'FRA', 'GER', 'DEU', 'RUS', 'KOR', 'JPN', 'JAP', 'ARA', 'POR', 'CHI']);

const TOKEN_TO_CODE = new Map();
const NAME_TO_CODE = new Map();
for (const [code, names, codes] of LANGUAGES) {
    for (const name of names) {
        NAME_TO_CODE.set(name, code);
        TOKEN_TO_CODE.set(name, code);
    }
    for (const c of codes) TOKEN_TO_CODE.set(c, code);
}
const NAMES_REGEX = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...NAME_TO_CODE.keys()].join('|')})(?![\\p{L}\\p{N}])`, 'giu');
const CODES_REGEX = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...RUNNING_TEXT_CODES].join('|')})(?![\\p{L}\\p{N}])`, 'gu');

// "🎧 Audio: English, Hindi" / "🔊 por/en/spa" - up to the next emoji or separator.
const EXPLICIT_AUDIO_REGEX = /(?:\baudio\s*:|🔊)\s*([^\n|•\p{Extended_Pictographic}]+)/iu;

function explicitLanguages(text) {
    const m = text.match(EXPLICIT_AUDIO_REGEX);
    if (!m) return [];
    const found = m[1].split(/[,/+&\s]+/)
        .map(token => TOKEN_TO_CODE.get(token.toLowerCase()))
        .filter(Boolean);
    return [...new Set(found)];
}

function removeSubtitleMentions(text) {
    return text
        // "📝 Subtitles: English, Spanish" / "🙊 No included subtitles" - up to the next emoji.
        .replace(/[📝💬🙊][^\p{Extended_Pictographic}]*/gu, ' ')
        .replace(/\bsub(?:title)?s?\s*:\s*[^\n|•]*/gi, ' ')
        // "English subs", "SUB ITA" - but not MovieBox's "Hindi sub audio",
        // which is its name for a substitute audio track.
        .replace(/[\p{L}]+[\s.-]+(?:subs?|subbed|subtitles?)\b(?!\s*audio)/giu, ' ')
        .replace(/\b(?:subs?|subtitles?)[\s.-]+[\p{L}]+/giu, match => (/\baudio$/i.test(match) ? match : ' '));
}

function removeTitles(text, titles) {
    let out = text;
    for (const title of titles) {
        const words = String(title || '').replace(/[._]/g, ' ').trim().split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        const pattern = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s:,\'-]*\\s*');
        out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
    }
    return out;
}

// Returns the language codes the stream's audio is known to have ([] = unknown).
function detectAudioLanguages(stream, titles) {
    const hints = stream.behaviorHints || {};
    const text = [stream.name, stream.title, stream.description, stream.filename, hints.filename]
        .filter(value => typeof value === 'string')
        .join('\n')
        .replace(/_/g, ' ');

    const field = String(stream.language || stream.lang || '').toLowerCase();
    if (TOKEN_TO_CODE.has(field)) return [TOKEN_TO_CODE.get(field)];

    const explicit = explicitLanguages(text);
    if (explicit.length) return explicit;

    const scanned = removeTitles(removeSubtitleMentions(text).replace(/\./g, ' '), titles || []);
    const found = new Set();
    for (const m of scanned.matchAll(NAMES_REGEX)) found.add(NAME_TO_CODE.get(m[0].toLowerCase()));
    for (const m of scanned.matchAll(CODES_REGEX)) found.add(TOKEN_TO_CODE.get(m[0].toLowerCase()));
    return [...found];
}

// TMDB's code for Cantonese is "cn"; the table above files all Chinese under zh.
function normalizeOriginal(code) {
    const value = String(code || '').toLowerCase();
    return TOKEN_TO_CODE.get(value) || value;
}

function filterByLanguage(streams, info) {
    const original = normalizeOriginal(info.originalLanguage);
    return streams.filter(stream => {
        const languages = detectAudioLanguages(stream, info.titles);
        return languages.length === 0 || languages.includes('en') || languages.includes(original);
    });
}

module.exports = { detectAudioLanguages, filterByLanguage };
