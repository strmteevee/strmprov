// penguplay - relays the PenguPlay Stremio addon instead of scraping any
// site directly. PenguPlay is itself a multi-source aggregator (4KHDHub,
// MovieBox, VegaMovies, HDHub4u, VidLink, VidFast, 2Peckle and others,
// selectable via its own config), so this merges its combined results into
// this repo's aggregate the same way providers/hdhub4u.js relays its own
// external addon - convert our TMDB id to the IMDb id it expects, call its
// /stream endpoint, and map the results into this repo's normal stream
// shape. Nothing else needs to change for that: this still just exports the
// same getStreams(tmdbId, mediaType, season, episode) shape as every other
// provider.
//
// disable_direct:true is added to the given auth_token's config - PenguPlay
// documents this itself as "Hide non-seekable streams", and confirmed live:
// without it, results include the same kind of unresolved HubCloud-style
// gateway links this repo's own scrapers have repeatedly found to be
// non-seekable Google Drive links or dead redirects; with it on, every
// remaining stream tested (PixelDrain, 2Peckle's own CDN) properly returned
// 206/Content-Range on a ranged request.
const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const AUTH_TOKEN = "CwgTS317M83kEQR4ErRaW_IOI0hJIU00Y91Umm97ZC0";
const ADDON_BASE = "https://pengu.uk";

function getConfigPath() {
  const config = { auth_token: AUTH_TOKEN, disable_direct: true };
  return encodeURIComponent(JSON.stringify(config));
}

function getImdbId(tmdbId, mediaType) {
  const endpoint = mediaType === "tv" ? "tv" : "movie";
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  return fetch(url, { headers: { "Accept": "application/json" } })
    .then((res) => {
      if (!res.ok) throw new Error(`TMDB API error: ${res.status}`);
      return res.json();
    })
    .then((data) => (data.external_ids && data.external_ids.imdb_id) || null);
}

function parseQuality(name) {
  const text = name || "";
  if (/\b4k\b|2160/i.test(text)) return "4K";
  const m = text.match(/(\d{3,4})p/i);
  return m ? `${m[1]}p` : "Unknown";
}

function parseSize(description) {
  // The description also carries a bitrate line ("~55.9 Mbps") - a plain
  // /(GB|MB)/i match grabs "Mb" out of "Mbps" instead of the real "💾 47.24
  // GB" size line that follows it, since both start with the same two
  // letters. Requiring a word boundary after the unit rules that out: "Mbps"
  // has no boundary between "b" and "p", so it no longer matches there.
  const m = (description || "").match(/([\d.]+)\s*(GB|MB)\b/i);
  return m ? `${m[1]} ${m[2].toUpperCase()}` : undefined;
}

// Backstop for whatever disable_direct doesn't catch - same reasoning as
// providers/hdhub4u.js's isUsableStream: a HubCloud-style gateway link needs
// its own multi-hop resolution before it's known whether it lands on a real
// file or a non-seekable/dead one, which isn't worth reproducing here for a
// third-party addon we don't control. lib/aggregate.js's own
// googleusercontent.com filter still applies on top of this regardless.
function isUsableStream(s) {
  if (!s.url) return false;
  try {
    return !new URL(s.url).hostname.includes("hubcloud");
  } catch (e) {
    return false;
  }
}

function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  console.log(`[PenguPlay] Fetching streams for TMDB: ${tmdbId}, Type: ${mediaType}`);
  return getImdbId(tmdbId, mediaType).then((imdbId) => {
    if (!imdbId) {
      console.log("[PenguPlay] No IMDb id found for this TMDB id");
      return [];
    }
    const type = mediaType === "tv" ? "series" : "movie";
    if (type === "series" && (!season || !episode)) return [];
    const id = type === "series" ? `${imdbId}:${season}:${episode}` : imdbId;

    return fetch(`${ADDON_BASE}/${getConfigPath()}/stream/${type}/${id}.json`, { headers: { "User-Agent": "Mozilla/5.0" } })
      .then((res) => {
        if (!res.ok) throw new Error(`PenguPlay HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const raw = Array.isArray(data.streams) ? data.streams : [];
        const seenUrls = new Set();
        const streams = [];
        for (const s of raw) {
          if (!isUsableStream(s) || seenUrls.has(s.url)) continue;
          seenUrls.add(s.url);
          const name = (s.name || "").replace(/\n/g, " ").trim();
          const description = (s.description || "").replace(/\n/g, " ").trim();
          streams.push({
            // The source name already carries its own "PenguPlay" branding
            // (e.g. "🐧 PenguPlay ❄️ 4K • 2Peckle") - prefixing our own
            // would just double it up.
            name,
            title: description,
            url: s.url,
            quality: parseQuality(name),
            size: parseSize(description),
            provider: "penguplay"
          });
        }
        console.log(`[PenguPlay] Got ${streams.length} usable stream(s)`);
        return streams;
      });
  }).catch((err) => {
    console.error(`[PenguPlay] Error: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
