const OrganizerI18n = (function () {
  const api = globalThis.browser || globalThis.chrome;
  function t(key, subs) { return (api.i18n && api.i18n.getMessage(key, subs)) || key; }
  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach(node => { node.textContent = t(node.getAttribute("data-i18n")); });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(node => { node.placeholder = t(node.getAttribute("data-i18n-placeholder")); });
    root.querySelectorAll("[data-i18n-title]").forEach(node => { node.title = t(node.getAttribute("data-i18n-title")); });
  }
  return { t, apply };
})();
