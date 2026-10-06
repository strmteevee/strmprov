// Generic, config-driven relay for an external Stremio-protocol addon -
// the single implementation behind every "just relay another addon's own
// results" provider in this repo (hdhub4u, penguplay, and anything added
// later through the admin UI), instead of a hand-written copy per addon.
//
// Exports createProvider(config), not a bare getStreams - lib/aggregate.js's
// loadProvider() calls createProvider(entry.config) for any manifest entry
// that points its filename here, so one file can back many differently
// configured providers at once. See admin-server.js for how a manifest
// entry's config gets created/edited.
//
// config shape: { addonBaseUrl: string, configJson?: object, tmdbApiKey?: string, namePrefix?: string }
// - addonBaseUrl: the addon's own base URL (e.g. "https://pengu.uk"). Some
//   addons bake their whole config into this URL already (hdhub4u) and need
//   nothing else; others expect a URL-encoded JSON config path segment
//   appended after the base (penguplay's auth_token/disable_direct).
// - configJson: when present, JSON-encoded and appended as that path
//   segment. Omit/null for addons that don't use one.
// - tmdbApiKey: optional override; every provider in this repo already
//   shares one publicly-used TMDB key, reused here by default so most
//   configs don't need to specify it.
// - namePrefix: prepended to each returned stream's own name. Some addons'
//   stream names are already self-branded (PenguPlay's "🐧 PenguPlay ...")
//   and don't need one; others (HDHub4u's) aren't, so this repo has
//   historically added "HDHub4u " itself - kept configurable rather than
//   hardcoded so either style works without new code.
const DEFAULT_TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

function getImdbId(tmdbId, mediaType, tmdbApiKey) {
  const endpoint = mediaType === "tv" ? "tv" : "movie";
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${tmdbApiKey}&append_to_response=external_ids`;
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
  // Descriptions sometimes also carry a bitrate line ("~55.9 Mbps") - a
  // plain /(GB|MB)/i match grabs "Mb" out of "Mbps" instead of a real size
  // line, since both start with the same two letters. A word boundary after
  // the unit rules that out: "Mbps" has no boundary between "b" and "p".
  const m = (description || "").match(/([\d.]+)\s*(GB|MB)\b/i);
  return m ? `${m[1]} ${m[2].toUpperCase()}` : undefined;
}

// Confirmed live (while building this repo's own hdhub4u/penguplay relays):
// "HubCloud"-style gateway links (hubcloud.cx/.ist/.dad) need their own
// multi-hop resolution before it's known whether they land on a real file or
// a non-seekable Google Drive link / dead Telegram-bot redirect. Not worth
// reproducing that chain for a third-party addon we don't control, so these
// are skipped; already-direct links (PixelDrain, R2, etc.) pass through.
// HubDrive file pages (hubdrive.*/file/<id>) are the same kind of gateway:
// re-verified live 2026-10-06 that HDHub4u's relay returns them as stream
// URLs and each is just an HTML interstitial (200 text/html), not a video.
function isUsableStream(s) {
  if (!s.url) return false;
  try {
    const host = new URL(s.url).hostname;
    return !host.includes("hubcloud") && !host.includes("hubdrive");
  } catch (e) {
    return false;
  }
}

// By request: PenguPlay's MovieBox-sourced entries sometimes offer the same
// title re-dubbed into another language entirely (Arabic, French, Kurdish,
// Russian, Tamil, Telugu, ...) - confirmed live in MovieBox's own
// descriptions, two ways: most say so explicitly with a "<language> sub
// audio"/"<language> dub audio" phrase (MovieBox's own confusing term for a
// substitute/dubbed audio track, not an actual burned-in visual subtitle -
// there's no separate subtitle file or hardsub involved at all), but Hindi
// variants specifically only carry a trailing "Audio: Hindi" line with no
// "dub audio" phrasing at all - confirmed live this second pattern would
// otherwise slip through the first check alone. The original/default-audio
// variants never carry either pattern, so both are reliable signals without
// needing to enumerate every language they might show up as.
function isForeignDubbedAudio(description) {
  const text = description || "";
  if (/\b(?:sub|dub) audio\b/i.test(text)) return true;
  const audioLine = text.match(/Audio:\s*([^\n]+)/i);
  return !!audioLine && !/\benglish\b/i.test(audioLine[1]);
}

function createProvider(config) {
  const addonBaseUrl = (config && config.addonBaseUrl || "").replace(/\/+$/, "");
  const configJson = config && config.configJson;
  const tmdbApiKey = (config && config.tmdbApiKey) || DEFAULT_TMDB_API_KEY;
  const providerLabel = (config && config.name) || "ExternalAddon";
  const namePrefix = (config && config.namePrefix) || "";
  const configSegment = configJson ? `/${encodeURIComponent(JSON.stringify(configJson))}` : "";

  function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
    console.log(`[${providerLabel}] Fetching streams for TMDB: ${tmdbId}, Type: ${mediaType}`);
    return getImdbId(tmdbId, mediaType, tmdbApiKey).then((imdbId) => {
      if (!imdbId) {
        console.log(`[${providerLabel}] No IMDb id found for this TMDB id`);
        return [];
      }
      const type = mediaType === "tv" ? "series" : "movie";
      if (type === "series" && (!season || !episode)) return [];
      const id = type === "series" ? `${imdbId}:${season}:${episode}` : imdbId;

      return fetch(`${addonBaseUrl}${configSegment}/stream/${type}/${id}.json`, { headers: { "User-Agent": "Mozilla/5.0" } })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          const raw = Array.isArray(data.streams) ? data.streams : [];
          const seenUrls = new Set();
          const streams = [];
          for (const s of raw) {
            if (!isUsableStream(s) || seenUrls.has(s.url) || isForeignDubbedAudio(s.description)) continue;
            seenUrls.add(s.url);
            const rawName = (s.name || "").replace(/\n/g, " ").trim();
            const name = `${namePrefix}${rawName}`.trim();
            const description = (s.description || "").replace(/\n/g, " ").trim();
            streams.push({
              name,
              title: description,
              url: s.url,
              quality: parseQuality(name),
              size: parseSize(description)
            });
          }
          console.log(`[${providerLabel}] Got ${streams.length} usable stream(s)`);
          return streams;
        });
    }).catch((err) => {
      console.error(`[${providerLabel}] Error: ${err.message}`);
      return [];
    });
  }

  return { getStreams };
}

module.exports = { createProvider };
