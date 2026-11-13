// Generic YouTube channel "Live" tab reader - lists a channel's streams that
// are live right now, scheduled to go live, and finished ones (the "races
// that have finished" catalogs), with no API key.
//
// Written against the real pages, re-verified live 2026-10-17:
//   - https://www.youtube.com/<handle>/streams is the channel's "Live" tab.
//     It is a normal HTML page whose `ytInitialData` JSON lists every stream
//     as a `lockupViewModel` (YouTube's current layout - the older
//     `videoRenderer` shape no longer appears). Each one carries the video id
//     (`contentId`), the title, and thumbnail overlay badges that give its
//     state: the text "LIVE" (live now, metadata row "N watching"),
//     "Upcoming" (metadata row "Scheduled for M/D/YY, h:mm AM"), or a
//     duration like "1:30:55" (finished; metadata row "<views> / Streamed 2h
//     ago"). A SOCS/CONSENT cookie is needed or YouTube serves a consent wall.
//   - Only ~30 items fit on the first page. Older ones come from the
//     `continuationItemRenderer` token at the end of the grid, exchanged via
//     the InnerTube browse endpoint (no login needed for this call).
//
// Playback: each video is resolved to its HLS master playlist (every quality
// up to 1080p, audio included) the same way the Nuvio app resolves trailers
// and `ytId` streams (NuvioMobile's InAppYouTubeExtractor): read the watch
// page's INNERTUBE_API_KEY and VISITOR_DATA, then ask the InnerTube `player`
// API as the visionOS client (falling back to Android, then iOS) with that
// visitor id. Re-verified live 2026-10-19 for a finished video and a live
// stream. A bare player call without the visitor id - what was tried first -
// gets "Sign in to confirm you're not a bot" from this network instead.
// The playlist URL is tied to the public IP that asked for it, which is fine
// for devices on the same home network as the server; for anything else a
// `ytId` stream (played through YouTube itself) and an `externalUrl` (opens
// the YouTube app) are offered as well.

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'en-US,en;q=0.9',
  // PREF tz=UTC: without it YouTube renders "Scheduled for ..." in US Pacific
  // time for a location-less server request (confirmed 2026-11-07: every
  // time was exactly 8h off), while parseScheduled() reads it as UTC.
  Cookie: 'SOCS=CAI; CONSENT=YES+1; PREF=tz=UTC'
};

// A finished stream shorter than this is a clip/short, not a race.
const MIN_RACE_SECONDS = 20 * 60;
const MIN_HIGHLIGHT_SECONDS = 60;

// How many extra grid pages (~30 items each) to walk for the finished list.
const MAX_CONTINUATION_PAGES = 4;
// Stop paging once this many races have been found.
const TARGET_RACES = 40;

const LIVE_CACHE_TTL_MS = 2 * 60 * 1000;
const RACES_CACHE_TTL_MS = 15 * 60 * 1000;

// Each channel decides for itself what counts as a "race" among its finished
// streams - GT World posts the same race in several languages, onboard feeds
// and qualifying sessions as separate streams, so its main English race
// broadcast has to be picked out by title; iRacing's finished streams are all
// race broadcasts ("<series> | <round> | <track>"), so duration alone is
// enough there.
const CHANNELS = {
  gtworld: {
    label: 'GT World',
    path: '@GTWorld',
    isRace: (title) => /\brace\b/i.test(title) && !/qualif|practice|warm[- ]?up|onboard|\bOB\b|highlights|preview/i.test(title)
  },
  iracing: {
    label: 'iRacing',
    path: 'iRacingTV',
    isRace: (title) => !/preview|interview|podcast|trailer|recap/i.test(title)
  },
  // DTM has no live streams on its channel (checked 2026-10-17) - its
  // /videos tab is the useful one, with race highlights mixed in among
  // team-radio/overtake clips, Behind The Grid episodes and teasers, so
  // highlights are picked out by title.
  dtm: {
    label: 'DTM',
    path: '@DTM',
    tab: 'videos',
    // DTM uploads each highlight in English and German ("... Race 2
    // Highlights" / "... Highlights Rennen 2") - keep the English one.
    isHighlight: (title) => /highlight/i.test(title) && !/\bRennen\b/i.test(title)
  },
  // Full-race playlists rather than channels (a `playlist` id instead of a
  // `path`): a curated list of full race replays, read as a "races" catalog.
  // Every item is a full race, so isRace keeps them all - MIN_RACE_SECONDS
  // still drops any short clip that slips into the playlist.
  nascar: {
    label: 'NASCAR',
    playlist: 'PLtc57NTUizP5puz0sL-X83QHZ-6fQgVR-',
    isRace: () => true
  },
  indycar: {
    label: 'IndyCar',
    playlist: 'PL948kNhk-wMuegsHBAlJOb_wUEzXFcLfy',
    isRace: () => true
  }
};

