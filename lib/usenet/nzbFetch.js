// Fetches an NZB (the file the indexer links to) and parses it into a flat
// list of segments to download. An NZB can bundle more than one <file>
// (e.g. a tiny .nfo alongside the video); we already filtered at search
// time for single-video-file posts, so picking the <file> with the most
// total bytes reliably picks the actual video rather than a sidecar.

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'file' || name === 'segment' || name === 'group'
});

async function fetchNzb(nzbUrl) {
  const res = await fetch(nzbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`NZB fetch HTTP ${res.status}`);
  const xml = await res.text();
  return parseNzb(xml);
}

function parseNzb(xml) {
  const doc = parser.parse(xml);
  const files = doc && doc.nzb && doc.nzb.file;
  if (!Array.isArray(files) || !files.length) {
    throw new Error('NZB has no <file> entries');
  }

  const candidates = files.map((f) => {
    const segRaw = (f.segments && f.segments.segment) || [];
    const segments = segRaw
      .map((s) => ({
        number: parseInt(s['@_number'], 10),
        bytes: parseInt(s['@_bytes'], 10) || 0,
        messageId: String(s['#text'] || s).trim()
      }))
      .sort((a, b) => a.number - b.number);
    const totalBytes = segments.reduce((sum, s) => sum + s.bytes, 0);
    return { subject: f['@_subject'] || '', segments, totalBytes };
  });

  candidates.sort((a, b) => b.totalBytes - a.totalBytes);
  const best = candidates[0];
  if (!best || !best.segments.length) {
    throw new Error('NZB has no usable segments');
  }

  return { subject: best.subject, totalBytes: best.totalBytes, segments: best.segments };
}

module.exports = { fetchNzb, parseNzb };
