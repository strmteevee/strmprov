// MovieBox scraper for Nuvio Local Scrapers
//
// The previous moviebox.js targeted the native-app API (api3.aoneroom.com),
// which requires a per-request HMAC signature ("x-tr-signature") whose secret
// keys went stale and started returning 441 "miss token" for every request.
//
// This rewrite instead targets MovieBox's H5 (mobile web) API
// (h5-api.aoneroom.com/wefeed-h5api-bff), which a community CloudStream/API
// project (github.com/walterwhite-69/Moviebox-API) showed uses much simpler
// auth: a guest JWT handed back in the `x-user` response header of any GET
// to /home - no signing at all. Flow, confirmed working live:
//
//   1. GET  /home?host=moviebox.ph                 -> x-user header has the JWT
//   2. POST /subject/search {keyword,page,perPage}  -> candidates incl. detailPath
//   3. GET  /detail?detailPath=X                    -> canonical subjectId
//      (search results are split per-season/per-dub; /detail's subject is the
//      canonical multi-season entry, which is what /subject/play expects)
//   4. GET  /media-player/get-domain                -> current play domain (rotates)
//   5. GET  {domain}/wefeed-h5api-bff/subject/play?subjectId=&se=&ep=&detailPath=
//      with a Referer that mimics the real player page
//      -> direct MP4 sources (+ hls/dash if present)
//
// Gotcha found while testing: for movies, se/ep MUST be 0/0 - sending 1/1 (a
// reasonable-looking default) makes the API report hasResource:false even
// when the title genuinely has a resource. TV shows use real season/episode
// numbers against the single canonical (multi-season) subjectId.

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const API_BASE = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': 'https://moviebox.ph/',
  'Origin': 'https://moviebox.ph',
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};

let cachedToken = null;

function getBearerToken() {
  if (cachedToken) return Promise.resolve(cachedToken);
  return fetch(`${API_BASE}/home?host=moviebox.ph`, { headers: BASE_HEADERS })
    .then(res => {
      const xUser = res.headers.get('x-user');
      if (xUser) {
        try {
          cachedToken = JSON.parse(xUser).token || null;
        } catch (e) {}
      }
      return cachedToken;
    })
    .catch(err => {
      console.log(`[MovieBox] Failed to acquire guest token: ${err.message}`);
      return null;
    });
}

function authHeaders(token, extra) {
  return Object.assign({}, BASE_HEADERS, { 'Authorization': token ? `Bearer ${token}` : '' }, extra || {});
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    .then(res => res.json())
    .then(data => {
      const title = mediaType === 'tv' ? data.name : data.title;
      const year = (mediaType === 'tv' ? data.first_air_date : data.release_date || '').substring(0, 4);
      console.log(`[MovieBox] TMDB Info: "${title}" (${year})`);
      return { title, year };
    });
}

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    // MovieBox's search splits one multi-season show into one result row
    // PER SEASON (or season range) - "The Office S1", "The Office S9",
    // "The Office S1-S8" - all sharing the same underlying subjectId.
    // Left un-stripped, a correctly season-matched row only ever qualifies
    // for the weaker "starts with" score below (since "office s1" !==
    // "office"), while a same-named but unrelated adaptation with no season
    // suffix in its title gets the full exact-match score instead - even
    // with a year that doesn't match at all. Confirmed live: this is
    // exactly why "The Office" (2005, US) S1E1 played a different
    // same-titled adaptation entirely. Stripping the suffix first makes
    // every season-row of the right show compare equal to a bare title, so
    // the year check below can actually do its job.
    .replace(/\s+s\d+(\s*-\s*s\d+)?\s*$/i, '')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/[:\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

// Below this, the match is a loose substring hit (e.g. "Fortnite x the
// Simpsons" containing "simpsons") rather than the actual title - reject it
// instead of confidently serving the wrong content.
const MIN_MATCH_SCORE = 25;
function findBestMatch(items, mediaInfo, mediaType) {
  const wantType = mediaType === 'tv' ? 2 : 1;
  const normTarget = normalizeTitle(mediaInfo.title);
  let best = null;
  let bestScore = -1;
  for (const item of items) {
    if (item.subjectType !== wantType) continue;
    const normTitle = normalizeTitle(item.title);
    let score = 0;
    if (normTitle === normTarget) score += 50;
    else if (normTitle.startsWith(normTarget) || normTarget.startsWith(normTitle)) score += 25;
    else if (normTitle.includes(normTarget)) score += 10;
    else continue;
    const itemYear = (item.releaseDate || '').substring(0, 4);
    if (mediaInfo.year && itemYear === mediaInfo.year) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (best && bestScore < MIN_MATCH_SCORE) {
    console.log(`[MovieBox] Best candidate "${best.title}" scored ${bestScore} (below ${MIN_MATCH_SCORE}) - treating as no match`);
    return null;
  }
  return best;
}

function search(token, keyword) {
  return fetch(`${API_BASE}/subject/search`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ keyword, page: 1, perPage: 20 })
  })
    .then(res => res.json())
    .then(json => (json && json.data && json.data.items) || []);
}

