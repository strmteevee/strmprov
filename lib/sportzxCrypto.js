// Port of the SportzX Android app's (com.sportzx.live) response-decryption
// scheme - every API response body is `{"data": "<url-safe-base64 blob>"}`,
// and this recovers the real plaintext JSON underneath it.
//
// Reverse-engineered by decompiling the app's own CloudStream plugin
// (cloudstream/SportzxProvider.cs3, a compiled plugin the user already had
// on disk) with jadx, reading its SportzxCryptoUtils.kt class, and porting
// its "v3" scheme byte-for-byte to JavaScript - confirmed live (2026-09-18)
// against real /cats.json and /events.json responses from the app's actual
// backend. The real app tries several older scheme versions too (v2, and
// two more legacy fallbacks) for backward compatibility with cached/old
// data; only v3 is implemented here since it's confirmed to be what the
// live server actually uses today. If the server ever rotates to an older
// version, decrypt() below will need the same treatment - see the original
// SportzxCryptoUtils.kt (recoverable the same way, from the same .cs3 file)
// for the exact algorithms.
//
// The scheme itself is a custom construction, not a named standard: a
// ChaCha20-shaped 512-bit permutation ("SXR") used both as a keyed sponge
// (for a PRF/KDF and for a truncated-to-128-bit authentication tag) and as
// a stream cipher (encrypting 64-byte blocks XORed against the plaintext,
// same structural idea as ChaCha20's own keystream generation). All inputs
// are compile-time constants baked into the app - no device-specific or
// per-session secret is involved, so this is fully and deterministically
// portable.

const CTX_HASH = Buffer.from('1676ec7db4771b0d826d70369b579684b182d2c0133be041bdd55f5d6d79a98b', 'hex');
const V3_SXR_LABEL = Buffer.from('SXR3/kdf', 'utf8');
const V3_PEPPER = Buffer.from([
    -79, 101, 125, -29, 9, -42, -25, -112, 96, 122, 92, 78, -25, -47, -81, 72,
    83, -11, 113, -123, 125, -55, 101, -26, 92, -75, 103, 67, -110, 58, 69, 121
].map((b) => b & 0xff));
// The ChaCha20 constants would be "expand 32-byte k" - SportzX uses its own
// four 32-bit words instead, confirmed live via the decompiled bytecode.
const SXR_CONSTS = Int32Array.from([1398297139, -1640531527, 2101127200, -1028477379]);
const V2_VERSION_BYTE = 2; // used only as a KDF domain-separation byte here, not a scheme selector

function rotl32(x, n) {
    x = x >>> 0;
    return ((x << n) | (x >>> (32 - n))) >>> 0;
}
function add32(a, b) { return (a + b) | 0; }

// The same quarter-round shape as ChaCha20's, just with SportzX's own
// rotation constants (13/17/9/25 instead of ChaCha's 16/12/8/7).
function sxrQr(s, a, b, c, d) {
    s[a] = add32(s[a], s[b]);
    s[d] = rotl32(s[d] ^ s[a], 13);
    s[c] = add32(s[c], s[d]);
    s[b] = rotl32(s[b] ^ s[c], 17);
    s[a] = add32(s[a], s[b]);
    s[d] = rotl32(s[d] ^ s[a], 9);
    s[c] = add32(s[c], s[d]);
    s[b] = rotl32(s[b] ^ s[c], 25);
}
function sxrPermute(state) {
    for (let round = 0; round < 10; round++) {
        sxrQr(state, 0, 4, 8, 12);
        sxrQr(state, 1, 5, 9, 13);
        sxrQr(state, 2, 6, 10, 14);
        sxrQr(state, 3, 7, 11, 15);
        sxrQr(state, 0, 5, 10, 15);
        sxrQr(state, 1, 6, 11, 12);
        sxrQr(state, 2, 7, 8, 13);
        sxrQr(state, 3, 4, 9, 14);
    }
}
function ld32le(buf, off) { return buf.readInt32LE(off); }
function st32le(buf, off, value) { buf.writeInt32LE(value | 0, off); }

// A 512-bit (16x int32) sponge: absorbs bytes 32 at a time (XORed into the
// first 8 words, then permuted), and squeezes a 32-byte digest out the same
// 8 words at the end - used both as a keyed PRF (sxrPrf) and, keyed with a
// MAC key, as the authentication tag over the ciphertext.
class SxrSponge {
    constructor() {
        this.state = new Int32Array(16);
        for (let i = 0; i < 16; i++) this.state[i] = Math.imul(-1640531527, i + 1);
        this.buf = Buffer.alloc(32);
        this.pos = 0;
    }
    absorb(data, length, offset = 0) {
        for (let i = 0; i < length; i++) {
            this.buf[this.pos++] = data[offset + i];
            if (this.pos === 32) {
                for (let j = 0; j < 8; j++) this.state[j] = (this.state[j] ^ ld32le(this.buf, j * 4)) | 0;
                sxrPermute(this.state);
                this.pos = 0;
            }
        }
    }
    final(out, outOffset = 0) {
        this.buf[this.pos++] = 0x80;
        while (this.pos < 32) this.buf[this.pos++] = 0;
        for (let j = 0; j < 8; j++) this.state[j] = (this.state[j] ^ ld32le(this.buf, j * 4)) | 0;
        sxrPermute(this.state);
        for (let j = 0; j < 8; j++) st32le(out, j * 4 + outOffset, this.state[j]);
    }
}

