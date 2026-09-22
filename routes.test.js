const { test } = require("node:test");
const assert = require("node:assert/strict");
const { install, dayBounds } = require("./retrieval");
function harness(fail = false) {
  const routes = new Map();
  const app = { get: (path, fn) => routes.set(path, fn) };
  const bounds = dayBounds("2026-09-21");
  const data = [{ id: "id1", key: { remoteJid: "anonymous@lid", fromMe: false },
    messageTimestamp: bounds.start, message: { conversation: "test" } }];
  let reads = 0;
  const axios = {
    get: async () => ({ data: [{ name: "test-instance", ownerJid: "owner@s.whatsapp.net",
      connectionStatus: "open", token: "DO_NOT_EXPOSE" }] }),
    post: async (url, body) => {
      reads++;
      if (fail) {
        const err = new Error("raw sensitive error"); err.response = { status: 401 }; throw err;
      }
      assert.match(url, /findMessages/);
      assert.equal(body.where.messageTimestamp.gte, "2026-09-20T21:00:00.000Z");
      assert.equal(body.where.messageTimestamp.lte, "2026-09-21T20:59:59.000Z");
      return { data: { messages: { total: 1, pages: 1, currentPage: body.page,
        records: body.page === 1 ? data : [] } } };
    }
  };
  install(app, { axios, baseUrl: "https://example.test", apiKey: "secret", instance: "test-instance" });
  async function call(path) {
    let value;
    const res = { set() {}, status() { return this; }, json(v) { value = v; } };
    await routes.get(path)({ query: { date: "2026-09-21", audit: "true" } }, res);
    return value;
  }
  return { call, reads: () => reads };
}
test("background report verifies every page, preserves LIDs and returns safe identity", async () => {
  const h = harness();
  const first = await h.call("/insights");
  assert.equal(first.status, "running");
  await new Promise(r => setImmediate(r));
  const final = await h.call("/insights");
  assert.equal(final.status, "complete");
  assert.equal(final.coverage.passesVerified, 2);
  assert.equal(h.reads(), 4);
  assert.equal(final.summary.totalMessages, 1);
  assert.equal(final.chats[0].kind, "individual_lid");
  assert.equal(final.pagination.nextOffset, null);
  assert.equal(JSON.stringify(final).includes("DO_NOT_EXPOSE"), false);
  const records = await h.call("/insights/records");
  assert.equal(records.messages.length, 1);
  assert.equal(records.messages[0].id, "id1");
});
test("failed read is explicit, never a successful empty report", async () => {
  const h = harness(true);
  await h.call("/insights");
  await new Promise(r => setImmediate(r));
  const r = await h.call("/insights");
  assert.equal(r.status, "failed");
  assert.equal(r.coverage.complete, false);
  assert.equal(r.summary, undefined);
  assert.equal(r.error.includes("raw sensitive"), false);
});
