// Live Channels: live sport as rows with a programme guide, instead of a list
// of separate events.
//
// A catalog marked `guide: true` in the manifest has one meta per channel, each
// with `programmes: [{ title, start, end, description?, image? }]` (epoch ms,
// by start time, not overlapping). Stremio clients ignore both fields and just
// show the rows; OmniStream draws them as its guide.

const crypto = require('crypto');

// Upstream only gives start times. Same estimate as DaddyLive's live window:
// long enough for a match or race; the next programme on the channel cuts it off.
const PROGRAMME_LENGTH_MS = 3 * 60 * 60 * 1000;
// A stream that's live and running over its estimate still runs at least this much longer.
const LIVE_AT_LEAST_MS = 30 * 60 * 1000;
const HORIZON_MS = 24 * 60 * 60 * 1000;
// What just ended still has its place in a guide that starts at the half hour.
const KEEP_ENDED_MS = 60 * 60 * 1000;
// Events of one competition this close together run at the same time, as far as is known.
const SAME_ROW_GAP_MS = 2 * 60 * 60 * 1000;
const ROW_ID = 'daddylive:row:';
// A stream first seen live has been on for a while already.
const FIRST_SEEN_LIVE_MS = 5 * 60 * 1000;
const REMEMBER_STARTS_MS = 2 * 24 * 60 * 60 * 1000;

