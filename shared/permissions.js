const OrganizerPermissions = (function () {
  const api = globalThis.browser || globalThis.chrome;
  const ORIGINS = { dave: "https://davefrassoni.com/*", openai: "https://api.openai.com/*", anthropic: "https://api.anthropic.com/*", gemini: "https://generativelanguage.googleapis.com/*" };
  // globalThis.browser no longer means Firefox -- Chrome has its own alias
  // now. getBrowserInfo is Firefox-only, so it's the reliable signal here.
  function isFirefox() { return typeof globalThis.browser?.runtime?.getBrowserInfo === "function"; }
  function buildRequest(provider) {
    const request = { origins: [ORIGINS[provider] || ORIGINS.dave] };
    if (isFirefox()) {
      request.data_collection = ["browsingActivity", "bookmarksInfo"];
      if (provider !== "dave") request.data_collection.push("authenticationInfo");
    }
    return request;
  }
  // permissions.request must run synchronously from the click's call stack;
  // only the await below suspends, so this is safe at the start of a handler.
  async function request(provider) {
    const built = buildRequest(provider);
    try {
      return await api.permissions.request(built);
    } catch (error) {
      // If a browser/version still rejects the Firefox-only data_collection
      // field, retry without it instead of failing outright.
      if (built.data_collection && /data_collection/i.test(String(error?.message || error))) {
        const { data_collection, ...fallback } = built;
        return api.permissions.request(fallback);
      }
      throw error;
    }
  }
  return { request };
})();
