// DNS fallback for hosts the local resolver refuses to answer.
//
// The home router (an ASUS TUF-AX4200) answers "non-existent domain" for some
// hosts providers depend on - confirmed 2026-10-19 for SportzX's events
// server es.bandspx.com, which Cloudflare's public DNS resolves fine - and
// the Pi uses that router, so those providers silently returned nothing. By
// request, a failed normal lookup is retried through Cloudflare's
// DNS-over-HTTPS. Successful normal lookups are never touched.
//
// It works by wrapping dns.lookup, which is what Node's net/tls connections
// (and so the built-in fetch) use to resolve hostnames.

const dns = require('dns');
const https = require('https');

const RETRY_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL']);
// Queried by IP, so the fallback itself never needs a DNS lookup.
const DOH_URL = 'https://1.1.1.1/dns-query';
const MIN_TTL_MS = 60 * 1000;

const cache = new Map(); // hostname -> { addresses: string[], expires }
const announced = new Set();
let installed = false;

function queryDoh(hostname) {
  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.addresses);
  return new Promise((resolve, reject) => {
    const req = https.get(`${DOH_URL}?name=${encodeURIComponent(hostname)}&type=A`, { headers: { accept: 'application/dns-json' }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const answers = (json.Answer || []).filter((a) => a.type === 1 && a.data);
          if (!answers.length) return reject(new Error('no A records'));
          const ttl = Math.max(MIN_TTL_MS, Math.min(...answers.map((a) => (a.TTL || 60) * 1000)));
          const addresses = answers.map((a) => a.data);
          cache.set(hostname, { addresses, expires: Date.now() + ttl });
          resolve(addresses);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('DoH timeout')));
    req.on('error', reject);
  });
}

function install() {
  if (installed) return;
  installed = true;
  const originalLookup = dns.lookup;

  dns.lookup = function lookupWithFallback(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { family: options };
    } else {
      options = options || {};
    }
    originalLookup.call(dns, hostname, options, (err, address, family) => {
      // Only a plain "can't resolve" is retried, and only for IPv4-capable
      // requests (the fallback asks for A records).
      if (!err || !RETRY_CODES.has(err.code) || options.family === 6 || typeof hostname !== 'string') {
        return callback(err, address, family);
      }
      queryDoh(hostname).then((addresses) => {
        if (!announced.has(hostname)) {
          announced.add(hostname);
          console.log(`[dns] Local DNS could not resolve ${hostname} (${err.code}); using DNS-over-HTTPS -> ${addresses[0]}`);
        }
        if (options.all) callback(null, addresses.map((a) => ({ address: a, family: 4 })));
        else callback(null, addresses[0], 4);
      }, () => callback(err, address, family));
    });
  };
}

module.exports = { install };
