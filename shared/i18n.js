// Localizes the extension's own pages (popup, options, activity). By default
// it defers to the browser UI language via api.i18n; when the user picks a
// language in Settings, that locale's messages.json is fetched and used
// instead, falling back to English and then to api.i18n.
const OrganizerI18n = (function () {
  const api = globalThis.browser || globalThis.chrome;
  const SUPPORTED = ["en", "es", "fr", "de", "pt", "it"];
  const NATIVE_NAME = { en: "English", es: "Español", fr: "Français", de: "Deutsch", pt: "Português", it: "Italiano" };
  let table = null;      // { key: "message" } for the active locale
  let fallback = null;   // English table, for keys missing from the active locale
  let activeLang = "en";

  function browserLanguage() {
    const list = (globalThis.navigator && navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [(globalThis.navigator && navigator.language) || "en"];
    for (const raw of list) {
      const base = String(raw).toLowerCase().split("-")[0];
      if (SUPPORTED.includes(base)) return base;
    }
    return "en";
  }
  function resolve(preference) {
    return preference && preference !== "auto" && SUPPORTED.includes(preference) ? preference : browserLanguage();
  }
  async function loadTable(lang) {
    const response = await fetch(api.runtime.getURL(`_locales/${lang}/messages.json`));
    const json = await response.json();
    const flat = {};
    for (const [key, value] of Object.entries(json)) flat[key] = (value && value.message) || "";
    return flat;
  }
  async function init() {
    let preference = "auto";
    try { preference = (await api.storage.local.get({ organizerSettings: {} })).organizerSettings.uiLanguage || "auto"; } catch (_) {}
    activeLang = resolve(preference);
    try {
      table = await loadTable(activeLang);
      fallback = activeLang === "en" ? table : await loadTable("en");
    } catch (_) {
      table = null;
      fallback = null;
    }
    if (globalThis.document) document.documentElement.lang = activeLang;
    return activeLang;
  }
  function substitute(text, subs) {
    if (subs == null) return text;
    const list = Array.isArray(subs) ? subs : [subs];
    return text.replace(/\$(\d+)/g, (_, n) => (list[Number(n) - 1] != null ? String(list[Number(n) - 1]) : ""));
  }
  function t(key, subs) {
    if (table && table[key]) return substitute(table[key], subs);
    if (fallback && fallback[key]) return substitute(fallback[key], subs);
    return (api.i18n && api.i18n.getMessage(key, subs)) || key;
  }
  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach(node => { node.textContent = t(node.getAttribute("data-i18n")); });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(node => { node.placeholder = t(node.getAttribute("data-i18n-placeholder")); });
    root.querySelectorAll("[data-i18n-title]").forEach(node => { node.title = t(node.getAttribute("data-i18n-title")); });
  }
  return { t, apply, init, resolve, browserLanguage, SUPPORTED, NATIVE_NAME, get lang() { return activeLang; } };
})();
