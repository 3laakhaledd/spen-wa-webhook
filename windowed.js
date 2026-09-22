// Split timestamp ties away from page boundaries. Never silently deduplicate.
module.exports = async function windowed(readPage, where, bounds, progress, collectPass, digest) {
  if (!bounds) return collectPass(readPage, where, bounds, progress);
  const receipts = [], rows = [], ids = new Set();
  let windows = 0;
  async function visit(start, end) {
    const filter = { ...where, messageTimestamp: {
      gte: new Date(start * 1000).toISOString(),
      lte: new Date((end - 1) * 1000).toISOString()
    } };
    const probe = await readPage({ where: filter, offset: 500, page: 1 });
    const m = probe?.messages;
    if (!m || !Array.isArray(m.records) || !Number.isInteger(m.total) || m.total < 0 ||
        m.currentPage !== 1 || m.pages !== Math.ceil(m.total / 500) ||
        m.records.length !== Math.min(500, m.total))
      throw new Error("Invalid time-window probe metadata");
    receipts.push({ start, end, probeTotal: m.total, probe: true });
    if (m.total > 500 && end - start > 1) {
      const mid = start + Math.floor((end - start) / 2);
      const left = await visit(start, mid);
      const right = await visit(mid, end);
      if (left + right !== m.total) throw new Error("Time-window totals changed or filters ignored");
      return m.total;
    }
    // A single second with >500 records still uses strict pagination and fails
    // closed if the upstream order is unstable; it is never marked complete.
    const result = await collectPass(readPage, filter, { start, end }, () => {});
    if (result.audit.total !== m.total) throw new Error("Time-window total changed after probe");
    for (const row of result.rows) {
      if (ids.has(row.id)) throw new Error("Duplicate message across time windows");
      ids.add(row.id); rows.push(row);
    }
    windows++;
    for (const receipt of result.audit.receipts) receipts.push({ start, end, ...receipt });
    progress({ windowsRead: windows, uniqueRecords: rows.length });
    return m.total;
  }
  const total = await visit(bounds.start, bounds.end);
  if (ids.size !== total) throw new Error("Window union does not match source total");
  return { rows, audit: { total, pages: receipts.filter(r => !r.probe && !r.exhaustion).length,
    windows, uniqueRecords: ids.size, duplicates: 0, exhaustionVerified: true,
    strategy: "disjoint-time-windows", sha256: digest(rows), receipts } };
};
