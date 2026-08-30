const api = globalThis.browser || globalThis.chrome;
const t = OrganizerI18n.t;
const $ = selector => document.querySelector(selector);
const ACTIVE = new Set(["queued", "processing", "applying"]);
const params = new URLSearchParams(location.search);
let kind = params.get("kind");
let job = null;
let view = "category";
let timer = null;
let busy = false;
// Categories the user has expanded, so a re-render (or a poll) doesn't
// collapse them again.
const openCategories = new Set();
let userToggledCategory = false;
let resultsKey = null;

function message(action, extra = {}) {
  if (globalThis.browser) return api.runtime.sendMessage({ action, ...extra });
  return new Promise((resolve, reject) => api.runtime.sendMessage({ action, ...extra }, response => {
    const error = api.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve(response);
  }));
}

function fmtTime(iso) { try { return new Date(iso).toLocaleString(); } catch (_) { return iso || "—"; } }
function host(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; } }
function providerLabel(value) {
  return { dave: t("providerDave"), openai: t("providerOpenai"), anthropic: t("providerAnthropic"), gemini: t("providerGemini") }[value] || value || "—";
}
function stateLabel(state) {
  return { queued: t("activityStateQueued"), processing: t("activityStateProcessing"), applying: t("activityStateApplying"), completed: t("activityStateCompleted"), failed: t("jobStateFailed"), cancelled: t("jobStateCancelled") }[state] || state;
}

async function refresh() {
  let response;
  try { response = await message("aiJobDetail", { kind, id: job && job.id }); }
  catch (_) { return schedule(); }
  const next = response && response.ok ? response.result : null;
  if (next) {
    if (!job || job.id !== next.id) { openCategories.clear(); userToggledCategory = false; resultsKey = null; }
    job = next; kind = job.kind; $("#cleared").hidden = true; render();
  }
  else if (job) { $("#cleared").hidden = false; }
  else { $("#empty").hidden = false; $("#job").hidden = true; }
  schedule();
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(refresh, job && ACTIVE.has(job.state) ? 1200 : 6000);
}

function renderSummary() {
  const badge = $("#state-badge");
  badge.textContent = stateLabel(job.state);
  badge.className = `badge ${job.state}`;
  $("#s-count").textContent = t("activityItemsCount", [String(job.count || 0), job.kind === "tabs" ? t("kindTabsLabel") : t("kindBookmarksLabel")]);
  $("#s-method").textContent = job.method === "builtin" ? t("methodBuiltin") : t("methodAi");
  $("#s-provider").textContent = job.method === "builtin" ? "—" : providerLabel(job.provider);
  $("#s-started").textContent = fmtTime(job.createdAt);
  $("#s-updated").textContent = fmtTime(job.updatedAt);

  const progress = $("#job-progress");
  const text = $("#progress-text");
  const err = $("#job-error");
  err.hidden = !job.error;
  err.textContent = job.error || "";
  if (job.state === "applying") {
    progress.hidden = false;
    progress.max = Math.max(1, job.count || 1);
    progress.value = job.applyProgress || 0;
    text.textContent = t(job.kind === "tabs" ? "jobStateApplyingTabs" : "jobStateApplyingBookmarks", [String(job.applyProgress || 0), String(job.count || 0)]);
  } else if (job.state === "queued" || job.state === "processing") {
    const done = (job.progress && job.progress.completed) || 0;
    const total = (job.progress && job.progress.total) || 1;
    progress.hidden = false;
    progress.max = total;
    progress.value = done;
    text.textContent = t(job.state === "queued" ? "jobStateQueued" : "jobStateProcessing", [String(done), String(total)]);
  } else if (job.state === "completed") {
    progress.hidden = false;
    progress.max = 1;
    progress.value = 1;
    text.textContent = t(job.kind === "tabs" ? "jobStateCompletedTabs" : "jobStateCompletedBookmarks", [String(job.categories || 0)]);
  } else {
    progress.hidden = true;
    text.textContent = "";
  }
}

function renderActions() {
  const active = ACTIVE.has(job.state);
  $("#cancel").hidden = !active;
  $("#retry").disabled = active || busy;
  const undo = $("#undo");
  undo.hidden = !job.canUndo;
  undo.disabled = busy;
  if (job.undone) {
    $("#action-status").textContent = job.undone === "bookmarks" ? t("activityUndoneBookmarks") : t("activityUndoneTabs");
  }
}

function renderBatches() {
  const list = $("#batch-list");
  const total = Math.max(1, (job.progress && job.progress.total) || 1);
  let done = (job.progress && job.progress.completed) || 0;
  if (job.state === "completed" || job.state === "applying") done = total;
  const rows = [];
  for (let index = 0; index < total; index++) {
    const state = index < done ? "done" : (index === done && job.state === "processing" ? "active" : "wait");
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `dot ${state}`;
    const label = document.createElement("span");
    const status = state === "done" ? t("activityBatchDone") : state === "active" ? t("activityBatchActive") : t("activityBatchWaiting");
    label.textContent = `${t("activityBatch", [String(index + 1)])} · ${status}`;
    li.append(dot, label);
    rows.push(li);
  }
  list.replaceChildren(...rows);
}

