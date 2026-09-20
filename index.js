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

// Health check
app.get("/", (req, res) => res.json({
  status: "ok",
  service: "spen-wa-insights",
  nextRun: "Daily at 8:00 AM (Asia/Riyadh)",
  hasToken: !!CLICKUP_TOKEN,
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

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// =============================================
// CORE: Fetch chats & messages from last 24h
// =============================================
async function fetchLast24hChats() {
  const now = Date.now();
  const since = now - 86400000; // 24 hours ago

  console.log("Fetching chats from Evolution API...");

  // Get all chats
  const chatsRes = await axios.post(
    `${EVO_API_URL}/chat/findChats/${EVO_INSTANCE}`,
    {},
    { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
  );

  const allChats = chatsRes.data || [];
  console.log(`Found ${allChats.length} total chats`);

  // Filter to individual chats (not groups, not status)
  const individualChats = allChats.filter((c) => {
    const jid = c.id || c.remoteJid || "";
    return jid.includes("@s.whatsapp.net") && !jid.startsWith("status");
  });

  console.log(`${individualChats.length} individual chats found`);

  const activeChats = [];

  for (const chat of individualChats) {
    const jid = chat.id || chat.remoteJid;
    const phone = jid.replace("@s.whatsapp.net", "");
    const contactName = chat.name || chat.pushName || phone;

    try {
      // Fetch messages for this chat
      const msgsRes = await axios.post(
        `${EVO_API_URL}/chat/findMessages/${EVO_INSTANCE}`,
        {
          where: {
            key: { remoteJid: jid },
          },
          limit: 500,
        },
        { headers: { apikey: EVO_API_KEY, "Content-Type": "application/json" } }
      );

      const allMessages = msgsRes.data?.messages?.records || msgsRes.data?.messages || msgsRes.data || [];

      // Filter messages from last 24 hours
      const recentMessages = allMessages.filter((m) => {
        const msgTime = getMsgTimestamp(m) * 1000;
        return msgTime >= since;
      });

      if (recentMessages.length === 0) continue;

      // Sort chronologically
      recentMessages.sort((a, b) => getMsgTimestamp(a) - getMsgTimestamp(b));

      // Find first customer message (not from me)
      const firstCustomerMsg = recentMessages.find((m) => !m.key?.fromMe);
      const firstCustomerTime = firstCustomerMsg ? getMsgTimestamp(firstCustomerMsg) : 0;

      // Find our first response AFTER the first customer message
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

      // Determine chat status: last message from customer = Open, from us = Closed
      const lastMessage = recentMessages[recentMessages.length - 1];
      const lastMessageFromMe = lastMessage?.key?.fromMe || false;
      const chatStatus = lastMessageFromMe ? "Closed" : "Open";

      // Format messages into conversation log
      const formattedMessages = recentMessages.map((m) => {
        const isFromMe = m.key?.fromMe || false;
        const direction = isFromMe ? "SENT" : "RECEIVED";
        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          m.message?.documentMessage?.title ||
          "[media]";
        const ts = getMsgTimestamp(m);
        const time = formatTime(ts);
        return `[${time}] ${direction}: ${text}`;
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

      console.log(`Chat with ${contactName} (${phone}): ${recentMessages.length} msgs, status: ${chatStatus}`);
    } catch (err) {
      console.error(`Error fetching messages for ${phone}:`, err.response?.status || err.message);
    }
  }

  return activeChats;
}

// =============================================
// CORE: Create ClickUp tasks from chat data
// =============================================
async function createDailyInsights() {
  console.log("\n========================================");
  console.log("Starting daily WhatsApp Insights report...");
  console.log("========================================\n");

  try {
    const chats = await fetchLast24hChats();

    if (chats.length === 0) {
      console.log("No active chats in the last 24 hours. Nothing to report.");
      return { success: true, tasksCreated: 0 };
    }

    console.log(`\nCreating ${chats.length} tasks in ClickUp...`);
    const dateStr = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" });
    let tasksCreated = 0;

    for (const chat of chats) {
      try {
        // Build description
        const descLines = [
          `**Contact:** ${chat.contactName}`,
          `**Phone:** ${chat.phone}`,
          `**Total Messages:** ${chat.messageCount} (Sent: ${chat.sentCount}, Received: ${chat.receivedCount})`,
          `**Date:** ${dateStr}`,
          "",
          `**First Message:** ${chat.firstCustomerTime ? formatTime(chat.firstCustomerTime) : "N/A"}`,
          `**Our First Response:** ${chat.firstResponseTime ? formatTime(chat.firstResponseTime) : "No response yet"}`,
          `**Response Time:** ${chat.responseDelaySec !== null ? formatDuration(chat.responseDelaySec) : "N/A"}`,
          "",
          `**Chat Status:** ${chat.chatStatus === "Open" ? "🔴 Open (awaiting our reply)" : "🟢 Closed (we replied last)"}`,
        ];

        // Determine task status based on chat status
        const taskStatus = chat.chatStatus === "Open" ? "to do" : "complete";

        // Create the task
        const taskRes = await axios.post(
          `${CLICKUP_API}/list/${LIST_ID}/task`,
          {
            name: `${chat.contactName} (${chat.phone}) - ${dateStr}`,
            description: descLines.join("\n"),
            status: taskStatus,
          },
          { headers: { Authorization: CLICKUP_TOKEN } }
        );

        // Add the full conversation as one comment
        const commentBody = [
          `**Chat Log: ${chat.contactName} (${chat.phone})**`,
          `**Messages: ${chat.messageCount}** | **Response Time: ${chat.responseDelaySec !== null ? formatDuration(chat.responseDelaySec) : "No response"}** | **Status: ${chat.chatStatus}**`,
          "",
          "---",
          "",
          chat.conversationLog,
        ].join("\n");

        await axios.post(
          `${CLICKUP_API}/task/${taskRes.data.id}/comment`,
          { comment_text: commentBody },
          { headers: { Authorization: CLICKUP_TOKEN } }
        );

        tasksCreated++;
        console.log(`Task created: ${chat.contactName} (${chat.phone}) | ${chat.messageCount} msgs | ${chat.chatStatus} | Response: ${chat.responseDelaySec !== null ? formatDuration(chat.responseDelaySec) : "none"}`);

        // Small delay to respect ClickUp rate limits
        await new Promise((r) => setTimeout(r, 600));
      } catch (err) {
        console.error(`Failed to create task for ${chat.phone}:`, err.response?.status, err.response?.data || err.message);
      }
    }

    console.log(`\nDaily report complete: ${tasksCreated}/${chats.length} tasks created.`);
    return { success: true, tasksCreated, totalChats: chats.length };
  } catch (err) {
    console.error("Daily insights error:", err.response?.status, err.response?.data || err.message);
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
  console.log("Manual trigger: running daily insights now...");
  const result = await createDailyInsights();
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`SPEN WA Insights running on port ${PORT}`);
  console.log(`ClickUp token present: ${!!CLICKUP_TOKEN}`);
  console.log(`Target list: ${LIST_ID}`);
  console.log(`Evolution API: ${EVO_API_URL}`);
  console.log(`Schedule: Daily at 8:00 AM (Asia/Riyadh)`);
  console.log(`Manual trigger: GET /run`);
});