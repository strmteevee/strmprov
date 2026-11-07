// node --test lib/liveGuide.test.js
const test = require('node:test');
const assert = require('node:assert');
const { channelsFromEvents, channelFromYoutube, fitProgrammes, sportOf } = require('./liveGuide');

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

test('an event is on every channel it has a feed on', () => {
    const channels = channelsFromEvents([event('Match', -1, [[1, 'One'], [2, 'Two']], 'Rugby Union 🏉')], NOW);
    assert.deepStrictEqual(channels.map((c) => c.id), ['daddylive:1', 'daddylive:2']);
    assert.strictEqual(channels[1].programmes[0].title, 'Match');
    assert.deepStrictEqual(channels[0].genres, ['Rugby']);
});

test('a channel holds its events in order, without overlap', () => {
    const [channel] = channelsFromEvents([event('Later', 2, [[1, 'One']]), event('First', 1, [[1, 'One']])], NOW);
    assert.deepStrictEqual(channel.programmes.map((p) => p.title), ['First', 'Later']);
    assert.strictEqual(channel.programmes[0].end, channel.programmes[1].start);
});

test('channels with something on come first, then what starts soonest', () => {
    const channels = channelsFromEvents([
        event('Soon', 1, [[1, 'Soon']]), event('Later', 5, [[2, 'Later']]), event('On', -1, [[3, 'On']]),
    ], NOW);
    assert.deepStrictEqual(channels.map((c) => c.name), ['On', 'Soon', 'Later']);
});

test('feeds sharing a name each stay their own channel', () => {
    const channels = channelsFromEvents([event('A', 1, [[7, 'Event Stream']]), event('B', 2, [[8, 'Event Stream']]), event('C', 3, [[9, 'Sky']])], NOW);
    assert.deepStrictEqual(channels.map((c) => c.name), ['Event Stream 7', 'Event Stream 8', 'Sky']);
});

test('events without a time or too far ahead stay out', () => {
    assert.deepStrictEqual(channelsFromEvents([event('Far', 30, [[1, 'One']]), { title: 'None', start: 0, channels: [{ channel: 2, name: 'Two' }] }], NOW), []);
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
    assert.strictEqual(channelFromYoutube(row, [{ id: 'b', title: 'B', status: 'live' }], starts, NOW).programmes[0].start, NOW);
    assert.strictEqual(channelFromYoutube(row, [{ id: 'b', title: 'B', status: 'live' }], starts, NOW + HOUR).programmes[0].start, NOW);
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
