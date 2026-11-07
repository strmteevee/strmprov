// node --test lib/liveGuide.test.js
const test = require('node:test');
const assert = require('node:assert');
const { rowsFromEvents, rowMeta, rowEventId, channelFromYoutube, fitProgrammes, sportOf, competitionOf, eventFields, youtubeEventFields } = require('./liveGuide');

const HOUR = 60 * 60 * 1000;
const NOW = 1000 * HOUR;

function event(title, startHours, channels, category) {
    const start = NOW + startHours * HOUR;
    return { title, start, end: start + 3 * HOUR, category, channels: channels.map(([channel, name]) => ({ channel, name })) };
}

test('sports are read from free-text categories', () => {
    assert.strictEqual(sportOf('All Soccer Events ⚽'), 'Soccer');
    assert.strictEqual(sportOf('England - Championship ⚽'), 'Soccer');
    assert.strictEqual(sportOf('Tennis 🎾 ATP - Singles: Paris (France)'), 'Tennis');
    assert.strictEqual(sportOf('College Football (NCAAF) 🏈'), 'American Football');
    assert.strictEqual(sportOf('Motorsport 🏎️🏁'), 'Motorsport');
    assert.strictEqual(sportOf('Squash 🏸'), 'Squash');
    assert.strictEqual(sportOf('UFC Fight Night 293'), 'MMA');
    assert.strictEqual(sportOf('Upcoming Events'), null);
    assert.strictEqual(sportOf(''), null);
});

test('a programme ends where the next one starts', () => {
    const fitted = fitProgrammes([{ title: 'b', start: 2, end: 9 }, { title: 'a', start: 1, end: 5 }, { title: 'c', start: 2, end: 3 }]);
    assert.deepStrictEqual(fitted.map((p) => [p.title, p.start, p.end]), [['a', 1, 2], ['b', 2, 9]]);
});

test('competitions are read from free-text titles', () => {
    assert.strictEqual(competitionOf('🏎️ Moto2 | Round 20 | Qatar Qualifying'), 'Moto2');
    assert.strictEqual(competitionOf('⚽ Spain - La Liga : Osasuna 🇪🇸 vs Athletic Club 🇪🇸'), 'Spain - La Liga');
    assert.strictEqual(competitionOf('🎾 WTA - Doubles: 🇨🇳 Xinyu Jiang / 🇭🇰 Cody Wong'), 'WTA - Doubles');
    assert.strictEqual(competitionOf('🏇 Live racing from Wincanton'), 'Live racing from Wincanton');
});

test('a title on its row leaves out what the row already says', () => {
    const titleOf = (title) => rowsFromEvents([event(title, 1, [[1, 'x']])], NOW)[0].programmes[0].title;
    assert.strictEqual(titleOf('🏎️ Moto2 | Round 20 | Qatar Qualifying'), 'Round 20 | Qatar Qualifying');
    assert.strictEqual(titleOf('🎾 WTA - Doubles: 🇨🇳 Xinyu Jiang / Cody Wong'), 'Xinyu Jiang / Cody Wong');
    assert.strictEqual(titleOf('🏇 Live racing from Wincanton'), 'Live racing from Wincanton');
});

test('an event is one row, however many feeds carry it', () => {
    const rows = rowsFromEvents([event('🏎️ Moto2 | Race', -1, [[1, 'One'], [2, 'Two'], [3, 'Three']], 'Motorsport 🏎️🏁')], NOW);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'Moto2');
    assert.strictEqual(rows[0].programmes[0].description, 'Motorsport 🏎️🏁 · 3 sources');
    assert.strictEqual(rows[0].programmes[0].eventId, undefined);
});

test('a competition follows one row, ending each at the next', () => {
    const [row, ...rest] = rowsFromEvents([event('Moto2 | Race', 3, [[1, 'A']]), event('Moto2 | Qualifying', 0.5, [[2, 'B']])], NOW);
    assert.deepStrictEqual(rest, []);
    assert.strictEqual(row.name, 'Moto2');
    assert.deepStrictEqual(row.programmes.map((p) => p.title), ['Qualifying', 'Race']);
    assert.strictEqual(row.programmes[0].end, row.programmes[1].start);
});

