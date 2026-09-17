// Minimal yEnc decoder for a single NNTP article body. yEnc is the encoding
// Usenet binary posts use: each byte is (raw + 42) mod 256, with 0x3D ('=')
// as an escape char meaning "subtract another 64 from the next byte" (used
// to avoid NUL, LF, CR, and the '=' byte itself appearing in the stream).
// Multi-part posts (the common case for anything bigger than ~700KB) carry
// a `=ypart begin=X end=Y` header giving this article's byte offset into
// the full file; single-part posts have no =ypart line and start at 0.
//
// Reference: http://www.yenc.org/yenc-draft.1.3.txt

function decodeYencSegment(body) {
  const lines = body.split(/\r?\n/);
  let size = null;
  let beginOffset = 0;
  let name = null;
  let dataStart = -1;
  let dataEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('=ybegin')) {
      const sizeMatch = /size=(\d+)/.exec(line);
      const nameMatch = /name=(.+)$/.exec(line);
      if (sizeMatch) size = parseInt(sizeMatch[1], 10);
      if (nameMatch) name = nameMatch[1].trim();
      dataStart = i + 1;
    } else if (line.startsWith('=ypart')) {
      const beginMatch = /begin=(\d+)/.exec(line);
      if (beginMatch) beginOffset = parseInt(beginMatch[1], 10) - 1; // 1-indexed in the header
      dataStart = i + 1;
    } else if (line.startsWith('=yend')) {
      dataEnd = i;
      break;
    }
  }

  if (dataStart === -1) {
    throw new Error('yEnc: no =ybegin header found in article body');
  }

  const out = Buffer.alloc(size != null ? size : body.length);
  let outPos = 0;

  for (let i = dataStart; i < dataEnd; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      let code = line.charCodeAt(j);
      if (code === 0x3d) { // '=' escape
        j++;
        code = line.charCodeAt(j) - 64;
      }
      const byte = (code - 42) & 0xff;
      if (outPos < out.length) out[outPos] = byte;
      outPos++;
    }
  }

  return { beginOffset, length: outPos, name, data: out.subarray(0, outPos) };
}

module.exports = { decodeYencSegment };
