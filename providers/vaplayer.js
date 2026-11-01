// VaPlayer scraper for Nuvio Local Scrapers
//
// VaPlayer is the player behind nextgencloudfabric.com embeds. Its data API
// answers by IMDb id with ready-to-play HLS master playlists - no search,
// no page scraping, no decryption:
//
//   GET https://streamdata.vaplayer.ru/api.php?imdb={imdbId}&type=movie
//   GET https://streamdata.vaplayer.ru/api.php?imdb={imdbId}&type=tv&season={s}&episode={e}
//     -> {"status_code":"200","data":{"title","file_name","stream_urls":[...]},
//         "default_subs":[...]}
//     (an empty body when the title isn't available)
//
// Written from the endpoint the community "Streamline" plugin uses, re-checked
// by hand 2026-11-01: each stream_urls entry is a master playlist (several
// renditions, audio included) that plays without any special headers; the
// Referer below is what the site's own player sends, kept for safety.
// file_name is the original release name, which is where the quality comes
// from (the playlist itself is adaptive).

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const API_BASE = 'https://streamdata.vaplayer.ru';
const REFERER = 'https://nextgencloudfabric.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, options) {
  if (typeof AbortController === 'undefined') return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, Object.assign({}, options, { signal: controller.signal })).then(
    res => { clearTimeout(timer); return res; },
    err => { clearTimeout(timer); throw err; }
  );
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  return fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => ({
      title: mediaType === 'tv' ? data.name : data.title,
      year: ((mediaType === 'tv' ? data.first_air_date : data.release_date) || '').substring(0, 4),
      imdbId: (data.external_ids && data.external_ids.imdb_id) || data.imdb_id || null
    }))
    .catch(err => {
      console.log(`[VaPlayer] TMDB lookup failed: ${err.message}`);
      return { title: '', year: '', imdbId: null };
    });
}

function qualityFromName(name) {
  const text = String(name || '');
  if (/2160p|\b4k\b/i.test(text)) return '4K';
  const m = text.match(/(\d{3,4})p/i);
  return m ? `${m[1]}p` : 'Auto';
}

function mapSubtitles(subs) {
  if (!Array.isArray(subs)) return [];
  return subs
    .filter(s => s && s.url)
    .map(s => ({ url: s.url, language: s.lang || s.code || 'en', name: s.lang || s.code || 'Subtitle' }));
}

// Every playlist URL is fetched once before it's offered: a dead mirror
// answers 4xx or something other than a playlist.
function isPlayable(url, headers) {
  return fetchWithTimeout(url, { headers })
    .then(res => (res.ok ? res.text().then(text => /^#EXTM3U/.test(text.trim())) : false))
    .catch(() => false);
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[VaPlayer] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
  if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);

  return getTmdbInfo(tmdbId, mediaType).then(info => {
    if (!info.imdbId) {
      console.log('[VaPlayer] No IMDb id for this title');
      return [];
    }
    const url = mediaType === 'tv'
      ? `${API_BASE}/api.php?imdb=${info.imdbId}&type=tv&season=${season}&episode=${episode}`
      : `${API_BASE}/api.php?imdb=${info.imdbId}&type=movie`;
    const headers = { 'User-Agent': USER_AGENT, Referer: REFERER };

    return fetchWithTimeout(url, { headers })
      .then(res => (res.ok ? res.text() : ''))
      .then(body => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (e) { json = null; }
        const data = json && json.data;
        const urls = data && Array.isArray(data.stream_urls) ? [...new Set(data.stream_urls.filter(Boolean))] : [];
        if (!urls.length) {
          console.log('[VaPlayer] Not available');
          return [];
        }
        const quality = qualityFromName(data.file_name);
        const label = mediaType === 'tv'
          ? `${info.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
          : `${info.title}${info.year ? ` (${info.year})` : ''}`;
        const subtitles = mapSubtitles(json.default_subs);
        const playbackHeaders = { Referer: REFERER, 'User-Agent': USER_AGENT };
        const streams = urls.map((streamUrl, i) => ({
          name: `VaPlayer${urls.length > 1 ? ` ${i + 1}` : ''}`,
          title: data.file_name ? `${label}\n${String(data.file_name).split('/').pop()}` : label,
          url: streamUrl,
          quality,
          type: 'hls',
          headers: playbackHeaders,
          subtitles,
          provider: 'vaplayer'
        }));
        return Promise.all(streams.map(s => isPlayable(s.url, s.headers))).then(ok => {
          const working = streams.filter((_, i) => ok[i]);
          console.log(`[VaPlayer] ${working.length}/${streams.length} stream(s) playable`);
          return working;
        });
      });
  }).catch(err => {
    console.log(`[VaPlayer] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
