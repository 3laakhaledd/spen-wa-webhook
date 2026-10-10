// Multi-number support: one Evolution instance per WhatsApp number ("line").
// EVO_INSTANCES is a comma list; the first entry is the primary line used by the legacy root routes.
const DEFAULT_LINES = "spen-whatsapp,spen-whatsapp-2,spen-whatsapp-3";

function parseLines(raw, primary) {
  const first = primary || DEFAULT_LINES.split(",")[0];
  const list = String(raw || "").split(",").map(s => s.trim()).filter(Boolean);
  // Default: keep the already-connected instance as line 1, add "-2" and "-3".
  const names = list.length ? list : [first, first + "-2", first + "-3"];
  const seen = new Set();
  return names.filter(n => /^[A-Za-z0-9_-]{1,60}$/.test(n) && !seen.has(n) && seen.add(n)).slice(0, 10);
}

const maskJid = jid => {
  const d = String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
  return d.length > 4 ? "+" + "•".repeat(Math.max(0, d.length - 4)) + d.slice(-4) : null;
};
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function create({ axios, baseUrl, apiKey, lines, connectKey }) {
  const base = String(baseUrl).replace(/\/$/, "");
  const opts = { headers: { apikey: apiKey, "Content-Type": "application/json" }, timeout: 30000 };

  async function fetchAll() {
    const r = await axios.get(base + "/instance/fetchInstances", opts);
    const arr = Array.isArray(r.data) ? r.data : [r.data];
    const map = new Map();
    for (const x of arr) {
      const name = x && (x.name || x.instance?.instanceName || x.instanceName);
      if (name) map.set(name, {
        exists: true, ownerJid: x.ownerJid || x.instance?.ownerJid || null,
        state: x.connectionStatus || x.instance?.status || x.instance?.state || null
      });
    }
    return map;
  }
  async function ensure(name, existing) {
    if (existing.has(name)) return false;
    await axios.post(base + "/instance/create", {
      instanceName: name, integration: "WHATSAPP-BAILEYS", qrcode: true,
      syncFullHistory: true, groupsIgnore: false, rejectCall: false, alwaysOnline: false,
      readMessages: false, readStatus: false
    }, opts);
    return true;
  }
  async function connectCode(name, phone) {
    const params = phone ? { number: phone } : undefined;
    const r = await axios.get(base + "/instance/connect/" + encodeURIComponent(name), { ...opts, params });
    const d = r.data || {};
    const q = d.qrcode || d;
    return { qr: q.base64 || null, pairingCode: q.pairingCode || d.pairingCode || null };
  }
  async function status() {
    const existing = await fetchAll();
    const created = [];
    for (const name of lines) {
      try { if (await ensure(name, existing)) created.push(name); }
      catch (e) { existing.set(name, { exists: false, error: "create failed" + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") }); }
    }
    const fresh = created.length ? await fetchAll() : existing;
    return lines.map((name, i) => {
      const s = fresh.get(name) || existing.get(name) || { exists: false };
      return { line: i + 1, instance: name, exists: !!s.exists, state: s.state || "close",
        connected: s.state === "open", number: maskJid(s.ownerJid), error: s.error };
    });
  }
  const authorized = req => !connectKey || req.query.key === connectKey;

  function install(app) {
    app.get("/lines", async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!authorized(req)) return res.status(403).json({ error: "Add ?key=CONNECT_KEY" });
      try { res.json({ lines: await status() }); }
      catch (e) { res.status(502).json({ error: "Line status failed" + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") }); }
    });
    app.get("/connect", async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!authorized(req)) return res.status(403).type("text/plain").send("Forbidden: add ?key=CONNECT_KEY");
      let rows, top = "";
      try { rows = await status(); } catch (e) { rows = []; top = "Could not reach Evolution API" + (e.response?.status ? " (HTTP " + e.response.status + ")" : ""); }
      const phone = String(req.query.phone || "").replace(/\D/g, "");
      const target = String(req.query.line || "");
      const cards = [];
      for (const r of rows) {
        let body = "";
        if (r.connected) body = '<p class="ok">Connected ' + esc(r.number || "") + "</p>";
        else if (r.error) body = '<p class="bad">' + esc(r.error) + "</p>";
        else {
          try {
            const c = await connectCode(r.instance, target === r.instance && phone.length >= 8 ? phone : "");
            body = (c.qr ? '<img alt="QR" src="' + esc(c.qr) + '">' : '<p class="bad">QR not ready, page refreshes automatically</p>') +
              (c.pairingCode ? '<p>Pairing code: <b>' + esc(c.pairingCode) + "</b></p>" : "");
          } catch (e) { body = '<p class="bad">QR failed' + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") + "</p>"; }
          body += '<form method="get"><input type="hidden" name="line" value="' + esc(r.instance) + '">' +
            (req.query.key ? '<input type="hidden" name="key" value="' + esc(req.query.key) + '">' : "") +
            '<input name="phone" placeholder="or phone e.g. 9665XXXXXXXX"><button>Get pairing code</button></form>';
        }
        cards.push('<div class="card"><h2>Line ' + r.line + ' <small>' + esc(r.instance) + '</small></h2><p>Status: <b>' +
          esc(r.state) + "</b></p>" + body + "</div>");
      }
      const allOn = rows.length && rows.every(r => r.connected);
      res.type("html").send('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        (allOn || phone ? "" : '<meta http-equiv="refresh" content="25">') +
        "<title>SPEN WhatsApp lines</title><style>body{font-family:system-ui,sans-serif;background:#0f1d3a;color:#fff;margin:0;padding:24px}" +
        "h1{margin:0 0 6px}.wrap{display:flex;gap:16px;flex-wrap:wrap}.card{background:#fff;color:#0f1d3a;border-radius:16px;padding:18px;width:300px}" +
        "h2{margin:0;color:#FF8200}small{color:#666;font-size:12px}img{width:260px;height:260px}.ok{color:#2EAA5B;font-weight:700}.bad{color:#c0392b}" +
        "input{padding:8px;width:170px}button{padding:8px 12px;background:#FF8200;color:#fff;border:0;border-radius:20px}</style></head><body>" +
        "<h1>SPEN WhatsApp: " + rows.filter(r => r.connected).length + "/" + rows.length + " lines connected</h1>" +
        "<p>WhatsApp on the phone, Settings, Linked devices, Link a device, then scan. QR refreshes every 25s.</p>" +
        (top ? '<p class="bad">' + esc(top) + "</p>" : "") + '<div class="wrap">' + cards.join("") + "</div></body></html>");
    });
  }
  return { status, install, fetchAll };
}
module.exports = { DEFAULT_LINES, parseLines, maskJid, create };
