const api = globalThis.browser || globalThis.chrome;
const $ = selector => document.querySelector(selector);
let pendingImport;
let currentSettings = { method: "ai", provider: "dave" };
let currentAiJobs = {};
function friendlyError(error, aiAction = false) {
  const detail = String(error?.message || error || "");
  if (/receiving end does not exist|could not establish connection|message port closed|no matching message handler/i.test(detail)) return aiAction
    ? "Organizer's background process restarted. Reopen the popup to see the saved AI job and its latest progress."
    : "Organizer's background process is unavailable. Reopen the popup; if this continues, reload the extension and try again.";
  if (/timed out|timeout|aborted/i.test(detail)) return "The AI service is taking longer than expected. No tabs or bookmarks were changed, and remaining AI batches were cancelled. Please try again later.";
  if (/failed to fetch|networkerror|network request failed/i.test(detail)) return "Organizer could not reach the AI service. Check your connection and try again; no tabs or bookmarks were changed.";
  return detail || "Organizer could not complete this action.";
}
function message(action, extra = {}) { return globalThis.browser ? api.runtime.sendMessage({ action, ...extra }).catch(error => { throw new Error(friendlyError(error, action.startsWith("organize"))); }) : new Promise((resolve, reject) => api.runtime.sendMessage({ action, ...extra }, response => { const error = api.runtime.lastError; error ? reject(new Error(friendlyError(error, action.startsWith("organize")))) : resolve(response); })); }
function status(text, type = "") { const node = $("#status"); node.className = type; node.textContent = text; }
function activeAiJob(job) { return job && ["queued", "processing", "applying"].includes(job.state); }
function applyJobButtonState() { if (activeAiJob(currentAiJobs.bookmarks)) $("#organize-bookmarks").disabled = true; }
function setOrganizeBusy(busy, activeId = "") { for (const id of ["#organize-tabs", "#organize-bookmarks"]) { const button = $(id); button.disabled = busy; button.classList.toggle("loading", busy && id === activeId); } if (!busy) applyJobButtonState(); }
async function run(action, extra = {}, success = "Done.") {
  status("Working…", "busy");
  try { const response = await message(action, extra); if (!response?.ok) throw new Error(response?.error || "The extension background process did not respond. Reload the extension and try again."); status(success, "success"); await render(); return response.result; }
  catch (error) { status(friendlyError(error), "error"); }
}
function requestAiAccess() {
  if (currentSettings.method !== "ai" || !api.permissions) return Promise.resolve(true);
  const origins = { dave: "https://davefrassoni.com/*", openai: "https://api.openai.com/*", anthropic: "https://api.anthropic.com/*", gemini: "https://generativelanguage.googleapis.com/*" };
  const request = { origins: [origins[currentSettings.provider] || origins.dave] };
  if (globalThis.browser) { request.data_collection = ["browsingActivity", "bookmarksInfo"]; if (currentSettings.provider !== "dave") request.data_collection.push("authenticationInfo"); }
  return api.permissions.request(request);
}
async function organize(action, success, activeId) {
  setOrganizeBusy(true, activeId);
  status("Preparing AI access…", "busy");
  let ticker;
  try {
    // permissions.request must be invoked synchronously from this click's call
    // stack. Await only the already-started permission request below.
    const accessRequest = requestAiAccess();
    if (!await accessRequest) { status("AI access is required for the selected organization method. You can choose the offline method in Settings.", "error"); return; }
    const started = Date.now();
    status("Creating a safety backup and sending links to the AI…", "busy");
    ticker = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); status(`AI job is processing… ${seconds}s. You can keep this popup open.`, "busy"); }, 3000);
    const response = await message(action);
    if (!response?.ok) throw new Error(response?.error || "The AI job could not be completed.");
    status(response.result?.pending ? `AI processing started for ${response.result.job.count} bookmarks. You can close this popup; Organizer will continue in the background.` : success, "success");
    await render();
  } catch (error) {
    status(friendlyError(error, true), "error");
  } finally {
    clearInterval(ticker);
    setOrganizeBusy(false);
  }
}
function row(item, store, restoreAction, count) {
  const node = document.createElement("div"); node.className = "item";
  const name = document.createElement("strong"); name.textContent = item.name;
  const detail = document.createElement("small"); detail.textContent = `${count} items · ${new Date(item.createdAt).toLocaleString()}`;
  const actions = document.createElement("div"); actions.className = "item-actions";
  const restore = document.createElement("button"); restore.className = "small"; restore.textContent = "Open"; restore.onclick = () => run(restoreAction, { id: item.id }, "Backup restored.");
  const remove = document.createElement("button"); remove.className = "small danger"; remove.textContent = "Delete"; remove.onclick = () => { if (confirm("Delete this backup?")) run("delete", { store, id: item.id }, "Backup deleted."); };
  actions.append(restore, remove); node.append(name, detail, actions); return node;
}
function aiJobRow(job) {
  const node = document.createElement("div"); node.className = `item ai-job ${job.state}`;
  const title = document.createElement("strong"); title.textContent = `🤖 ${job.count} ${job.kind}`;
  const detail = document.createElement("small");
  const completed = job.progress?.completed || 0, total = job.progress?.total || 1;
  const labels = { queued: `Waiting for AI · ${completed}/${total} batches`, processing: `AI processing · ${completed}/${total} batches`, applying: `Creating folders · ${job.applyProgress || 0}/${job.count} bookmarks`, completed: `Completed · ${job.categories || 0} folders`, failed: job.error || "Failed", cancelled: "Cancelled" };
  detail.textContent = labels[job.state] || job.state;
  const actions = document.createElement("div"); actions.className = "item-actions";
  if (activeAiJob(job)) {
    const cancel = document.createElement("button"); cancel.className = "small danger"; cancel.textContent = "Cancel";
    cancel.onclick = async () => { cancel.disabled = true; status("Cancelling AI job…", "busy"); try { const response = await message("cancelAiJob", { id: job.id }); if (!response?.ok) throw new Error(response?.error || "Could not cancel the AI job."); status("AI job cancelled.", "success"); await render(); } catch (error) { status(friendlyError(error, true), "error"); } };
    actions.append(cancel);
  }
  const progress = document.createElement("progress");
  if (job.state === "applying") { progress.max = Math.max(1, job.count); progress.value = job.applyProgress || 0; }
  else { progress.max = Math.max(1, total); progress.value = job.state === "completed" ? total : completed; }
  node.append(title, detail, actions, progress); return node;
}
async function render() {
  const response = await message("list"); if (!response.ok) return;
  const tabs = response.result.tabSessions || [], bookmarks = response.result.bookmarkBackups || [];
  currentAiJobs = response.result.aiJobs || {};
  const jobs = Object.values(currentAiJobs).filter(Boolean);
  $("#ai-jobs").hidden = !jobs.length;
  $("#ai-jobs-list").replaceChildren(...jobs.map(aiJobRow));
  $("#organize-bookmarks").disabled = activeAiJob(currentAiJobs.bookmarks);
  $("#tabs-list").replaceChildren(...(tabs.length ? tabs.map(x => row(x, "tabSessions", "restoreTabs", x.tabs.length)) : [Object.assign(document.createElement("div"), { className: "empty", textContent: "No saved sessions yet." })]));
  $("#bookmarks-list").replaceChildren(...(bookmarks.length ? bookmarks.map(x => row(x, "bookmarkBackups", "restoreBookmarks", countBookmarks(x.tree))) : [Object.assign(document.createElement("div"), { className: "empty", textContent: "No bookmark backups yet." })]));
}
function countBookmarks(nodes) { return (nodes || []).reduce((sum, x) => sum + (x.url ? 1 : 0) + countBookmarks(x.children), 0); }
async function loadSettings() { const stored = await api.storage.local.get({ organizerSettings: currentSettings }); currentSettings = { ...currentSettings, ...stored.organizerSettings }; }
$("#save-close").onclick = () => run("saveTabs", { closeAfter: true }, "Session saved; window closed.");
$("#save-tabs").onclick = () => run("saveTabs", {}, "Tabs backed up.");
$("#save-bookmarks").onclick = () => run("saveBookmarks", {}, "Bookmarks backed up.");
$("#organize-tabs").onclick = () => organize("organizeTabs", "Tabs organized; a backup was saved first.", "#organize-tabs");
$("#organize-bookmarks").onclick = () => organize("organizeBookmarks", "Bookmarks organized; a backup was saved first.", "#organize-bookmarks");
$("#settings").onclick = () => api.runtime.openOptionsPage();
document.querySelectorAll("[data-export]").forEach(button => button.onclick = async () => { const response = await message("list"); const store = button.dataset.export; const blob = new Blob([JSON.stringify({ format: "organizer-addon", version: 1, type: store, items: response.result[store] }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `organizer-${store}-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
document.querySelectorAll("[data-import]").forEach(button => button.onclick = () => { pendingImport = button.dataset.import; $("#file").click(); });
$("#file").onchange = async event => { try { const parsed = JSON.parse(await event.target.files[0].text()); if (parsed.format !== "organizer-addon" || parsed.type !== pendingImport || !Array.isArray(parsed.items)) throw new Error("This is not a compatible Organizer backup."); await run("import", { store: pendingImport, items: parsed.items }, "Backup imported."); } catch (error) { $("#status").className = "error"; $("#status").textContent = error.message; } event.target.value = ""; };
setOrganizeBusy(true);
Promise.all([loadSettings(), render()]).then(() => setOrganizeBusy(false)).catch(error => status(friendlyError(error), "error"));
setInterval(() => { if (!document.hidden) render().catch(error => status(friendlyError(error), "error")); }, 5000);
