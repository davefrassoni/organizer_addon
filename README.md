# Organizer — Tabs & Bookmarks

A privacy-conscious Manifest V3 extension for Firefox and Chrome. Organizer can save every restorable tab in the current window and close it, restore sessions into new windows, back up and restore bookmark trees, and import/export both backup types as JSON.

[Landing page](https://davefrassoni.com/organizer/) · [Install for Firefox](https://addons.mozilla.org/en-US/firefox/addon/organizer-tabs-bookmarks/) · [Install for Chrome](https://chromewebstore.google.com/detail/organizer-%E2%80%94-tabs-bookmark/hkdidohkmfhjahagjihpohjenkjejbpl)

Organization always creates a backup first — a snapshot in extension storage, and (unless "Keep the old layout in a \"backup\" folder" is turned off in Settings, on by default) a copy of the current arrangement dropped into a dated folder inside a `backup` folder in the first bookmark root, so the previous layout stays browsable in the bookmark manager. The organizer always skips that `backup` folder. Dave AI is the default organization method and requests access only when the user organizes something. Users can instead select the private built-in method, OpenAI, Anthropic Claude, or Google Gemini. The built-in method categorizes locally using a generated catalog of 10,000 popular domains, common services, titles, and page metadata when available.

By default, organizing bookmarks only touches items sitting directly in a root (Bookmarks Bar, Other Bookmarks, Mobile Bookmarks): loose bookmarks and top-level folders are sent for categorization, and the resulting category folders are created directly inside that same root — never a separate "Organizer" wrapper folder. A folder is sent and moved as a single unit, so its own contents (including anything nested inside it) move together and are never broken apart or recategorized individually; bookmarks already filed a level deeper are left untouched entirely. A top-level folder whose assigned category is its own name is adopted as that category folder instead of being wrapped in a fresh copy, so re-running organize doesn't nest `Development / Development / …` deeper each time. An options checkbox restores the previous "organize everything" behavior for anyone who wants the whole library flattened and recategorized; when that pass (or organizing inside an excluded folder) empties a user folder by moving its bookmarks out, the now-empty folder is removed — roots are never removed.

Two more options refine that top-level pass over folders: "Don't move bookmark folders themselves" (off by default) excludes folders from being moved at all, leaving both the folder and its contents exactly where they are; turning that on reveals "Still organize the bookmarks inside those folders", which — instead of leaving an excluded folder's contents alone — sorts that folder's own direct bookmarks into new category folders created inside it, as their own batch, without moving the folder or touching anything nested deeper inside it.

AI collections are processed in batches of at most 50 links. A second 18,000-byte input cap automatically makes smaller batches for unusually long titles, URLs, or metadata; this leaves safe input and output headroom in the worker's 8k model context. Dave AI coordinates those batches under one parent request. If that request fails, expires, or is cancelled by the add-on, all unfinished child jobs are cancelled and their queued prompts are cleared.

Every organize job — tabs or bookmarks, Dave AI, a vendor AI, or the built-in method — goes through one durable, checkpointed job pipeline. The extension stores progress and the relevant browser tab/bookmark IDs locally, then uses a 30-second browser alarm to keep making progress after the popup closes or a Manifest V3 service worker restarts. Folder/group creation and bookmark/tab moves are checkpointed after each step, so even a library of thousands of bookmarks or a window with hundreds of tabs keeps making progress across worker restarts instead of silently stalling partway through. Reopening the popup shows batch and application progress (most recently updated job first) and provides a cancel action. A finished job (completed, failed, or cancelled) fades out and clears itself from the panel a few seconds after it's been seen; closing the popup before then leaves it in place to show again next time.

## AI activity page

Whenever an AI organize job starts, Organizer opens `activity/activity.html` in a tab (turn this off with "Show the AI activity page automatically" in Settings; it stays reachable from the popup's "View AI detail" button). The page live-polls the job and shows: a summary (method, provider, item count, state, timestamps); a collapsed row per section the AI works through, each marked queued / processing / done and expandable to the items it contains and the category each got (the whole set is submitted at once — the wait is the model, not the upload — and the section boundaries are the byte-aware chunking `OrganizerCategories.chunkRanges` reproduces locally, falling back to an even split); and the full results grouped by category (each group lists the sites its items have in common) or as a flat item→category list. The page also has Retry (re-runs the organize for that kind), Cancel (while active), and Undo — which for bookmarks does an exact restore of the backup taken just before organizing, and for tabs ungroups and returns every tab to its previous position.

Restoring a bookmark backup reproduces the snapshot exactly. Each root the snapshot covers (matched to a live root by id, then title, then position) has its current contents cleared and the saved subtree rebuilt in original order, so a restore undoes an organize run completely — no leftover category folders, no folders left empty, no duplicated bookmarks. A restore first saves a fresh backup of the pre-restore tree, so it is itself undoable. Roots the snapshot doesn't include are left alone.

## Privacy and AI

The built-in organization method is local and sends nothing anywhere. AI is the default method; when the user organizes, titles and URLs are sent to the chosen provider after permission is granted. Vendor keys are supplied by the user, stored in local extension storage, and sent only to that vendor. Dave AI requires no user secret and accepts only a strict, size-limited link categorization schema—never arbitrary prompts. See [PRIVACY.md](PRIVACY.md).

## Localization

Messages live in `shared/_locales/*/messages.json` (English, Spanish, French, German, Portuguese, Italian). `shared/i18n.js` (`OrganizerI18n`) localizes the popup, settings, and activity pages: `init()` reads the `uiLanguage` setting, and when it is a specific locale it `fetch`es that `_locales/<lang>/messages.json` and layers it over the browser default; `"auto"` (the default) uses the browser UI language when it is one of the six, otherwise English. `apply()` fills `data-i18n`/`data-i18n-placeholder`/`data-i18n-title` attributes and `t(key, subs)` does `$1`/`$2` substitution, falling back to English then to `api.i18n.getMessage`. The Language selector at the top of Settings sets `uiLanguage`. `background.js` still calls `api.i18n.getMessage` directly (its strings are error/skip notices). Category names stay canonical English since they become real bookmark folder and tab group titles; only their presentation as chips on the options page is translated.

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
