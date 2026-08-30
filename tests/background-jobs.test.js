const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync("shared/background.js", "utf8");
const enMessages = JSON.parse(fs.readFileSync("shared/_locales/en/messages.json", "utf8"));
const RealCategories = require("../shared/categories.js");

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function defaultTree(bookmarks) {
  return [{ id: "0", title: "", children: [{ id: "1", title: "Other Bookmarks", children: bookmarks }] }];
}

function backgroundHarness(shared, remoteState) {
  shared.tree ||= defaultTree(shared.bookmarks || []);
  shared.tabsList ||= [];
  shared.created ||= [];
  shared.moves ||= [];
  shared.tabMoves ||= [];
  shared.groups ||= {};
  shared.groupTitles ||= {};
  shared.windowsCreated ||= [];
  shared.folderSequence ||= 0;
  shared.groupSequence ||= 0;
  shared.windowSequence ||= 0;
  shared.alarms ||= {};
  let messageListener, alarmListener;
  // A live index of every bookmark node so create/move/remove actually mutate
  // the tree -- prune and exact-restore assertions need real emptiness.
  const nodeById = new Map();
  const indexNode = (node, parentId) => { node.parentId = parentId; nodeById.set(node.id, node); for (const child of node.children || []) indexNode(child, node.id); };
  for (const root of shared.tree) indexNode(root, undefined);
  const detach = id => { const node = nodeById.get(id); const parent = node && nodeById.get(node.parentId); if (parent) parent.children = (parent.children || []).filter(child => child.id !== id); return node; };
  const drop = id => { const node = detach(id); if (!node) return; nodeById.delete(id); for (const child of node.children || []) drop(child.id); };
  const api = {
    bookmarks: {
      async getTree() { return shared.tree; },
      async getSubTree(id) { const node = nodeById.get(id); if (!node) throw new Error("Can't find bookmark for id."); return [node]; },
      async create(details) {
        const node = { id: `node-${++shared.folderSequence}`, parentId: details.parentId, title: details.title, ...(details.url ? { url: details.url } : { children: [] }) };
        nodeById.set(node.id, node);
        const parent = nodeById.get(details.parentId);
        if (parent) (parent.children ||= []).push(node);
        shared.created.push(node);
        return node;
      },
      async move(id, details) {
        shared.moves.push({ id, ...details });
        const node = detach(id);
        if (node) { node.parentId = details.parentId; const parent = nodeById.get(details.parentId); if (parent) (parent.children ||= []).push(node); }
        return { id, ...details };
      },
      async remove(id) { (shared.removed ||= []).push(id); const node = nodeById.get(id); if (node?.children?.length) throw new Error("Can't remove non-empty folder."); drop(id); },
      async removeTree(id) { (shared.removed ||= []).push(id); drop(id); },
    },
    tabs: {
      async query(details = {}) { return details.url ? (shared.activityTabs || []) : shared.tabsList; },
      async group(details) {
        if (details.groupId != null) { shared.groups[details.groupId].push(...details.tabIds); return details.groupId; }
        const groupId = `group-${++shared.groupSequence}`;
        shared.groups[groupId] = [...details.tabIds];
        return groupId;
      },
      async move(id, details) { shared.tabMoves.push({ id, ...details }); return { id, ...details }; },
      async ungroup(ids) { (shared.ungrouped ||= []).push(...ids); },
      async create(details) { (shared.tabsCreated ||= []).push(details); return { id: 9000 + shared.tabsCreated.length, ...details }; },
      async update(id, details) { (shared.tabUpdates ||= []).push({ id, ...details }); return { id, ...details }; },
      async remove() {},
    },
    tabGroups: { async update(groupId, details) { shared.groupTitles[groupId] = details.title; } },
    windows: { async create(details) { const win = { id: `win-${++shared.windowSequence}`, ...details }; shared.windowsCreated.push(win); return win; }, async update() {} },
    storage: { local: {
      async get(defaults) { return { ...defaults, ...shared.storage }; },
      async set(values) { Object.assign(shared.storage, structuredClone(values)); },
    } },
    alarms: {
      async create(name, details) { shared.alarms[name] = details; },
      async clear(name) { delete shared.alarms[name]; return true; },
      onAlarm: { addListener(listener) { alarmListener = listener; } },
    },
    i18n: { getMessage(key, subs) { const entry = enMessages[key]; if (!entry) return key; const list = subs == null ? [] : Array.isArray(subs) ? subs : [subs]; return entry.message.replace(/\$(\d+)/g, (_, n) => list[Number(n) - 1] ?? ""); } },
    runtime: {
      lastError: null,
      getURL(path) { return `chrome-extension://test/${path}`; },
      onMessage: { addListener(listener) { messageListener = listener; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
  };
  const context = {
    browser: api,
    OrganizerCategories: {
      ...RealCategories,
      assignments(items) { return items.map((item, index) => ({ index, category: shared.assignCategory ? shared.assignCategory(item, index) : "Other" })); },
      splitDuplicateUrls(items) { return { unique: items, duplicates: [] }; },
      async batchedAssignments(items, _size, assignBatch) { return assignBatch(items); },
    },
    fetch: async (url, options = {}) => {
      if (options.method === "POST" && /\/organizer\/jobs\/$/.test(url)) return response({ id: "parent-job", status: "queued", chunks: 6, timeout_seconds: 900, expires_at: "2099-01-01T00:00:00Z" }, 201);
      if (/\/organizer\/jobs\/parent-job\/$/.test(url)) {
        if (remoteState.status !== "completed") return response({ id: "parent-job", status: remoteState.status, progress: remoteState.progress, result: null, error: "" });
        return response({ id: "parent-job", status: "completed", progress: { completed: 6, total: 6 }, result: { assignments: remoteState.assignments }, error: "" });
      }
      if (/\/cancel\/$/.test(url)) return response({ status: "cancelled" });
      throw new Error(`Unexpected fetch: ${url}`);
    },
    AbortController,
    TextEncoder,
    URL,
    crypto: { randomUUID: () => "backup-id" },
    setTimeout,
    clearTimeout,
    console,
    structuredClone,
  };
  vm.runInNewContext(backgroundSource, context, { filename: "background.js" });
  return {
    async message(action, extra = {}) {
      return new Promise(resolve => messageListener({ action, ...extra }, null, resolve));
    },
    alarm() { alarmListener({ name: "organizer-ai-jobs" }); },
  };
}

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for background work.");
}

test("a 300-bookmark Dave job resumes after a background restart and applies every move", async () => {
  const bookmarks = Array.from({ length: 300 }, (_, index) => ({ id: `bookmark-${index}`, title: `Bookmark ${index}`, url: `https://example.com/${index}` }));
  const shared = {
    storage: { organizerSettings: { method: "ai", provider: "dave", removeDuplicateBookmarks: false, keepBackupFolder: false } },
    bookmarks,
  };
  const remote = { status: "queued", progress: { completed: 0, total: 6 }, assignments: bookmarks.map((_, index) => ({ index, category: `Group ${index % 3}` })) };
  const firstWorker = backgroundHarness(shared, remote);
  const submitted = await firstWorker.message("organizeBookmarks");
  assert.equal(submitted.ok, true);
  assert.equal(submitted.result.pending, true);
  assert.equal(submitted.result.job.count, 300);
  assert.equal(shared.storage.organizerAiJobs.bookmarks.state, "queued");
  assert.ok(shared.alarms["organizer-ai-jobs"]);
  assert.equal(shared.moves.length, 0);

  // Simulate the browser terminating the first service worker. A fresh worker
  // receives the persisted job, observes server completion, and resumes it.
  remote.status = "completed";
  const restartedWorker = backgroundHarness(shared, remote);
  restartedWorker.alarm();
  await waitFor(() => shared.storage.organizerAiJobs.bookmarks.state === "completed");

  const job = shared.storage.organizerAiJobs.bookmarks;
  assert.equal(shared.moves.length, 300);
  assert.equal(job.applyProgress, 300);
  assert.equal(job.categories, 3);
  assert.equal(job.refs, undefined);
  assert.equal(shared.alarms["organizer-ai-jobs"], undefined);
  // Every category folder is created directly inside the bookmark's own root
  // (id "1") — no intermediate wrapper folder, never left to the browser default.
  assert.equal(shared.created.length, 3);
  assert.ok(shared.created.every(node => node.parentId === "1"));
});

test("a Dave tab-organize job resumes after a background restart and groups every tab", async () => {
  const tabs = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, title: `Tab ${index}`, url: `https://example.com/${index}`, pinned: false }));
  const shared = { storage: { organizerSettings: { method: "ai", provider: "dave" } }, tabsList: tabs };
  const remote = { status: "queued", progress: { completed: 0, total: 1 }, assignments: tabs.map((_, index) => ({ index, category: `Group ${index % 4}` })) };
  const firstWorker = backgroundHarness(shared, remote);
  const submitted = await firstWorker.message("organizeTabs");
  assert.equal(submitted.ok, true);
  assert.equal(submitted.result.pending, true);
  assert.equal(submitted.result.job.kind, "tabs");
  assert.equal(shared.tabMoves.length, 0);
  assert.equal(Object.keys(shared.groups).length, 0);

  remote.status = "completed";
  const restartedWorker = backgroundHarness(shared, remote);
  restartedWorker.alarm();
  await waitFor(() => shared.storage.organizerAiJobs.tabs?.state === "completed");

  const job = shared.storage.organizerAiJobs.tabs;
  assert.equal(job.applyProgress, 40);
  assert.equal(job.categories, 4);
  assert.equal(job.refs, undefined);
  assert.equal(Object.keys(shared.groups).length, 4);
  assert.equal(Object.values(shared.groups).flat().length, 40);
});

