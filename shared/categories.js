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
  function hostOf(url) { const parsed = safeUrl(url || ""); return parsed ? parsed.hostname.replace(/^www\./, "") : ""; }
  function topValues(values, limit) {
    const counts = new Map();
    for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
  }
  // A per-category digest for the activity screen: how many items landed in
  // each category and which sites/examples they share -- the raw material the
  // page turns into an inferred "why" for AI methods that return no reasoning.
  function summarizeCategories(items, assignmentRows) {
    const groups = new Map();
    for (const row of assignmentRows || []) {
      const item = items[row.index];
      if (!item) continue;
      if (!groups.has(row.category)) groups.set(row.category, []);
      groups.get(row.category).push(item);
    }
    return Array.from(groups.entries()).map(([name, group]) => ({
      name,
      count: group.length,
      domains: topValues(group.map(item => hostOf(item.url)), 5),
      sample: group.slice(0, 6).map(item => item.title || hostOf(item.url) || item.url || ""),
    })).sort((a, b) => b.count - a.count);
  }
  function splitDuplicateUrls(items) {
    const seen = new Set(), unique = [], duplicates = [];
    for (const item of items) {
      const url = String(item?.url || "");
      (url && seen.has(url) ? duplicates : unique).push(item);
      if (url) seen.add(url);
    }
    return { unique, duplicates };
  }
  const serializedBytes = item => new TextEncoder().encode(JSON.stringify(item)).length;
  // The [start, end) chunk boundaries batchedAssignments would use, computed
  // without calling any AI. The Dave server chunks the same way, so the
  // activity page can show which items each processed section contained.
  function chunkRanges(items, batchSize, maxSerializedBytes = Infinity) {
    const ranges = [];
    for (let offset = 0; offset < items.length;) {
      let length = 0, bytes = 2;
      while (offset + length < items.length && length < batchSize) {
        const itemBytes = serializedBytes(items[offset + length]) + (length ? 1 : 0);
        if (length && bytes + itemBytes > maxSerializedBytes) break;
        length += 1;
        bytes += itemBytes;
      }
      length = Math.max(1, length);
      ranges.push([offset, offset + length]);
      offset += length;
    }
    return ranges;
  }
  async function batchedAssignments(items, batchSize, assignBatch, maxSerializedBytes = Infinity) {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Batch size must be a positive integer.");
    if (!(maxSerializedBytes > 0)) throw new Error("Batch byte limit must be positive.");
    const combined = [];
    for (let offset = 0; offset < items.length;) {
      const batch = [];
      let batchBytes = 2;
      while (offset + batch.length < items.length && batch.length < batchSize) {
        const item = items[offset + batch.length];
        const itemBytes = serializedBytes(item) + (batch.length ? 1 : 0);
        if (batch.length && batchBytes + itemBytes > maxSerializedBytes) break;
        batch.push(item);
        batchBytes += itemBytes;
      }
      const rows = await assignBatch(batch);
      if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error("The AI returned an incomplete batch.");
      combined.push(...rows.map(row => ({ ...row, index: row.index + offset })));
      offset += batch.length;
    }
    return combined;
  }
  return { CATEGORIES, categoryFor, assignments, summarizeCategories, hostOf, splitDuplicateUrls, batchedAssignments, chunkRanges };
});
