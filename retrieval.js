// Evolution 2.3.7 fetchMessages uses offset (page size) and page (1-based).
// Validate source totals and exhaust pagination twice; never equate an error with zero.
const crypto = require("node:crypto");
const VERSION = "verified-windows-v4";
const windowed = require("./windowed");
const PAGE_SIZE = 500;
function timestamp(m) {
  const v = m.messageTimestamp;
  return Number(v && typeof v === "object" ? v.low : v);
}
function jidOf(c) {
  return c.remoteJid || c.lastMessage?.key?.remoteJid ||
    (typeof c.id === "string" && c.id.includes("@") ? c.id : "");
}
function textOf(m) {
  let v = m.message || {};
  for (let i = 0; i < 5; i++) {
    const next = v.ephemeralMessage?.message || v.viewOnceMessage?.message ||
      v.viewOnceMessageV2?.message || v.documentWithCaptionMessage?.message;
    if (!next) break;
    v = next;
  }
  return v.conversation || v.extendedTextMessage?.text || v.imageMessage?.caption ||
    v.videoMessage?.caption || v.documentMessage?.caption || v.documentMessage?.fileName ||
    v.documentMessage?.title || v.documentMessage?.name || "[media or non-text]";
}
function dayBounds(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Use date=YYYY-MM-DD");
  const midnight = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date)
    throw new Error("Invalid date");
  const start = midnight / 1000 - 10800;
  return { start, end: start + 86400 };
}
function yesterday() {
  return new Date(Date.now() + 10800000 - 86400000).toISOString().slice(0, 10);
}
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
  return v;
}
function digest(rows) {
  const h = crypto.createHash("sha256");
  for (const m of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(JSON.stringify(stable({
      id: m.id, instanceId: m.instanceId, key: m.key,
      messageTimestamp: timestamp(m), messageType: m.messageType, message: m.message
    })) + "\n");
  }
  return h.digest("hex");
}
function category(jid) {
  if (jid === "status@broadcast") return "status";
  if (jid.endsWith("@broadcast")) return "broadcast";
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@lid")) return "individual_lid";
  if (jid.endsWith("@s.whatsapp.net")) return "individual_phone";
  return "other";
}
async function collectPass(readPage, where, bounds, progress = () => {}) {
  let total = null, pages = null;
  const rows = [], ids = new Set(), receipts = [];
  async function read(page, exhaustion = false) {
    const data = await readPage({ where, offset: PAGE_SIZE, page });
    const b = data?.messages;
    if (!b || !Array.isArray(b.records) || !Number.isInteger(b.total) || b.total < 0 ||
        !Number.isInteger(b.pages) || b.pages < 0 || b.currentPage !== page)
      throw new Error("Missing or invalid pagination metadata on page " + page);
    if (total === null) {
      total = b.total; pages = b.pages;
      if (pages !== Math.ceil(total / PAGE_SIZE))
        throw new Error("Page size ignored or page count inconsistent");
    }
    if (b.total !== total || b.pages !== pages)
      throw new Error("Source changed during pagination; retry a fresh report");
    const expected = exhaustion ? 0 : Math.max(0, Math.min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE));
    if (b.records.length !== expected) throw new Error("Unexpected record count on page " + page);
    for (const m of b.records) {
      if (typeof m.id !== "string" || !m.id) throw new Error("Message missing stable database ID");
      if (ids.has(m.id)) throw new Error("Duplicate message across pages; source pagination is unstable");
      const ts = timestamp(m);
      if (!Number.isFinite(ts)) throw new Error("Message has invalid timestamp");
      if (bounds && (ts < bounds.start || ts >= bounds.end))
        throw new Error("Date filter was not honored by upstream");
      if (!m.key?.remoteJid) throw new Error("Message missing chat identifier");
      if (where.key?.remoteJid && m.key.remoteJid !== where.key.remoteJid)
        throw new Error("Contact filter was not honored by upstream");
      if (typeof m.key.fromMe !== "boolean") throw new Error("Message missing direction");
      ids.add(m.id); rows.push(m);
    }
    receipts.push({ page, records: b.records.length, sha256: digest(b.records), exhaustion });
    progress({ expectedRecords: total, expectedPages: pages, pagesRead: receipts.length, uniqueRecords: rows.length });
  }
  await read(1);
  for (let p = 2; p <= pages; p++) await read(p);
  await read(Math.max(2, pages + 1), true);
  if (ids.size !== total) throw new Error("Unique record total does not match source total");
  return { rows, audit: { total, pages, uniqueRecords: ids.size, duplicates: 0,
    exhaustionVerified: true, sha256: digest(rows), receipts } };
}
async function verifiedCollect(readPage, where, bounds, progress = () => {}) {
  const a = await windowed(readPage, where, bounds, p => progress({ pass: 1, ...p }), collectPass, digest);
  const b = await windowed(readPage, where, bounds, p => progress({ pass: 2, ...p }), collectPass, digest);
  if (a.audit.total !== b.audit.total || a.audit.sha256 !== b.audit.sha256)
    throw new Error("Verification pass differed; report is not complete");
  return { rows: b.rows, coverage: { complete: true, scope: "stored Evolution messages matching the query",
    sourceTotal: b.audit.total, uniqueRecords: b.rows.length, pagesPerPass: b.audit.pages,
    passesVerified: 2, exhaustionVerified: true, sha256: b.audit.sha256,
    verifiedAt: new Date().toISOString(), passes: [a.audit, b.audit] } };
}
function aggregate(rows) {
  const chats = new Map(), types = {};
  let sent = 0, received = 0, nonText = 0;
  for (const m of rows) {
    const jid = m.key.remoteJid, kind = category(jid);
    types[kind] = (types[kind] || 0) + 1;
    if (m.key.fromMe) sent++; else received++;
    if (textOf(m) === "[media or non-text]") nonText++;
    if (!chats.has(jid)) chats.set(jid, { jid, kind, contactName: jid, records: [] });
    const c = chats.get(jid);
    if (!m.key.fromMe && m.pushName) c.contactName = m.pushName;
    c.records.push(m);
  }
  const list = [...chats.values()].map(c => {
    c.records.sort((a, b) => timestamp(a) - timestamp(b) || a.id.localeCompare(b.id));
    const sentCount = c.records.filter(m => m.key.fromMe).length;
    const first = c.records[0], last = c.records[c.records.length - 1];
    return { ...c, messageCount: c.records.length, sent: sentCount,
      received: c.records.length - sentCount,
      firstMessageTime: new Date(timestamp(first) * 1000).toISOString(),
      lastMessageTime: new Date(timestamp(last) * 1000).toISOString(),
      lastDirection: last.key.fromMe ? "sent" : "received",
      // Direction is NOT a resolution status or proof a reply was required.
      endsWithInbound: !last.key.fromMe };
  }).sort((a, b) => b.messageCount - a.messageCount || a.jid.localeCompare(b.jid));
  return { chats: list, summary: { totalMessages: rows.length, sent, received,
    rawChatThreads: list.length, messagesByChatType: types, nonTextMessages: nonText,
    threadsEndingInbound: list.filter(c => c.endsWithInbound).length,
    note: "All chat ID types included; LID and phone aliases are not assumed to be distinct people. Media is counted, not transcribed. Last direction does not establish resolution." } };
}
function install(app, { axios, baseUrl, apiKey, instance }) {
  const jobs = new Map();
  const options = { headers: { apikey: apiKey, "Content-Type": "application/json" }, timeout: 30000 };
  const path = name => baseUrl.replace(/\/$/, "") + name + "/" + encodeURIComponent(instance);
  async function request(body) {
    let err;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return (await axios.post(path("/chat/findMessages"), body, options)).data; }
      catch (e) {
        err = e;
        if (e.response && e.response.status < 500 && e.response.status !== 429) break;
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw new Error("Evolution message query failed" + (err?.response?.status ? " (HTTP " + err.response.status + ")" : ""));
  }
  async function identity() {
    const r = await axios.get(baseUrl.replace(/\/$/, "") + "/instance/fetchInstances",
      { ...options, params: { instanceName: instance } });
    const list = Array.isArray(r.data) ? r.data : [r.data];
    const found = list.find(x => (x.name || x.instance?.instanceName || x.instanceName) === instance);
    if (!found) throw new Error("Configured instance could not be verified");
    const ownerJid = found.ownerJid || found.instance?.ownerJid;
    if (!ownerJid) throw new Error("Instance owner could not be verified");
    // Never return tokens, keys or the raw instance response.
    return { name: instance, ownerJid, connectionStatus: found.connectionStatus || found.instance?.status || null };
  }
  function ensureJob(date) {
    const bounds = dayBounds(date);
    const existing = jobs.get(date);
    if (existing && (existing.status === "running" ||
        Date.now() - existing.created < (existing.status === "failed" ? 30000 : 600000))) return existing;
    if ([...jobs.values()].some(j => j.status === "running"))
      throw new Error("Another date is being verified; retry when it completes");
    for (const [k, v] of jobs) if (Date.now() - v.created >= 600000) jobs.delete(k);
    if (jobs.size >= 3) jobs.delete(jobs.keys().next().value);
    const job = { date, status: "running", created: Date.now(), progress: {}, coverage: { complete: false } };
    jobs.set(date, job);
    (async () => {
      try {
        const before = await identity();
        const where = { messageTimestamp: {
          gte: new Date(bounds.start * 1000).toISOString(),
          lte: new Date((bounds.end - 1) * 1000).toISOString()
        } };
        const data = await verifiedCollect(request, where, bounds, p => { job.progress = p; });
        const after = await identity();
        if (before.ownerJid !== after.ownerJid) throw new Error("Connected number changed during verification");
        Object.assign(job, data, aggregate(data.rows), { identity: after, status: "complete",
          window: { start: new Date(bounds.start * 1000).toISOString(),
            endExclusive: new Date(bounds.end * 1000).toISOString(), timezone: "Asia/Riyadh" } });
      } catch (e) {
        job.status = "failed"; job.error = e.message; job.coverage = { complete: false };
      }
    })();
    return job;
  }
  const int = (v, d, max) => Math.min(max, Math.max(0, Number.isInteger(Number(v)) && v !== undefined ? Number(v) : d));
  function respond(req, res, recordsOnly = false) {
    try {
      const job = ensureJob(req.query.date || yesterday());
      res.set("Cache-Control", "no-store");
      const base = { version: VERSION, instance, date: job.date, status: job.status,
        coverage: job.coverage, progress: job.progress };
      if (job.status !== "complete") return res.json({ ...base, error: job.error,
        note: "Poll this URL until status=complete. Failed/running is NOT a zero-activity report." });
      const coverage = { ...job.coverage };
      if (req.query.audit !== "true") delete coverage.passes;
      const offset = int(req.query.offset, 0, 10000000), limit = Math.max(1, int(req.query.limit, 50, 200));
      const source = recordsOnly ? job.rows : job.chats;
      const page = source.slice(offset, offset + limit);
      const data = recordsOnly ? page.map(m => ({
        id: m.id, jid: m.key.remoteJid, timestamp: timestamp(m),
        direction: m.key.fromMe ? "sent" : "received", text: textOf(m), messageType: m.messageType
      })) : page.map(({ records, ...c }) => ({
        ...c, preview: records.slice(0, 3).map(m => ({ direction: m.key.fromMe ? "sent" : "received", text: textOf(m) })),
        messageIds: req.query.lite === "false" ? records.map(m => m.id) : undefined,
        transcript: req.query.transcript === "true" ? records.map(m => ({
          id: m.id, timestamp: timestamp(m), direction: m.key.fromMe ? "sent" : "received",
          text: textOf(m), messageType: m.messageType
        })) : undefined
      }));
      return res.json({ ...base, coverage, identity: job.identity, window: job.window, summary: job.summary,
        pagination: { offset, limit, total: source.length, returned: page.length,
          nextOffset: offset + page.length < source.length ? offset + page.length : null },
        [recordsOnly ? "messages" : "chats"]: data });
    } catch (e) { res.status(400).json({ version: VERSION, coverage: { complete: false }, error: e.message }); }
  }
  app.get("/insights", (req, res) => respond(req, res));
  app.get("/insights/records", (req, res) => respond(req, res, true));
  app.get("/retrieval-health", (req, res) => res.json({ version: VERSION, pagination: "offset/page",
    verification: "two disjoint-time-window passes plus empty terminal pages", instance }));
  app.get("/search", async (req, res) => {
    try {
      // phone selects a CONTACT, never the connected account.
      const phone = String(req.query.phone || "").replace(/\D/g, "");
      const jid = req.query.jid || (phone ? phone + "@s.whatsapp.net" : "");
      if (typeof jid !== "string" || !jid.includes("@")) throw new Error("Supply a contact phone or exact jid");
      const where = { key: { remoteJid: jid } };
      const b = req.query.date ? dayBounds(req.query.date) : null;
      if (b) where.messageTimestamp = { gte: new Date(b.start * 1000).toISOString(), lte: new Date((b.end - 1) * 1000).toISOString() };
      const data = await verifiedCollect(request, where, b);
      const offset = int(req.query.offset, 0, 10000000), limit = Math.max(1, int(req.query.limit, 200, 1000));
      const rows = data.rows.sort((a, b) => timestamp(a) - timestamp(b) || a.id.localeCompare(b.id));
      res.set("Cache-Control", "no-store");
      res.json({ version: VERSION, instance, scope: "one contact thread, not account-wide history",
        jid, totalMessages: rows.length, coverage: { ...data.coverage, passes: undefined },
        pagination: { offset, limit, returned: rows.slice(offset, offset + limit).length,
          nextOffset: offset + limit < rows.length ? offset + limit : null },
        messages: rows.slice(offset, offset + limit).map(m => ({
          id: m.id, timestamp: timestamp(m), direction: m.key.fromMe ? "SENT" : "RECEIVED", text: textOf(m)
        })) });
    } catch (e) { res.status(502).json({ coverage: { complete: false }, error: e.message }); }
  });
  app.get("/chats", async (req, res) => {
    try {
      // findChats (unlike findMessages) uses take/skip. Fetch its uncapped list,
      // then page the display, using upstream lastMessage rather than 30 extra queries.
      const r = await axios.post(path("/chat/findChats"), {}, options);
      if (!Array.isArray(r.data)) throw new Error("Unexpected chat-list response");
      const list = r.data.map(c => ({
        jid: jidOf(c), name: c.name || c.pushName || jidOf(c),
        kind: category(jidOf(c)), unreadCount: c.unreadCount || 0,
        lastMessageTimestamp: c.lastMessage ? timestamp(c.lastMessage) : null,
        lastMessageText: req.query.preview === "true" && c.lastMessage ? textOf(c.lastMessage) : undefined
      }));
      if (list.some(c => !c.jid)) throw new Error("Chat missing remoteJid; refusing silent exclusion");
      const offset = int(req.query.offset, 0, 10000000), limit = Math.max(1, int(req.query.limit, 50, 200));
      res.set("Cache-Control", "no-store");
      res.json({ version: VERSION, instance, totalChats: list.length,
        note: "Chat list is not a message-coverage audit; use /insights.",
        pagination: { offset, limit, nextOffset: offset + limit < list.length ? offset + limit : null },
        chats: list.slice(offset, offset + limit) });
    } catch (e) { res.status(502).json({ error: "Chat retrieval failed", coverage: { complete: false } }); }
  });
  return { request, verifiedCollect };
}
module.exports = { VERSION, dayBounds, jidOf, textOf, collectPass, verifiedCollect, aggregate, install };