test("a built-in (non-Dave) bookmark job is resumable if interrupted mid-apply", async () => {
  const bookmarks = Array.from({ length: 120 }, (_, index) => ({ id: `bookmark-${index}`, title: `Bookmark ${index}`, url: `https://example.com/${index}` }));
  const shared = { storage: { organizerSettings: { method: "builtin" } }, bookmarks };
  const worker = backgroundHarness(shared, {});
  const result = await worker.message("organizeBookmarks");
  assert.equal(result.ok, true);
  // The built-in method applies synchronously within the same call for a
  // library this size, but it still goes through the checkpointed job path.
  assert.equal(shared.storage.organizerAiJobs.bookmarks.state, "completed");
  assert.equal(shared.moves.length, 120);
});

test("reorganizing bookmarks with the default loose scope moves loose bookmarks and top-level folders as whole units", async () => {
  const looseBookmarks = [
    { id: "loose-1", title: "Loose 1", url: "https://example.com/loose1" },
    { id: "loose-2", title: "Loose 2", url: "https://example.com/loose2" },
  ];
  const nested = [{ id: "buried-1", title: "Buried", url: "https://example.com/buried" }];
  const folderContents = [
    { id: "kept-1", title: "Kept", url: "https://example.com/kept" },
    { id: "nested-folder", title: "Nested", children: nested },
  ];
  const tree = [{
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks Bar", children: [{ id: "folder-a", title: "My Folder", children: folderContents }, ...looseBookmarks] },
      { id: "2", title: "Other Bookmarks", children: [] },
    ],
  }];
  const shared = { storage: { organizerSettings: { method: "builtin", keepBackupFolder: false } }, tree };
  const worker = backgroundHarness(shared, {});
  const result = await worker.message("organizeBookmarks");
  assert.equal(result.ok, true);
  // Only three things ever move: the two loose bookmarks and the top-level
  // folder itself, as one unit — never its nested contents individually.
  assert.equal(shared.moves.length, 3);
  assert.ok(shared.moves.some(move => move.id === "folder-a"), "the top-level folder should be sent and moved as a unit");
  assert.ok(shared.moves.some(move => move.id === "loose-1"));
  assert.ok(shared.moves.some(move => move.id === "loose-2"));
  assert.ok(!shared.moves.some(move => ["kept-1", "buried-1", "nested-folder"].includes(move.id)), "a folder's own contents move with it, not individually");
  // The category folder is created directly inside root "1" — no
  // intermediate "Organizer <date>" wrapper folder.
  const categoryFolders = shared.created.filter(node => node.parentId === "1" && !node.url);
  assert.equal(categoryFolders.length, 1, "exactly one category folder, no extra wrapper folder");
});

