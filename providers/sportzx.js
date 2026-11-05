// SportzX live-sports catalog & stream resolver.
//
// NOT a TMDB-based provider - like providers/indycar.js and providers/f1.js,
// this has no tmdbId/mediaType/season/episode interface, since live sports
// events have no TMDB entries. Used directly by addon-server.js's dedicated
// "SportzX Live" catalog, not through lib/aggregate.js, and intentionally
// left out of manifest.json's scrapers list for the same reason.
//
// Reverse-engineered from the real Android app (com.sportzx.live) by
// decompiling its own CloudStream plugin (cloudstream/SportzxProvider.cs3,
// a compiled plugin the user already had on disk) with jadx - not scraped
// from any website, since the app has no web frontend at all: every public
// sportzx.* domain (sportzx.cc/.me/.org, sportzxlive.com) is just an
// APK-download landing page with zero embedded player or API. sportzx.live
// itself (found as a string constant in the app) also serves no content -
// it's the real backend API domain that matters, resolved dynamically (see
// getBaseUrl below).
//
// Flow, confirmed live end-to-end 2026-09-18:
//   1. Base API URL: the app fetches this from Firebase Remote Config at
//      startup (POST to firebaseremoteconfig.googleapis.com, with the app's
//      own real Firebase project id + API key - both public, embedded in
//      the APK the same way any Firebase-configured app ships them), and
//      falls back to a hardcoded default if that call fails. Ported the
//      same way here.
//   2. Every API request needs `User-Agent: Dalvik/2.1.0 (Linux; Android
//      13)` specifically - confirmed live that a normal browser UA gets the
//      connection reset (TLS renegotiation demanded, then dropped) while
//      this exact UA is answered cleanly. Simple UA-based filtering, not a
//      real IP/network block - the same class of thing already seen (and
//      left unresolved from a browser UA) for providers/doflix.js.
//   3. Every response body is `{"data": "<encrypted blob>", ...}` -
//      decrypted with lib/sportzxCrypto.js (ported from and verified
//      byte-for-byte against the app's own scheme).
//   4. GET /events.json -> the full live/upcoming events list, each with an
//      eventInfo (teams, start/end time) and a list of format/server names.
//   5. GET /channels/{eventId}.json (fallback: /channels/{eventId}e.json)
//      -> that event's actual stream list. Each entry has a `type`: "0" is
//      a plain, directly playable stream (sometimes with
//      `|user-agent=...`/`|Referer=...` appended to the URL for required
//      playback headers); "1" is ClearKey-DRM protected (the `api` field is
//      a hex `kid:key` pair). Only "0" streams are used - DRM is out of
//      scope here the same way it's been ruled out everywhere else in this
//      project (this addon's stream response format has no way to carry a
//      decryption key to the player anyway).

const sportzxCrypto = require('../lib/sportzxCrypto');

const FIREBASE_API_KEY = 'AIzaSyCTIFo_vw_-XrjzDeE1yG4KuAqGLchzZ0M';
const FIREBASE_APP_ID = '1:234785582029:android:f5f9299eaa7a0d73c93284';
const FIREBASE_PROJECT_NUMBER = '234785582029';
const PACKAGE_NAME = 'com.sportzx.live';
const FALLBACK_BASE_URL = 'https://streamtvapp.top';
const USER_AGENT = 'Dalvik/2.1.0 (Linux; Android 13)';

let cachedBaseUrl = null;
let cachedBaseUrlAt = 0;
const BASE_URL_CACHE_TTL_MS = 1000 * 60 * 60;

