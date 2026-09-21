const express = require("express");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json({ limit: '10mb' }));

const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID || "901821823676";
const PORT = process.env.PORT || 3000;

const EVO_API_URL = process.env.EVO_API_URL || "https://evolution-api-production-3bf028.up.railway.app";
const EVO_API_KEY = process.env.EVO_API_KEY || "spen-evo-2026-secret";
const EVO_INSTANCE = process.env.EVO_INSTANCE || "spen-whatsapp";

const LOOKBACK_MS = 24 * 60 * 60 * 1000;

app.get("/", (req, res) => res.json({
  status: "ok",
  service: "spen-wa-insights",
  endpoints: {
    run: "GET /run",
    search: "GET /search?phone=XXXXX&limit=100",
    chats: "GET /chats?preview=true&limit=20",
    insights: "GET /insights?date=YYYY-MM-DD&lite=true",
  },
}));

function getMsgTimestamp(m) {
  if (!m.messageTimestamp) return 0;
  return typeof m.messageTimestamp === "object" ? m.messageTimestamp.low : Number(m.messageTimestamp);
}

function formatTime(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Riyadh" });
}

function formatDate(epochSec) {
  return new Date(epochSec * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Riyadh" });
}

function formatDateTime(epochSec) {
  return new Date(epochSec * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Riyadh" });
}

function formatDuration(seconds) {
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
}

function getTodayDateStr() { return new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" }); }

function getMessageText(m) {
  return m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || m.message?.documentMessage?.title || "[media]";
}

async function processBatches(items, concurrency, handler) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(handler));
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
  }
  return results;
}