function channelKeys() {
  return Object.keys(CHANNELS);
}

// On/off per channel, switched from the admin dashboard and shared by both
// servers through this file. It holds the switched-off channels (so a newly
// added channel starts on) plus a revision counter that goes up on every
// change, which addon-server.js folds into its manifest version so clients
// notice catalogs appearing/disappearing. Kept out of git (.gitignore) so a
// `git pull` on the server never fights a local setting.
const SETTINGS_PATH = path.join(__dirname, '..', 'config', 'youtube-channels.json');

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((k) => typeof k === 'string') : [],
      revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
    };
  } catch (e) {
    return { disabled: [], revision: 0 };
  }
}

function isChannelEnabled(key) {
  return !readSettings().disabled.includes(key);
}

function setChannelEnabled(key, enabled) {
  if (!CHANNELS[key]) throw new Error(`Unknown YouTube channel "${key}"`);
  const settings = readSettings();
  const disabled = new Set(settings.disabled);
  if (enabled) disabled.delete(key); else disabled.add(key);
  const next = { disabled: [...disabled], revision: settings.revision + 1 };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function settingsRevision() {
  return readSettings().revision;
}

// GT World titles every broadcast "LIVE | Race | ..." (or "LIVE I ..."/
// "EN DIRECT | ...") and the title is kept after the stream ends, so a
// finished race would otherwise still be labeled LIVE in a replay catalog.
function cleanTitle(title) {
  return String(title || '').replace(/^\s*(?:LIVE|EN DIRECT)\s+(?:OB\s*#\d+\s+)?[|I]\s*/i, '').replace(/^\s*(?:LIVE|EN DIRECT)\s*[|I]\s*/i, '').trim() || title;
}

// ---- page + continuation fetching ----

function extractJson(html, startMarker) {
  const start = html.indexOf(startMarker);
  if (start === -1) return null;
  const from = html.indexOf('{', start);
  // The object is followed by ";</script>" - scan to the matching brace
  // rather than regex it, since the JSON itself contains "};" sequences.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(from, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function findAll(root, predicate) {
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (predicate(o)) out.push(o);
    Object.values(o).forEach(walk);
  })(root);
  return out;
}

function collectText(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach(n => collectText(n, acc)); return acc; }
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'text' || k === 'content') && typeof v === 'string') acc.push(v);
    else collectText(v, acc);
  }
  return acc;
}

function parseDuration(text) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10);
}

const UNIT_MS = {
  second: 1000, minute: 60 * 1000, hour: 3600 * 1000, day: 86400 * 1000,
  week: 7 * 86400 * 1000, month: 30 * 86400 * 1000, year: 365 * 86400 * 1000
};

// "Streamed 2 hours ago" / "2h ago" / "1d ago" / "3 weeks ago" -> approximate
// epoch ms (YouTube only gives a relative age for finished streams).
function parseRelativeAge(text) {
  const m = /(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d|week|w|month|mo|year|yr|y)s?\s+ago/i.exec(text) || /(\d+)(s|m|h|d|w|y)\s*ago/i.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  let unit;
  if (u.startsWith('sec') || u === 's') unit = 'second';
  else if (u.startsWith('min') || u === 'm') unit = 'minute';
  else if (u.startsWith('h')) unit = 'hour';
  else if (u.startsWith('d')) unit = 'day';
  else if (u.startsWith('w')) unit = 'week';
  else if (u.startsWith('mo')) unit = 'month';
  else unit = 'year';
  return Date.now() - n * UNIT_MS[unit];
}

// "Scheduled for 10/18/26, 7:35 AM" -> epoch ms. PAGE_HEADERS (PREF tz=UTC)
// and the browse context make YouTube render this in UTC, so the result is a
// real absolute start time (used for display and live/upcoming status).
function parseScheduled(text) {
  const m = /Scheduled for\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text);
  if (!m) return null;
  let hour = parseInt(m[4], 10) % 12;
  if (m[6].toUpperCase() === 'PM') hour += 12;
  const year = parseInt(m[3], 10) < 100 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
  return Date.UTC(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10), hour, parseInt(m[5], 10));
}

function parseViewers(text) {
  const m = /([\d.,]+)\s*([KM]?)\s+watching/i.exec(text);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Math.round(n * (m[2].toUpperCase() === 'K' ? 1000 : m[2].toUpperCase() === 'M' ? 1000000 : 1));
}

