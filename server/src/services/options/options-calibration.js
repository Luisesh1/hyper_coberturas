/**
 * Calibración del backtest sintético: empareja los ciclos del backtest con las
 * posiciones de sombra reales y resume la divergencia. Módulo puro (sin E/S).
 */
const { parseSymbol } = require('./options-utils');

const PAIR_TOLERANCE_MS = 30 * 60_000;
// Patas de un mismo ciclo se abren en el mismo instante; margen para el reloj del bot.
const GROUP_GAP_MS = 60_000;

const sum = (items, pick) => items.reduce((a, x) => a + (Number(pick(x)) || 0), 0);
const underlyingOf = (symbol) => parseSymbol(symbol)?.underlying || null;

/** Agrupa posiciones de sombra en operaciones (conjuntos de patas abiertas a la vez). */
function groupShadowTrades(positions) {
  const sorted = [...positions].sort((a, b) => a.openedAt - b.openedAt || a.id - b.id);
  const groups = [];
  for (const p of sorted) {
    const under = underlyingOf(p.symbol);
    const g = groups.find((x) => x.underlying === under && p.openedAt - x.lastOpenedAt <= GROUP_GAP_MS);
    if (g) {
      g.positions.push(p);
      g.lastOpenedAt = p.openedAt;
    } else {
      groups.push({ underlying: under, openedAt: p.openedAt, lastOpenedAt: p.openedAt, positions: [p] });
    }
  }
  return groups.map((g) => {
    const open = g.positions.some((p) => p.closedAt == null);
    return {
      underlying: g.underlying,
      openedAt: g.openedAt,
      closedAt: open ? null : Math.max(...g.positions.map((p) => p.closedAt)),
      closeReason: g.positions.find((p) => p.closeReason)?.closeReason || (open ? 'open' : null),
      pnlUsdt: sum(g.positions, (p) => p.pnlUsdt),
      feesUsdt: sum(g.positions, (p) => p.feesUsdt),
      legs: g.positions.map((p) => ({
        symbol: p.symbol, side: p.side, quantity: p.quantity, price: p.entryPrice, exitPrice: p.exitPrice ?? null,
      })),
    };
  });
}

function backtestTrades(cycles) {
  return cycles.map((c) => ({
    underlying: underlyingOf(c.legs?.[0]?.symbol),
    openedAt: c.openedAt,
    closedAt: c.exitAt ?? null,
    closeReason: c.exitReason || null,
    pnlUsdt: Number(c.pnlUsdt) || 0,
    feesUsdt: Number(c.feesUsdt) || 0,
    legs: (c.legs || []).map((l) => ({ ...l, exitPrice: l.exitPrice ?? null })),
  }));
}

/** Error medio (%) del precio sintético frente al real en las patas comunes (símbolo + lado). */
function entryErrorPct(synthetic, real) {
  const errors = [];
  const used = new Set();
  for (const leg of synthetic.legs) {
    const i = real.legs.findIndex((r, idx) => !used.has(idx) && r.symbol === leg.symbol && r.side === leg.side);
    if (i < 0) continue;
    used.add(i);
    const ref = Number(real.legs[i].price);
    if (ref > 0) errors.push(((Number(leg.price) - ref) / ref) * 100);
  }
  return errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;
}

/**
 * Empareja ciclos del backtest con posiciones de sombra: mismo subyacente y
 * apertura a +-tolerancia. Asignación voraz por menor distancia temporal.
 */
function pairTrades({ cycles, positions, toleranceMs = PAIR_TOLERANCE_MS }) {
  const bt = backtestTrades(cycles || []);
  const sh = groupShadowTrades(positions || []);
  const candidates = [];
  bt.forEach((b, i) => sh.forEach((s, j) => {
    const dt = Math.abs(b.openedAt - s.openedAt);
    if (b.underlying && b.underlying === s.underlying && dt <= toleranceMs) candidates.push({ i, j, dt });
  }));
  candidates.sort((a, b) => a.dt - b.dt || a.i - b.i || a.j - b.j);
  const usedB = new Set();
  const usedS = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedB.has(c.i) || usedS.has(c.j)) continue;
    usedB.add(c.i);
    usedS.add(c.j);
    pairs.push({
      underlying: bt[c.i].underlying,
      symbols: sh[c.j].legs.map((l) => l.symbol),
      entryDeltaMs: bt[c.i].openedAt - sh[c.j].openedAt,
      entryErrorPct: entryErrorPct(bt[c.i], sh[c.j]),
      backtest: bt[c.i],
      shadow: sh[c.j],
    });
  }
  pairs.sort((a, b) => a.shadow.openedAt - b.shadow.openedAt);
  return {
    pairs,
    backtestOnly: bt.filter((_, i) => !usedB.has(i)),
    shadowOnly: sh.filter((_, j) => !usedS.has(j)),
  };
}

const round = (v, d = 4) => (v == null ? v : Math.round(v * 10 ** d) / 10 ** d);

