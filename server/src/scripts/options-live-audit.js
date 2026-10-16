/**
 * Diagnóstico SOLO LECTURA de órdenes/posiciones reales.
 * Ejecutar desde backend: node src/scripts/options-live-audit.js
 * No consulta Binance ni modifica el estado.
 */
const db = require('../db');
const { parseSymbol } = require('../services/options/options-utils');

async function audit() {
  const at = Date.now();
  const [states, pending, positions] = await Promise.all([
    db.query("SELECT status,COUNT(*)::int AS count FROM options_live_orders GROUP BY status"),
    db.query("SELECT id,user_id,strategy_id,symbol,status,deadline_at,last_error " +
      "FROM options_live_orders WHERE status<>'final' ORDER BY deadline_at LIMIT 100"),
    db.query("SELECT id,user_id,strategy_id,symbol,side,quantity " +
      "FROM options_strategy_positions WHERE mode='live' AND closed_at IS NULL"),
  ]);
  const expired = positions.rows.filter((p) => {
    const meta = parseSymbol(p.symbol);
    return !meta || meta.expiryMs <= at;
  });
  const out = {
    at: new Date(at).toISOString(),
    orderStatuses: states.rows.map((r) => ({ status: r.status, count: Number(r.count) })),
    unresolved: pending.rows.map((r) => ({
      id: String(r.id), userId: Number(r.user_id),
      strategyId: Number(r.strategy_id), symbol: r.symbol, status: r.status,
      minutesPastDeadline: Math.round((at - Number(r.deadline_at)) / 60_000),
      error: r.last_error,
    })),
    expiredLocalLivePositions: expired.map((p) => ({
      positionId: String(p.id), userId: Number(p.user_id),
      strategyId: Number(p.strategy_id), symbol: p.symbol,
      side: p.side, quantity: String(p.quantity),
    })),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (out.unresolved.some((r) => r.status === 'attention' || r.minutesPastDeadline > 1) ||
      out.expiredLocalLivePositions.length) process.exitCode = 2;
}

audit().catch((err) => {
  process.stderr.write('Options live audit failed: ' + err.message + '\n');
  process.exitCode = 1;
}).finally(() => db.pool.end());
