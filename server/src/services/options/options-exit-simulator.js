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
// Un precio <= 0 de un snapshot es un libro vacío, no un precio real.
const positiveOrNull = (v) => {
  const n = numOrNull(v);
  return n != null && n > 0 ? n : null;
};

/** Spot del punto del camino con spot más cercano en el tiempo a `at`. */
function nearestSpot(points, at) {
  let best = null;
  for (const p of points) {
    if (p.spot == null) continue;
    if (best == null || Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
  }
  return best ? best.spot : null;
}

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
    .map((s) => ({ at: s.capturedAt, bid: positiveOrNull(s.bid), spot: numOrNull(s.spot) }));
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
    if (spot == null) spot = nearestSpot(points, meta.expiryMs);
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
    if (tpLevel != null && p.bid >= tpLevel) exit = { price: tpLevel, at: p.at, spot: p.spot ?? nearestSpot(path, p.at) };
    else if (stopLevel != null && p.bid <= stopLevel) exit = { price: p.bid, at: p.at, spot: p.spot ?? nearestSpot(path, p.at) };
    else if (timeReached) exit = { price: p.bid, at: p.at, spot: p.spot ?? nearestSpot(path, p.at) };
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

/**
 * Primer índice de `path` (con bid) que cumple cada nivel; Infinity si ninguno.
 * `up`: TP (bid >= nivel, niveles de menor a mayor); si no, stop (bid <= nivel,
 * de mayor a menor). Ordenados así, una sola pasada basta para todos.
 */
function firstCrossings(path, levels, up) {
  const hits = up ? (bid, level) => bid >= level : (bid, level) => bid <= level;
  const order = levels
    .map((level, k) => ({ level, k }))
    .filter((x) => x.level != null && !Number.isNaN(x.level))
    .sort((a, b) => (up ? a.level - b.level : b.level - a.level));
  const out = levels.map(() => Infinity);
  let next = 0;
  for (let i = 0; i < path.length && next < order.length; i += 1) {
    const bid = path[i].bid;
    if (bid == null) continue;
    while (next < order.length && hits(bid, order[next].level)) {
      out[order[next].k] = i;
      next += 1;
    }
  }
  return out;
}

/**
 * Precalcula, en una pasada por umbral ordenado, el primer punto que alcanza
 * cada TP y cada stop de la rejilla y, para cada tiempo máximo, el primer
 * punto con bid pasado el límite. Cada escenario se resuelve luego en O(1)
 * con las mismas reglas que `runScenario` (en el mismo punto: TP > stop > tiempo).
 */
function scenarioResolver(prepared) {
  const { position, path, expiry } = prepared;
  const entry = position.entryPrice;
  const tpLevels = TP_GRID.map((pct) => (pct == null ? null : entry * (1 + pct / 100)));
  const stopLevels = STOP_GRID.map((pct) => (pct == null ? null : entry * (1 - pct / 100)));
  const tpIdx = firstCrossings(path, tpLevels, true);
  const stopIdx = firstCrossings(path, stopLevels, false);
  const holdLimits = MAX_HOLD_GRID.map((h) => (h == null ? null : position.openedAt + h * HOUR_MS));
  const timeIdx = holdLimits.map(() => Infinity);
  const pending = holdLimits
    .map((limit, k) => ({ limit, k }))
    .filter((x) => x.limit != null)
    .sort((a, b) => a.limit - b.limit);
  let next = 0;
  for (let i = 0; i < path.length && next < pending.length; i += 1) {
    if (path[i].bid == null) continue;
    while (next < pending.length && path[i].at >= pending[next].limit) {
      timeIdx[pending[next].k] = i;
      next += 1;
    }
  }
  const spotAt = new Map();
  const spotOf = (i) => {
    if (!spotAt.has(i)) spotAt.set(i, path[i].spot ?? nearestSpot(path, path[i].at));
    return spotAt.get(i);
  };
  const finish = (price, at, fee) => ({
    pnl: (price - entry) * position.quantity - prepared.entryFee - fee,
    holdMs: Math.max(0, at - position.openedAt),
  });
  // Pocas salidas distintas por posición: al nivel de cada TP, al bid de un
  // punto o al vencimiento. Se calculan una vez (resultados de solo lectura).
  const atTp = new Map();
  const atBid = new Map();
  let atExpiry;
  return (tpK, holdK, stopK) => {
    const t = tpIdx[tpK]; const s = stopIdx[stopK]; const h = timeIdx[holdK];
    const i = Math.min(t, s, h);
    if (i === Infinity) {
      if (atExpiry === undefined) atExpiry = expiry ? finish(expiry.price, prepared.expiryMs, expiry.fee) : null;
      return atExpiry;
    }
    const p = path[i];
    if (t === i) {
      if (!atTp.has(tpK)) {
        const price = tpLevels[tpK];
        atTp.set(tpK, finish(price, p.at, tradeFee({ spot: spotOf(i), quantity: position.quantity, price })));
      }
      return atTp.get(tpK);
    }
    if (!atBid.has(i)) atBid.set(i, finish(p.bid, p.at, tradeFee({ spot: spotOf(i), quantity: position.quantity, price: p.bid })));
    return atBid.get(i);
  };
}

function prepare(position, samples, snapshots) {
  const meta = parseSymbol(position.symbol);
  const expiryMs = meta ? meta.expiryMs : null;
  const { points, coverage } = buildPath(position, samples.get(position.id) || [], snapshots.get(position.symbol) || [], expiryMs);
  const expiry = meta && coverage !== 'none' ? expiryValue(position, meta, snapshots.get(position.symbol) || [], points) : null;
  const firstSpot = nearestSpot(points, position.openedAt);
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
  const resolvers = usable.map(scenarioResolver);

  const realPnl = (p) => Number(p.pnlUsdt) || 0;
  const tally = (list) => {
    const t = { pnlUsdt: 0, trades: list.length, wins: 0 };
    for (const p of list) {
      t.pnlUsdt += realPnl(p);
      if (realPnl(p) > 0) t.wins += 1;
    }
    t.pnlUsdt = round(t.pnlUsdt);
    return t;
  };
  const actual = tally(positions);
  const actualCovered = tally(usable.map((p) => p.position));

  const scenarios = [];
  TP_GRID.forEach((tpPct, tpK) => {
    MAX_HOLD_GRID.forEach((maxHoldHours, holdK) => {
      STOP_GRID.forEach((stopPct, stopK) => {
        let pnl = 0; let trades = 0; let wins = 0; let holdMs = 0; let incomplete = 0;
        let actualPnl = 0; let actualWins = 0;
        for (let j = 0; j < usable.length; j += 1) {
          const p = usable[j];
          const r = resolvers[j](tpK, holdK, stopK);
          if (!r) { incomplete += 1; continue; }
          pnl += r.pnl; trades += 1; holdMs += r.holdMs;
          if (r.pnl > 0) wins += 1;
          actualPnl += realPnl(p.position);
          if (realPnl(p.position) > 0) actualWins += 1;
        }
        scenarios.push({
          tpPct, maxHoldHours, stopPct,
          pnlUsdt: round(pnl), trades, wins,
          avgHoldMinutes: trades ? round(holdMs / trades / MINUTE_MS, 2) : 0,
          incomplete,
          // Lo real de exactamente las posiciones que usó este escenario.
          actualPnlUsdt: round(actualPnl), actualWins,
        });
      });
    });
  });
  const best = [...scenarios]
    .sort((a, b) => b.pnlUsdt - a.pnlUsdt || b.wins - a.wins || a.avgHoldMinutes - b.avgHoldMinutes)
    .slice(0, BEST_COUNT);
  return { coverage, actual, actualCovered, scenarios, best };
}

module.exports = { simulateExits, buildPath, expiryValue, runScenario, prepare, TP_GRID, MAX_HOLD_GRID, STOP_GRID };
