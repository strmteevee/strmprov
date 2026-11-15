// node --test lib/hlsContentOnly.test.js
const test = require('node:test');
const assert = require('node:assert');
const { contentOnly } = require('./hlsContentOnly');

const BASE = 'https://stitcher.example/v2/stitch/hls/episode/abc/1080/playlist.m3u8';
const film = (n) => `https://cdn.example/206_dist/clip/film123_uuid/1080/seg${n}.ts`;
const ad = (folder, n) => `https://cdn.example/${folder}/ad${n}.ts`;
const KEY_FILM = '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/206_dist/clip/film123_uuid/key"';
const KEY_NONE = '#EXT-X-KEY:METHOD=NONE';

// A playlist of [parts]: ['film', count] or ['ad', folder, count], 10 s a segment, a discontinuity between parts.
function playlist(parts, { live } = {}) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
    let n = 0;
    parts.forEach(([kind, a, b], i) => {
        if (i) lines.push('#EXT-X-DISCONTINUITY');
        lines.push('#EXT-X-PROGRAM-DATE-TIME:2026-11-16T10:00:00.000Z');
        const count = kind === 'film' ? a : b;
        for (let k = 0; k < count; k++) {
            lines.push(kind === 'film' ? KEY_FILM : KEY_NONE, '#EXTINF:10.000,', kind === 'film' ? film(n++) : ad(a, n++));
        }
    });
    if (!live) lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
}

const segmentsOf = (text) => text.split('\n').filter(l => l && !l.startsWith('#'));

test('advert breaks are left out, the film stays whole and in order', () => {
    const text = playlist([['film', 20], ['ad', 'v1/mp4', 3], ['ad', 'mp4/v1', 2], ['film', 15], ['ad', '0_ad/creative', 3], ['film', 10]]);
    const r = contentOnly(text, BASE);
    const segs = segmentsOf(r.text);
    assert.strictEqual(segs.length, 45);
    assert.ok(segs.every(s => s.includes('/206_dist/clip/film123_uuid/')));
    assert.deepStrictEqual(segs, segmentsOf(text).filter(s => s.includes('film123')));
    assert.strictEqual(r.keptSeconds, 450);
    assert.strictEqual(r.removedSeconds, 80);
    assert.strictEqual(r.breaks, 2);
});

test('a discontinuity marks each left-out break, and only those', () => {
    const r = contentOnly(playlist([['ad', 'v1/mp4', 2], ['film', 20], ['ad', 'v1/mp4', 3], ['film', 15]]), BASE);
    assert.strictEqual((r.text.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1);
    // Not before the first segment (a pre-roll left out needs none).
    assert.ok(r.text.indexOf('#EXT-X-DISCONTINUITY\n') > r.text.indexOf('seg2.ts'));
    assert.ok(!r.text.includes('PROGRAM-DATE-TIME'));
    assert.ok(r.text.trimEnd().endsWith('#EXT-X-ENDLIST'));
    assert.ok(r.text.startsWith('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD'));
});

test('the film keeps its key after an unencrypted break', () => {
    const r = contentOnly(playlist([['film', 20], ['ad', 'v1/mp4', 3], ['film', 15]]), BASE);
    assert.ok(!r.text.includes('METHOD=NONE'));
    // Once is enough: the same key is in effect for every film segment.
    assert.strictEqual((r.text.match(/#EXT-X-KEY/g) || []).length, 1);
    assert.ok(r.text.indexOf(KEY_FILM) < r.text.indexOf('seg0.ts'));
});

test('header tags that come after the first key stay in the header', () => {
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', KEY_FILM, '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:10,', film(0), '#EXTINF:10,', film(1), '#EXTINF:10,', film(2),
        '#EXT-X-DISCONTINUITY', KEY_NONE, '#EXTINF:10,', ad('v1/mp4', 0), '#EXT-X-ENDLIST'].join('\n');
    const lines = contentOnly(text, BASE).text.split('\n');
    assert.deepStrictEqual(lines.slice(0, 6), ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:0', KEY_FILM, '#EXTINF:10,']);
});

test('a live playlist is left as it is', () => {
    const text = playlist([['film', 20], ['ad', 'v1/mp4', 3]], { live: true });
    assert.strictEqual(contentOnly(text, BASE).text, text);
});

test('a playlist without a clear programme is left as it is', () => {
    // Three sources of about the same length: nothing makes up 60%.
    const text = playlist([['ad', 'a/b', 10], ['film', 12], ['ad', 'c/d', 10]]);
    const r = contentOnly(text, BASE);
    assert.strictEqual(r.text, text);
    assert.strictEqual(r.removedSeconds, 0);
});

test('a playlist that is all programme is left as it is', () => {
    const text = playlist([['film', 30]]);
    assert.strictEqual(contentOnly(text, BASE).text, text);
});

test('relative segment addresses are grouped by the playlist they belong to', () => {
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10,', 'film/part/a1.ts', '#EXTINF:10,', 'film/part/a2.ts', '#EXTINF:10,', 'film/part/a3.ts',
        '#EXT-X-DISCONTINUITY', '#EXTINF:10,', 'https://ads.example/x/y/ad.ts',
        '#EXT-X-DISCONTINUITY', '#EXTINF:10,', 'film/part/a4.ts', '#EXT-X-ENDLIST'].join('\n');
    const r = contentOnly(text, BASE);
    assert.deepStrictEqual(segmentsOf(r.text), ['film/part/a1.ts', 'film/part/a2.ts', 'film/part/a3.ts', 'film/part/a4.ts']);
});

test('the sound is cut where the picture is, even when an advert has its sound where the film has it', () => {
    const { programmeRanges } = require('./hlsContentOnly');
    const picture = playlist([['film', 20], ['ad', 'v1/mp4', 3], ['ad', '7_ad/creative', 6], ['film', 15]]);
    // The sound: the film's and the "7_ad" advert's both under /v1/jit, the other advert elsewhere.
    const sound = (n) => `https://cdn.example/v1/jit/a${n}.ts`;
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10'];
    let n = 0;
    [[20, sound], [3, (k) => ad('v1/mp4', k)], [6, sound], [15, sound]].forEach(([count, uri], i) => {
        if (i) lines.push('#EXT-X-DISCONTINUITY');
        for (let k = 0; k < count; k++) lines.push('#EXTINF:10.000,', uri(n++));
    });
    lines.push('#EXT-X-ENDLIST');
    const text = lines.join('\n');

    // Judged by itself the advert's sound would stay (41 segments).
    assert.strictEqual(segmentsOf(contentOnly(text, BASE).text).length, 41);
    const ranges = programmeRanges(picture, BASE);
    assert.deepStrictEqual(ranges, [{ start: 0, end: 200 }, { start: 290, end: 440 }]);
    const r = contentOnly(text, BASE, ranges);
    const segs = segmentsOf(r.text);
    assert.strictEqual(segs.length, 35);
    assert.deepStrictEqual(segs.slice(18, 22), [sound(18), sound(19), sound(29), sound(30)]);
    assert.strictEqual(r.keptSeconds, 350);
    assert.strictEqual((r.text.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1);
});

test('no ranges to go by (the picture is all programme, or live) leaves the sound as it is', () => {
    const text = playlist([['film', 20], ['ad', 'v1/mp4', 3]]);
    assert.strictEqual(contentOnly(text, BASE, null).text, text);
});
