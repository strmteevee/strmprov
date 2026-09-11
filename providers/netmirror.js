// NetMirror Scraper for Nuvio Local Scrapers
//
// IMPORTANT: netmirror's original target (Netflix/Prime/Hotstar/Disney+ mirrors,
// backed by the MovieBox/"aoneroom" catalog) is no longer scrapable over plain
// HTTP. The current site (net27.cc, rebranded around the "CNCVerse" family of
// mirrors) resolves titles against MovieBox's h5-api.aoneroom.com just fine
// (GET /wefeed-h5api-bff/detail?detailPath=...), but the actual play/stream
// URL fetch is deliberately stubbed out in the public site bundle:
//
//   async function O(e,t,i,r,n){return null}   // "Server 1" stream fetch
//   async function R(e){return null}            // companion lookup
//
// The site's own UI says "Server 1 won't play without the extension" - the
// real stream URLs are only ever supplied by NetMirror's proprietary browser
// extension (presumably injected client-side), not by any discoverable REST
// endpoint. "Server 2" (their own fallback for extension-less users) is just
// an iframe to peachify.top, one of the many generic vidsrc-clone aggregators
// - the same class of site listed under yflix.ws's own source list, and one
// that (like most of that ecosystem) hides its stream fetch behind a Next.js
// server action with no client-visible API.
//
// Since there's no way left to reach netmirror's actual unique catalog, this
// rewrite falls back to the same verified-working aggregator yflix.js uses
// (moviesapi.to's "vidora" API - a plain JSON endpoint gated only by a static
// header baked into moviesapi.to's own JS bundle). This means netmirror and
// yflix can return the same underlying stream when both are enabled; that's
// a real limitation of what's left to scrape, not an oversight.
//
// This file is intentionally NOT generated from src/netmirror/ - there is no
// src/netmirror/ directory. Running `node build.js` with no arguments will
// NOT touch this file (only providers with a matching src/<name>/ folder get
// regenerated), so hand edits here are safe.

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://moviesapi.to';
// Static key read out of moviesapi.to's own frontend bundle (assets/index-*.js).
const PLAYER_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const STREAM_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': API_BASE + '/',
  'Origin': API_BASE
};

function apiHeaders(referer) {
  return {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
    'Origin': API_BASE,
    'Referer': referer,
    'x-player-key': PLAYER_KEY
  };
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[NetMirror] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(err => {
      console.log(`[NetMirror] TMDB lookup failed: ${err.message}`);
      return { title: '', year: '' };
    });
}

function mapSubtitles(tracks) {
  if (!Array.isArray(tracks)) return [];
  return tracks
    .filter(t => t && t.file)
    .map(t => ({
      url: t.file,
      language: t.label || 'Unknown',
      name: t.label || 'Unknown',
      headers: STREAM_HEADERS
    }));
}

function fetchStreams(tmdbId, mediaType, season, episode, mediaInfo) {
  const path = mediaType === 'tv'
    ? `/tv/${tmdbId}/${season}/${episode}`
    : `/movie/${tmdbId}`;
  const apiUrl = `${API_BASE}/api/vidora/v1${path}`;
  const pageUrl = `${API_BASE}${path}`;

  console.log(`[NetMirror] Requesting: ${apiUrl}`);
  return fetch(apiUrl, { headers: apiHeaders(pageUrl) })
    .then(res => {
      if (!res.ok) {
        return res.json().catch(() => null).then(body => {
          const reason = body && (body.message || body.error);
          console.log(`[NetMirror] Stream request failed: ${res.status}${reason ? ' - ' + reason : ''}`);
          return [];
        });
      }
      return res.json().then(data => {
        if (!data || !data.result || !Array.isArray(data.sources) || data.sources.length === 0) {
          console.log('[NetMirror] No sources returned for this title');
          return [];
        }
        const label = mediaInfo.title
          ? `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`
          : (data.title || 'Auto Quality Stream');

        return data.sources
          .filter(s => s && s.url)
          .map((s, idx) => ({
            name: 'NetMirror',
            title: data.sources.length > 1 ? `${label} - Server ${idx + 1}` : label,
            url: s.url,
            quality: 'Auto',
            type: 'direct',
            headers: STREAM_HEADERS,
            subtitles: mapSubtitles(s.tracks),
            provider: 'netmirror'
          }));
      });
    })
    .catch(err => {
      console.log(`[NetMirror] Error fetching streams: ${err.message}`);
      return [];
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[NetMirror] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[NetMirror] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    return fetchStreams(tmdbId, mediaType, season, episode, mediaInfo).then(streams => {
      console.log(`[NetMirror] Found ${streams.length} stream(s)`);
      return streams;
    });
  }).catch(err => {
    console.log(`[NetMirror] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
