const api = globalThis.browser || globalThis.chrome, DEFAULTS = { method: "ai", provider: "dave", apiKeys: {}, model: "", tabFallback: "reorder", closeDuplicateTabs: false, removeDuplicateBookmarks: false, bookmarkScope: "loose", excludeFoldersFromOrganizing: false, organizeInsideExcludedFolders: false, openActivityOnStart: true, uiLanguage: "auto", keepBackupFolder: true, categories: null };
const t = OrganizerI18n.t;
const C = OrganizerCategories;
const $ = selector => document.querySelector(selector);
const stored = async () => ({ ...DEFAULTS, ...(await api.storage.local.get({ organizerSettings: DEFAULTS })).organizerSettings });

// The working copy of the category list; saved with the rest of the form.
let categories = C.defaultCategoryList();
let nextCategoryId = 1;

async function load() { const value = await stored(); $("#ui-language").value = OrganizerI18n.SUPPORTED.includes(value.uiLanguage) || value.uiLanguage === "auto" ? value.uiLanguage : "auto"; $("#method").value = value.method; $("#tab-fallback").value = value.tabFallback; $("#bookmark-scope").checked = value.bookmarkScope !== "all"; $("#exclude-folders").checked = !!value.excludeFoldersFromOrganizing; $("#organize-inside-excluded").checked = !!value.organizeInsideExcludedFolders; $("#close-duplicate-tabs").checked = !!value.closeDuplicateTabs; $("#remove-duplicate-bookmarks").checked = !!value.removeDuplicateBookmarks; $("#keep-backup-folder").checked = value.keepBackupFolder !== false; $("#open-activity").checked = value.openActivityOnStart !== false; $("#provider").value = value.provider; $("#model").value = value.model || ""; $("#api-key").value = value.apiKeys?.[value.provider] || ""; categories = C.userCategoryList(value.categories); renderCategories(); toggle(); toggleFolderScope(); setStatus(""); }
function toggle() { const ai = $("#method").value === "ai", dave = $("#provider").value === "dave"; $("#ai").hidden = !ai; $("#key-label").hidden = dave; $("#model-label").hidden = dave; $("#categories-builtin-note").hidden = ai; if (!dave) stored().then(x => $("#api-key").value = x.apiKeys?.[$("#provider").value] || ""); }
function toggleFolderScope() { $("#folder-scope-settings").hidden = !$("#bookmark-scope").checked; $("#organize-inside-excluded-row").hidden = !$("#exclude-folders").checked; }
function setStatus(text, dirty = false) { $("#status").textContent = text; $("#status").classList.toggle("dirty", dirty); }
function markDirty() { setStatus(t("unsavedChanges"), true); }
$("#method").onchange = toggle; $("#provider").onchange = toggle;
$("#bookmark-scope").onchange = toggleFolderScope; $("#exclude-folders").onchange = toggleFolderScope;
document.querySelector("form").addEventListener("input", event => { if (event.target.id !== "new-category" && event.target.id !== "ui-language") markDirty(); });

