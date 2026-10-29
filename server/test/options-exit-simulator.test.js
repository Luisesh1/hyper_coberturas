const test = require('node:test');
const assert = require('node:assert/strict');

const { simulateExits, buildPath, runScenario } = require('../src/services/options/options-exit-simulator');
const { createOptionsAutoTradingService } = require('../src/services/options/options-auto-trading.service');
const { tradeFee, exerciseFee, HOUR_MS } = require('../src/services/options/options-utils');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

const SYMBOL = 'BTC-261101-60000-C';
const EXPIRY = Date.UTC(2026, 10, 1, 8);
const OPEN = Date.UTC(2026, 9, 31, 8);
const MIN = 60 * 1000;
const SPOT = 60000;

const position = (over = {}) => ({
  id: 1, mode: 'shadow', side: 'BUY', symbol: SYMBOL, quantity: 1, entryPrice: 100, exitPrice: 90,
  openedAt: OPEN, closedAt: OPEN + 3 * HOUR_MS, pnlUsdt: -20, entryFeeUsdt: 1, closeReason: 'manual', ...over,
});
const sample = (minutes, bid, spot = SPOT) => ({ at: OPEN + minutes * MIN, bid, ask: bid + 1, spot });
const snap = (at, bid, spot = SPOT) => ({ symbol: SYMBOL, capturedAt: at, bid, ask: bid + 1, spot });
const scenario = (tpPct = null, maxHoldHours = null, stopPct = null) => ({ tpPct, maxHoldHours, stopPct });
const find = (res, tp, hold, stop) => res.scenarios.find((s) => s.tpPct === tp && s.maxHoldHours === hold && s.stopPct === stop);

function run(pos, samples, snaps) {
  return simulateExits({ positions: [pos], samples: new Map([[pos.id, samples]]), snapshots: new Map([[pos.symbol, snaps]]) });
}

test('TP alcanzado sale al nivel exacto, no al bid del punto', () => {
  const res = run(position(), [sample(10, 130), sample(20, 180)], []);
  const s = find(res, 40, null, null);
  const fee = tradeFee({ spot: SPOT, quantity: 1, price: 140 });
  assert.equal(s.trades, 1);
  assert.ok(Math.abs(s.pnlUsdt - (40 - 1 - fee)) < 1e-6);
  assert.equal(s.wins, 1);
  assert.equal(s.avgHoldMinutes, 20);
});

test('stop sale al bid del punto', () => {
  const res = run(position(), [sample(10, 90), sample(20, 60)], []);
  const s = find(res, null, null, 30);
  const fee = tradeFee({ spot: SPOT, quantity: 1, price: 60 });
  assert.ok(Math.abs(s.pnlUsdt - (-40 - 1 - fee)) < 1e-6);
});

test('tiempo máximo sale al primer punto con bid pasado el límite', () => {
  const path = [sample(30, 110), { at: OPEN + HOUR_MS, bid: null, ask: null, spot: SPOT }, sample(90, 120)];
  const res = run(position(), path, []);
  const s = find(res, null, 1, null);
  const fee = tradeFee({ spot: SPOT, quantity: 1, price: 120 });
  assert.ok(Math.abs(s.pnlUsdt - (20 - 1 - fee)) < 1e-6);
  assert.equal(s.avgHoldMinutes, 90);
});

test('en el mismo punto TP gana al tiempo y stop gana al tiempo (TP y stop no pueden coincidir)', () => {
  const prepared = (path) => ({ position: position(), path, expiry: { price: 0, spot: SPOT, fee: 0 }, expiryMs: EXPIRY, entryFee: 0 });
  // Con bid alto cumple TP y tiempo: gana TP (nivel exacto 120).
  const tp = runScenario(prepared([{ at: OPEN + HOUR_MS, bid: 500, spot: SPOT }]), scenario(20, 1, 30));
  assert.ok(Math.abs(tp.pnl - (20 - tradeFee({ spot: SPOT, quantity: 1, price: 120 }))) < 1e-6);
  // Con bid bajo cumple stop y tiempo: gana stop (bid del punto).
  const stop = runScenario(prepared([{ at: OPEN + HOUR_MS, bid: 50, spot: SPOT }]), scenario(20, 1, 30));
  assert.ok(Math.abs(stop.pnl - (-50 - tradeFee({ spot: SPOT, quantity: 1, price: 50 }))) < 1e-6);
  // TP y stop imposibles a la vez salvo entry degenerado; solo tiempo -> bid.
  const time = runScenario(prepared([{ at: OPEN + HOUR_MS, bid: 105, spot: SPOT }]), scenario(20, 1, 30));
  assert.ok(Math.abs(time.pnl - (5 - tradeFee({ spot: SPOT, quantity: 1, price: 105 }))) < 1e-6);
});

