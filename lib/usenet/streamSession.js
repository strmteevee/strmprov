// Real-time progressive Usenet streaming: no file is ever written to disk.
// Segments are fetched from the user's NNTP provider across a small pool of
// connections, yEnc-decoded in memory, and piped straight into the HTTP
// response as soon as they arrive in the right order - the same idea as
// sequential/priority piece downloading in a torrent-streaming client,
// adapted to Usenet's simpler strictly-linear segment numbering.
//
// One UsenetSession is kept alive per active stream token (see
// providers/usenet.js and addon-server.js's /usenet/stream route) across
// however many Range requests the player makes for it, so a normal
// "keep watching forward" playback reuses the same connection pool instead
// of reconnecting to NNTP for every chunk. A big jump (seek) resets the
// fetch position; small forward movement just keeps draining the same
// pipeline.

const { fetchNzb } = require('./nzbFetch');
const { decodeYencSegment } = require('./yenc');
const { openPool, closePool } = require('./nntpPool');

// How far ahead (in already-decoded, not-yet-emitted bytes) the fetch
// workers are allowed to race ahead of what's actually been sent to the
// player - bounds memory use per session instead of buffering the whole
// file, which is the whole point of not saving anything to disk.
const MAX_BUFFER_AHEAD_BYTES = 48 * 1024 * 1024;

// A request whose start lands within this many bytes of the current fetch
// cursor is treated as "still playing forward", not a seek - real players
// commonly issue a fresh Range request slightly behind or ahead of where
// the last one left off (re-requesting a few segments, or the next chunk
// before the previous one even finishes), and resetting the whole pipeline
// for that would throw away work and stall playback on every such request.
const FORWARD_REUSE_WINDOW_BYTES = 8 * 1024 * 1024;

const SESSION_IDLE_TTL_MS = 90 * 1000;

class UsenetSession {
    constructor(nzbUrl, config) {
        this.nzbUrl = nzbUrl;
        this.config = config;
        this.nzb = null;
        this.partSize = 0;
        this.totalSize = 0;
        this.clients = [];
        this.closed = false;

        // Fetch/emit state for the current linear run.
        this.nextToFetch = 1; // 1-indexed segment number workers should claim next
        this.nextToEmit = 1;
        this.pending = new Map(); // segmentNumber -> { beginOffset, data }
        this.bufferedBytes = 0;
        this.waiters = []; // resolve fns waiting on "more buffer space" or "next segment ready"
        this.activeRequestId = 0;
        this.fatalError = null;

        this.idleTimer = null;
    }

    // Rough current playback position, used only to decide whether a new
    // request is "still playing forward" (reuse) or a real seek (reset) -
    // doesn't need to be exact, just close enough for that call.
    currentEmitByteEstimate() {
        return (this.nextToEmit - 1) * this.partSize;
    }

    async init() {
        this.nzb = await fetchNzb(this.nzbUrl);
        const poolSize = Math.min(this.config.connections, Math.max(1, this.nzb.segments.length));
        this.clients = await openPool(this.config, poolSize);
        // Learn the exact per-part decoded size and total file size from the
        // very first segment's own yEnc headers, rather than trusting the
        // NZB's <segment bytes="..."> (that's the encoded wire size, not the
        // decoded one - close but not exact) - this makes seeking to an
        // arbitrary byte offset land on the right segment number directly
        // instead of guessing.
        const firstSegment = this.nzb.segments[0];
        const firstBody = await this.clients[0].body(firstSegment.messageId);
        const firstDecoded = decodeYencSegment(firstBody);
        this.totalSize = this._ybeginSize(firstBody) || this.nzb.totalBytes;
        this.partSize = firstDecoded.data.length || 1;
        this.pending.set(1, { beginOffset: firstDecoded.beginOffset, data: firstDecoded.data });
        this.bufferedBytes += firstDecoded.data.length;
        this._startWorkers();
    }

