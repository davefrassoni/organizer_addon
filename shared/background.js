/* global OrganizerCategories */
if (typeof OrganizerTopSites === "undefined" && typeof importScripts === "function") importScripts("top-sites.js");
if (typeof OrganizerCategories === "undefined" && typeof importScripts === "function") importScripts("categories.js");
const api = globalThis.browser || globalThis.chrome;
const STORE = { tabs: "tabSessions", bookmarks: "bookmarkBackups", settings: "organizerSettings", aiJobs: "organizerAiJobs" };
const DEFAULTS = { method: "ai", provider: "dave", apiKeys: {}, model: "", tabFallback: "reorder", closeDuplicateTabs: false, removeDuplicateBookmarks: false, bookmarkScope: "loose" };
const DAVE_AI_ENDPOINT = "https://davefrassoni.com";
const PUBLIC_CLIENT_KEY = "organizer-addon-v1"; // Identifier, not a secret. Server validation provides security.
// Live worker timings show 50 items balances throughput and ~22-33s inference time.
// The byte cap protects the 8k model context when titles or URLs are unusually long.
const AI_BATCH_SIZE = 50;
const AI_BATCH_MAX_BYTES = 18000;
const DAVE_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DAVE_FETCH_TIMEOUT_MS = 20000;
const JOB_ALARM = "organizer-ai-jobs";
const JOB_KINDS = ["bookmarks", "tabs"];
const ACTIVE_JOB_STATES = new Set(["queued", "processing", "applying"]);
const ALLOWED_URL = /^(https?|ftp):\/\//i;
let jobOperation = Promise.resolve();

function t(key, subs) { return (api.i18n && api.i18n.getMessage(key, subs)) || key; }

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
const serializeJobs = operation => {
  const result = jobOperation.then(operation, operation);
  jobOperation = result.catch(() => {});
  return result;
};
const notFoundError = error => /not found|can't find|no tab with id|no window with id|invalid (bookmark|tab) id/i.test(String(error?.message || error || ""));

function id() { return `${Date.now()}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`; }
function cleanTab(tab) { return { url: tab.url, title: tab.title || tab.url, pinned: !!tab.pinned }; }
function validTabs(tabs) { return tabs.filter(tab => ALLOWED_URL.test(tab.url || "")); }

async function saveTabs(closeAfter = false) {
  const tabs = validTabs(await queryTabs({ currentWindow: true }));
  if (!tabs.length) throw new Error(t("bgNoRestorableTabs"));
  const data = await getLocal({ [STORE.tabs]: [] });
  const session = { id: id(), name: `${t("bgTabsSessionPrefix")} — ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), tabs: tabs.map(cleanTab) };
  await setLocal({ [STORE.tabs]: [session, ...data[STORE.tabs]] });
  if (closeAfter) {
    const current = await queryTabs({ currentWindow: true });
    const ids = current.map(tab => tab.id).filter(Number.isInteger);
    if (ids.length) await call(api.tabs, "remove", ids);
  }
  return session;
}

async function bookmarkTree() { return await call(api.bookmarks, "getTree"); }
async function bookmarkRoots() { const tree = await bookmarkTree(); return (tree[0] && tree[0].children) || []; }
async function saveBookmarks() {
  const data = await getLocal({ [STORE.bookmarks]: [] });
  const backup = { id: id(), name: `${t("bgBookmarksBackupPrefix")} — ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), tree: await bookmarkTree() };
  await setLocal({ [STORE.bookmarks]: [backup, ...data[STORE.bookmarks]] });
  return backup;
}

