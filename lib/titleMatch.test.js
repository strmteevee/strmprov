// node --test lib/titleMatch.test.js
const test = require('node:test');
const assert = require('node:assert');
const { normalize, pickTitle, matchingTitles, pickEpisode } = require('./titleMatch');

test('names are compared without case, accents, punctuation or a year in brackets', () => {
    assert.strictEqual(normalize('A Star Is Born (2018)'), 'a star is born');
    assert.strictEqual(normalize('Amélie'), 'amelie');
    assert.strictEqual(normalize('Fast & Furious'), normalize('Fast and Furious'));
    assert.strictEqual(normalize("Hell's Kitchen (US)"), 'hell s kitchen us');
});

test('a title is found by its name, not by a longer one that starts the same', () => {
    const found = [{ name: 'One Piece - Skypiea Saga' }, { name: 'One Piece' }, { name: 'One On One' }];
    assert.strictEqual(pickTitle(found, { titles: ['One Piece', 'ワンピース'], year: 1999 }).name, 'One Piece');
    assert.strictEqual(pickTitle(found, { titles: ['One Piece Film: Red'] }), null);
});

test('a remake with another year is not the wanted film', () => {
    const found = [{ name: 'The Nutty Professor (1996)' }, { name: 'A Star Is Born (2018)' }];
    assert.strictEqual(pickTitle(found, { titles: ['A Star Is Born'], year: 1976 }), null);
    assert.strictEqual(pickTitle(found, { titles: ['A Star Is Born'], year: 2018 }).name, 'A Star Is Born (2018)');
    // A year off by one (release dates differ by country) is still the same film.
    assert.strictEqual(pickTitle(found, { titles: ['The Nutty Professor'], year: 1997 }).name, 'The Nutty Professor (1996)');
});

test('a candidate that says the right year goes before one that says none', () => {
    const found = [{ name: 'Crash' }, { name: 'Crash (2004)' }];
    assert.deepStrictEqual(matchingTitles(found, { titles: ['Crash'], year: 2004 }).map(c => c.name), ['Crash (2004)', 'Crash']);
});

// A service's own cut of a series: its second season starts four episodes earlier than the asker's.
const videos = [
    { season: 1, episode: 1, title: "I'm Luffy! The Man Who's Gonna Be King of the Pirates!" },
    { season: 1, episode: 2, title: 'Enter the Great Swordsman! Pirate Hunter Roronoa Zoro!' },
    { season: 1, episode: 3, title: "Morgan versus Luffy! Who's the Mysterious Pretty Girl?" },
    { season: 1, episode: 4, title: "Luffy's Past! Enter Red-Haired Shanks!" },
    { season: 2, episode: 1, title: 'Showdown in the Ruins! Tense Zoro vs. Eric!' },
    { season: 2, episode: 2, title: 'The First Line of Defense? The Giant Whale Laboon Appears!' },
    { season: 2, episode: 3, title: 'A Promise Between Men! Luffy and the Whale Vow to Meet Again!' }
];

test('an episode goes by its title, not by numbers that mean something else there', () => {
    const hit = pickEpisode(videos, { season: 2, episode: 1, title: 'The First Line of Defense? The Giant Whale Laboon Appears!' });
    assert.deepStrictEqual([hit.season, hit.episode], [2, 2]);
});

test('an episode at the asked numbers with the asked title is taken as it is', () => {
    const hit = pickEpisode(videos, { season: 1, episode: 2, title: 'Enter the Great Swordsman! Pirate Hunter Roronoa Zoro!' });
    assert.deepStrictEqual([hit.season, hit.episode], [1, 2]);
});

test('an episode without a title of its own goes by its numbers', () => {
    assert.strictEqual(pickEpisode(videos, { season: 1, episode: 3, title: 'Episode 3' }).title, videos[2].title);
    assert.strictEqual(pickEpisode(videos, { season: 1, episode: 3, title: null }).title, videos[2].title);
    assert.strictEqual(pickEpisode(videos, { season: 4, episode: 1, title: 'Episode 1' }), null);
});

test('a differently translated title is placed by its neighbours', () => {
    // The asker's season 1: the same four episodes, the first translated otherwise.
    const siblings = [
        { episode: 1, title: "I'm Luffy! The Man Who Will Become the Pirate King!" },
        { episode: 2, title: 'Enter the Great Swordsman! Pirate Hunter Roronoa Zoro!' },
        { episode: 3, title: "Morgan versus Luffy! Who's the Mysterious Pretty Girl?" },
        { episode: 4, title: "Luffy's Past! Enter Red-Haired Shanks!" }
    ];
    const wanted = { season: 3, episode: 1, title: siblings[0].title };
    assert.strictEqual(pickEpisode(videos, wanted), null);
    assert.strictEqual(pickEpisode(videos, wanted, siblings).title, videos[0].title);
});

test('neighbours that disagree, or only one of them, place nothing', () => {
    const wanted = { season: 3, episode: 2, title: 'A title nobody has' };
    // One neighbour only.
    assert.strictEqual(pickEpisode(videos, wanted, [{ episode: 1, title: videos[0].title }, { episode: 2, title: wanted.title }]), null);
    // Two that point to different places (the service left an episode out between them).
    const apart = [{ episode: 1, title: videos[0].title }, { episode: 2, title: wanted.title }, { episode: 3, title: videos[3].title }];
    assert.strictEqual(pickEpisode(videos, wanted, apart), null);
});

test('a title two episodes share is not guessed at', () => {
    const twice = videos.concat([{ season: 3, episode: 9, title: 'Showdown in the Ruins! Tense Zoro vs. Eric!' }]);
    assert.strictEqual(pickEpisode(twice, { season: 9, episode: 9, title: 'Showdown in the Ruins! Tense Zoro vs. Eric!' }), null);
});
