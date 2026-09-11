# StrmProv

A collection of streaming providers for the [Nuvio](https://github.com/tapframe/Nuvio) app. Providers are JavaScript modules that fetch streams from various third-party sources for movies, TV shows, and anime.

This project is a fork/continuation of the `nuvio-providers` collection originally created by **Yoru** — full credit for the original provider framework and build tooling this repository builds on. (Nuvio itself, the app that consumes these providers, is a separate project by tapframe.)

📖 **[Read the Comprehensive Developer Guide](DOCUMENTATION.md)**

## Quick Start

### Using in Nuvio App

1. Open **Nuvio** > **Settings** > **Plugins**
2. Add this repository URL:
   ```
   https://raw.githubusercontent.com/strmteevee/strmprov/refs/heads/main
   ```
3. Refresh and enable the providers you want

---

## Providers

18 providers are currently registered in [`manifest.json`](manifest.json):

| Provider | Types | Notes |
|---|---|---|
| **All Sources** | movie, tv | Combines every provider below into one plugin and ranks the results — see [Combined provider](#combined-provider) |
| **StreamAPI** | movie, tv | Thin client for the [aggregator API](#aggregator-api) below — needs a server URL configured in its settings |
| Peachify | movie, tv | Multi-server (air, holly, multi) with subtitles |
| Vidrock | movie, tv | Multi-server, AES-256-GCM decrypted sources |
| MovieBox | movie, tv | H5 web API, multiple resolutions and subtitles |
| RiveStream | movie, tv | Multi-server (Citadel, PrimeVids, others) with subtitles |
| 4KHDHub | movie, tv | Direct links |
| UHDMovies | movie, tv | Multiple resolutions |
| NetMirror | movie, tv | Auto-disabled on iOS |
| StreamFlix | movie, tv | Direct links via StreamFlix API |
| Vixsrc | movie, tv | M3U8 with auto quality selection |
| VIDEASY | movie, tv | Multi-server, multi-language (currently disabled) |
| Vidlink | movie, tv | Encrypted TMDB ID support |
| Castle | movie, tv | Multi-language |
| HDHub4u | movie, tv | High-speed direct links |
| MovieBlast | movie, tv | Telugu/Hindi/English |
| AnimeDekho | anime | Sub/dub |
| KickassAnime | anime | Multi-server, sub/dub |

Content-type detection (movie vs. TV vs. anime) is based on TMDB metadata: a title is treated as anime when its genres include Animation **and** its original language/origin country is Japanese.

---

## Combined provider

[`providers/allsources.js`](providers/allsources.js) runs every other provider in this repo from a single Nuvio plugin, so it can be enabled on its own instead of adding all 16 individually. The other providers still exist as separate, individually toggleable entries — this is purely an additional option.

It queries all 16 sources in parallel, applies the same ranking as the [aggregator API](#aggregator-api) (30GB size cap; movies keep only 4K/1080p, series show every resolution with the best tagged `[PREFERRED]`), and returns as soon as every source has answered **or ~15 seconds have passed, whichever comes first** — any source still running past that point is left to finish in the background and its result is discarded, so one slow source can't hold up the rest.

That 15-second cutoff is an approximation, not an exact timer: Nuvio's plugin sandbox has no `setTimeout`/`setInterval` at all (confirmed from Nuvio's own source — the sandbox only injects `console`, the `fetch` bridge, `__parse_url`, and the cheerio helpers), so there's no way to schedule a callback after a fixed delay from JavaScript alone. Instead, all sources are raced against a `fetch()` to a public delay endpoint that itself takes about 15 seconds to respond. If that endpoint is ever unreachable, the cutoff is skipped entirely and it just waits for every source to finish normally, rather than guessing how much time has actually passed.

**This file is generated** by [`build-combined.js`](build-combined.js), which inlines each source provider's current code into its own isolated scope. Run it after changing any of the 16 combined providers:

```bash
node build-combined.js
```

Don't hand-edit `providers/allsources.js` directly — it'll be overwritten the next time the build script runs.

---

## Aggregator API

Each provider `.js` file is still meant to be loaded directly by Nuvio via the manifest URL, same as always. Separately, [`server.js`](server.js) runs those same files as a small Node HTTP API that queries multiple providers at once and returns a combined list of streams as JSON — useful for aggregation, testing, or any client that wants pooled results without re-implementing provider selection itself.

This runs as a plain Node process, not inside Nuvio's sandboxed engine, so there's no size or concurrency limit to work around — every provider can be queried in parallel with no restrictions.

### Running it

```bash
npm run serve
```

Starts the server on port 3000 (prints the LAN URL on startup).

### Endpoints

**`GET /api/streams`** — query one or more providers and get back a combined stream list.

| Param | Required | Notes |
|---|---|---|
| `tmdbId` | yes | TMDB id of the movie or show |
| `type` | no | `movie` (default) or `tv` |
| `season`, `episode` | if `type=tv` | required for TV lookups |
| `providers` | no | comma-separated provider ids (e.g. `vidrock,moviebox`); defaults to every enabled provider in `manifest.json` |
| `preferred` | no | `true` (default) or `false` to skip the `[PREFERRED]` selection below and get the raw combined list |

```bash
curl "http://localhost:3000/api/streams?tmdbId=550&type=movie"
curl "http://localhost:3000/api/streams?tmdbId=1396&type=tv&season=1&episode=1&providers=vidrock,peachify"
```

Response shape:
```json
{
  "tmdbId": "550",
  "mediaType": "movie",
  "totalMs": 9488,
  "totalStreams": 45,
  "providers": {
    "vidrock": { "count": 1, "ms": 9350 },
    "peachify": { "count": 3, "ms": 650 }
  },
  "streams": [
    { "name": "[PREFERRED] MovieBox", "url": "...", "quality": "1080p", "headers": {}, "source": "moviebox", "isPreferred": true }
  ]
}
```

Each stream is tagged with a `source` field naming the provider it came from. The `providers` object reports a per-provider stream count and timing, or an `error` if that provider failed or timed out — useful for spotting which sources are currently broken without losing the ones that worked.

**Preferred stream selection**: by default, the endpoint filters and ranks results, then tags the best remaining stream with `name` prefixed `[PREFERRED]` and `isPreferred: true`, moved to the front. Rules are deliberately simple and differ by `type`:

- **Any stream over 30GB is dropped entirely** (checked against a `size` field, or a size embedded in `title` for providers that only report it that way, e.g. "...x265.mkv\n40.16 GB").
- **Movies**: only 4K/2160p and 1080p are kept — 720p, 480p, and anything lower/unlabeled ("Auto", "Unknown") is hidden outright, not just deprioritized. Of what's left, 4K is preferred over 1080p.
- **Series**: nothing is hidden by resolution — every quality is kept, just ranked for the pick: 1080p first, then 4K/2160p, then 720p, then 480p, then everything else.

This is a filter for movies (sub-1080p results are actually removed from the response) but only a suggestion for series (the full list stays, just reordered with the pick moved to front).

This selection logic previously shipped as its own Nuvio provider ("PreferredStream") but never worked reliably inside the app's sandboxed engine for reasons that couldn't be diagnosed without device-level error output — it worked in every other test environment, including a real QuickJS engine loaded by hand. Running it here instead sidesteps that: it's the same idea, running as a plain Node post-processing step with no sandbox constraints to fight.

**`GET /api/providers`** — lists every provider registered in the manifest with its id, name, enabled state, and supported types.

---

## Project Structure

```
strmprov/
├── src/                    # Source files (multi-file development)
│   ├── vixsrc/
│   │   ├── index.js        # Main entry point
│   │   ├── extractor.js    # Stream extraction
│   │   ├── http.js         # HTTP utilities
│   │   └── ...
│   └── uhdmovies/
│       └── ...
│
├── providers/              # Output directory (ready-to-use files)
│   ├── vixsrc.js           # Bundled from src/vixsrc/
│   ├── uhdmovies.js
│   ├── castle.js           # Hand-written directly in providers/ (no src/)
│   ├── allsources.js       # Generated by build-combined.js - see below
│   └── ...
│
├── manifest.json           # Provider registry
├── build.js                # Build script (esbuild-bundled providers)
├── build-combined.js       # Build script for providers/allsources.js
└── package.json
```

**Note:** Most providers with a `src/<name>/` folder are bundled by `build.js` — editing `providers/<name>.js` directly will be silently overwritten the next time the build runs. Edit the `src/` version instead. Providers that have no `src/` counterpart (e.g. `castle.js`) are hand-written directly in `providers/` and are safe to edit there. `providers/allsources.js` is a third category: always generated by `node build-combined.js` from the 16 individual provider files, never hand-written.

---

## Development

There are two ways to create providers:

### Option 1: Single-File Provider

For simple providers, you can create a single JavaScript file directly in the `providers/` directory.

**Important:** The app's JavaScript engine (Hermes) has limitations with `async/await` in dynamic code.
- **Recommended**: Use Promise chains (`.then()`).
- **Alternative**: Use `async/await` and run the transpiler command (see below).

**Example (Promise Chains):**
```javascript
// providers/myprovider.js

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[MyProvider] Fetching ${mediaType} ${tmdbId}`);
  
  return fetch(`https://api.example.com/streams/${tmdbId}`)
    .then(response => response.json())
    .then(data => {
      return data.streams.map(s => ({
        name: "MyProvider",
        title: s.title,
        url: s.url,
        quality: s.quality
      }));
    })
    .catch(error => {
      console.error('[MyProvider] Error:', error.message);
      return [];
    });
}

module.exports = { getStreams };
```

To register the provider, add it to `manifest.json`:
```json
{
  "id": "myprovider",
  "name": "My Provider",
  "filename": "providers/myprovider.js",
  "supportedTypes": ["movie", "tv"],
  "enabled": true
}
```

### Option 2: Multi-File Provider (Recommended)

For complex providers, use the `src/` directory. This allows you to split code into multiple files. The build script automatically handles bundling and `async/await` transpilation.

1. **Create source folder:**
   ```bash
   mkdir -p src/myprovider
   ```

2. **Create entry point** (`src/myprovider/index.js`):
   ```javascript
   import { fetchPage } from './http.js';
   import { extractStreams } from './extractor.js';

   // async/await is fully supported here
   async function getStreams(tmdbId, mediaType, season, episode) {
     const page = await fetchPage(tmdbId, mediaType, season, episode);
     return extractStreams(page);
   }

   module.exports = { getStreams };
   ```

3. **Build:**
   ```bash
   node build.js myprovider
   ```

This generates `providers/myprovider.js`.

---

## Building

### Build Source Providers
Bundles files from `src/<provider>/` into `providers/<provider>.js`.

```bash
# Build specific provider
node build.js vixsrc

# Build multiple
node build.js vixsrc uhdmovies

# Build all source providers
node build.js
```

### Transpile Single-File Providers
If you wrote a single-file provider using `async/await`, you must transpile it for compatibility.

```bash
# Transpile specific file
node build.js --transpile myprovider.js

# Transpile all applicable files in providers/
node build.js --transpile
```

### Watch Mode
Automatically rebuilds when files change.
```bash
npm run build:watch
```

---

## Testing

Create a test script to identify issues before loading into the app.

```javascript
// test-myprovider.js
const { getStreams } = require('./providers/myprovider.js');

async function test() {
  console.log('Testing...');
  const streams = await getStreams('872585', 'movie'); // Oppenheimer ID
  console.log('Streams found:', streams.length);
}

test();
```

Run with Node.js:
```bash
node test-myprovider.js
```

---

## Stream Object Format

Providers must return an array of stream objects:

```javascript
{
  name: "Provider Name",           // Provider identifier
  title: "1080p Stream",           // Stream description
  url: "https://...",              // Direct stream URL (m3u8, mp4, mkv)
  quality: "1080p",                // Quality label
  size: "2.5 GB",                  // Optional file size
  headers: {                       // Optional headers for playback
    "Referer": "https://source.com",
    "User-Agent": "Mozilla/5.0..."
  }
}
```

---

## Available Modules

Providers have access to these modules via `require()`:

| Module | Usage |
|--------|-------|
| `cheerio-without-node-native` | HTML parsing |
| `crypto-js` | Encryption/decryption |
| `axios` | HTTP requests |

Native `fetch` and `console` are also available globally.

---

## Manifest Options

The `manifest.json` file controls provider settings.

```json
{
  "id": "unique-id",
  "name": "Display Name",
  "description": "Short description",
  "version": "1.0.0",
  "author": "Your Name",
  "supportedTypes": ["movie", "tv"],
  "filename": "providers/file.js",
  "enabled": true,
  "logo": "https://url/to/logo.png",
  "contentLanguage": ["en", "hi"],
  "formats": ["mkv", "mp4"],
  "limited": false,
  "disabledPlatforms": ["ios"],
  "supportsExternalPlayer": true
}
```

---

## Contributing

1. **Fork the repository**
2. **Create a branch**: `git checkout -b add-myprovider`
3. **Develop and test**
4. **Build**: `node build.js myprovider`
5. **Commit**: `git commit -m "Add MyProvider"`
6. **Push and PR**

---

## Credits

- **Yoru** — original creator of the `nuvio-providers` framework and provider collection this repository is built on.
- **[tapframe](https://github.com/tapframe)** — creator of the Nuvio app that these providers are designed for.

---

## License

This project is licensed under the **GNU General Public License v3.0**.

---

## Disclaimer

- **No content is hosted by this repository.**
- Providers fetch publicly available content from third-party websites.
- Users are responsible for compliance with local laws.
- For DMCA concerns, contact the actual content hosts.