test('what runs at the same time gets a row of its own', () => {
    const rows = rowsFromEvents([event('NCAAF : A vs B', 1, [[1, 'x']]), event('NCAAF : C vs D', 1, [[2, 'y']]), event('NCAAF : E vs F', 1.5, [[3, 'z']])], NOW);
    assert.deepStrictEqual(rows.map((r) => r.name).sort(), ['NCAAF', 'NCAAF 2', 'NCAAF 3']);
    assert.strictEqual(new Set(rows.map((r) => r.id)).size, 3);
});

test('a row is about one sport: a channel carrying several sports does not mix them', () => {
    const rows = rowsFromEvents([
        event('🏎️ Moto2 | Race', -1, [[1, 'Sportklub']], 'Motorsport 🏎️🏁'),
        event('⚽ Liga : A vs B', 1, [[1, 'Sportklub']], 'All Soccer Events ⚽'),
    ], NOW);
    assert.deepStrictEqual(rows.map((r) => [r.name, r.genres]), [['Moto2', ['Motorsport']], ['Liga', ['Soccer']]]);
});

test('the same name in two sports stays two rows, and says which', () => {
    const rows = rowsFromEvents([event('World Cup : A vs B', 1, [[1, 'x']], 'Rugby Union'), event('World Cup : C vs D', 1, [[2, 'y']], 'Soccer')], NOW);
    assert.deepStrictEqual(rows.map((r) => r.name).sort(), ['World Cup (Rugby)', 'World Cup (Soccer)']);
});

test('rows with something on come first, then what starts soonest', () => {
    const rows = rowsFromEvents([event('Soon', 1, [[1, 'x']]), event('Later', 5, [[2, 'y']]), event('On', -1, [[3, 'z']])], NOW);
    assert.deepStrictEqual(rows.map((r) => r.name), ['On', 'Soon', 'Later']);
});

test('what is over, far ahead or without a time stays out', () => {
    const none = rowsFromEvents([
        event('Far', 30, [[1, 'x']]), event('Over', -5, [[2, 'y']]), { title: 'None', start: 0, channels: [{ channel: 3, name: 'z' }] },
    ], NOW);
    assert.deepStrictEqual(none, []);
});

test('a row keeps its id as the day goes by', () => {
    const events = [event('L : A', -6, [[1, 'x']]), event('L : B', -6, [[2, 'y']]), event('L : C', 1, [[3, 'z']])];
    const before = rowsFromEvents(events, NOW - 7 * HOUR).map((r) => r.id).sort();
    const after = rowsFromEvents(events, NOW).map((r) => r.id);
    assert.ok(after.length && after.every((id) => before.includes(id)));
});

test('playing a row is what is on it now, else what is next', () => {
    const events = [
        Object.assign(event('L : On', -1, [[1, 'x']]), { id: '1:on' }),
        Object.assign(event('L : Next', 3, [[2, 'y']]), { id: '2:next' }),
    ];
    const { id } = rowsFromEvents(events, NOW)[0];
    assert.strictEqual(rowEventId(events, id, NOW), '1:on');
    assert.strictEqual(rowEventId(events, id, NOW + 3.5 * HOUR), '2:next');
    assert.strictEqual(rowEventId(events, 'daddylive:row:nope:1', NOW), null);
    assert.strictEqual(rowMeta(events, id, NOW).name, 'L');
});

test('a YouTube channel without anything on is still a channel', () => {
    const channel = channelFromYoutube({ id: 'ytlive:channel:x', name: 'X', genre: 'Motorsport' }, [], new Map(), NOW);
    assert.deepStrictEqual(channel.programmes, []);
    assert.deepStrictEqual(channel.genres, ['Motorsport']);
});

test('a live stream starts at its scheduled time when that was seen, else when first seen', () => {
    const starts = new Map();
    const row = { id: 'y', name: 'Y' };
    channelFromYoutube(row, [{ id: 'a', title: 'A', status: 'upcoming', scheduledTs: NOW - HOUR }], starts, NOW - 2 * HOUR);
    assert.strictEqual(channelFromYoutube(row, [{ id: 'a', title: 'A', status: 'live' }], starts, NOW).programmes[0].start, NOW - HOUR);
    const first = channelFromYoutube(row, [{ id: 'b', title: 'B', status: 'live' }], starts, NOW).programmes[0].start;
    assert.ok(first < NOW && first > NOW - HOUR);
    assert.strictEqual(channelFromYoutube(row, [{ id: 'b', title: 'B', status: 'live' }], starts, NOW + HOUR).programmes[0].start, first);
});

