const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID || "1018657164762024505";
const PORT = process.env.PORT || 3000;

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "spen-wa-webhook" }));

// Evolution API webhook receiver
app.post("/webhook/messages", async (req, res) => {
  try {
    const data = req.body;

    // Evolution API sends different event types
    if (!data || !data.data) return res.sendStatus(200);

    const message = data.data;
    const phone = message.key?.remoteJid?.replace("@s.whatsapp.net", "") || "unknown";
    const isFromMe = message.key?.fromMe || false;
    const senderName = message.pushName || phone;
    const msgText =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      "[media message]";

    // Skip status broadcasts and group messages
    if (phone === "status" || message.key?.remoteJid?.includes("@g.us")) {
      return res.sendStatus(200);
    }

    const direction = isFromMe ? "Sent" : "Received";
    const commentBody = `**${direction}** | **${senderName}** (${phone})\n\n${msgText}`;

    // Check for existing task for this phone number today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const tomorrowMs = todayMs + 86400000;

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
    console.error("Webhook error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`SPEN WA Webhook running on port ${PORT}`);
});