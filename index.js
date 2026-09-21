const express = require("express");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json({ limit: '10mb' }));

const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID || "901821823676";
const PORT = process.env.PORT || 3000;

// Evolution API config
const EVO_API_URL = process.env.EVO_API_URL || "https://evolution-api-production-3bf028.up.railway.app";
const EVO_API_KEY = process.env.EVO_API_KEY || "spen-evo-2026-secret";
const EVO_INSTANCE = process.env.EVO_INSTANCE || "spen-whatsapp";

// 24h lookback window
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Health check
app.get("/", (req, res) => res.json({
  status: "ok",
  service: "spen-wa-insights",
  nextRun: "Daily at 8:00 AM (Asia/Riyadh)",
  lookbackHours: 24,
  hasToken: !!CLICKUP_TOKEN,
  endpoints: {
    run: "GET /run - manual daily report",
    search: "GET /search?phone=XXXXX&limit=100 - search WhatsApp chat history",
    chats: "GET /chats?preview=true&limit=20 - list all chats with optional last-message preview",
    insights: "GET /insights?date=YYYY-MM-DD - scan ALL chats for a date (defaults to yesterday)",
  },
}));

// =============================================
// HELPERS
// =============================================
function getMsgTimestamp(m) {
  if (!m.messageTimestamp) return 0;
  return typeof m.messageTimestamp === "object" ? m.messageTimestamp.low : Number(m.messageTimestamp);
}

function formatTime(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Riyadh"
  });
}

function formatDate(epochSec) {
  return new Date(epochSec * 1000).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Riyadh"
  });
}

function formatDateTime(epochSec) {
  return new Date(epochSec * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Riyadh"
  });
}

function formatDuration(seconds) {
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h + "h " + m + "m";
}

function getTodayDateStr() {
  return new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" });
}

function getMessageText(m) {
  return m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    m.message?.documentMessage?.title ||
    "[media]";
}