function lockupToItem(lockup) {
  if (!lockup || lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !lockup.contentId) return null;
  const meta = lockup.metadata && lockup.metadata.lockupMetadataViewModel;
  const title = meta && meta.title && meta.title.content;
  if (!title) return null;

  const overlayText = collectText(lockup.contentImage && lockup.contentImage.thumbnailViewModel && lockup.contentImage.thumbnailViewModel.overlays, []);
  const metaText = collectText(meta.metadata, []);

  let status = 'past';
  let durationSeconds = null;
  if (overlayText.some(t => /^live$/i.test(t.trim()))) status = 'live';
  else if (overlayText.some(t => /^upcoming$/i.test(t.trim()))) status = 'upcoming';
  else {
    for (const t of overlayText) {
      const d = parseDuration(t);
      if (d !== null) { durationSeconds = d; break; }
    }
    // Neither a LIVE/Upcoming badge nor a duration: not something playable.
    if (durationSeconds === null) return null;
  }

  const joined = metaText.join(' / ');
  const sources = lockup.contentImage && lockup.contentImage.thumbnailViewModel && lockup.contentImage.thumbnailViewModel.image && lockup.contentImage.thumbnailViewModel.image.sources;
  const thumb = Array.isArray(sources) && sources.length ? sources[sources.length - 1].url : `https://i.ytimg.com/vi/${lockup.contentId}/hqdefault.jpg`;

  return {
    id: lockup.contentId,
    title,
    status,
    durationSeconds,
    viewers: status === 'live' ? parseViewers(joined) : null,
    scheduledText: status === 'upcoming' ? (metaText.find(t => /^Scheduled for/i.test(t)) || null) : null,
    scheduledTs: status === 'upcoming' ? parseScheduled(joined) : null,
    timestamp: status === 'past' ? parseRelativeAge(joined) : null,
    thumbnail: thumb
  };
}

function itemsFromData(data) {
  return findAll(data, o => o.lockupViewModel).map(o => lockupToItem(o.lockupViewModel)).filter(Boolean);
}

function continuationToken(data) {
  const found = findAll(data, o => o.continuationItemRenderer);
  for (const o of found) {
    const cmd = o.continuationItemRenderer.continuationEndpoint && o.continuationItemRenderer.continuationEndpoint.continuationCommand;
    if (cmd && cmd.token) return cmd.token;
  }
  return null;
}

function fetchFirstPage(channel) {
  const url = channel.playlist
    ? `https://www.youtube.com/playlist?list=${channel.playlist}`
    : `https://www.youtube.com/${channel.path}/${channel.tab || 'streams'}`;
  return fetch(url, { headers: PAGE_HEADERS })
    .then(res => {
      if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
      return res.text();
    })
    .then(html => {
      const data = extractJson(html, 'var ytInitialData');
      if (!data) throw new Error('ytInitialData not found (YouTube layout changed or consent wall)');
      const version = (/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1];
      const visitorData = (/"VISITOR_DATA":"([^"]+)"/.exec(html) || [])[1];
      return { items: itemsFromData(data), token: continuationToken(data), version, visitorData };
    });
}

function fetchContinuation(token, version, visitorData) {
  // timeZone/utcOffsetMinutes: same reason as PREF tz=UTC in PAGE_HEADERS.
  const client = { clientName: 'WEB', clientVersion: version || '2.20260101.00.00', hl: 'en', gl: 'US', timeZone: 'UTC', utcOffsetMinutes: 0 };
  if (visitorData) client.visitorData = visitorData;
  return fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Origin: 'https://www.youtube.com' }, PAGE_HEADERS),
    body: JSON.stringify({ context: { client }, continuation: token })
  })
    .then(res => {
      if (!res.ok) throw new Error(`YouTube continuation HTTP ${res.status}`);
      return res.json();
    })
    .then(data => ({ items: itemsFromData(data), token: continuationToken(data) }));
}

// ---- caching (stale-on-error, deduped in-flight) ----

const cache = new Map(); // key -> { value, at, inflight }

