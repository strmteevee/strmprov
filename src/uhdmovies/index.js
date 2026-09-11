import cheerio from 'cheerio-without-node-native';
import { HEADERS } from './constants.js';
import { getMainUrl, fetchTmdbDetails, bypassHrefli, extractDriveseedPage, getIndexQuality, extractVideoSeed, fetchWithTimeout } from './utils.js';

async function getStreams(tmdbId, mediaType, seasonNum = 1, episodeNum = 1) {
    console.log(`[UHDMovies] Querying streams for TMDB: ${tmdbId}, Type: ${mediaType}`);
    
    const details = await fetchTmdbDetails(tmdbId, mediaType);
    if (!details) return [];

    const mainUrl = await getMainUrl();
    const query = details.title;
    const searchUrl = `${mainUrl}/?s=${encodeURIComponent(query)}`;
    
    try {
        const searchRes = await fetchWithTimeout(searchUrl, { headers: { ...HEADERS, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
        const searchHtml = await searchRes.text();
        const $search = cheerio.load(searchHtml);
        
        let targetUrl = "";
        $search("article.gridlove-post, article.latestPost").each((i, el) => {
            const title = $search(el).find("h1.sanket, h2.title a").text() || $search(el).find("a").attr("title") || "";
            const href = $search(el).find("div.entry-image > a, h2.title a, a").first().attr("href");
            if (href && (title.toLowerCase().includes(details.title.toLowerCase()) || (details.imdbId && title.includes(details.imdbId)))) {
                targetUrl = href;
                return false;
            }
        });

        if (!targetUrl) {
            console.log("[UHDMovies] No search result found");
            return [];
        }

        const pageRes = await fetchWithTimeout(targetUrl, { headers: { ...HEADERS, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
        const pageHtml = await pageRes.text();
        const $ = cheerio.load(pageHtml);
        
        const allStreams = [];

        if (mediaType === 'movie') {
            const iframeRegex = /\[.*\]/;
            $("div.entry-content > p, div.entry-content > div").each((i, el) => {
                const text = $(el).text();
                if (iframeRegex.test(text)) {
                    const quality = getIndexQuality(text);
                    const nextHref = $(el).next().find("a.maxbutton-1, a.maxbutton").attr("href") || $(el).find("a.maxbutton-1, a.maxbutton").attr("href");
                    if (nextHref) {
                        allStreams.push({ url: nextHref, quality });
                    }
                }
            });
        } else {
            // TV Series
            const episodesMap = {};
            let currentSeason = seasonNum; // Default to requested

            $("pre, p, a, h3").each((i, el) => {
                const text = $(el).text().trim();
                const seasonMatch = text.match(/(?:season\s*|S)(\d+)/i);
                if (seasonMatch && text.length < 20) {
                    currentSeason = parseInt(seasonMatch[1]);
                }

                if (($(el).is("a") || $(el).find("a").length > 0) && text.toLowerCase().includes("episode")) {
                    if (text.toLowerCase().includes("zip")) return;
                    const epMatch = text.match(/Episode\s*(\d+)/i);
                    if (epMatch) {
                        const realEp = parseInt(epMatch[1]);
                        const epUrl = $(el).is("a") ? $(el).attr("href") : $(el).find("a").attr("href");
                        if (epUrl) {
                            const key = `${currentSeason}-${realEp}`;
                            if (!episodesMap[key]) episodesMap[key] = [];
                            episodesMap[key].push(epUrl);
                        }
                    }
                }
            });

            const targetKey = `${seasonNum}-${episodeNum}`;
            const urls = episodesMap[targetKey] || [];
            urls.forEach(url => {
                allStreams.push({ url, quality: "Unknown" });
            });
        }

        // Each quality link resolves independently (its own bypass/driveseed/video-seed
        // chain of requests), so resolve them all concurrently instead of one at a time -
        // this was the main reason uhdmovies could take 60-90s for a handful of qualities.
        const resultGroups = await Promise.all(allStreams.map(async (item) => {
            let finalLink = item.url;
            if (finalLink.includes("unblockedgames")) {
                finalLink = await bypassHrefli(finalLink);
            }
            if (!finalLink) return [];

            if (finalLink.includes("driveseed") || finalLink.includes("driveleech")) {
                const streams = await extractDriveseedPage(finalLink);
                return streams.map(s => ({
                    ...s,
                    name: "UHDMovies [Driveseed]",
                    title: `UHDMovies - ${s.quality} ${s.size ? `[${s.size}]` : ""}`,
                    quality: s.quality || item.quality,
                    provider: "uhdmovies"
                }));
            } else if (finalLink.includes("video-seed")) {
                const streamUrl = await extractVideoSeed(finalLink);
                if (!streamUrl) return [];
                return [{
                    name: "UHDMovies [VideoSeed]",
                    title: `UHDMovies - ${item.quality}`,
                    url: streamUrl,
                    quality: item.quality,
                    provider: "uhdmovies"
                }];
            }
            return [{
                name: "UHDMovies",
                title: `UHDMovies - ${item.quality}`,
                url: finalLink,
                quality: item.quality,
                provider: "uhdmovies"
            }];
        }));

        return resultGroups.flat();
    } catch (e) {
        console.error("[UHDMovies] Error:", e.message);
        return [];
    }
}

module.exports = { getStreams };
