const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync("shared/background.js", "utf8");

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function backgroundHarness(shared, remoteState) {
  let messageListener, alarmListener;
  const bookmarks = Array.from({ length: 300 }, (_, index) => ({ id: `bookmark-${index}`, title: `Bookmark ${index}`, url: `https://example.com/${index}` }));
  const api = {
    bookmarks: {
      async getTree() { return [{ id: "root", children: bookmarks }]; },
      async create(details) { const folder = { id: `folder-${++shared.folderSequence}`, ...details }; shared.createdFolders.push(folder); return folder; },
      async move(id, details) { shared.moves.push({ id, ...details }); return { id, ...details }; },
      async remove() {},
    },
    tabs: { async query() { return []; } },
    windows: {},
    storage: { local: {
      async get(defaults) { return { ...defaults, ...shared.storage }; },
      async set(values) { Object.assign(shared.storage, structuredClone(values)); },
    } },
    alarms: {
      async create(name, details) { shared.alarms[name] = details; },
      async clear(name) { delete shared.alarms[name]; return true; },
      onAlarm: { addListener(listener) { alarmListener = listener; } },
    },
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
        return response({ id: "parent-job", status: "completed", progress: { completed: 6, total: 6 }, result: { assignments: bookmarks.map((_, index) => ({ index, category: `Group ${index % 3}` })) }, error: "" });
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
    alarm() { alarmListener({ name: "organizer-dave-ai-jobs" }); },
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
  const shared = {
    storage: { organizerSettings: { method: "ai", provider: "dave", removeDuplicateBookmarks: false } },
    moves: [], createdFolders: [], folderSequence: 0, alarms: {},
  };
  const remote = { status: "queued", progress: { completed: 0, total: 6 } };
  const firstWorker = backgroundHarness(shared, remote);
  const submitted = await firstWorker.message("organizeBookmarks");
  assert.equal(submitted.ok, true);
  assert.equal(submitted.result.pending, true);
  assert.equal(submitted.result.job.count, 300);
  assert.equal(shared.storage.organizerAiJobs.bookmarks.state, "queued");
  assert.ok(shared.alarms["organizer-dave-ai-jobs"]);
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
  assert.equal(job.bookmarkRefs, undefined);
  assert.equal(shared.alarms["organizer-dave-ai-jobs"], undefined);
});
