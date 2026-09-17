// Indexers do loose full-text search, so a query for "Inception" also
// matches things like "01 - Lean Inception.mp4" (an audiobook/talk, not the
// movie). Scene/P2P release names put the actual title first, so requiring
// the filename to *start with* the requested title's words - after
// normalizing both to bare lowercase word sequences - is a cheap, reliable
// filter against that kind of unrelated match. Year (movies) or a SxxEyy
// pattern (series) is checked too, since both are almost always present in
// real releases and further rule out wrong entries (remakes, wrong show).

const STOPWORDS = new Set(['the', 'a', 'an']);

function normalizeWords(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function titleWords(title) {
  const words = normalizeWords(title);
  while (words.length > 1 && STOPWORDS.has(words[0])) words.shift();
  return words;
}

function matchesTitle(filename, { title, year, season, episode }) {
  const tWords = titleWords(title);
  if (!tWords.length) return true;

  const fWords = normalizeWords(filename);
  for (let i = 0; i < tWords.length; i++) {
    if (fWords[i] !== tWords[i]) return false;
  }

  if (season && episode) {
    const se = new RegExp(`s0*${season}e0*${episode}\\b|\\b${season}x0*${String(episode).padStart(2, '0')}\\b`, 'i');
    if (!se.test(filename)) return false;
  } else if (year) {
    if (!fWords.includes(String(year))) return false;
  }

  return true;
}

module.exports = { matchesTitle };
