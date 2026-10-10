const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const retrieval = require("./retrieval");
const linesLib = require("./lines");

const app = express();
app.use(express.json({ limit: "10mb" }));
const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID || "901821823676";
const PORT = process.env.PORT || 3000;
const EVO_API_URL = process.env.EVO_API_URL || "https://evolution-api-production-3bf028.up.railway.app";
const EVO_API_KEY = process.env.EVO_API_KEY || "spen-evo-2026-secret";
const EVO_INSTANCE = process.env.EVO_INSTANCE || "spen-whatsapp";
// Up to 3 connected numbers by default: EVO_INSTANCES="spen-whatsapp,spen-whatsapp-2,spen-whatsapp-3".
const LINES = linesLib.parseLines(process.env.EVO_INSTANCES, EVO_INSTANCE);
const PRIMARY = LINES[0];
const evoOpts = { axios, baseUrl: EVO_API_URL, apiKey: EVO_API_KEY };

// Legacy root routes keep reading line 1 exactly as before.
const api = retrieval.install(app, { ...evoOpts, instance: PRIMARY });
// Every line also gets its own copy of the read routes under /line/N/... (e.g. /line/2/insights).
const apis = new Map();
LINES.forEach((name, i) => {
  const router = express.Router();
  apis.set(name, i === 0 ? api : retrieval.install(router, { ...evoOpts, instance: name }));
  if (i > 0) app.use("/line/" + (i + 1), router);
});
app.use("/line/1", (req, res) => res.redirect(307, req.originalUrl.replace(/^\/line\/1/, "") || "/"));
const lines = linesLib.create({ ...evoOpts, lines: LINES, connectKey: process.env.CONNECT_KEY || "" });
lines.install(app);
require("./report").install(app, name => apis.get(name), LINES, instance => fetchGroups(instance));
// ?line=2 or ?instance=spen-whatsapp-2 selects a number; default is line 1.
function pickInstance(req) {
  const n = Number(req.query.line);
  if (Number.isInteger(n) && n >= 1 && n <= LINES.length) return LINES[n - 1];
  if (req.query.instance && LINES.includes(String(req.query.instance))) return String(req.query.instance);
  if (req.query.line || req.query.instance) throw Object.assign(new Error("Unknown line; use 1-" + LINES.length), { client: true });
  return PRIMARY;
}

app.get("/", (req, res) => res.json({
  status: "ok", service: "spen-wa-insights", version: retrieval.VERSION,
  lines: LINES.map((name, i) => ({ line: i + 1, instance: name })),
  endpoints: {
    weekReport: "GET /report/week?from=YYYY-MM-DD&to=YYYY-MM-DD&days=0,1,2,3,4&line=N (individual customer chats, compact)",
    connect: "GET /connect (QR / pairing codes for every line)",
    lines: "GET /lines (connection status of every line)",
    insights: "GET /insights?date=YYYY-MM-DD&offset=0&limit=50&audit=true (line 1; /line/N/insights for others)",
    records: "GET /insights/records?date=YYYY-MM-DD&offset=0&limit=200",
    chats: "GET /chats?preview=true&offset=0&limit=50",
    search: "GET /search?phone=CONTACT_NUMBER&offset=0&limit=200",
    groups: "GET /groups?name=Grade&line=N (member counts only)",
    groupMembers: "GET /groups/members?name=Grade 5&line=N (counts here; numbers go to the private ClickUp WhatsApp list)",
    health: "GET /retrieval-health",
    run: "GET /run (legacy ClickUp task creation for all connected lines; NOT a read-only report)"
  }
}));