test("excludeFoldersFromOrganizing leaves a top-level folder and its contents completely untouched", async () => {
  const looseBookmarks = [
    { id: "loose-1", title: "Loose 1", url: "https://example.com/loose1" },
    { id: "loose-2", title: "Loose 2", url: "https://example.com/loose2" },
  ];
  const nested = [{ id: "buried-1", title: "Buried", url: "https://example.com/buried" }];
  const folderContents = [
    { id: "kept-1", title: "Kept", url: "https://example.com/kept" },
    { id: "nested-folder", title: "Nested", children: nested },
  ];
  const tree = [{
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks Bar", children: [{ id: "folder-a", title: "My Folder", children: folderContents }, ...looseBookmarks] },
    ],
  }];
  const shared = { storage: { organizerSettings: { method: "builtin", excludeFoldersFromOrganizing: true } }, tree };
  const worker = backgroundHarness(shared, {});
  const result = await worker.message("organizeBookmarks");
  assert.equal(result.ok, true);
  // Only the two loose bookmarks move; the folder and everything inside it
  // (including its own direct bookmarks) is left exactly where it is.
  assert.equal(shared.moves.length, 2);
  assert.ok(shared.moves.every(move => move.id === "loose-1" || move.id === "loose-2"));
  assert.ok(!shared.moves.some(move => ["folder-a", "kept-1", "buried-1", "nested-folder"].includes(move.id)));
});

