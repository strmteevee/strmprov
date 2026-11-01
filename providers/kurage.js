// Kurage scraper for Nuvio Local Scrapers (anime)
//
// kurage.live is an anime streaming site built on tRPC. Its own API returns,
// per AniList id + episode, the servers for the subbed and the dubbed
// version; each server URL is Kurage's own proxy, which answers with a plain
// seekable MP4 (or HLS) - confirmed by hand 2026-11-01 (206 video/mp4 for
// Attack on Titan episode 1, sub and dub, no special headers needed):
//
//   GET https://kurage.live/api/trpc/episodes.source,episodes.source?batch=1
//       &input={"0":{"json":{"animeId":<anilistId>,"episode":<n>,"language":"sub"}},
//               "1":{"json":{"animeId":<anilistId>,"episode":<n>,"language":"dub"}}}
//     -> [{"result":{"data":{"json":{"servers":[{"url","label","language","sourceType"}]}}}}, ...]
//
// Mapping TMDB to AniList uses the public ARM id-mapping API
// (arm.haglund.dev), which also says which TMDB season each AniList entry
// belongs to. Two cases need care:
//   - a TMDB season split over several AniList entries (Attack on Titan S3
//     part 1 and 2): entries are ordered by start date and the episode number
//     is offset by the earlier parts' episode counts (from AniList itself);
//   - a long-running show kept as one AniList entry with absolute numbering
//     (One Piece, no season in ARM): the episode becomes TMDB's absolute
//     number, counted from the earlier seasons' episode counts.
// Written from the endpoint the community Nuvio "kurage" plugin uses.

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const KURAGE_BASE = 'https://kurage.live';
const ARM_BASE = 'https://arm.haglund.dev/api/v2';
const ANILIST_GRAPHQL = 'https://graphql.anilist.co';
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

