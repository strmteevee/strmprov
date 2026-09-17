// Standalone lookup tool - not wired into the rest of strmprov_dev.
//
// Searches free Usenet indexers (NZBKing, Binsearch) for a title and shows
// only results that look like a single directly playable video file (see
// lib/filter.js) - compressed/split archives (rar/zip/7z/.NNN volumes) are
// filtered out. With a Usenet provider configured (Provider Settings in the
// UI), a result can also be downloaded via NNTP (lib/downloadManager.js)
// and played back with the browser's built-in video element once the
// download completes.
//
// Same style as this repo's other servers: plain Node http, no framework.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { searchAll } = require('./lib/searchAll');
const providerStore = require('./lib/providerStore');
const downloadManager = require('./lib/downloadManager');
const { checkAvailability } = require('./lib/availability');
const { NntpClient } = require('./lib/nntp');

const PORT = process.env.PORT || 4100;

const MIME_TYPES = {
  mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', avi: 'video/x-msvideo',
  mov: 'video/quicktime', webm: 'video/webm', ts: 'video/mp2t', m2ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv'
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function handleProviderTest(req, res) {
  const body = await readJsonBody(req);
  const saved = providerStore.load();
  // Password field may arrive masked (unchanged) from the UI - fall back to
  // the already-saved one so "Test" works right after a save without
  // forcing the user to retype it.
  const config = {
    host: body.host || saved.host,
    port: parseInt(body.port, 10) || saved.port,
    ssl: body.ssl !== undefined ? !!body.ssl : saved.ssl,
    username: body.username || saved.username,
    password: (body.password && !/^•+$/.test(body.password)) ? body.password : saved.password
  };

  const client = new NntpClient({ host: config.host, port: config.port, ssl: config.ssl, timeoutMs: 10000 });
  try {
    await client.connect();
    await client.authinfo(config.username, config.password);
    client.quit();
    sendJson(res, 200, { ok: true });
  } catch (err) {
    try { client.quit(); } catch (e) { /* ignore */ }
    sendJson(res, 200, { ok: false, error: err.message });
  }
}

function serveMedia(req, res, id) {
  const info = downloadManager.getJobFilePath(id);
  if (!info) {
    sendJson(res, 404, { error: 'Not downloaded (yet), or unknown job id' });
    return;
  }

  const stat = fs.statSync(info.filePath);
  const ext = (info.filename.split('.').pop() || '').toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(info.filePath).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;

  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(info.filePath, { start, end }).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (url.pathname === '/api/search') {
    const title = url.searchParams.get('title') || '';
    const year = url.searchParams.get('year') || '';
    const season = url.searchParams.get('season') || '';
    const episode = url.searchParams.get('episode') || '';

    if (!title.trim()) {
      sendJson(res, 400, { error: 'title is required' });
      return;
    }

    try {
      const result = await searchAll({ title, year, season, episode });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/provider' && req.method === 'GET') {
    sendJson(res, 200, providerStore.redact(providerStore.load()));
    return;
  }

  if (url.pathname === '/api/provider' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const saved = providerStore.load();
      // Don't overwrite a real saved password with the masked placeholder
      // the UI echoes back when the user didn't change it.
      if (body.password && /^•+$/.test(body.password)) body.password = saved.password;
      const config = providerStore.save(body);
      sendJson(res, 200, providerStore.redact(config));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/provider/test' && req.method === 'POST') {
    await handleProviderTest(req, res);
    return;
  }

  if (url.pathname === '/api/check' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.nzbUrl) {
        sendJson(res, 400, { error: 'nzbUrl is required' });
        return;
      }
      const result = await checkAvailability({ nzbUrl: body.nzbUrl });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/download' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.nzbUrl || !body.filename) {
        sendJson(res, 400, { error: 'nzbUrl and filename are required' });
        return;
      }
      const job = downloadManager.createJob({ nzbUrl: body.nzbUrl, filename: body.filename });
      sendJson(res, 200, job);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const downloadStatusMatch = /^\/api\/download\/([a-f0-9-]+)$/.exec(url.pathname);
  if (downloadStatusMatch && req.method === 'GET') {
    const job = downloadManager.getJob(downloadStatusMatch[1]);
    if (!job) { sendJson(res, 404, { error: 'Unknown job id' }); return; }
    sendJson(res, 200, job);
    return;
  }

  const mediaMatch = /^\/api\/media\/([a-f0-9-]+)$/.exec(url.pathname);
  if (mediaMatch && req.method === 'GET') {
    serveMedia(req, res, mediaMatch[1]);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[usenet-search] listening on http://localhost:${PORT}`);
});