function summarize({ pairs, backtestOnly, shadowOnly }) {
  const btAll = [...pairs.map((p) => p.backtest), ...backtestOnly];
  const shAll = [...pairs.map((p) => p.shadow), ...shadowOnly];
  const errors = pairs.map((p) => p.entryErrorPct).filter((e) => e != null);
  return {
    pairs: pairs.length,
    backtestOnly: backtestOnly.length,
    shadowOnly: shadowOnly.length,
    backtestPnlUsdt: round(sum(btAll, (t) => t.pnlUsdt)),
    shadowPnlUsdt: round(sum(shAll, (t) => t.pnlUsdt)),
    meanEntryErrorPct: errors.length ? round(errors.reduce((a, b) => a + b, 0) / errors.length) : null,
    meanAbsEntryErrorPct: errors.length ? round(errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length) : null,
    backtestFeesUsdt: round(sum(btAll, (t) => t.feesUsdt)),
    shadowFeesUsdt: round(sum(shAll, (t) => t.feesUsdt)),
  };
}

const day = (ms) => (ms == null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));
const usd = (v) => (v == null ? '-' : Number(v).toFixed(2));
const px = (v) => (v == null ? 'abierta' : Number(v).toFixed(2));
const legsText = (t) => t.legs.map((l) => `${l.side} ${l.symbol} ${px(l.price)}->${px(l.exitPrice)}`).join('; ');
const pct = (v) => (v == null ? 'n/d' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

/** Une los resultados de varios subyacentes (pares y solo-lado) en uno. */
function mergeResults(results) {
  return {
    pairs: results.flatMap((r) => r.pairs).sort((a, b) => a.shadow.openedAt - b.shadow.openedAt),
    backtestOnly: results.flatMap((r) => r.backtestOnly),
    shadowOnly: results.flatMap((r) => r.shadowOnly),
  };
}

function parseDay(value, name) {
  if (value == null) return null;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${name} debe ser YYYY-MM-DD`);
  return ms;
}

function parseArgs(argv) {
  const args = { json: false };
  const valued = ['--strategy', '--since', '--until', '--source', '--underlying'];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (valued.includes(a)) {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) throw new Error(`Falta el valor de ${a}`);
      args[a.slice(2)] = v;
      i += 1;
    } else throw new Error(`Argumento desconocido: ${a}`);
  }
  if (!/^\d+$/.test(String(args.strategy || ''))) throw new Error('Falta --strategy <id>');
  if (args.underlying) args.underlying = args.underlying.toUpperCase();
  return args;
}

function formatReport({ strategyId, from, until, summary, byUnderlying, pairs, backtestOnly, shadowOnly }) {
  const lines = [`Calibración del backtest - Estrategia ${strategyId}`];
  if (from != null) lines.push(`Periodo: ${day(from)} a ${day(until)} UTC`);
  lines.push('', 'Pares (sintético vs sombra):');
  for (const p of pairs) {
    lines.push(
      `- ${p.underlying} ${p.symbols.join(' / ')} | entrada ${day(p.shadow.openedAt)} | prima sintética vs real: ${pct(p.entryErrorPct)}`,
      `    backtest: ${legsText(p.backtest)} | salida ${day(p.backtest.closedAt)} (${p.backtest.closeReason || '-'}) P&L ${usd(p.backtest.pnlUsdt)}`,
      `    sombra:   ${legsText(p.shadow)} | salida ${day(p.shadow.closedAt)} (${p.shadow.closeReason || '-'}) P&L ${usd(p.shadow.pnlUsdt)}`,
    );
  }
  if (!pairs.length) lines.push('- (ninguno)');
  if (backtestOnly.length) lines.push('', 'Solo backtest:', ...backtestOnly.map((t) => `- ${t.underlying} ${day(t.openedAt)} P&L ${usd(t.pnlUsdt)}`));
  if (shadowOnly.length) lines.push('', 'Solo sombra:', ...shadowOnly.map((t) => `- ${t.underlying} ${day(t.openedAt)} P&L ${usd(t.pnlUsdt)}`));
  lines.push(
    '', 'Resumen:',
    `Pares: ${summary.pairs} | solo backtest: ${summary.backtestOnly} | solo sombra: ${summary.shadowOnly}`,
    `P&L total: backtest ${usd(summary.backtestPnlUsdt)} | sombra ${usd(summary.shadowPnlUsdt)} USDT`,
    `Error medio de prima de entrada: ${pct(summary.meanEntryErrorPct)} (absoluto ${pct(summary.meanAbsEntryErrorPct)})`,
    `Comisiones: backtest ${usd(summary.backtestFeesUsdt)} | sombra ${usd(summary.shadowFeesUsdt)} USDT`,
  );
  if (byUnderlying && Object.keys(byUnderlying).length > 1) {
    lines.push('', 'Por subyacente:');
    for (const [u, s] of Object.entries(byUnderlying)) {
      lines.push(`- ${u}: pares ${s.pairs}, solo backtest ${s.backtestOnly}, solo sombra ${s.shadowOnly}, P&L backtest ${usd(s.backtestPnlUsdt)} | sombra ${usd(s.shadowPnlUsdt)}, error prima ${pct(s.meanEntryErrorPct)}`);
    }
  }
  return lines.join('\n');
}

module.exports = { mergeResults, parseDay, parseArgs, pairTrades, summarize, groupShadowTrades, formatReport, PAIR_TOLERANCE_MS };
