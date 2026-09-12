var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/utils/extractors.js
var require_extractors = __commonJS({
  "src/utils/extractors.js"(exports2, module2) {
    var cheerio2 = require("cheerio-without-node-native");
    function unpack(packed) {
      const regex = new RegExp('eval\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*d\\s*\\).*?return\\s+p\\s*}\\s*\\(\\s*\\"(.*?)\\"\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*\\"(.*?)\\"\\.split\\(\\"\\|\\"\\)', "s");
      let match = packed.match(regex);
      if (!match) {
        const regexSq = new RegExp("eval\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*d\\s*\\).*?return\\s+p\\s*}\\s*\\(\\s*\\'(.*?)\\'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*\\'(.*?)\\'\\.split\\(\\'\\|\\'\\)", "s");
        match = packed.match(regexSq);
      }
      if (!match)
        return null;
      let p = match[1];
      const a = parseInt(match[2], 10);
      let c = parseInt(match[3], 10);
      const k = match[4].split("|");
      function e(c2) {
        return (c2 < a ? "" : e(Math.floor(c2 / a))) + (c2 % a > 35 ? String.fromCharCode(c2 % a + 29) : (c2 % a).toString(36));
      }
      while (c--) {
        if (k[c]) {
          const pattern = new RegExp("\\b" + e(c) + "\\b", "g");
          p = p.replace(pattern, k[c]);
        }
      }
      return p;
    }
    function extractVidmoly(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const m = html.match(/file:\s*["'](.*?m3u8.*?)["']/);
          if (m)
            return { url: m[1], quality: "Unknown", source: "Vidmoly" };
        } catch (e) {
        }
        return null;
      });
    }
    function extractFilemoon(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const unpacked = unpack(html);
          if (unpacked) {
            const m = unpacked.match(/file:\s*["'](.*?m3u8.*?)["']/);
            if (m)
              return { url: m[1], quality: "Unknown", source: "Filemoon" };
          }
        } catch (e) {
        }
        return null;
      });
    }
    function extractStreamhide(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url, { headers: { "Referer": url } });
          const html = yield res.text();
          const unpacked = unpack(html);
          if (unpacked) {
            const m = unpacked.match(/sources:\s*\[\s*{\s*file:\s*["'](.*?m3u8.*?)["']/);
            if (m)
              return { url: m[1], quality: "Unknown", source: "Streamhide" };
          }
        } catch (e) {
        }
        return null;
      });
    }
    function extractVoe(url) {
      return __async(this, null, function* () {
        try {
          const res = yield fetch(url);
          const html = yield res.text();
          const m = html.match(/hls':\s*'(.*?)'/);
          if (m)
            return { url: m[1], quality: "Unknown", source: "Voe" };
        } catch (e) {
        }
        return null;
      });
    }
    function extract2(url) {
      return __async(this, null, function* () {
        if (!url)
          return null;
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes("vidmoly")) {
          return yield extractVidmoly(url);
        } else if (lowerUrl.includes("filemoon") || lowerUrl.includes("abyssplayer") || lowerUrl.includes("rubystm")) {
          return yield extractFilemoon(url);
        } else if (lowerUrl.includes("streamhide") || lowerUrl.includes("cloudy.upns") || lowerUrl.includes("gdmirrorbot") || lowerUrl.includes("emturbovid")) {
          return yield extractStreamhide(url);
        } else if (lowerUrl.includes("voe.sx") || lowerUrl.includes("voe.network")) {
          return yield extractVoe(url);
        }
        return null;
      });
    }
    module2.exports = { extract: extract2 };
  }
});