    _ybeginSize(body) {
        const m = /=ybegin[^\r\n]*\bsize=(\d+)/.exec(body);
        return m ? parseInt(m[1], 10) : null;
    }

    // Segment numbers are 1-indexed and map onto nzb.segments[number-1].
    _segmentAt(number) {
        return this.nzb.segments[number - 1];
    }

    _startWorkers() {
        this.clients.forEach((client) => this._workerLoop(client));
    }

    async _workerLoop(client) {
        while (!this.closed) {
            // Flow control: don't claim more work while too much decoded data
            // is already sitting in `pending` unconsumed - wait for the
            // emitter to drain some of it first.
            if (this.bufferedBytes >= MAX_BUFFER_AHEAD_BYTES) {
                await this._wait();
                continue;
            }
            const number = this.nextToFetch;
            // Nothing left to claim right now - wait rather than exit for
            // good, since a later backward seek can move nextToFetch back
            // down and this worker needs to still be around to pick it up.
            // Only the session actually closing ends this loop.
            if (number > this.nzb.segments.length) { await this._wait(); continue; }
            const segment = this._segmentAt(number);
            if (!segment) { await this._wait(); continue; }
            this.nextToFetch += 1;
            if (this.pending.has(number)) continue; // segment 1 pre-fetched by init()

            try {
                const body = await client.body(segment.messageId);
                const decoded = decodeYencSegment(body);
                if (this.closed) return;
                this.pending.set(number, { beginOffset: decoded.beginOffset, data: decoded.data });
                this.bufferedBytes += decoded.data.length;
                this._wake();
            } catch (err) {
                if (this.closed) return;
                // A single missing/failed article shouldn't kill the whole
                // session - record it as an unrecoverable gap only if it's
                // the one the emitter is actually waiting on (see _drain);
                // otherwise later segments can still arrive and play fine
                // right up to the point where this hole would be needed.
                this.pending.set(number, { error: err });
                this._wake();
            }
        }
    }

    _wait() {
        return new Promise((resolve) => this.waiters.push(resolve));
    }

    _wake() {
        const w = this.waiters.splice(0);
        w.forEach((resolve) => resolve());
    }

    // Finds which segment number a given absolute byte offset falls into,
    // using the exact part size learned from segment 1 as a first guess,
    // then self-corrects against that segment's own real beginOffset - most
    // real multi-part posts use a perfectly uniform part size (so the guess
    // lands exactly), but this doesn't assume it.
    async _segmentForByte(byteOffset, client) {
        let guess = Math.min(this.nzb.segments.length, Math.max(1, Math.floor(byteOffset / this.partSize) + 1));
        for (let attempts = 0; attempts < 6; attempts++) {
            const cached = this.pending.get(guess);
            const decoded = cached && !cached.error ? cached : await this._fetchOne(client, guess);
            if (decoded.beginOffset > byteOffset && guess > 1) { guess -= 1; continue; }
            if (decoded.beginOffset + decoded.data.length <= byteOffset && guess < this.nzb.segments.length) { guess += 1; continue; }
            return guess;
        }
        return guess;
    }

    async _fetchOne(client, number) {
        const segment = this._segmentAt(number);
        const body = await client.body(segment.messageId);
        const decoded = decodeYencSegment(body);
        const entry = { beginOffset: decoded.beginOffset, data: decoded.data };
        this.pending.set(number, entry);
        this.bufferedBytes += decoded.data.length;
        return entry;
    }

