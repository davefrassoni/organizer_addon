const test = require("node:test");
const assert = require("node:assert/strict");
require("../shared/top-sites.js");
const { categoryFor, assignments, splitDuplicateUrls, batchedAssignments, chunkRanges } = require("../shared/categories.js");
test("recognizes common services", () => {
  assert.equal(categoryFor({ url: "https://github.com/openai/codex", title: "Code" }), "Development");
  assert.equal(categoryFor({ url: "https://mail.google.com/", title: "Inbox" }), "Communication");
});
test("falls back to domain and preserves indexes", () => {
  assert.deepEqual(assignments([{ url: "https://organizer-unknown.invalid/a" }, { url: "https://organizer-unknown.invalid/b" }]), [{ index: 0, category: "organizer-unknown.invalid" }, { index: 1, category: "organizer-unknown.invalid" }]);
});
test("ships exactly ten thousand popular domains for offline fallback", () => {
  assert.equal(globalThis.OrganizerTopSites.length, 10000);
  assert.equal(new Set(globalThis.OrganizerTopSites).size, 10000);
  assert.equal(categoryFor({ url: "https://gstatic.com/", title: "" }), "Popular Websites");
});
test("keeps the first identical URL and reports later duplicates", () => {
  const first = { id: 1, url: "https://example.org/page" }, duplicate = { id: 2, url: "https://example.org/page" }, other = { id: 3, url: "https://example.org/other" };
  assert.deepEqual(splitDuplicateUrls([first, duplicate, other]), { unique: [first, other], duplicates: [duplicate] });
});
test("combines AI batches while preserving indexes for large bookmark libraries", async () => {
  const items = Array.from({ length: 105 }, (_, index) => ({ url: `https://example.org/${index}` }));
  const batchSizes = [];
  const rows = await batchedAssignments(items, 50, async batch => {
    batchSizes.push(batch.length);
    return batch.map((_, index) => ({ index, category: `Batch ${batchSizes.length}` }));
  });
  assert.deepEqual(batchSizes, [50, 50, 5]);
  assert.equal(rows.length, 105);
  assert.deepEqual(rows.map(row => row.index), Array.from({ length: 105 }, (_, index) => index));
  assert.equal(rows[49].category, "Batch 1");
  assert.equal(rows[50].category, "Batch 2");
  assert.equal(rows[100].category, "Batch 3");
});
test("chunkRanges reports the same boundaries batchedAssignments would use", () => {
  const bySize = chunkRanges(Array.from({ length: 105 }, (_, index) => ({ url: `https://example.org/${index}` })), 50);
  assert.deepEqual(bySize, [[0, 50], [50, 100], [100, 105]]);
  const byBytes = chunkRanges(Array.from({ length: 5 }, (_, index) => ({ url: `https://example.org/${index}/${"x".repeat(30)}` })), 50, 150);
  assert.deepEqual(byBytes, [[0, 2], [2, 4], [4, 5]]);
});
test("uses serialized byte size to keep unusually long links within the model context", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ url: `https://example.org/${index}/${"x".repeat(30)}` }));
  const batchSizes = [];
  const rows = await batchedAssignments(items, 50, async batch => {
    batchSizes.push(batch.length);
    return batch.map((_, index) => ({ index, category: "Safe" }));
  }, 150);
  assert.deepEqual(batchSizes, [2, 2, 1]);
  assert.deepEqual(rows.map(row => row.index), [0, 1, 2, 3, 4]);
});
