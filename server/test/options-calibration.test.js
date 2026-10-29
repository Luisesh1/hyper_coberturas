const test = require('node:test');
const assert = require('node:assert/strict');

const { pairTrades, summarize, groupShadowTrades, formatReport } = require('../src/services/options/options-calibration');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0);
const SYM = 'BTC-261030-70000-P';

const cycle = (over = {}) => ({
  openedAt: T0, exitAt: T0 + 3_600_000, exitReason: 'take_profit', pnlUsdt: 10, feesUsdt: 2,
  legs: [{ symbol: SYM, side: 'SELL', quantity: 0.1, price: 110 }], ...over,
});
const pos = (over = {}) => ({
  id: 1, symbol: SYM, side: 'SELL', quantity: 0.1, entryPrice: 100, exitPrice: 50,
  openedAt: T0 + 5 * MIN, closedAt: T0 + 4_000_000, pnlUsdt: 8, feesUsdt: 1.5, closeReason: 'tp', ...over,
});

test('groupShadowTrades agrupa patas abiertas a la vez y separa el resto', () => {
  const trades = groupShadowTrades([
    pos({ id: 1 }), pos({ id: 2, symbol: 'BTC-261030-65000-P', side: 'BUY', openedAt: T0 + 5 * MIN + 2000 }),
    pos({ id: 3, openedAt: T0 + 5 * 3_600_000 }),
  ]);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].legs.length, 2);
  assert.equal(trades[0].pnlUsdt, 16);
  assert.equal(trades[0].feesUsdt, 3);
  assert.equal(trades[0].underlying, 'BTC');
});

test('pairTrades empareja por subyacente y entrada a +-30 min y calcula el error de prima', () => {
  const { pairs, backtestOnly, shadowOnly } = pairTrades({ cycles: [cycle()], positions: [pos()] });
  assert.equal(pairs.length, 1);
  assert.equal(backtestOnly.length, 0);
  assert.equal(shadowOnly.length, 0);
  assert.equal(pairs[0].underlying, 'BTC');
  assert.ok(Math.abs(pairs[0].entryErrorPct - 10) < 1e-9);
  assert.equal(pairs[0].backtest.pnlUsdt, 10);
  assert.equal(pairs[0].shadow.pnlUsdt, 8);
  assert.equal(pairs[0].shadow.closeReason, 'tp');
  assert.equal(pairs[0].backtest.closeReason, 'take_profit');
  assert.equal(pairs[0].backtest.closedAt, T0 + 3_600_000);
});

test('fuera de 30 min no empareja: queda como solo-backtest y solo-sombra', () => {
  const { pairs, backtestOnly, shadowOnly } = pairTrades({
    cycles: [cycle()], positions: [pos({ openedAt: T0 + 31 * MIN })],
  });
  assert.equal(pairs.length, 0);
  assert.equal(backtestOnly.length, 1);
  assert.equal(shadowOnly.length, 1);
});

test('distinto subyacente no empareja y cada lado se usa una sola vez', () => {
  const eth = pos({ symbol: 'ETH-261030-3000-P' });
  assert.equal(pairTrades({ cycles: [cycle()], positions: [eth] }).pairs.length, 0);
  const r = pairTrades({
    cycles: [cycle(), cycle({ openedAt: T0 + 10 * MIN })],
    positions: [pos({ openedAt: T0 + 9 * MIN })],
  });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].backtest.openedAt, T0 + 10 * MIN);
  assert.equal(r.backtestOnly.length, 1);
});

test('entryErrorPct es null si no hay patas comunes', () => {
  const { pairs } = pairTrades({ cycles: [cycle()], positions: [pos({ symbol: 'BTC-261030-60000-P' })] });
  assert.equal(pairs[0].entryErrorPct, null);
});

test('summarize totaliza P&L, comisiones y error medio', () => {
  const r = pairTrades({
    cycles: [cycle(), cycle({ openedAt: T0 + 24 * 3_600_000, pnlUsdt: -5, feesUsdt: 1 })],
    positions: [pos(), pos({ id: 9, openedAt: T0 + 48 * 3_600_000, pnlUsdt: 3, feesUsdt: 0.5 })],
  });
  const s = summarize(r);
  assert.equal(s.pairs, 1);
  assert.equal(s.backtestOnly, 1);
  assert.equal(s.shadowOnly, 1);
  assert.equal(s.backtestPnlUsdt, 5);
  assert.equal(s.shadowPnlUsdt, 11);
  assert.equal(s.backtestFeesUsdt, 3);
  assert.equal(s.shadowFeesUsdt, 2);
  assert.ok(Math.abs(s.meanEntryErrorPct - 10) < 1e-9);
});

test('summarize sin pares devuelve error medio null', () => {
  const s = summarize(pairTrades({ cycles: [], positions: [] }));
  assert.equal(s.pairs, 0);
  assert.equal(s.meanEntryErrorPct, null);
});

test('formatReport produce texto legible', () => {
  const r = pairTrades({ cycles: [cycle()], positions: [pos()] });
  const text = formatReport({ strategyId: 7, summary: summarize(r), ...r });
  assert.match(text, /Estrategia 7/);
  assert.match(text, /BTC/);
  assert.match(text, /Pares: 1/);
});
