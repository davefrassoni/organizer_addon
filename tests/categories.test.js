const test = require("node:test");
const assert = require("node:assert/strict");
const { categoryFor, assignments } = require("../shared/categories.js");
test("recognizes common services", () => {
  assert.equal(categoryFor({ url: "https://github.com/openai/codex", title: "Code" }), "Development");
  assert.equal(categoryFor({ url: "https://mail.google.com/", title: "Inbox" }), "Communication");
});
test("falls back to domain and preserves indexes", () => {
  assert.deepEqual(assignments([{ url: "https://example.org/a" }, { url: "https://example.org/b" }]), [{ index: 0, category: "example.org" }, { index: 1, category: "example.org" }]);
});