function sxrPrf(data, length) {
    const sponge = new SxrSponge();
    sponge.absorb(data, length, 0);
    const out = Buffer.alloc(32);
    sponge.final(out, 0);
    return out;
}

// HKDF-shaped key derivation, but built from the sponge PRF above instead of
// HMAC: seed = PRF(label || certHash || pepper || iv), then encKey/macKey
// are each PRF(seed || 1-byte domain separator).
function sxrDerive(certHash, iv) {
    const buf = Buffer.alloc(88);
    V3_SXR_LABEL.copy(buf, 0);
    certHash.copy(buf, 8);
    V3_PEPPER.copy(buf, 40);
    iv.copy(buf, 72);
    const seed = sxrPrf(buf, 88);

    const encKeyInput = Buffer.alloc(33);
    seed.copy(encKeyInput, 0);
    encKeyInput[32] = 1;
    const encKey = sxrPrf(encKeyInput, 33);

    const macKeyInput = Buffer.alloc(33);
    seed.copy(macKeyInput, 0);
    macKeyInput[32] = V2_VERSION_BYTE;
    const macKey = sxrPrf(macKeyInput, 33);

    const streamState = new Int32Array(8);
    for (let i = 0; i < 8; i++) streamState[i] = ld32le(encKey, i * 4);
    return { streamState, macKey };
}

// One 64-byte keystream block: SXR_CONSTS || streamState || blockCounter ||
// counterWords, permuted and added back to itself (the same "permute then
// add the original block" finalization ChaCha20 uses).
function sxrBlock(streamState, blockCounter, counterWords, out) {
    const state = new Int32Array(16);
    state.set(SXR_CONSTS, 0);
    state.set(streamState, 4);
    state[12] = blockCounter | 0;
    state.set(counterWords, 13);
    const working = Int32Array.from(state);
    sxrPermute(working);
    for (let i = 0; i < 16; i++) working[i] = add32(working[i], state[i]);
    for (let i = 0; i < 16; i++) st32le(out, i * 4, working[i]);
}

function urlSafeB64Decode(s) {
    let std = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (std.length % 4 !== 0) std += '=';
    return Buffer.from(std, 'base64');
}

// Blob layout: [1 version byte][16-byte iv][12 bytes = 3x int32 counter
// words][ciphertext][16-byte truncated tag].
function decryptV3(b64Data) {
    try {
        const raw = urlSafeB64Decode(b64Data);
        if (raw.length < 45) throw new Error(`v3 blob too short (${raw.length})`);
        if (raw[0] !== 3) throw new Error(`not a v3 blob (version=0x${raw[0].toString(16)})`);
        const iv = raw.subarray(1, 17);
        const counterWords = new Int32Array(3);
        for (let i = 0; i < 3; i++) counterWords[i] = ld32le(raw, i * 4 + 17);
        const ct = raw.subarray(29, raw.length - 16);
        const tag = raw.subarray(raw.length - 16, raw.length);

        const { streamState, macKey } = sxrDerive(CTX_HASH, iv);
        const sponge = new SxrSponge();
        sponge.absorb(macKey, 32, 0);
        sponge.absorb(raw, 29, 0);
        sponge.absorb(ct, ct.length, 0);
        sponge.absorb(macKey, 32, 0);
        const computedTag = Buffer.alloc(32);
        sponge.final(computedTag, 0);
        let diff = 0;
        for (let i = 0; i < 16; i++) diff |= computedTag[i] ^ tag[i];
        if (diff !== 0) throw new Error('HMAC tag mismatch - wrong cert_hash or tampered payload');

        const pt = Buffer.alloc(ct.length);
        const block = Buffer.alloc(64);
        let offset = 0;
        let blockCounter = 0;
        while (offset < ct.length) {
            sxrBlock(streamState, blockCounter, counterWords, block);
            const chunk = Math.min(64, ct.length - offset);
            for (let i = 0; i < chunk; i++) pt[offset + i] = ct[offset + i] ^ block[i];
            offset += chunk;
            blockCounter++;
        }
        return pt.toString('utf8');
    } catch (e) {
        console.log(`[SportzxCrypto] v3 decryption failed - ${e.message}`);
        return null;
    }
}

function decrypt(b64Data) {
    const trimmed = String(b64Data || '').trim();
    if (!trimmed) return null;
    return decryptV3(trimmed);
}

module.exports = { decrypt };