test('vencimiento OTM vale 0 sin comisión de ejercicio', () => {
  const res = run(position(), [sample(10, 95)], [snap(EXPIRY - 30 * MIN, 0, 59000)]);
  const s = find(res, null, null, null);
  assert.ok(Math.abs(s.pnlUsdt - (-100 - 1)) < 1e-6);
  assert.equal(s.avgHoldMinutes, (EXPIRY - OPEN) / MIN);
});

test('vencimiento ITM cobra el intrínseco con exerciseFee', () => {
  const res = run(position(), [sample(10, 95)], [snap(EXPIRY - 30 * MIN, 400, 60500)]);
  const s = find(res, null, null, null);
  const fee = exerciseFee({ spot: 60500, quantity: 1, intrinsicValue: 500 });
  assert.ok(fee > 0);
  assert.ok(Math.abs(s.pnlUsdt - (400 - 1 - fee)) < 1e-6);
});

test('posición cerrada por vencimiento usa su exitPrice', () => {
  const pos = position({ closeReason: 'expiry', exitPrice: 300, closedAt: EXPIRY });
  const res = run(pos, [sample(10, 95)], []);
  assert.equal(res.coverage.incomplete, 0);
  const s = find(res, null, null, null);
  assert.ok(Math.abs(s.pnlUsdt - (200 - 1 - exerciseFee({ spot: SPOT, quantity: 1, intrinsicValue: 300 }))) < 1e-6);
});

test('sin snapshot cerca del vencimiento queda incomplete solo donde hace falta', () => {
  const res = run(position(), [sample(10, 150)], []);
  assert.equal(res.coverage.incomplete, 1);
  assert.equal(find(res, null, null, null).trades, 0);
  assert.equal(find(res, null, null, null).incomplete, 1);
  assert.equal(find(res, 20, null, null).trades, 1);
  assert.equal(find(res, 20, null, null).incomplete, 0);
});

test('mezcla minuto y horario: manda el minuto', () => {
  const closedAt = OPEN + 3 * HOUR_MS;
  const snaps = [snap(OPEN + HOUR_MS, 999), snap(OPEN + 2 * HOUR_MS, 999), snap(closedAt + HOUR_MS, 250), snap(OPEN - HOUR_MS, 5)];
  const { points, coverage } = buildPath(position(), [sample(30, 100), sample(120, 100)], snaps, EXPIRY);
  assert.equal(coverage, 'minute');
  // Antes de la primera muestra (a OPEN+30m) no hay snapshots; los horarios dentro del rango por minuto no cuentan; sí el posterior al cierre.
  assert.deepEqual(points.map((p) => p.bid), [100, 100, 250]);
});

test('snapshots horarios completan antes de la primera muestra por minuto', () => {
  const snaps = [snap(OPEN + 5 * MIN, 70), snap(OPEN + HOUR_MS, 999)];
  const { points } = buildPath(position(), [sample(30, 100)], snaps, EXPIRY);
  assert.deepEqual(points.map((p) => p.bid), [70, 100]);
});

test('cobertura hourly y posición none queda fuera de los escenarios', () => {
  const hourly = run(position(), [], [snap(OPEN + HOUR_MS, 200), snap(EXPIRY - HOUR_MS, 0, 59000)]);
  assert.deepEqual(hourly.coverage, { positions: 1, minute: 0, hourly: 1, none: 0, incomplete: 0 });
  assert.equal(find(hourly, 60, null, null).trades, 1);

  const none = run(position(), [], []);
  assert.deepEqual(none.coverage, { positions: 1, minute: 0, hourly: 0, none: 1, incomplete: 0 });
  assert.ok(none.scenarios.every((s) => s.trades === 0 && s.incomplete === 0));
  assert.deepEqual(none.actual, { pnlUsdt: -20, trades: 1, wins: 0 });
});

