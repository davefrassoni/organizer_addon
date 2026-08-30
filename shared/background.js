/* global OrganizerCategories */
if (typeof OrganizerTopSites === "undefined" && typeof importScripts === "function") importScripts("top-sites.js");
if (typeof OrganizerCategories === "undefined" && typeof importScripts === "function") importScripts("categories.js");
const api = globalThis.browser || globalThis.chrome;
const STORE = { tabs: "tabSessions", bookmarks: "bookmarkBackups", settings: "organizerSettings", aiJobs: "organizerAiJobs" };
const DEFAULTS = { method: "ai", provider: "dave", apiKeys: {}, model: "", tabFallback: "reorder", closeDuplicateTabs: false, removeDuplicateBookmarks: false, bookmarkScope: "loose", excludeFoldersFromOrganizing: false, organizeInsideExcludedFolders: false, openActivityOnStart: true, uiLanguage: "auto", keepBackupFolder: true };
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
// The activity page shows an input->category row per item; cap what each job
// stores so a huge bookmark library can't bloat extension storage.
const ACTIVITY_ITEM_CAP = 2000;
const ACTIVITY_PAGE = "activity/activity.html";
// Before organizing, a copy of the whole pre-organize tree is dropped into a
// folder with this name in the first root, so the old layout stays visible in
// the bookmark manager. Always skipped by the organizer itself.
const BACKUP_FOLDER_NAME = "backup";
const ALLOWED_URL = /^(https?|ftp):\/\//i;
let jobOperation = Promise.resolve();
let lastDetailResume = 0;

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
function jobRef(item) { return { id: item.id, rootId: item.rootId, pinned: item.pinned, parentId: item.parentId, isFolder: !!item.isFolder, title: item.title }; }
// A trimmed, capped copy of the organize input kept on the job so the activity
// page can show every item next to the category it was given.
function jobDetail(items) {
  const kept = items.slice(0, ACTIVITY_ITEM_CAP);
  return {
    total: items.length,
    truncated: items.length > kept.length,
    items: kept.map(item => ({ title: item.title || "", url: item.url || "", pinned: !!item.pinned, isFolder: !!item.isFolder, tabId: Number.isInteger(item.id) ? item.id : undefined })),
  };
}
// The per-category digest the activity page renders: how many items landed in
// each category and the sites they have in common.
function buildExplain(job) {
  if (!job.detail || !Array.isArray(job.assignments)) return null;
  return { categories: OrganizerCategories.summarizeCategories(job.detail.items, job.assignments) };
}
function canUndoJob(job) {
  if (!job || job.state !== "completed" || job.undone) return false;
  if (job.kind === "bookmarks") return !!job.backupId;
  return job.kind === "tabs" && (job.useTabGroups || job.tabFallback === "reorder");
}
function fullAiJob(job) {
  if (!job) return null;
  return { ...publicAiJob(job), method: job.method || null, provider: job.provider || null, backupId: job.backupId || null, undone: job.undone || null, canUndo: canUndoJob(job), detail: job.detail || null, assignments: job.assignments || null, explain: job.explain || null, sections: job.sections || null, sectionCompletedAt: job.sectionCompletedAt || null, processingStartedAt: job.processingStartedAt || null, partialAssignments: job.partialAssignments || null };
}
async function maybeOpenActivity(kind) {
  if (!api.tabs || !api.tabs.create) return;
  try {
    if ((await settings()).openActivityOnStart === false) return;
    const base = api.runtime.getURL(ACTIVITY_PAGE);
    const url = `${base}?kind=${kind}`;
    let open = [];
    try { open = await call(api.tabs, "query", { url: `${base}*` }); } catch (_) {}
    if (open.length) {
      await call(api.tabs, "update", open[0].id, { active: true, url });
      if (api.windows && api.windows.update) await call(api.windows, "update", open[0].windowId, { focused: true }).catch(() => {});
    } else {
      await call(api.tabs, "create", { url });
    }
  } catch (_) {}
}
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
// "Loose" = direct children of a root only; bookmarks already inside a
// user-made folder are left alone. Root-level folders move as a single
// unit with their contents intact, never skipped or split apart.
// excludeFolders: folders stay put, never moved as units. Add
// organizeInsideExcluded to still sort an excluded folder's own direct
// bookmarks in place, without moving the folder or its nested contents.
function isBackupFolder(node) { return node && !node.url && node.title === BACKUP_FOLDER_NAME; }
function collectLooseBookmarks(roots, { excludeFolders = false, organizeInsideExcluded = false } = {}) {
  const out = [];
  for (const root of roots) {
    for (const node of root.children || []) {
      if (isBackupFolder(node)) continue;
      if (node.url && ALLOWED_URL.test(node.url)) { out.push({ id: node.id, title: node.title, url: node.url, rootId: root.id, parentId: root.id }); continue; }
      if (!node.children) continue;
      if (excludeFolders) {
        if (organizeInsideExcluded) for (const child of node.children) if (child.url && ALLOWED_URL.test(child.url)) out.push({ id: child.id, title: child.title, url: child.url, rootId: node.id, parentId: node.id });
      } else if (countBookmarksIn(node) > 0) {
        out.push({ id: node.id, title: node.title || t("bgImportedFolderTitle"), url: representativeUrl(node), rootId: root.id, parentId: root.id, isFolder: true, metaTags: Array.from(folderHostnames(node)).slice(0, 20) });
      }
    }
  }
  return out;
}
function flattenBookmarkNode(nodes, rootId, out, parentId) {
  for (const node of nodes || []) {
    if (node.url && ALLOWED_URL.test(node.url)) out.push({ id: node.id, title: node.title, url: node.url, rootId, parentId });
    if (node.children) flattenBookmarkNode(node.children, rootId, out, node.id);
  }
  return out;
}
function collectAllBookmarks(roots) {
  const out = [];
  for (const root of roots) flattenBookmarkNode((root.children || []).filter(node => !isBackupFolder(node)), root.id, out, root.id);
  return out;
}

