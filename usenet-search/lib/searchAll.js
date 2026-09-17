const nzbking = require('./nzbking');
const binsearch = require('./binsearch');
const { classify, sizeToBytes } = require('./filter');
const { matchesTitle } = require('./titleMatch');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildQuery({ title, year, season, episode }) {
  let q = (title || '').trim();
  if (season && episode) {
    q += ` S${pad2(season)}E${pad2(episode)}`;
  } else if (year) {
    q += ` ${year}`;
  }
  return q.trim();
}

async function searchAll({ title, year, season, episode }) {
  const query = buildQuery({ title, year, season, episode });
  if (!query) throw new Error('title is required');

  const [nzbkingResult, binsearchResult] = await Promise.allSettled([
    nzbking.search(query),
    binsearch.search(query, { max: 100 })
  ]);

  const errors = [];
  const raw = [];

  if (nzbkingResult.status === 'fulfilled') raw.push(...nzbkingResult.value);
  else errors.push({ source: 'nzbking', message: nzbkingResult.reason.message });

  if (binsearchResult.status === 'fulfilled') raw.push(...binsearchResult.value);
  else errors.push({ source: 'binsearch', message: binsearchResult.reason.message });

  const seen = new Set();
  const results = [];

  for (const item of raw) {
    const playable = classify(item.subject, item.filetypes);
    if (!playable) continue;
    if (!matchesTitle(playable.filename, { title, year, season, episode })) continue;

    const bytes = sizeToBytes(item.size);
    const dedupeKey = `${playable.filename.toLowerCase()}::${bytes}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    results.push({
      filename: playable.filename,
      ext: playable.ext,
      size: item.size,
      sizeBytes: bytes,
      poster: item.poster,
      groups: item.groups,
      age: item.age,
      source: item.source,
      nzbUrl: item.nzbUrl,
      detailsUrl: item.detailsUrl
    });
  }

  results.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return { query, results, errors };
}

module.exports = { searchAll, buildQuery };
