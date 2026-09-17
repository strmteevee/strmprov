// Shared connect+authenticate logic for a small pool of NNTP connections,
// used by both the actual downloader (lib/downloadManager.js) and the
// cheaper pre-download availability check (lib/availability.js).

const { NntpClient } = require('./nntp');

async function openPool(config, size) {
  const clients = [];
  try {
    for (let i = 0; i < size; i++) {
      const client = new NntpClient({ host: config.host, port: config.port, ssl: config.ssl });
      await client.connect();
      await client.authinfo(config.username, config.password);
      clients.push(client);
    }
  } catch (err) {
    clients.forEach((c) => c.quit());
    throw err;
  }
  return clients;
}

function closePool(clients) {
  clients.forEach((c) => c.quit());
}

module.exports = { openPool, closePool };