// =============================================
// INSIGHTS: Scan ALL chats for a specific date
// =============================================
app.get("/insights", async (req, res) => {
  try {
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

    console.log("Insights scan for " + dateLabel);

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

    console.log("Scanning " + individualChats.length + " chats for " + dateLabel + "...");

    const activeChats = [];
    let scanned = 0;

    for (const chat of individualChats) {
      const jid = chat.id || chat.remoteJid;
      const phone = jid.replace("@s.whatsapp.net", "");
      const contactName = chat.name || chat.pushName || phone;

      try {
        const msgsRes = await axios.post(
          EVO_API_URL + "/chat/findMessages/" + EVO_INSTANCE,
          {
            where: { key: { remoteJid: jid } },
            limit: 500,
          },
          { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
        );

        const allMessages = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];

        const dayMessages = allMessages.filter((m) => {
          const msgTime = getMsgTimestamp(m) * 1000;
          return msgTime >= targetStart && msgTime < targetEnd;
        });

        if (dayMessages.length === 0) {
          scanned++;
          if (scanned % 50 === 0) console.log("Scanned " + scanned + "/" + individualChats.length + "...");
          continue;
        }

        dayMessages.sort((a, b) => getMsgTimestamp(a) - getMsgTimestamp(b));

        const sentCount = dayMessages.filter((m) => m.key?.fromMe).length;
        const receivedCount = dayMessages.length - sentCount;

        const firstMsg = dayMessages[0];
        const initiatedBy = firstMsg.key?.fromMe ? "us" : "customer";

        const lastMsg = dayMessages[dayMessages.length - 1];
        const chatStatus = lastMsg.key?.fromMe ? "Closed" : "Open";

        const conversationLog = dayMessages.map((m) => {
          const isFromMe = m.key?.fromMe || false;
          const direction = isFromMe ? "SENT" : "RECEIVED";
          const ts = getMsgTimestamp(m);
          const time = formatTime(ts);
          return "[" + time + "] " + direction + ": " + getMessageText(m);
        }).join("\n");

        activeChats.push({
          phone,
          contactName,
          messageCount: dayMessages.length,
          sent: sentCount,
          received: receivedCount,
          initiatedBy,
          chatStatus,
          firstMessageTime: formatTime(getMsgTimestamp(firstMsg)),
          lastMessageTime: formatTime(getMsgTimestamp(lastMsg)),
          conversationLog,
        });

        scanned++;
        if (scanned % 50 === 0) console.log("Scanned " + scanned + "/" + individualChats.length + "...");
      } catch (err) {
        scanned++;
        console.error("Error scanning " + phone + ":", err.response?.status || err.message);
      }
    }

    activeChats.sort((a, b) => b.messageCount - a.messageCount);

    console.log("Insights done: " + activeChats.length + " active chats on " + dateLabel);

    res.json({
      date: dateLabel,
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

// =============================================
// CHATS: List all WhatsApp chats with summary
// =============================================
app.get("/chats", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const preview = req.query.preview === "true";

    console.log("Listing chats (limit: " + limit + ", preview: " + preview + ")...");

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

    const groupChats = allChats.filter((c) => {
      const jid = c.id || c.remoteJid || "";
      return jid.includes("@g.us");
    });

    let chatList = individualChats.map((c) => {
      const jid = c.id || c.remoteJid || "";
      const phone = jid.replace("@s.whatsapp.net", "");
      return {
        phone,
        name: c.name || c.pushName || phone,
        unreadCount: c.unreadCount || 0,
      };
    });

    if (preview) {
      const enrichLimit = Math.min(limit, 30);
      for (let i = 0; i < Math.min(chatList.length, enrichLimit); i++) {
        const chat = chatList[i];
        try {
          const msgsRes = await axios.post(
            EVO_API_URL + "/chat/findMessages/" + EVO_INSTANCE,
            {
              where: { key: { remoteJid: chat.phone + "@s.whatsapp.net" } },
              limit: 5,
            },
            { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
          );

          const msgs = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];

          if (msgs.length > 0) {
            msgs.sort((a, b) => getMsgTimestamp(b) - getMsgTimestamp(a));
            const last = msgs[0];
            const ts = getMsgTimestamp(last);
            chat.lastMessageTime = formatDateTime(ts);
            chat.lastMessageTimestamp = ts;
            chat.lastMessageFrom = last.key?.fromMe ? "You" : chat.name;
            chat.lastMessageText = getMessageText(last);
          }
        } catch (e) {
          chat.lastMessageText = "[error fetching preview]";
        }
      }

      chatList.sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));
    }

    chatList = chatList.slice(0, limit);

    res.json({
      totalChats: allChats.length,
      individualChats: individualChats.length,
      groupChats: groupChats.length,
      returned: chatList.length,
      chats: chatList,
    });

    console.log("Chats listed: " + chatList.length + " of " + individualChats.length + " individual chats");
  } catch (err) {
    console.error("Chats error:", err.response?.status, err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// =============================================
// SEARCH: Query WhatsApp chat history by phone
// =============================================
app.get("/search", async (req, res) => {
  try {
    const phone = req.query.phone;
    const limit = parseInt(req.query.limit) || 200;

    if (!phone) {
      return res.status(400).json({ error: "Missing ?phone= parameter. Usage: /search?phone=966548692404&limit=100" });
    }

    console.log("Searching WhatsApp history for " + phone + " (limit: " + limit + ")...");

    const jid = phone + "@s.whatsapp.net";

    const msgsRes = await axios.post(
      EVO_API_URL + "/chat/findMessages/" + EVO_INSTANCE,
      {
        where: { key: { remoteJid: jid } },
        limit: limit,
      },
      { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
    );

    const allMessages = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];

    if (allMessages.length === 0) {
      return res.json({
        phone,
        totalMessages: 0,
        note: "No messages found. Evolution API only stores messages since the WhatsApp session was connected.",
        messages: [],
      });
    }

    allMessages.sort((a, b) => getMsgTimestamp(a) - getMsgTimestamp(b));

    const contactName = allMessages.find((m) => m.pushName)?.pushName || phone;

    const formatted = allMessages.map((m) => {
      const ts = getMsgTimestamp(m);
      const isFromMe = m.key?.fromMe || false;
      return {
        time: formatDateTime(ts),
        timestamp: ts,
        direction: isFromMe ? "SENT" : "RECEIVED",
        sender: isFromMe ? "You" : contactName,
        text: getMessageText(m),
      };
    });

    const sentCount = formatted.filter((m) => m.direction === "SENT").length;
    const receivedCount = formatted.length - sentCount;

    const byDate = {};
    for (const msg of formatted) {
      const date = formatDate(msg.timestamp);
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push("[" + (msg.time.split(",")[1]?.trim() || msg.time) + "] " + msg.direction + ": " + msg.text);
    }

    res.json({
      phone,
      contactName,
      totalMessages: formatted.length,
      sent: sentCount,
      received: receivedCount,
      firstMessage: formatted[0]?.time || "N/A",
      lastMessage: formatted[formatted.length - 1]?.time || "N/A",
      byDate,
      messages: formatted,
    });

    console.log("Search complete: " + formatted.length + " messages for " + phone);
  } catch (err) {
    console.error("Search error:", err.response?.status, err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// =============================================
// DEDUP: Get existing tasks for today
// =============================================
async function getExistingTaskPhones() {
  const today = new Date();
  const riyadhOffset = 3 * 60 * 60 * 1000;
  const nowUtc = today.getTime();
  const riyadhNow = new Date(nowUtc + riyadhOffset);
  riyadhNow.setUTCHours(0, 0, 0, 0);
  const todayMs = riyadhNow.getTime() - riyadhOffset;
  const tomorrowMs = todayMs + 86400000;

  try {
    const res = await axios.get(CLICKUP_API + "/list/" + LIST_ID + "/task", {
      headers: { Authorization: CLICKUP_TOKEN },
      params: {
        order_by: "created",
        reverse: true,
        date_created_gt: todayMs,
        date_created_lt: tomorrowMs,
        include_closed: true,
      },
    });

    const phones = new Set();
    for (const task of (res.data.tasks || [])) {
      const match = task.name.match(/\((\d+)\)/);
      if (match) phones.add(match[1]);
    }

    console.log("Found " + phones.size + " existing tasks for today (dedup check)");
    return phones;
  } catch (err) {
    console.error("Dedup check failed:", err.response?.status || err.message);
    return new Set();
  }
}

// =============================================
// CORE: Fetch chats & messages from lookback
// =============================================
async function fetchRecentChats() {
  const now = Date.now();
  const since = now - LOOKBACK_MS;

  console.log("Fetching chats from last " + (LOOKBACK_MS / 3600000) + "h...");

  const chatsRes = await axios.post(
    EVO_API_URL + "/chat/findChats/" + EVO_INSTANCE,
    {},
    { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
  );

  const allChats = chatsRes.data || [];
  console.log("Found " + allChats.length + " total chats");

  const individualChats = allChats.filter((c) => {
    const jid = c.id || c.remoteJid || "";
    return jid.includes("@s.whatsapp.net") && !jid.startsWith("status");
  });

  console.log(individualChats.length + " individual chats found");

  const activeChats = [];

  for (const chat of individualChats) {
    const jid = chat.id || chat.remoteJid;
    const phone = jid.replace("@s.whatsapp.net", "");
    const contactName = chat.name || chat.pushName || phone;

    try {
      const msgsRes = await axios.post(
        EVO_API_URL + "/chat/findMessages/" + EVO_INSTANCE,
        {
          where: { key: { remoteJid: jid } },
          limit: 500,
        },
        { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
      );

      const allMessages = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];

      const recentMessages = allMessages.filter((m) => {
        const msgTime = getMsgTimestamp(m) * 1000;
        return msgTime >= since;
      });

      if (recentMessages.length === 0) continue;

      recentMessages.sort((a, b) => getMsgTimestamp(a) - getMsgTimestamp(b));

      const firstCustomerMsg = recentMessages.find((m) => !m.key?.fromMe);
      const firstCustomerTime = firstCustomerMsg ? getMsgTimestamp(firstCustomerMsg) : 0;

      let firstResponseTime = 0;
      let responseDelaySec = null;
      if (firstCustomerTime > 0) {
        const firstResponse = recentMessages.find(
          (m) => m.key?.fromMe && getMsgTimestamp(m) > firstCustomerTime
        );
        if (firstResponse) {
          firstResponseTime = getMsgTimestamp(firstResponse);
          responseDelaySec = firstResponseTime - firstCustomerTime;
        }
      }

      const lastMessage = recentMessages[recentMessages.length - 1];
      const lastMessageFromMe = lastMessage?.key?.fromMe || false;
      const chatStatus = lastMessageFromMe ? "Closed" : "Open";

      const formattedMessages = recentMessages.map((m) => {
        const isFromMe = m.key?.fromMe || false;
        const direction = isFromMe ? "SENT" : "RECEIVED";
        const ts = getMsgTimestamp(m);
        const time = formatTime(ts);
        return "[" + time + "] " + direction + ": " + getMessageText(m);
      });

      const sentCount = recentMessages.filter((m) => m.key?.fromMe).length;
      const receivedCount = recentMessages.length - sentCount;

      activeChats.push({
        phone,
        contactName,
        messageCount: recentMessages.length,
        sentCount,
        receivedCount,
        conversationLog: formattedMessages.join("\n"),
        firstCustomerTime,
        firstResponseTime,
        responseDelaySec,
        chatStatus,
      });

      console.log("Chat with " + contactName + " (" + phone + "): " + recentMessages.length + " msgs, status: " + chatStatus);
    } catch (err) {
      console.error("Error fetching messages for " + phone + ":", err.response?.status || err.message);
    }
  }

  return activeChats;
}

// =============================================
// CORE: Create ClickUp tasks from chat data
// =============================================
async function createDailyInsights() {
  console.log("\n========================================");
  console.log("Starting WhatsApp Insights report...");
  console.log("========================================\n");

  try {
    const chats = await fetchRecentChats();

    if (chats.length === 0) {
      console.log("No active chats found. Nothing to report.");
      return { success: true, tasksCreated: 0, skipped: 0 };
    }

    const existingPhones = await getExistingTaskPhones();

    const dateStr = getTodayDateStr();
    let tasksCreated = 0;
    let skipped = 0;

    for (const chat of chats) {
      if (existingPhones.has(chat.phone)) {
        console.log("Skipping " + chat.contactName + " (" + chat.phone + "): task already exists today");
        skipped++;
        continue;
      }

      try {
        const descLines = [
          "**Contact:** " + chat.contactName,
          "**Phone:** " + chat.phone,
          "**Total Messages:** " + chat.messageCount + " (Sent: " + chat.sentCount + ", Received: " + chat.receivedCount + ")",
          "**Date:** " + dateStr,
          "",
          "**First Message:** " + (chat.firstCustomerTime ? formatTime(chat.firstCustomerTime) : "N/A"),
          "**Our First Response:** " + (chat.firstResponseTime ? formatTime(chat.firstResponseTime) : "No response yet"),
          "**Response Time:** " + (chat.responseDelaySec !== null ? formatDuration(chat.responseDelaySec) : "N/A"),
          "",
          "**Chat Status:** " + (chat.chatStatus === "Open" ? "\ud83d\udd34 Open (awaiting our reply)" : "\ud83d\udfe2 Closed (we replied last)"),
        ];

        const taskStatus = chat.chatStatus === "Open" ? "to do" : "complete";

        const taskRes = await axios.post(
          CLICKUP_API + "/list/" + LIST_ID + "/task",
          {
            name: chat.contactName + " (" + chat.phone + ") - " + dateStr,
            description: descLines.join("\n"),
            status: taskStatus,
          },
          { headers: { Authorization: CLICKUP_TOKEN } }
        );

        const commentBody = [
          "**Chat Log: " + chat.contactName + " (" + chat.phone + ")**",
          "**Messages: " + chat.messageCount + "** | **Response Time: " + (chat.responseDelaySec !== null ? formatDuration(chat.responseDelaySec) : "No response") + "** | **Status: " + chat.chatStatus + "**",
          "",
          "---",
          "",
          chat.conversationLog,
        ].join("\n");

        await axios.post(
          CLICKUP_API + "/task/" + taskRes.data.id + "/comment",
          { comment_text: commentBody },
          { headers: { Authorization: CLICKUP_TOKEN } }
        );

        tasksCreated++;
        console.log("Task created: " + chat.contactName + " (" + chat.phone + ") | " + chat.messageCount + " msgs | " + chat.chatStatus);

        await new Promise((r) => setTimeout(r, 600));
      } catch (err) {
        console.error("Failed to create task for " + chat.phone + ":", err.response?.status, err.response?.data || err.message);
      }
    }

    console.log("\nReport complete: " + tasksCreated + " created, " + skipped + " skipped (already existed).");
    return { success: true, tasksCreated, skipped, totalChats: chats.length };
  } catch (err) {
    console.error("Insights error:", err.response?.status, err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// =============================================
// SCHEDULE: Run daily at 8:00 AM Riyadh time
// =============================================
cron.schedule("0 5 * * *", () => {
  console.log("Cron triggered: 8:00 AM Riyadh time");
  createDailyInsights();
}, { timezone: "Asia/Riyadh" });

// =============================================
// MANUAL TRIGGER: Run report on demand
// =============================================
app.get("/run", async (req, res) => {
  console.log("Manual trigger: running insights now...");
  const result = await createDailyInsights();
  res.json(result);
});

app.listen(PORT, () => {
  console.log("SPEN WA Insights running on port " + PORT);
  console.log("ClickUp token present: " + !!CLICKUP_TOKEN);
  console.log("Target list: " + LIST_ID);
  console.log("Evolution API: " + EVO_API_URL);
  console.log("Lookback: 24h");
  console.log("Schedule: Daily at 8:00 AM (Asia/Riyadh)");
  console.log("Manual trigger: GET /run");
  console.log("Chat list: GET /chats");
  console.log("Insights: GET /insights?date=YYYY-MM-DD");
  console.log("Search: GET /search?phone=XXXXX");
});
