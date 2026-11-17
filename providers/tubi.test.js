// node --test providers/tubi.test.js
const test = require('node:test');
const assert = require('node:assert');
const { addressNames, filmIn, seriesIn, seasonListIn, streamOf, isTitle, episodeTitle, sameEpisode } = require('./tubi');

const pageOf = (id, film) => `<script>window.__data={"auth":{"x":undefined},"video":{"byId":{"7":{"id":"7","video_resources":[]},"${id}":${JSON.stringify(Object.assign({ id, video_resources: [] }, film))}}}};</script>`;
const plain = { type: 'hlsv6', resolution: '720P', manifest: { url: 'https://nc.tubi.video/a/b.m3u8?token=t', duration: 100 } };
// As a protected title has them: one that wants a protected screen connection, one that doesn't; H.265 and H.264; other systems too.
const guarded = { type: 'hlsv6_widevine_nonclearlead', codec: 'H264', resolution: '720P', manifest: { url: 'https://nc.tubi.video/a/c.m3u8' }, license_server: { url: 'https://license.example/x?hd', hdcp_version: 'hdcp_v1' } };
const guardedAnyScreen = { type: 'hlsv6_widevine_nonclearlead', codec: 'H264', resolution: '576P', manifest: { url: 'https://nc.tubi.video/a/d.m3u8' }, license_server: { url: 'https://license.example/x?sd', hdcp_version: 'hdcp_disabled' } };
const guardedHevc = Object.assign({}, guardedAnyScreen, { codec: 'H265', manifest: { url: 'https://nc.tubi.video/a/e.m3u8' } });
const playready = Object.assign({}, guardedAnyScreen, { type: 'hlsv6_playready_psshv0', manifest: { url: 'https://nc.tubi.video/a/f.m3u8' } });

test('a title as Tubi writes it in an address, an apostrophe and "&" both ways', () => {
    assert.deepStrictEqual(addressNames(['Dauntless: The Battle of Midway']), ['dauntless-the-battle-of-midway']);
    assert.ok(addressNames(["Daddy's Home"]).includes('daddys-home'));
    assert.ok(addressNames(["Daddy's Home"]).includes('daddy-s-home'));
    assert.ok(addressNames(['Love & Basketball']).includes('love-and-basketball'));
    assert.ok(addressNames(['Love & Basketball']).includes('love-basketball'));
    assert.deepStrictEqual(addressNames(['Am\u00e9lie', null, '']), ['amelie']);
});

test('a film page gives the film, its plain stream and its subtitles', () => {
    const html = pageOf('42', { imdb_id: 'tt0000042', title: 'A "Quoted" Film', year: 1999, needs_login: false, video_resources: [guarded, plain], subtitles: [{ url: 'http://s.example/a.srt', lang: 'English', lang_alpha3: 'eng' }] });
    const film = filmIn(html, '42');
    assert.strictEqual(film.imdbId, 'tt0000042');
    assert.strictEqual(film.title, 'A "Quoted" Film');
    const [stream] = streamOf(film);
    assert.strictEqual(stream.url, plain.manifest.url);
    assert.strictEqual(stream.quality, '720p');
    assert.strictEqual(stream.official, true);
    assert.deepStrictEqual(stream.subtitles, [{ url: 'http://s.example/a.srt', lang: 'eng' }]);
    assert.strictEqual(filmIn(html, '43'), null);
});

test('a film only offered protected gives its Widevine streams with their licence address, the better picture first', () => {
    const streams = streamOf(filmIn(pageOf('1', { video_resources: [guardedHevc, guardedAnyScreen, playready, guarded] }), '1'));
    assert.deepStrictEqual(streams.map(s => [s.url, s.quality, s.drm.widevine.licenseUrl]), [
        [guarded.manifest.url, '720p', 'https://license.example/x?hd'],
        [guardedAnyScreen.manifest.url, '576p', 'https://license.example/x?sd']
    ]);
    assert.deepStrictEqual(streams[0].behaviorHints.drm, streams[0].drm);
    // The plain stream alone where its picture is as good as the protected ones', without a licence.
    const free = streamOf(filmIn(pageOf('1', { video_resources: [guardedAnyScreen, guarded, plain] }), '1'));
    assert.strictEqual(free.length, 1);
    assert.strictEqual(free[0].url, plain.manifest.url);
    assert.strictEqual(free[0].drm, undefined);
    // A plain stream with a lesser picture: the protected one with the better picture first, the plain one after it.
    const low = Object.assign({}, plain, { type: 'hlsv3', resolution: '480P', manifest: { url: 'https://nc.tubi.video/a/low.m3u8' } });
    const both = streamOf(filmIn(pageOf('1', { video_resources: [guarded, playready, low] }), '1'));
    assert.deepStrictEqual(both.map(x => [x.quality, !!x.drm]), [['720p', true], ['480p', false]]);
    // Only another system, or a codec not every TV plays: nothing.
    assert.deepStrictEqual(streamOf(filmIn(pageOf('1', { video_resources: [guardedHevc, playready] }), '1')), []);
});

