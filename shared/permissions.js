const OrganizerPermissions = (function () {
  const api = globalThis.browser || globalThis.chrome;
  const ORIGINS = { dave: "https://davefrassoni.com/*", openai: "https://api.openai.com/*", anthropic: "https://api.anthropic.com/*", gemini: "https://generativelanguage.googleapis.com/*" };
  // `globalThis.browser` alone no longer means "this is Firefox" — modern
  // Chrome also defines a promise-based `browser` alias. `getBrowserInfo` is
  // a genuine Firefox-only WebExtensions API, so it's a reliable signal for
  // the AMO-specific `data_collection` permission field below.
  function isFirefox() { return typeof globalThis.browser?.runtime?.getBrowserInfo === "function"; }
  function buildRequest(provider) {
    const request = { origins: [ORIGINS[provider] || ORIGINS.dave] };
    if (isFirefox()) {
      request.data_collection = ["browsingActivity", "bookmarksInfo"];
      if (provider !== "dave") request.data_collection.push("authenticationInfo");
    }
    return request;
  }
  // permissions.request must be invoked synchronously from a click's call
  // stack. This stays synchronous up to that call: only the await below can
  // suspend, so it's safe to call from the very start of a click handler.
  async function request(provider) {
    const built = buildRequest(provider);
    try {
      return await api.permissions.request(built);
    } catch (error) {
      // Belt-and-suspenders: if some browser/version still rejects the
      // Firefox-only data_collection field, retry without it instead of
      // failing the whole permission request.
      if (built.data_collection && /data_collection/i.test(String(error?.message || error))) {
        const { data_collection, ...fallback } = built;
        return api.permissions.request(fallback);
      }
      throw error;
    }
  }
  return { request };
})();
