/**
 * A hard monthly cap on everything this server spends at Cloudflare.
 *
 * Cloudflare itself has no hard spending limit for R2 or Workers AI - budget
 * alerts only send email. Every billable call goes through this server, so the
 * cap is enforced here: before a call, `allow()` checks the month's estimated
 * spend plus the call's own estimate against SPEND_CAP_USD, and afterwards
 * `record()` books what it actually used.
 *
 * Estimates deliberately ignore Cloudflare's free allowances (10 GB of R2
 * storage, 1M writes, 10M reads a month), so the number shown is an upper
 * bound: the real bill is at or below it, never above.
 */

// Cloudflare list prices, USD. Checked 2026-09-30.
export const PRICES = {
  jev_input_per_m_tokens: 0.042,   // typesafe/jev on Workers AI; output is free
  r2_storage_per_gb_month: 0.015,
  r2_class_a_per_m_ops: 4.50,      // PUT / DELETE / LIST
  r2_class_b_per_m_ops: 0.36,      // GET
};

const GB = 1024 ** 3;

export function makeBudget(db, env = process.env) {
  const capUsd = Number(env.SPEND_CAP_USD ?? 10);

  db.exec(`
    CREATE TABLE IF NOT EXISTS spend (
      month     TEXT NOT NULL,          -- YYYY-MM, UTC (Cloudflare bills monthly)
      kind      TEXT NOT NULL,          -- jev | r2_write | r2_read
      units     INTEGER NOT NULL DEFAULT 0,
      cost_usd  REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (month, kind)
    );
  `);

  const month = () => new Date().toISOString().slice(0, 7);

  const upsert = db.prepare(`
    INSERT INTO spend (month, kind, units, cost_usd) VALUES (?, ?, ?, ?)
    ON CONFLICT(month, kind) DO UPDATE SET
      units = units + excluded.units, cost_usd = cost_usd + excluded.cost_usd`);

  /** Stored transcript bytes, priced as a full month of storage. */
  function storageCost() {
    const row = db.prepare(
      "SELECT COALESCE(SUM(gz_bytes), 0) AS b FROM transcripts WHERE deleted_at = ''").get();
    return (row.b / GB) * PRICES.r2_storage_per_gb_month;
  }

  function spent() {
    const rows = db.prepare('SELECT kind, units, cost_usd FROM spend WHERE month = ?').all(month());
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, { units: r.units, cost_usd: r.cost_usd }]));
    const ops = rows.reduce((a, r) => a + r.cost_usd, 0);
    const storage = storageCost();
    return { month: month(), cap_usd: capUsd, ops_usd: ops, storage_usd: storage, total_usd: ops + storage, byKind };
  }

  return {
    capUsd,

    /** True when a call estimated at `estUsd` still fits under the cap. */
    allow(estUsd = 0) {
      if (!(capUsd > 0)) return true; // SPEND_CAP_USD=0 disables the cap
      return spent().total_usd + estUsd <= capUsd;
    },

    record(kind, units, costUsd) {
      upsert.run(month(), kind, Math.max(0, Math.round(units)), Math.max(0, costUsd));
    },

    spent,

    est: {
      jev: (inputTokens) => (inputTokens / 1e6) * PRICES.jev_input_per_m_tokens,
      r2Write: (ops = 1) => (ops / 1e6) * PRICES.r2_class_a_per_m_ops,
      r2Read: (ops = 1) => (ops / 1e6) * PRICES.r2_class_b_per_m_ops,
      // A new object adds a month of storage to the bill.
      r2Storage: (bytes) => (bytes / GB) * PRICES.r2_storage_per_gb_month,
    },
  };
}
