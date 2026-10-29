/**
 * Simulador de salidas (puro): repite las posiciones compradas ya cerradas de
 * un bot con distintas reglas de salida (TP, stop, tiempo máximo) sobre el
 * recorrido real de la prima, y compara el P&L con lo que ocurrió de verdad.
 *
 * Recorrido: muestras por minuto mientras la posición estuvo abierta,
 * completadas con los snapshots horarios (antes de la primera muestra por
 * minuto y después del cierre real, hasta el vencimiento).
 */

const { parseSymbol, tradeFee, exerciseFee, HOUR_MS } = require('./options-utils');

const TP_GRID = [20, 30, 40, 60, 80, 100, 150, 200, null];
const MAX_HOLD_GRID = [1, 2, 4, 6, 8, 12, 24, null];
const STOP_GRID = [null, 30, 50];
const BEST_COUNT = 10;
const MINUTE_MS = 60 * 1000;

const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Recorrido de la prima de una posición: [{ at, bid, spot }] ordenado por tiempo. */
function buildPath(position, minuteSamples = [], snapshots = [], expiryMs = null) {
  const end = position.closedAt ?? Infinity;
  const minute = minuteSamples
    .filter((s) => s.at >= position.openedAt && s.at <= end)
    .map((s) => ({ at: s.at, bid: numOrNull(s.bid), spot: numOrNull(s.spot) }));
  const firstMinute = minute.length ? minute[0].at : null;
  const hourly = snapshots
    .filter((s) => s.capturedAt >= position.openedAt && (expiryMs == null || s.capturedAt <= expiryMs))
    .filter((s) => firstMinute == null || s.capturedAt < firstMinute || s.capturedAt > end)
    .map((s) => ({ at: s.capturedAt, bid: numOrNull(s.bid), spot: numOrNull(s.spot) }));
  const points = [...minute, ...hourly].sort((a, b) => a.at - b.at);
  let coverage = 'none';
  if (minute.length) coverage = 'minute';
  else if (hourly.length) coverage = 'hourly';
  return { points, coverage };
}

/** Valor al vencimiento: { price, spot, fee } o null si no se puede determinar. */
function expiryValue(position, meta, snapshots, points) {
  const quantity = position.quantity;
  const lastSnapshot = [...snapshots]
    .filter((s) => meta.expiryMs != null && s.capturedAt <= meta.expiryMs && s.capturedAt >= meta.expiryMs - HOUR_MS)
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .pop();
  const snapSpot = lastSnapshot ? numOrNull(lastSnapshot.spot) : null;
  let price;
  let spot = snapSpot;
  if (position.closeReason === 'expiry' && position.exitPrice != null) {
    price = position.exitPrice;
    if (spot == null) spot = points.length ? points[points.length - 1].spot : null;
  } else {
    if (snapSpot == null) return null;
    price = meta.type === 'C' ? Math.max(snapSpot - meta.strike, 0) : Math.max(meta.strike - snapSpot, 0);
  }
  const fee = price > 0 ? exerciseFee({ spot, quantity, intrinsicValue: price }) : 0;
  return { price: price > 0 ? price : 0, spot, fee };
}

/** Recorre el camino con un escenario; devuelve la salida o null si falta el vencimiento. */
function runScenario(prepared, { tpPct, maxHoldHours, stopPct }) {
  const { position, path, expiry } = prepared;
  const entry = position.entryPrice;
  const tpLevel = tpPct == null ? null : entry * (1 + tpPct / 100);
  const stopLevel = stopPct == null ? null : entry * (1 - stopPct / 100);
  const timeLimit = maxHoldHours == null ? null : position.openedAt + maxHoldHours * HOUR_MS;
  let timeReached = false;
  let exit = null;
  for (const p of path) {
    if (timeLimit != null && p.at >= timeLimit) timeReached = true;
    if (p.bid == null) continue;
    if (tpLevel != null && p.bid >= tpLevel) exit = { price: tpLevel, at: p.at, spot: p.spot };
    else if (stopLevel != null && p.bid <= stopLevel) exit = { price: p.bid, at: p.at, spot: p.spot };
    else if (timeReached) exit = { price: p.bid, at: p.at, spot: p.spot };
    if (exit) {
      exit.fee = tradeFee({ spot: exit.spot, quantity: position.quantity, price: exit.price });
      break;
    }
  }
  if (!exit) {
    if (!expiry) return null;
    exit = { price: expiry.price, at: prepared.expiryMs, spot: expiry.spot, fee: expiry.fee };
  }
  const pnl = (exit.price - entry) * position.quantity - prepared.entryFee - exit.fee;
  return { pnl, holdMs: Math.max(0, exit.at - position.openedAt) };
}

