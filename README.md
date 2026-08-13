# Organizer — Tabs & Bookmarks

A privacy-conscious Manifest V3 extension for Firefox and Chrome. Organizer can save every restorable tab in the current window and close it, restore sessions into new windows, back up and restore bookmark trees, and import/export both backup types as JSON.

Organization always creates a backup first. Dave AI is the default organization method and requests access only when the user organizes something. Users can instead select the private built-in method, OpenAI, Anthropic Claude, or Google Gemini. The built-in method categorizes locally using common services, domains, titles, and page metadata when available.

## Privacy and AI

The default organization method is local and sends nothing anywhere. When a user explicitly selects AI organization, titles and URLs are sent to the chosen provider. Vendor keys are supplied by the user, stored in local extension storage, and sent only to that vendor. Dave AI requires no user secret and accepts only a strict, size-limited link categorization schema—never arbitrary prompts. See [PRIVACY.md](PRIVACY.md).

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
