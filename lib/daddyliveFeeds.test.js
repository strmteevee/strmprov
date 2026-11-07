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