function getCanonicalSubject(token, detailPath) {
  return fetch(`${API_BASE}/detail?detailPath=${encodeURIComponent(detailPath)}`, { headers: authHeaders(token) })
    .then(res => res.json())
    .then(json => (json && json.data && json.data.subject) || null);
}

function getPlayDomain(token) {
  return fetch(`${API_BASE}/media-player/get-domain`, { headers: authHeaders(token) })
    .then(res => res.json())
    .then(json => (json && json.data ? String(json.data).replace(/\/$/, '') : 'https://netfilm.world'));
}

function fetchPlayData(token, domain, subjectId, detailPath, se, ep) {
  const referer = `${domain}/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`;
  const playUrl = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${detailPath}`;
  return fetch(playUrl, { headers: authHeaders(token, { Referer: referer }) })
    .then(res => res.json())
    .then(json => (json && json.data) || null);
}

function fetchCaptions(token, subjectId, detailPath, firstStream) {
  if (!firstStream) return Promise.resolve([]);
  const format = firstStream.format || 'MP4';
  const capUrl = `${API_BASE}/subject/caption?format=${format}&id=${firstStream.id}&subjectId=${subjectId}&detailPath=${detailPath}`;
  return fetch(capUrl, { headers: authHeaders(token) })
    .then(res => res.json())
    .then(json => {
      const captions = (json && json.data && json.data.captions) || [];
      return captions
        .filter(c => c && c.url)
        .map(c => ({ url: c.url, language: c.lanName || c.lan || 'Unknown', name: c.lanName || c.lan || 'Unknown' }));
    })
    .catch(() => []);
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[MovieBox] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);

  if (mediaType === 'tv' && (!season || !episode)) {
    console.log('[MovieBox] Missing season/episode for TV lookup');
    return Promise.resolve([]);
  }

  return getTmdbInfo(tmdbId, mediaType).then(mediaInfo => {
    return getBearerToken().then(token => {
      if (!token) {
        console.log('[MovieBox] Could not acquire guest token');
        return [];
      }
      return search(token, mediaInfo.title).then(items => {
        const match = findBestMatch(items, mediaInfo, mediaType);
        if (!match) {
          console.log(`[MovieBox] No match found for "${mediaInfo.title}"`);
          return [];
        }
        console.log(`[MovieBox] Matched: "${match.title}" (${match.detailPath})`);

        return getCanonicalSubject(token, match.detailPath).then(subject => {
          const subjectId = (subject && subject.subjectId) || match.subjectId;
          const detailPath = (subject && subject.detailPath) || match.detailPath;

          return getPlayDomain(token).then(domain => {
            const se = mediaType === 'tv' ? season : 0;
            const ep = mediaType === 'tv' ? episode : 0;
            return fetchPlayData(token, domain, subjectId, detailPath, se, ep).then(playData => {
              if (!playData || !playData.hasResource || !Array.isArray(playData.streams) || playData.streams.length === 0) {
                console.log('[MovieBox] No playable resource for this title');
                return [];
              }

              return fetchCaptions(token, subjectId, detailPath, playData.streams[0]).then(subtitles => {
                const label = `${mediaInfo.title}${mediaInfo.year ? ' (' + mediaInfo.year + ')' : ''}`;
                const streams = playData.streams.map(s => ({
                  name: 'MovieBox',
                  title: `${label} - ${s.resolutions}p`,
                  url: s.url,
                  quality: `${s.resolutions}p`,
                  size: s.size ? `${(Number(s.size) / (1024 * 1024)).toFixed(0)} MB` : undefined,
                  type: 'direct',
                  headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://moviebox.ph/' },
                  subtitles,
                  provider: 'moviebox'
                }));
                console.log(`[MovieBox] Successfully processed ${streams.length} streams`);
                return streams;
              });
            });
          });
        });
      });
    });
  }).catch(err => {
    console.log(`[MovieBox] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
