/* global OrganizerCategories */
if (typeof OrganizerTopSites === "undefined" && typeof importScripts === "function") importScripts("top-sites.js");
if (typeof OrganizerCategories === "undefined" && typeof importScripts === "function") importScripts("categories.js");
const api = globalThis.browser || globalThis.chrome;
const STORE = { tabs: "tabSessions", bookmarks: "bookmarkBackups", settings: "organizerSettings" };
const DEFAULTS = { method: "ai", provider: "dave", apiKeys: {}, model: "", tabFallback: "reorder", closeDuplicateTabs: false, removeDuplicateBookmarks: false };
const DAVE_AI_ENDPOINT = "https://davefrassoni.com";
const PUBLIC_CLIENT_KEY = "organizer-addon-v1"; // Identifier, not a secret. Server validation provides security.
// Live worker timings show 50 items balances throughput and ~22-33s inference time.
// The byte cap protects the 8k model context when titles or URLs are unusually long.
const AI_BATCH_SIZE = 50;
const AI_BATCH_MAX_BYTES = 18000;
const DAVE_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DAVE_FETCH_TIMEOUT_MS = 20000;
const DAVE_POLL_INTERVAL_MS = 2000;
const ALLOWED_URL = /^(https?|ftp):\/\//i;

const call = (object, method, ...args) => new Promise((resolve, reject) => {
  if (globalThis.browser) {
    object[method](...args).then(resolve, reject);
    return;
  }
  let settled = false;
  const callback = result => {
    settled = true;
    const error = api.runtime && api.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve(result);
  };
  try {
    const result = object[method](...args, callback);
    if (result && typeof result.then === "function") result.then(resolve, reject);
  } catch (error) { if (!settled) reject(error); }
});
const getLocal = keys => call(api.storage.local, "get", keys);
const setLocal = values => call(api.storage.local, "set", values);
const queryTabs = query => call(api.tabs, "query", query);

function id() { return `${Date.now()}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`; }
function cleanTab(tab) { return { url: tab.url, title: tab.title || tab.url, pinned: !!tab.pinned }; }
function validTabs(tabs) { return tabs.filter(tab => ALLOWED_URL.test(tab.url || "")); }

async function saveTabs(closeAfter = false) {
  const tabs = validTabs(await queryTabs({ currentWindow: true }));
  if (!tabs.length) throw new Error("There are no restorable tabs in this window.");
  const data = await getLocal({ [STORE.tabs]: [] });
  const session = { id: id(), name: `Tabs — ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), tabs: tabs.map(cleanTab) };
  await setLocal({ [STORE.tabs]: [session, ...data[STORE.tabs]] });
  if (closeAfter) {
    const current = await queryTabs({ currentWindow: true });
    const ids = current.map(tab => tab.id).filter(Number.isInteger);
    if (ids.length) await call(api.tabs, "remove", ids);
  }
  return session;
}

async function bookmarkTree() { return await call(api.bookmarks, "getTree"); }
async function saveBookmarks() {
  const data = await getLocal({ [STORE.bookmarks]: [] });
  const backup = { id: id(), name: `Bookmarks — ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), tree: await bookmarkTree() };
  await setLocal({ [STORE.bookmarks]: [backup, ...data[STORE.bookmarks]] });
  return backup;
}

async function restoreBookmarkChildren(children, parentId) {
  for (const node of children || []) {
    if (node.url && ALLOWED_URL.test(node.url)) await call(api.bookmarks, "create", { parentId, title: node.title || node.url, url: node.url });
    else if (node.children) {
      const folder = await call(api.bookmarks, "create", { parentId, title: node.title || "Imported" });
      await restoreBookmarkChildren(node.children, folder.id);
    }
  }
}

function flattenBookmarks(nodes, out = []) {
  for (const node of nodes || []) { if (node.url && ALLOWED_URL.test(node.url)) out.push(node); if (node.children) flattenBookmarks(node.children, out); }
  return out;
}

