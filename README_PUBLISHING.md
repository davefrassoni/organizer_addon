# Store publishing guide

This guide is for Organizer v0.1.9. Keep the version identical in
`package.json`, `chrome/manifest.json`, and `firefox/manifest.json` before each
release.

## Build and verify

```bash
npm test
npm run build
```

Test `build/chrome` through `chrome://extensions` → **Developer mode** →
**Load unpacked**. Test Firefox through `about:debugging#/runtime/this-firefox`
→ **Load Temporary Add-on** and select `build/firefox/manifest.json`.

Upload these packages:

- Chrome: `dist/organizer-chrome-v0.1.9.zip`
- Firefox: `dist/organizer-firefox-v0.1.9.zip`

The ZIPs contain readable, unminified source and need no separate source-code
archive for this release.

## Shared listing content

**Name**

> Organizer — Tabs & Bookmarks

**Short summary**

> Back up, restore, import, export, and intelligently organize your tabs and bookmarks.

**Detailed description**

> Clear the clutter without losing the context.
>
> Organizer is a privacy-conscious tab and bookmark manager for Firefox and Chrome. Save every open tab in the current window with one click, close the window, and restore the complete session later in a new window.
>
> FEATURES
>
> • Back up all tabs in the current window
> • Save and close a complete tab session in one action
> • Restore saved sessions in a new window
> • Back up and restore your bookmark organization
> • Delete backups you no longer need
> • Import and export tab sessions and bookmark backups as JSON
> • Automatically organize related tabs
> • Automatically organize bookmarks, with a safety backup created first
> • Choose private built-in categories or optional AI organization
> • Choose Dave AI, OpenAI, Anthropic Claude, or Google Gemini
>
> PRIVATE BY DEFAULT
>
> Dave AI is the default organization method, but no data is sent until you press an Organize button and grant browser access. Organizer contains no analytics or advertising. Only the titles and URLs you ask to organize are sent to the provider you select. You can switch to the built-in offline method at any time.
>
> ALWAYS BACKED UP
>
> Organizer creates a backup before every automatic organization operation, so you can keep working without putting your current setup at risk.
>
> OPEN SOURCE
>
> Review the code, report issues, or contribute at https://github.com/davefrassoni/organizer_addon

**Homepage / website**

> https://davefrassoni.com/organizer/

**Support website**

> https://github.com/davefrassoni/organizer_addon/issues

**Support email**

> hello@davefrassoni.com

**Privacy policy URL**

> https://github.com/davefrassoni/organizer_addon/blob/main/PRIVACY.md

**Donation URL**

> https://paypal.me/dfranchesco

## Graphic assets

Use `shared/icons/icon-128.png` as the store icon.

Upload screenshots from `store-assets/v0.1.9/` in this order:

1. `screenshot-tab-sessions-1280x800.png`
2. `screenshot-bookmarks-1280x800.png`
3. `screenshot-ai-options-1280x800.png`
4. `screenshot-privacy-1280x800.png`

Chrome also requires:

- Small promotional tile: `promo-small-440x280.png`
- Optional marquee: `promo-marquee-1400x560.png`

Additional icons and the multi-size favicon are in `shared/icons/`. The source
brand mark is `shared/icons/icon.svg`.

## Chrome Web Store

1. Open https://chrome.google.com/webstore/devconsole/ and use the account that
   will own the listing. Complete developer registration, contact verification,
   and two-step verification if needed.
2. Select **Add new item** and upload the Chrome ZIP.
3. In **Store listing**, paste the shared listing content above.
4. Set **Category** to **Productivity** and **Language** to **English**.
5. Upload the icon, four screenshots, small promotional tile, and marquee from
   the paths above. A YouTube URL is optional; leave it empty until a real demo
   video exists.
6. In **Privacy practices**, use the answers below.
7. In **Distribution**, choose **Public**, all regions, and the normal free
   distribution option. Use **Unlisted** first only if you want a link-only
   review before launch.
8. Save every tab, run the dashboard's validation, and select **Submit for
   review**. Automatic publication after approval is appropriate unless you
   want to coordinate the launch manually.

### Chrome privacy fields

**Single purpose**

> Help users back up, restore, transfer, and organize browser tabs and bookmarks, using local categorization by default and user-selected AI categorization as an optional part of the same organization workflow.