function getBaseUrl() {
    if (cachedBaseUrl && Date.now() - cachedBaseUrlAt < BASE_URL_CACHE_TTL_MS) return Promise.resolve(cachedBaseUrl);
    const appInstanceId = require('crypto').randomBytes(16).toString('hex');
    const body = JSON.stringify({
        appInstanceId,
        appInstanceIdToken: '',
        appId: FIREBASE_APP_ID,
        countryCode: 'IN',
        languageCode: 'en-IN',
        platformVersion: '33',
        timeZone: 'Asia/Calcutta',
        appVersion: '2.6',
        appBuild: '15',
        packageName: PACKAGE_NAME,
        sdkVersion: '23.1.0',
        analyticsUserProperties: {}
    });
    // A failed call here falls back to the hardcoded default anyway (see
    // below), which happens to be the same URL Remote Config itself is
    // returning as of 2026-09-18 - but that's the current default, not a
    // guarantee, and this result gets cached for a full hour (much longer
    // than the events cache), so a transient failure is worth a couple of
    // retries rather than risking an hour on a stale fallback if SportzX
    // ever rotates their real backend domain the way several other sites in
    // this project already have.
    const fetchRemoteConfig = (attemptsLeft = 2) => fetch(`https://firebaseremoteconfig.googleapis.com/v1/projects/${FIREBASE_PROJECT_NUMBER}/namespaces/firebase:fetch`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Android-Package': PACKAGE_NAME,
            'X-Goog-Api-Key': FIREBASE_API_KEY
        },
        body
    })
        .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .catch((err) => {
            if (attemptsLeft <= 0) throw err;
            return new Promise((resolve) => setTimeout(resolve, 1000))
                .then(() => fetchRemoteConfig(attemptsLeft - 1));
        });

    return fetchRemoteConfig()
        .then((json) => {
            const apiUrl = json && json.entries && json.entries.api_url;
            const base = (apiUrl || FALLBACK_BASE_URL).replace(/\/+$/, '');
            cachedBaseUrl = base;
            cachedBaseUrlAt = Date.now();
            return base;
        })
        .catch(() => FALLBACK_BASE_URL);
}

// This backend has been directly observed to be flaky during development
// today (connection failures that cleared up moments later) - the same
// transient-network class of problem providers/indycar.js's own
// fetchHtmlWithRetries already exists to smooth over, so this mirrors that
// same couple-of-retries-with-a-short-backoff shape rather than letting one
// bad request empty out the whole catalog.
function fetchEnvelope(url, attemptsLeft = 2) {
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
        .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .catch((err) => {
            if (attemptsLeft <= 0) throw err;
            return new Promise((resolve) => setTimeout(resolve, 1000))
                .then(() => fetchEnvelope(url, attemptsLeft - 1));
        });
}

function fetchDecrypted(path) {
    return getBaseUrl().then((base) => {
        const url = `${base}${path}`;
        return fetchEnvelope(url)
            .then((envelope) => {
                if (!envelope || !envelope.data) return null;
                const decrypted = sportzxCrypto.decrypt(envelope.data);
                if (!decrypted) {
                    console.log(`[SportzX] Decryption failed for ${url}`);
                    return null;
                }
                try {
                    return JSON.parse(decrypted);
                } catch (e) {
                    console.log(`[SportzX] Decrypted body wasn't valid JSON for ${url}`);
                    return null;
                }
            })
            .catch((err) => {
                console.log(`[SportzX] Request failed for ${url}: ${err.message}`);
                return null;
            });
    });
}

// Live sports events change fast (a match starts/ends within hours) - a
// short TTL matters more here than the hour-plus caches indycar.js/f1.js
// use for their much slower-moving schedules, but it's still cheap enough
// (one JSON request, not a multi-page crawl) that a bare cache without the
// stale-while-revalidate machinery those two need is enough.
const EVENTS_CACHE_TTL_MS = 1000 * 60 * 3;
let eventsCache = { events: null, timestamp: 0 };
let inFlightEvents = null;

function getAllEvents() {
    const now = Date.now();
    if (eventsCache.events && now - eventsCache.timestamp < EVENTS_CACHE_TTL_MS) {
        return Promise.resolve(eventsCache.events);
    }
    if (!inFlightEvents) {
        inFlightEvents = fetchDecrypted('/events.json').then((events) => {
            inFlightEvents = null;
            const list = Array.isArray(events) ? events : [];
            eventsCache = { events: list, timestamp: Date.now() };
            console.log(`[SportzX] Fetched ${list.length} live event(s)`);
            return list;
        }).catch((err) => {
            inFlightEvents = null;
            console.error(`[SportzX] Failed to fetch events: ${err.message}`);
            return eventsCache.events || [];
        });
    }
    return inFlightEvents;
}