// src/providers/anime-dekho.js
var cheerio = require("cheerio-without-node-native");
var BASE_URL = "https://animedekho.app";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Referer": `${BASE_URL}/`
};
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
      const mediaInfo = yield (yield fetch(tmdbUrl, { skipSizeCheck: true })).json();
      const title = mediaInfo.title || mediaInfo.name;
      if (!title)
        return [];
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(title)}`;
      const searchHtml = yield (yield fetch(searchUrl, { headers: HEADERS, skipSizeCheck: true })).text();
      const $ = cheerio.load(searchHtml);
      let itemUrl = null;
      $("ul[data-results] li article").each((_, el) => {
        if (!itemUrl) {
          const href = $(el).find("a.lnk-blk").attr("href");
          if (href)
            itemUrl = href;
        }
      });
      if (!itemUrl) {
        $("article").each((_, el) => {
          if (!itemUrl) {
            const href = $(el).find("a.lnk-blk").attr("href");
            if (href)
              itemUrl = href;
          }
        });
      }
      if (!itemUrl)
        return [];
      const animePage = yield (yield fetch(itemUrl, { headers: HEADERS, skipSizeCheck: true })).text();
      const $2 = cheerio.load(animePage);
      const bodyClass = $2("body").attr("class") || "";
      const termMatch = bodyClass.match(/(?:term|postid)-(\d+)/);
      const term = termMatch?.[1];
      if (!term)
        return [];
      const seasonItems = $2("ul.seasons-lst li");
      let targetUrl = itemUrl;
      let mediaType2 = 1;
      if (seasonItems.length > 0) {
        mediaType2 = 2;
        seasonItems.each((_, el) => {
          const seasonNum = $2(el).find("h3.title > span").text().match(/S(\d+)/)?.[1];
          const href = $2(el).find("a").attr("href");
          if (href && parseInt(seasonNum) === (season || 1)) {
            targetUrl = href;
          }
        });
      }
      const targetPage = yield (yield fetch(targetUrl, { headers: HEADERS, skipSizeCheck: true })).text();
      const $3 = cheerio.load(targetPage);
      const targetBodyClass = $3("body").attr("class") || "";
      const targetTermMatch = targetBodyClass.match(/(?:term|postid)-(\d+)/);
      const targetTerm = targetTermMatch?.[1] || term;
      const epNum = episode || 1;
      // The 11 track indices are independent lookups (each just asks "does
      // track i exist for this title"), so probing them one at a time was
      // paying their full round-trip latency 11 times over for no reason -
      // running them in parallel cuts this from ~11x that latency to ~1x.
      const iframeUrls = yield Promise.all(
        Array.from({ length: 11 }, (_, i) => {
          const iframePageUrl = `${BASE_URL}/?trdekho=${i}&trid=${targetTerm}&trtype=${mediaType2}`;
          return fetch(iframePageUrl, { headers: HEADERS, skipSizeCheck: true })
            .then(res => res.text())
            .then(html => {
              const $4 = cheerio.load(html);
              const iframeSrc = $4("iframe").attr("src");
              return (iframeSrc && iframeSrc.startsWith("http")) ? iframeSrc : null;
            })
            .catch(() => null);
        })
      );
      const streams = iframeUrls.filter(Boolean).map(iframeSrc => ({
        url: iframeSrc,
        quality: "Unknown",
        title: `AnimeDekho [S${season || 1}E${epNum}]`,
        subtitles: []
      }));
      return streams;
    } catch (e) {
      console.error("[AnimeDekho]", e);
      return [];
    }
  });
}
var { extract } = require_extractors();
function wrappedGetStreams(...args) {
  return __async(this, null, function* () {
    const streams = yield getStreams(...args);
    // Each candidate's extraction is independent of the others (a different
    // embed host per candidate - abyssplayer, rubystm, cloudy, vidmoly,
    // emturbovid, ...), but this used to await them one at a time, so the
    // total wait was the SUM of every host's latency instead of just the
    // slowest one. Running them in parallel preserves the original filtering
    // logic and result order exactly, just without the serial wait.
    const extracted = yield Promise.all(streams.map(s => {
      if (!s.url) return Promise.resolve(null);
      return Promise.resolve(extract(s.url)).then(ext => {
        if (ext) {
          return Object.assign({}, s, {
            url: ext.url,
            quality: ext.quality !== "Unknown" ? ext.quality : s.quality,
            name: "AnimeDekho",
            provider: "anime-dekho",
            headers: HEADERS
          });
        }
        if (s.url.includes(".mp4") || s.url.includes(".m3u8") || s.url.includes(".mkv") || s.url.includes(".avi") || s.url.startsWith("magnet:") || s.url.includes("/api/file/") || s.url.includes(".cloudflarestorage.com")) {
          return Object.assign({}, s, { name: "AnimeDekho", provider: "anime-dekho", headers: HEADERS });
        }
        return null;
      }).catch(() => null);
    }));
    return extracted.filter(Boolean);
  });
}
module.exports = { getStreams: wrappedGetStreams };