test("excludeFoldersFromOrganizing + organizeInsideExcludedFolders sorts a folder's own bookmarks inside itself without moving the folder", async () => {
  const looseBookmarks = [{ id: "loose-1", title: "Loose 1", url: "https://example.com/loose1" }];
  const nested = [{ id: "buried-1", title: "Buried", url: "https://example.com/buried" }];
  const folderContents = [
    { id: "kept-1", title: "Kept", url: "https://example.com/kept" },
    { id: "kept-2", title: "Kept 2", url: "https://example.com/kept2" },
    { id: "nested-folder", title: "Nested", children: nested },
  ];
  const tree = [{
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks Bar", children: [{ id: "folder-a", title: "My Folder", children: folderContents }, ...looseBookmarks] },
    ],
  }];
  const shared = { storage: { organizerSettings: { method: "builtin", excludeFoldersFromOrganizing: true, organizeInsideExcludedFolders: true } }, tree };
  const worker = backgroundHarness(shared, {});
  const result = await worker.message("organizeBookmarks");
  assert.equal(result.ok, true);
  // The folder itself never moves, and its nested subfolder is left alone —
  // only its two direct bookmarks move, into a category folder created
  // inside the original folder (id "folder-a"), plus the loose bookmark.
  assert.equal(shared.moves.length, 3);
  assert.ok(!shared.moves.some(move => move.id === "folder-a"), "the excluded folder itself must never move");
  assert.ok(!shared.moves.some(move => ["buried-1", "nested-folder"].includes(move.id)), "nested subfolders inside an excluded folder stay untouched");
  const kept1Move = shared.moves.find(move => move.id === "kept-1");
  const kept2Move = shared.moves.find(move => move.id === "kept-2");
  assert.ok(kept1Move && kept2Move);
  assert.equal(kept1Move.parentId, kept2Move.parentId, "both of the folder's own bookmarks land in the same new category folder");
  const categoryFolder = shared.created.find(node => node.id === kept1Move.parentId);
  assert.equal(categoryFolder.parentId, "folder-a", "the category folder is created inside the excluded folder itself");
});

test("reorganizing bookmarks with scope 'all' also recategorizes bookmarks already in folders", async () => {
  const folderedBookmarks = [{ id: "kept-1", title: "Kept", url: "https://example.com/kept" }];
  const tree = [{
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks Bar", children: [{ id: "folder-a", title: "My Folder", children: folderedBookmarks }] },
    ],
  }];
  const shared = { storage: { organizerSettings: { method: "builtin", bookmarkScope: "all" } }, tree };
  const worker = backgroundHarness(shared, {});
  const result = await worker.message("organizeBookmarks");
  assert.equal(result.ok, true);
  assert.equal(shared.moves.length, 1);
  assert.equal(shared.moves[0].id, "kept-1");
  // "My Folder" is emptied by that move, so organizing removes it -- no empty
  // folder left behind. The root is never touched.
  assert.ok((shared.removed || []).includes("folder-a"));
  assert.ok(!(shared.removed || []).includes("1"));
  const bar = shared.tree[0].children.find(node => node.id === "1");
  assert.ok(!bar.children.some(node => node.id === "folder-a"));
});

