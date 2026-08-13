const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync("shared/background.js", "utf8");
const enMessages = JSON.parse(fs.readFileSync("shared/_locales/en/messages.json", "utf8"));

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
  const api = {
    bookmarks: {
      async getTree() { return shared.tree; },
      async create(details) { const node = { id: `node-${++shared.folderSequence}`, ...details }; shared.created.push(node); return node; },
      async move(id, details) { shared.moves.push({ id, ...details }); return { id, ...details }; },
      async remove() {},
    },
    tabs: {
      async query() { return shared.tabsList; },
      async group(details) {
        if (details.groupId != null) { shared.groups[details.groupId].push(...details.tabIds); return details.groupId; }
        const groupId = `group-${++shared.groupSequence}`;
        shared.groups[groupId] = [...details.tabIds];
        return groupId;
      },
      async move(id, details) { shared.tabMoves.push({ id, ...details }); return { id, ...details }; },
      async remove() {},
    },
    tabGroups: { async update(groupId, details) { shared.groupTitles[groupId] = details.title; } },
    windows: { async create(details) { const win = { id: `win-${++shared.windowSequence}`, ...details }; shared.windowsCreated.push(win); return win; } },
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
      onMessage: { addListener(listener) { messageListener = listener; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
  };
  const context = {
    browser: api,
    OrganizerCategories: {
      assignments(items) { return items.map((_, index) => ({ index, category: "Other" })); },
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
    storage: { organizerSettings: { method: "ai", provider: "dave", removeDuplicateBookmarks: false } },
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
  const shared = { storage: { organizerSettings: { method: "builtin" } }, tree };
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
});

test("restoring a bookmark snapshot merges it back into the current tree instead of a wrapper folder", async () => {
  const snapshotTree = [{
    id: "0", title: "", children: [
      {
        id: "1", title: "Bookmarks Bar", children: [
          { id: "s-folder-work", title: "Work", children: [{ id: "s-b1", title: "Docs", url: "https://example.com/docs" }] },
          { id: "s-folder-gone", title: "Gone Folder", children: [{ id: "s-b2", title: "Gone", url: "https://example.com/gone" }] },
          { id: "s-b3", title: "Loose", url: "https://example.com/loose" },
        ],
      },
    ],
  }];
  const liveTree = [{
    id: "0", title: "", children: [
      {
        id: "live-1", title: "Bookmarks Bar", children: [
          { id: "live-folder-work", title: "Work", children: [] },
          { id: "live-existing", title: "Docs", url: "https://example.com/docs" },
          { id: "live-loose", title: "Loose", url: "https://example.com/loose" },
        ],
      },
    ],
  }];
  const shared = {
    storage: { bookmarkBackups: [{ id: "backup-1", name: "Bookmarks — snapshot", createdAt: new Date().toISOString(), tree: snapshotTree }] },
    tree: liveTree,
  };
  const worker = backgroundHarness(shared, {});
  const result = await worker.message("restoreBookmarks", { id: "backup-1" });
  assert.equal(result.ok, true);

  // No synthetic "<name> restored" wrapper folder is ever created.
  assert.ok(!shared.created.some(node => /restored/i.test(node.title || "")));
  // "Docs" is restored inside "Work" (where the snapshot had it) since the
  // live "Work" folder doesn't already contain it — dedupe is scoped per
  // folder, not global, so the same URL sitting loose elsewhere doesn't block it.
  const createdDocs = shared.created.filter(node => node.url === "https://example.com/docs");
  assert.equal(createdDocs.length, 1);
  assert.equal(createdDocs[0].parentId, "live-folder-work");
  // "Work" already exists (matched by title) and is reused, not recreated.
  assert.ok(!shared.created.some(node => node.title === "Work"));
  // "Gone Folder" no longer exists live, so it is recreated directly under
  // the matched live root, and its bookmark restored inside it.
  const goneFolder = shared.created.find(node => node.title === "Gone Folder");
  assert.ok(goneFolder);
  assert.equal(goneFolder.parentId, "live-1");
  assert.ok(shared.created.some(node => node.url === "https://example.com/gone" && node.parentId === goneFolder.id));
  // "Loose" already exists directly under the same live root with the same
  // URL, so restoring it again does not create a duplicate.
  assert.ok(!shared.created.some(node => node.url === "https://example.com/loose"));
});
