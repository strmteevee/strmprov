// node --test lib/regularTitle.test.js
const test = require('node:test');
const assert = require('node:assert');
const { choose, sameSeason } = require('./regularTitle');

const r = (o) => Object.assign({ vote_count: 100, genre_ids: [] }, o);

test('one title with the name is it', () => {
    const results = [r({ id: 1, title: 'Pretty Woman', release_date: '1990-03-23' }), r({ id: 2, title: 'Pretty Woman 2' })];
    assert.strictEqual(choose(results, { name: 'Pretty Woman' }).id, 1);
    assert.strictEqual(choose(results, { name: 'Ugly Woman' }), null);
});

test('a year in the name or given picks among remakes', () => {
    const results = [r({ id: 1, title: 'A Star Is Born', release_date: '2018-10-03' }), r({ id: 2, title: 'A Star Is Born', release_date: '1976-12-17' }), r({ id: 3, title: 'A Star Is Born', release_date: '1954-10-01' })];
    assert.strictEqual(choose(results, { name: 'A Star Is Born (2018)' }).id, 1);
    assert.strictEqual(choose(results, { name: 'A Star Is Born', year: '1976' }).id, 2);
    assert.strictEqual(choose(results, { name: 'A Star Is Born', year: 1999 }), null);
});

test('a title filed under anime is the animated one of two with the name', () => {
    const results = [
        r({ id: 37854, name: 'One Piece', first_air_date: '1999-10-20', vote_count: 5655, genre_ids: [10759, 35, 16] }),
        r({ id: 111110, name: 'ONE PIECE', first_air_date: '2023-08-31', vote_count: 2000, genre_ids: [10759, 10765] })
    ];
    assert.strictEqual(choose(results, { name: 'One Piece', genres: ['Anime'] }).id, 37854);
    // Without that to go by, neither stands out enough.
    assert.strictEqual(choose(results, { name: 'One Piece', genres: ['Drama'] }), null);
});

test('of several with the name only one that clearly leads is taken', () => {
    const lead = [r({ id: 1, title: 'Crash', vote_count: 4000 }), r({ id: 2, title: 'Crash', vote_count: 900 })];
    assert.strictEqual(choose(lead, { name: 'Crash' }).id, 1);
    const close = [r({ id: 1, title: 'Crash', vote_count: 4000 }), r({ id: 2, title: 'Crash', vote_count: 2500 })];
    assert.strictEqual(choose(close, { name: 'Crash' }), null);
    const obscure = [r({ id: 1, title: 'Hush', vote_count: 12 }), r({ id: 2, title: 'Hush', vote_count: 2 })];
    assert.strictEqual(choose(obscure, { name: 'Hush' }), null);
});

test('the original title counts as the name too', () => {
    const results = [r({ id: 5, title: 'Day of Anger', original_title: 'I giorni dell\'ira', release_date: '1967-12-19' })];
    assert.strictEqual(choose(results, { name: "I giorni dell'ira" }).id, 5);
});

test('what a service adds in brackets and a leading article are not part of the name', () => {
    const results = [r({ id: 1, name: 'Survivor', first_air_date: '2000-05-31' }), r({ id: 2, name: 'The Black Hamptons', first_air_date: '2022-08-25' })];
    assert.strictEqual(choose(results, { name: 'Survivor (Latest Episodes)' }).id, 1);
    assert.strictEqual(choose(results, { name: 'Black Hamptons' }).id, 2);
    // A year or a country in brackets says which title it is: it stays.
    assert.strictEqual(choose(results, { name: 'Survivor (1990)' }), null);
    assert.strictEqual(choose(results, { name: 'Survivor (AU)' }), null);
});

test('a season is the same when enough of its episode titles are', () => {
    const pluto = [{ title: 'Pilot' }, { title: 'Hello!' }, { title: 'Viking Funeral' }, { title: 'Dinner Party' }];
    const american = [{ name: 'Pilot' }, { name: 'Hello!' }, { name: 'Viking Funeral' }, { name: 'Dinner Party' }, { name: 'Halloween' }];
    const british = [{ name: 'Who Do You Think You Are?' }, { name: 'Gorilla War' }, { name: 'Happy Death Day' }];
    assert.strictEqual(sameSeason(pluto, american), true);
    assert.strictEqual(sameSeason(pluto, british), false);
    // One shared "Pilot" isn't enough, and numbered episodes say nothing.
    assert.strictEqual(sameSeason(pluto, [{ name: 'Pilot' }, { name: 'Something Else' }, { name: 'Another' }]), false);
    assert.strictEqual(sameSeason([{ title: 'Episode 1' }, { title: 'Episode 2' }], [{ name: 'Episode 1' }, { name: 'Episode 2' }]), false);
});
