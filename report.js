// Weekly customer-chat report data (individual chats only; groups/broadcast/status excluded).
// Compact per-thread rows so a reviewer can classify segments/inquiries; metrics are computed per inbound "burst".
const retrieval = require("./retrieval");
const SKIP = new Set(["reactionMessage", "protocolMessage", "secretEncryptedMessage", "associatedChildMessage",
  "editedMessage", "pollUpdateMessage", "senderKeyDistributionMessage", "messageContextInfo", "keepInChatMessage"]);
const CLOSER = /^(?:\s|شكرا|شكراً|مشكور[ةه]?|يعطيك?\s*العافي[ةه]|جزاك[مي]?\s*الله\s*خير[اً]*|تمام|طيب|اوك|أوك|ok|okay|thanks?|thank you|تسلم[يو]?|الله يسعدك|ماشي|حاضر|خلاص|وصلت?|[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2764\uFE0F👍🙏🌹🌷❤]+|[.!؟?]+)+$/iu;
const ts = m => Number(m.messageTimestamp && typeof m.messageTimestamp === "object" ? m.messageTimestamp.low : m.messageTimestamp);
const riyadh = sec => new Date((sec + 10800) * 1000);
function install(app, apiFor, lines) {
  const jobs = new Map();
  app.get("/report/week", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const n = Number(req.query.line || 1);
      const instance = lines[n - 1];
      if (!instance) throw new Error("Unknown line");
      const from = String(req.query.from || ""), to = String(req.query.to || "");
      const s = retrieval.dayBounds(from).start, e = retrieval.dayBounds(to).end;
      if (e <= s || e - s > 15 * 86400) throw new Error("Range must be 1-15 days");
      const days = String(req.query.days || "0,1,2,3,4").split(",").map(Number); // 0=Sun Riyadh
      const key = instance + "|" + from + "|" + to + "|" + days.join("");
      let job = jobs.get(key);
      if (!job || (job.status === "failed" && Date.now() - job.created > 30000)) {
        job = { status: "running", created: Date.now() };
        jobs.set(key, job);
        (async () => {
          try {
            const api = apiFor(instance);
            // replies may land after the window (e.g. Fri/Sat); read until now (max +3 days)
            const end = Math.min(Math.floor(Date.now() / 1000) + 1, e + 3 * 86400);
            const where = { messageTimestamp: { gte: new Date(s * 1000).toISOString(), lte: new Date((end - 1) * 1000).toISOString() } };
            const data = await api.verifiedCollect(api.request, where, { start: s, end });
            const threads = new Map();
            for (const m of data.rows) {
              const jid = m.key.remoteJid;
              if (!(jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"))) continue;
              if (SKIP.has(m.messageType)) continue;
              if (!threads.has(jid)) threads.set(jid, { jid, name: null, msgs: [] });
              const t = threads.get(jid);
              if (!m.key.fromMe && m.pushName) t.name = m.pushName;
              t.msgs.push(m);
            }
            const inWin = sec => sec >= s && sec < e && days.includes(riyadh(sec).getUTCDay());
            const rows = [];
            for (const t of threads.values()) {
              t.msgs.sort((a, b) => ts(a) - ts(b));
              const bursts = []; let cur = null; let inC = 0, outC = 0; const texts = [];
              for (const m of t.msgs) {
                const sec = ts(m);
                if (m.key.fromMe) {
                  if (inWin(sec)) outC++;
                  if (cur) { cur.r = sec; bursts.push(cur); cur = null; }
                } else {
                  if (!cur) cur = inWin(sec) ? { s: sec, r: null, n: 0, txt: [] } : { skip: true, n: 0, txt: [] };
                  if (inWin(sec)) inC++;
                  cur.n++;
                  const tx = retrieval.textOf(m);
                  cur.txt.push(tx);
                  if (inWin(sec) && tx !== "[media or non-text]" && texts.length < 3) texts.push(tx.replace(/\s+/g, " ").slice(0, 90));
                  else if (inWin(sec) && tx === "[media or non-text]" && texts.length < 3) texts.push("<" + m.messageType + ">");
                }
              }
              if (cur) bursts.push(cur);
              const kept = bursts.filter(b => !b.skip).map(b => {
                const real = b.txt.filter(x => x !== "[media or non-text]");
                const closer = real.length > 0 && real.length === b.txt.length && real.every(x => x.length <= 40 && CLOSER.test(x.trim()));
                return [b.s, b.r, b.n, closer ? 1 : 0];
              });
              if (!kept.length && !outC) continue;
              const firstOut = t.msgs.find(m => inWin(ts(m)));
              rows.push({ jid: t.jid, name: t.name || "", in: inC, out: outC,
                startedBy: firstOut ? (firstOut.key.fromMe ? "school" : "customer") : null, b: kept, t: texts });
            }
            rows.sort((a, b) => (b.in + b.out) - (a.in + a.out));
            Object.assign(job, { status: "complete", rows, coverage: { ...data.coverage, passes: undefined },
              window: { from, to, days, readUntil: new Date(end * 1000).toISOString() } });
          } catch (err) { job.status = "failed"; job.error = err.message; }
        })();
      }
      if (job.status !== "complete") return res.json({ status: job.status, error: job.error, note: "poll again" });
      const offset = Math.max(0, Number(req.query.offset) || 0), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
      res.json({ status: "complete", instance, window: job.window, coverage: job.coverage, totalThreads: job.rows.length,
        offset, nextOffset: offset + limit < job.rows.length ? offset + limit : null,
        legend: "b=[[burstStartSec, firstReplySec|null, inboundMsgs, closerOnly]]", rows: job.rows.slice(offset, offset + limit) });
    } catch (err) { res.status(400).json({ status: "failed", error: err.message }); }
  });
}
module.exports = { install, CLOSER };
