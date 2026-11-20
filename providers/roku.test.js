// Run with: node providers/roku.test.js
const assert = require('assert');
const { hitsIn, freeOption, episodesIn, isAskedEpisode, relayDescription, segmentAddress } = require('./roku');

// ---- a search answer: only what Roku itself offers for free ----
const search = {
    view: [
        { content: { type: 'series', title: 'Monk', releaseYear: 2002, meta: { id: 'a'.repeat(32) }, viewOptions: [{ providerId: 'rokuavod' }] } },
        { content: { type: 'movie', title: 'Monkey Shines', releaseDate: '1988-07-29T00:00:00Z', meta: { id: 'b'.repeat(32) }, viewOptions: [{ providerId: 'epix' }] } },
        { content: { type: 'movie', title: 'Monkey Trouble', releaseDate: '1994-03-18T00:00:00Z', meta: { id: 'c'.repeat(32) }, viewOptions: [{ providerId: 'rokusvod' }, { providerId: 'rokuavod' }] } },
        { content: { type: 'zone', title: 'Video Games', meta: { id: 'w.x' } } },
        { content: null }
    ]
};
assert.deepStrictEqual(hitsIn(search), [
    { id: 'a'.repeat(32), kind: 'series', name: 'Monk', year: 2002 },
    { id: 'c'.repeat(32), kind: 'movie', name: 'Monkey Trouble', year: 1994 }
]);
assert.deepStrictEqual(hitsIn(null), []);
assert.deepStrictEqual(hitsIn({}), []);

// ---- a title's free way of watching ----
const film = {
    viewOptions: [
        { providerId: 'rokusvod', playId: 's-x', price: 0 },
        {
            providerId: 'rokuavod', playId: 's-nbcu.abc', price: 0, license: 'Free', inHd: true, in4k: false, hasMedia: true,
            media: { captions: [{ language: 'en-US', url: 'https://static-delivery.sr.roku.com/x/captions/a_cc_en-us.vtt' }, { language: 'en-US', url: 'https://static-delivery.sr.roku.com/x/captions/a.dfxp' }] }
        }
    ]
};
assert.deepStrictEqual(freeOption(film), {
    playId: 's-nbcu.abc', providerId: 'rokuavod', quality: '1080p',
    subtitles: [{ url: 'https://static-delivery.sr.roku.com/x/captions/a_cc_en-us.vtt', lang: 'en' }]
});
assert.strictEqual(freeOption({ viewOptions: [{ providerId: 'rokuavod', playId: 'p', in4k: true }] }).quality, '2160p');
assert.strictEqual(freeOption({ viewOptions: [{ providerId: 'rokuavod', playId: 'p' }] }).quality, '480p');
// Only a subscription, nothing to play, or a price: not free.
assert.strictEqual(freeOption({ viewOptions: [{ providerId: 'rokusvod', playId: 'p' }] }), null);
assert.strictEqual(freeOption({ viewOptions: [{ providerId: 'rokuavod', playId: 'p', hasMedia: false }] }), null);
assert.strictEqual(freeOption({ viewOptions: [{ providerId: 'rokuavod', playId: 'p', price: 3.99 }] }), null);
assert.strictEqual(freeOption({ viewOptions: [{ providerId: 'rokuavod' }] }), null);
assert.strictEqual(freeOption({}), null);

// ---- a series' episodes ----
const series = {
    episodes: [
        { meta: { id: 'e1', seasonNumber: 1, episodeNumber: 1 } },
        { meta: { id: 'e2', seasonNumber: 1, episodeNumber: 2 } },
        { meta: { id: 'e3', seasonNumber: 2, episodeNumber: 1 } },
        { meta: { id: 'special' } },
        {}
    ]
};
const episodes = episodesIn(series);
assert.deepStrictEqual(episodes, [{ id: 'e1', season: 1, episode: 1 }, { id: 'e2', season: 1, episode: 2 }, { id: 'e3', season: 2, episode: 1 }]);
assert.deepStrictEqual(episodesIn({}), []);

