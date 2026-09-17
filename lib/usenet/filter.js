// Decides whether an indexer result is a single, directly playable video
// file (what the user asked for) versus a compressed/split archive (rar,
// r00-r999, zip, 7z, numbered .001 volumes) or a non-video post (nfo, sfv,
// par2 repair blocks, sample clips, audio-only, etc).
//
// Usenet subjects almost always embed the real posted filename in quotes,
// e.g. `[1/8] - "Movie.2024.1080p.mkv" yEnc`. We read the extension off that
// filename rather than trying to inspect the binary itself - nothing here
// downloads anything, it only classifies what the indexer already listed.

const VIDEO_EXTS = ['mkv', 'mp4', 'avi', 'm4v', 'mov', 'webm', 'ts', 'm2ts', 'wmv', 'flv'];

// Any of these appearing anywhere in the subject is treated as disqualifying,
// even if a video extension also shows up elsewhere in the same line - e.g.
// NZBKing sometimes lists "filetypes: .MKV .NFO" for a post whose actual
// posted file is a rar part, because the group's other files reference the
// original name. Better to under-include than surface an archive as playable.
const COMPRESSED_MARKERS = /\.(rar|r\d{2,3}|zip|7z|exe|iso)\b|\.\d{3}\b|part\d+\.rar|NO PASSWORD/i;

function lastQuotedFilename(subject) {
  const matches = [...subject.matchAll(/"([^"]*)"/g)].map(m => m[1]).filter(Boolean);
  return matches.length ? matches[matches.length - 1] : null;
}

function extensionOf(filename) {
  const m = /\.([a-z0-9]{2,4})$/i.exec(filename);
  return m ? m[1].toLowerCase() : null;
}

// filetypes: an optional array of extensions the indexer itself reports for
// the whole grouped post (NZBKing exposes this; Binsearch doesn't). Used as
// an extra guard, not the primary signal.
function classify(subjectRaw, filetypes) {
  const subject = (subjectRaw || '').trim();
  if (!subject) return null;
  if (COMPRESSED_MARKERS.test(subject)) return null;
  if (Array.isArray(filetypes) && filetypes.some(ft => /^\.?(rar|r\d{2,3}|zip|7z|exe|iso|\d{3})$/i.test(ft))) {
    return null;
  }

  let filename = lastQuotedFilename(subject);
  let ext = filename ? extensionOf(filename) : null;

  if (!ext) {
    // Some posts (single-part "complete" uploads) put the filename outside
    // quotes entirely, e.g. `Movie.2024.mkv - "" yEnc`. Fall back to pulling
    // the whitespace-free token that ends in a video extension, rather than
    // the whole subject line.
    const m = new RegExp(`([^\\s"]+\\.(${VIDEO_EXTS.join('|')}))\\b`, 'i').exec(subject);
    if (m) {
      filename = filename || m[1];
      ext = m[2].toLowerCase();
    }
  }

  if (!ext || !VIDEO_EXTS.includes(ext)) return null;

  return { filename: filename || subject, ext };
}

function sizeToBytes(sizeStr) {
  const m = /([\d.]+)\s*([KMGT]?B)/i.exec(sizeStr || '');
  if (!m) return 0;
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return parseFloat(m[1]) * (units[m[2].toUpperCase()] || 1);
}

module.exports = { classify, sizeToBytes, VIDEO_EXTS };