test("re-running loose organize adopts an existing category folder instead of nesting it inside a fresh copy", async () => {
  const tree = [{
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks Bar", children: [
        { id: "cat-dev", title: "Development", children: [{ id: "b1", title: "GH", url: "https://github.com/x" }] },
        { id: "loose-1", title: "Extra", url: "https://example.com/extra" },
      ] },
    ],
  }];
  const shared = { storage: { organizerSettings: { method: "builtin", keepBackupFolder: false } }, tree, assignCategory: () => "Development" };
  const worker = backgroundHarness(shared, {});
  const result = await worker.message("organizeBookmarks");
  assert.equal(result.ok, true);
  // The existing "Development" folder is reused: it never moves, no second
  // "Development" folder is created, and the loose bookmark merges into it.
  assert.ok(!shared.created.some(node => node.title === "Development"));
  assert.ok(!shared.moves.some(move => move.id === "cat-dev"));
  assert.equal(shared.moves.find(move => move.id === "loose-1").parentId, "cat-dev");
  assert.equal(shared.storage.organizerAiJobs.bookmarks.categories, 1);
});

test("restoring a bookmark snapshot rebuilds each root to match it exactly, leaving no organize residue", async () => {
  const snapshotTree = [{
    id: "0", title: "", children: [
      { id: "s-1", title: "Bookmarks Bar", children: [
        { id: "s-folder-work", title: "Work", children: [{ id: "s-b1", title: "Docs", url: "https://example.com/docs" }] },
        { id: "s-b3", title: "Loose", url: "https://example.com/loose" },
      ] },
      { id: "s-2", title: "Other Bookmarks", children: [] },
    ],
  }];
  // The live tree looks like the snapshot was organized: a "Development"
  // category folder holds the moved bookmarks, and "Work" was left empty.
  const liveTree = [{
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks Bar", children: [
        { id: "live-cat", title: "Development", children: [
          { id: "live-docs", title: "Docs", url: "https://example.com/docs" },
          { id: "live-loose", title: "Loose", url: "https://example.com/loose" },
        ] },
        { id: "live-empty", title: "Work", children: [] },
      ] },
      { id: "2", title: "Other Bookmarks", children: [] },
    ],
  }];
  const shared = {
    storage: { bookmarkBackups: [{ id: "backup-1", name: "Bookmarks — snapshot", createdAt: new Date().toISOString(), tree: snapshotTree }] },
    tree: liveTree,
  };
  const worker = backgroundHarness(shared, {});
  const result = await worker.message("restoreBookmarks", { id: "backup-1" });
  assert.equal(result.ok, true);

  // A safety backup of the pre-restore tree is saved before anything changes.
  assert.equal(shared.storage.bookmarkBackups.length, 2);

  // Root "1" now matches the snapshot exactly: "Work" > "Docs", then "Loose".
  const bar = shared.tree[0].children.find(node => node.id === "1");
  assert.deepEqual(bar.children.map(node => node.title), ["Work", "Loose"]);
  assert.equal(bar.children[0].url, undefined);
  assert.deepEqual(bar.children[0].children.map(node => node.url), ["https://example.com/docs"]);
  assert.equal(bar.children[1].url, "https://example.com/loose");
  // The "Development" category folder and the duplicate bookmarks are gone.
  assert.ok(!JSON.stringify(shared.tree).includes("Development"));
});

test("the activity detail exposes per-item categories and a per-category site digest", async () => {
  const bookmarks = [
    { id: "b0", title: "GitHub", url: "https://github.com/a" },
    { id: "b1", title: "GitLab", url: "https://gitlab.com/b" },
    { id: "b2", title: "YouTube", url: "https://youtube.com/c" },
  ];
  const shared = { storage: { organizerSettings: { method: "ai", provider: "dave" } }, bookmarks };
  const remote = { status: "queued", progress: { completed: 0, total: 6 }, assignments: [
    { index: 0, category: "Development" }, { index: 1, category: "Development" }, { index: 2, category: "Video" },
  ] };
  const first = backgroundHarness(shared, remote);
  await first.message("organizeBookmarks");
  // The activity tab opens automatically when the job starts.
  assert.equal((shared.tabsCreated || []).length, 1);
  assert.match(shared.tabsCreated[0].url, /activity\/activity\.html\?kind=bookmarks/);

  remote.status = "completed";
  const second = backgroundHarness(shared, remote);
  second.alarm();
  await waitFor(() => shared.storage.organizerAiJobs.bookmarks?.state === "completed");

  const res = await second.message("aiJobDetail", { kind: "bookmarks" });
  assert.equal(res.ok, true);
  const job = res.result;
  assert.equal(job.method, "ai");
  assert.equal(job.provider, "dave");
  assert.equal(job.detail.items.length, 3);
  assert.equal(job.assignments[0].category, "Development");
  const dev = job.explain.categories.find(entry => entry.name === "Development");
  assert.equal(dev.count, 2);
  assert.deepEqual(dev.domains.sort(), ["github.com", "gitlab.com"]);
  assert.equal(job.canUndo, true);
});

