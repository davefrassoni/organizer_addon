# Organizer privacy policy

Last updated: August 13, 2026.

Organizer stores tab-session backups, bookmark backups, settings, resumable AI job status, and optional AI-provider API keys locally in the user's browser. Resumable job records contain the Dave parent job ID and browser bookmark IDs, but do not duplicate bookmark titles or URLs. Organizer has no analytics, advertising, tracking pixels, or sale of user information.

## Local features

The built-in organizer, backup, restore, import, and export features operate locally. Organizer reads the titles and URLs of tabs or bookmarks only to perform the action requested by the user. JSON files are created only when the user selects Export. Imported data remains in extension-local browser storage. Organizer does not transmit locally organized data.

## Optional AI organization

AI organization with Dave AI is the default organization method, but no data is sent until the user presses an Organize button and grants the browser's requested access. Organizer sends only the titles, URLs, and limited metadata of the tabs or bookmarks the user asks it to organize. It does not send page bodies, cookies, form contents, unrelated browsing history, or arbitrary prompts. Users can select the built-in offline method at any time.

The user chooses the processor:

- **Dave AI:** data is sent over HTTPS to `davefrassoni.com` solely to return category assignments. Requests accept only a size-limited organizer schema and a server-authored prompt. Link-bearing job payloads are erased when processing reaches a completed or failed state; category assignments and minimal operational status may remain for maintenance and abuse prevention.
- **OpenAI, Anthropic, or Google Gemini:** data is sent directly from the extension to the selected provider using the API key supplied by the user. That provider's privacy policy and retention terms apply. Dave Frassoni does not receive these requests or API keys.

Provider API keys are stored in extension-local browser storage, are never included in exports, and are sent only to the provider selected by the user. Browser permissions for external AI access are requested when the user enables that provider.

## Sharing, security, and control

Data is shared only with the AI processor explicitly selected by the user and only to provide the requested organization feature. It is not used for advertising, profiling, credit decisions, or unrelated AI requests. Network transfers use HTTPS.

Users can delete individual backups in Organizer, clear extension storage through browser settings, remove saved API keys in Settings, or uninstall the extension. Exported JSON files remain under the user's control.

The use of information received from browser APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

Questions: `hello@davefrassoni.com`
