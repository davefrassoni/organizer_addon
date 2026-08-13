(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OrganizerCategories = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CATEGORIES = [
    { name: "Work & Productivity", terms: ["docs", "drive", "notion", "slack", "teams", "asana", "trello", "linear", "office", "zoom"] },
    { name: "Development", terms: ["github", "gitlab", "stackoverflow", "npmjs", "developer", "localhost", "vercel", "cloudflare", "aws", "code"] },
    { name: "Communication", terms: ["mail", "gmail", "outlook", "whatsapp", "telegram", "discord", "messenger"] },
    { name: "Social", terms: ["facebook", "instagram", "linkedin", "reddit", "x.com", "twitter", "mastodon", "tiktok"] },
    { name: "News & Reading", terms: ["news", "medium", "substack", "wikipedia", "bbc", "reuters", "nytimes", "reader"] },
    { name: "Video & Music", terms: ["youtube", "netflix", "spotify", "twitch", "vimeo", "soundcloud", "music"] },
    { name: "Shopping", terms: ["amazon", "ebay", "etsy", "mercadolibre", "shop", "store", "cart"] },
    { name: "Finance", terms: ["bank", "paypal", "stripe", "wise", "finance", "trading", "crypto", "wallet"] },
    { name: "Travel & Maps", terms: ["maps", "booking", "airbnb", "trip", "travel", "flight", "hotel", "uber"] },
    { name: "Education", terms: ["course", "learn", "school", "university", "coursera", "udemy", "academy"] }
  ];

  function safeUrl(url) { try { return new URL(url); } catch (_) { return null; } }
  function categoryFor(item) {
    const parsed = safeUrl(item.url || "");
    const text = `${parsed ? parsed.hostname : ""} ${item.title || ""} ${(item.metaTags || []).join(" ")}`.toLowerCase();
    let best = null;
    for (const category of CATEGORIES) {
      const score = category.terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      if (score && (!best || score > best.score)) best = { name: category.name, score };
    }
    return best ? best.name : (parsed ? parsed.hostname.replace(/^www\./, "") : "Other");
  }
  function assignments(items) { return items.map((item, index) => ({ index, category: categoryFor(item) })); }
  return { CATEGORIES, categoryFor, assignments };
});
