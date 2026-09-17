// Minimal NNTP client: just enough to authenticate and fetch article bodies
// by message-id, which is all an NZB download needs (RFC 3977 allows BODY
// <message-id> without first SELECTing a group). No article posting, no
// STARTTLS - providers that require SSL nearly all use implicit TLS on a
// dedicated port (typically 563), which is what `ssl: true` connects with.
//
// Decoding note: article bodies are read with 'latin1' socket encoding, not
// utf8. yEnc-encoded lines can contain any byte 0x00-0xFF; utf8 would
// reinterpret bytes >=0x80 as multi-byte sequences and corrupt the data.
// latin1 is a lossless 1:1 byte<->codepoint mapping, so lib/yenc.js's
// charCodeAt() on these strings recovers the exact original byte.

const net = require('net');
const tls = require('tls');

class NntpError extends Error {}

class NntpClient {
  constructor({ host, port, ssl, timeoutMs = 30000 }) {
    this.host = host;
    this.port = port;
    this.ssl = ssl;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = '';
    this.lineQueue = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      const opts = { host: this.host, port: this.port, rejectUnauthorized: true };
      this.socket = this.ssl ? tls.connect(opts) : net.connect(opts);
      this.socket.setTimeout(this.timeoutMs);
      this.socket.setEncoding('latin1');
      this.socket.once('error', onError);
      this.socket.on('timeout', () => this.socket.destroy(new Error('NNTP connection timed out')));
      this.socket.on('data', (chunk) => this._onData(chunk));
      this.socket.on('close', () => this._flushWaiters(new Error('NNTP connection closed')));

      const connectEvent = this.ssl ? 'secureConnect' : 'connect';
      this.socket.once(connectEvent, async () => {
        this.socket.removeListener('error', onError);
        this.socket.on('error', () => {}); // subsequent errors surface via pending reads
        try {
          const greeting = await this.readLine();
          if (!/^20[01]/.test(greeting)) throw new NntpError(`Unexpected greeting: ${greeting}`);
          resolve(greeting);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lineQueue.push(line);
    }
  }

  _flushWaiters(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  readLine() {
    if (this.lineQueue.length) return Promise.resolve(this.lineQueue.shift());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async readMultiline() {
    const lines = [];
    for (;;) {
      const line = await this.readLine();
      if (line === '.') break;
      lines.push(line.startsWith('..') ? line.slice(1) : line);
    }
    return lines.join('\r\n');
  }

  async command(cmd) {
    this.socket.write(cmd + '\r\n', 'latin1');
    return this.readLine();
  }

  async authinfo(username, password) {
    let resp = await this.command(`AUTHINFO USER ${username}`);
    if (/^281/.test(resp)) return resp; // some servers accept user-only
    if (!/^381/.test(resp)) throw new NntpError(`AUTHINFO USER rejected: ${resp}`);
    resp = await this.command(`AUTHINFO PASS ${password}`);
    if (!/^281/.test(resp)) throw new NntpError(`AUTHINFO PASS rejected: ${resp}`);
    return resp;
  }

  // STAT just confirms an article exists (223) or doesn't (430), without
  // transferring its body - orders of magnitude cheaper than BODY, so it's
  // what a pre-download availability check should use.
  async stat(messageId) {
    const id = messageId.startsWith('<') ? messageId : `<${messageId}>`;
    const resp = await this.command(`STAT ${id}`);
    return /^223/.test(resp);
  }

  async body(messageId) {
    const id = messageId.startsWith('<') ? messageId : `<${messageId}>`;
    const resp = await this.command(`BODY ${id}`);
    if (/^430/.test(resp)) {
      throw new NntpError(
        `Article not found on this provider (${id}). It's likely outside your provider's ` +
        `retention window, never propagated to it, or was removed - not a bug, just a ` +
        `content-availability gap. Try a different search result for the same title.`
      );
    }
    if (!/^222/.test(resp)) throw new NntpError(`BODY ${id} failed: ${resp}`);
    return this.readMultiline();
  }

  quit() {
    if (!this.socket) return;
    try { this.socket.write('QUIT\r\n'); } catch (e) { /* closing anyway */ }
    this.socket.destroy();
  }
}

module.exports = { NntpClient, NntpError };
