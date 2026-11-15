// One page of a catalog that several regions fill together (Pluto TV's US and
// UK, Plex's NL and US).
//
// A Stremio client pages with `skip` = how many titles it has so far. With
// regions merged, duplicates dropped and unplayable titles left out, that
// number says nothing about how far each region's own list was read. So the
// merged list is built the same way every time - round k takes every region's
// k-th page, in the regions' order, each title once - and the page asked for
// is cut out of it: titles [skip, skip + size). The regions' pages are cached
// by their source, so building it again for a later page costs little.

const CHUNK = 10;

// options:
//   regions   in order of preference
//   loadPage  (region, k) -> Promise of that region's k-th page of metas ([] = no more)
//   keys      (meta) -> the names a title goes by; one already seen under any of them is a duplicate
//   accept    optional (metas) -> Promise of booleans: which of them to keep (checked a few at a time)
//   skip, size, maxRounds
async function mergedPage(options) {
    const { regions, loadPage, keys, accept, skip, size, maxRounds } = options;
    const need = skip + size;
    const out = [];
    const seen = new Set();
    let live = regions.slice();
    for (let k = 0; k < maxRounds && live.length && out.length < need; k++) {
        const lists = await Promise.all(live.map(r => loadPage(r, k).catch(() => [])));
        live = live.filter((r, i) => lists[i].length > 0);
        const fresh = [];
        for (const list of lists) {
            for (const m of list) {
                const names = keys(m);
                if (names.some(n => seen.has(n))) continue;
                names.forEach(n => seen.add(n));
                fresh.push(m);
            }
        }
        for (let i = 0; i < fresh.length && out.length < need; i += CHUNK) {
            const chunk = fresh.slice(i, i + CHUNK);
            const ok = accept ? await accept(chunk) : chunk.map(() => true);
            chunk.forEach((m, n) => { if (ok[n]) out.push(m); });
        }
    }
    return out.slice(skip, need);
}

module.exports = { mergedPage };
