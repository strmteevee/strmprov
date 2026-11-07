// Live Channels: live sport as TV channels with a programme guide, instead of
// a list of separate events.
//
// A catalog marked `guide: true` in the manifest has one meta per channel, each
// with `programmes: [{ title, start, end, description?, image? }]` (epoch ms,
// by start time, not overlapping). Stremio clients ignore both fields and just
// show the channels; OmniStream draws them as its guide.

// Upstream only gives start times. Same estimate as DaddyLive's live window:
// long enough for a match or race; the next programme on the channel cuts it off.
const PROGRAMME_LENGTH_MS = 3 * 60 * 60 * 1000;
// A stream that's live and running over its estimate still runs at least this much longer.
const LIVE_AT_LEAST_MS = 30 * 60 * 1000;
const HORIZON_MS = 24 * 60 * 60 * 1000;
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
function sportOf(category) {
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

// DaddyLive's events ({ start, end, title, category, channels: [{ channel, name }] })
// as channels: an event with several feeds is on each of them. Channels with
// something on now come first, then by what starts soonest. Generic feeds share
// a name ("Event Stream"): those get their number, so each is its own channel.
function channelsFromEvents(events, now) {
    const byChannel = new Map();
    events.forEach((ev) => {
        if (!ev.start || ev.start > now + HORIZON_MS || !ev.channels) return;
        const programme = { title: ev.title, start: ev.start, end: ev.end || ev.start + PROGRAMME_LENGTH_MS };
        if (ev.category) programme.description = ev.category;
        const sport = sportOf(ev.category);
        ev.channels.forEach((feed) => {
            if (!byChannel.has(feed.channel)) byChannel.set(feed.channel, { name: feed.name, programmes: [], sports: [] });
            const entry = byChannel.get(feed.channel);
            entry.programmes.push(programme);
            if (sport) entry.sports.push(sport);
        });
    });
    const nameCount = new Map();
    byChannel.forEach(({ name }) => nameCount.set(name, (nameCount.get(name) || 0) + 1));

    return [...byChannel.entries()].map(([channel, entry]) => {
        const programmes = fitProgrammes(entry.programmes);
        const name = !entry.name ? `Channel ${channel}` : nameCount.get(entry.name) > 1 ? `${entry.name} ${channel}` : entry.name;
        return {
            id: `daddylive:${channel}`,
            type: 'tv',
            name,
            description: describe(programmes, now),
            posterShape: 'landscape',
            genres: [...new Set(entry.sports)],
            programmes
        };
    }).sort((a, b) => (isOn(b, now) - isOn(a, now))
        || (a.programmes[0].start - b.programmes[0].start)
        || a.name.localeCompare(b.name));
}

// A YouTube channel's live page ({ id, title, status, viewers, thumbnail,
// scheduledTs }) as one channel. YouTube doesn't say when a live stream began:
// [starts] remembers its scheduled time, or else when it was first seen live.
// Streams live at the same time share one block (playing the channel offers each).
function channelFromYoutube({ id, name, genre }, items, starts, now) {
    starts.forEach((start, videoId) => { if (start < now - REMEMBER_STARTS_MS) starts.delete(videoId); });
    const live = items.filter((i) => i.status === 'live');
    const upcoming = items.filter((i) => i.status === 'upcoming' && i.scheduledTs);
    upcoming.forEach((i) => starts.set(i.id, i.scheduledTs));
    live.forEach((i) => { if (!starts.has(i.id)) starts.set(i.id, now); });

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

module.exports = { channelsFromEvents, channelFromYoutube, fitProgrammes, sportOf };
