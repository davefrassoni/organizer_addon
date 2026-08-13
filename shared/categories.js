(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OrganizerCategories = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CATEGORIES = [
    { name: "Work & Productivity", terms: ["docs", "drive", "notion", "slack", "teams", "asana", "trello", "linear", "office", "zoom", "calendar", "workspace", "dropbox", "figma", "miro", "airtable", "atlassian"] },
    { name: "Development", terms: ["github", "gitlab", "stackoverflow", "npmjs", "developer", "localhost", "vercel", "cloudflare", "aws", "azure", "code", "docker", "kubernetes", "jetbrains", "python", "linux"] },
    { name: "Communication", terms: ["mail", "gmail", "outlook", "whatsapp", "telegram", "discord", "messenger", "signal", "proton", "meet", "chat"] },
    { name: "Social", terms: ["facebook", "instagram", "linkedin", "reddit", "x.com", "twitter", "mastodon", "tiktok", "pinterest", "snapchat", "threads"] },
    { name: "News & Reading", terms: ["news", "medium", "substack", "wikipedia", "bbc", "reuters", "nytimes", "guardian", "reader", "journal", "press", "newspaper"] },
    { name: "Video & Music", terms: ["youtube", "netflix", "spotify", "twitch", "vimeo", "soundcloud", "music", "hulu", "disneyplus", "primevideo", "deezer", "podcast"] },
    { name: "Shopping", terms: ["amazon", "ebay", "etsy", "mercadolibre", "aliexpress", "walmart", "shop", "store", "cart", "retail", "marketplace", "ikea"] },
    { name: "Finance", terms: ["bank", "paypal", "stripe", "wise", "finance", "trading", "crypto", "wallet", "invest", "broker", "visa", "mastercard", "coinbase", "binance"] },
    { name: "Travel & Maps", terms: ["maps", "booking", "airbnb", "trip", "travel", "flight", "hotel", "uber", "lyft", "expedia", "airline", "railway"] },
    { name: "Education", terms: ["course", "learn", "school", "university", "coursera", "udemy", "academy", "college", "education", "quizlet", "duolingo", "khan"] },
    { name: "Science & Reference", terms: ["science", "research", "scholar", "nature", "dictionary", "reference", "archive", "library", "britannica", "pubmed"] },
    { name: "Health & Fitness", terms: ["health", "medical", "clinic", "hospital", "doctor", "fitness", "workout", "nutrition", "pharmacy", "webmd"] },
    { name: "Sports", terms: ["sport", "football", "soccer", "basketball", "baseball", "tennis", "nba", "nfl", "espn", "fifa", "uefa"] },
    { name: "Gaming", terms: ["game", "gaming", "steam", "playstation", "xbox", "nintendo", "roblox", "epicgames", "minecraft", "ign"] },
    { name: "Government & Public Services", terms: ["government", "gov.", ".gov", "municipal", "ministry", "public service", "tax", "embassy"] },
    { name: "Food & Recipes", terms: ["food", "recipe", "cooking", "restaurant", "delivery", "doordash", "ubereats", "grubhub", "allrecipes"] },
    { name: "Home & Real Estate", terms: ["realestate", "real estate", "property", "realtor", "zillow", "housing", "home", "apartment", "rent"] },
    { name: "AI Tools", terms: ["openai", "chatgpt", "anthropic", "claude", "gemini", "huggingface", "perplexity", "copilot", "midjourney", "artificial intelligence"] }
  ];
  const TOP_SITES = new Set((typeof OrganizerTopSites !== "undefined" ? OrganizerTopSites : []));

  function safeUrl(url) { try { return new URL(url); } catch (_) { return null; } }
  function categoryFor(item) {
    const parsed = safeUrl(item.url || "");
    const text = `${parsed ? parsed.hostname : ""} ${item.title || ""} ${(item.metaTags || []).join(" ")}`.toLowerCase();
    let best = null;
    for (const category of CATEGORIES) {
      const score = category.terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      if (score && (!best || score > best.score)) best = { name: category.name, score };
    }
    const hostname = parsed ? parsed.hostname.replace(/^www\./, "") : "";
    return best ? best.name : (TOP_SITES.has(hostname) ? "Popular Websites" : (hostname || "Other"));
  }
  function assignments(items) { return items.map((item, index) => ({ index, category: categoryFor(item) })); }
  function splitDuplicateUrls(items) {
    const seen = new Set(), unique = [], duplicates = [];
    for (const item of items) {
      const url = String(item?.url || "");
      (url && seen.has(url) ? duplicates : unique).push(item);
      if (url) seen.add(url);
    }
    return { unique, duplicates };
  }
  async function batchedAssignments(items, batchSize, assignBatch) {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Batch size must be a positive integer.");
    const combined = [];
    for (let offset = 0; offset < items.length; offset += batchSize) {
      const batch = items.slice(offset, offset + batchSize);
      const rows = await assignBatch(batch);
      if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error("The AI returned an incomplete batch.");
      combined.push(...rows.map(row => ({ ...row, index: row.index + offset })));
    }
    return combined;
  }
  return { CATEGORIES, categoryFor, assignments, splitDuplicateUrls, batchedAssignments };
});