// Restore reproduces a snapshot exactly: every root the snapshot covers has
// its current contents cleared and the saved subtree rebuilt in order, so
// organize-time category folders, folders left empty, and duplicate bookmarks
// are all gone afterwards. restoreBookmarkSnapshot saves a fresh backup of the
// pre-restore tree first, so the operation stays undoable.
function matchLiveRoot(snapshotRoot, liveRoots, index) {
  return liveRoots.find(root => root.id === snapshotRoot.id)
    || (snapshotRoot.title && liveRoots.find(root => root.title === snapshotRoot.title))
    || liveRoots[index]
    || liveRoots[liveRoots.length - 1];
}
async function clearBookmarkChildren(children) {
  for (const child of children || []) {
    try { await call(api.bookmarks, child.url ? "remove" : "removeTree", child.id); } catch (_) {}
  }
}
async function recreateBookmarkNodes(nodes, parentId) {
  for (const node of nodes || []) {
    if (node.url) {
      if (!ALLOWED_URL.test(node.url)) continue;
      try { await call(api.bookmarks, "create", { parentId, title: node.title || node.url, url: node.url }); } catch (_) {}
    } else {
      let folder;
      try { folder = await call(api.bookmarks, "create", { parentId, title: node.title || t("bgImportedFolderTitle") }); } catch (_) { continue; }
      await recreateBookmarkNodes(node.children, folder.id);
    }
  }
}
async function restoreBookmarkSnapshot(item) {
  const snapshotRoots = (item.tree[0] && item.tree[0].children) || [];
  const liveRoots = await bookmarkRoots();
  if (!liveRoots.length) throw new Error(t("bgNoBookmarkRoots"));
  await saveBookmarks();
  for (let index = 0; index < snapshotRoots.length; index++) {
    const liveRoot = matchLiveRoot(snapshotRoots[index], liveRoots, index);
    await clearBookmarkChildren(liveRoot.children);
    await recreateBookmarkNodes(snapshotRoots[index].children, liveRoot.id);
  }
}