test("retrying a finished job runs a fresh organize for the same kind", async () => {
  const shared = { storage: { organizerSettings: { method: "builtin" } }, bookmarks: [{ id: "b0", title: "X", url: "https://x.com/a" }] };
  const worker = backgroundHarness(shared, {});
  await worker.message("organizeBookmarks");
  const firstId = shared.storage.organizerAiJobs.bookmarks.id;
  const backupsBefore = shared.storage.bookmarkBackups.length;

  const res = await worker.message("retryAiJob", { id: firstId });
  assert.equal(res.ok, true);
  assert.equal(res.result.pending, false);
  assert.equal(res.result.job.state, "completed");
  // A fresh organize means a fresh safety backup was taken first.
  assert.equal(shared.storage.bookmarkBackups.length, backupsBefore + 1);
});

test("undo restores the pre-organize backup for a completed bookmark job", async () => {
  const tree = [{ id: "0", title: "", children: [
    { id: "1", title: "Bookmarks Bar", children: [
      { id: "b0", title: "GitHub", url: "https://github.com/a" },
      { id: "b1", title: "News", url: "https://bbc.com/x" },
    ] },
  ] }];
  const shared = { storage: { organizerSettings: { method: "builtin" } }, tree, assignCategory: () => "Stuff" };
  const worker = backgroundHarness(shared, {});
  await worker.message("organizeBookmarks");
  const bar = shared.tree[0].children.find(node => node.id === "1");
  assert.ok(bar.children.some(node => node.title === "Stuff"));

  const jobId = shared.storage.organizerAiJobs.bookmarks.id;
  const res = await worker.message("undoAiJob", { id: jobId });
  assert.equal(res.ok, true);
  assert.equal(res.result.undone, "bookmarks");
  const restored = shared.tree[0].children.find(node => node.id === "1");
  assert.deepEqual(restored.children.map(node => node.title).sort(), ["GitHub", "News"]);
  assert.ok(!restored.children.some(node => node.title === "Stuff"));
});

test("the activity tab is not opened when the setting is off", async () => {
  const shared = { storage: { organizerSettings: { method: "ai", provider: "dave", openActivityOnStart: false, keepBackupFolder: false } }, bookmarks: [{ id: "b0", title: "X", url: "https://x.com" }] };
  const worker = backgroundHarness(shared, { status: "queued", progress: { completed: 0, total: 6 }, assignments: [] });
  await worker.message("organizeBookmarks");
  assert.equal((shared.tabsCreated || []).length, 0);
});

test("organizing bookmarks stashes the old layout in a \"backup\" folder in the first root", async () => {
  const tree = [{ id: "0", title: "", children: [
    { id: "1", title: "Bookmarks Bar", children: [
      { id: "b0", title: "GitHub", url: "https://github.com/a" },
      { id: "f1", title: "Reading", children: [{ id: "b1", title: "Post", url: "https://blog.example.com/p" }] },
    ] },
  ] }];
  const shared = { storage: { organizerSettings: { method: "builtin" } }, tree, assignCategory: () => "Stuff" };
  const worker = backgroundHarness(shared, {});
  await worker.message("organizeBookmarks");

  const bar = shared.tree[0].children.find(node => node.id === "1");
  const backup = bar.children.find(node => node.title === "backup" && !node.url);
  assert.ok(backup, "a 'backup' folder is created in the first root");
  assert.equal(backup.children.length, 1, "one dated subfolder per run");
  assert.deepEqual(backup.children[0].children.map(node => node.title).sort(), ["GitHub", "Reading"]);
  assert.deepEqual(backup.children[0].children.find(node => node.title === "Reading").children.map(node => node.url), ["https://blog.example.com/p"]);
  // the backup folder itself is never organized
  assert.ok(!shared.moves.some(move => move.id === backup.id));
  assert.ok(bar.children.find(node => node.title === "Stuff").children.some(node => node.url === "https://github.com/a"));

  // A second run adds another dated folder and never copies the backup folder into itself.
  await worker.message("organizeBookmarks");
  assert.equal(bar.children.find(node => node.title === "backup").children.length, 2);
  assert.ok(!bar.children.find(node => node.title === "backup").children.some(stamp => (stamp.children || []).some(node => node.title === "backup")));
});