function prepare(position, samples, snapshots) {
  const meta = parseSymbol(position.symbol);
  const expiryMs = meta ? meta.expiryMs : null;
  const { points, coverage } = buildPath(position, samples.get(position.id) || [], snapshots.get(position.symbol) || [], expiryMs);
  const expiry = meta && coverage !== 'none' ? expiryValue(position, meta, snapshots.get(position.symbol) || [], points) : null;
  const firstSpot = points.find((p) => p.spot != null)?.spot ?? null;
  const entryFee = position.entryFeeUsdt != null
    ? position.entryFeeUsdt
    : (firstSpot != null ? tradeFee({ spot: firstSpot, quantity: position.quantity, price: position.entryPrice }) : 0);
  return { position, path: points, coverage, expiry, expiryMs, entryFee };
}

function round(n, decimals = 6) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * @param {object} args
 * @param {Array} args.positions posiciones cerradas y compradas (ya filtradas)
 * @param {Map<number, Array>} args.samples muestras por minuto por posición
 * @param {Map<string, Array>} args.snapshots snapshots horarios por símbolo
 */
function simulateExits({ positions, samples = new Map(), snapshots = new Map() }) {
  const prepared = positions.map((p) => prepare(p, samples, snapshots));
  const coverage = { positions: prepared.length, minute: 0, hourly: 0, none: 0, incomplete: 0 };
  for (const p of prepared) {
    coverage[p.coverage] += 1;
    if (p.coverage !== 'none' && !p.expiry) coverage.incomplete += 1;
  }
  const usable = prepared.filter((p) => p.coverage !== 'none');

  const actual = { pnlUsdt: 0, trades: positions.length, wins: 0 };
  for (const p of positions) {
    const pnl = Number(p.pnlUsdt) || 0;
    actual.pnlUsdt += pnl;
    if (pnl > 0) actual.wins += 1;
  }
  actual.pnlUsdt = round(actual.pnlUsdt);

  const scenarios = [];
  for (const tpPct of TP_GRID) {
    for (const maxHoldHours of MAX_HOLD_GRID) {
      for (const stopPct of STOP_GRID) {
        let pnl = 0; let trades = 0; let wins = 0; let holdMs = 0; let incomplete = 0;
        for (const p of usable) {
          const r = runScenario(p, { tpPct, maxHoldHours, stopPct });
          if (!r) { incomplete += 1; continue; }
          pnl += r.pnl; trades += 1; holdMs += r.holdMs;
          if (r.pnl > 0) wins += 1;
        }
        scenarios.push({
          tpPct, maxHoldHours, stopPct,
          pnlUsdt: round(pnl), trades, wins,
          avgHoldMinutes: trades ? round(holdMs / trades / MINUTE_MS, 2) : 0,
          incomplete,
        });
      }
    }
  }
  const best = [...scenarios]
    .sort((a, b) => b.pnlUsdt - a.pnlUsdt || b.wins - a.wins || a.avgHoldMinutes - b.avgHoldMinutes)
    .slice(0, BEST_COUNT);
  return { coverage, actual, scenarios, best };
}

module.exports = { simulateExits, buildPath, expiryValue, runScenario, TP_GRID, MAX_HOLD_GRID, STOP_GRID };
