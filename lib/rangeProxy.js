// Range-request-emulating proxy.
//
// Some upstream hosts - confirmed live: video-downloads.googleusercontent.com,
// the Google Drive-style delivery several driveseed/HubCloud-style scrapers
// in this repo resolve to - ignore the HTTP Range header entirely and always
// send back the full file with a plain 200, never a 206. That breaks players
// that need random access just to begin playback (ExoPlayer/Android TV
// confirmed: "links visible, not playable" for streams that otherwise
// download and play fine with a plain sequential GET).
//
// This can't be fixed by asking the upstream nicely - it simply doesn't
// support ranged responses - but this server sits between that upstream and
// the player, so it can fake Range support instead: request the full body
// (which is what the upstream was always going to send anyway), read past
// and discard the bytes before the requested window, then forward only that
// window to the player as a real 206 Partial Content response with a proper
// Content-Range header.
//
// The real cost this doesn't remove: a request for a range near the END of
// a large file - which many MKV files need immediately, to read their
// Cues/seek index before they can play anything at all - means downloading
// and discarding almost the entire file first. That's the upstream's own
// limitation showing through, not something any proxy can route around. This
// makes playback *possible* where it previously wasn't at all; it doesn't
// make seeking free.

function needsProxy(url) {
    return typeof url === 'string' && url.includes('googleusercontent.com');
}

// Encodes enough into the proxy URL to make the upstream request later
// without needing any server-side session/state - this server may be
// restarted, and a stream URL handed to a player needs to keep working.
function toProxyUrl(baseUrl, originalUrl, headers) {
    const params = new URLSearchParams({ url: originalUrl });
    if (headers && Object.keys(headers).length) {
        params.set('headers', Buffer.from(JSON.stringify(headers)).toString('base64'));
    }
    return `${baseUrl}/proxy?${params.toString()}`;
}

// Rewrites any stream whose url needs proxying to point at this server's
// own /proxy route instead - used by both server.js's /api/streams and
// addon-server.js's /stream so a real device downstream (Nuvio on Android
// TV, in particular) always gets something it can actually seek into.
// baseUrl should be like `http://192.168.1.50:3000` (derived from the
// incoming request's own Host header, not hardcoded, so this works the same
// whether reached by LAN IP or a .local hostname).
function rewriteStreamUrls(streams, baseUrl) {
    return streams.map((s) => {
        if (!needsProxy(s.url)) return s;
        const rewritten = Object.assign({}, s, {
            url: toProxyUrl(baseUrl, s.url, s.headers)
        });
        delete rewritten.headers; // the proxy sends these upstream itself now
        return rewritten;
    });
}

function parseRange(rangeHeader, totalSize) {
    if (!rangeHeader) return null;
    const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!m) return null;
    const [, startStr, endStr] = m;
    if (startStr === '' && endStr === '') return null;

    if (startStr === '') {
        // Suffix range ("last N bytes") - only resolvable when the total
        // size is already known.
        if (totalSize == null) return null;
        const suffixLength = parseInt(endStr, 10);
        return { start: Math.max(0, totalSize - suffixLength), end: totalSize - 1 };
    }
    const start = parseInt(startStr, 10);
    const end = endStr === '' ? (totalSize != null ? totalSize - 1 : null) : parseInt(endStr, 10);
    return { start, end };
}

// Forwards the upstream body as-is (used when the player didn't send a
// Range we can honor, or total size is unknown) - still advertises
// Accept-Ranges so the player knows to try a ranged request next time.
function pipeFull(body, res, controller) {
    const reader = body.getReader();
    res.on('close', () => { try { controller.abort(); } catch (e) { /* already done */ } });
    function pump() {
        reader.read().then(({ done, value }) => {
            if (done) { res.end(); return; }
            const ok = res.write(Buffer.from(value));
            if (ok) pump(); else res.once('drain', pump);
        }).catch(() => res.end());
    }
    pump();
}

// Reads the full upstream body but only writes out [start, end] to the
// client, aborting the upstream fetch as soon as that window is complete so
// we don't keep downloading (and paying for) the rest of a multi-GB file
// once the player has what it asked for.
function pipeRange(body, res, start, end, controller) {
    const reader = body.getReader();
    let position = 0;
    let finished = false;
    res.on('close', () => { finished = true; try { controller.abort(); } catch (e) { /* already done */ } });

    function pump() {
        if (finished) return;
        reader.read().then(({ done, value }) => {
            if (done) { finished = true; res.end(); return; }
            const chunk = Buffer.from(value);
            const chunkStart = position;
            const chunkEnd = position + chunk.length - 1;
            position += chunk.length;

            if (chunkEnd < start) { pump(); return; } // still before the window

            const sliceStart = Math.max(0, start - chunkStart);
            const sliceEnd = end != null ? Math.min(chunk.length, end - chunkStart + 1) : chunk.length;
            if (sliceStart >= sliceEnd) { pump(); return; }

            const ok = res.write(chunk.slice(sliceStart, sliceEnd));
            if (end != null && chunkStart + sliceEnd - 1 >= end) {
                finished = true;
                try { controller.abort(); } catch (e) { /* already done */ }
                res.end();
                return;
            }
            if (ok) pump(); else res.once('drain', pump);
        }).catch(() => { finished = true; res.end(); });
    }
    pump();
}

// req/res: the incoming HTTP request for GET /proxy?url=...&headers=...
function handleProxyRequest(req, res, query) {
    const targetUrl = query.get('url');
    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        return;
    }
    let upstreamHeaders = {};
    const headersParam = query.get('headers');
    if (headersParam) {
        try { upstreamHeaders = JSON.parse(Buffer.from(headersParam, 'base64').toString('utf8')); } catch (e) { /* ignore malformed headers, proceed without them */ }
    }

    const controller = new AbortController();
    req.on('close', () => { try { controller.abort(); } catch (e) { /* already done */ } });

    fetch(targetUrl, { headers: upstreamHeaders, signal: controller.signal }).then((upstream) => {
        if (!upstream.ok) {
            res.writeHead(upstream.status);
            res.end();
            return;
        }
        const totalSize = parseInt(upstream.headers.get('content-length') || '', 10);
        const hasTotalSize = Number.isFinite(totalSize);
        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        const range = parseRange(req.headers['range'], hasTotalSize ? totalSize : null);

        if (!range) {
            res.writeHead(200, Object.assign(
                { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' },
                hasTotalSize ? { 'Content-Length': totalSize } : {}
            ));
            pipeFull(upstream.body, res, controller);
            return;
        }

        const { start } = range;
        const end = range.end != null ? range.end : (hasTotalSize ? totalSize - 1 : null);
        res.writeHead(206, Object.assign(
            {
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${start}-${end != null ? end : ''}/${hasTotalSize ? totalSize : '*'}`
            },
            end != null ? { 'Content-Length': end - start + 1 } : {}
        ));
        pipeRange(upstream.body, res, start, end, controller);
    }).catch((err) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Proxy fetch failed: ${err.message}`);
    });
}

module.exports = { needsProxy, rewriteStreamUrls, handleProxyRequest };
