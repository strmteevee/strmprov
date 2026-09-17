// Pre-download check: fetches the NZB and runs STAT (not BODY) against a
// sample of its segments across a pooled set of connections, so a user can
// see whether a release is actually present on their provider before
// spending time on a full download that might die partway through on a
// missing article (see lib/nntp.js's 430 handling).
//
// Sampled, not exhaustive: a release can have thousands of segments (a
// large 4K remux easily posts 10,000+), and STAT-ing every one of them is
// still one NNTP round trip each - even pooled across several connections
// that's minutes, not the quick check this is meant to be. Providers carry
// or drop a whole post together (retention/propagation applies at the
// article-group level, not per-segment), so a spread-out sample is a
// reliable proxy for the whole file's availability in practice.

const MAX_SAMPLE = 40;
// Checks for different results can now run in parallel (see the frontend's
// autoCheckAvailability), each opening its own pool - so this is kept small
// and fixed rather than using the user's full `connections` setting (that
// number is sized for the heavier download workload), to keep the total
// simultaneous connections across several concurrent checks from blowing
// past the provider's connection limit.
const CHECK_POOL_SIZE = 2;

const { fetchNzb } = require('./nzbFetch');
const { openPool, closePool } = require('./nntpPool');
const providerStore = require('./providerStore');

function sampleSegments(segments, max) {
  if (segments.length <= max) return segments;
  const step = (segments.length - 1) / (max - 1);
  const sample = [];
  for (let i = 0; i < max; i++) {
    sample.push(segments[Math.round(i * step)]);
  }
  return sample;
}

async function runStatWorker(queue, client, results) {
  for (;;) {
    const segment = queue.shift();
    if (!segment) return;
    try {
      const ok = await client.stat(segment.messageId);
      results.push({ number: segment.number, ok });
    } catch (err) {
      results.push({ number: segment.number, ok: false, error: err.message });
    }
  }
}

async function checkAvailability({ nzbUrl }) {
  const config = providerStore.load();
  if (!providerStore.isConfigured(config)) {
    throw new Error('No Usenet provider configured. Add one in Provider Settings first.');
  }

  const nzb = await fetchNzb(nzbUrl);
  const queue = sampleSegments(nzb.segments, MAX_SAMPLE);
  const sampleSize = queue.length; // capture before workers drain it via shift()
  const poolSize = Math.min(CHECK_POOL_SIZE, Math.max(1, queue.length));
  const clients = await openPool(config, poolSize);

  const results = [];
  try {
    await Promise.all(clients.map((client) => runStatWorker(queue, client, results)));
  } finally {
    closePool(clients);
  }

  const missing = results.filter((r) => !r.ok).sort((a, b) => a.number - b.number);
  return {
    totalSegments: nzb.segments.length,
    sampledSegments: sampleSize,
    missingSegments: missing.length,
    available: missing.length === 0,
    missingSample: missing.slice(0, 5).map((m) => m.number)
  };
}

module.exports = { checkAvailability };