// Preserve the existing 05:00 Riyadh cron and legacy /run integration.
// Report routes above NEVER invoke this task/comment-writing workflow.
const formatTime = sec => new Date(sec * 1000).toLocaleTimeString("en-GB",
  { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Riyadh" });
const stamp = m => Number(typeof m.messageTimestamp === "object" ? m.messageTimestamp.low : m.messageTimestamp);
function formatDuration(sec) {
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
  return Math.floor(sec / 3600) + "h " + Math.floor(sec % 3600 / 60) + "m";
}
const lineTag = name => LINES.indexOf(name) > 0 ? " [Line " + (LINES.indexOf(name) + 1) + "]" : "";
// Dedupe key is phone + line, so the same contact on two numbers gets one task per number.
async function getExistingTaskKeys() {
  const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
  const { start, end } = retrieval.dayBounds(today);
  const keys = new Set();
  for (let page = 0; ; page++) {
    const r = await axios.get(CLICKUP_API + "/list/" + LIST_ID + "/task", {
      headers: { Authorization: CLICKUP_TOKEN }, timeout: 30000,
      params: { page, order_by: "created", reverse: true, date_created_gt: start * 1000,
        date_created_lt: end * 1000, include_closed: true }
    });
    const tasks = r.data.tasks;
    if (!Array.isArray(tasks)) throw new Error("Cannot verify existing tasks");
    for (const task of tasks) {
      const match = task.name.match(/\(([^)]+)\)/);
      const line = task.name.match(/\[Line (\d+)\]\s*$/);
      if (match) keys.add(match[1] + "|" + (line ? line[1] : "1"));
    }
    if (r.data.last_page === true || tasks.length === 0) break;
  }
  return keys;
}
async function fetchRecentChats(lineApi) {
  const end = Math.floor(Date.now() / 1000) + 1;
  const bounds = { start: end - 86400, end };
  const where = { messageTimestamp: { gte: new Date(bounds.start * 1000).toISOString(),
    lte: new Date((end - 1) * 1000).toISOString() } };
  const data = await lineApi.verifiedCollect(lineApi.request, where, bounds);
  return retrieval.aggregate(data.rows).chats
    .filter(c => c.kind === "individual_phone" || c.kind === "individual_lid")
    .map(c => {
      const firstCustomer = c.records.find(m => !m.key.fromMe);
      const firstCustomerTime = firstCustomer ? stamp(firstCustomer) : 0;
      const firstResponse = firstCustomer && c.records.find(m => m.key.fromMe && stamp(m) > firstCustomerTime);
      const firstResponseTime = firstResponse ? stamp(firstResponse) : 0;
      return {
        phone: c.kind === "individual_phone" ? c.jid.replace("@s.whatsapp.net", "") : c.jid,
        contactName: c.contactName, messageCount: c.messageCount, sentCount: c.sent, receivedCount: c.received,
        firstCustomerTime, firstResponseTime,
        responseDelaySec: firstResponse ? firstResponseTime - firstCustomerTime : null,
        chatStatus: c.endsWithInbound ? "Open" : "Closed",
        conversationLog: c.records.map(m => "[" + formatTime(stamp(m)) + "] " +
          (m.key.fromMe ? "SENT: " : "RECEIVED: ") + retrieval.textOf(m)).join("\n")
      };
    });
}
async function createLineInsights(name, existing, date) {
  const chats = await fetchRecentChats(apis.get(name));
  const lineNo = String(LINES.indexOf(name) + 1);
  let tasksCreated = 0, skipped = 0, failed = 0;
  for (const c of chats) {
    const key = c.phone + "|" + lineNo;
    if (existing.has(key)) { skipped++; continue; }
    try {
      const description = [
        "**Line:** " + lineNo + " (" + name + ")",
        "**Contact:** " + c.contactName, "**Phone:** " + c.phone,
        "**Total Messages:** " + c.messageCount + " (Sent: " + c.sentCount + ", Received: " + c.receivedCount + ")",
        "**Date:** " + date, "",
        "**First Message:** " + (c.firstCustomerTime ? formatTime(c.firstCustomerTime) : "N/A"),
        "**Our First Response:** " + (c.firstResponseTime ? formatTime(c.firstResponseTime) : "No response yet"),
        "**Response Time:** " + (c.responseDelaySec !== null ? formatDuration(c.responseDelaySec) : "N/A"),
        "**Chat Status:** " + c.chatStatus + " (legacy last-direction heuristic, not verified resolution)"
      ].join("\n");
      const r = await axios.post(CLICKUP_API + "/list/" + LIST_ID + "/task",
        { name: c.contactName + " (" + c.phone + ") - " + date + lineTag(name), description,
          status: c.chatStatus === "Open" ? "to do" : "complete" },
        { headers: { Authorization: CLICKUP_TOKEN }, timeout: 30000 });
      tasksCreated++; existing.add(key);
      await axios.post(CLICKUP_API + "/task/" + r.data.id + "/comment",
        { comment_text: "**Chat Log:**\n" + c.conversationLog },
        { headers: { Authorization: CLICKUP_TOKEN }, timeout: 30000 });
      await new Promise(r => setTimeout(r, 600));
    } catch (e) { failed++; }
  }
  return { line: Number(lineNo), instance: name, success: failed === 0, tasksCreated, skipped, failed, totalChats: chats.length };
}
async function createDailyInsights() {
  let status;
  try { status = await lines.status(); } catch (e) { status = LINES.map((n, i) => ({ instance: n, connected: i === 0 })); }
  const connected = status.filter(s => s.connected).map(s => s.instance);
  const date = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" });
  let existing;
  try { existing = await getExistingTaskKeys(); }
  catch (e) { return { success: false, error: "Could not read existing ClickUp tasks (check CLICKUP_API_TOKEN)" }; }
  const results = [];
  for (const name of connected) {
    try { results.push(await createLineInsights(name, existing, date)); }
    catch (e) { results.push({ instance: name, success: false, error: "Daily insights retrieval failed; no complete report available" }); }
  }
  const sum = k => results.reduce((a, r) => a + (r[k] || 0), 0);
  return { success: results.every(r => r.success), tasksCreated: sum("tasksCreated"), skipped: sum("skipped"),
    failed: sum("failed"), totalChats: sum("totalChats"),
    skippedLines: status.filter(s => !s.connected).map(s => s.instance), lines: results };
}
cron.schedule("0 5 * * *", () => { createDailyInsights(); }, { timezone: "Asia/Riyadh" });
app.get("/run", async (req, res) => res.json(await createDailyInsights()));

async function fetchGroups(instance) {
  const r = await axios.get(EVO_API_URL.replace(/\/$/, "") + "/group/fetchAllGroups/" + encodeURIComponent(instance),
    { headers: { apikey: EVO_API_KEY }, params: { getParticipants: "true" }, timeout: 120000 });
  if (!Array.isArray(r.data)) throw new Error("Unexpected group-list response");
  return r.data;
}
// Read-only group roster counts. This service is public, so participant numbers are NEVER returned.
app.get("/groups", async (req, res) => {
  try {
    const instance = pickInstance(req);
    const data = await fetchGroups(instance);
    const q = String(req.query.name || "").toLowerCase().replace(/\s+/g, "");
    const groups = data.map(g => {
      const parts = Array.isArray(g.participants) ? g.participants : null;
      return {
        jid: g.id, name: g.subject || g.id,
        participants: parts ? parts.length : (Number.isInteger(g.size) ? g.size : null),
        admins: parts ? parts.filter(p => p.admin === "admin" || p.admin === "superadmin").length : null,
        reportedSize: Number.isInteger(g.size) ? g.size : null,
        source: parts ? "participant list" : "size field"
      };
    }).filter(g => !q || String(g.name).toLowerCase().replace(/\s+/g, "").includes(q))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    res.set("Cache-Control", "no-store");
    res.json({ instance, line: LINES.indexOf(instance) + 1, totalGroups: groups.length,
      note: "Counts only; participant numbers are never returned. Counts include the connected account itself.",
      groups });
  } catch (e) {
    res.status(e.client ? 400 : 502).json({ error: e.client ? e.message :
      "Group retrieval failed" + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") });
  }
});

// Member numbers are PII: never returned over this public URL. They are posted as a
// task in the private ClickUp WhatsApp list instead; the HTTP response carries counts only.
const MEMBERS_LIST_ID = process.env.MEMBERS_LIST_ID || LIST_ID;
const memberNumber = p => {
  const pick = [p.phoneNumber, p.jid, p.id].find(v => typeof v === "string" && v.endsWith("@s.whatsapp.net"));
  return pick ? "+" + pick.split("@")[0].split(":")[0] : null;
};
app.get("/groups/members", async (req, res) => {
  try {
    const instance = pickInstance(req);
    const q = String(req.query.name || "").toLowerCase().replace(/\s+/g, "");
    if (q.length < 2) throw Object.assign(new Error("Supply ?name= (at least 2 characters)"), { client: true });
    const data = await fetchGroups(instance);
    const groups = data.filter(g => String(g.subject || "").toLowerCase().replace(/\s+/g, "").includes(q))
      .sort((a, b) => String(a.subject).localeCompare(String(b.subject), undefined, { numeric: true }));
    if (groups.length > 15) throw Object.assign(new Error("Too many groups match (" + groups.length + "); narrow ?name="), { client: true });
    const summary = [];
    for (const g of groups) {
      const parts = Array.isArray(g.participants) ? g.participants : [];
      const rows = parts.map(p => ({ number: memberNumber(p), lid: String(p.id || "").endsWith("@lid") ? p.id : null,
        admin: p.admin === "admin" || p.admin === "superadmin" }));
      const withNumber = rows.filter(x => x.number);
      const lines = rows.map((x, i) => (i + 1) + ". " + (x.number || ("hidden number (" + x.lid + ")")) + (x.admin ? " [admin]" : ""));
      const body = "Line: " + (LINES.indexOf(instance) + 1) + " (" + instance + ")\nTotal members: " + rows.length +
        " | with visible number: " + withNumber.length +
        "\nPulled: " + new Date().toISOString() + "\n\n" + lines.join("\n");
      try {
        // Private ClickUp list the service already writes to (same token as the daily run).
        await axios.post(CLICKUP_API + "/list/" + MEMBERS_LIST_ID + "/task",
          { name: "WA group members: " + (g.subject || g.id) + " (" + new Date().toISOString().slice(0, 10) + ")" + lineTag(instance),
            description: body },
          { headers: { Authorization: CLICKUP_TOKEN }, timeout: 30000 });
      } catch (e) {
        throw Object.assign(new Error("ClickUp write failed" + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") +
          (CLICKUP_TOKEN ? "" : " - CLICKUP_API_TOKEN not set")), { client: false, safe: true });
      }
      summary.push({ name: g.subject || g.id, members: rows.length, withVisibleNumber: withNumber.length,
        hiddenLidOnly: rows.length - withNumber.length });
      await new Promise(r => setTimeout(r, 600));
    }
    res.set("Cache-Control", "no-store");
    res.json({ instance, line: LINES.indexOf(instance) + 1, matchedGroups: summary.length,
      note: "Numbers saved as tasks in the private ClickUp WhatsApp list; not returned here.", groups: summary });
  } catch (e) {
    res.status(e.client ? 400 : e.safe ? 200 : 502).json({ ok: false, error: (e.client || e.safe) ? e.message :
      "Member export failed" + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") });
  }
});

app.listen(PORT, () => console.log("SPEN WA Insights " + retrieval.VERSION + " on port " + PORT + " lines: " + LINES.join(", ")));