// The root the backup folder goes in: the toolbar/bookmarks bar if we can
// find it (it's the one people actually see -- Firefox's first root is the
// often-hidden Bookmarks Menu), otherwise the first root that has bookmarks,
// otherwise the first root.
function backupHostRoot(roots) {
  return roots.find(root => root.id === "1" || root.id === "toolbar_____" || /toolbar|bookmarks bar|barra|lesezeichen-symbolleiste/i.test(root.title || ""))
    || roots.find(root => (root.children || []).some(node => !isBackupFolder(node)))
    || roots[0];
}
// Copies the pre-organize tree into "<toolbar>/backup/<timestamp>/" so the old
// arrangement stays browsable in the bookmark manager. `roots` must be the
// tree read before this runs, so the new backup folder isn't copied into
// itself. Any earlier backup folder is left out of the copy.
async function stashVisibleBackup(roots) {
  const host = backupHostRoot(roots);
  if (!host) return;
  const existing = (host.children || []).find(isBackupFolder);
  // index 0 keeps it at the top of the toolbar so it's easy to find.
  const backupFolder = existing || await call(api.bookmarks, "create", { parentId: host.id, title: BACKUP_FOLDER_NAME, index: 0 });
  const stamp = await call(api.bookmarks, "create", { parentId: backupFolder.id, title: new Date().toLocaleString() });
  const multiRoot = roots.filter(root => (root.children || []).some(node => !isBackupFolder(node))).length > 1;
  for (const root of roots) {
    const kids = (root.children || []).filter(node => !isBackupFolder(node));
    if (!kids.length) continue;
    const parentId = multiRoot
      ? (await call(api.bookmarks, "create", { parentId: stamp.id, title: root.title || BACKUP_FOLDER_NAME })).id
      : stamp.id;
    await recreateBookmarkNodes(kids, parentId);
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
  const { id: jobId, kind, state, count, progress, applyProgress, createdAt, updatedAt, error, categories, method, provider } = job;
  return { id: jobId, kind, state, count, progress, applyProgress, createdAt, updatedAt, error, categories, method, provider, hasDetail: !!job.detail, canUndo: canUndoJob(job) };
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
    // Left in English on purpose -- popup.js regex-matches this text to show
    // a translated message instead. Do not localize.
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
    const sections = OrganizerCategories.chunkRanges(payload, AI_BATCH_SIZE, AI_BATCH_MAX_BYTES);
    const job = {
      id: created.id,
      kind,
      state: created.status || "queued",
      count: items.length,
      progress: { completed: 0, total: created.chunks || sections.length || 1 },
      sections,
      applyProgress: 0,
      refs: items.map(jobRef),
      detail: jobDetail(items),
      createdAt: now,
      updatedAt: now,
      expiresAt: created.expires_at || null,
      error: "",
      ...meta,
    };
    jobs[kind] = job;
    await saveAiJobs(jobs);
    createJobAlarm();
    await maybeOpenActivity(kind);
    return { pending: true, job: publicAiJob(job) };
  });
}

// Remove a folder the organize moves emptied, then its parent if that in turn
// became empty, and so on upward. Roots (protectedIds) are never removed, and
// bookmarks.remove refuses a non-empty folder, so this only ever deletes
// folders left with nothing in them.
async function pruneEmptyFolders(folderId, protectedIds) {
  let currentId = folderId;
  while (currentId && !protectedIds.has(currentId)) {
    let node;
    try { [node] = await call(api.bookmarks, "getSubTree", currentId); } catch (_) { return; }
    if (!node || node.url || !node.children || node.children.length) return;
    try { await call(api.bookmarks, "remove", currentId); } catch (_) { return; }
    currentId = node.parentId;
  }
}

