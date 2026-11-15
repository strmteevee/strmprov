// An HLS media playlist with only the programme left in: for a stream that
// has other material stitched into it (advert breaks, channel idents), which
// the playlist shows as segments from other places than the programme's own.
//
// Seen in Pluto TV's on-demand playlists (2026-11-16): a film's picture
// segments all sit under one folder ("/206_pluto/clip/<its id>…", 13
// stretches, 120 of 140 minutes), the adverts under others ("/v1/mp4/…",
// "/mp4/v1/…", "/0_ad/creative/…"), a different one for nearly every break.
//
// Nothing here knows those names. The segments are grouped by where they
// come from (host and the first two folders of the path); the group that
// makes up most of the playlist is the programme, the rest is left out. When
// no group clearly is (less than MIN_SHARE of the running time), or the
// playlist is live, the playlist is returned as it was.
//
// The sound and the subtitles are playlists of their own, laid out in time
// exactly like the picture's. They can't be judged by themselves - one kind
// of advert had its sound in the same place as the film's - so they are cut
// where the picture is: programmeRanges() of a picture playlist says which
// stretches of time are programme, and contentOnly() with those ranges keeps
// the segments that fall in them.

const MIN_SHARE = 0.6;

function groupOf(uri, base) {
    try {
        const u = new URL(uri, base);
        return `${u.host}/${u.pathname.split('/').filter(Boolean).slice(0, 2).join('/')}`;
    } catch (e) {
        return '?';
    }
}

// The playlist's header, its segments (each with its own tags, the key and
// map in effect, and where it starts), and what closes it.
function parse(text, base) {
    const header = [];
    const segments = [];
    const tail = [];
    let pending = [];
    let key = null; // the #EXT-X-KEY in effect
    let map = null; // the #EXT-X-MAP in effect
    let at = 0;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#EXT-X-KEY')) { key = line; continue; }
        if (line.startsWith('#EXT-X-MAP')) { map = line; continue; }
        if (line === '#EXT-X-ENDLIST') { tail.push(line); continue; }
        if (line.startsWith('#')) {
            // Before the first segment, everything but a segment's own tags is the playlist's header
            // (which can come after the first key: "#EXT-X-DISCONTINUITY-SEQUENCE", "#EXT-X-MEDIA-SEQUENCE").
            const segmentTag = line.startsWith('#EXTINF') || line === '#EXT-X-DISCONTINUITY' || line.startsWith('#EXT-X-PROGRAM-DATE-TIME') || line.startsWith('#EXT-X-BYTERANGE');
            if (!segments.length && !segmentTag) header.push(line);
            else pending.push(line);
            continue;
        }
        const inf = pending.find(t => t.startsWith('#EXTINF:'));
        const seconds = inf ? parseFloat(inf.slice(8)) || 0 : 0;
        segments.push({
            uri: line,
            group: groupOf(line, base),
            start: at,
            seconds,
            // Its own tags, without the ones that say where it sits among the others (rewritten when cut).
            tags: pending.filter(t => t !== '#EXT-X-DISCONTINUITY' && !t.startsWith('#EXT-X-PROGRAM-DATE-TIME')),
            key,
            map
        });
        at += seconds;
        pending = [];
    }
    return { header, segments, tail, total: at };
}

// The stretches of time that are programme, judged on a (picture) playlist:
// [{ start, end }] in seconds, or null when it is live, has no clear
// programme, or is all programme (nothing to leave out).
function programmeRanges(text, base) {
    const { segments, tail, total } = parse(text, base);
    // Only a finished (on-demand) playlist: in a live one a left-out break is a hole to wait in.
    if (!tail.length || !segments.length || total <= 0) return null;
    const perGroup = new Map();
    segments.forEach(s => perGroup.set(s.group, (perGroup.get(s.group) || 0) + s.seconds));
    const [programme, programmeSeconds] = Array.from(perGroup.entries()).sort((a, b) => b[1] - a[1])[0];
    if (perGroup.size < 2 || programmeSeconds / total < MIN_SHARE) return null;
    const ranges = [];
    for (const s of segments) {
        if (s.group !== programme) continue;
        const last = ranges[ranges.length - 1];
        if (last && Math.abs(last.end - s.start) < 0.001) last.end = s.start + s.seconds;
        else ranges.push({ start: s.start, end: s.start + s.seconds });
    }
    return ranges;
}

// text: the media playlist; base: its address (for relative segment addresses);
// ranges: the stretches to keep, from programmeRanges() of the picture's
// playlist - left out, the playlist is judged by itself.
// -> { text, removedSeconds, keptSeconds, breaks } - text unchanged when nothing was left out.
function contentOnly(text, base, ranges) {
    const unchanged = { text, removedSeconds: 0, keptSeconds: 0, breaks: 0 };
    const keep = ranges === undefined ? programmeRanges(text, base) : ranges;
    if (!keep || !keep.length) return unchanged;
    const { header, segments, tail, total } = parse(text, base);
    if (!tail.length || !segments.length) return unchanged;

    // A segment belongs to the stretch its middle falls in (the playlists line up, give or take rounding).
    let r = 0;
    const inProgramme = (s) => {
        const middle = s.start + s.seconds / 2;
        while (r < keep.length - 1 && middle >= keep[r].end) r++;
        return middle >= keep[r].start && middle < keep[r].end;
    };

    const out = header.slice();
    let lastKey = null;
    let lastMap = null;
    let gap = false; // something was left out since the last segment kept
    let kept = 0;
    let keptSeconds = 0;
    let breaks = 0;
    for (const s of segments) {
        if (!inProgramme(s)) {
            if (!gap) breaks++;
            gap = true;
            continue;
        }
        // The timing starts anew after a left-out break.
        if (gap && kept) out.push('#EXT-X-DISCONTINUITY');
        if (s.key !== lastKey) { out.push(s.key || '#EXT-X-KEY:METHOD=NONE'); lastKey = s.key; }
        if (s.map !== lastMap && s.map) { out.push(s.map); lastMap = s.map; }
        out.push(...s.tags, s.uri);
        gap = false;
        kept++;
        keptSeconds += s.seconds;
    }
    if (!breaks) return unchanged;
    out.push(...tail);
    return { text: out.join('\n') + '\n', removedSeconds: total - keptSeconds, keptSeconds, breaks };
}

module.exports = { contentOnly, programmeRanges };
