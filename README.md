# Organizer — Tabs & Bookmarks

A privacy-conscious Manifest V3 extension for Firefox and Chrome. Organizer can save every restorable tab in the current window and close it, restore sessions into new windows, back up and restore bookmark trees, and import/export both backup types as JSON.

Organization always creates a backup first. Dave AI is the default organization method and requests access only when the user organizes something. Users can instead select the private built-in method, OpenAI, Anthropic Claude, or Google Gemini. The built-in method categorizes locally using a generated catalog of 10,000 popular domains, common services, titles, and page metadata when available.

By default, organizing bookmarks only touches "loose" bookmarks sitting directly in a root (Bookmarks Bar, Other Bookmarks, Mobile Bookmarks) — bookmarks already filed into a folder the user made are left untouched, and the folders Organizer creates always live inside the same root the bookmarks came from. An options checkbox restores the previous "organize everything" behavior for anyone who wants the whole library recategorized.

AI collections are processed in batches of at most 50 links. A second 18,000-byte input cap automatically makes smaller batches for unusually long titles, URLs, or metadata; this leaves safe input and output headroom in the worker's 8k model context. Dave AI coordinates those batches under one parent request. If that request fails, expires, or is cancelled by the add-on, all unfinished child jobs are cancelled and their queued prompts are cleared.

Every organize job — tabs or bookmarks, Dave AI, a vendor AI, or the built-in method — goes through one durable, checkpointed job pipeline. The extension stores progress and the relevant browser tab/bookmark IDs locally, then uses a 30-second browser alarm to keep making progress after the popup closes or a Manifest V3 service worker restarts. Folder/group creation and bookmark/tab moves are checkpointed after each step, so even a library of thousands of bookmarks or a window with hundreds of tabs keeps making progress across worker restarts instead of silently stalling partway through. Reopening the popup shows batch and application progress and provides a cancel action.

Restoring a bookmark backup merges the snapshot back into the current bookmark tree instead of dumping it into one new folder: folders are matched to existing ones by title and reused, and a bookmark is skipped if an identical URL already sits in that same folder. Nothing is ever deleted by a restore.

## Privacy and AI

The built-in organization method is local and sends nothing anywhere. AI is the default method; when the user organizes, titles and URLs are sent to the chosen provider after permission is granted. Vendor keys are supplied by the user, stored in local extension storage, and sent only to that vendor. Dave AI requires no user secret and accepts only a strict, size-limited link categorization schema—never arbitrary prompts. See [PRIVACY.md](PRIVACY.md).

## Localization

The UI is localized with the standard WebExtension `i18n` API (`shared/_locales/*/messages.json`): it defaults to the browser's own UI language and falls back to English. Supported languages: English, Spanish, French, German, Portuguese, Italian. `shared/i18n.js` applies `data-i18n`/`data-i18n-placeholder`/`data-i18n-title` attributes in the popup and options pages; `background.js` and the page scripts call `api.i18n.getMessage` directly. Offline/AI category names stay canonical/English since they become real bookmark folder and tab group titles; only their presentation as chips on the options page is translated.

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
