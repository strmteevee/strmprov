/**
 * hdhub4u - Built from src/hdhub4u/
 * Generated: 2026-09-11T16:50:57.161Z
 */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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

// src/hdhub4u/index.js
var import_cheerio_without_node_native2 = __toESM(require("cheerio-without-node-native"));

// src/hdhub4u/constants.js
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";
var MAIN_URL = "https://new6.hdhub4u.fo";
var DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
var DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1e3;
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Cookie": "xla=s4t",
  "Referer": `${MAIN_URL}/`
};
function updateMainUrl(url) {
  MAIN_URL = url;
  HEADERS.Referer = `${url}/`;
}

// src/hdhub4u/utils.js
var domainCacheTimestamp = 0;
function fetchWithTimeout(url, options) {
  return fetch(url, options);
}
function formatBytes(bytes) {
  if (!bytes || bytes === 0)
    return "Unknown";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
function extractServerName(source) {
  if (!source)
    return "Unknown";
  if (source.startsWith("HubCloud")) {
    const serverMatch = source.match(/HubCloud(?:\s*-\s*([^[\]]+))?/);
    return serverMatch ? serverMatch[1] || "Download" : "HubCloud";
  }
  if (source.startsWith("Pixeldrain"))
    return "Pixeldrain";
  if (source.startsWith("StreamTape"))
    return "StreamTape";
  if (source.startsWith("HubCdn"))
    return "HubCdn";
  if (source.startsWith("HbLinks"))
    return "HbLinks";
  if (source.startsWith("Hubstream"))
    return "Hubstream";
  return source.replace(/^www\./, "").split(".")[0];
}
function rot13(value) {
  return value.replace(/[a-zA-Z]/g, function(c) {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}
var BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function atob(value) {
  if (!value)
    return "";
  let input = String(value).replace(/=+$/, "");
  let output = "";
  let bc = 0, bs, buffer, idx = 0;
  while (buffer = input.charAt(idx++)) {
    buffer = BASE64_CHARS.indexOf(buffer);
    if (~buffer) {
      bs = bc % 4 ? bs * 64 + buffer : buffer;
      if (bc++ % 4) {
        output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
      }
    }
  }
  return output;
}
function cleanTitle(title) {
  let name = title.replace(/\.[a-zA-Z0-9]{2,4}$/, "");
  const normalized = name.replace(/WEB[-_. ]?DL/gi, "WEB-DL").replace(/WEB[-_. ]?RIP/gi, "WEBRIP").replace(/H[ .]?265/gi, "H265").replace(/H[ .]?264/gi, "H264").replace(/DDP[ .]?([0-9]\.[0-9])/gi, "DDP$1");
  const parts = normalized.split(/[\s_.]/);
  const sourceTags = /* @__PURE__ */ new Set(["WEB-DL", "WEBRIP", "BLURAY", "HDRIP", "DVDRIP", "HDTV", "CAM", "TS", "BRRIP", "BDRIP"]);
  const codecTags = /* @__PURE__ */ new Set(["H264", "H265", "X264", "X265", "HEVC", "AVC"]);
  const audioTags = ["AAC", "AC3", "DTS", "MP3", "FLAC", "DD", "DDP", "EAC3"];
  const audioExtras = /* @__PURE__ */ new Set(["ATMOS"]);
  const hdrTags = /* @__PURE__ */ new Set(["SDR", "HDR", "HDR10", "HDR10+", "DV", "DOLBYVISION"]);
  const filtered = parts.map((part) => {
    const p = part.toUpperCase();
    if (sourceTags.has(p))
      return p;
    if (codecTags.has(p))
      return p;
    if (audioTags.some((tag) => p.startsWith(tag)))
      return p;
    if (audioExtras.has(p))
      return p;
    if (hdrTags.has(p))
      return p === "DOLBYVISION" || p === "DV" ? "DOLBYVISION" : p;
    if (p === "NF" || p === "CR")
      return p;
    return null;
  }).filter(Boolean);
  return [...new Set(filtered)].join(" ");
}
function fetchAndUpdateDomain() {
  return __async(this, null, function* () {
    const now = Date.now();
    if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL)
      return;
    console.log("[HDHub4u] Fetching latest domain...");
    try {
      const response = yield fetchWithTimeout(DOMAINS_URL, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
      if (response.ok) {
        const data = yield response.json();
        if (data && data.HDHUB4u) {
          const newDomain = data.HDHUB4u;
          if (newDomain !== MAIN_URL) {
            console.log(`[HDHub4u] Updating domain from ${MAIN_URL} to ${newDomain}`);
            updateMainUrl(newDomain);
            domainCacheTimestamp = now;
          }
        }
      }
    } catch (error) {
      console.error(`[HDHub4u] Failed to fetch latest domains: ${error.message}`);
    }
  });
}
function getCurrentDomain() {
  return __async(this, null, function* () {
    yield fetchAndUpdateDomain();
    return MAIN_URL;
  });
}
function normalizeTitle(title) {
  if (!title)
    return "";
  return title.toLowerCase().replace(/\b(the|a|an)\b/g, "").replace(/[:\-_]/g, " ").replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}
function calculateTitleSimilarity(title1, title2) {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);
  if (norm1 === norm2)
    return 1;
  const words1 = norm1.split(/\s+/).filter((w) => w.length > 0);
  const words2 = norm2.split(/\s+/).filter((w) => w.length > 0);
  if (words1.length === 0 || words2.length === 0)
    return 0;
  const set2 = new Set(words2);
  const matchedCount = words1.filter((w) => set2.has(w)).length;
  let score = matchedCount / words1.length;
  if (matchedCount === words1.length) {
    score += 0.3;
  }
  const extraWordsCount = words2.length - matchedCount;
  score -= Math.min(0.2, extraWordsCount * 0.01);
  return score;
}
// HDHub4u often has MULTIPLE separate posts for the exact same title+year -
// a full "1080p 720p 480p Dual Audio" post alongside minimal single-quality
// ones (e.g. "480p BluRay 390MB"). The scoring below penalizes a title for
// each extra word it has over the search query, which - confirmed live for
// Guardians of the Galaxy (2014) - means a bare-bones post can outscore a
// fuller one purely for having fewer words, even though the fuller post is
// the more useful (and, live, the only actually working) one. Rather than
// try to perfectly re-tune that heuristic, returning every plausible match
// instead of just the top one lets getStreams try several posts and merge
// whatever links they produce, so one low-effort or dead post can no longer
// wipe out everything for a title that has better posts available too.
function findTitleMatches(mediaInfo, searchResults, mediaType, season) {
  if (!searchResults || searchResults.length === 0)
    return [];
  const scored = [];
  for (const result of searchResults) {
    let score = calculateTitleSimilarity(mediaInfo.title, result.title);
    if (score <= 0)
      continue;
    if (mediaInfo.year && result.year) {
      const yearDiff = Math.abs(mediaInfo.year - result.year);
      if (yearDiff === 0)
        score += 0.2;
      else if (yearDiff <= 1)
        score += 0.1;
      else if (yearDiff > 5)
        score -= 0.3;
    }
    if (mediaType === "tv" && season) {
      const titleLower = result.title.toLowerCase();
      const seasonPatterns = [
        `season ${season}`,
        `s${season}`,
        `season ${season.toString().padStart(2, "0")}`,
        `s${season.toString().padStart(2, "0")}`
      ];
      const hasSeason = seasonPatterns.some((p) => titleLower.includes(p));
      const otherSeasonMatch = titleLower.match(/season\s*(\d+)|s(\d+)/i);
      if (otherSeasonMatch) {
        const foundSeason = parseInt(otherSeasonMatch[1] || otherSeasonMatch[2]);
        if (foundSeason !== season) {
          score -= 0.8;
        }
      }
      if (hasSeason)
        score += 0.5;
      else
        score -= 0.3;
    }
    if (result.title.toLowerCase().includes("2160p") || result.title.toLowerCase().includes("4k")) {
      score += 0.05;
    }
    if (score > 0.3) {
      scored.push({ result, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 0) {
    console.log(`[HDHub4u] Title matches: ${scored.map((s) => `"${s.result.title}" (${s.score.toFixed(2)})`).join(", ")}`);
  }
  return scored.map((s) => s.result);
}
function getTMDBDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var _a;
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const response = yield fetchWithTimeout(url, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok)
      throw new Error(`TMDB API error: ${response.status}`);
    const data = yield response.json();
    const title = mediaType === "tv" ? data.name : data.title;
    const releaseDate = mediaType === "tv" ? data.first_air_date : data.release_date;
    const year = releaseDate ? parseInt(releaseDate.split("-")[0]) : null;
    return { title, year, imdbId: ((_a = data.external_ids) == null ? void 0 : _a.imdb_id) || null };
  });
}

// src/hdhub4u/extractors.js
var import_cheerio_without_node_native = __toESM(require("cheerio-without-node-native"));
var import_crypto_js = __toESM(require("crypto-js"));
function getRedirectLinks(url) {
  return __async(this, null, function* () {
    try {
      const response = yield fetchWithTimeout(url, { headers: HEADERS });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const doc = yield response.text();
      const regex = /s\s*\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]|ck\s*\(\s*['"]_wp_http_\d+['"]\s*,\s*['"]([^'"]+)['"]/g;
      let combinedString = "";
      let match;
      while ((match = regex.exec(doc)) !== null) {
        const extractedValue = match[1] || match[2];
        if (extractedValue)
          combinedString += extractedValue;
      }
      if (!combinedString) {
        const redirectMatch = doc.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (redirectMatch && redirectMatch[1]) {
          const newUrl = redirectMatch[1];
          if (newUrl !== url && !newUrl.includes(url)) {
            return yield getRedirectLinks(newUrl);
          }
        }
        return null;
      }
      const decodedString = atob(rot13(atob(atob(combinedString))));
      const jsonObject = JSON.parse(decodedString);
      const encodedUrl = atob(jsonObject.o || "").trim();
      if (encodedUrl)
        return encodedUrl;
      const data = atob(jsonObject.data || "").trim();
      const wpHttp = (jsonObject.blog_url || "").trim();
      if (wpHttp && data) {
        const directLinkResponse = yield fetchWithTimeout(`${wpHttp}?re=${data}`, { headers: HEADERS });
        const html = yield directLinkResponse.text();
        const $ = import_cheerio_without_node_native.default.load(html);
        return ($("body").text() || html).trim();
      }
      return null;
    } catch (e) {
      return null;
    }
  });
}
function vidStackExtractor(url) {
  return __async(this, null, function* () {
    var _a, _b, _c;
    try {
      const hash = url.split("#").pop().split("/").pop();
      const baseUrl = new URL(url).origin;
      const apiUrl = `${baseUrl}/api/v1/video?id=${hash}`;
      const response = yield fetchWithTimeout(apiUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: url }) });
      const encoded = (yield response.text()).trim();
      const key = import_crypto_js.default.enc.Utf8.parse("kiemtienmua911ca");
      const ivs = ["1234567890oiuytr", "0123456789abcdef"];
      for (const ivStr of ivs) {
        try {
          const iv = import_crypto_js.default.enc.Utf8.parse(ivStr);
          const decrypted = import_crypto_js.default.AES.decrypt(
            { ciphertext: import_crypto_js.default.enc.Hex.parse(encoded) },
            key,
            { iv, mode: import_crypto_js.default.mode.CBC, padding: import_crypto_js.default.pad.Pkcs7 }
          );
          const decryptedText = decrypted.toString(import_crypto_js.default.enc.Utf8);
          if (decryptedText && decryptedText.includes("source")) {
            const m3u8 = (_b = (_a = decryptedText.match(/"source":"(.*?)"/)) == null ? void 0 : _a[1]) == null ? void 0 : _b.replace(/\\/g, "");
            const subtitles = [];
            const subtitleSection = (_c = decryptedText.match(/"subtitle":\{(.*?)\}/)) == null ? void 0 : _c[1];
            if (subtitleSection) {
              const subtitlePattern = /"([^"]+)":\s*"([^"]+)"/g;
              let subMatch;
              while ((subMatch = subtitlePattern.exec(subtitleSection)) !== null) {
                const lang = subMatch[1];
                const subPath = subMatch[2].split("#")[0].replace(/\\/g, "");
                if (subPath) {
                  subtitles.push({
                    language: lang,
                    url: subPath.startsWith("http") ? subPath : `${baseUrl}${subPath}`
                  });
                }
              }
            }
            if (m3u8) {
              return [{
                source: "Vidstack Hubstream",
                quality: "M3U8",
                url: m3u8.replace("https:", "http:"),
                headers: {
                  "Referer": url,
                  "Origin": url.split("/").pop()
                },
                subtitles
              }];
            }
          }
        } catch (e) {
        }
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}
function hbLinksExtractor(url) {
  return __async(this, null, function* () {
    try {
      const response = yield fetchWithTimeout(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: url }) });
      const data = yield response.text();
      const $ = import_cheerio_without_node_native.default.load(data);
      const links = $("h3 a, h5 a, div.entry-content p a").map((i, el) => $(el).attr("href")).get();
      const results = yield Promise.all(links.map((l) => loadExtractor(l, url)));
      return results.flat().map((link) => __spreadProps(__spreadValues({}, link), {
        source: `${link.source} Hblinks`
      }));
    } catch (e) {
      return [];
    }
  });
}
function pixelDrainExtractor(link) {
  return __async(this, null, function* () {
    var _a;
    try {
      const urlObj = new URL(link);
      const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      const fileId = ((_a = link.match(/(?:file|u)\/([A-Za-z0-9]+)/)) == null ? void 0 : _a[1]) || link.split("/").pop();
      if (!fileId)
        return [{ source: "Pixeldrain", quality: 0, url: link }];
      const finalUrl = link.includes("?download") ? link : `${baseUrl}/api/file/${fileId}?download`;
      return [{ source: "Pixeldrain", quality: 0, url: finalUrl }];
    } catch (e) {
      return [{ source: "Pixeldrain", quality: 0, url: link }];
    }
  });
}
function streamTapeExtractor(link) {
  return __async(this, null, function* () {
    var _a, _b, _c, _d;
    try {
      const url = new URL(link);
      url.hostname = "streamtape.com";
      const res = yield fetchWithTimeout(url.toString(), { headers: HEADERS });
      const data = yield res.text();
      let videoSrc = (_c = (_b = (_a = data.match(/document\.getElementById\('videolink'\)\.innerHTML = (.*?);/)) == null ? void 0 : _a[1]) == null ? void 0 : _b.match(/'(\/\/streamtape\.com\/get_video[^']+)'/)) == null ? void 0 : _c[1];
      if (!videoSrc) {
        videoSrc = (_d = data.match(/'(\/\/streamtape\.com\/get_video[^']+)'/)) == null ? void 0 : _d[1];
      }
      return videoSrc ? [{ source: "StreamTape", quality: 720, url: "https:" + videoSrc }] : [];
    } catch (e) {
      return [];
    }
  });
}
function hubCloudExtractor(url, referer) {
  return __async(this, null, function* () {
    var _a;
    try {
      let currentUrl = url.replace("hubcloud.ink", "hubcloud.dad");
      const pageResponse = yield fetchWithTimeout(currentUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
      let pageData = yield pageResponse.text();
      let finalUrl = currentUrl;
      if (!currentUrl.includes("hubcloud.php")) {
        let nextHref = "";
        const $first = import_cheerio_without_node_native.default.load(pageData);
        const downloadBtn = $first("#download");
        if (downloadBtn.length) {
          nextHref = downloadBtn.attr("href");
        } else {
          const scriptUrlMatch = pageData.match(/var url = '([^']*)'/);
          if (scriptUrlMatch)
            nextHref = scriptUrlMatch[1];
        }
        if (nextHref) {
          if (!nextHref.startsWith("http")) {
            const urlObj = new URL(currentUrl);
            nextHref = `${urlObj.protocol}//${urlObj.hostname}/${nextHref.replace(/^\//, "")}`;
          }
          finalUrl = nextHref;
          const secondResponse = yield fetchWithTimeout(finalUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: currentUrl }) });
          pageData = yield secondResponse.text();
        }
      }
      const $ = import_cheerio_without_node_native.default.load(pageData);
      const size = $("i#size").text().trim();
      const header = $("div.card-header").text().trim();
      const qualityStr = (_a = header.match(/(\d{3,4})[pP]/)) == null ? void 0 : _a[1];
      const quality = qualityStr ? parseInt(qualityStr) : 1080;
      const headerDetails = cleanTitle(header);
      const labelExtras = (headerDetails ? `[${headerDetails}]` : "") + (size ? `[${size}]` : "");
      const sizeInBytes = (() => {
        const sizeMatch = size.match(/([\d.]+)\s*(GB|MB|KB)/i);
        if (!sizeMatch)
          return 0;
        const multipliers = { GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 };
        return parseFloat(sizeMatch[1]) * (multipliers[sizeMatch[2].toUpperCase()] || 0);
      })();
      const links = [];
      const elements = $("a.btn").get();
      const perButton = yield Promise.all(elements.map((element) => __async(this, null, function* () {
        const link = $(element).attr("href");
        const text = $(element).text().toLowerCase();
        const fileName = header || headerDetails || "Unknown";
        if (text.includes("download file") || text.includes("fsl server") || text.includes("s3 server") || text.includes("fslv2") || text.includes("mega server") || link && link.includes("r2.dev")) {
          let label = "HubCloud";
          if (link && link.includes("r2.dev"))
            label = "Direct R2";
          else if (link && link.includes("workers.dev"))
            label = "ZipDisk Server";
          else if (text.includes("fsl server"))
            label = "HubCloud - FSL";
          else if (text.includes("s3 server"))
            label = "HubCloud - S3";
          else if (text.includes("fslv2"))
            label = "HubCloud - FSLv2";
          else if (text.includes("mega server"))
            label = "HubCloud - Mega";
          return [{ source: `${label} ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName }];
        } else if (text.includes("buzzserver")) {
          try {
            const buzzResp = yield fetchWithTimeout(`${link}/download`, { method: "GET", headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: link }), redirect: "manual" });
            let dlink = buzzResp.headers.get("hx-redirect") || buzzResp.headers.get("HX-Redirect");
            if (!dlink && buzzResp.url && buzzResp.url !== `${link}/download`) {
              dlink = buzzResp.url;
            }
            if (dlink) {
              return [{ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: dlink, size: sizeInBytes, fileName }];
            }
            return [];
          } catch (e) {
            return [];
          }
        } else if (text.includes("10gbps") || link && link.includes("hubcloud.cx")) {
          // Both button variants need their redirect chain walked to reach a
          // real file - "10Gbps" buttons (gpdl./pixel.hubcloud.ist) used to
          // redirect straight to a ?link=<real url> location in one hop, but
          // confirmed live that they now take an extra hop first through a
          // *.workers.dev gateway (still just ?id=..., no "link=" yet) before
          // finally landing on gamerxyt.com/dl.php?link=<real url> - the old
          // single-hop check left the URL on that intermediate gateway, which
          // serves an HTML "please wait" page instead of video. Walking the
          // chain instead of assuming a fixed hop count survives that kind of
          // change. hubcloud.cx links, previously assumed to already be a
          // final target needing no resolution, turned out on the same live
          // check to dead-end at a Telegram bot deep link (t.me/...) instead
          // of any HTTP file - there's nothing playable to extract from those,
          // so unlike the 10Gbps case, finding no "link=" here means dropping
          // the button entirely rather than falling back to a broken URL.
          let targetUrl = null;
          try {
            let currentLink = link;
            for (let hop = 0; hop < 5 && currentLink; hop++) {
              const resp = yield fetchWithTimeout(currentLink, { method: "GET", redirect: "manual" });
              const loc = resp.headers.get("location");
              if (!loc)
                break;
              if (loc.includes("link=")) {
                targetUrl = loc.substring(loc.indexOf("link=") + 5);
                break;
              }
              currentLink = loc;
            }
          } catch (e) {
          }
          if (!targetUrl)
            return [];
          return [{ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: targetUrl, size: sizeInBytes, fileName }];
        } else if (text.includes("zipdisk") || link && link.includes("workers.dev")) {
          return [{ source: `ZipDisk Server ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName }];
        } else if (link && link.includes("pixeldra")) {
          const results = yield pixelDrainExtractor(link);
          return results.map((l) => __spreadProps(__spreadValues({}, l), { source: `${l.source} ${labelExtras}`, size: sizeInBytes, fileName }));
        } else if (link && !link.includes("magnet:") && link.startsWith("http")) {
          const extracted = yield loadExtractor(link, finalUrl);
          return extracted.map((l) => __spreadProps(__spreadValues({}, l), { quality: l.quality || quality }));
        }
        return [];
      })));
      links.push(...perButton.flat());
      return links;
    } catch (e) {
      return [];
    }
  });
}
function hubCdnExtractor(url, referer) {
  return __async(this, null, function* () {
    try {
      const response = yield fetchWithTimeout(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
      const data = yield response.text();
      const $ = import_cheerio_without_node_native.default.load(data);
      let scriptContent = "";
      $("script").each((i, el) => {
        const html = $(el).html();
        if (html && html.includes("reurl")) {
          scriptContent = html;
        }
      });
      if (scriptContent) {
        const match = scriptContent.match(/reurl\s*=\s*["']([^"']+)["']/);
        if (match && match[1]) {
          const reurlVal = match[1];
          if (reurlVal.includes("?r=")) {
            const queryPart = reurlVal.split("?r=").pop();
            try {
              const decoded = atob(queryPart);
              const m3u8Link = decoded.substring(decoded.lastIndexOf("link=") + 5);
              if (m3u8Link && m3u8Link.startsWith("http")) {
                return [{ source: "HubCdn", quality: 1080, url: m3u8Link }];
              }
            } catch (e) {
            }
          } else if (reurlVal.includes("link=")) {
            const m3u8Link = reurlVal.split("link=").pop();
            if (m3u8Link && m3u8Link.startsWith("http")) {
              return [{ source: "HubCdn", quality: 1080, url: m3u8Link }];
            }
          } else if (reurlVal.startsWith("http")) {
            return [{ source: "HubCdn", quality: 1080, url: reurlVal }];
          }
        }
      }
      const encodedMatch = data.match(/r=([A-Za-z0-9+/=]+)/);
      if (encodedMatch && encodedMatch[1]) {
        try {
          const decoded = atob(encodedMatch[1]);
          const m3u8Link = decoded.substring(decoded.lastIndexOf("link=") + 5);
          if (m3u8Link && m3u8Link.startsWith("http")) {
            return [{ source: "HubCdn", quality: 1080, url: m3u8Link }];
          }
        } catch (e) {
        }
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}
function loadExtractor(_0) {
  return __async(this, arguments, function* (url, referer = MAIN_URL) {
    try {
      const hostname = new URL(url).hostname;
      const isRedirect = url.includes("?id=") || hostname.includes("techyboy4u") || hostname.includes("gadgetsweb.xyz") || hostname.includes("cryptoinsights.site") || hostname.includes("bloggingvector") || hostname.includes("ampproject.org");
      if (isRedirect) {
        const finalLink = yield getRedirectLinks(url);
        if (finalLink && finalLink !== url)
          return yield loadExtractor(finalLink, url);
        return [];
      }
      if (hostname.includes("hubcloud"))
        return yield hubCloudExtractor(url, referer);
      if (hostname.includes("hubcdn"))
        return yield hubCdnExtractor(url, referer);
      if (hostname.includes("hblinks") || hostname.includes("hubstream.dad"))
        return yield hbLinksExtractor(url);
      if (hostname.includes("hubstream") || hostname.includes("vidstack"))
        return yield vidStackExtractor(url);
      if (hostname.includes("pixeldrain"))
        return yield pixelDrainExtractor(url);
      if (hostname.includes("streamtape"))
        return yield streamTapeExtractor(url);
      if (hostname.includes("hdstream4u"))
        return [{ source: "HdStream4u", quality: 1080, url }];
      if (hostname.includes("hubdrive")) {
        const res = yield fetchWithTimeout(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
        const data = yield res.text();
        const href = import_cheerio_without_node_native.default.load(data)(".btn.btn-primary.btn-user.btn-success1.m-1").attr("href");
        if (href)
          return yield loadExtractor(href, url);
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}

// src/hdhub4u/index.js
function search(query) {
  return __async(this, null, function* () {
    const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const searchUrl = `https://search.hdhub4u.glass/collections/post/documents/search?q=${encodeURIComponent(query)}&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=15&highlight_fields=none&use_cache=true&page=1&analytics_tag=${today}`;
    const response = yield fetchWithTimeout(searchUrl, { headers: HEADERS });
    const data = yield response.json();
    if (!data || !data.hits)
      return [];
    return data.hits.map((hit) => {
      const doc = hit.document;
      const title = doc.post_title;
      const yearMatch = title.match(/\((\d{4})\)|\b(\d{4})\b/);
      const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2]) : null;
      let url = doc.permalink;
      if (url && url.startsWith("/")) {
        url = `${MAIN_URL}${url}`;
      }
      return {
        title,
        url,
        poster: doc.post_thumbnail,
        year
      };
    });
  });
}
function getDownloadLinks(mediaUrl) {
  return __async(this, null, function* () {
    const domain = yield getCurrentDomain();
    if (mediaUrl.includes("hdhub4u.")) {
      try {
        const urlObj = new URL(mediaUrl);
        const domainObj = new URL(domain);
        urlObj.hostname = domainObj.hostname;
        mediaUrl = urlObj.toString();
      } catch (e) {
      }
    }
    const response = yield fetchWithTimeout(mediaUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: `${domain}/` }) });
    const data = yield response.text();
    const $ = import_cheerio_without_node_native2.default.load(data);
    const typeRaw = $("h1.page-title span").text();
    const isMovie = typeRaw.toLowerCase().includes("movie");
    if (isMovie) {
      const qualityLinks = $("h3 a, h4 a").filter((i, el) => $(el).text().match(/480|720|1080|2160|4K/i));
      const bodyLinks = $(".page-body > div a").filter((i, el) => {
        const href = $(el).attr("href");
        return href && (href.includes("hdstream4u") || href.includes("hubstream"));
      });
      const initialLinks = [.../* @__PURE__ */ new Set([
        ...qualityLinks.map((i, el) => $(el).attr("href")).get(),
        ...bodyLinks.map((i, el) => $(el).attr("href")).get()
      ])];
      const results = yield Promise.all(initialLinks.map((url) => loadExtractor(url, mediaUrl)));
      const allFinalLinks = results.flat();
      const seenUrls = /* @__PURE__ */ new Set();
      const uniqueFinalLinks = allFinalLinks.filter((link) => {
        var _a;
        if (!link.url || link.url.includes(".zip") || ((_a = link.name) == null ? void 0 : _a.toLowerCase().includes(".zip")))
          return false;
        if (seenUrls.has(link.url))
          return false;
        seenUrls.add(link.url);
        return true;
      });
      return { finalLinks: uniqueFinalLinks, isMovie };
    } else {
      const episodeLinksMap = /* @__PURE__ */ new Map();
      const directLinkBlocks = [];
      $("h3, h4").each((i, element) => {
        const $el = $(element);
        const text = $el.text();
        const anchors = $el.find("a");
        const links = anchors.map((i2, a) => $(a).attr("href")).get();
        const isDirectLinkBlock = anchors.get().some((a) => $(a).text().match(/1080|720|4K|2160/i));
        if (isDirectLinkBlock) {
          directLinkBlocks.push(...links);
          return;
        }
        const episodeMatch = text.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
        if (episodeMatch) {
          const epNum = parseInt(episodeMatch[1] || episodeMatch[2]);
          if (!episodeLinksMap.has(epNum))
            episodeLinksMap.set(epNum, []);
          episodeLinksMap.get(epNum).push(...links);
          let nextElement = $el.next();
          while (nextElement.length && nextElement.get(0).tagName !== "hr") {
            const siblingLinks = nextElement.find("a[href]").map((i2, a) => $(a).attr("href")).get();
            episodeLinksMap.get(epNum).push(...siblingLinks);
            nextElement = nextElement.next();
          }
        }
      });
      if (directLinkBlocks.length > 0) {
        yield Promise.all(directLinkBlocks.map((blockUrl) => __async(this, null, function* () {
          try {
            const resolvedUrl = yield getRedirectLinks(blockUrl);
            if (!resolvedUrl)
              return;
            const blockRes = yield fetchWithTimeout(resolvedUrl, { headers: HEADERS });
            const blockData = yield blockRes.text();
            const $$ = import_cheerio_without_node_native2.default.load(blockData);
            $$("h5 a, h4 a, h3 a").each((i, el) => {
              const linkText = $$(el).text();
              const linkHref = $$(el).attr("href");
              const epMatch = linkText.match(/Episode\s*(\d+)/i);
              if (epMatch && linkHref) {
                const epNum = parseInt(epMatch[1]);
                if (!episodeLinksMap.has(epNum))
                  episodeLinksMap.set(epNum, []);
                episodeLinksMap.get(epNum).push(linkHref);
              }
            });
          } catch (e) {
          }
        })));
      }
      const initialLinks = [];
      episodeLinksMap.forEach((links, epNum) => {
        const uniqueLinks = [...new Set(links)];
        initialLinks.push(...uniqueLinks.map((link) => ({ url: link, episode: epNum })));
      });
      const results = yield Promise.all(initialLinks.map((linkInfo) => __async(this, null, function* () {
        try {
          const extracted = yield loadExtractor(linkInfo.url, mediaUrl);
          return extracted.map((ext) => __spreadProps(__spreadValues({}, ext), { episode: linkInfo.episode }));
        } catch (e) {
          return [];
        }
      })));
      const allFinalLinks = results.flat();
      const seenUrls = /* @__PURE__ */ new Set();
      const uniqueFinalLinks = allFinalLinks.filter((link) => {
        if (!link.url || link.url.includes(".zip"))
          return false;
        if (seenUrls.has(link.url))
          return false;
        seenUrls.add(link.url);
        return true;
      });
      return { finalLinks: uniqueFinalLinks, isMovie };
    }
  });
}
function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    console.log(`[HDHub4u] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    try {
      const mediaInfo = yield getTMDBDetails(tmdbId, mediaType);
      console.log(`[HDHub4u] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || "N/A"})`);
      const searchQuery = mediaType === "tv" && season ? `${mediaInfo.title} Season ${season}` : mediaInfo.title;
      const searchResults = yield search(searchQuery);
      if (searchResults.length === 0)
        return [];
      const matches = findTitleMatches(mediaInfo, searchResults, mediaType, season);
      if (matches.length === 0) {
        console.log(`[HDHub4u] No confident match for "${mediaInfo.title}" - refusing to guess from unrelated search results`);
        return [];
      }
      // Try several top-scoring posts, not just the single best-scoring one -
      // HDHub4u frequently splits the same title+year across multiple posts
      // of differing quality/completeness, and the single best-scored post
      // is sometimes a dead or minimal one with no working links at all even
      // when a fuller post for the same title does have them (confirmed
      // live). Merging survives that instead of failing outright.
      const candidates = matches.slice(0, 3);
      const perCandidate = yield Promise.all(candidates.map((media) => __async(this, null, function* () {
        console.log(`[HDHub4u] Trying: "${media.title}" (${media.url})`);
        try {
          const result2 = yield getDownloadLinks(media.url);
          return result2.finalLinks;
        } catch (e) {
          return [];
        }
      })));
      const seenUrls = /* @__PURE__ */ new Set();
      const finalLinks = perCandidate.flat().filter((link) => {
        if (!link.url || seenUrls.has(link.url))
          return false;
        seenUrls.add(link.url);
        return true;
      });
      let filteredLinks = finalLinks;
      if (mediaType === "tv" && episode !== null) {
        filteredLinks = finalLinks.filter((link) => link.episode === episode);
      }
      const streams = filteredLinks.map((link) => {
        let mediaTitle = link.fileName && link.fileName !== "Unknown" ? link.fileName : mediaInfo.title;
        if (mediaType === "tv" && season && episode) {
          mediaTitle = `${mediaInfo.title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
        }
        const serverName = extractServerName(link.source);
        let qualityStr = "Unknown";
        if (typeof link.quality === "number" && link.quality > 0) {
          if (link.quality >= 2160)
            qualityStr = "4K";
          else if (link.quality >= 1080)
            qualityStr = "1080p";
          else if (link.quality >= 720)
            qualityStr = "720p";
          else if (link.quality >= 480)
            qualityStr = "480p";
        } else if (typeof link.quality === "string") {
          qualityStr = link.quality;
        }
        return {
          name: `HDHub4u ${serverName}`,
          title: mediaTitle,
          url: link.url,
          quality: qualityStr,
          size: formatBytes(link.size),
          headers: link.headers || void 0,
          provider: "hdhub4u"
        };
      });
      // HubCloud's "10Gbps" links resolve to a video-downloads.googleusercontent.com
      // Google Drive URL that (confirmed live) doesn't support HTTP Range
      // requests at all - a ranged request gets the full multi-GB file back,
      // 200 not 206. A proxy that fakes Range support by discarding leading
      // bytes was tried (lib/rangeProxy.js) before concluding that doesn't
      // actually help: a request for a range near the end of a real movie
      // file - which many MKVs need immediately for their seek index - took
      // over 4 minutes over a Pi's real upload bandwidth, far past any
      // player's timeout. So these are dropped here entirely rather than
      // just deprioritized, even when they're the only result for a given
      // quality - the same exclusion lib/aggregate.js applies for any other
      // provider's Google Drive links, kept here too since this file can
      // also be installed directly as its own standalone Nuvio plugin
      // without ever going through aggregate.js.
      const isNonSeekable = (url) => typeof url === "string" && url.includes("googleusercontent.com");
      const playableStreams = streams.filter((s) => !isNonSeekable(s.url));
      const qualityOrder = { "4K": 4, "1080p": 2, "720p": 1, "480p": 0, "Unknown": -2 };
      return playableStreams.sort((a, b) => (qualityOrder[b.quality] || -3) - (qualityOrder[a.quality] || -3));
    } catch (error) {
      console.error(`[HDHub4u] Scraping error: ${error.message}`);
      return [];
    }
  });
}
module.exports = { getStreams };