// =============================================
// INSIGHTS: Scan ALL chats for a specific date
// ?lite=true  -> fast mode (20 concurrent, no logs, limit 50 msgs)
// ?lite=false -> full mode (10 concurrent, with logs, limit 500 msgs)
// =============================================
app.get("/insights", async (req, res) => {
  try {
    const lite = req.query.lite !== "false";
    const concurrency = lite ? 20 : 10;
    const msgLimit = lite ? 50 : 500;
    const riyadhOffset = 3 * 60 * 60 * 1000;
    let targetStart, targetEnd, dateLabel;

    if (req.query.date) {
      const parts = req.query.date.split("-");
      const d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
      targetStart = d.getTime() - riyadhOffset;
      targetEnd = targetStart + 86400000;
      dateLabel = req.query.date;
    } else {
      const nowUtc = Date.now();
      const riyadhNow = new Date(nowUtc + riyadhOffset);
      riyadhNow.setUTCHours(0, 0, 0, 0);
      const todayMs = riyadhNow.getTime() - riyadhOffset;
      targetStart = todayMs - 86400000;
      targetEnd = todayMs;
      const d = new Date(targetStart + riyadhOffset);
      dateLabel = d.toISOString().split("T")[0];
    }

    console.log("Insights " + (lite ? "LITE" : "FULL") + " scan for " + dateLabel + " (" + concurrency + " concurrent)");

    const chatsRes = await axios.post(
      EVO_API_URL + "/chat/findChats/" + EVO_INSTANCE,
      {},
      { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
    );

    const allChats = chatsRes.data || [];
    const individualChats = allChats.filter((c) => {
      const jid = c.id || c.remoteJid || "";
      return jid.includes("@s.whatsapp.net") && !jid.startsWith("status");
    });

    console.log("Scanning " + individualChats.length + " chats...");
    let scanned = 0;

    const activeChats = await processBatches(individualChats, concurrency, async (chat) => {
      const jid = chat.id || chat.remoteJid;
      const phone = jid.replace("@s.whatsapp.net", "");
      const contactName = chat.name || chat.pushName || phone;

      try {
        const msgsRes = await axios.post(
          EVO_API_URL + "/chat/findMessages/" + EVO_INSTANCE,
          { where: { key: { remoteJid: jid } }, limit: msgLimit },
          { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
        );

        const allMessages = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];
        const dayMessages = allMessages.filter((m) => {
          const msgTime = getMsgTimestamp(m) * 1000;
          return msgTime >= targetStart && msgTime < targetEnd;
        });

        scanned++;
        if (scanned % 100 === 0) console.log("Scanned " + scanned + "/" + individualChats.length);
        if (dayMessages.length === 0) return null;

        dayMessages.sort((a, b) => getMsgTimestamp(a) - getMsgTimestamp(b));
        const sentCount = dayMessages.filter((m) => m.key?.fromMe).length;
        const firstMsg = dayMessages[0];
        const lastMsg = dayMessages[dayMessages.length - 1];

        const result = {
          phone,
          contactName,
          messageCount: dayMessages.length,
          sent: sentCount,
          received: dayMessages.length - sentCount,
          initiatedBy: firstMsg.key?.fromMe ? "us" : "customer",
          chatStatus: lastMsg.key?.fromMe ? "Closed" : "Open",
          firstMessageTime: formatTime(getMsgTimestamp(firstMsg)),
          lastMessageTime: formatTime(getMsgTimestamp(lastMsg)),
        };

        if (!lite) {
          result.conversationLog = dayMessages.map((m) => {
            const dir = m.key?.fromMe ? "SENT" : "RECEIVED";
            return "[" + formatTime(getMsgTimestamp(m)) + "] " + dir + ": " + getMessageText(m);
          }).join("\n");
        } else {
          // In lite mode, include first few message texts as preview
          result.preview = dayMessages.slice(0, 5).map((m) => {
            const dir = m.key?.fromMe ? "SENT" : "RECEIVED";
            return dir + ": " + getMessageText(m);
          });
        }

        return result;
      } catch (err) {
        scanned++;
        return null;
      }
    });

    activeChats.sort((a, b) => b.messageCount - a.messageCount);
    console.log("Done: " + activeChats.length + " active chats on " + dateLabel);

    res.json({
      date: dateLabel,
      mode: lite ? "lite" : "full",
      totalScanned: individualChats.length,
      activeChats: activeChats.length,
      totalMessages: activeChats.reduce((sum, c) => sum + c.messageCount, 0),
      chats: activeChats,
    });
  } catch (err) {
    console.error("Insights error:", err.response?.status, err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get("/chats", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const preview = req.query.preview === "true";
    const chatsRes = await axios.post(EVO_API_URL + "/chat/findChats/" + EVO_INSTANCE, {}, { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } });
    const allChats = chatsRes.data || [];
    const individualChats = allChats.filter((c) => { const jid = c.id || c.remoteJid || ""; return jid.includes("@s.whatsapp.net") && !jid.startsWith("status"); });
    const groupChats = allChats.filter((c) => { const jid = c.id || c.remoteJid || ""; return jid.includes("@g.us"); });
    let chatList = individualChats.map((c) => { const jid = c.id || c.remoteJid || ""; return { phone: jid.replace("@s.whatsapp.net", ""), name: c.name || c.pushName || jid.replace("@s.whatsapp.net", ""), unreadCount: c.unreadCount || 0 }; });
    if (preview) {
      const enrichLimit = Math.min(limit, 30);
      for (let i = 0; i < Math.min(chatList.length, enrichLimit); i++) {
        const chat = chatList[i];
        try {
          const msgsRes = await axios.post(EVO_API_URL + "/chat/findMessages/" + EVO_INSTANCE, { where: { key: { remoteJid: chat.phone + "@s.whatsapp.net" } }, limit: 5 }, { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } });
          const msgs = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];
          if (msgs.length > 0) { msgs.sort((a, b) => getMsgTimestamp(b) - getMsgTimestamp(a)); const last = msgs[0]; const ts = getMsgTimestamp(last); chat.lastMessageTime = formatDateTime(ts); chat.lastMessageTimestamp = ts; chat.lastMessageFrom = last.key?.fromMe ? "You" : chat.name; chat.lastMessageText = getMessageText(last); }
        } catch (e) { chat.lastMessageText = "[error]"; }
      }
      chatList.sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));
    }
    chatList = chatList.slice(0, limit);
    res.json({ totalChats: allChats.length, individualChats: individualChats.length, groupChats: groupChats.length, returned: chatList.length, chats: chatList });
  } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
});

