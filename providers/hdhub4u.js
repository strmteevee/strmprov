// hdhub4u - now relays an external, community-maintained Stremio addon
// instead of scraping HDHub4u's own site directly. That scraper needed
// repeated fixes as the site's own redirect/gateway chain kept changing
// (see git history), so per instruction this stops maintaining a duplicate
// of that work and instead merges this addon's own results into the
// aggregate the same way every other provider here already does - nothing
// else in lib/aggregate.js or manifest.json needs to change for that, since
// this file still just exports the same getStreams(tmdbId, mediaType,
// season, episode) shape as every other provider.
//
// The external addon expects a real IMDb id, not a TMDB id (confirmed live:
// `tmdb:<id>` requests intermittently hung/failed, while `tt<id>` requests
// resolved reliably in 1-2s) - converting TMDB -> IMDb is done inline here,
// the same way castle.js/streamflix.js/etc already do it, rather than
// importing lib/tmdb.js, so this file stays self-contained like every other
// provider (some of which are also installed as standalone Nuvio plugins,
// where cross-file requires aren't available at all).
const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const EXTERNAL_ADDON_BASE = "https://hdhub.thevolecitor.qzz.io/eyJ0b3Jib3giOiJ1bnNldCIsInF1YWxpdGllcyI6IjEwODBwLDcyMHAiLCJzb3J0IjoiZGVzYyIsImNhdGFsb2dzIjoiIn0";

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
  const m = (name || "").match(/(\d{3,4})p/i);
  return m ? `${m[1]}p` : "Unknown";
}

function formatBytes(bytes) {
  if (!bytes) return undefined;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

// The addon's raw response mixes real streams in with promo entries
// ("Donation needed", "Join the Discord server" - identifiable by having no
// `url`, only an `externalUrl`) and, among the real ones, "HubCloud" gateway
// links (hubcloud.cx/.ist/.dad) whose id token needs its own multi-hop
// resolution before it's known whether it lands on a real file or - as
// found repeatedly while building this repo's own HDHub4u scraper - a
// non-seekable Google Drive link or even a dead Telegram-bot redirect.
// Resolving that chain for a third-party addon we don't control isn't worth
// reproducing here, so those are skipped; pixeldrain/R2/other already-direct
// links pass through as-is.
function isUsableStream(s) {
  if (!s.url) return false;
  try {
    return !new URL(s.url).hostname.includes("hubcloud");
  } catch (e) {
    return false;
  }
}

function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  console.log(`[HDHub4u] Fetching streams (external addon) for TMDB: ${tmdbId}, Type: ${mediaType}`);
  return getImdbId(tmdbId, mediaType).then((imdbId) => {
    if (!imdbId) {
      console.log("[HDHub4u] No IMDb id found for this TMDB id");
      return [];
    }
    const type = mediaType === "tv" ? "series" : "movie";
    if (type === "series" && (!season || !episode)) return [];
    const id = type === "series" ? `${imdbId}:${season}:${episode}` : imdbId;

    return fetch(`${EXTERNAL_ADDON_BASE}/stream/${type}/${id}.json`, { headers: { "User-Agent": "Mozilla/5.0" } })
      .then((res) => {
        if (!res.ok) throw new Error(`External addon HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const raw = Array.isArray(data.streams) ? data.streams : [];
        const seenUrls = new Set();
        const streams = [];
        for (const s of raw) {
          if (!isUsableStream(s) || seenUrls.has(s.url)) continue;
          seenUrls.add(s.url);
          streams.push({
            name: `HDHub4u ${(s.name || "").replace(/\n/g, " ").trim()}`.trim(),
            title: (s.description || "").replace(/\n/g, " ").trim(),
            url: s.url,
            quality: parseQuality(s.name),
            size: formatBytes(s.behaviorHints && s.behaviorHints.videoSize),
            provider: "hdhub4u"
          });
        }
        console.log(`[HDHub4u] Got ${streams.length} usable stream(s) from external addon`);
        return streams;
      });
  }).catch((err) => {
    console.error(`[HDHub4u] Error: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
