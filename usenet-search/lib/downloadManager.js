// Orchestrates one NZB download: fetch+parse the NZB, then fan the segment
// list out across a small pool of NNTP connections (as configured by the
// user's provider settings), yEnc-decode each article body, and write it at
// its correct byte offset into the output file. Jobs are tracked in memory
// only (this is a single-user local tool, not a durable queue) so progress
// is lost on server restart - acceptable for what this is.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { fetchNzb } = require('./nzbFetch');
const { decodeYencSegment } = require('./yenc');
const { openPool, closePool } = require('./nntpPool');
const providerStore = require('./providerStore');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'data', 'downloads');

const jobs = new Map();

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'video';
}

function publicJob(job) {
  return {
    id: job.id,
    filename: job.filename,
    state: job.state,
    totalBytes: job.totalBytes,
    downloadedBytes: job.downloadedBytes,
    progress: job.totalBytes ? Math.min(1, job.downloadedBytes / job.totalBytes) : 0,
    error: job.error || null
  };
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

function getJobFilePath(id) {
  const job = jobs.get(id);
  if (!job || job.state !== 'complete') return null;
  return { filePath: job.filePath, filename: job.filename };
}

async function runWorker(queue, client, job) {
  for (;;) {
    const segment = queue.shift();
    if (!segment) return;
    const body = await client.body(segment.messageId);
    const decoded = decodeYencSegment(body);
    await job.fileHandle.write(decoded.data, 0, decoded.data.length, decoded.beginOffset);
    job.downloadedBytes += decoded.length;
  }
}

async function startDownload(job) {
  const config = providerStore.load();
  if (!providerStore.isConfigured(config)) {
    job.state = 'error';
    job.error = 'No Usenet provider configured. Add one in Provider Settings first.';
    return;
  }

  try {
    const nzb = await fetchNzb(job.nzbUrl);
    job.totalBytes = nzb.totalBytes;

    await fsp.mkdir(path.dirname(job.filePath), { recursive: true });
    job.fileHandle = await fsp.open(job.filePath, 'w');

    const queue = nzb.segments.slice();
    const poolSize = Math.min(config.connections, Math.max(1, queue.length));
    const clients = await openPool(config, poolSize);

    job.state = 'downloading';
    await Promise.all(clients.map((client) => runWorker(queue, client, job)));

    closePool(clients);
    await job.fileHandle.close();
    job.state = 'complete';
  } catch (err) {
    job.state = 'error';
    job.error = err.message;
    if (job.fileHandle) {
      try { await job.fileHandle.close(); } catch (e) { /* already closed */ }
    }
  }
}

function createJob({ nzbUrl, filename }) {
  const id = crypto.randomUUID();
  const safeName = sanitizeFilename(filename);
  const job = {
    id,
    nzbUrl,
    filename: safeName,
    filePath: path.join(DOWNLOADS_DIR, id, safeName),
    state: 'queued',
    totalBytes: 0,
    downloadedBytes: 0,
    error: null,
    fileHandle: null
  };
  jobs.set(id, job);
  startDownload(job); // fire and forget - progress polled via getJob(id)
  return publicJob(job);
}

module.exports = { createJob, getJob, getJobFilePath };