// emptyIsFailure: a channel's finished races/highlights are never really
// empty, so an empty list means YouTube served an odd page (seen once live) -
// keep the previous list and retry on the next request instead of caching
// an empty catalog for the whole TTL. A live list can legitimately be empty.
function cached(key, ttlMs, loader, emptyIsFailure) {
  const entry = cache.get(key) || { value: null, at: 0, inflight: null };
  cache.set(key, entry);
  if (entry.value && Date.now() - entry.at < ttlMs) return Promise.resolve(entry.value);
  if (entry.inflight) return entry.inflight;
  entry.inflight = loader()
    .then(value => {
      if (emptyIsFailure && Array.isArray(value) && value.length === 0) {
        console.error(`[YouTube] ${key} came back empty, not caching it`);
        return entry.value || [];
      }
      entry.value = value;
      entry.at = Date.now();
      return value;
    })
    .catch(err => {
      console.error(`[YouTube] ${key} failed: ${err.message}`);
      // Serve the last good list rather than an empty catalog if YouTube
      // hiccups (rate limit, transient 5xx).
      return entry.value || [];
    })
    .then(value => {
      entry.inflight = null;
      return value;
    });
  return entry.inflight;
}

function withChannel(channelKey) {
  const channel = CHANNELS[channelKey];
  if (!channel) throw new Error(`Unknown YouTube channel "${channelKey}"`);
  return channel;
}

// ---- public API ----

// Live now (most-watched first), then upcoming (soonest first).
function listLive(channelKey) {
  const channel = withChannel(channelKey);
  return cached(`live:${channelKey}`, LIVE_CACHE_TTL_MS, () => fetchFirstPage(channel).then(page => {
    const live = page.items.filter(i => i.status === 'live').sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
    const upcoming = page.items.filter(i => i.status === 'upcoming').sort((a, b) => (a.scheduledTs || Infinity) - (b.scheduledTs || Infinity));
    return [...live, ...upcoming].map(i => Object.assign({ channel: channelKey }, i));
  }));
}

// Walks a channel tab (first page, then continuation pages) collecting the
// finished videos that pass `keep`, newest first.
function listPast(channelKey, cachePrefix, keep) {
  const channel = withChannel(channelKey);
  return cached(`${cachePrefix}:${channelKey}`, RACES_CACHE_TTL_MS, () => {
    const wanted = (i) => i.status === 'past' && keep(channel, i);
    return fetchFirstPage(channel).then(first => {
      const found = first.items.filter(wanted);
      const walk = (token, pagesLeft) => {
        if (!token || pagesLeft <= 0 || found.length >= TARGET_RACES) return Promise.resolve();
        return fetchContinuation(token, first.version, first.visitorData).then(page => {
          found.push(...page.items.filter(wanted));
          return walk(page.token, pagesLeft - 1);
        });
      };
      return walk(first.token, MAX_CONTINUATION_PAGES)
        // A failed extra page shouldn't throw away what was already found.
        .catch(err => console.error(`[YouTube] ${channelKey} continuation failed: ${err.message}`))
        .then(() => {
          const seen = new Set();
          return found
            .filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)))
            .map(i => Object.assign({ channel: channelKey }, i));
        });
    });
  }, true);
}

// Finished race broadcasts, newest first.
function listRaces(channelKey) {
  return listPast(channelKey, 'races', (channel, i) => channel.isRace && i.durationSeconds >= MIN_RACE_SECONDS && channel.isRace(i.title));
}

// Highlight videos (a minute or longer, so Shorts-length clips are skipped),
// newest first.
function listHighlights(channelKey) {
  return listPast(channelKey, 'highlights', (channel, i) => channel.isHighlight && i.durationSeconds >= MIN_HIGHLIGHT_SECONDS && channel.isHighlight(i.title));
}

// Looks a video up in whatever lists are already cached (the catalog is
// always requested before its items are opened); falls back to YouTube's
// public oEmbed endpoint for a video that has aged out of both.
function getItem(videoId) {
  for (const key of channelKeys()) {
    for (const prefix of ['live', 'races', 'highlights']) {
      const entry = cache.get(`${prefix}:${key}`);
      const hit = entry && entry.value && entry.value.find(i => i.id === videoId);
      if (hit) return Promise.resolve(hit);
    }
  }
  return fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => (res.ok ? res.json() : null))
    .then(j => (j ? { id: videoId, title: j.title, status: 'past', thumbnail: j.thumbnail_url, channel: null } : null))
    .catch(() => null);
}

// ---- HLS resolution (see file header) ----

