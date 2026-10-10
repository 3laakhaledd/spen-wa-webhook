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
            rows.sort((a, b) => (b.in + b.out) - (a.in + a.out) || a.jid.localeCompare(b.jid));
            Object.assign(job, { status: "complete", rows, coverage: { ...data.coverage, passes: undefined },
              window: { from, to, days, readUntil: new Date(end * 1000).toISOString() } });
          } catch (err) { job.status = "failed"; job.error = err.message; }
        })();
      }
      if (job.status !== "complete") return res.json({ status: job.status, error: job.error, note: "poll again" });
      if (req.query.cls) return res.json(summarize(job, req.query, s, e));
      const offset = Math.max(0, Number(req.query.offset) || 0), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
      res.json({ status: "complete", instance, window: job.window, coverage: job.coverage, totalThreads: job.rows.length,
        offset, nextOffset: offset + limit < job.rows.length ? offset + limit : null,
        legend: "b=[[burstStartSec, firstReplySec|null, inboundMsgs, closerOnly]]", rows: job.rows.slice(offset, offset + limit).map((r, i) => req.query.lite ? { i: offset + i, name: r.name, in: r.in, out: r.out, by: r.startedBy, t: r.t } : r) });
    } catch (err) { res.status(400).json({ status: "failed", error: err.message }); }
  });
}

// Working hours (Riyadh): Sun-Thu, OPEN-CLOSE. Business seconds between two instants.
function bizSeconds(a, b, open, close, days) {
  let t = a, sum = 0;
  while (t < b) {
    const d = riyadh(t), dayStart = t - (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds());
    const o = dayStart + open * 3600, c = dayStart + close * 3600, next = dayStart + 86400;
    if (days.includes(d.getUTCDay())) sum += Math.max(0, Math.min(b, c) - Math.max(t, o));
    t = next;
  }
  return sum;
}
const median = a => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
function summarize(job, q, s, e) {
  const cls = String(q.cls), cat = String(q.cat || ""), cmp = String(q.cmp || "");
  const open = Number(q.open || 7), close = Number(q.close || 15), target = Number(q.target || 30) * 60;
  const days = job.window.days;
  const pendingFrom = Number(q.pendingFrom || 0); // unreplied bursts at/after this instant = still pending
  const keep = new Set(String(q.keep || "PN").split(""));
  const out = { assumptions: { workingHours: open + ":00-" + close + ":00 Sun-Thu Riyadh", targetMinutes: target / 60,
      pendingFrom: pendingFrom ? new Date(pendingFrom * 1000).toISOString() : null, kept: [...keep] },
    totals: {}, bySegment: {}, byCategory: {}, complaints: {}, byDay: {}, byHour: {}, unreplied: [], slowest: [] };
  const z = () => ({ threads: 0, msgsIn: 0, msgsOut: 0, bursts: 0, closers: 0, replied: 0, notReplied: 0, pending: 0, withinTarget: 0, rtBiz: [], rtRaw: [] });
  const T = z();
  const bump = (map, k) => (map[k] = map[k] || z());
  job.rows.forEach((r, i) => {
    const seg = cls[i] || "?";
    if (!keep.has(seg)) return;
    const c = cat[i] || "O", k = cmp[i] && cmp[i] !== "-" ? cmp[i] : null;
    const targets = [T, bump(out.bySegment, seg), bump(out.byCategory, c)];
    if (k) targets.push(bump(out.complaints, k));
    targets.forEach(x => { x.threads++; x.msgsIn += r.in; x.msgsOut += r.out; });
    for (const [bs, br, n, closer] of r.b) {
      const d = riyadh(bs), day = d.toISOString().slice(0, 10), hr = d.getUTCHours();
      const D = out.byDay[day] = out.byDay[day] || { bursts: 0, msgsIn: 0, replied: 0, unreplied: 0, rtBiz: [] };
      out.byHour[hr] = (out.byHour[hr] || 0) + n;
      D.msgsIn += n;
      if (closer) { targets.forEach(x => x.closers++); continue; }
      D.bursts++;
      targets.forEach(x => x.bursts++);
      if (br) {
        const biz = bizSeconds(bs, br, open, close, days), raw = br - bs;
        D.replied++; D.rtBiz.push(biz);
        targets.forEach(x => { x.replied++; x.rtBiz.push(biz); x.rtRaw.push(raw); if (biz <= target) x.withinTarget++; });
        if (biz > 4 * 3600) out.slowest.push({ i, name: r.name, seg, cat: c, at: d.toISOString().slice(0, 16), bizMin: Math.round(biz / 60), rawMin: Math.round(raw / 60) });
      } else {
        const pend = pendingFrom && bs >= pendingFrom;
        D.unreplied++;
        targets.forEach(x => pend ? x.pending++ : x.notReplied++);
        out.unreplied.push({ i, name: r.name, seg, cat: c, at: d.toISOString().slice(0, 16), msgs: n, state: pend ? "pending" : "not replied" });
      }
    }
  });
  const fin = x => { const o = { ...x, medianBizMin: x.rtBiz.length ? +(median(x.rtBiz) / 60).toFixed(1) : null,
    avgBizMin: x.rtBiz.length ? +(x.rtBiz.reduce((a, b) => a + b, 0) / x.rtBiz.length / 60).toFixed(1) : null,
    medianRawMin: x.rtRaw && x.rtRaw.length ? +(median(x.rtRaw) / 60).toFixed(1) : null,
    p90BizMin: x.rtBiz.length ? +([...x.rtBiz].sort((a, b) => a - b)[Math.floor(x.rtBiz.length * 0.9)] / 60).toFixed(1) : null,
    replyRate: x.bursts ? +(100 * x.replied / x.bursts).toFixed(1) : null,
    withinTargetPct: x.replied != null && x.replied ? +(100 * x.withinTarget / x.replied).toFixed(1) : null };
    delete o.rtBiz; delete o.rtRaw; return o; };
  out.totals = fin(T);
  for (const m of [out.bySegment, out.byCategory, out.complaints]) for (const k of Object.keys(m)) m[k] = fin(m[k]);
  for (const k of Object.keys(out.byDay)) { const D = out.byDay[k]; D.medianBizMin = D.rtBiz.length ? +(median(D.rtBiz) / 60).toFixed(1) : null; delete D.rtBiz; }
  out.slowest.sort((a, b) => b.bizMin - a.bizMin); out.slowest = out.slowest.slice(0, 15);
  return out;
}
module.exports = { install, CLOSER, bizSeconds };