app.get("/search", async (req, res) => {
  try {
    const phone = req.query.phone;
    const limit = parseInt(req.query.limit) || 200;
    if (!phone) return res.status(400).json({ error: "Missing ?phone= parameter" });
    const jid = phone + "@s.whatsapp.net";
    const msgsRes = await axios.post(EVO_API_URL + "/chat/findMessages/" + EVO_INSTANCE, { where: { key: { remoteJid: jid } }, limit: limit }, { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } });
    const allMessages = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];
    if (allMessages.length === 0) return res.json({ phone, totalMessages: 0, note: "No messages found.", messages: [] });
    allMessages.sort((a, b) => getMsgTimestamp(a) - getMsgTimestamp(b));
    const contactName = allMessages.find((m) => m.pushName)?.pushName || phone;
    const formatted = allMessages.map((m) => { const ts = getMsgTimestamp(m); const isFromMe = m.key?.fromMe || false; return { time: formatDateTime(ts), timestamp: ts, direction: isFromMe ? "SENT" : "RECEIVED", sender: isFromMe ? "You" : contactName, text: getMessageText(m) }; });
    const sentCount = formatted.filter((m) => m.direction === "SENT").length;
    const byDate = {};
    for (const msg of formatted) { const date = formatDate(msg.timestamp); if (!byDate[date]) byDate[date] = []; byDate[date].push("[" + (msg.time.split(",")[1]?.trim() || msg.time) + "] " + msg.direction + ": " + msg.text); }
    res.json({ phone, contactName, totalMessages: formatted.length, sent: sentCount, received: formatted.length - sentCount, firstMessage: formatted[0]?.time || "N/A", lastMessage: formatted[formatted.length - 1]?.time || "N/A", byDate, messages: formatted });
  } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
});

async function getExistingTaskPhones() {
  const today = new Date(); const riyadhOffset = 3 * 60 * 60 * 1000; const nowUtc = today.getTime(); const riyadhNow = new Date(nowUtc + riyadhOffset); riyadhNow.setUTCHours(0, 0, 0, 0); const todayMs = riyadhNow.getTime() - riyadhOffset; const tomorrowMs = todayMs + 86400000;
  try { const res = await axios.get(CLICKUP_API + "/list/" + LIST_ID + "/task", { headers: { Authorization: CLICKUP_TOKEN }, params: { order_by: "created", reverse: true, date_created_gt: todayMs, date_created_lt: tomorrowMs, include_closed: true } }); const phones = new Set(); for (const task of (res.data.tasks || [])) { const match = task.name.match(/\((\d+)\)/); if (match) phones.add(match[1]); } return phones; } catch (err) { return new Set(); }
}