// ---- is the episode at the asked numbers the asked one? ----
// The same title.
assert.strictEqual(isAskedEpisode({ title: 'Mr. Monk and the Psychic' }, episodes, { season: 1, episodeTitle: 'Mr. Monk and the Psychic', siblings: [{}, {}, {}] }), true);
// Named differently, but Roku's season is as long as the asked one: the numbers mean the same.
assert.strictEqual(isAskedEpisode({ title: 'Mr. Monk Meets the Candidate, Part 1' }, episodes, { season: 1, episodeTitle: 'Mr. Monk and the Candidate (1)', siblings: [{}, {}] }), true);
// Named differently and the seasons are cut differently: not it.
assert.strictEqual(isAskedEpisode({ title: 'Something Else' }, episodes, { season: 1, episodeTitle: 'Mr. Monk and the Candidate (1)', siblings: [{}, {}, {}, {}] }), false);
// An asked episode without a title of its own: the numbers decide.
assert.strictEqual(isAskedEpisode({ title: 'Whatever' }, episodes, { season: 1, episodeTitle: 'Episode 2', siblings: [{}, {}, {}, {}] }), true);

// ---- the description, its video pointed at this server ----
const base = 'http://192.168.50.252:3100';
const absolute = '<MPD><Period><AdaptationSet>' +
    '<SegmentTemplate initialization="https://vod2.delivery.roku.com/id/dash/a_v_init.mp4" media="https://vod2.delivery.roku.com/id/dash/a_v_$Number%09d$.mp4?x=1&amp;y=2" startNumber="1"/>' +
    '</AdaptationSet></Period></MPD>';
const relayed = relayDescription(absolute, 'https://vod-playlist.sr.roku.com/1.mpd?origin=x', base);
assert.ok(relayed.includes(`initialization="${base}/roku/seg/vod2.delivery.roku.com/id/dash/a_v_init.mp4"`));
// The player's own placeholders stay, and "&" stays written the XML way.
assert.ok(relayed.includes(`media="${base}/roku/seg/vod2.delivery.roku.com/id/dash/a_v_$Number%09d$.mp4?x=1&amp;y=2"`));
assert.ok(!/="https:\/\/vod2/.test(relayed));

// Short addresses, meant beside the description's own: written out, through this server.
const beside = '<MPD type="static"><Period><AdaptationSet><SegmentTemplate initialization="v_init.mp4" media="v_$Number$.mp4"/></AdaptationSet></Period></MPD>';
const relayedBeside = relayDescription(beside, 'https://vod.delivery.roku.com/a/b/index.mpd', base);
assert.ok(relayedBeside.includes(`initialization="${base}/roku/seg/vod.delivery.roku.com/a/b/v_init.mp4"`));
assert.ok(relayedBeside.includes(`media="${base}/roku/seg/vod.delivery.roku.com/a/b/v_$Number$.mp4"`));

// With a BaseURL: that one is pointed at this server and the short addresses follow it as they are.
const withBase = relayDescription('<MPD><BaseURL>https://vod.delivery.roku.com/a/</BaseURL><SegmentTemplate initialization="v_init.mp4"/></MPD>', 'https://vod-playlist.sr.roku.com/1.mpd', base);
assert.ok(withBase.includes(`<BaseURL>${base}/roku/seg/vod.delivery.roku.com/a/</BaseURL>`));
assert.ok(withBase.includes('initialization="v_init.mp4"'));
// A BaseURL that isn't Roku's is left alone.
assert.ok(relayDescription('<MPD><BaseURL>https://elsewhere.example/a/</BaseURL></MPD>', 'https://vod-playlist.sr.roku.com/1.mpd', base)
    .includes('<BaseURL>https://elsewhere.example/a/</BaseURL>'));

// ---- a request for a piece of video: only Roku's own hosts ----
assert.strictEqual(segmentAddress('vod2.delivery.roku.com/id/dash/a_v_000000001.mp4', '?x=1&y=2'), 'https://vod2.delivery.roku.com/id/dash/a_v_000000001.mp4?x=1&y=2');
assert.strictEqual(segmentAddress('vod.delivery.roku.com/a/b.mp4', ''), 'https://vod.delivery.roku.com/a/b.mp4');
assert.strictEqual(segmentAddress('evil.example/a/b.mp4', ''), null);
assert.strictEqual(segmentAddress('roku.com.evil.example/a.mp4', ''), null);
assert.strictEqual(segmentAddress('vod.delivery.roku.com', ''), null);
assert.strictEqual(segmentAddress('user@vod.delivery.roku.com/a.mp4', ''), null);
assert.strictEqual(segmentAddress('', ''), null);

console.log('roku.test.js: all passed');
