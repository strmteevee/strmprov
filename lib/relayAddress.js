// Streams whose playlist comes through this addon server (a Plex title that
// only plays through a tunnel, /plex/hls) need this server's address as the
// client reaches it. A provider doesn't know that address - it is asked by
// lib/aggregate.js, not by a request - so it writes PLACEHOLDER instead, and
// whoever answers the client puts the real address in (resolve).

const PLACEHOLDER = 'http://strmprov-relay.invalid';

// [streams] with the placeholder replaced by [base] ("http://192.168.50.252:3100").
function resolve(streams, base) {
    return streams.map(s => (typeof s.url === 'string' && s.url.startsWith(PLACEHOLDER)
        ? Object.assign({}, s, { url: base + s.url.slice(PLACEHOLDER.length) })
        : s));
}

module.exports = { PLACEHOLDER, resolve };
