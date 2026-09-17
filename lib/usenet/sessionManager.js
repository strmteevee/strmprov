// Keeps one UsenetSession alive per active stream token across however many
// HTTP Range requests a player makes for it (see addon-server.js's
// /usenet/stream route), so ordinary forward playback reuses the same NNTP
// connection pool instead of reconnecting for every chunk. Sessions with no
// requests for a while are torn down by UsenetSession's own idle timer.

const { UsenetSession, FORWARD_REUSE_WINDOW_BYTES } = require('./streamSession');

const sessions = new Map(); // token -> UsenetSession

async function getSessionForRequest(token, nzbUrl, config, startByte) {
    let session = sessions.get(token);
    if (session && session.closed) {
        sessions.delete(token);
        session = null;
    }

    if (!session) {
        session = new UsenetSession(nzbUrl, config);
        sessions.set(token, session);
        try {
            await session.init();
        } catch (err) {
            sessions.delete(token);
            throw err;
        }
    } else {
        const delta = startByte - session.currentEmitByteEstimate();
        if (delta < -FORWARD_REUSE_WINDOW_BYTES || delta > FORWARD_REUSE_WINDOW_BYTES) {
            await session.seekTo(startByte);
        }
    }

    session.touch();
    return session;
}

function dropSession(token) {
    const session = sessions.get(token);
    if (session) {
        session.close();
        sessions.delete(token);
    }
}

module.exports = { getSessionForRequest, dropSession };