test('a film for signed-in viewers only gives no stream', () => {
    assert.deepStrictEqual(streamOf(filmIn(pageOf('1', { needs_login: true, video_resources: [plain] }), '1')), []);
});

test('the IMDb id settles whether it is the asked title; without one, name and year, or name and the asked episode', () => {
    const wanted = { imdbId: 'tt1', titles: ['Alligator'], year: 1980 };
    assert.strictEqual(isTitle({ imdbId: 'tt1', title: 'Other name', year: 2001 }, wanted), true);
    assert.strictEqual(isTitle({ imdbId: 'tt2', title: 'Alligator', year: 1980 }, wanted), false);
    assert.strictEqual(isTitle({ imdbId: null, title: 'Alligator', year: 1981 }, wanted), true);
    assert.strictEqual(isTitle({ imdbId: null, title: 'Alligator', year: 2013 }, wanted), false);
    assert.strictEqual(isTitle({ imdbId: null, title: 'Alligator', year: null }, wanted), false);
    const episode = { imdbId: 'tt9', titles: ['Building in the Wild'], year: 2026, episodeTitle: 'Secret Cabin Construction' };
    assert.strictEqual(isTitle({ imdbId: null, title: 'Building in the Wild', year: null, episodes: [{ title: 'Secret Cabin Construction' }] }, episode), true);
    assert.strictEqual(isTitle({ imdbId: null, title: 'Building in the Wild', year: null, episodes: [{ title: 'Another' }] }, episode), false);
});

test('a series page gives its first season whole and lists the episodes of every season', () => {
    const series = { id: '0300', imdb_id: 'tt0000300', title: 'A Series', year: 1990, credit_cuepoints: null, seasons: [{ number: '1', title: 'Season 1', episodes: [
        { id: '11', episode_number: '1', title: 'S01:E01 - Pilot', needs_login: false, video_resources: [plain], subtitles: [] },
        { id: '12', episode_number: '2', title: 'S01:E02 - The Second One', video_resources: [guarded] }
    ] }] };
    // As the page writes it: a field without a value reads undefined.
    const html = `<script>window.__data={"video":{"byId":{"0300":${JSON.stringify(series).replace('"credit_cuepoints":null', '"credit_cuepoints":undefined')}}}};`
        + `{"state":{"data":{"seasons":[{"number":"1","episodes":[{"id":"11","num":1},{"id":"12","num":2}]},{"number":"2","episodes":[{"id":"21","num":1}]}]}},"queryKey":["seriesPaginationInfo","300"]}</script>`;
    const found = seriesIn(html, '300');
    assert.strictEqual(found.imdbId, 'tt0000300');
    assert.deepStrictEqual(found.episodes.map(e => [e.id, e.season, e.episode, e.title]), [['11', 1, 1, 'Pilot'], ['12', 1, 2, 'The Second One']]);
    assert.strictEqual(streamOf(found.episodes[0]).length, 1);
    // (The second episode is only offered protected: its Widevine stream.)
    assert.strictEqual(streamOf(found.episodes[1])[0].drm.widevine.licenseUrl, 'https://license.example/x?hd');
    assert.deepStrictEqual(seasonListIn(html), [{ id: '11', season: 1, episode: 1 }, { id: '12', season: 1, episode: 2 }, { id: '21', season: 2, episode: 1 }]);
    assert.deepStrictEqual(seasonListIn('<html></html>'), []);
});

test('an episode on its own page counts when its title is the asked one', () => {
    assert.strictEqual(episodeTitle('S03:E04 - Tonight, Tonight'), 'Tonight, Tonight');
    assert.strictEqual(sameEpisode('S03:E04 - Tonight, Tonight', 'Tonight, Tonight (1)'), true);
    assert.strictEqual(sameEpisode('S03:E04 - Tonight, Tonight', 'Stop in the Name of Love'), false);
    // An asked episode without a title of its own: the numbers decide.
    assert.strictEqual(sameEpisode('S03:E04 - Tonight, Tonight', 'Episode 4'), true);
});
