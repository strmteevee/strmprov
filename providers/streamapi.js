// StreamAPI - thin client for the aggregator API in server.js.
//
// Doesn't scrape anything itself: calls GET /api/streams on a server running
// this same repo's `npm run serve`, which queries multiple providers in
// plain Node (no sandbox size/concurrency limits) and returns a combined
// stream list. This provider just forwards the request and passes the
// results straight through.
//
// Requires the server's URL to be configured in this provider's settings
// (Nuvio > Settings > Plugins > StreamAPI) before it can return anything.

const REQUEST_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function getServerUrl() {
  if (typeof global !== 'undefined' && global.SCRAPER_SETTINGS && global.SCRAPER_SETTINGS.serverUrl) {
    return String(global.SCRAPER_SETTINGS.serverUrl).trim().replace(/\/+$/, '');
  }
  return null;
}

function getProviderFilter() {
  if (typeof global !== 'undefined' && global.SCRAPER_SETTINGS && global.SCRAPER_SETTINGS.providers) {
    return String(global.SCRAPER_SETTINGS.providers).trim();
  }
  return '';
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[StreamAPI] getStreams tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    console.log('[StreamAPI] No server URL configured - go to Scraper Settings and set it');
    return Promise.resolve([]);
  }

  const type = mediaType === 'tv' ? 'tv' : 'movie';
  if (type === 'tv' && (!season || !episode)) {
    console.log('[StreamAPI] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  const params = new URLSearchParams({ tmdbId: String(tmdbId), type });
  if (type === 'tv') {
    params.set('season', String(season));
    params.set('episode', String(episode));
  }
  const providerFilter = getProviderFilter();
  if (providerFilter) {
    params.set('providers', providerFilter);
  }

  const url = `${serverUrl}/api/streams?${params.toString()}`;
  console.log(`[StreamAPI] Requesting: ${url}`);

  return withTimeout(fetch(url), REQUEST_TIMEOUT_MS, 'API request')
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      const streams = Array.isArray(data.streams) ? data.streams : [];
      console.log(`[StreamAPI] Server returned ${streams.length} stream(s) in ${data.totalMs || '?'}ms`);
      return streams;
    })
    .catch(err => {
      console.log(`[StreamAPI] Request failed: ${err.message}`);
      return [];
    });
}

function onSettings() {
  return Promise.resolve([
    { type: 'header', label: 'StreamAPI Configuration' },
    {
      type: 'text',
      key: 'serverUrl',
      label: 'Server URL',
      placeholder: 'http://192.168.1.50:3000',
      description: 'Base URL of a running strmprov server (`npm run serve` from this repo). Must be reachable from your device - a LAN IP only works while on the same network, so use a public/tunnel URL for remote access.'
    },
    {
      type: 'text',
      key: 'providers',
      label: 'Providers filter (optional)',
      placeholder: 'vidrock,moviebox',
      description: 'Comma-separated provider ids to query. Leave blank to query every enabled provider on the server.'
    }
  ]);
}

module.exports = { getStreams, onSettings };