// Schedule categories are free text ("All Soccer Events ⚽", "England -
// Championship ⚽", "Tennis 🎾 ATP - Singles: Paris (France)"): the sport they're about.
const SPORTS = [
    [/⚽|soccer/i, 'Soccer'],
    [/🏈|am\. football|college football|\bnfl\b|\bcfl\b/i, 'American Football'],
    [/🎾|tennis/i, 'Tennis'],
    [/🏒|hockey|\bnhl\b/i, 'Ice Hockey'],
    [/🏉|rugby/i, 'Rugby'],
    [/🏀|basketball|\bnba\b/i, 'Basketball'],
    [/🏎|motorsport|formula|motogp/i, 'Motorsport'],
    [/\bufc\b|\bmma\b/i, 'MMA']
];
function sportOf(category, title) {
    // The emoji an event's title starts with beats its category: upstream files
    // KHL hockey (🏒) under "Rugby Union", for one.
    const lead = (String(title || '').match(/^[^\p{L}\p{N}]+/u) || [''])[0];
    const fromTitle = lead && SPORTS.find(([pattern]) => pattern.test(lead));
    if (fromTitle) return fromTitle[1];
    const text = String(category || '');
    const known = SPORTS.find(([pattern]) => pattern.test(text));
    if (known) return known[1];
    if (/^upcoming/i.test(text)) return null;
    // Anything else: its name up to the first emoji or detail ("Squash 🏸").
    return text.split(/[^\p{L}\p{N} .&'-]/u)[0].trim() || null;
}

// Sorted, without overlaps: a programme ends where the next one starts, and of
// two starting at the same moment the first stays.
function fitProgrammes(list) {
    const sorted = list.slice().sort((a, b) => a.start - b.start);
    const fitted = [];
    sorted.forEach((p) => {
        const last = fitted[fitted.length - 1];
        if (last && last.start === p.start) return;
        if (last && last.end > p.start) last.end = p.start;
        fitted.push(Object.assign({}, p));
    });
    return fitted;
}

function describe(programmes, now) {
    const on = programmes.find((p) => p.start <= now && now < p.end);
    const next = programmes.find((p) => p.start > now);
    return [on && `Now: ${on.title}`, next && `Next: ${next.title}`].filter(Boolean).join('\n') || undefined;
}

function isOn(meta, now) {
    return meta.programmes.some((p) => p.start <= now && now < p.end);
}

// What an event belongs to, from its free-text title: "🏎️ Moto2 | Round 20 | Qatar
// Qualifying" is Moto2, "⚽ Spain - La Liga : Osasuna vs Athletic Club" is Spain - La Liga.
function competitionOf(title) {
    const text = String(title || '').replace(/^[^\p{L}\p{N}]+/u, '');
    return text.split(/\s+:\s+|\s+\|\s+|:\s+/)[0].replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/\s+/g, ' ').trim();
}

// The title without what the row's name already says: "Round 20 | Qatar Qualifying".
function titleOnRow(title) {
    const text = String(title || '').replace(/^[^\p{L}\p{N}]+/u, '');
    const separator = text.match(/\s+:\s+|\s+\|\s+|:\s+/);
    if (!separator) return text;
    return text.slice(separator.index + separator[0].length).replace(/^[^\p{L}\p{N}]+/u, '') || text;
}

// Rows of a competition. Its events follow each other on one row; one that starts
// too soon after the last can't be on the same row, so it goes on the next.
function intoRows(events) {
    const rows = [];
    events.forEach((ev) => {
        const free = rows.find((row) => ev.start - row[row.length - 1].start >= SAME_ROW_GAP_MS);
        if (free) free.push(ev); else rows.push([ev]);
    });
    return rows;
}

// DaddyLive's events ({ id, start, end, title, category, channels }) as the guide's
// rows, one per competition: however many feeds carry an event, it's there once,
// and playing it offers all of them. A row is about one sport, so what shows under
// a sport's filter is that sport. All of the schedule goes in, finished events too,
// so a row keeps its number (and id) while the day goes by.
function allRows(events) {
    const timed = events.filter((ev) => ev.start && ev.channels && ev.channels.length)
        .sort((a, b) => (a.start - b.start) || String(a.title).localeCompare(String(b.title)));
    const groups = new Map();
    timed.forEach((ev) => {
        const name = competitionOf(ev.title);
        const sport = sportOf(ev.category, ev.title);
        const key = `${sport}|${name}`;
        if (!groups.has(key)) groups.set(key, { name, sport, events: [] });
        groups.get(key).events.push(ev);
    });
    const nameCount = new Map();
    groups.forEach(({ name }) => nameCount.set(name, (nameCount.get(name) || 0) + 1));

    const rows = [];
    groups.forEach(({ name, sport, events: group }, key) => {
        const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
        const label = nameCount.get(name) > 1 && sport ? `${name} (${sport})` : name;
        intoRows(group).forEach((rowEvents, i) => {
            const programmes = fitProgrammes(rowEvents.map((ev) => ({
                title: titleOnRow(ev.title),
                start: ev.start,
                end: ev.end || ev.start + PROGRAMME_LENGTH_MS,
                description: [ev.category, ev.channels.length > 1 ? `${ev.channels.length} sources` : null].filter(Boolean).join(' · ') || undefined,
                eventId: ev.id
            })));
            rows.push({ id: `${ROW_ID}${hash}:${i + 1}`, name: i ? `${label} ${i + 1}` : label, sport, programmes });
        });
    });
    return rows;
}

function rowToMeta(row, now) {
    const programmes = row.programmes
        .filter((p) => p.end > now - KEEP_ENDED_MS && p.start < now + HORIZON_MS)
        .map(({ eventId, ...programme }) => programme);
    return {
        id: row.id,
        type: 'tv',
        name: row.name,
        description: describe(programmes, now),
        posterShape: 'landscape',
        genres: row.sport ? [row.sport] : [],
        programmes
    };
}

// Rows with something on now come first, then by what starts soonest.
function rowsFromEvents(events, now) {
    const nextStart = (meta) => meta.programmes.find((p) => p.end > now).start;
    return allRows(events)
        .filter((row) => row.programmes.some((p) => p.end > now && p.start < now + HORIZON_MS))
        .map((row) => rowToMeta(row, now))
        .sort((a, b) => (isOn(b, now) - isOn(a, now)) || (nextStart(a) - nextStart(b)) || a.name.localeCompare(b.name));
}

function rowMeta(events, id, now) {
    const row = allRows(events).find((r) => r.id === id);
    return row ? rowToMeta(row, now) : null;
}

// What playing a row means: the id of the event on it now, else of the next one.
function rowEventId(events, id, now) {
    const row = allRows(events).find((r) => r.id === id);
    if (!row) return null;
    const programme = row.programmes.find((p) => p.end > now) || row.programmes[row.programmes.length - 1];
    return programme ? programme.eventId : null;
}

// A YouTube channel's live page ({ id, title, status, viewers, thumbnail,
// scheduledTs }) as one channel. YouTube doesn't say when a live stream began:
// [starts] remembers its scheduled time, or else about when it was first seen live.
// Streams live at the same time share one block (playing the channel offers each).
function channelFromYoutube({ id, name, genre }, items, starts, now) {
    starts.forEach((start, videoId) => { if (start < now - REMEMBER_STARTS_MS) starts.delete(videoId); });
    const live = items.filter((i) => i.status === 'live');
    const upcoming = items.filter((i) => i.status === 'upcoming' && i.scheduledTs);
    upcoming.forEach((i) => starts.set(i.id, i.scheduledTs));
    live.forEach((i) => { if (!starts.has(i.id)) starts.set(i.id, now - FIRST_SEEN_LIVE_MS); });

    const list = upcoming.filter((i) => i.scheduledTs > now).map((i) => ({
        title: i.title,
        start: i.scheduledTs,
        end: i.scheduledTs + PROGRAMME_LENGTH_MS,
        image: i.thumbnail
    }));
    if (live.length) {
        const top = live[0];
        const start = Math.min(...live.map((i) => starts.get(i.id)));
        list.push({
            title: live.length > 1 ? `${top.title} (+${live.length - 1} more live)` : top.title,
            start,
            end: Math.max(start + PROGRAMME_LENGTH_MS, now + LIVE_AT_LEAST_MS),
            description: top.viewers ? `${top.viewers.toLocaleString('en-US')} watching` : undefined,
            image: top.thumbnail
        });
    }
    const programmes = fitProgrammes(list);
    return { id, type: 'tv', name, description: describe(programmes, now), posterShape: 'landscape', genres: genre ? [genre] : [], programmes };
}

module.exports = { ROW_ID, rowsFromEvents, rowMeta, rowEventId, channelFromYoutube, fitProgrammes, sportOf, competitionOf };