// startTime/endTime arrive as "2026/09/24 08:30:00 +0000" - slash-separated
// date, space before the offset. Node's Date.parse actually handles that
// exact shape natively (confirmed live: it round-trips to the correct UTC
// instant, offset and all) - a previous version of this function rewrote it
// toward ISO shape first ("T" separator, "+0000"->"Z"), which actually broke
// it instead (the rewritten string doesn't match any format Date.parse
// recognizes and silently returns NaN), so every event's status/timing
// computation always failed. Parse the raw string as-is.
function isEventLive(event) {
    const info = event && event.eventInfo;
    if (!info || !info.startTime) return false;
    const start = Date.parse(info.startTime);
    const end = info.endTime ? Date.parse(info.endTime) : null;
    const now = Date.now();
    if (Number.isNaN(start)) return false;
    return now >= start && (end === null || Number.isNaN(end) || now < end);
}

function listEvents() {
    return getAllEvents();
}

function getEvent(eventId) {
    return getAllEvents().then((events) => events.find((e) => String(e.id) === String(eventId)) || null);
}

// A stream's `link` sometimes carries required playback headers appended
// after a `|`, e.g. "https://...m3u8|user-agent=Mozilla/5.0 ...". Confirmed
// live this isn't always one header per `|` segment though - some entries
// pack more than one into a single segment, joined with `&` query-string
// style (e.g. "...m3u8?|Referer=https://x/&Origin=https://x"), so each
// pipe-delimited segment is itself split on `&` before parsing key=value.
function parseLinkAndHeaders(link) {
    const parts = String(link).split('|');
    const url = parts[0];
    const headers = {};
    for (let i = 1; i < parts.length; i++) {
        for (const pair of parts[i].split('&')) {
            const eq = pair.indexOf('=');
            if (eq === -1) continue;
            const key = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (key && value) headers[key] = value;
        }
    }
    return { url, headers };
}

// Confirmed live 2026-10-19 that an event's channel list mixes working feeds
// with dead ones (403 even with the entry's own headers), so each is test-
// fetched before it's offered: an HLS feed has to answer with a real
// "#EXTM3U" playlist, anything else with a 2xx. Probed concurrently with a
// short timeout, so it adds roughly one round trip, not one per feed.
const PROBE_TIMEOUT_MS = 6000;

function isPlayable(stream) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    return fetch(stream.url, { headers: stream.headers || {}, signal: controller.signal })
        .then((res) => {
            if (!res.ok) return false;
            const type = res.headers.get('content-type') || '';
            if (/\.m3u8(\?|$)/i.test(stream.url) || /mpegurl/i.test(type)) {
                return res.text().then((text) => /^#EXTM3U/.test(text.trim()));
            }
            if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
            return true;
        })
        .catch(() => false)
        .then((ok) => { clearTimeout(timer); return ok; });
}

function getEventStreams(eventId) {
    return fetchDecrypted(`/channels/${eventId}.json`)
        .then((channels) => (channels ? channels : fetchDecrypted(`/channels/${eventId}e.json`)))
        .then((channels) => {
            const list = Array.isArray(channels) ? channels : [];
            const playable = list.filter((c) => String(c.type) !== '1'); // skip ClearKey-DRM entries
            const streams = playable.map((c) => {
                const { url, headers } = parseLinkAndHeaders(c.link);
                return {
                    name: `SportzX - ${c.title || 'Live'}`,
                    url,
                    headers: Object.keys(headers).length ? headers : undefined,
                    quality: 'Live'
                };
            }).filter((s) => s.url);
            return Promise.all(streams.map(isPlayable)).then((results) => {
                const working = streams.filter((_, i) => results[i]);
                const dropped = streams.length - working.length;
                if (dropped) console.log(`[SportzX] Event ${eventId}: dropped ${dropped}/${streams.length} unreachable stream(s)`);
                return working;
            });
        });
}

module.exports = { listEvents, getEvent, getEventStreams, isEventLive };
