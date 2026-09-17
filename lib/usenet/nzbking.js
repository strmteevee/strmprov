// Scrapes https://nzbking.com search results. No account/API - plain
// server-rendered HTML, confirmed by fetching the search page directly
// (curl, no JS execution) and inspecting the markup: each result is a
// `.search-result` block containing the subject line, a direct
// `/nzb:<id>/` download link, and `parts:`/`size:`/`filetypes:` metadata as
// plain text alongside it.

const cheerio = require('cheerio');

const BASE = 'https://nzbking.com';

async function search(query) {
  const url = `${BASE}/search/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`nzbking HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const results = [];
  $('.search-result').each((_, el) => {
    const $el = $(el);
    const $subject = $el.find('.search-subject').first();
    if (!$subject.length) return;

    const nzbHref = $subject.find('a[href^="/nzb:"]').attr('href');
    if (!nzbHref) return; // no direct nzb link - skip rather than guess one

    // Strip the two <a class="button"> links and the trailing empty div so
    // only the subject + "parts:/size:/filetypes:" text nodes remain, then
    // collapse to one line for easy regex extraction.
    const $clean = $subject.clone();
    $clean.find('a, div[id]').remove();
    const flat = $clean.text().replace(/\s+/g, ' ').trim();

    const subject = flat.split(/\s+parts:\s+/i)[0].trim();
    const sizeMatch = /size:\s*([\d.]+\s*[KMGT]?B)/i.exec(flat);
    const filetypesMatch = /filetypes:\s*([.\w\s]+?)\s*$/i.exec(flat);
    const filetypes = filetypesMatch
      ? filetypesMatch[1].trim().split(/\s+/).filter(Boolean)
      : [];

    results.push({
      source: 'nzbking',
      subject,
      filetypes,
      size: sizeMatch ? sizeMatch[1] : null,
      nzbUrl: BASE + nzbHref,
      detailsUrl: BASE + (($subject.find('a[href^="/details:"]').attr('href')) || ''),
      poster: $el.find('.search-poster a').first().text().trim(),
      groups: $el.find('.search-groups').text().replace(/\s+/g, ' ').trim(),
      age: $el.find('.search-age').text().trim()
    });
  });

  return results;
}

module.exports = { search };
