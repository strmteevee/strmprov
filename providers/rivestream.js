// RiveStream scraper for Nuvio Local Scrapers
//
// RiveStream (rivestream.app / www.rivestream.app) is a Next.js streaming
// site whose source is partly open (github.com/BytesGaming/rive). Its player
// calls a "scrapper" backend directly by TMDB id:
//
//   GET https://scrapper.rivestream.app/api/providers
//     -> {"data": ["apex","pulse","solstice","quasar","horizon",
//                  "primevids","asiacloud","citadel","guru"]}
//   GET https://scrapper.rivestream.app/api/provider?provider={name}&id={tmdbId}
//     (+ &season=&episode= for TV)
//     -> {"data": {"sources": [{quality,url,source,format}], "captions": [...]}}
//
// No auth/session/signing of any kind is needed - this is a plain public
// JSON API discovered by reading the site's own Next.js bundle. In testing,
// only "citadel" and "primevids" reliably returned sources (the rest replied
// {"data":null} or an error for every title tried), but all services are
// queried in parallel here since that costs nothing and some may only carry
// specific titles. "asiacloud" is excluded: it consistently takes ~15s to
// respond (vs <1s for every other service) and has never once returned a
// usable source in testing, so it was just adding 15s of dead latency to
// every single call (Promise.all waits on the slowest member).

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://scrapper.rivestream.app';
const SERVICES = ['citadel', 'primevids', 'apex', 'pulse', 'solstice', 'quasar', 'horizon', 'guru'];
const SERVICE_TIMEOUT_MS = 10000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return withTimeout(fetch(url, { headers: { 'User-Agent': USER_AGENT } }), SERVICE_TIMEOUT_MS)
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[RiveStream] TMDB Info: "${title}" (${year})`);
      return { title, year };
    })
    .catch(err => {
      console.log(`[RiveStream] TMDB lookup failed: ${err.message}`);
      return { title: '', year: '' };
    });
}

function mapSubtitles(captions) {
  if (!Array.isArray(captions)) return [];
  return captions
    .filter(c => c && c.file)
    .map(c => ({
      url: c.file,
      language: c.language || c.label || 'Unknown',
      name: c.label || c.language || 'Unknown'
    }));
}

// Service labels vary: "720p | English", "1080p", "tcloud", "dcloud", etc.
function parseQualityLabel(label) {
  if (!label) return { quality: 'Auto', language: null };
  const parts = String(label).split('|').map(p => p.trim());
  const resMatch = parts[0].match(/\d{3,4}p/i);
  return {
    quality: resMatch ? resMatch[0] : 'Auto',
    language: parts[1] || null
  };
}

function fetchFromService(service, tmdbId, mediaType, season, episode, mediaInfo) {
  let apiUrl = `${API_BASE}/api/provider?provider=${service}&id=${tmdbId}`;
  if (mediaType === 'tv') {
    apiUrl += `&season=${season}&episode=${episode}`;
  }

  return withTimeout(fetch(apiUrl, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } }), SERVICE_TIMEOUT_MS)
    .then(res => {
      if (!res.ok) return [];
      return res.json();
    })
    .then(body => {
      const data = body && body.data;
      if (!data || !Array.isArray(data.sources) || data.sources.length === 0) {
        return [];
      }
      const subtitles = mapSubtitles(data.captions);
      const label = mediaInfo.title
        ? `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`
        : 'Auto Quality Stream';

      return data.sources
        .filter(s => s && s.url)
        .map(s => {
          const { quality, language } = parseQualityLabel(s.quality);
          const sourceName = s.source || service;
          return {
            name: `RiveStream - ${sourceName}`,
            title: language ? `${label} - ${language}` : label,
            url: s.url,
            quality,
            type: 'direct',
            headers: { 'User-Agent': USER_AGENT },
            subtitles,
            provider: 'rivestream'
          };
        });
    })
    .catch(err => {
      console.log(`[RiveStream] ${service} failed: ${err.message}`);
      return [];
    });
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[RiveStream] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[RiveStream] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    return Promise.all(
      SERVICES.map(service => fetchFromService(service, tmdbId, mediaType, season, episode, mediaInfo))
    ).then(results => {
      const streams = results.flat();
      console.log(`[RiveStream] Found ${streams.length} stream(s) across ${SERVICES.length} services`);
      return streams;
    });
  }).catch(err => {
    console.log(`[RiveStream] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