test('rejilla completa y best ordenado y de 10', () => {
  const res = run(position(), [sample(10, 130), sample(70, 60), sample(200, 400)], [snap(EXPIRY - HOUR_MS, 0, 59000)]);
  assert.equal(res.scenarios.length, 9 * 8 * 3);
  assert.equal(res.best.length, 10);
  for (let i = 1; i < res.best.length; i += 1) assert.ok(res.best[i - 1].pnlUsdt >= res.best[i].pnlUsdt);
  assert.equal(res.best[0].pnlUsdt, Math.max(...res.scenarios.map((s) => s.pnlUsdt)));
});

test('actual por escenario y actualCovered con posiciones cubiertas, none e incompletas', () => {
  const covered = position({ id: 1, pnlUsdt: 10 });
  const noSnap = position({ id: 2, pnlUsdt: -5 }); // cubierta pero sin vencimiento: incompleta
  const none = position({ id: 3, pnlUsdt: 100, symbol: 'BTC-261101-62000-C' });
  const res = simulateExits({
    positions: [covered, noSnap, none],
    samples: new Map([[1, [sample(10, 150)]], [2, [sample(10, 150)]]]),
    snapshots: new Map([[SYMBOL, [snap(EXPIRY - 30 * MIN, 0, 59000)]]]),
  });
  assert.deepEqual(res.actual, { pnlUsdt: 105, trades: 3, wins: 2 });
  assert.deepEqual(res.actualCovered, { pnlUsdt: 5, trades: 2, wins: 1 });
  const s = find(res, null, null, null);
  assert.equal(s.trades, 2);
  assert.equal(s.actualPnlUsdt, 5);
  assert.equal(s.actualWins, 1);

  const other = position({ id: 2, pnlUsdt: -5, symbol: 'BTC-261101-61000-C' });
  const res2 = simulateExits({
    positions: [covered, other],
    samples: new Map([[1, [sample(10, 150)]], [2, [sample(10, 150)]]]),
    snapshots: new Map([[SYMBOL, [snap(EXPIRY - 30 * MIN, 0, 59000)]]]),
  });
  const noTp = find(res2, null, null, null);
  assert.equal(noTp.trades, 1);
  assert.equal(noTp.incomplete, 1);
  assert.equal(noTp.actualPnlUsdt, 10);
  const tp = find(res2, 20, null, null);
  assert.equal(tp.trades, 2);
  assert.equal(tp.actualPnlUsdt, 5);
  assert.equal(res2.actualCovered.pnlUsdt, 5);
});

test('un punto sin spot usa el spot más cercano en el tiempo para la comisión', () => {
  const path = [{ at: OPEN + 10 * MIN, bid: 200, spot: null }, { at: OPEN + 20 * MIN, bid: 90, spot: 30000 }];
  const prepared = { position: position({ entryFeeUsdt: 0 }), path, expiry: { price: 0, spot: SPOT, fee: 0 }, expiryMs: EXPIRY, entryFee: 0 };
  const r = runScenario(prepared, scenario(20, null, null));
  const fee = tradeFee({ spot: 30000, quantity: 1, price: 120 });
  assert.ok(fee > 0);
  assert.ok(Math.abs(r.pnl - (20 - fee)) < 1e-6);

  // Entrada sin comisión guardada: spot más cercano a openedAt.
  const res = simulateExits({
    positions: [position({ entryFeeUsdt: null })],
    samples: new Map([[1, [{ at: OPEN + 10 * MIN, bid: 100, ask: 101, spot: null }, { at: OPEN + 20 * MIN, bid: 100, ask: 101, spot: 30000 }]]]),
    snapshots: new Map([[SYMBOL, [snap(EXPIRY - 30 * MIN, 0, 59000)]]]),
  });
  const entryFee = tradeFee({ spot: 30000, quantity: 1, price: 100 });
  assert.ok(Math.abs(find(res, null, null, null).pnlUsdt - (-100 - entryFee)) < 1e-6);
});