async function applyBookmarkJob(jobs, job) {
  job.folderIds ||= {};
  job.skipped ||= 0;
  // A folder sent as a unit whose assigned category is its own name already is
  // the category folder: adopt it so sibling bookmarks merge into it, instead
  // of creating a fresh folder and nesting the old one inside it on re-runs.
  if (!job.foldersSeeded) {
    job.assignments.forEach((row, position) => {
      const ref = job.refs[position];
      if (ref?.isFolder && ref.title && ref.title === row.category && ref.rootId) job.folderIds[`${ref.rootId}:${row.category}`] ||= ref.id;
    });
    job.foldersSeeded = true;
    await saveAiJobs(jobs);
  }
  // Category folders go directly in the bookmark's own root -- no
  // intermediate "Organizer <date>" wrapper folder.
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
      if (!ref?.id) job.skipped += 1;
      else if (ref.id !== folderId) await call(api.bookmarks, "move", ref.id, { parentId: folderId });
    } catch (error) {
      if (notFoundError(error)) job.skipped += 1;
      else throw error;
    }
    job.applyProgress = position + 1;
    job.updatedAt = new Date().toISOString();
    await saveAiJobs(jobs);
  }
  // Moving bookmarks out of user folders (scope "all", or organizing inside an
  // excluded folder) can leave those folders empty -- clean them up.
  if (!job.pruneCandidates) {
    job.pruneCandidates = Array.from(new Set((job.refs || []).map(ref => ref?.parentId).filter(Boolean)));
    job.pruneProtected = Array.from(new Set((job.refs || []).map(ref => ref?.rootId).filter(Boolean)));
    await saveAiJobs(jobs);
  }
  const protectedIds = new Set(job.pruneProtected);
  for (let position = job.pruneProgress || 0; position < job.pruneCandidates.length; position++) {
    await pruneEmptyFolders(job.pruneCandidates[position], protectedIds);
    job.pruneProgress = position + 1;
    job.updatedAt = new Date().toISOString();
    await saveAiJobs(jobs);
  }
  job.state = "completed";
  job.categories = Object.keys(job.folderIds).length;
  job.error = job.skipped ? t("bgBookmarksSkipped", [String(job.skipped)]) : "";
  job.explain = buildExplain(job);
  job.updatedAt = new Date().toISOString();
  delete job.refs;
  delete job.folderIds;
  delete job.pruneCandidates;
  delete job.pruneProtected;
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
  job.explain = buildExplain(job);
  job.updatedAt = new Date().toISOString();
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
      sections: [[0, items.length]],
      applyProgress: 0,
      refs: items.map(jobRef),
      detail: jobDetail(items),
      assignments,
      createdAt: now,
      updatedAt: now,
      error: "",
      ...meta,
    };
    jobs[kind] = job;
    await saveAiJobs(jobs);
    createJobAlarm();
    await maybeOpenActivity(kind);
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
  const stamp = new Date().toISOString();
  job.updatedAt = stamp;
  // Timestamp each section as it completes so the activity page can show how
  // long it took. Poll-time accuracy (~2s while the page is open) is enough.
  const completedSections = Math.min((job.progress && job.progress.completed) || 0, (job.progress && job.progress.total) || 0);
  job.sectionCompletedAt ||= [];
  if (!job.processingStartedAt && (remote.status === "processing" || completedSections > 0)) job.processingStartedAt = stamp;
  while (job.sectionCompletedAt.length < completedSections) job.sectionCompletedAt.push(stamp);
  // Some deployments stream partial category assignments while processing;
  // surface them per section without feeding incomplete data into apply.
  const partialRows = remote.result && (Array.isArray(remote.result) ? remote.result : remote.result.assignments);
  if (Array.isArray(partialRows)) job.partialAssignments = partialRows.filter(row => Number.isInteger(row?.index) && typeof row?.category === "string").map(row => ({ index: row.index, category: row.category }));
  if (remote.status === "completed") {
    job.assignments = normalizeAssignments(remote.result, job.refs.length);
    job.state = "applying";
    job.applyProgress = job.applyProgress || 0;
    job.retryCount = 0;
    job.error = "";
    delete job.partialAssignments;
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

async function retryAiJob(jobId) {
  const jobs = await storedAiJobs();
  const job = Object.values(jobs).find(candidate => candidate?.id === jobId);
  if (!job) throw new Error(t("bgJobNotFound"));
  if (ACTIVE_JOB_STATES.has(job.state)) throw new Error(t("bgJobAlreadyRunning"));
  return job.kind === "bookmarks" ? organizeBookmarks() : organizeTabs();
}

// Undo puts back what an organize run changed. Bookmarks: the exact restore of
// the backup taken right before organizing. Tabs: ungroup and return every tab
// to its original position (the reorder itself closed nothing).
async function undoTabOrganization(job) {
  const order = job.detail?.items || [];
  const tabIds = order.map(item => item.tabId).filter(Number.isInteger);
  if (api.tabs.ungroup && tabIds.length) await call(api.tabs, "ungroup", tabIds).catch(() => {});
  for (let index = 0; index < order.length; index++) {
    const tabId = order[index].tabId;
    if (!Number.isInteger(tabId)) continue;
    try { await call(api.tabs, "move", tabId, { index }); }
    catch (error) { if (!notFoundError(error)) throw error; }
  }
}

async function undoAiJob(jobId) {
  return serializeJobs(async () => {
    const jobs = await storedAiJobs();
    const job = Object.values(jobs).find(candidate => candidate?.id === jobId);
    if (!job) throw new Error(t("bgJobNotFound"));
    if (!canUndoJob(job)) throw new Error(t("bgUndoUnavailable"));
    if (job.kind === "bookmarks") {
      const backup = (await getLocal({ [STORE.bookmarks]: [] }))[STORE.bookmarks].find(entry => entry.id === job.backupId);
      if (!backup) throw new Error(t("bgBackupNotFound"));
      await restoreBookmarkSnapshot(backup);
    } else {
      await undoTabOrganization(job);
    }
    job.undone = job.kind;
    job.updatedAt = new Date().toISOString();
    await saveAiJobs(jobs);
    return fullAiJob(job);
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
  const backup = await saveBookmarks();
  const config = await settings();
  const meta = { method: config.method, provider: config.method === "ai" ? config.provider : "builtin", backupId: backup.id };
  const roots = await bookmarkRoots();
  let items = config.bookmarkScope === "all" ? collectAllBookmarks(roots) : collectLooseBookmarks(roots, { excludeFolders: !!config.excludeFoldersFromOrganizing, organizeInsideExcluded: !!config.organizeInsideExcludedFolders });
  if (!items.length) throw new Error(t("bgNoBookmarksToOrganize"));
  if (config.keepBackupFolder !== false) await stashVisibleBackup(roots);
  if (config.removeDuplicateBookmarks) {
    // Folders are never duplicate candidates -- only bookmarks sent
    // alongside them.
    const dedupable = items.filter(item => !item.isFolder);
    const untouched = items.filter(item => item.isFolder);
    const split = OrganizerCategories.splitDuplicateUrls(dedupable);
    for (const item of split.duplicates) await call(api.bookmarks, "remove", item.id);
    items = [...split.unique, ...untouched];
  }
  if (config.method === "ai" && config.provider === "dave") return startDaveJob("bookmarks", items, meta);
  const assignments = await assign(items, "bookmarks", config);
  return startLocalApplyJob("bookmarks", items, assignments, meta);
}

async function organizeTabs() {
  const backup = await saveTabs(false);
  const config = await settings();
  let tabs = validTabs(await queryTabs({ currentWindow: true }));
  if (config.closeDuplicateTabs) {
    const split = OrganizerCategories.splitDuplicateUrls(tabs);
    const duplicateIds = split.duplicates.map(tab => tab.id).filter(Number.isInteger);
    if (duplicateIds.length) await call(api.tabs, "remove", duplicateIds);
    tabs = split.unique;
  }
  const items = tabs.map(tab => ({ id: tab.id, title: tab.title || "", url: tab.url, pinned: !!tab.pinned }));
  const meta = { tabFallback: config.tabFallback, useTabGroups: !!(api.tabs.group && api.tabGroups), method: config.method, provider: config.method === "ai" ? config.provider : "builtin", backupId: backup.id };
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
    if (message.action === "aiJobDetail") {
      // The activity page polls this ~every 2s; don't fire a Dave GET that often.
      if (Date.now() - lastDetailResume > 4000) { lastDetailResume = Date.now(); void resumeJobs(); }
      const jobs = await storedAiJobs();
      const mostRecent = Object.values(jobs).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
      const job = (message.id && Object.values(jobs).find(candidate => candidate?.id === message.id)) || (JOB_KINDS.includes(message.kind) && jobs[message.kind]) || mostRecent || null;
      return fullAiJob(job);
    }
    if (message.action === "retryAiJob") return retryAiJob(message.id);
    if (message.action === "undoAiJob") return undoAiJob(message.id);
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
