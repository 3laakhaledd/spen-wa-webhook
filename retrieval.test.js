const { test } = require("node:test");
const assert = require("node:assert/strict");
const { dayBounds, jidOf, textOf, collectPass, verifiedCollect, aggregate } = require("./retrieval");
const b = dayBounds("2026-09-21");
function rows(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: "db-" + i, instanceId: "test",
    key: { id: "wa-" + i, remoteJid: i % 2 ? "abc@lid" : "123@g.us", fromMe: i % 3 === 0 },
    messageTimestamp: b.start + i, message: { conversation: "Test " + i }
  }));
}
function source(data, calls = []) {
  return async q => {
    calls.push(q);
    assert.equal(q.offset, 500);
    assert.equal(q.take, undefined);
    const f = q.where.messageTimestamp;
    const subset = f ? data.filter(m => m.messageTimestamp >= Date.parse(f.gte) / 1000 &&
      m.messageTimestamp <= Date.parse(f.lte) / 1000) : data;
    return { messages: { total: subset.length, pages: Math.ceil(subset.length / q.offset),
      currentPage: q.page, records: subset.slice((q.page - 1) * q.offset, q.page * q.offset) } };
  };
}
test("Riyadh date bounds are exact and invalid dates rejected", () => {
  assert.equal(new Date(b.start * 1000).toISOString(), "2026-09-20T21:00:00.000Z");
  assert.equal(new Date(b.end * 1000).toISOString(), "2026-09-21T21:00:00.000Z");
  assert.throws(() => dayBounds("2026-02-30"));
});
test("1001 records cover disjoint windows and exhaustion twice", async () => {
  const calls = [];
  const r = await verifiedCollect(source(rows(1001), calls), {}, b);
  assert.equal(r.coverage.complete, true);
  assert.equal(r.coverage.sourceTotal, 1001);
  assert.equal(r.coverage.passesVerified, 2);
  assert.ok(calls.every(q => q.page <= 2));
  assert.ok(r.coverage.passes.every(p => p.windows > 1 && p.exhaustionVerified));
});
test("zero is verified, not inferred from a failure", async () => {
  const r = await verifiedCollect(source([]), {}, b);
  assert.equal(r.coverage.uniqueRecords, 0);
  await assert.rejects(() => verifiedCollect(async () => { throw new Error("unreachable"); }, {}, b), /unreachable/);
});
test("duplicate page is rejected", async () => {
  const read = source(rows(1000));
  await assert.rejects(() => collectPass(async q => {
    const r = await read(q);
    if (q.page === 2) r.messages.records = rows(500);
    return r;
  }, {}, b), /Duplicate/);
});
test("ignored page parameter is rejected", async () => {
  const read = source(rows(501));
  await assert.rejects(() => collectPass(q => read({ ...q, page: 1 }), {}, b), /metadata/);
});
test("ignored page size is rejected", async () => {
  await assert.rejects(() => collectPass(async q => ({ messages: {
    total: 501, pages: 11, currentPage: q.page, records: rows(50)
  } }), {}, b), /Page size/);
});
test("changing count is rejected", async () => {
  const read = source(rows(501));
  await assert.rejects(() => collectPass(async q => {
    const r = await read(q); if (q.page > 1) r.messages.total++;
    return r;
  }, {}, b), /Source changed/);
});
test("date filter must be honored", async () => {
  const data = rows(1); data[0].messageTimestamp = b.end;
  await assert.rejects(() => collectPass(source(data), {}, b), /Date filter/);
});
test("different second-pass IDs invalidate report", async () => {
  let requests = 0;
  const data = rows(1);
  await assert.rejects(() => verifiedCollect(async q => {
    requests++;
    return source(requests > 3 ? [{ ...data[0], id: "changed" }] : data)(q);
  }, {}, b), /Verification pass differed/);
});
test("database ID never overrides remoteJid and all JID types count", () => {
  assert.equal(jidOf({ id: "database-uuid", remoteJid: "abc@lid" }), "abc@lid");
  const data = rows(4);
  data[2].key.remoteJid = "123@s.whatsapp.net";
  data[3].key.remoteJid = "status@broadcast";
  const a = aggregate(data);
  assert.equal(a.summary.totalMessages, 4);
  assert.equal(a.summary.rawChatThreads, 4);
  assert.equal(a.summary.sent + a.summary.received, 4);
});
test("wrapped text is extracted without claiming to transcribe media", () => {
  assert.equal(textOf({ message: { ephemeralMessage: { message: { conversation: "hello" } } } }), "hello");
  assert.equal(textOf({ message: { audioMessage: {} } }), "[media or non-text]");
});

test("timestamp ties cannot create duplicate pages in windowed retrieval", async () => {
  const data = rows(844).map((m, i) => ({ ...m, messageTimestamp: b.start + Math.floor(i / 100) }));
  const filtered = source(data);
  const r = await verifiedCollect(async q => {
    const result = await filtered(q);
    if (q.page > 1 && result.messages.total > 500)
      result.messages.records = data.slice(0, result.messages.records.length);
    return result;
  }, {}, b);
  assert.equal(r.rows.length, 844);
  assert.equal(r.coverage.passes[0].sha256, r.coverage.passes[1].sha256);
});
test("overfull single-second window still fails on unstable pagination", async () => {
  const data = rows(700).map(m => ({ ...m, messageTimestamp: b.start }));
  const filtered = source(data);
  await assert.rejects(() => verifiedCollect(async q => {
    const result = await filtered(q);
    if (q.page > 1 && result.messages.total > 500)
      result.messages.records = data.slice(0, result.messages.records.length);
    return result;
  }, {}, b), /Duplicate/);
});