const PLAYER_CLIENTS = [
  {
    id: '101', version: '1.02',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    context: { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471', hl: 'en', gl: 'US' }
  },
  {
    id: '3', version: '20.10.35',
    userAgent: 'com.google.android.youtube/20.10.35 (Linux; U; Android 14; en_US) gzip',
    context: { clientName: 'ANDROID', clientVersion: '20.10.35', osName: 'Android', osVersion: '14', platform: 'MOBILE', androidSdkVersion: 34, hl: 'en', gl: 'US' }
  },
  {
    id: '5', version: '20.10.1',
    userAgent: 'com.google.ios.youtube/20.10.1 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)',
    context: { clientName: 'IOS', clientVersion: '20.10.1', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '17.4.0.21E219', platform: 'MOBILE', hl: 'en', gl: 'US' }
  }
];

// Playlist URLs stay valid for hours; a short cache just avoids re-resolving
// when a client asks for the same video's streams twice in a row.
const HLS_CACHE_TTL_MS = 5 * 60 * 1000;
const hlsCache = new Map(); // videoId -> { value, at }

function requestPlayer(apiKey, visitorData, videoId, client) {
  const headers = {
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: 'https://www.youtube.com',
    'x-youtube-client-name': client.id,
    'x-youtube-client-version': client.version,
    'user-agent': client.userAgent
  };
  if (visitorData) headers['x-goog-visitor-id'] = visitorData;
  return fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      context: { client: client.context },
      playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } }
    })
  }).then(res => (res.ok ? res.json() : null)).catch(() => null);
}

// Highest variant in the master playlist, for the stream's quality label.
function maxHeight(masterUrl) {
  return fetch(masterUrl)
    .then(res => (res.ok ? res.text() : ''))
    .then(text => {
      if (!/^#EXTM3U/.test(text.trim())) return null;
      const heights = [...text.matchAll(/RESOLUTION=\d+x(\d+)/g)].map(m => parseInt(m[1], 10));
      return heights.length ? Math.max(...heights) : 0;
    })
    .catch(() => null);
}

// -> { url, height } or null.
function resolveHls(videoId) {
  const hit = hlsCache.get(videoId);
  if (hit && Date.now() - hit.at < HLS_CACHE_TTL_MS) return Promise.resolve(hit.value);
  return fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { headers: { 'accept-language': 'en-US,en;q=0.9', 'user-agent': USER_AGENT } })
    .then(res => (res.ok ? res.text() : ''))
    .then(html => {
      const apiKey = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1];
      const visitorData = (/"VISITOR_DATA":"([^"]+)"/.exec(html) || [])[1];
      if (!apiKey) return null;
      const tryClient = (i) => {
        if (i >= PLAYER_CLIENTS.length) return Promise.resolve(null);
        return requestPlayer(apiKey, visitorData, videoId, PLAYER_CLIENTS[i]).then(json => {
          const url = json && json.streamingData && json.streamingData.hlsManifestUrl;
          if (!url) return tryClient(i + 1);
          // Playable playlist or bust - a URL that doesn't answer with a real
          // master playlist is no use to a player.
          return maxHeight(url).then(height => (height === null ? tryClient(i + 1) : { url, height }));
        });
      };
      return tryClient(0);
    })
    .then(value => {
      if (value) {
        const now = Date.now();
        hlsCache.forEach((v, k) => { if (now - v.at >= HLS_CACHE_TTL_MS) hlsCache.delete(k); });
        hlsCache.set(videoId, { value, at: now });
      }
      return value;
    })
    .catch(err => {
      console.error(`[YouTube] HLS resolve failed for ${videoId}: ${err.message}`);
      return null;
    });
}

// Stremio stream objects: the direct HLS playlist first (plays in any
// player), then YouTube's own playback (ytId) and an "open in the YouTube
// app" link as fallbacks.
function getStreams(videoId) {
  return Promise.all([getItem(videoId), resolveHls(videoId)]).then(([item, hls]) => {
    const kind = item && item.status === 'live' ? 'Live' : item && item.status === 'upcoming' ? 'Upcoming' : 'Replay';
    const title = item ? item.title : '';
    const streams = [];
    if (hls) {
      streams.push({
        name: `YouTube ${kind}`,
        title: hls.height ? `${title}\nHLS up to ${hls.height}p` : title,
        url: hls.url,
        behaviorHints: { notWebReady: true }
      });
    }
    streams.push({ name: hls ? `YouTube ${kind} (YouTube player)` : `YouTube ${kind}`, title, ytId: videoId });
    streams.push({ name: 'Open in YouTube', title, externalUrl: `https://www.youtube.com/watch?v=${videoId}` });
    return streams;
  });
}

module.exports = { CHANNELS, channelKeys, isChannelEnabled, setChannelEnabled, settingsRevision, cleanTitle, listLive, listRaces, listHighlights, getItem, getStreams, resolveHls, parseRelativeAge, parseScheduled, parseDuration, parseViewers };
