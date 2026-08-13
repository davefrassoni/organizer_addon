const api = globalThis.browser || globalThis.chrome;
const t = OrganizerI18n.t;
const $ = selector => document.querySelector(selector);
let pendingImport;
let currentSettings = { method: "ai", provider: "dave" };
let currentAiJobs = {};
function friendlyError(error, aiAction = false) {
  const detail = String(error?.message || error || "");
  if (/receiving end does not exist|could not establish connection|message port closed|no matching message handler/i.test(detail)) return aiAction ? t("errorBackgroundRestarted") : t("errorBackgroundUnavailable");
  if (/timed out|timeout|aborted/i.test(detail)) return t("errorAiTimeoutFriendly");
  if (/failed to fetch|networkerror|network request failed/i.test(detail)) return t("errorNetworkUnreachable");
  return detail || t("errorGeneric");
}
function message(action, extra = {}) { return globalThis.browser ? api.runtime.sendMessage({ action, ...extra }).catch(error => { throw new Error(friendlyError(error, action.startsWith("organize"))); }) : new Promise((resolve, reject) => api.runtime.sendMessage({ action, ...extra }, response => { const error = api.runtime.lastError; error ? reject(new Error(friendlyError(error, action.startsWith("organize")))) : resolve(response); })); }
function status(text, type = "") { const node = $("#status"); node.className = type; node.textContent = text; }
function activeAiJob(job) { return job && ["queued", "processing", "applying"].includes(job.state); }
function applyJobButtonState() {
  if (activeAiJob(currentAiJobs.bookmarks)) $("#organize-bookmarks").disabled = true;
  if (activeAiJob(currentAiJobs.tabs)) $("#organize-tabs").disabled = true;
}
function setOrganizeBusy(busy, activeId = "") { for (const id of ["#organize-tabs", "#organize-bookmarks"]) { const button = $(id); button.disabled = busy; button.classList.toggle("loading", busy && id === activeId); } if (!busy) applyJobButtonState(); }
async function run(action, extra = {}, success = "") {
  status(t("statusWorking"), "busy");
  try { const response = await message(action, extra); if (!response?.ok) throw new Error(response?.error || t("errorBackgroundGone")); status(success || t("statusDone"), "success"); await render(); return response.result; }
  catch (error) { status(friendlyError(error), "error"); }
}
function requestAiAccess() {
  if (currentSettings.method !== "ai" || !api.permissions) return Promise.resolve(true);
  return OrganizerPermissions.request(currentSettings.provider);
}
async function organize(action, success, activeId) {
  setOrganizeBusy(true, activeId);
  status(t("preparingAiAccess"), "busy");
  let ticker;
  try {
    // permissions.request must be invoked synchronously from this click's call
    // stack. Await only the already-started permission request below.
    const accessRequest = requestAiAccess();
    if (!await accessRequest) { status(t("aiAccessRequired"), "error"); return; }
    const started = Date.now();
    status(t("creatingBackupSendingAi"), "busy");
    ticker = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); status(t("aiProcessingTicker", [String(seconds)]), "busy"); }, 3000);
    const response = await message(action);
    if (!response?.ok) throw new Error(response?.error || t("errorAiJobFailed"));
    const kindLabel = response.result?.job?.kind === "tabs" ? t("kindTabsLabel") : t("kindBookmarksLabel");
    status(response.result?.pending ? t("aiProcessingStarted", [String(response.result.job.count), kindLabel]) : success, "success");
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
  const detail = document.createElement("small"); detail.textContent = `${t("itemsCount", [String(count)])} · ${new Date(item.createdAt).toLocaleString()}`;
  const actions = document.createElement("div"); actions.className = "item-actions";
  const restore = document.createElement("button"); restore.className = "small"; restore.textContent = t("restoreButton"); restore.onclick = () => run(restoreAction, { id: item.id }, t("backupRestored"));
  const remove = document.createElement("button"); remove.className = "small danger"; remove.textContent = t("deleteButton"); remove.onclick = () => { if (confirm(t("confirmDeleteBackup"))) run("delete", { store, id: item.id }, t("backupDeleted")); };
  actions.append(restore, remove); node.append(name, detail, actions); return node;
}
const AI_JOB_SEEN_MS = 5000;
const AI_JOB_FADE_MS = 600;
const dismissedAiJobIds = new Set();
const dismissTimers = new Map();
function finalizeDismiss(jobId) {
  if (dismissedAiJobIds.has(jobId)) return;
  dismissedAiJobIds.add(jobId);
  document.querySelector(`[data-job-id="${CSS.escape(jobId)}"]`)?.remove();
  $("#ai-jobs").hidden = !$("#ai-jobs-list").children.length;
  message("dismissAiJob", { id: jobId }).catch(() => {});
}
function scheduleAiJobDismiss(job) {
  if (dismissTimers.has(job.id) || dismissedAiJobIds.has(job.id)) return;
  dismissTimers.set(job.id, setTimeout(() => {
    dismissTimers.delete(job.id);
    const node = document.querySelector(`[data-job-id="${CSS.escape(job.id)}"]`);
    if (node) {
      node.classList.add("fade-out");
      node.addEventListener("transitionend", () => finalizeDismiss(job.id), { once: true });
    }
    setTimeout(() => finalizeDismiss(job.id), AI_JOB_FADE_MS + 200);
  }, AI_JOB_SEEN_MS));
}
function aiJobRow(job) {
  const node = document.createElement("div"); node.className = `item ai-job ${job.state}`;
  node.dataset.jobId = job.id;
  const kindLabel = job.kind === "tabs" ? t("kindTabsLabel") : t("kindBookmarksLabel");
  const title = document.createElement("strong"); title.textContent = `🤖 ${job.count} ${kindLabel}`;
  const detail = document.createElement("small");
  const completed = job.progress?.completed || 0, total = job.progress?.total || 1;
  const applyingKey = job.kind === "tabs" ? "jobStateApplyingTabs" : "jobStateApplyingBookmarks";
  const completedKey = job.kind === "tabs" ? "jobStateCompletedTabs" : "jobStateCompletedBookmarks";
  const labels = {
    queued: t("jobStateQueued", [String(completed), String(total)]),
    processing: t("jobStateProcessing", [String(completed), String(total)]),
    applying: t(applyingKey, [String(job.applyProgress || 0), String(job.count)]),
    completed: t(completedKey, [String(job.categories || 0)]),
    failed: job.error || t("jobStateFailed"),
    cancelled: t("jobStateCancelled"),
  };
  detail.textContent = labels[job.state] || job.state;
  const actions = document.createElement("div"); actions.className = "item-actions";
  if (activeAiJob(job)) {
    const cancel = document.createElement("button"); cancel.className = "small danger"; cancel.textContent = t("cancelButton");
    cancel.onclick = async () => { cancel.disabled = true; status(t("cancellingAiJob"), "busy"); try { const response = await message("cancelAiJob", { id: job.id }); if (!response?.ok) throw new Error(response?.error || t("couldNotCancelAiJob")); status(t("aiJobCancelled"), "success"); await render(); } catch (error) { status(friendlyError(error, true), "error"); } };
    actions.append(cancel);
  }
  const progress = document.createElement("progress");
  if (job.state === "applying") { progress.max = Math.max(1, job.count); progress.value = job.applyProgress || 0; }
  else { progress.max = Math.max(1, total); progress.value = job.state === "completed" ? total : completed; }
  node.append(title, detail, actions, progress); return node;
}
function renderAiJobs(jobs) {
  const list = $("#ai-jobs-list");
  // A job mid-fade keeps its existing DOM node (not a fresh one) so the CSS
  // transition isn't interrupted by the next automatic poll's re-render.
  const nodes = jobs.filter(job => !dismissedAiJobIds.has(job.id)).map(job => {
    const existing = list.querySelector(`[data-job-id="${CSS.escape(job.id)}"]`);
    if (existing && existing.classList.contains("fade-out")) return existing;
    if (!activeAiJob(job)) scheduleAiJobDismiss(job);
    return aiJobRow(job);
  });
  list.replaceChildren(...nodes);
  $("#ai-jobs").hidden = !nodes.length;
}
async function render() {
  const response = await message("list"); if (!response.ok) return;
  const tabs = response.result.tabSessions || [], bookmarks = response.result.bookmarkBackups || [];
  currentAiJobs = response.result.aiJobs || {};
  // Most recently updated/finished jobs are shown first.
  const jobs = Object.values(currentAiJobs).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  renderAiJobs(jobs);
  $("#organize-bookmarks").disabled = activeAiJob(currentAiJobs.bookmarks);
  $("#organize-tabs").disabled = activeAiJob(currentAiJobs.tabs);
  $("#tabs-list").replaceChildren(...(tabs.length ? tabs.map(x => row(x, "tabSessions", "restoreTabs", x.tabs.length)) : [Object.assign(document.createElement("div"), { className: "empty", textContent: t("noSessionsYet") })]));
  $("#bookmarks-list").replaceChildren(...(bookmarks.length ? bookmarks.map(x => row(x, "bookmarkBackups", "restoreBookmarks", countBookmarks(x.tree))) : [Object.assign(document.createElement("div"), { className: "empty", textContent: t("noBackupsYet") })]));
}
function countBookmarks(nodes) { return (nodes || []).reduce((sum, x) => sum + (x.url ? 1 : 0) + countBookmarks(x.children), 0); }
async function loadSettings() { const stored = await api.storage.local.get({ organizerSettings: currentSettings }); currentSettings = { ...currentSettings, ...stored.organizerSettings }; }
OrganizerI18n.apply();
$("#save-close").onclick = () => run("saveTabs", { closeAfter: true }, t("sessionSavedClosed"));
$("#save-tabs").onclick = () => run("saveTabs", {}, t("tabsBackedUp"));
$("#save-bookmarks").onclick = () => run("saveBookmarks", {}, t("bookmarksBackedUp"));
$("#organize-tabs").onclick = () => organize("organizeTabs", t("tabsOrganizedSuccess"), "#organize-tabs");
$("#organize-bookmarks").onclick = () => organize("organizeBookmarks", t("bookmarksOrganizedSuccess"), "#organize-bookmarks");
$("#settings").onclick = () => api.runtime.openOptionsPage();
document.querySelectorAll("[data-export]").forEach(button => button.onclick = async () => { const response = await message("list"); const store = button.dataset.export; const blob = new Blob([JSON.stringify({ format: "organizer-addon", version: 1, type: store, items: response.result[store] }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `organizer-${store}-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
document.querySelectorAll("[data-import]").forEach(button => button.onclick = () => { pendingImport = button.dataset.import; $("#file").click(); });
$("#file").onchange = async event => { try { const parsed = JSON.parse(await event.target.files[0].text()); if (parsed.format !== "organizer-addon" || parsed.type !== pendingImport || !Array.isArray(parsed.items)) throw new Error(t("incompatibleBackupFile")); await run("import", { store: pendingImport, items: parsed.items }, t("backupImported")); } catch (error) { $("#status").className = "error"; $("#status").textContent = error.message; } event.target.value = ""; };
setOrganizeBusy(true);
Promise.all([loadSettings(), render()]).then(() => setOrganizeBusy(false)).catch(error => status(friendlyError(error), "error"));
setInterval(() => { if (!document.hidden) render().catch(error => status(friendlyError(error), "error")); }, 5000);
