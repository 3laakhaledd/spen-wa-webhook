const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: '10mb' }));

const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID || "901821823676";
const TEAM_ID = process.env.CLICKUP_TEAM_ID || "9018866787";
const PORT = process.env.PORT || 3000;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || "https://web-production-1abd6.up.railway.app";

// Evolution API config
const EVO_API_URL = process.env.EVO_API_URL || "https://evolution-api-production-3bf028.up.railway.app";
const EVO_API_KEY = process.env.EVO_API_KEY || "spen-evo-2026-secret";
const EVO_INSTANCE = process.env.EVO_INSTANCE || "spen-whatsapp";

// Track comments we created (to avoid echo loops)
const botCommentIds = new Set();

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "spen-wa-webhook", hasToken: !!CLICKUP_TOKEN }));

// =============================================
// SETUP: Create ClickUp webhook (visit once)
// =============================================
app.get("/setup", async (req, res) => {
  try {
    // Check existing webhooks first
    const existing = await axios.get(`${CLICKUP_API}/team/${TEAM_ID}/webhook`, {
      headers: { Authorization: CLICKUP_TOKEN },
    });

    const alreadyExists = existing.data.webhooks?.find((w) =>
      w.endpoint?.includes("/webhook/clickup")
    );

    if (alreadyExists) {
      return res.json({ message: "ClickUp webhook already exists!", webhook: alreadyExists });
    }

    // Create new webhook
    const result = await axios.post(
      `${CLICKUP_API}/team/${TEAM_ID}/webhook`,
      {
        endpoint: `${WEBHOOK_BASE_URL}/webhook/clickup`,
        events: ["taskCommentPosted"],
        list_id: LIST_ID,
      },
      { headers: { Authorization: CLICKUP_TOKEN } }
    );

    console.log("ClickUp webhook created:", result.data);
    res.json({ message: "ClickUp webhook created successfully!", webhook: result.data });
  } catch (err) {
    console.error("Setup error:", err.response?.status, err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// =============================================
// INBOUND: WhatsApp -> ClickUp Task/Comment
// =============================================
app.post("/webhook/messages", async (req, res) => {
  try {
    const data = req.body;
    console.log("Incoming WhatsApp event:", data?.event || "unknown");

    if (!data || !data.data) {
      console.log("No data.data found, skipping.");
      return res.sendStatus(200);
    }

    const message = data.data;
    const phone = message.key?.remoteJid?.replace("@s.whatsapp.net", "") || "unknown";
    const isFromMe = message.key?.fromMe || false;
    const senderName = message.pushName || phone;
    const msgText =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      "[media message]";

    console.log(`Message from ${senderName} (${phone}): ${msgText}`);

    // Skip status broadcasts, group messages, and our own outbound replies
    if (phone === "status" || message.key?.remoteJid?.includes("@g.us")) {
      console.log("Skipping status/group message");
      return res.sendStatus(200);
    }

    // Skip messages sent by us (outbound replies from ClickUp)
    if (isFromMe) {
      console.log("Skipping our own outbound message");
      return res.sendStatus(200);
    }

    const commentBody = `**Received** | **${senderName}** (${phone})\n\n${msgText}`;

    // Check for existing task for this phone number today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const tomorrowMs = todayMs + 86400000;

    console.log("Searching ClickUp for existing task...");

    const searchRes = await axios.get(`${CLICKUP_API}/list/${LIST_ID}/task`, {
      headers: { Authorization: CLICKUP_TOKEN },
      params: {
        order_by: "created",
        reverse: true,
        date_created_gt: todayMs,
        date_created_lt: tomorrowMs,
        include_closed: false,
      },
    });

    console.log("ClickUp search returned", searchRes.data.tasks?.length || 0, "tasks");

    const existingTask = searchRes.data.tasks?.find((t) =>
      t.name.includes(phone)
    );

    if (existingTask) {
      const commentRes = await axios.post(
        `${CLICKUP_API}/task/${existingTask.id}/comment`,
        { comment_text: commentBody },
        { headers: { Authorization: CLICKUP_TOKEN } }
      );
      if (commentRes.data?.id) botCommentIds.add(String(commentRes.data.id));
      console.log(`Comment added to task ${existingTask.id} for ${phone}`);
    } else {
      const dateStr = new Date().toLocaleDateString("en-GB");
      const taskRes = await axios.post(
        `${CLICKUP_API}/list/${LIST_ID}/task`,
        {
          name: `WhatsApp: ${senderName} (${phone}) - ${dateStr}`,
          description: `WhatsApp conversation with **${senderName}** (${phone})\nStarted: ${new Date().toISOString()}`,
          status: "to do",
        },
        { headers: { Authorization: CLICKUP_TOKEN } }
      );

      const commentRes = await axios.post(
        `${CLICKUP_API}/task/${taskRes.data.id}/comment`,
        { comment_text: commentBody },
        { headers: { Authorization: CLICKUP_TOKEN } }
      );
      if (commentRes.data?.id) botCommentIds.add(String(commentRes.data.id));
      console.log(`New task created for ${phone}: ${taskRes.data.id}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("WhatsApp webhook error:", err.response?.status, err.response?.data || err.message);
    res.sendStatus(200);
  }
});

// =============================================
// OUTBOUND: ClickUp Comment -> WhatsApp Reply
// =============================================
app.post("/webhook/clickup", async (req, res) => {
  try {
    const data = req.body;
    console.log("Incoming ClickUp event:", data?.event);

    if (data?.event !== "taskCommentPosted") {
      return res.sendStatus(200);
    }

    const commentId = String(data.history_items?.[0]?.comment?.id || "");
    const commentText = data.history_items?.[0]?.comment?.text_content || "";
    const taskId = data.task_id;

    console.log(`ClickUp comment on task ${taskId}: ${commentText}`);

    // Skip if this comment was created by our bot (inbound WhatsApp message)
    if (botCommentIds.has(commentId)) {
      console.log("Skipping bot-created comment (from WhatsApp inbound)");
      botCommentIds.delete(commentId);
      return res.sendStatus(200);
    }

    // Skip comments that look like inbound WhatsApp messages
    if (commentText.startsWith("**Received**") || commentText.startsWith("Received")) {
      console.log("Skipping inbound WhatsApp echo");
      return res.sendStatus(200);
    }

    // Get the task to extract phone number from name
    const taskRes = await axios.get(`${CLICKUP_API}/task/${taskId}`, {
      headers: { Authorization: CLICKUP_TOKEN },
    });

    const taskName = taskRes.data.name || "";
    const phoneMatch = taskName.match(/\((\d+)\)/);

    if (!phoneMatch) {
      console.log("No phone number found in task name:", taskName);
      return res.sendStatus(200);
    }

    const phone = phoneMatch[1];
    console.log(`Sending reply to WhatsApp ${phone}: ${commentText}`);

    // Send message via Evolution API
    await axios.post(
      `${EVO_API_URL}/message/sendText/${EVO_INSTANCE}`,
      {
        number: phone,
        text: commentText,
      },
      {
        headers: {
          apikey: EVO_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`WhatsApp reply sent to ${phone}`);
    res.sendStatus(200);
  } catch (err) {
    console.error("ClickUp webhook error:", err.response?.status, err.response?.data || err.message);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`SPEN WA Webhook running on port ${PORT}`);
  console.log(`ClickUp token present: ${!!CLICKUP_TOKEN}`);
  console.log(`Target list: ${LIST_ID}`);
  console.log(`Evolution API: ${EVO_API_URL}`);
});