**`tabs` permission**

> Reads the titles and URLs of tabs in the current window to create user-requested session backups. It also closes, opens, moves, and groups tabs when the user selects save, restore, or organize. Organizer does not silently collect unrelated browsing history.

**`bookmarks` permission**

> Reads the user's bookmark tree to create backups and moves or recreates bookmark entries when the user selects organize or restore.

**`storage` permission**

> Stores tab sessions, bookmark backups, organization settings, and optional user-supplied provider API keys in extension-local browser storage. API keys are not included in exported backup files.

**`tabGroups` permission**

> Places related tabs into named Chrome tab groups when the user selects Organize tabs.

**Optional host permissions**

> External access is requested only after the user enables an AI provider. The selected host receives the titles and URLs the user asks to categorize and returns category assignments. Dave AI uses davefrassoni.com; direct provider choices use api.openai.com, api.anthropic.com, or generativelanguage.googleapis.com. The built-in organization method requires no host access.

**Remote code**

Select **No, I am not using remote code**.

> All executable extension code is packaged in the ZIP. AI providers are called as data-processing APIs and return category data; their responses are never executed as code.

**Data-use disclosures**

Select the dashboard categories corresponding to **Web history / browsing
activity**, **Website content** (tab and bookmark titles/URLs), and
**Authentication information** (only user-supplied third-party AI API keys).
Do not select financial, health, location, personal communications, or
personally identifiable information. Certify all Limited Use statements.

Use this explanation if a free-text data-use field appears:

> Organizer handles tab URLs, tab titles, bookmark URLs, and bookmark titles solely to provide user-requested backup and organization features. The local method transmits nothing. When the user explicitly enables AI organization, the selected links are sent over HTTPS only to the provider chosen by the user. Optional provider API keys are stored locally and sent only to that provider. No data is sold, used for advertising, or used for unrelated purposes, and humans do not read user link data except where required for security or legal compliance.

## Firefox Add-ons (AMO)

1. Open https://addons.mozilla.org/developers/ and sign in with the Mozilla
   account that will own the add-on.
2. Choose **Submit a New Add-on** → **On this site** and upload the Firefox ZIP.
3. Choose Firefox desktop as the supported platform. Do not select Android for
   this release: the tab-window workflow has not been validated there.
4. The code is readable and unminified. If asked whether a separate source-code
   package is needed, select **No**.
5. On **Describe Add-on**, use the shared copy above.
6. Suggested URL slug: `organizer-tabs-bookmarks`.
7. Select up to two categories: **Tabs** and **Bookmarks** (or the closest names
   presented by AMO).
8. Do not mark the add-on experimental and do not mark it as requiring payment.
   Donations and third-party AI providers are optional; all core features work
   without payment.
9. Set the support email, support website, privacy policy, and donation URL from
   the shared fields above. Choose **Mozilla Public License 2.0**, matching the
   repository's `LICENSE` file.
10. Upload the four screenshots in the order listed above and submit the
    version for review.

### Firefox data declarations

The manifest declares no required transmission and these optional data types:

- **Browsing activity:** titles and URLs of tabs selected for AI organization.
- **Bookmarks:** titles and URLs of bookmarks selected for AI organization.
- **Authentication information:** a user-supplied API key when OpenAI,
  Anthropic, or Gemini is selected.

Firefox asks for these optional permissions when the user saves AI settings.
The built-in method works without granting them.

**Notes for reviewers**

> Organizer is functional without an account and defaults to Dave AI categorization. Open the toolbar popup to back up tabs or bookmarks. When Organize is first pressed, Firefox requests optional browsing-activity and bookmark data-transmission consent plus access to davefrassoni.com. No data is sent before that user action and consent. The built-in offline method is available in Settings. Automatic organization always creates a backup first. OpenAI, Anthropic, and Gemini require a reviewer-supplied API key; no key is included in the package. All JavaScript is readable and unminified, and the build script only copies shared files and creates the browser-specific ZIP.

## Official references

- Chrome listing fields and assets: https://developer.chrome.com/docs/webstore/cws-dashboard-listing/
- Chrome image requirements: https://developer.chrome.com/docs/webstore/images
- Chrome privacy fields: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/
- Firefox submission flow: https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
- Firefox data consent: https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