// --- Categories: add, rename in place, delete, reset ---
function problemMessage(problem) {
  if (!problem) return "";
  if (problem.code === "empty") return t("categoryErrorEmpty");
  if (problem.code === "limit") return t("categoryErrorLimit", [String(C.MAX_USER_CATEGORIES)]);
  if (problem.code === "duplicate") return t("categoryErrorDuplicate", [problem.name]);
  return problem.name ? t("categoryErrorInvalid", [problem.name]) : t("categoryErrorBlank");
}
function showCategoryError(message) { $("#category-error").textContent = message; $("#category-error").hidden = !message; }
function renderCategories(focusIndex = -1) {
  const rows = categories.map((entry, index) => {
    const row = document.createElement("li");
    const input = Object.assign(document.createElement("input"), { value: entry.name, maxLength: C.MAX_CATEGORY_NAME, autocomplete: "off", spellcheck: false });
    input.setAttribute("aria-label", t("categoryNameLabel"));
    input.oninput = () => { entry.name = input.value; row.classList.remove("invalid"); showCategoryError(""); };
    input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); $("#new-category").focus(); } };
    const remove = Object.assign(document.createElement("button"), { type: "button", className: "remove", textContent: "×" });
    remove.setAttribute("aria-label", t("categoryDelete", [entry.name]));
    remove.title = t("categoryDelete", [entry.name]);
    remove.onclick = () => { categories.splice(index, 1); renderCategories(Math.min(index, categories.length - 1)); markDirty(); };
    row.append(input, remove);
    return row;
  });
  $("#category-list").replaceChildren(...rows);
  $("#category-count").textContent = t("categoryCount", [String(categories.length), String(C.MAX_USER_CATEGORIES)]);
  const full = categories.length >= C.MAX_USER_CATEGORIES;
  $("#new-category").disabled = full;
  $("#add-category").disabled = full;
  // After a delete, keep keyboard focus in the list instead of losing it.
  if (focusIndex >= 0) rows[focusIndex].querySelector(".remove").focus();
}
function addCategory() {
  const name = C.cleanCategoryName($("#new-category").value);
  if (!name) return;
  const candidate = [...categories, { id: `u${Date.now().toString(36)}-${nextCategoryId++}`, name }];
  const problem = C.categoryListProblem(candidate);
  if (problem) { showCategoryError(problemMessage(problem)); $("#new-category").focus(); return; }
  categories = candidate;
  $("#new-category").value = "";
  showCategoryError("");
  renderCategories();
  $("#new-category").focus();
  markDirty();
}
$("#add-category").onclick = addCategory;
$("#new-category").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); addCategory(); } };
$("#reset-categories").onclick = () => { categories = C.defaultCategoryList(); showCategoryError(""); renderCategories(); markDirty(); };
// Stored as null while it still matches Organizer's own list, so a future
// update to the defaults reaches people who never customized theirs.
function categoriesToStore() {
  const clean = categories.map(entry => ({ id: entry.id, name: C.cleanCategoryName(entry.name) }));
  const defaults = C.defaultCategoryList();
  const unchanged = clean.length === defaults.length && clean.every((entry, index) => entry.id === defaults[index].id && entry.name === defaults[index].name);
  return unchanged ? null : clean;
}

document.querySelector("form").onsubmit = async event => {
  event.preventDefault();
  const problem = C.categoryListProblem(categories);
  if (problem) {
    showCategoryError(problemMessage(problem));
    const bad = categories.findIndex(entry => C.cleanCategoryName(entry.name) === problem.name);
    const row = $("#category-list").children[bad];
    if (row) { row.classList.add("invalid"); row.querySelector("input").focus(); } else $("#new-category").focus();
    setStatus(t("categoryFixBeforeSaving"), true);
    return;
  }
  const provider = $("#provider").value, method = $("#method").value, tabFallback = $("#tab-fallback").value, bookmarkScope = $("#bookmark-scope").checked ? "loose" : "all", excludeFoldersFromOrganizing = $("#exclude-folders").checked, organizeInsideExcludedFolders = $("#exclude-folders").checked && $("#organize-inside-excluded").checked, closeDuplicateTabs = $("#close-duplicate-tabs").checked, removeDuplicateBookmarks = $("#remove-duplicate-bookmarks").checked, keepBackupFolder = $("#keep-backup-folder").checked, openActivityOnStart = $("#open-activity").checked, uiLanguage = $("#ui-language").value;
  try {
    const permissionRequest = method === "ai" && api.permissions ? OrganizerPermissions.request(provider) : Promise.resolve(true);
    const old = await stored();
    if (!await permissionRequest) { setStatus(t("aiAccessNotGranted"), true); return; }
    const apiKeys = { ...(old.apiKeys || {}) };
    if (provider !== "dave") apiKeys[provider] = $("#api-key").value.trim();
    await api.storage.local.set({ organizerSettings: { method, provider, model: $("#model").value.trim(), apiKeys, tabFallback, bookmarkScope, excludeFoldersFromOrganizing, organizeInsideExcludedFolders, closeDuplicateTabs, removeDuplicateBookmarks, keepBackupFolder, openActivityOnStart, uiLanguage, categories: categoriesToStore() } });
    categories = categories.map(entry => ({ ...entry, name: C.cleanCategoryName(entry.name) }));
    renderCategories();
    setStatus(t("savedStatus"));
  } catch (error) { setStatus(error.message || t("errorGeneric"), true); }
};

async function relocalize() { await OrganizerI18n.init(); OrganizerI18n.apply(); document.title = t("optionsTitle"); renderCategories(); }
$("#ui-language").onchange = async () => {
  await api.storage.local.set({ organizerSettings: { ...(await stored()), uiLanguage: $("#ui-language").value } });
  await relocalize();
};
OrganizerI18n.apply();
OrganizerI18n.init().then(() => { OrganizerI18n.apply(); document.title = t("optionsTitle"); load(); });