async function settings() { return { ...DEFAULTS, ...(await getLocal({ [STORE.settings]: DEFAULTS }))[STORE.settings] }; }
function normalizeAssignments(raw, length) {
  const rows = Array.isArray(raw) ? raw : raw.assignments;
  if (!Array.isArray(rows)) throw new Error("The AI returned an invalid response.");
  const map = new Map();
  for (const row of rows) if (Number.isInteger(row.index) && row.index >= 0 && row.index < length && typeof row.category === "string") map.set(row.index, row.category.trim().replace(/[\\/:*?\"<>|]/g, " ").slice(0, 50) || "Other");
  return Array.from({ length }, (_, index) => ({ index, category: map.get(index) || "Other" }));
}

async function daveFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DAVE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${DAVE_AI_ENDPOINT}${path}`, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The Dave AI network request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function cancelDaveJob(jobId) {
  try {
    await daveFetch(`/api/ai/organizer/jobs/${jobId}/cancel/`, { method: "POST", headers: { "X-Organizer-Client": PUBLIC_CLIENT_KEY } });
  } catch (_) {
    // The server also owns an expiry deadline, so a failed best-effort cancel
    // cannot leave this parent request claimable forever.
  }
}

async function daveAI(items, kind, config) {
  let created;
  let completed = false;
  try {
    const response = await daveFetch("/api/ai/organizer/jobs/", { method: "POST", headers: { "Content-Type": "application/json", "X-Organizer-Client": PUBLIC_CLIENT_KEY }, body: JSON.stringify({ kind, items }) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || `Dave AI returned ${response.status}.`);
    created = await response.json();
    const serverTimeout = Number(created.timeout_seconds) * 1000;
    const deadline = Date.now() + Math.min(DAVE_JOB_TIMEOUT_MS, Number.isFinite(serverTimeout) && serverTimeout > 0 ? serverTimeout : Infinity);
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, DAVE_POLL_INTERVAL_MS));
      const poll = await daveFetch(`/api/ai/organizer/jobs/${created.id}/`, { headers: { "X-Organizer-Client": PUBLIC_CLIENT_KEY } });
      const job = await poll.json().catch(() => ({}));
      if (!poll.ok) throw new Error(job.detail || `Dave AI returned ${poll.status}.`);
      if (job.status === "completed") {
        completed = true;
        return normalizeAssignments(job.result, items.length);
      }
      if (["failed", "cancelled"].includes(job.status)) throw new Error(job.error || "Dave AI could not organize these items.");
    }
    throw new Error("The AI request timed out before every processing batch finished.");
  } finally {
    if (created?.id && !completed) await cancelDaveJob(created.id);
  }
}

async function vendorAI(items, kind, config) {
  const key = config.apiKeys && config.apiKeys[config.provider];
  if (!key) throw new Error(`Add your ${config.provider} API key in Settings.`);
  const instruction = `Categorize these ${kind}. Return JSON only as {"assignments":[{"index":0,"category":"Name"}]}. Every input index must occur once. Use concise, safe category names.`;
  let response;
  if (config.provider === "openai") response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: config.model || "gpt-4.1-mini", response_format: { type: "json_object" }, messages: [{ role: "system", content: instruction }, { role: "user", content: JSON.stringify(items) }] }) });
  else if (config.provider === "anthropic") response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify({ model: config.model || "claude-3-5-haiku-latest", max_tokens: 2048, system: instruction, messages: [{ role: "user", content: JSON.stringify(items) }] }) });
  else response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model || "gemini-2.0-flash")}:generateContent?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: `${instruction}\n${JSON.stringify(items)}` }] }], generationConfig: { responseMimeType: "application/json" } }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `AI provider returned ${response.status}.`);
  const text = config.provider === "openai" ? body.choices?.[0]?.message?.content : config.provider === "anthropic" ? body.content?.[0]?.text : body.candidates?.[0]?.content?.parts?.[0]?.text;
  return normalizeAssignments(JSON.parse(text), items.length);
}

async function assign(items, kind, selectedSettings = null) {
  const config = selectedSettings || await settings();
  if (config.method !== "ai") return OrganizerCategories.assignments(items);
  if (config.provider === "dave") return daveAI(items, kind, config);
  const assignBatch = batch => vendorAI(batch, kind, config);
  return OrganizerCategories.batchedAssignments(items, AI_BATCH_SIZE, assignBatch, AI_BATCH_MAX_BYTES);
}

async function organizeBookmarks() {
  await saveBookmarks();
  const config = await settings();
  let items = flattenBookmarks(await bookmarkTree()).map(node => ({ id: node.id, title: node.title || "", url: node.url }));
  if (!items.length) throw new Error("No bookmarks to organize.");
  if (config.removeDuplicateBookmarks) {
    const split = OrganizerCategories.splitDuplicateUrls(items);
    for (const item of split.duplicates) await call(api.bookmarks, "remove", item.id);
    items = split.unique;
  }
  const assignments = await assign(items, "bookmarks", config);
  const groups = assignments.reduce((all, row) => ((all[row.category] ||= []).push(row), all), {});
  const root = await call(api.bookmarks, "create", { title: `Organizer ${new Date().toLocaleDateString()}` });
  for (const [name, rows] of Object.entries(groups)) {
    const folder = await call(api.bookmarks, "create", { parentId: root.id, title: name });
    for (const row of rows) await call(api.bookmarks, "move", items[row.index].id, { parentId: folder.id });
  }
  return { count: items.length, categories: Object.keys(groups).length };
}

async function organizeTabs() {
  await saveTabs(false);
  const config = await settings();
  let tabs = validTabs(await queryTabs({ currentWindow: true }));
  if (config.closeDuplicateTabs) {
    const split = OrganizerCategories.splitDuplicateUrls(tabs);
    const duplicateIds = split.duplicates.map(tab => tab.id).filter(Number.isInteger);
    if (duplicateIds.length) await call(api.tabs, "remove", duplicateIds);
    tabs = split.unique;
  }
  const items = tabs.map(tab => ({ title: tab.title || "", url: tab.url }));
  const rows = await assign(items, "tabs", config);
  const groups = rows.reduce((all, row) => ((all[row.category] ||= []).push(tabs[row.index]), all), {});
  if (api.tabs.group && api.tabGroups) {
    for (const [name, grouped] of Object.entries(groups)) { const groupId = await call(api.tabs, "group", { tabIds: grouped.map(tab => tab.id) }); await call(api.tabGroups, "update", groupId, { title: name, collapsed: false }); }
  } else if (config.tabFallback === "windows") {
    for (const grouped of Object.values(groups)) {
      const win = await call(api.windows, "create", { tabId: grouped[0].id });
      for (const tab of grouped.slice(1)) await call(api.tabs, "move", tab.id, { windowId: win.id, index: -1 });
    }
  } else {
    const ordered = Object.values(groups).flat();
    const sameWindowOrder = [...ordered.filter(tab => tab.pinned), ...ordered.filter(tab => !tab.pinned)];
    for (let index = 0; index < sameWindowOrder.length; index++) await call(api.tabs, "move", sameWindowOrder[index].id, { index });
  }
  return { count: tabs.length, categories: Object.keys(groups).length };
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.action === "list") return await getLocal({ [STORE.tabs]: [], [STORE.bookmarks]: [] });
    if (message.action === "saveTabs") return saveTabs(message.closeAfter);
    if (message.action === "saveBookmarks") return saveBookmarks();
    if (message.action === "restoreTabs") { const data = await getLocal({ [STORE.tabs]: [] }); const item = data[STORE.tabs].find(x => x.id === message.id); if (!item) throw new Error("Backup not found."); return call(api.windows, "create", { url: item.tabs.map(x => x.url) }); }
    if (message.action === "restoreBookmarks") { const data = await getLocal({ [STORE.bookmarks]: [] }); const item = data[STORE.bookmarks].find(x => x.id === message.id); if (!item) throw new Error("Backup not found."); const root = await call(api.bookmarks, "create", { title: `${item.name} restored` }); await restoreBookmarkChildren(item.tree, root.id); return true; }
    if (message.action === "delete") { const data = await getLocal({ [message.store]: [] }); await setLocal({ [message.store]: data[message.store].filter(x => x.id !== message.id) }); return true; }
    if (message.action === "import") { if (![STORE.tabs, STORE.bookmarks].includes(message.store) || !Array.isArray(message.items)) throw new Error("Invalid backup file."); const data = await getLocal({ [message.store]: [] }); await setLocal({ [message.store]: [...message.items, ...data[message.store]] }); return true; }
    if (message.action === "organizeTabs") return organizeTabs();
    if (message.action === "organizeBookmarks") return organizeBookmarks();
    throw new Error("Unknown action.");
  })().then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