    // Resets the linear fetch cursor to start at `byteOffset` - used when a
    // request lands far enough from the current position that it's a real
    // seek, not a continuation. Segments already buffered from the old
    // position that are still useful are kept; the rest of `pending` for
    // positions we're abandoning is dropped so memory doesn't grow
    // unbounded across repeated seeks.
    async seekTo(byteOffset) {
        const client = this.clients[0];
        const startSegment = await this._segmentForByte(byteOffset, client);
        for (const [num] of this.pending) {
            if (num < startSegment) this.pending.delete(num);
        }
        this.bufferedBytes = [...this.pending.values()].reduce((sum, v) => sum + (v.data ? v.data.length : 0), 0);
        this.nextToEmit = startSegment;
        // Always jump the fetch cursor straight to the new position, in
        // either direction: for a forward seek, workers must stop grinding
        // through the now-irrelevant skipped range and jump ahead instead
        // (otherwise a seek near the end of a long file would have to wait
        // for everything before it to download anyway, defeating the point
        // of seeking); for a backward seek, workers need to re-claim numbers
        // they've already passed. Either way, a worker that reaches a
        // segment number still sitting in `pending` from before the seek
        // just skips re-fetching it (see the workerLoop's own pending.has
        // check), so this never redundantly re-downloads anything still
        // cached.
        this.nextToFetch = startSegment;
        this._wake();
        return startSegment;
    }

    // Drains decoded segments in strict order starting at `nextToEmit`,
    // calling `onChunk(buffer)` for each contiguous piece of data (already
    // trimmed to the requested [startByte, endByte] window) until the
    // window is fully served, the session is closed/errored, or a newer
    // request has superseded this one (see beginRequest below) - only one
    // HTTP request drains a given session at a time, since nextToEmit/
    // pending are shared mutable state that two concurrent drain loops
    // would corrupt for each other. A player that abandons a request mid-
    // flight (common when it seeks again before the previous chunk
    // finished) just causes this to return `{ superseded: true }` quietly
    // rather than continuing to burn NNTP bandwidth on a response nothing
    // is reading anymore.
    beginRequest() {
        this.activeRequestId += 1;
        return this.activeRequestId;
    }

    async pipeRange(startByte, endByte, onChunk, requestId) {
        let cursor = Math.max(startByte, 0);
        while (cursor <= endByte && !this.closed) {
            if (requestId !== this.activeRequestId) return { superseded: true };
            const number = this.nextToEmit;
            if (number > this.nzb.segments.length) break;
            let entry = this.pending.get(number);
            if (!entry) {
                await this._wait();
                continue;
            }
            if (entry.error) {
                throw entry.error;
            }
            const segStart = entry.beginOffset;
            const segEnd = segStart + entry.data.length; // exclusive
            if (segEnd <= cursor) {
                // Already fully consumed by a previous overlapping request -
                // just advance past it.
                this.pending.delete(number);
                this.bufferedBytes -= entry.data.length;
                this.nextToEmit += 1;
                // Consuming a segment frees buffer headroom - workers parked
                // in the MAX_BUFFER_AHEAD_BYTES wait in _workerLoop need to
                // be woken to notice, or they'd stay asleep forever once the
                // cap is hit (nothing else ever wakes them, since a sleeping
                // worker can't complete a fetch to wake anyone either) - a
                // real deadlock, not just a slowdown, confirmed by tracing
                // through: no other code path calls _wake() from here.
                this._wake();
                continue;
            }
            const sliceStart = Math.max(0, cursor - segStart);
            const sliceEndAbs = Math.min(segEnd, endByte + 1);
            const sliceEnd = sliceEndAbs - segStart;
            const chunk = entry.data.subarray(sliceStart, sliceEnd);
            if (chunk.length) onChunk(chunk);
            cursor = segStart + sliceEnd;
            if (sliceEndAbs >= segEnd) {
                this.pending.delete(number);
                this.bufferedBytes -= entry.data.length;
                this.nextToEmit += 1;
                this._wake();
            }
        }
    }

    touch() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close(), SESSION_IDLE_TTL_MS);
        this.idleTimer.unref();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this._wake();
        closePool(this.clients);
        this.pending.clear();
    }
}

module.exports = { UsenetSession, FORWARD_REUSE_WINDOW_BYTES };