async function fetchRecentChats() {
  const now = Date.now(); const since = now - LOOKBACK_MS;
  const chatsRes = await axios.post(EVO_API_URL + "/chat/findChats/" + EVO_INSTANCE, {}, { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } });
  const allChats = chatsRes.data || [];
  const individualChats = allChats.filter((c) => { const jid = c.id || c.remoteJid || ""; return jid.includes("@s.whatsapp.net") && !jid.startsWith("status"); });
  const activeChats = [];
  for (const chat of individualChats) {
    const jid = chat.id || chat.remoteJid; const phone = jid.replace("@s.whatsapp.net", ""); const contactName = chat.name || chat.pushName || phone;
    try {
      const msgsRes = await axios.post(EVO_API_URL + "/chat/findMessages/" + EVO_INSTANCE, { where: { key: { remoteJid: jid } }, limit: 500 }, { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } });
      const allMessages = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];
      const recentMessages = allMessages.filter((m) => { const msgTime = getMsgTimestamp(m) * 1000; return msgTime >= since; });
      if (recentMessages.length === 0) continue;
      recentMessages.sort((a, b) => getMsgTimestamp(a) - getMsgTimestamp(b));
      const firstCustomerMsg = recentMessages.find((m) => !m.key?.fromMe); const firstCustomerTime = firstCustomerMsg ? getMsgTimestamp(firstCustomerMsg) : 0;
      let firstResponseTime = 0; let responseDelaySec = null;
      if (firstCustomerTime > 0) { const firstResponse = recentMessages.find((m) => m.key?.fromMe && getMsgTimestamp(m) > firstCustomerTime); if (firstResponse) { firstResponseTime = getMsgTimestamp(firstResponse); responseDelaySec = firstResponseTime - firstCustomerTime; } }
      const lastMessage = recentMessages[recentMessages.length - 1]; const chatStatus = lastMessage?.key?.fromMe ? "Closed" : "Open";
      const formattedMessages = recentMessages.map((m) => { const dir = m.key?.fromMe ? "SENT" : "RECEIVED"; return "[" + formatTime(getMsgTimestamp(m)) + "] " + dir + ": " + getMessageText(m); });
      const sentCount = recentMessages.filter((m) => m.key?.fromMe).length;
      activeChats.push({ phone, contactName, messageCount: recentMessages.length, sentCount, receivedCount: recentMessages.length - sentCount, conversationLog: formattedMessages.join("\n"), firstCustomerTime, firstResponseTime, responseDelaySec, chatStatus });
    } catch (err) { console.error("Error fetching messages for " + phone); }
  }
  return activeChats;
}

async function createDailyInsights() {
  console.log("Starting WhatsApp Insights report...");
  try {
    const chats = await fetchRecentChats();
    if (chats.length === 0) return { success: true, tasksCreated: 0, skipped: 0 };
    const existingPhones = await getExistingTaskPhones(); const dateStr = getTodayDateStr(); let tasksCreated = 0; let skipped = 0;
    for (const chat of chats) {
      if (existingPhones.has(chat.phone)) { skipped++; continue; }
      try {
        const descLines = ["**Contact:** " + chat.contactName, "**Phone:** " + chat.phone, "**Total Messages:** " + chat.messageCount + " (Sent: " + chat.sentCount + ", Received: " + chat.receivedCount + ")", "**Date:** " + dateStr, "", "**First Message:** " + (chat.firstCustomerTime ? formatTime(chat.firstCustomerTime) : "N/A"), "**Our First Response:** " + (chat.firstResponseTime ? formatTime(chat.firstResponseTime) : "No response yet"), "**Response Time:** " + (chat.responseDelaySec !== null ? formatDuration(chat.responseDelaySec) : "N/A"), "", "**Chat Status:** " + (chat.chatStatus === "Open" ? "\ud83d\udd34 Open" : "\ud83d\udfe2 Closed")];
        const taskRes = await axios.post(CLICKUP_API + "/list/" + LIST_ID + "/task", { name: chat.contactName + " (" + chat.phone + ") - " + dateStr, description: descLines.join("\n"), status: chat.chatStatus === "Open" ? "to do" : "complete" }, { headers: { Authorization: CLICKUP_TOKEN } });
        await axios.post(CLICKUP_API + "/task/" + taskRes.data.id + "/comment", { comment_text: "**Chat Log:**\n" + chat.conversationLog }, { headers: { Authorization: CLICKUP_TOKEN } });
        tasksCreated++; await new Promise((r) => setTimeout(r, 600));
      } catch (err) { console.error("Failed to create task for " + chat.phone); }
    }
    return { success: true, tasksCreated, skipped, totalChats: chats.length };
  } catch (err) { return { success: false, error: err.message }; }
}

cron.schedule("0 5 * * *", () => { createDailyInsights(); }, { timezone: "Asia/Riyadh" });

app.get("/run", async (req, res) => { const result = await createDailyInsights(); res.json(result); });

app.listen(PORT, () => {
  console.log("SPEN WA Insights running on port " + PORT);
  console.log("Endpoints: / /run /chats /insights /search");
});
