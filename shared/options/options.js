const api = globalThis.browser || globalThis.chrome, DEFAULTS = { method: "ai", provider: "dave", apiKeys: {}, model: "", tabFallback: "reorder", closeDuplicateTabs: false, removeDuplicateBookmarks: false, bookmarkScope: "loose", excludeFoldersFromOrganizing: false, organizeInsideExcludedFolders: false, openActivityOnStart: true, uiLanguage: "auto", keepBackupFolder: true };
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
async function load() { const data = await api.storage.local.get({ organizerSettings: DEFAULTS }); const value = { ...DEFAULTS, ...data.organizerSettings }; $("#ui-language").value = OrganizerI18n.SUPPORTED.includes(value.uiLanguage) || value.uiLanguage === "auto" ? value.uiLanguage : "auto"; $("#method").value = value.method; $("#tab-fallback").value = value.tabFallback; $("#bookmark-scope").checked = value.bookmarkScope !== "all"; $("#exclude-folders").checked = !!value.excludeFoldersFromOrganizing; $("#organize-inside-excluded").checked = !!value.organizeInsideExcludedFolders; $("#close-duplicate-tabs").checked = !!value.closeDuplicateTabs; $("#remove-duplicate-bookmarks").checked = !!value.removeDuplicateBookmarks; $("#keep-backup-folder").checked = value.keepBackupFolder !== false; $("#open-activity").checked = value.openActivityOnStart !== false; $("#provider").value = value.provider; $("#model").value = value.model || ""; $("#api-key").value = value.apiKeys?.[value.provider] || ""; toggle(); toggleFolderScope(); }
function toggle() { const ai = $("#method").value === "ai", dave = $("#provider").value === "dave"; $("#ai").hidden = !ai; $("#key-label").hidden = dave; if (!dave) api.storage.local.get({ organizerSettings: DEFAULTS }).then(x => $("#api-key").value = x.organizerSettings.apiKeys?.[$("#provider").value] || ""); }
function toggleFolderScope() { $("#folder-scope-settings").hidden = !$("#bookmark-scope").checked; $("#organize-inside-excluded-row").hidden = !$("#exclude-folders").checked; }
$("#method").onchange = toggle; $("#provider").onchange = toggle;
$("#bookmark-scope").onchange = toggleFolderScope; $("#exclude-folders").onchange = toggleFolderScope;
document.querySelector("form").onsubmit = async event => { event.preventDefault(); const provider = $("#provider").value, method = $("#method").value, tabFallback = $("#tab-fallback").value, bookmarkScope = $("#bookmark-scope").checked ? "loose" : "all", excludeFoldersFromOrganizing = $("#exclude-folders").checked, organizeInsideExcludedFolders = $("#exclude-folders").checked && $("#organize-inside-excluded").checked, closeDuplicateTabs = $("#close-duplicate-tabs").checked, removeDuplicateBookmarks = $("#remove-duplicate-bookmarks").checked, keepBackupFolder = $("#keep-backup-folder").checked, openActivityOnStart = $("#open-activity").checked, uiLanguage = $("#ui-language").value; try { const permissionRequest = method === "ai" && api.permissions ? OrganizerPermissions.request(provider) : Promise.resolve(true); const old = (await api.storage.local.get({ organizerSettings: DEFAULTS })).organizerSettings; if (!await permissionRequest) { $("#status").textContent = t("aiAccessNotGranted"); return; } const apiKeys = { ...(old.apiKeys || {}) }; if (provider !== "dave") apiKeys[provider] = $("#api-key").value.trim(); await api.storage.local.set({ organizerSettings: { method, provider, model: $("#model").value.trim(), apiKeys, tabFallback, bookmarkScope, excludeFoldersFromOrganizing, organizeInsideExcludedFolders, closeDuplicateTabs, removeDuplicateBookmarks, keepBackupFolder, openActivityOnStart, uiLanguage } }); $("#status").textContent = t("savedStatus"); } catch (error) { $("#status").textContent = error.message || t("errorGeneric"); } };
function renderCategoryChips() { const list = OrganizerCategories.CATEGORIES.map(category => Object.assign(document.createElement("span"), { textContent: t(CATEGORY_MESSAGE_KEYS[category.name] || category.name) })); $("#categories").replaceChildren(...list); }
async function relocalize() { await OrganizerI18n.init(); OrganizerI18n.apply(); document.title = t("optionsTitle"); renderCategoryChips(); }
$("#ui-language").onchange = async () => {
  const stored = (await api.storage.local.get({ organizerSettings: DEFAULTS })).organizerSettings;
  await api.storage.local.set({ organizerSettings: { ...DEFAULTS, ...stored, uiLanguage: $("#ui-language").value } });
  await relocalize();
};
OrganizerI18n.apply();
OrganizerI18n.init().then(() => { OrganizerI18n.apply(); document.title = t("optionsTitle"); renderCategoryChips(); load(); });
