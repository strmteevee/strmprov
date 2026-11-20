// Run with: node providers/xumo.test.js
const assert = require('assert');
const { lineOf, filmIds, noteTitle, catalogIds, onlyProtected, parseId } = require('./xumo');

// ---- a list's title as a line of the index ----
assert.strictEqual(lineOf({ id: 'XM1', contentType: 'MOVIE', title: 'Annie', runtime: 7642 }), 'm:annie\tXM1\t7642');
assert.strictEqual(lineOf({ id: 'XM2', contentType: 'EPISODIC', title: "Hell's Kitchen", season: 1, episode: 2, episodeTitle: 'Day\tTwo', connectorId: 'XMS' }),
    'e:hell s kitchen\tXM2\t1\t2\tDay Two\tXMS');
// An episode that names no series of its own, a clip, a title without a name: the first without a series id, the others no line.
assert.strictEqual(lineOf({ id: 'XM3', contentType: 'EPISODIC', title: 'Show', season: 1, episode: 1, connectorId: 'XM3' }), 'e:show\tXM3\t1\t1\t\t');
assert.strictEqual(lineOf({ id: 'XM4', contentType: 'SHORT-FORM', title: 'Clip' }), null);
assert.strictEqual(lineOf({ id: 'XM5', contentType: 'EPISODIC', title: 'Show' }), null);
assert.strictEqual(lineOf({ id: 'XM6', contentType: 'MOVIE', title: '' }), null);

// ---- films with the asked name: only those of the asked length ----
const lines = [['A', '7642'], ['B', '7080'], ['C', '0']];
assert.deepStrictEqual(filmIds(lines, { seconds: 127 * 60 }), ['A', 'C']);
assert.deepStrictEqual(filmIds(lines, { seconds: 0 }), ['A', 'B', 'C']);

// ---- titles Xumo only has protected ----
assert.strictEqual(onlyProtected({ providers: [{ title: 'Sony Pictures - Licensed (DRM)' }] }), true);
assert.strictEqual(onlyProtected({ providers: [{ title: 'Lionsgate - RevShare (DRM)' }, { title: 'FilmRise' }] }), false);
assert.strictEqual(onlyProtected({ providers: [{ title: 'FilmRise' }] }), false);
assert.strictEqual(onlyProtected({}), false);

// ---- the catalog: what a list's title adds ----
const catalog = { rows: [], titles: {}, order: [] };
assert.strictEqual(noteTitle(catalog, { id: 'M1', contentType: 'MOVIE', title: 'Annie' }), 'M1');
assert.strictEqual(noteTitle(catalog, { id: 'S1', contentType: 'SERIES', title: 'Murdoch Mysteries' }), 'S1');
// An episode adds its series (once), not itself; one without a series of its own adds nothing.
assert.strictEqual(noteTitle(catalog, { id: 'E1', contentType: 'EPISODIC', title: 'Heartland', connectorId: 'S2' }), 'S2');
assert.strictEqual(noteTitle(catalog, { id: 'E2', contentType: 'EPISODIC', title: 'Heartland', connectorId: 'S2' }), 'S2');
assert.strictEqual(noteTitle(catalog, { id: 'E3', contentType: 'EPISODIC', title: 'Loose', connectorId: 'E3' }), null);
assert.strictEqual(noteTitle(catalog, { id: 'C1', contentType: 'SHORT-FORM', title: 'Clip' }), null);
noteTitle(catalog, { id: 'M2', contentType: 'MOVIE', title: 'Annie Hall' });
noteTitle(catalog, { id: 'M3', contentType: 'MOVIE', title: 'The Contractor' });
assert.deepStrictEqual(catalog.order, ['M1', 'S1', 'S2', 'M2', 'M3']);
assert.deepStrictEqual(catalog.titles.S2, ['s', 'Heartland']);

// ---- the catalog: which titles a request stands for ----
catalog.rows = [
    { name: 'Most Popular', kind: 'm', ids: ['M3', 'M1'] },
    { name: 'Comedy', kind: 'm', ids: ['M2', 'M1'] },
    { name: 'Crime TV', kind: 's', ids: ['S1'] }
];
// Everything: the rows' order first, each title once, then the rest.
assert.deepStrictEqual(catalogIds(catalog, 'm', {}), ['M3', 'M1', 'M2']);
assert.deepStrictEqual(catalogIds(catalog, 's', {}), ['S1', 'S2']);
// One row by name, or the rows a function picks.
assert.deepStrictEqual(catalogIds(catalog, 'm', { genre: 'Comedy' }), ['M2', 'M1']);
assert.deepStrictEqual(catalogIds(catalog, 'm', { match: (name) => /popular|comedy/i.test(name) }), ['M3', 'M1', 'M2']);
assert.deepStrictEqual(catalogIds(catalog, 'm', { genre: 'Crime TV' }), []);
// A search: every word starts a word of the name.
assert.deepStrictEqual(catalogIds(catalog, 'm', { search: 'annie' }), ['M1', 'M2']);
assert.deepStrictEqual(catalogIds(catalog, 'm', { search: 'ann hal' }), ['M2']);
assert.deepStrictEqual(catalogIds(catalog, 'm', { search: 'nie' }), []);
assert.deepStrictEqual(catalogIds(catalog, 's', { search: 'murdoch' }), ['S1']);
assert.deepStrictEqual(catalogIds(catalog, 'm', { search: '!!' }), []);

// ---- ids ----
assert.deepStrictEqual(parseId('xumo:m:XM02Z9WXDAENQ4'), { kind: 'm', id: 'XM02Z9WXDAENQ4' });
assert.deepStrictEqual(parseId('xumo:e:XM0QMIEUWG6SOF'), { kind: 'e', id: 'XM0QMIEUWG6SOF' });
assert.strictEqual(parseId('xumo:x:XM1'), null);
assert.strictEqual(parseId('pluto:movie:1'), null);

console.log('xumo.test.js: all passed');
