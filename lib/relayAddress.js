// Streams whose playlist comes through this addon server (a Plex title that
// only plays through a tunnel, /plex/hls), or whose licence request does
// (/plex/licence), need this server's address as the client reaches it. A provider doesn't know that address - it is asked by
// lib/aggregate.js, not by a request - so it writes PLACEHOLDER instead, and
// whoever answers the client puts the real address in (resolve).

const PLACEHOLDER = 'http://strmprov-relay.invalid';

function withBase(address, base) {
    return typeof address === 'string' && address.startsWith(PLACEHOLDER) ? base + address.slice(PLACEHOLDER.length) : address;
}

// A stream's `drm` ({ widevine: { licenseUrl } }) with the placeholder replaced.
function drmWithBase(drm, base) {
    if (!drm || !drm.widevine || withBase(drm.widevine.licenseUrl, base) === drm.widevine.licenseUrl) return drm;
    return Object.assign({}, drm, { widevine: Object.assign({}, drm.widevine, { licenseUrl: withBase(drm.widevine.licenseUrl, base) }) });
}

// [streams] with the placeholder replaced by [base] ("http://192.168.50.252:3100"): in the
// stream's address and in its licence address.
function resolve(streams, base) {
    return streams.map(s => {
        const url = withBase(s.url, base);
        const drm = drmWithBase(s.drm, base);
        const hinted = s.behaviorHints && drmWithBase(s.behaviorHints.drm, base);
        if (url === s.url && drm === s.drm && (!s.behaviorHints || hinted === s.behaviorHints.drm)) return s;
        const out = Object.assign({}, s, { url });
        if (s.drm) out.drm = drm;
        if (s.behaviorHints && s.behaviorHints.drm) out.behaviorHints = Object.assign({}, s.behaviorHints, { drm: hinted });
        return out;
    });
}

module.exports = { PLACEHOLDER, resolve };
