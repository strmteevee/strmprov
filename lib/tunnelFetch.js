// HTTP(S) requests through the WireGuard tunnel (lib/wireguard.js): wireproxy
// offers the tunnel as a plain HTTP proxy on 127.0.0.1, and this talks to it
// with CONNECT - Node's own fetch() can't be pointed at a proxy without an
// extra package. Only what a provider needs: GET/POST, headers, a timeout, and
// the body as text or a Buffer, following redirects.

const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

// A socket to host:port through the proxy (CONNECT), TLS on top for https.
function connectThrough(proxy, host, port, secure, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${host}:${port}`, headers: { Host: `${host}:${port}` }, timeout: timeoutMs });
        req.on('connect', (res, socket) => {
            // The socket is ours now: the CONNECT request's own timeout must no longer close it.
            req.removeAllListeners('timeout');
            socket.setTimeout(0);
            if (res.statusCode !== 200) {
                socket.destroy();
                return reject(new Error(`Tunnel refused ${host}:${port} (HTTP ${res.statusCode})`));
            }
            if (!secure) return resolve(socket);
            const secured = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] }, () => resolve(secured));
            secured.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`Tunnel timed out connecting to ${host}`)));
        req.on('error', reject);
        req.end();
    });
}

// Some APIs compress whatever the request asks for, so the usual encodings are undone here.
function decode(body, encoding) {
    switch ((encoding || '').trim().toLowerCase()) {
        case 'gzip': return zlib.gunzipSync(body);
        case 'deflate': return zlib.inflateSync(body);
        case 'br': return zlib.brotliDecompressSync(body);
        default: return body;
    }
}

// -> { status, headers, url, text(), buffer() }
function tunnelFetch(proxy, url, options, redirects) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const port = Number(target.port) || (secure ? 443 : 80);
    return connectThrough(proxy, target.hostname, port, secure, timeoutMs).then(socket => new Promise((resolve, reject) => {
        const mod = secure ? https : http;
        const req = mod.request({
            host: target.hostname,
            port,
            path: target.pathname + target.search,
            method: opts.method || 'GET',
            headers: Object.assign({ Host: target.host, 'Accept-Encoding': 'gzip, deflate, br' }, opts.headers || {}),
            // No `agent`: only then does Node use createConnection (agent: false would connect directly).
            createConnection: () => socket,
            timeout: timeoutMs
        }, res => {
            const location = res.headers.location;
            if (res.statusCode >= 300 && res.statusCode < 400 && location && (redirects || 0) < MAX_REDIRECTS) {
                res.resume();
                socket.destroy();
                return resolve(tunnelFetch(proxy, new URL(location, url).href, Object.assign({}, opts, { method: 'GET', body: undefined }), (redirects || 0) + 1));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                socket.destroy();
                let body;
                try {
                    body = decode(Buffer.concat(chunks), res.headers['content-encoding']);
                } catch (e) {
                    return reject(new Error(`Could not decode ${target.host}'s answer: ${e.message}`));
                }
                resolve({ status: res.statusCode, headers: res.headers, url, buffer: () => body, text: () => body.toString('utf8') });
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`Timed out: ${target.host}`)));
        req.on('error', err => { socket.destroy(); reject(err); });
        if (opts.body) req.write(opts.body);
        req.end();
    }));
}

module.exports = { tunnelFetch };