test("the backup folder lands in the toolbar, not Firefox's hidden Bookmarks Menu", async () => {
  const tree = [{ id: "root________", title: "", children: [
    { id: "menu________", title: "Bookmarks Menu", children: [] },
    { id: "toolbar_____", title: "Bookmarks Toolbar", children: [{ id: "b0", title: "GitHub", url: "https://github.com/a" }] },
    { id: "unfiled_____", title: "Other Bookmarks", children: [] },
  ] }];
  const shared = { storage: { organizerSettings: { method: "builtin" } }, tree, assignCategory: () => "Stuff" };
  const worker = backgroundHarness(shared, {});
  await worker.message("organizeBookmarks");
  const menu = shared.tree[0].children.find(node => node.id === "menu________");
  const toolbar = shared.tree[0].children.find(node => node.id === "toolbar_____");
  assert.ok(!menu.children.some(node => node.title === "backup"), "not put in the often-hidden Bookmarks Menu");
  assert.ok(toolbar.children.some(node => node.title === "backup" && !node.url), "put in the visible toolbar");
});

test("keepBackupFolder off skips the visible backup folder", async () => {
  const tree = [{ id: "0", title: "", children: [
    { id: "1", title: "Bookmarks Bar", children: [{ id: "b0", title: "GitHub", url: "https://github.com/a" }] },
  ] }];
  const shared = { storage: { organizerSettings: { method: "builtin", keepBackupFolder: false } }, tree, assignCategory: () => "Stuff" };
  const worker = backgroundHarness(shared, {});
  await worker.message("organizeBookmarks");
  assert.ok(!shared.tree[0].children.find(node => node.id === "1").children.some(node => node.title === "backup"));
});

test("a Dave job records contiguous section ranges the activity detail can slice by", async () => {
  const bookmarks = Array.from({ length: 120 }, (_, index) => ({ id: `b${index}`, title: `B${index}`, url: `https://example.com/${index}` }));
  const shared = { storage: { organizerSettings: { method: "ai", provider: "dave", keepBackupFolder: false } }, bookmarks };
  const remote = { status: "queued", progress: { completed: 0, total: 6 }, assignments: bookmarks.map((_, index) => ({ index, category: `G${index % 3}` })) };
  const worker = backgroundHarness(shared, remote);
  await worker.message("organizeBookmarks");
  const sections = (await worker.message("aiJobDetail", { kind: "bookmarks" })).result.sections;
  assert.deepEqual(sections, [[0, 50], [50, 100], [100, 120]]);
});

test("Dave section completion timestamps accrue while the job is processing", async () => {
  const bookmarks = Array.from({ length: 100 }, (_, index) => ({ id: `b${index}`, title: `B${index}`, url: `https://example.com/${index}` }));
  const shared = { storage: { organizerSettings: { method: "ai", provider: "dave", keepBackupFolder: false } }, bookmarks };
  const remote = { status: "processing", progress: { completed: 1, total: 2 }, assignments: bookmarks.map((_, index) => ({ index, category: "G" })) };
  const worker = backgroundHarness(shared, remote);
  await worker.message("organizeBookmarks");
  worker.alarm();
  await waitFor(() => (shared.storage.organizerAiJobs.bookmarks.sectionCompletedAt || []).length >= 1);
  const job = (await worker.message("aiJobDetail", { kind: "bookmarks" })).result;
  assert.ok(job.processingStartedAt, "processing start is recorded");
  assert.ok((job.sectionCompletedAt || []).length >= 1, "a section completion time is recorded");
});
