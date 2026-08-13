# Organizer — Tabs & Bookmarks

A privacy-conscious Manifest V3 extension for Firefox and Chrome. Organizer can save every restorable tab in the current window and close it, restore sessions into new windows, back up and restore bookmark trees, and import/export both backup types as JSON.

Organization always creates a backup first. Dave AI is the default organization method and requests access only when the user organizes something. Users can instead select the private built-in method, OpenAI, Anthropic Claude, or Google Gemini. The built-in method categorizes locally using a generated catalog of 10,000 popular domains, common services, titles, and page metadata when available.

AI collections are processed in batches of at most 50 links. A second 18,000-byte input cap automatically makes smaller batches for unusually long titles, URLs, or metadata; this leaves safe input and output headroom in the worker's 8k model context. Dave AI coordinates those batches under one parent request. If that request fails, expires, or is cancelled by the add-on, all unfinished child jobs are cancelled and their queued prompts are cleared.

## Privacy and AI

The built-in organization method is local and sends nothing anywhere. AI is the default method; when the user organizes, titles and URLs are sent to the chosen provider after permission is granted. Vendor keys are supplied by the user, stored in local extension storage, and sent only to that vendor. Dave AI requires no user secret and accepts only a strict, size-limited link categorization schema—never arbitrary prompts. See [PRIVACY.md](PRIVACY.md).

## Top-sites catalog

`shared/top-sites.js` contains the first 10,000 domains from the Tranco research-oriented top-sites ranking. It contains domain names only and is loaded locally. To refresh it, download Tranco's current CSV and run `node scripts/generate_top_sites.js path/to/top-sites.csv`. Tranco combines multiple sources and requires attribution; see https://tranco-list.eu/.

## Build and test

```bash
npm test
npm run build
```

Load `build/chrome` as an unpacked extension at `chrome://extensions`, or load `build/firefox/manifest.json` temporarily from `about:debugging#/runtime/this-firefox`.

## Structure

- `shared/`: background logic and user interfaces shared by both browsers.
- `chrome/manifest.json`: Chrome permissions and service worker configuration.
- `firefox/manifest.json`: Firefox background script and Gecko extension ID.
- `scripts/build.js`: produces loadable directories and store-ready ZIP files.

## Security

Never commit provider API keys. The public Dave AI client value in the source is an identifier, not authentication material. The server enforces endpoint-specific schemas, fixed prompts, payload limits, URL restrictions, rate limits, and output validation.