function countBookmarksIn(node) { return node.url ? (ALLOWED_URL.test(node.url) ? 1 : 0) : (node.children || []).reduce((sum, child) => sum + countBookmarksIn(child), 0); }
function representativeUrl(node) {
  if (node.url) return ALLOWED_URL.test(node.url) ? node.url : null;
  for (const child of node.children || []) { const url = representativeUrl(child); if (url) return url; }
  return null;
}
function folderHostnames(node, out = new Set()) {
  if (node.url) { try { out.add(new URL(node.url).hostname.replace(/^www\./, "")); } catch (_) {} }
  else for (const child of node.children || []) folderHostnames(child, out);
  return out;
}
// Only direct children of a root (Bookmarks Bar / Other Bookmarks / Mobile
// Bookmarks) are "loose" — bookmarks already filed into a user-made folder
// are left untouched so organizing never empties folders the user built.
// Folders that directly sit in a root and contain at least one bookmark are
// sent and moved as a single unit (their contents move with them, intact)
// instead of being skipped entirely or broken apart.
function collectLooseBookmarks(roots) {
  const out = [];
  for (const root of roots) {
    for (const node of root.children || []) {
      if (node.url && ALLOWED_URL.test(node.url)) out.push({ id: node.id, title: node.title, url: node.url, rootId: root.id });
      else if (node.children && countBookmarksIn(node) > 0) out.push({ id: node.id, title: node.title || t("bgImportedFolderTitle"), url: representativeUrl(node), rootId: root.id, isFolder: true, metaTags: Array.from(folderHostnames(node)).slice(0, 20) });
    }
  }
  return out;
}
function flattenBookmarkNode(nodes, rootId, out) {
  for (const node of nodes || []) {
    if (node.url && ALLOWED_URL.test(node.url)) out.push({ id: node.id, title: node.title, url: node.url, rootId });
    if (node.children) flattenBookmarkNode(node.children, rootId, out);
  }
  return out;
}
function collectAllBookmarks(roots) {
  const out = [];
  for (const root of roots) flattenBookmarkNode(root.children, root.id, out);
  return out;
}

// Restore merges a snapshot back into the current tree instead of dumping it
// into one synthetic wrapper folder: folders are matched by title against
// what's already there (reused, not duplicated) and bookmarks are skipped if
// an identical URL already exists in that same folder.
function findChildFolder(liveNode, title) { return (liveNode?.children || []).find(child => !child.url && child.title === title); }
function findChildBookmark(liveNode, url) { return (liveNode?.children || []).find(child => child.url === url); }
async function mergeBookmarkNodes(nodes, parentId, liveParent) {
  for (const node of nodes || []) {
    if (node.url && ALLOWED_URL.test(node.url)) {
      if (findChildBookmark(liveParent, node.url)) continue;
      await call(api.bookmarks, "create", { parentId, title: node.title || node.url, url: node.url });
    } else if (node.children) {
      const existing = findChildFolder(liveParent, node.title || "");
      const folder = existing || await call(api.bookmarks, "create", { parentId, title: node.title || t("bgImportedFolderTitle") });
      await mergeBookmarkNodes(node.children, folder.id, existing || { children: [] });
    }
  }
}
async function restoreBookmarkSnapshot(item) {
  const snapshotRoots = (item.tree[0] && item.tree[0].children) || [];
  const liveRoots = await bookmarkRoots();
  if (!liveRoots.length) throw new Error(t("bgNoBookmarkRoots"));
  for (let index = 0; index < snapshotRoots.length; index++) {
    const liveRoot = liveRoots[index] || liveRoots[liveRoots.length - 1];
    await mergeBookmarkNodes(snapshotRoots[index].children, liveRoot.id, liveRoot);
  }
}