test('un bid 0 de un snapshot cuenta como ausente y no dispara el stop', () => {
  const { points } = buildPath(position(), [], [snap(OPEN + HOUR_MS, 0), snap(OPEN + 2 * HOUR_MS, 80)], EXPIRY);
  assert.deepEqual(points.map((p) => p.bid), [null, 80]);
  const res = run(position(), [], [snap(OPEN + HOUR_MS, 0), snap(EXPIRY - HOUR_MS, 0, 59000)]);
  const s = find(res, null, null, 30);
  // Sin bid válido nunca sale por stop: llega al vencimiento OTM (-100 - 1).
  assert.ok(Math.abs(s.pnlUsdt - (-101)) < 1e-6);
});

test('best desempata por wins y luego por menor avgHoldMinutes', () => {
  // Muchos escenarios empatan en pnl (p. ej. los que no llegan a salir antes del vencimiento).
  const res = run(position(), [sample(10, 105)], [snap(EXPIRY - HOUR_MS, 0, 59000)]);
  const tied = res.scenarios.filter((x) => x.pnlUsdt === res.best[0].pnlUsdt);
  assert.ok(tied.length > 1);
  const expected = [...tied].sort((a, b) => b.wins - a.wins || a.avgHoldMinutes - b.avgHoldMinutes);
  assert.deepEqual(res.best.slice(0, Math.min(10, tied.length)), expected.slice(0, 10));
  // Construcción directa: dos posiciones donde el empate se rompe por duración.
  const a = position({ id: 1 });
  const b = position({ id: 2 });
  const two = simulateExits({
    positions: [a, b],
    samples: new Map([[1, [sample(10, 130)]], [2, [sample(40, 130)]]]),
    snapshots: new Map([[SYMBOL, [snap(EXPIRY - HOUR_MS, 0, 59000)]]]),
  });
  for (let i = 1; i < two.best.length; i += 1) {
    const p = two.best[i - 1]; const q = two.best[i];
    assert.ok(p.pnlUsdt > q.pnlUsdt || (p.pnlUsdt === q.pnlUsdt && (p.wins > q.wins || (p.wins === q.wins && p.avgHoldMinutes <= q.avgHoldMinutes))));
  }
});

// ---------- servicio ----------

function makeService(extra = {}) {
  const repo = createFakeOptionsRepo();
  const premiumSamples = { listPremiumSamples: async (ids) => new Map(ids.map((id) => [id, [sample(10, 150)]])) };
  const ivSnapshots = { listBySymbols: async () => [snap(EXPIRY - HOUR_MS, 0, 59000)] };
  const service = createOptionsAutoTradingService({ repo, premiumSamples, ivSnapshots, now: () => 1234, alerts: { listAlerts: async () => [] }, ...extra });
  return { repo, service };
}

test('exitSimulation filtra por dueño, modo, lado, cierre y since', async () => {
  const { repo, service } = makeService();
  const bot = await repo.createStrategy({ userId: 7, name: 'b', template: 'alert_signal', underlying: 'BTC' });
  const { id: _id, ...rest } = position();
  const base = { strategyId: bot.id, userId: 7, ...rest };
  const keep = await repo.insertPosition({ ...base, feesUsdt: 1 });
  await repo.insertPosition({ ...base, mode: 'live' });
  await repo.insertPosition({ ...base, side: 'SELL' });
  await repo.insertPosition({ ...base, closedAt: null });
  await repo.insertPosition({ ...base, openedAt: OPEN - 1000 });

  const res = await service.exitSimulation(7, bot.id, { mode: 'shadow', since: String(OPEN) });
  assert.equal(res.mode, 'shadow');
  assert.equal(res.since, OPEN);
  assert.equal(res.generatedAt, 1234);
  assert.equal(res.coverage.positions, 1);
  assert.equal(res.coverage.minute, 1);
  assert.equal(res.actual.trades, 1);
  assert.ok(keep.id);
  assert.equal(res.scenarios.length, 216);

  await assert.rejects(() => service.exitSimulation(8, bot.id, {}), /no encontrado/i);
  await assert.rejects(() => service.exitSimulation(7, bot.id, { mode: 'x' }), /mode/);
});

