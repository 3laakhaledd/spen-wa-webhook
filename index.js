const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: '10mb' }));

const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID || "1018657164762024505";
const PORT = process.env.PORT || 3000;

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "spen-wa-webhook", hasToken: !!CLICKUP_TOKEN }));

// Evolution API webhook receiver
app.post("/webhook/messages", async (req, res) => {
  try {
    const data = req.body;
    console.log("Incoming webhook event:", data?.event || "unknown");
    console.log("Payload keys:", Object.keys(data || {}));

    // Evolution API sends different event types
    if (!data || !data.data) {
      console.log("No data.data found, skipping. Full body:", JSON.stringify(data).substring(0, 500));
      return res.sendStatus(200);
    }

    const message = data.data;
    console.log("Message keys:", Object.keys(message || {}));

    const phone = message.key?.remoteJid?.replace("@s.whatsapp.net", "") || "unknown";
    const isFromMe = message.key?.fromMe || false;
    const senderName = message.pushName || phone;
    const msgText =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      "[media message]";

    console.log(`Message from ${senderName} (${phone}): ${msgText}`);

    // Skip status broadcasts and group messages
    if (phone === "status" || message.key?.remoteJid?.includes("@g.us")) {
      console.log("Skipping status/group message");
      return res.sendStatus(200);
    }

    const direction = isFromMe ? "Sent" : "Received";
    const commentBody = `**${direction}** | **${senderName}** (${phone})\n\n${msgText}`;

    // Check for existing task for this phone number today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const tomorrowMs = todayMs + 86400000;

    console.log("Searching ClickUp for existing task...");
    console.log("Token present:", !!CLICKUP_TOKEN, "Token starts with:", CLICKUP_TOKEN?.substring(0, 5));

    // Search for tasks with this phone number in the name, created today
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
      // Add message as comment to existing task
      await axios.post(
        `${CLICKUP_API}/task/${existingTask.id}/comment`,
        { comment_text: commentBody },
        { headers: { Authorization: CLICKUP_TOKEN } }
      );
      console.log(`Comment added to task ${existingTask.id} for ${phone}`);
    } else {
      // Create new task for today's conversation
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

      // Add first message as comment
      await axios.post(
        `${CLICKUP_API}/task/${taskRes.data.id}/comment`,
        { comment_text: commentBody },
        { headers: { Authorization: CLICKUP_TOKEN } }
      );
      console.log(`New task created for ${phone}: ${taskRes.data.id}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.status, err.response?.data || err.message);
    res.sendStatus(200); // Return 200 anyway so Evolution stops retrying
  }
});

app.listen(PORT, () => {
  console.log(`SPEN WA Webhook running on port ${PORT}`);
  console.log(`ClickUp token present: ${!!CLICKUP_TOKEN}`);
  console.log(`Target list: ${LIST_ID}`);
});