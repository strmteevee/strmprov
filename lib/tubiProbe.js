// A look at Tubi (US, free with adverts) before anything is built for it: how
// it offers its titles to a visitor without an account - which stream kinds
// (plain HLS, or protected with Widevine and a licence service), going by its
// own web pages, asked through a US tunnel (Tubi shows Europe only a notice).
// Served at /probe/tubi for the admin; it fetches Tubi's own site, nothing else.

const wireguard = require('./wireguard');
const { tunnelFetch } = require('./tunnelFetch');

const SITE = 'https://tubitv.com';
const US_SOURCES = ['plutotv', 'plex-us'];
const TITLES_CHECKED = 20;
const AT_ONCE = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function page(proxy, url) {
    return tunnelFetch(proxy, url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json' }, timeoutMs: 20000 })
        .then(r => ({ status: r.status, url: r.url || url, text: r.text() }));
}

// What a title's page says about its streams: the kinds listed in the page's data, and whether a licence service is named.
function streamsIn(html) {
    const kinds = {};
    const re = /"type"\s*:\s*"((?:hls|dash)[a-z0-9_]*)"/gi;
    let m;
    while ((m = re.exec(html))) kinds[m[1].toLowerCase()] = (kinds[m[1].toLowerCase()] || 0) + 1;
    return {
        kinds: Object.keys(kinds),
        licence: /"license_server"\s*:\s*\{/.test(html),
        widevine: /widevine/i.test(html),
        manifest: (/"manifest"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/.exec(html) || [])[1] ? 'listed' : 'none',
        signIn: /"needs_login"\s*:\s*true|"login_required"\s*:\s*true/.test(html)
    };
}

function probe() {
    const source = US_SOURCES.find(s => wireguard.proxyFor(s));
    if (!source) return Promise.resolve({ ok: false, reason: 'No running US tunnel (Pluto TV (US) or Plex (US))' });
    const proxy = wireguard.proxyFor(source);
    return page(proxy, `${SITE}/`).then(home => {
        const blocked = /gdpr\.tubi\.tv/.test(home.url);
        const ids = Array.from(new Set((home.text.match(/\/(?:movies|tv-shows|series)\/\d+/g) || [])));
        const report = { ok: !blocked, through: source, home: { status: home.status, url: home.url, bytes: home.text.length, titleLinks: ids.length }, titles: [], kinds: {} };
        if (blocked || !ids.length) return report;
        const wanted = ids.filter(p => p.startsWith('/movies/')).slice(0, TITLES_CHECKED);
        const next = (i) => {
            if (i >= wanted.length) return Promise.resolve(report);
            return Promise.all(wanted.slice(i, i + AT_ONCE).map(p => page(proxy, `${SITE}${p}`)
                .then(t => Object.assign({ path: p, status: t.status, bytes: t.text.length }, streamsIn(t.text)))
                .catch(err => ({ path: p, error: err.message }))))
                .then(found => {
                    found.forEach(t => {
                        report.titles.push(t);
                        (t.kinds || []).forEach(k => { report.kinds[k] = (report.kinds[k] || 0) + 1; });
                    });
                    return next(i + AT_ONCE);
                });
        };
        return next(0);
    });
}

// One of a US service's own addresses as it answers through the US tunnel, to
// find out how its site gets its titles: { status, url, type, body (the first
// [max] characters), cookies }. Only the hosts of the services looked into
// (Tubi; The Roku Channel and Xumo Play, 2026-11-20); [options]: { method,
// body, bearer, cookie (sent as the Cookie header: what an earlier look's
// `cookies` gave), headers (more request headers, as JSON), from, max }.
const TUBI_HOSTS = /(^|\.)(tubitv\.com|tubi\.io|tubi\.tv|tubi\.video|roku\.com|xumo\.com|xumo\.tv)$/i;
function look(url, options) {
    const o = options || {};
    let target;
    try { target = new URL(url); } catch (e) { return Promise.resolve({ ok: false, reason: 'Bad address' }); }
    if (target.protocol !== 'https:' || !TUBI_HOSTS.test(target.hostname)) return Promise.resolve({ ok: false, reason: 'Not an address of a service looked into' });
    const source = US_SOURCES.find(s => wireguard.proxyFor(s));
    if (!source) return Promise.resolve({ ok: false, reason: 'No running US tunnel (Pluto TV (US) or Plex (US))' });
    const headers = { 'User-Agent': UA, Accept: 'application/json,text/html,*/*' };
    if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
    if (o.cookie) headers.Cookie = o.cookie;
    if (o.headers) { try { Object.assign(headers, JSON.parse(o.headers)); } catch (e) { /* not JSON: left out */ } }
    if (o.body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(o.body); }
    return tunnelFetch(wireguard.proxyFor(source), target.href, { method: o.method === 'POST' ? 'POST' : 'GET', body: o.body || undefined, headers, timeoutMs: 20000 })
        .then(r => {
            const text = r.text();
            // The cookies it set, as "name=value; name=value" (for the next look's `cookie`).
            const cookies = [].concat((r.headers && r.headers['set-cookie']) || []).map(c => String(c).split(';')[0]).join('; ');
            return { ok: true, status: r.status, url: r.url || target.href, type: (r.headers && r.headers['content-type']) || null, cookies: cookies || undefined, bytes: text.length, body: text.slice(Number(o.from) || 0, (Number(o.from) || 0) + (Number(o.max) || 20000)) };
        });
}

module.exports = { probe, look, streamsIn };
