// node --test lib/daddyliveFeeds.test.js
const test = require('node:test');
const assert = require('node:assert');
const { feedsOnAir } = require('../providers/daddylive')._parse;
const { sportOf } = require('./liveGuide');

const HOUR = 60 * 60 * 1000;
const NOW = 1000 * HOUR;
const event = (hours, ...channels) => ({ ts: NOW + hours * HOUR, channels: channels.map((channel) => ({ channel, name: `ch${channel}` })) });
const onAir = (ev, events) => feedsOnAir(ev, events, NOW).map((f) => f.channel);

test('an event that is hours away has no sources yet', () => {
    assert.deepStrictEqual(onAir(event(2, 1, 2), []), []);
});

test('an event about to start offers its feeds', () => {
    assert.deepStrictEqual(onAir(event(0.2, 1, 2), []), [1, 2]);
});

test('a channel that moved on to a later event is no source any more', () => {
    const match = event(-2, 1, 2);
    assert.deepStrictEqual(onAir(match, [match, event(-0.5, 2)]), [1]);
});

test('a later event that has not started yet leaves the channel alone', () => {
    const match = event(-2, 1, 2);
    assert.deepStrictEqual(onAir(match, [match, event(1, 2)]), [1, 2]);
});

test('events starting at the same time both keep the channel', () => {
    const a = event(-1, 1);
    assert.deepStrictEqual(onAir(a, [a, event(-1, 1)]), [1]);
});

test('every feed moved on leaves nothing to offer', () => {
    const match = event(-2, 1);
    assert.deepStrictEqual(onAir(match, [match, event(-1, 1)]), []);
});

test('without a known start nothing is ruled out', () => {
    assert.deepStrictEqual(feedsOnAir({ ts: 0, channels: [{ channel: 1 }] }, [event(-1, 1)], NOW).map((f) => f.channel), [1]);
});

test('the sport comes from the title emoji before the category', () => {
    assert.strictEqual(sportOf('Rugby Union 🏉', '🏒 Russia KHL : A vs B'), 'Ice Hockey');
    assert.strictEqual(sportOf('Upcoming Events', '🎾🇫🇷 Rolex Paris Masters'), 'Tennis');
});

test('without a known emoji in the title the category decides', () => {
    assert.strictEqual(sportOf('Rugby Union 🏉', 'A vs B'), 'Rugby');
    assert.strictEqual(sportOf('Squash 🏸', '🏸 Open : A vs B'), 'Squash');
    assert.strictEqual(sportOf('All Soccer Events ⚽'), 'Soccer');
});

const { eventLengthMs, hasStream } = require('../providers/daddylive')._parse;
const { rowsFromEvents, rowEventId } = require('./liveGuide');

test('a practice session is far shorter than a full broadcast', () => {
    assert.strictEqual(eventLengthMs({ title: '🏎️ Moto2 | Round 20 | Qatar Free Practice 2', category: 'Motorsport 🏎️🏁' }), HOUR);
    assert.strictEqual(eventLengthMs({ title: '🏎️ Moto2 | Round 20 | Qatar Qualifying' }), 1.25 * HOUR);
    assert.strictEqual(eventLengthMs({ title: '⚽ Spain - La Liga : A vs B', category: 'All Soccer Events ⚽' }), 2.5 * HOUR);
});

test('the title emoji decides the length before a wrong category', () => {
    assert.strictEqual(eventLengthMs({ title: '🏒 Russia KHL : A vs B', category: 'Rugby Union 🏉' }), 3 * HOUR);
    assert.strictEqual(eventLengthMs({ title: 'A vs B', category: 'Rugby Union 🏉' }), 2.5 * HOUR);
    assert.strictEqual(eventLengthMs({ title: '🎾 Open : A vs B', category: 'Tennis 🎾' }), 3 * HOUR);
});

test('a session that is over offers no feeds, with nothing else scheduled', () => {
    const fp = Object.assign(event(-2, 32), { title: '🏎️ Moto2 | Qatar Free Practice 2' });
    assert.deepStrictEqual(onAir(fp, [fp]), []);
});

const probes = (entries) => new Map(entries.map(([channel, playable]) => [channel, { playable }]));

test('an event is playable unless every feed is known to have no stream', () => {
    const ev = event(2, 1, 2);
    assert.strictEqual(hasStream(ev, [ev], NOW, probes([])), true);
    assert.strictEqual(hasStream(ev, [ev], NOW, probes([[1, false], [2, null]])), true);
    assert.strictEqual(hasStream(ev, [ev], NOW, probes([[1, false], [2, true]])), true);
    assert.strictEqual(hasStream(ev, [ev], NOW, probes([[1, false], [2, false]])), false);
});

test('a running event needs a playable feed that is still showing it', () => {
    const match = event(-2, 1, 2);
    const later = event(-1, 2);
    assert.strictEqual(hasStream(match, [match, later], NOW, probes([[1, false], [2, true]])), false);
    assert.strictEqual(hasStream(match, [match, later], NOW, probes([[1, true], [2, true]])), true);
});

test('the guide leaves out what has no stream, without renumbering rows', () => {
    const ev = (id, title, hours, playable) => ({ id, title, start: NOW + hours * HOUR, end: NOW + (hours + 1) * HOUR, category: 'x', channels: [{ channel: 1, name: 'n' }], playable });
    const events = [ev('a', 'League : A', 1, false), ev('b', 'League : B', 1, true), ev('c', 'Solo : C', 1, false)];
    const rows = rowsFromEvents(events, NOW);
    assert.deepStrictEqual(rows.map((r) => r.programmes.map((p) => p.title)), [['B']]);
    assert.strictEqual(rows[0].programmes[0].playable, undefined);
    assert.strictEqual(rowEventId(events, rows[0].id, NOW), 'b');
    const all = rowsFromEvents(events.map((e) => Object.assign({}, e, { playable: true })), NOW);
    assert.ok(all.some((r) => r.id === rows[0].id && r.programmes[0].title === 'B'), 'same id once everything is playable');
});

const { usableEmbed } = require('../providers/daddylive')._parse;

test('a player page counts when its embed is one we can use', () => {
    const page = (src) => `<iframe id="thatframe" src="${src}"></iframe>`;
    const url = 'https://site.example/cast/stream-1.php';
    assert.strictEqual(usableEmbed(page('https://tossequip.net/e/abc'), url), true);
    assert.strictEqual(usableEmbed(page('https://www.ksohls.ru/premiumtv/daddy.php?id=1'), url), false);
    assert.strictEqual(usableEmbed(page('/premiumtv/daddylive.php?id=1'), url), false);
    assert.strictEqual(usableEmbed(page('https://embedsports.me/atp-tour/a-vs-b-stream-1'), url), false);
    assert.strictEqual(usableEmbed('<p>nothing here</p>', url), false);
});
