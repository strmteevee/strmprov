// Scrapes https://www.binsearch.info search results. No account/API.
//
// The homepage 307-redirects `/?q=...` to `/search?q=...`, and that page is
// still plain server-rendered HTML (confirmed via a direct fetch, no JS
// needed) despite being built with Next.js. Each row is a `<tr>` in
// `table.result-table` with a `<a href="/details/<id>">` holding the raw
// subject text. The per-result "Create NZB" form on the details page posts
// to `/nzb` via GET with `id` + `name` fields, so the download link can be
// built directly without simulating the form.

const cheerio = require('cheerio');

const BASE = 'https://www.binsearch.info';

async function search(query, { max = 100 } = {}) {
  const url = `${BASE}/search?q=${encodeURIComponent(query)}&max=${max}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`binsearch HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const results = [];
  $('table.result-table tr').each((_, el) => {
    const $row = $(el);
    const $link = $row.find('a[href^="/details/"]').first();
    if (!$link.length) return; // header row / non-result row

    const id = $link.attr('href').replace('/details/', '');
    const subject = $link.text().trim();

    const spans = $row.find('div.flex.flex-row.flex-wrap span');
    const size = spans.eq(0).text().trim() || null;
    const filesInfo = spans.eq(1).text().replace(/\s+/g, ' ').trim();

    const poster = $row.find('a[href^="/search?poster="]').first().text().trim();
    const groups = $row
      .find('a[href^="/search?group="]')
      .map((__, g) => $(g).text().trim())
      .get()
      .join(', ');
    const age = $row.find('td').last().text().trim();

    results.push({
      source: 'binsearch',
      subject,
      filetypes: [], // binsearch doesn't expose this separately - subject-only classification
      size,
      filesInfo,
      nzbUrl: `${BASE}/nzb?id=${encodeURIComponent(id)}&name=${encodeURIComponent(subject)}`,
      detailsUrl: `${BASE}/details/${id}`,
      poster,
      groups,
      age
    });
  });

  return results;
}

module.exports = { search };