function itemLabel(item, fallbackIndex) {
  if (!item) return t("activityItemGone", [String(fallbackIndex + 1)]);
  return item.title || host(item.url) || item.url || "—";
}

function renderResults() {
  const results = $("#results");
  if (!job.explain || !job.assignments) { results.hidden = true; return; }
  results.hidden = false;

  $("#by-category").hidden = view !== "category";
  $(".table-wrap").hidden = view !== "list";
  $("#view-category").classList.toggle("active", view === "category");
  $("#view-list").classList.toggle("active", view === "list");

  // Only rebuild the (potentially large) result lists when the data or view
  // actually changed -- otherwise a poll would collapse open categories.
  const key = `${job.id}|${job.updatedAt}`;
  if (key === resultsKey) return;
  resultsKey = key;

  const detail = job.detail || { items: [], total: job.count || 0, truncated: false };
  $("#truncated").hidden = !detail.truncated;
  if (detail.truncated) $("#truncated").textContent = t("activityTruncated", [String(detail.items.length), String(detail.total)]);

  const byCategory = new Map();
  job.assignments.forEach(assignment => {
    if (!byCategory.has(assignment.category)) byCategory.set(assignment.category, []);
    byCategory.get(assignment.category).push(assignment);
  });
  const digest = new Map((job.explain.categories || []).map(entry => [entry.name, entry]));
  const autoOpen = byCategory.size <= 4;

  $("#by-category").replaceChildren(...Array.from(byCategory.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, rows]) => {
      const box = document.createElement("details");
      box.className = "cat";
      box.open = openCategories.has(name) || (autoOpen && !userToggledCategory);
      box.addEventListener("toggle", () => {
        userToggledCategory = true;
        box.open ? openCategories.add(name) : openCategories.delete(name);
      });
      const summary = document.createElement("summary");
      const strong = document.createElement("strong");
      strong.textContent = name;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(rows.length);
      summary.append(strong, count);
      box.append(summary);

      const entry = digest.get(name);
      if (entry && entry.domains && entry.domains.length) {
        const sites = document.createElement("p");
        sites.className = "cat-why";
        sites.textContent = t("activityCommonSites", [entry.domains.slice(0, 4).join(", ")]);
        box.append(sites);
      }

      const ul = document.createElement("ul");
      rows.forEach(assignment => {
        const item = detail.items[assignment.index];
        if (!item && detail.truncated) return;
        const li = document.createElement("li");
        const main = document.createElement("span");
        main.textContent = itemLabel(item, assignment.index);
        li.append(main);
        const site = item && host(item.url);
        if (site) { const sub = document.createElement("span"); sub.className = "sub"; sub.textContent = site; li.append(sub); }
        ul.append(li);
      });
      box.append(ul);
      return box;
    }));

  $("#full-list tbody").replaceChildren(...detail.items.map((item, index) => {
    const tr = document.createElement("tr");
    const itemCell = document.createElement("td");
    itemCell.textContent = itemLabel(item, index);
    const site = host(item.url);
    if (site) { const sub = document.createElement("span"); sub.className = "sub"; sub.textContent = site; itemCell.append(sub); }
    const categoryCell = document.createElement("td");
    categoryCell.textContent = (job.assignments[index] || {}).category || "—";
    tr.append(itemCell, categoryCell);
    return tr;
  }));
}

function render() {
  $("#empty").hidden = true;
  $("#job").hidden = false;
  renderSummary();
  renderActions();
  renderBatches();
  renderResults();
}

async function act(action, confirmKey, onDone) {
  if (busy) return;
  if (confirmKey && !confirm(t(confirmKey))) return;
  busy = true;
  renderActions();
  $("#action-status").textContent = t("statusWorking");
  try {
    const response = await message(action, { id: job.id });
    if (!response || !response.ok) throw new Error((response && response.error) || t("errorGeneric"));
    $("#action-status").textContent = onDone ? onDone() : t("statusDone");
  } catch (error) {
    $("#action-status").textContent = error.message || t("errorGeneric");
  } finally {
    busy = false;
    await refresh();
  }
}

$("#settings-link").onclick = event => { event.preventDefault(); api.runtime.openOptionsPage(); };
$("#retry").onclick = () => act("retryAiJob", null, () => t("activityRetryStarted"));
$("#cancel").onclick = () => act("cancelAiJob", null, () => t("aiJobCancelled"));
$("#undo").onclick = () => act("undoAiJob", "activityUndoConfirm", () => job.kind === "bookmarks" ? t("activityUndoneBookmarks") : t("activityUndoneTabs"));
$("#view-category").onclick = () => { view = "category"; if (job) renderResults(); };
$("#view-list").onclick = () => { view = "list"; if (job) renderResults(); };

if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.organizerAiJobs) refresh(); });
}

OrganizerI18n.apply();
OrganizerI18n.init().then(() => { OrganizerI18n.apply(); refresh(); });