// One retry on a network-level failure ("fetch failed"): confirmed live that
// kurage.live occasionally drops a connection that succeeds moments later.
function fetchJson(url, options, retries = 1) {
  return fetchWithTimeout(url, options).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`);
    return res.json();
  }, err => {
    if (retries <= 0) throw err;
    return new Promise(resolve => setTimeout(resolve, 500)).then(() => fetchJson(url, options, retries - 1));
  });
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  return fetchJson(`${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`, { headers: { 'User-Agent': USER_AGENT } })
    .then(data => ({
      title: mediaType === 'tv' ? data.name : data.title,
      seasons: Array.isArray(data.seasons) ? data.seasons : []
    }))
    .catch(() => ({ title: '', seasons: [] }));
}

function aniListEpisodeInfo(ids) {
  const query = 'query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id episodes startDate{year month day}}}}';
  return fetchJson(ANILIST_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { ids } })
  }).then(json => ((json && json.data && json.data.Page && json.data.Page.media) || []))
    .catch(() => []);
}

function dateKey(d) {
  if (!d || !d.year) return Infinity;
  return d.year * 10000 + (d.month || 1) * 100 + (d.day || 1);
}

// -> { anilistId, episode } or null
function resolveAniList(tmdbId, mediaType, season, episode, tmdbInfo) {
  return fetchJson(`${ARM_BASE}/themoviedb?id=${tmdbId}`, { headers: { 'User-Agent': USER_AGENT } }).then(entries => {
    const list = (Array.isArray(entries) ? entries : []).filter(e => e && e.anilist);
    if (mediaType !== 'tv') {
      const movie = list.find(e => e.media === 'MOVIE');
      return movie ? { anilistId: movie.anilist, episode: 1 } : null;
    }
    const seasonNum = Number(season);
    const parts = list.filter(e => e.media !== 'MOVIE' && e['themoviedb-season'] === seasonNum);
    if (parts.length) {
      return aniListEpisodeInfo(parts.map(p => p.anilist)).then(media => {
        const byId = new Map(media.map(m => [m.id, m]));
        const ordered = parts.slice().sort((a, b) =>
          dateKey((byId.get(a.anilist) || {}).startDate) - dateKey((byId.get(b.anilist) || {}).startDate));
        let ep = Number(episode);
        for (let i = 0; i < ordered.length; i++) {
          const count = (byId.get(ordered[i].anilist) || {}).episodes;
          if (!count || ep <= count || i === ordered.length - 1) return { anilistId: ordered[i].anilist, episode: ep };
          ep -= count;
        }
        return null;
      });
    }
    // One AniList entry for the whole show, numbered absolutely.
    const whole = list.find(e => e.media === 'TV' && (e['themoviedb-season'] === null || e['themoviedb-season'] === undefined));
    if (!whole) return null;
    const before = tmdbInfo.seasons
      .filter(s => s.season_number > 0 && s.season_number < seasonNum)
      .reduce((sum, s) => sum + (s.episode_count || 0), 0);
    return { anilistId: whole.anilist, episode: before + Number(episode) };
  }).catch(err => {
    console.log(`[Kurage] Mapping failed: ${err.message}`);
    return null;
  });
}

function isPlayable(stream) {
  const headers = { Range: 'bytes=0-1024', 'User-Agent': USER_AGENT };
  return fetchWithTimeout(stream.url, { headers })
    .then(res => {
      if (!res.ok) return false;
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (stream.type === 'hls' || /mpegurl/.test(type)) return res.text().then(t => /^#EXTM3U/.test(t.trim()));
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      return !/text\/html/.test(type);
    })
    .catch(() => false);
}

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[Kurage] getStreams start tmdbId=${tmdbId} type=${mediaType} S=${season || ''} E=${episode || ''}`);
  if (mediaType === 'tv' && (!season || !episode)) return Promise.resolve([]);

  return getTmdbInfo(tmdbId, mediaType).then(info =>
    resolveAniList(tmdbId, mediaType, season, episode, info).then(target => {
      if (!target) {
        console.log('[Kurage] Not an anime known to AniList');
        return [];
      }
      console.log(`[Kurage] AniList ${target.anilistId} episode ${target.episode}`);
      const input = {
        0: { json: { animeId: target.anilistId, episode: target.episode, language: 'sub' } },
        1: { json: { animeId: target.anilistId, episode: target.episode, language: 'dub' } }
      };
      const url = `${KURAGE_BASE}/api/trpc/episodes.source,episodes.source?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
      return fetchJson(url, {
        headers: { 'User-Agent': USER_AGENT, 'trpc-accept': 'application/json', 'x-trpc-source': 'nextjs-react' }
      }).then(results => {
        const label = mediaType === 'tv'
          ? `${info.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
          : info.title;
        const streams = [];
        (Array.isArray(results) ? results : []).forEach(r => {
          const servers = (r && r.result && r.result.data && r.result.data.json && r.result.data.json.servers) || [];
          servers.forEach(server => {
            if (!server || !server.url) return;
            const lang = String(server.language || 'sub').toUpperCase();
            streams.push({
              name: `Kurage [${lang}] ${server.label || ''}`.trim(),
              title: `${label} - ${lang === 'DUB' ? 'English dub' : 'Japanese audio, English subs'}`,
              url: server.url.startsWith('/') ? `${KURAGE_BASE}${server.url}` : server.url,
              quality: 'Auto',
              type: server.sourceType === 'hls' ? 'hls' : 'direct',
              provider: 'kurage'
            });
          });
        });
        return Promise.all(streams.map(isPlayable)).then(ok => {
          const working = streams.filter((_, i) => ok[i]);
          console.log(`[Kurage] ${working.length}/${streams.length} stream(s) playable`);
          return working;
        });
      });
    })
  ).catch(err => {
    console.log(`[Kurage] getStreams failed: ${err.message}`);
    return [];
  });
}

module.exports = { getStreams };