test('a long-running live stream stays on now', () => {
    const starts = new Map([['a', NOW - 10 * HOUR]]);
    const [on] = channelFromYoutube({ id: 'y', name: 'Y' }, [{ id: 'a', title: 'A', status: 'live' }], starts, NOW).programmes;
    assert.ok(on.start <= NOW && on.end > NOW);
});

test('streams live together share a block; a late upcoming one is left out, a later one ends it', () => {
    const items = [
        { id: 'a', title: 'Most watched', status: 'live', viewers: 900 },
        { id: 'b', title: 'Other', status: 'live', viewers: 10 },
        { id: 'late', title: 'Should have started', status: 'upcoming', scheduledTs: NOW - HOUR },
        { id: 'c', title: 'Tonight', status: 'upcoming', scheduledTs: NOW + HOUR },
    ];
    const { programmes } = channelFromYoutube({ id: 'y', name: 'Y' }, items, new Map(), NOW);
    assert.deepStrictEqual(programmes.map((p) => p.title), ['Most watched (+1 more live)', 'Tonight']);
    assert.strictEqual(programmes[0].end, NOW + HOUR);
    assert.strictEqual(programmes[0].description, '900 watching');
});

const dlEvent = (title, category, channels = 1) => ({
    title, category, start: NOW, end: NOW + HOUR, until: NOW + 3 * HOUR, rough: false, playFrom: NOW - HOUR,
    channels: Array.from({ length: channels }, (_, i) => ({ channel: i + 1, name: `c${i}` })),
});

test('an event card has its title apart from its competition, without flags and icons', () => {
    const e = eventFields(dlEvent('⚽ Spain - La Liga : Osasuna 🇪🇸 vs Athletic Club 🇪🇸', 'All Soccer Events ⚽', 4));
    assert.strictEqual(e.title, 'Osasuna vs Athletic Club');
    assert.strictEqual(e.competition, 'Spain - La Liga');
    assert.strictEqual(e.icon, '⚽');
    assert.strictEqual(e.detail, '4 sources');
});

test('flags made of invisible characters leave nothing behind', () => {
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    assert.strictEqual(eventFields(dlEvent(`⚽ England - Championship : Bristol City ${england} vs Norwich City ${england}`, 'x')).title, 'Bristol City vs Norwich City');
});

test('an event card runs until the event stops counting as running', () => {
    const e = eventFields(dlEvent('🏎️ Moto2 | Race', 'Motorsport 🏎️🏁'));
    assert.strictEqual(e.title, 'Race');
    assert.strictEqual(e.competition, 'Moto2');
    assert.strictEqual(e.end, NOW + 3 * HOUR);
    assert.strictEqual(e.playFrom, NOW - HOUR);
    assert.strictEqual(e.detail, undefined);
});

test('a title that is only a competition gets its sport as competition', () => {
    const e = eventFields(dlEvent('🏇 Live racing from Wincanton', 'Horse Racing 🏇'));
    assert.strictEqual(e.title, 'Live racing from Wincanton');
    assert.strictEqual(e.competition, 'Horse Racing');
});

test('a YouTube stream on a schedule, and one past it that has not begun', () => {
    const upcoming = youtubeEventFields({ id: 'a', title: 'A', status: 'upcoming', scheduledTs: NOW + HOUR }, 'iRacing', new Map(), NOW);
    assert.strictEqual(upcoming.start, NOW + HOUR);
    assert.strictEqual(upcoming.playFrom, NOW + HOUR);
    assert.strictEqual(upcoming.competition, 'iRacing');
    assert.strictEqual(youtubeEventFields({ id: 'a', title: 'A', status: 'upcoming', scheduledTs: NOW - HOUR }, 'iRacing', new Map(), NOW), null);
});

test('a live YouTube stream has rough times and stays on now', () => {
    const e = youtubeEventFields({ id: 'a', title: 'A', status: 'live', viewers: 1200 }, 'iRacing', new Map([['a', NOW - 10 * HOUR]]), NOW);
    assert.ok(e.start <= NOW && e.end > NOW);
    assert.strictEqual(e.rough, true);
    assert.strictEqual(e.detail, '1,200 watching');
});

test('a finished YouTube video is no event', () => {
    assert.strictEqual(youtubeEventFields({ id: 'a', title: 'A', status: 'past' }, 'iRacing', new Map(), NOW), null);
});
