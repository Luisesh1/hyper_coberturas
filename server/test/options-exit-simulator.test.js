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

// ---------- equivalencia y escala ----------

/** Datos pseudoaleatorios reproducibles: caminos con huecos de bid/spot, snapshots y vencimientos. */
function randomBook(n, perPosition, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const positions = []; const samples = new Map(); const snapshots = new Map();
  for (let i = 0; i < n; i += 1) {
    const day = i % 5; const strike = 58000 + (i % 4) * 1000;
    const symbol = `BTC-2611${String(day + 1).padStart(2, '0')}-${strike}-${i % 3 ? 'C' : 'P'}`;
    const openedAt = OPEN - 12 * HOUR_MS + (i % 9) * HOUR_MS;
    const closedAt = openedAt + perPosition * MIN;
    const expiryClose = i % 11 === 0;
    positions.push({ id: i + 1, side: 'BUY', symbol, quantity: 0.01 + (i % 3) * 0.05, entryPrice: 80 + (i % 7) * 10,
      exitPrice: expiryClose ? 40 : 90, openedAt, closedAt, pnlUsdt: rnd() * 20 - 10,
      entryFeeUsdt: i % 2 ? null : 0.5, closeReason: expiryClose ? 'expiry' : 'manual' });
    const list = []; let bid = 80 + (i % 7) * 10;
    for (let k = 0; k < perPosition; k += 1) {
      bid = Math.max(1, bid * (1 + (rnd() - 0.5) * 0.12));
      list.push({ at: openedAt + k * MIN, bid: rnd() < 0.08 ? null : bid, spot: rnd() < 0.1 ? null : 60000 + rnd() * 500 });
    }
    if (i % 13 !== 0) samples.set(i + 1, list);
    if (!snapshots.has(symbol)) {
      const expiry = Date.UTC(2026, 10, day + 1, 8); const snaps = [];
      // Algunos símbolos sin snapshot cerca del vencimiento: escenarios incompletos.
      const last = day % 2 ? expiry : expiry - 5 * HOUR_MS;
      for (let t = openedAt - 2 * HOUR_MS; t <= last; t += HOUR_MS) snaps.push(snap(t, rnd() < 0.1 ? 0 : 20 + rnd() * 200, 59000 + rnd() * 2000));
      snapshots.set(symbol, snaps.map((s) => ({ ...s, symbol })));
    }
  }
  return { positions, samples, snapshots };
}

test('equivalencia: cada escenario coincide con recorrer el camino con runScenario', () => {
  const { prepare, TP_GRID, MAX_HOLD_GRID, STOP_GRID } = require('../src/services/options/options-exit-simulator');
  const book = randomBook(120, 300);
  const res = simulateExits(book);
  const usable = book.positions.map((p) => prepare(p, book.samples, book.snapshots)).filter((p) => p.coverage !== 'none');
  assert.ok(usable.length > 50);
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  let k = 0;
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
        const s = res.scenarios[k];
        k += 1;
        assert.deepEqual([s.tpPct, s.maxHoldHours, s.stopPct], [tpPct, maxHoldHours, stopPct]);
        assert.equal(s.pnlUsdt, r6(pnl));
        assert.equal(s.trades, trades);
        assert.equal(s.wins, wins);
        assert.equal(s.incomplete, incomplete);
        assert.equal(s.avgHoldMinutes, trades ? Math.round((holdMs / trades / MIN) * 100) / 100 : 0);
      }
    }
  }
  // Hay escenarios de cada tipo de salida: no es una comparación trivial.
  assert.ok(res.scenarios.some((s) => s.incomplete > 0));
  assert.ok(new Set(res.scenarios.map((s) => s.pnlUsdt)).size > 100);
});

test('escala: 2000 posiciones × 480 muestras sin bloquear segundos el event loop', () => {
  const book = randomBook(2000, 480, 11);
  const t0 = process.hrtime.bigint();
  const res = simulateExits(book);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(res.scenarios.length, 216);
  // Antes ~3,5 s en esta máquina; ahora ~0,4 s. Margen amplio para CI cargada.
  assert.ok(ms < 2500, `tardó ${ms.toFixed(0)} ms`);
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


test('exitSimulation: solo las 1000 posiciones cerradas más recientes y truncated', async () => {
  const { repo, service } = makeService();
  const bot = await repo.createStrategy({ userId: 7, name: 'b', template: 'alert_signal', underlying: 'BTC' });
  const { id: _id, ...rest } = position();
  for (let i = 0; i < 1003; i += 1) {
    await repo.insertPosition({ strategyId: bot.id, userId: 7, ...rest, openedAt: OPEN + i * MIN, closedAt: OPEN + i * MIN + HOUR_MS, pnlUsdt: i < 3 ? 1000 : -1 });
  }
  const res = await service.exitSimulation(7, bot.id, { mode: 'shadow' });
  assert.equal(res.truncated, true);
  assert.equal(res.coverage.positions, 1000);
  // Las 3 más antiguas (las de +1000) quedan fuera.
  assert.equal(res.actual.pnlUsdt, -1000);

  const small = makeService();
  const other = await small.repo.createStrategy({ userId: 7, name: 'b', template: 'alert_signal', underlying: 'BTC' });
  await small.repo.insertPosition({ strategyId: other.id, userId: 7, ...rest });
  assert.equal((await small.service.exitSimulation(7, other.id, {})).truncated, false);
});

test('exitSimulation: caché de 60 s por bot, modo y since', async () => {
  const clock = { now: 1000 };
  let loads = 0;
  const { repo, service } = makeService({
    now: () => clock.now,
    premiumSamples: { listPremiumSamples: async (ids) => { loads += 1; return new Map(ids.map((id) => [id, [sample(10, 150)]])); } },
  });
  const bot = await repo.createStrategy({ userId: 7, name: 'b', template: 'alert_signal', underlying: 'BTC' });
  const { id: _id, ...rest } = position();
  await repo.insertPosition({ strategyId: bot.id, userId: 7, ...rest });
  const first = await service.exitSimulation(7, bot.id, { mode: 'shadow' });
  clock.now += 59_000;
  assert.equal(await service.exitSimulation(7, bot.id, { mode: 'shadow' }), first);
  assert.equal(loads, 1);
  // Otro since u otro modo no comparten entrada.
  await service.exitSimulation(7, bot.id, { mode: 'shadow', since: String(OPEN) });
  await service.exitSimulation(7, bot.id, { mode: 'live' });
  assert.equal(loads, 2); // live sin posiciones no carga muestras
  // El dueño se sigue comprobando con la caché caliente.
  await assert.rejects(() => service.exitSimulation(8, bot.id, { mode: 'shadow' }), /no encontrado/i);
  clock.now += 2_000;
  const fresh = await service.exitSimulation(7, bot.id, { mode: 'shadow' });
  assert.notEqual(fresh, first);
  assert.equal(fresh.generatedAt, clock.now);
  assert.equal(loads, 3);
});