async function settings() { return { ...DEFAULTS, ...(await getLocal({ [STORE.settings]: DEFAULTS }))[STORE.settings] }; }
function normalizeAssignments(raw, length) {
  const rows = Array.isArray(raw) ? raw : raw.assignments;
  if (!Array.isArray(rows)) throw new Error(t("bgAiInvalidResponse"));
  const map = new Map();
  for (const row of rows) if (Number.isInteger(row.index) && row.index >= 0 && row.index < length && typeof row.category === "string") map.set(row.index, row.category.trim().replace(/[\\/:*?\"<>|]/g, " ").slice(0, 50) || "Other");
  return Array.from({ length }, (_, index) => ({ index, category: map.get(index) || "Other" }));
}

async function storedAiJobs() { return (await getLocal({ [STORE.aiJobs]: {} }))[STORE.aiJobs] || {}; }
async function saveAiJobs(jobs) { await setLocal({ [STORE.aiJobs]: jobs }); }
function publicAiJob(job) {
  if (!job) return null;
  const { id: jobId, kind, state, count, progress, applyProgress, createdAt, updatedAt, error, categories } = job;
  return { id: jobId, kind, state, count, progress, applyProgress, createdAt, updatedAt, error, categories };
}
async function publicAiJobs() {
  const jobs = await storedAiJobs();
  return Object.fromEntries(Object.entries(jobs).map(([kind, job]) => [kind, publicAiJob(job)]));
}

function createJobAlarm() {
  if (!api.alarms) return;
  try {
    const result = api.alarms.create(JOB_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    if (result?.catch) result.catch(() => {});
  } catch (_) {}
}
async function syncJobAlarm() {
  if (!api.alarms) return;
  const jobs = await storedAiJobs();
  if (Object.values(jobs).some(job => ACTIVE_JOB_STATES.has(job.state))) createJobAlarm();
  else await call(api.alarms, "clear", JOB_ALARM).catch(() => {});
}

async function daveFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DAVE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${DAVE_AI_ENDPOINT}${path}`, { ...options, signal: controller.signal });
  } catch (error) {
    // Intentionally left in English: popup.js's friendlyError() matches this
    // text against an English regex before it is ever shown to the user, and
    // replaces it with a translated message. Never localize this string.
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

async function startDaveJob(kind, items, meta = {}) {
  return serializeJobs(async () => {
    const jobs = await storedAiJobs();
    if (jobs[kind] && ACTIVE_JOB_STATES.has(jobs[kind].state)) throw new Error(t("bgJobAlreadyRunning"));
    const payload = items.map(({ title, url }) => ({ title: title || "", url }));
    const response = await daveFetch("/api/ai/organizer/jobs/", { method: "POST", headers: { "Content-Type": "application/json", "X-Organizer-Client": PUBLIC_CLIENT_KEY }, body: JSON.stringify({ kind, items: payload }) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || t("bgProviderReturned", [String(response.status)]));
    const created = await response.json();
    const now = new Date().toISOString();
    const job = {
      id: created.id,
      kind,
      state: created.status || "queued",
      count: items.length,
      progress: { completed: 0, total: created.chunks || 1 },
      applyProgress: 0,
      refs: items.map(item => ({ id: item.id, rootId: item.rootId, pinned: item.pinned })),
      createdAt: now,
      updatedAt: now,
      expiresAt: created.expires_at || null,
      error: "",
      ...meta,
    };
    jobs[kind] = job;
    await saveAiJobs(jobs);
    createJobAlarm();
    return { pending: true, job: publicAiJob(job) };
  });
}

async function applyBookmarkJob(jobs, job) {
  job.folderIds ||= {};
  job.skipped ||= 0;
  // Category folders are created directly inside the bookmark's own root
  // (the toolbar / Other Bookmarks / Mobile Bookmarks) — no intermediate
  // "Organizer <date>" wrapper folder.
  for (let position = job.applyProgress || 0; position < job.assignments.length; position++) {
    const row = job.assignments[position];
    const ref = job.refs[position];
    const rootId = ref?.rootId;
    const folderKey = `${rootId}:${row.category}`;
    let folderId = job.folderIds[folderKey];
    if (!folderId) {
      const folder = await call(api.bookmarks, "create", { parentId: rootId, title: row.category });
      folderId = folder.id;
      job.folderIds[folderKey] = folderId;
      job.updatedAt = new Date().toISOString();
      await saveAiJobs(jobs);
    }
    try {
      if (ref?.id) await call(api.bookmarks, "move", ref.id, { parentId: folderId });
      else job.skipped += 1;
    } catch (error) {
      if (notFoundError(error)) job.skipped += 1;
      else throw error;
    }
    job.applyProgress = position + 1;
    job.updatedAt = new Date().toISOString();
    await saveAiJobs(jobs);
  }
  job.state = "completed";
  job.categories = Object.keys(job.folderIds).length;
  job.error = job.skipped ? t("bgBookmarksSkipped", [String(job.skipped)]) : "";
  job.updatedAt = new Date().toISOString();
  delete job.assignments;
  delete job.refs;
  delete job.folderIds;
  await saveAiJobs(jobs);
}

function tabReorderOrder(job) {
  const byCategory = new Map();
  job.assignments.forEach((row, index) => { if (!byCategory.has(row.category)) byCategory.set(row.category, []); byCategory.get(row.category).push(index); });
  const grouped = Array.from(byCategory.values()).flat();
  return [...grouped.filter(index => job.refs[index]?.pinned), ...grouped.filter(index => !job.refs[index]?.pinned)];
}

async function applyTabJob(jobs, job) {
  job.skipped ||= 0;
  const checkpoint = async () => { job.updatedAt = new Date().toISOString(); await saveAiJobs(jobs); };
  if (job.useTabGroups) {
    job.groupIds ||= {};
    for (let position = job.applyProgress || 0; position < job.assignments.length; position++) {
      const row = job.assignments[position];
      const ref = job.refs[position];
      try {
        if (job.groupIds[row.category] != null) await call(api.tabs, "group", { tabIds: [ref.id], groupId: job.groupIds[row.category] });
        else {
          const groupId = await call(api.tabs, "group", { tabIds: [ref.id] });
          job.groupIds[row.category] = groupId;
          await call(api.tabGroups, "update", groupId, { title: row.category, collapsed: false });
        }
      } catch (error) { if (notFoundError(error)) job.skipped += 1; else throw error; }
      job.applyProgress = position + 1;
      await checkpoint();
    }
  } else if (job.tabFallback === "windows") {
    job.windowIds ||= {};
    for (let position = job.applyProgress || 0; position < job.assignments.length; position++) {
      const row = job.assignments[position];
      const ref = job.refs[position];
      try {
        if (job.windowIds[row.category] != null) await call(api.tabs, "move", ref.id, { windowId: job.windowIds[row.category], index: -1 });
        else { const win = await call(api.windows, "create", { tabId: ref.id }); job.windowIds[row.category] = win.id; }
      } catch (error) { if (notFoundError(error)) job.skipped += 1; else throw error; }
      job.applyProgress = position + 1;
      await checkpoint();
    }
  } else {
    job.order ||= tabReorderOrder(job);
    for (let position = job.applyProgress || 0; position < job.order.length; position++) {
      const ref = job.refs[job.order[position]];
      try { await call(api.tabs, "move", ref.id, { index: position }); } catch (error) { if (notFoundError(error)) job.skipped += 1; else throw error; }
      job.applyProgress = position + 1;
      await checkpoint();
    }
  }
  job.state = "completed";
  job.categories = new Set(job.assignments.map(row => row.category)).size;
  job.error = job.skipped ? t("bgTabsSkipped", [String(job.skipped)]) : "";
  job.updatedAt = new Date().toISOString();
  delete job.assignments;
  delete job.refs;
  delete job.groupIds;
  delete job.windowIds;
  delete job.order;
  await saveAiJobs(jobs);
}

async function applyJob(jobs, job) { return job.kind === "bookmarks" ? applyBookmarkJob(jobs, job) : applyTabJob(jobs, job); }

async function startLocalApplyJob(kind, items, assignments, meta = {}) {
  return serializeJobs(async () => {
    const jobs = await storedAiJobs();
    if (jobs[kind] && ACTIVE_JOB_STATES.has(jobs[kind].state)) throw new Error(t("bgJobAlreadyRunning"));
    const now = new Date().toISOString();
    const job = {
      id: id(),
      kind,
      state: "applying",
      count: items.length,
      progress: { completed: 1, total: 1 },
      applyProgress: 0,
      refs: items.map(item => ({ id: item.id, rootId: item.rootId, pinned: item.pinned })),
      assignments,
      createdAt: now,
      updatedAt: now,
      error: "",
      ...meta,
    };
    jobs[kind] = job;
    await saveAiJobs(jobs);
    createJobAlarm();
    await applyJob(jobs, job);
    await syncJobAlarm();
    return { pending: job.state !== "completed", job: publicAiJob(job) };
  });
}

async function pollDaveJob(jobs, job) {
  if (job.state === "applying") return applyJob(jobs, job);
  if (Date.now() > new Date(job.createdAt).getTime() + DAVE_JOB_TIMEOUT_MS) {
    await cancelDaveJob(job.id);
    job.state = "failed";
    job.error = t("bgAiTimedOut");
    delete job.refs;
    job.updatedAt = new Date().toISOString();
    await saveAiJobs(jobs);
    return;
  }
  const response = await daveFetch(`/api/ai/organizer/jobs/${job.id}/`, { headers: { "X-Organizer-Client": PUBLIC_CLIENT_KEY } });
  const remote = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(remote.detail || t("bgProviderReturned", [String(response.status)]));
  job.progress = remote.progress || job.progress;
  job.updatedAt = new Date().toISOString();
  if (remote.status === "completed") {
    job.assignments = normalizeAssignments(remote.result, job.refs.length);
    job.state = "applying";
    job.applyProgress = job.applyProgress || 0;
    job.retryCount = 0;
    job.error = "";
    await saveAiJobs(jobs);
    return applyJob(jobs, job);
  }
  if (["failed", "cancelled"].includes(remote.status)) {
    job.state = remote.status;
    job.error = remote.error || t("bgDaveCouldNotOrganize");
    delete job.refs;
  } else {
    job.state = remote.status || "processing";
    job.error = "";
  }
  await saveAiJobs(jobs);
}

function resumeJobs() {
  return serializeJobs(async () => {
    const jobs = await storedAiJobs();
    for (const kind of JOB_KINDS) {
      const job = jobs[kind];
      if (!job || !ACTIVE_JOB_STATES.has(job.state)) continue;
      try {
        if (job.state === "applying") await applyJob(jobs, job);
        else await pollDaveJob(jobs, job);
      } catch (error) {
        job.retryCount = (job.retryCount || 0) + 1;
        job.lastError = String(error?.message || error).slice(0, 500);
        job.updatedAt = new Date().toISOString();
        if (job.state === "applying" && job.retryCount >= 5) {
          job.state = "failed";
          job.error = t("bgApplyFailed", [job.lastError]);
        }
        await saveAiJobs(jobs);
      }
    }
    await syncJobAlarm();
  });
}

async function cancelStoredAiJob(jobId) {
  return serializeJobs(async () => {
    const jobs = await storedAiJobs();
    const job = Object.values(jobs).find(candidate => candidate?.id === jobId);
    if (!job) throw new Error(t("bgJobNotFound"));
    if (!ACTIVE_JOB_STATES.has(job.state)) return publicAiJob(job);
    await cancelDaveJob(job.id);
    job.state = "cancelled";
    job.error = t("bgCancelledByYou");
    job.updatedAt = new Date().toISOString();
    delete job.refs;
    delete job.assignments;
    await saveAiJobs(jobs);
    await syncJobAlarm();
    return publicAiJob(job);
  });
}

async function dismissAiJob(jobId) {
  return serializeJobs(async () => {
    const jobs = await storedAiJobs();
    for (const kind of JOB_KINDS) if (jobs[kind]?.id === jobId && !ACTIVE_JOB_STATES.has(jobs[kind].state)) delete jobs[kind];
    await saveAiJobs(jobs);
    return true;
  });
}

async function vendorAI(items, kind, config) {
  const key = config.apiKeys && config.apiKeys[config.provider];
  if (!key) throw new Error(t("bgAddApiKey", [config.provider]));
  const instruction = `Categorize these ${kind}. Return JSON only as {"assignments":[{"index":0,"category":"Name"}]}. Every input index must occur once. Use concise, safe category names.`;
  let response;
  if (config.provider === "openai") response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: config.model || "gpt-4.1-mini", response_format: { type: "json_object" }, messages: [{ role: "system", content: instruction }, { role: "user", content: JSON.stringify(items) }] }) });
  else if (config.provider === "anthropic") response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify({ model: config.model || "claude-3-5-haiku-latest", max_tokens: 2048, system: instruction, messages: [{ role: "user", content: JSON.stringify(items) }] }) });
  else response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model || "gemini-2.0-flash")}:generateContent?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: `${instruction}\n${JSON.stringify(items)}` }] }], generationConfig: { responseMimeType: "application/json" } }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || t("bgVendorReturned", [String(response.status)]));
  const text = config.provider === "openai" ? body.choices?.[0]?.message?.content : config.provider === "anthropic" ? body.content?.[0]?.text : body.candidates?.[0]?.content?.parts?.[0]?.text;
  return normalizeAssignments(JSON.parse(text), items.length);
}

async function assign(items, kind, selectedSettings = null) {
  const config = selectedSettings || await settings();
  const payload = items.map(({ title, url, metaTags }) => (metaTags ? { title: title || "", url, metaTags } : { title: title || "", url }));
  if (config.method !== "ai") return OrganizerCategories.assignments(payload);
  const assignBatch = batch => vendorAI(batch, kind, config);
  return OrganizerCategories.batchedAssignments(payload, AI_BATCH_SIZE, assignBatch, AI_BATCH_MAX_BYTES);
}

async function organizeBookmarks() {
  await saveBookmarks();
  const config = await settings();
  const roots = await bookmarkRoots();
  let items = config.bookmarkScope === "all" ? collectAllBookmarks(roots) : collectLooseBookmarks(roots);
  if (!items.length) throw new Error(t("bgNoBookmarksToOrganize"));
  if (config.removeDuplicateBookmarks) {
    // Folders are never candidates for duplicate removal — only the
    // individual bookmarks sent alongside them.
    const dedupable = items.filter(item => !item.isFolder);
    const untouched = items.filter(item => item.isFolder);
    const split = OrganizerCategories.splitDuplicateUrls(dedupable);
    for (const item of split.duplicates) await call(api.bookmarks, "remove", item.id);
    items = [...split.unique, ...untouched];
  }
  if (config.method === "ai" && config.provider === "dave") return startDaveJob("bookmarks", items);
  const assignments = await assign(items, "bookmarks", config);
  return startLocalApplyJob("bookmarks", items, assignments);
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
  const items = tabs.map(tab => ({ id: tab.id, title: tab.title || "", url: tab.url, pinned: !!tab.pinned }));
  const meta = { tabFallback: config.tabFallback, useTabGroups: !!(api.tabs.group && api.tabGroups) };
  if (config.method === "ai" && config.provider === "dave") return startDaveJob("tabs", items, meta);
  const assignments = await assign(items, "tabs", config);
  return startLocalApplyJob("tabs", items, assignments, meta);
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.action === "list") {
      void resumeJobs();
      return { ...(await getLocal({ [STORE.tabs]: [], [STORE.bookmarks]: [] })), aiJobs: await publicAiJobs() };
    }
    if (message.action === "saveTabs") return saveTabs(message.closeAfter);
    if (message.action === "saveBookmarks") return saveBookmarks();
    if (message.action === "restoreTabs") { const data = await getLocal({ [STORE.tabs]: [] }); const item = data[STORE.tabs].find(x => x.id === message.id); if (!item) throw new Error(t("bgBackupNotFound")); return call(api.windows, "create", { url: item.tabs.map(x => x.url) }); }
    if (message.action === "restoreBookmarks") { const data = await getLocal({ [STORE.bookmarks]: [] }); const item = data[STORE.bookmarks].find(x => x.id === message.id); if (!item) throw new Error(t("bgBackupNotFound")); await restoreBookmarkSnapshot(item); return true; }
    if (message.action === "delete") { const data = await getLocal({ [message.store]: [] }); await setLocal({ [message.store]: data[message.store].filter(x => x.id !== message.id) }); return true; }
    if (message.action === "import") { if (![STORE.tabs, STORE.bookmarks].includes(message.store) || !Array.isArray(message.items)) throw new Error(t("bgInvalidBackupFile")); const data = await getLocal({ [message.store]: [] }); await setLocal({ [message.store]: [...message.items, ...data[message.store]] }); return true; }
    if (message.action === "organizeTabs") return organizeTabs();
    if (message.action === "organizeBookmarks") return organizeBookmarks();
    if (message.action === "cancelAiJob") return cancelStoredAiJob(message.id);
    if (message.action === "dismissAiJob") return dismissAiJob(message.id);
    if (message.action === "refreshAiJobs") { void resumeJobs(); return publicAiJobs(); }
    throw new Error(t("bgUnknownAction"));
  })().then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});

if (api.alarms) {
  api.alarms.onAlarm.addListener(alarm => { if (alarm.name === JOB_ALARM) void resumeJobs(); });
  if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => { void resumeJobs(); });
  if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(() => { void resumeJobs(); });
  void syncJobAlarm().then(() => resumeJobs());
}
