const api = globalThis.browser || globalThis.chrome, DEFAULTS = { method: "ai", provider: "dave", apiKeys: {}, model: "", tabFallback: "reorder", closeDuplicateTabs: false, removeDuplicateBookmarks: false, bookmarkScope: "loose", excludeFoldersFromOrganizing: false, organizeInsideExcludedFolders: false };
const t = OrganizerI18n.t;
const $ = selector => document.querySelector(selector);
const CATEGORY_MESSAGE_KEYS = {
  "Work & Productivity": "categoryWorkProductivity",
  "Development": "categoryDevelopment",
  "Communication": "categoryCommunication",
  "Social": "categorySocial",
  "News & Reading": "categoryNewsReading",
  "Video & Music": "categoryVideoMusic",
  "Shopping": "categoryShopping",
  "Finance": "categoryFinance",
  "Travel & Maps": "categoryTravelMaps",
  "Education": "categoryEducation",
  "Science & Reference": "categoryScienceReference",
  "Health & Fitness": "categoryHealthFitness",
  "Sports": "categorySports",
  "Gaming": "categoryGaming",
  "Government & Public Services": "categoryGovernment",
  "Food & Recipes": "categoryFood",
  "Home & Real Estate": "categoryRealEstate",
  "AI Tools": "categoryAiTools",
};
async function load() { const data = await api.storage.local.get({ organizerSettings: DEFAULTS }); const value = { ...DEFAULTS, ...data.organizerSettings }; $("#method").value = value.method; $("#tab-fallback").value = value.tabFallback; $("#bookmark-scope").checked = value.bookmarkScope !== "all"; $("#exclude-folders").checked = !!value.excludeFoldersFromOrganizing; $("#organize-inside-excluded").checked = !!value.organizeInsideExcludedFolders; $("#close-duplicate-tabs").checked = !!value.closeDuplicateTabs; $("#remove-duplicate-bookmarks").checked = !!value.removeDuplicateBookmarks; $("#provider").value = value.provider; $("#model").value = value.model || ""; $("#api-key").value = value.apiKeys?.[value.provider] || ""; toggle(); toggleFolderScope(); }
function toggle() { const ai = $("#method").value === "ai", dave = $("#provider").value === "dave"; $("#ai").hidden = !ai; $("#key-label").hidden = dave; if (!dave) api.storage.local.get({ organizerSettings: DEFAULTS }).then(x => $("#api-key").value = x.organizerSettings.apiKeys?.[$("#provider").value] || ""); }
function toggleFolderScope() { $("#folder-scope-settings").hidden = !$("#bookmark-scope").checked; $("#organize-inside-excluded-row").hidden = !$("#exclude-folders").checked; }
$("#method").onchange = toggle; $("#provider").onchange = toggle;
$("#bookmark-scope").onchange = toggleFolderScope; $("#exclude-folders").onchange = toggleFolderScope;
document.querySelector("form").onsubmit = async event => { event.preventDefault(); const provider = $("#provider").value, method = $("#method").value, tabFallback = $("#tab-fallback").value, bookmarkScope = $("#bookmark-scope").checked ? "loose" : "all", excludeFoldersFromOrganizing = $("#exclude-folders").checked, organizeInsideExcludedFolders = $("#exclude-folders").checked && $("#organize-inside-excluded").checked, closeDuplicateTabs = $("#close-duplicate-tabs").checked, removeDuplicateBookmarks = $("#remove-duplicate-bookmarks").checked; let permissionRequest = Promise.resolve(true); if (method === "ai" && api.permissions) { const origins = { dave: "https://davefrassoni.com/*", openai: "https://api.openai.com/*", anthropic: "https://api.anthropic.com/*", gemini: "https://generativelanguage.googleapis.com/*" }; const request = { origins: [origins[provider]] }; if (globalThis.browser) { request.data_collection = ["browsingActivity", "bookmarksInfo"]; if (provider !== "dave") request.data_collection.push("authenticationInfo"); } permissionRequest = api.permissions.request(request); } const old = (await api.storage.local.get({ organizerSettings: DEFAULTS })).organizerSettings; if (!await permissionRequest) { $("#status").textContent = t("aiAccessNotGranted"); return; } const apiKeys = { ...(old.apiKeys || {}) }; if (provider !== "dave") apiKeys[provider] = $("#api-key").value.trim(); await api.storage.local.set({ organizerSettings: { method, provider, model: $("#model").value.trim(), apiKeys, tabFallback, bookmarkScope, excludeFoldersFromOrganizing, organizeInsideExcludedFolders, closeDuplicateTabs, removeDuplicateBookmarks } }); $("#status").textContent = t("savedStatus"); };
OrganizerI18n.apply();
for (const category of OrganizerCategories.CATEGORIES) { const chip = document.createElement("span"); chip.textContent = t(CATEGORY_MESSAGE_KEYS[category.name] || category.name); $("#categories").append(chip); } load();
