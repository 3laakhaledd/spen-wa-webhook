const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseLines, maskJid, create } = require("./lines");
test("defaults to 3 lines keeping the existing instance first", () => {
  assert.deepEqual(parseLines("", "spen-whatsapp"), ["spen-whatsapp", "spen-whatsapp-2", "spen-whatsapp-3"]);
  assert.deepEqual(parseLines("a, b ,a,bad name", "x"), ["a", "b"]);
});
test("masks the connected number", () => {
  assert.equal(maskJid("966531208444:12@s.whatsapp.net"), "+••••••••8444");
});
test("creates missing lines and reports state without leaking tokens", async () => {
  const made = [];
  const axios = {
    get: async url => ({ data: [{ name: "l1", connectionStatus: "open", ownerJid: "966500001111@s.whatsapp.net", token: "SECRET" },
      ...made.map(n => ({ name: n, connectionStatus: "close" }))] }),
    post: async (url, body) => { assert.match(url, /instance\/create$/); made.push(body.instanceName); return { data: {} }; }
  };
  const l = create({ axios, baseUrl: "https://e.test/", apiKey: "k", lines: ["l1", "l2", "l3"] });
  const s = await l.status();
  assert.deepEqual(made, ["l2", "l3"]);
  assert.equal(s.length, 3);
  assert.equal(s[0].connected, true);
  assert.equal(s[1].exists, true);
  assert.equal(s[2].connected, false);
  assert.equal(JSON.stringify(s).includes("SECRET"), false);
});
test("connect key gate", async () => {
  const routes = new Map();
  const app = { get: (p, f) => routes.set(p, f) };
  create({ axios: { get: async () => ({ data: [] }), post: async () => ({}) }, baseUrl: "x", apiKey: "k", lines: ["a"], connectKey: "z" }).install(app);
  let code;
  const res = { set() {}, status(c) { code = c; return this; }, json() {}, type() { return this; }, send() {} };
  await routes.get("/lines")({ query: {} }, res);
  assert.equal(code, 403);
});
