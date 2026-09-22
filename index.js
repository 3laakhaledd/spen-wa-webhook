const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const retrieval = require("./retrieval");

const app = express();
app.use(express.json({ limit: "10mb" }));
const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID || "901821823676";
const PORT = process.env.PORT || 3000;
const EVO_API_URL = process.env.EVO_API_URL || "https://evolution-api-production-3bf028.up.railway.app";
const EVO_API_KEY = process.env.EVO_API_KEY || "spen-evo-2026-secret";
const EVO_INSTANCE = process.env.EVO_INSTANCE || "spen-whatsapp";
const api = retrieval.install(app, { axios, baseUrl: EVO_API_URL, apiKey: EVO_API_KEY, instance: EVO_INSTANCE });

app.get("/", (req, res) => res.json({
  status: "ok", service: "spen-wa-insights", version: retrieval.VERSION,
  endpoints: {
    insights: "GET /insights?date=YYYY-MM-DD&offset=0&limit=50&audit=true",
    records: "GET /insights/records?date=YYYY-MM-DD&offset=0&limit=200",
    chats: "GET /chats?preview=true&offset=0&limit=50",
    search: "GET /search?phone=CONTACT_NUMBER&offset=0&limit=200",
    health: "GET /retrieval-health",
    run: "GET /run (legacy ClickUp task creation; NOT a read-only report)"
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
async function getExistingTaskPhones() {
  const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
  const { start, end } = retrieval.dayBounds(today);
  const phones = new Set();
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
      if (match) phones.add(match[1]);
    }
    if (r.data.last_page === true || tasks.length === 0) break;
  }
  return phones;
}
async function fetchRecentChats() {
  const end = Math.floor(Date.now() / 1000) + 1;
  const bounds = { start: end - 86400, end };
  const where = { messageTimestamp: { gte: new Date(bounds.start * 1000).toISOString(),
    lte: new Date((end - 1) * 1000).toISOString() } };
  const data = await api.verifiedCollect(api.request, where, bounds);
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
async function createDailyInsights() {
  try {
    const chats = await fetchRecentChats();
    if (!chats.length) return { success: true, tasksCreated: 0, skipped: 0 };
    const existing = await getExistingTaskPhones();
    const date = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" });
    let tasksCreated = 0, skipped = 0, failed = 0;
    for (const c of chats) {
      if (existing.has(c.phone)) { skipped++; continue; }
      try {
        const description = [
          "**Contact:** " + c.contactName, "**Phone:** " + c.phone,
          "**Total Messages:** " + c.messageCount + " (Sent: " + c.sentCount + ", Received: " + c.receivedCount + ")",
          "**Date:** " + date, "",
          "**First Message:** " + (c.firstCustomerTime ? formatTime(c.firstCustomerTime) : "N/A"),
          "**Our First Response:** " + (c.firstResponseTime ? formatTime(c.firstResponseTime) : "No response yet"),
          "**Response Time:** " + (c.responseDelaySec !== null ? formatDuration(c.responseDelaySec) : "N/A"),
          "**Chat Status:** " + c.chatStatus + " (legacy last-direction heuristic, not verified resolution)"
        ].join("\n");
        const r = await axios.post(CLICKUP_API + "/list/" + LIST_ID + "/task",
          { name: c.contactName + " (" + c.phone + ") - " + date, description,
            status: c.chatStatus === "Open" ? "to do" : "complete" },
          { headers: { Authorization: CLICKUP_TOKEN }, timeout: 30000 });
        tasksCreated++; existing.add(c.phone);
        await axios.post(CLICKUP_API + "/task/" + r.data.id + "/comment",
          { comment_text: "**Chat Log:**\n" + c.conversationLog },
          { headers: { Authorization: CLICKUP_TOKEN }, timeout: 30000 });
        await new Promise(r => setTimeout(r, 600));
      } catch (e) { failed++; }
    }
    return { success: failed === 0, tasksCreated, skipped, failed, totalChats: chats.length };
  } catch (e) { return { success: false, error: "Daily insights retrieval failed; no complete report available" }; }
}
cron.schedule("0 5 * * *", () => { createDailyInsights(); }, { timezone: "Asia/Riyadh" });
app.get("/run", async (req, res) => res.json(await createDailyInsights()));
app.listen(PORT, () => console.log("SPEN WA Insights " + retrieval.VERSION + " on port " + PORT));
