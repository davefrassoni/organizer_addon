const api = globalThis.browser || globalThis.chrome;
const $ = selector => document.querySelector(selector);
let pendingImport;
function message(action, extra = {}) { return globalThis.browser ? api.runtime.sendMessage({ action, ...extra }) : new Promise((resolve, reject) => api.runtime.sendMessage({ action, ...extra }, response => { const error = api.runtime.lastError; error ? reject(new Error(error.message)) : resolve(response); })); }
function status(text, type = "") { const node = $("#status"); node.className = type; node.textContent = text; }
function setOrganizeBusy(busy) { for (const id of ["#organize-tabs", "#organize-bookmarks"]) { const button = $(id); button.disabled = busy; button.classList.toggle("loading", busy); } }
async function run(action, extra = {}, success = "Done.") {
  status("Working…", "busy");
  try { const response = await message(action, extra); if (!response?.ok) throw new Error(response?.error || "The extension background process did not respond. Reload the extension and try again."); status(success, "success"); await render(); return response.result; }
  catch (error) { status(error.message, "error"); }
}
async function ensureAiAccess() {
  const stored = await api.storage.local.get({ organizerSettings: { method: "ai", provider: "dave" } });
  const settings = { method: "ai", provider: "dave", ...stored.organizerSettings };
  if (settings.method !== "ai" || !api.permissions) return true;
  const origins = { dave: "https://davefrassoni.com/*", openai: "https://api.openai.com/*", anthropic: "https://api.anthropic.com/*", gemini: "https://generativelanguage.googleapis.com/*" };
  const request = { origins: [origins[settings.provider] || origins.dave] };
  if (globalThis.browser) { request.data_collection = ["browsingActivity", "bookmarksInfo"]; if (settings.provider !== "dave") request.data_collection.push("authenticationInfo"); }
  const granted = await api.permissions.request(request);
  if (!granted) status("AI access is required for the selected organization method. You can choose the offline method in Settings.", "error");
  return granted;
}
async function organize(action, success) {
  setOrganizeBusy(true);
  status("Preparing AI access…", "busy");
  let ticker;
  try {
    if (!await ensureAiAccess()) return;
    const started = Date.now();
    status("Creating a safety backup and sending links to the AI…", "busy");
    ticker = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); status(`AI job is processing… ${seconds}s. You can keep this popup open.`, "busy"); }, 3000);
    const response = await message(action);
    if (!response?.ok) throw new Error(response?.error || "The AI job could not be completed.");
    status(success, "success");
    await render();
  } catch (error) {
    status(error.message || "Organizer could not complete the AI job.", "error");
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
async function render() {
  const response = await message("list"); if (!response.ok) return;
  const tabs = response.result.tabSessions || [], bookmarks = response.result.bookmarkBackups || [];
  $("#tabs-list").replaceChildren(...(tabs.length ? tabs.map(x => row(x, "tabSessions", "restoreTabs", x.tabs.length)) : [Object.assign(document.createElement("div"), { className: "empty", textContent: "No saved sessions yet." })]));
  $("#bookmarks-list").replaceChildren(...(bookmarks.length ? bookmarks.map(x => row(x, "bookmarkBackups", "restoreBookmarks", countBookmarks(x.tree))) : [Object.assign(document.createElement("div"), { className: "empty", textContent: "No bookmark backups yet." })]));
}
function countBookmarks(nodes) { return (nodes || []).reduce((sum, x) => sum + (x.url ? 1 : 0) + countBookmarks(x.children), 0); }
$("#save-close").onclick = () => run("saveTabs", { closeAfter: true }, "Tabs saved.");
$("#save-tabs").onclick = () => run("saveTabs", {}, "Tabs backed up.");
$("#save-bookmarks").onclick = () => run("saveBookmarks", {}, "Bookmarks backed up.");
$("#organize-tabs").onclick = () => organize("organizeTabs", "Tabs organized; a backup was saved first.");
$("#organize-bookmarks").onclick = () => organize("organizeBookmarks", "Bookmarks organized; a backup was saved first.");
$("#settings").onclick = () => api.runtime.openOptionsPage();
document.querySelectorAll("[data-export]").forEach(button => button.onclick = async () => { const response = await message("list"); const store = button.dataset.export; const blob = new Blob([JSON.stringify({ format: "organizer-addon", version: 1, type: store, items: response.result[store] }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `organizer-${store}-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
document.querySelectorAll("[data-import]").forEach(button => button.onclick = () => { pendingImport = button.dataset.import; $("#file").click(); });
$("#file").onchange = async event => { try { const parsed = JSON.parse(await event.target.files[0].text()); if (parsed.format !== "organizer-addon" || parsed.type !== pendingImport || !Array.isArray(parsed.items)) throw new Error("This is not a compatible Organizer backup."); await run("import", { store: pendingImport, items: parsed.items }, "Backup imported."); } catch (error) { $("#status").className = "error"; $("#status").textContent = error.message; } event.target.value = ""; };
render().catch(error => status(error.message || "Could not connect to the extension background process. Reload the extension and try again.", "error"));
