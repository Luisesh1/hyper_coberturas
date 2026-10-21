const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeribitOptionsService } = require('../src/services/deribit/deribit-options.service');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 12); // 2026-10-21
const EXP = Date.UTC(2026, 9, 2, 8); // viernes 2 OCT 2026

function fakes({ existing = [], failOn = null, live = [] } = {}) {
  const calls = { getInstrument: [], getInstruments: 0, getChartData: [] };
  const client = {
    async getInstrument(name) {
      calls.getInstrument.push(name);
      if (failOn && name === failOn) throw new Error('red caida');
      return existing.includes(name) ? { instrument_name: name } : null;
    },
    async getInstruments() {
      calls.getInstruments++;
      return live.map((n) => ({ instrument_name: n }));
    },
    async getChartData(args) {
      calls.getChartData.push(args);
      const base = args.instrument.endsWith('PERPETUAL') ? 2000 : 0.01;
      return {
        ticks: [Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2)],
        open: [base, base], high: [base, base], low: [base, base], close: [base, base * 2], volume: [1, 1],
      };
    },
  };
  const marketData = {
    async getCandles(_asset, _tf, { startTime, endTime }) {
      const out = [];
      for (let t = Math.ceil(startTime / DAY) * DAY; t <= endTime; t += DAY) {
        out.push({ time: t, open: 2418, high: 2418, low: 2418, close: 2418, volume: 1 });
      }
      return out;
    },
  };
  return { client, marketData, calls };
}

async function settle(svc, u, code) {
  for (let i = 0; i < 200; i++) {
    const j = svc.getStrikesJob(u, code);
    if (j.status !== 'running') return j;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('job no termino');
}

test('strikes de un vencido: sondea la rejilla y conserva los existentes', async () => {
  const { client, marketData } = fakes({
    existing: ['ETH-2OCT26-2400-C', 'ETH-2OCT26-2450-P'],
  });
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  const first = svc.getStrikesJob('ETH', '2OCT26');
  assert.equal(first.status, 'running');
  const job = await settle(svc, 'ETH', '2OCT26');
  assert.equal(job.status, 'done');
  assert.equal(job.spotRef, 2418);
  assert.deepEqual(job.strikes.map((s) => s.strike), [2400, 2450]);
  assert.equal(job.strikes[0].call, 'ETH-2OCT26-2400-C');
  assert.equal(job.strikes[0].put, null);
  assert.equal(job.strikes[1].put, 'ETH-2OCT26-2450-P');
  assert.ok(Math.abs(job.strikes[0].distancePct - -0.744) < 0.01);
  assert.equal(job.probed, job.total);
  assert.ok(job.total > 20);
});

test('error a mitad de sondeo: status error y conserva lo hallado', async () => {
  const { client, marketData } = fakes({
    existing: ['ETH-2OCT26-1750-C'],
    failOn: 'ETH-2OCT26-2800-C',
  });
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  svc.getStrikesJob('ETH', '2OCT26');
  const job = await settle(svc, 'ETH', '2OCT26');
  assert.equal(job.status, 'error');
  assert.match(job.error, /red caida/);
  assert.deepEqual(job.strikes.map((s) => s.strike), [1750]);
  // con retry se reintenta
  client.getInstrument = async () => null;
  assert.equal(svc.getStrikesJob('ETH', '2OCT26').status, 'error'); // sondear no reinicia
  const again = svc.getStrikesJob('ETH', '2OCT26', { retry: true });
  assert.equal(again.status, 'running');
  await settle(svc, 'ETH', '2OCT26');
});

test('vencimiento vigente: no llama a getInstrument', async () => {
  const { client, marketData, calls } = fakes({
    live: ['ETH-31OCT26-3000-C', 'ETH-31OCT26-3000-P', 'ETH-31OCT26-3100-C', 'SOL_USDC-31OCT26-100-C'],
  });
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  svc.getStrikesJob('ETH', '31OCT26');
  const job = await settle(svc, 'ETH', '31OCT26');
  assert.equal(job.status, 'done');
  assert.deepEqual(job.strikes.map((s) => [s.strike, s.call, s.put]), [
    [3000, 'ETH-31OCT26-3000-C', 'ETH-31OCT26-3000-P'],
    [3100, 'ETH-31OCT26-3100-C', null],
  ]);
  assert.equal(calls.getInstrument.length, 0);
});

test('listExpiries: vigentes asc y luego vencidos viernes verificados desc', async () => {
  const { client, marketData } = fakes({
    live: ['ETH-31OCT26-3000-C', 'ETH-28OCT26-3000-C', 'ETH-31OCT26-3000-P'],
    existing: ['ETH-9OCT26-2400-C', 'ETH-2OCT26-2400-C'],
  });
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  const list = await svc.listExpiries('ETH');
  assert.deepEqual(list.filter((e) => e.live).map((e) => e.code), ['28OCT26', '31OCT26']);
  const dead = list.filter((e) => !e.live).map((e) => e.code);
  assert.deepEqual(dead, ['9OCT26', '2OCT26']);
  assert.equal(list.findIndex((e) => !e.live), 2);
});

test('getCandles inversa: pide el perpetuo con la misma resolucion y multiplica', async () => {
  const { client, marketData, calls } = fakes();
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  const out = await svc.getCandles({
    instrument: 'ETH-3OCT26-2400-C', timeframe: '1d',
    startMs: Date.UTC(2026, 9, 1), endMs: Date.UTC(2026, 9, 2),
  });
  assert.equal(calls.getChartData.length, 2);
  assert.equal(calls.getChartData[1].instrument, 'ETH-PERPETUAL');
  assert.equal(calls.getChartData[1].resolution, calls.getChartData[0].resolution);
  assert.deepEqual(out.map((c) => c.close), [0.01 * 2000, 0.02 * 4000]);
});

test('cache: vencido permanente, vigente 10 s', async () => {
  const f = fakes();
  let now = NOW;
  const svc = createDeribitOptionsService({ client: f.client, marketData: f.marketData, now: () => now });
  const args = { timeframe: '1d', startMs: Date.UTC(2026, 9, 1), endMs: Date.UTC(2026, 9, 2) };
  await svc.getCandles({ ...args, instrument: 'ETH-3OCT26-2400-C' });
  const n = f.calls.getChartData.length;
  await svc.getCandles({ ...args, instrument: 'ETH-3OCT26-2400-C' });
  assert.equal(f.calls.getChartData.length, n);

  await svc.getCandles({ ...args, instrument: 'ETH-31OCT26-3000-C' });
  const m = f.calls.getChartData.length;
  await svc.getCandles({ ...args, instrument: 'ETH-31OCT26-3000-C' });
  assert.equal(f.calls.getChartData.length, m);
  now += 11_000;
  await svc.getCandles({ ...args, instrument: 'ETH-31OCT26-3000-C' });
  assert.ok(f.calls.getChartData.length > m);
});

test('job vigente terminado se relanza pasados 10 s; no es permanente', async () => {
  const f = fakes({ live: ['ETH-31OCT26-3000-C'] });
  let now = NOW;
  const svc = createDeribitOptionsService({ client: f.client, marketData: f.marketData, now: () => now });
  svc.getStrikesJob('ETH', '31OCT26');
  await settle(svc, 'ETH', '31OCT26');
  now += 5_000;
  assert.equal(svc.getStrikesJob('ETH', '31OCT26').status, 'done');
  f.client.getInstruments = async () => [{ instrument_name: 'ETH-31OCT26-3000-C' }, { instrument_name: 'ETH-31OCT26-3100-C' }];
  now += 20_000;
  assert.equal(svc.getStrikesJob('ETH', '31OCT26').status, 'running');
  const job = await settle(svc, 'ETH', '31OCT26');
  assert.equal(job.strikes.length, 2);
});

test('job de un vigente se relanza con sondeo al vencer', async () => {
  const f = fakes({ live: ['ETH-30OCT26-3000-C'] });
  let now = NOW;
  const svc = createDeribitOptionsService({ client: f.client, marketData: f.marketData, now: () => now });
  svc.getStrikesJob('ETH', '30OCT26');
  await settle(svc, 'ETH', '30OCT26');
  now = Date.UTC(2026, 10, 1); // 30OCT26 es viernes: vencido aceptado
  assert.equal(svc.getStrikesJob('ETH', '30OCT26').status, 'running');
  await settle(svc, 'ETH', '30OCT26');
  assert.ok(f.calls.getInstrument.length > 0);
});

test('codigo de vencimiento invalido lanza ValidationError', () => {
  const { client, marketData } = fakes();
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  assert.throws(() => svc.getStrikesJob('ETH', 'basura'), { name: 'ValidationError' });
  assert.throws(() => svc.getStrikesJob('ETH', '31FEB26'), { name: 'ValidationError' });
});

test('getCandles 1w conserva el primer cubo (lunes anterior a startMs)', async () => {
  const f = fakes();
  const monday = Date.UTC(2026, 9, 5); // lunes
  f.client.getChartData = async (a) => {
    f.calls.getChartData.push(a);
    const ticks = [monday, monday + DAY, monday + 8 * DAY];
    const v = ticks.map(() => 0.01);
    return { ticks, open: v, high: v, low: v, close: v, volume: v.map(() => 1) };
  };
  const svc = createDeribitOptionsService({ client: f.client, marketData: f.marketData, now: () => NOW });
  const out = await svc.getCandles({
    instrument: 'SOL_USDC-3OCT27-100-C', timeframe: '1w',
    startMs: monday + 2 * DAY, endMs: monday + 10 * DAY,
  });
  assert.equal(f.calls.getChartData[0].startMs, monday);
  assert.deepEqual(out.map((c) => c.time), [monday, monday + 7 * DAY]);
});

test('cache de velas: expulsa entradas viejas (tope) y borra las caducadas', async () => {
  const f = fakes();
  let now = NOW;
  const svc = createDeribitOptionsService({ client: f.client, marketData: f.marketData, now: () => now });
  for (let i = 0; i < 350; i++) {
    await svc.getCandles({
      instrument: 'ETH-31OCT26-3000-C', timeframe: '1d',
      startMs: Date.UTC(2026, 0, 1) + i * DAY, endMs: Date.UTC(2026, 9, 20),
    });
  }
  const n = f.calls.getChartData.length;
  // la primera entrada fue expulsada: vuelve a pedirse
  await svc.getCandles({ instrument: 'ETH-31OCT26-3000-C', timeframe: '1d', startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 9, 20) });
  assert.ok(f.calls.getChartData.length > n);
  // rango enorme: se acota a 400 dias
  await svc.getCandles({ instrument: 'ETH-31OCT26-3000-C', timeframe: '1d', startMs: 0, endMs: Date.UTC(2026, 9, 20) });
  const last = f.calls.getChartData[f.calls.getChartData.length - 2];
  assert.ok(last.endMs - last.startMs <= 401 * DAY);
});

test('listExpiries: una sola serie de Binance, llamadas simultaneas compartidas y vigentes en cache', async () => {
  const f = fakes({ live: ['ETH-31OCT26-3000-C'], existing: ['ETH-9OCT26-2400-C'] });
  let spotCalls = 0;
  const md = { getCandles: async (...a) => { spotCalls++; return fakes().marketData.getCandles(...a); } };
  const svc = createDeribitOptionsService({ client: f.client, marketData: md, now: () => NOW });
  const [a, b] = await Promise.all([svc.listExpiries('ETH'), svc.listExpiries('ETH')]);
  assert.deepEqual(a, b);
  assert.equal(spotCalls, 1);
  assert.equal(f.calls.getInstruments, 1);
  await svc.listExpiries('ETH');
  assert.equal(f.calls.getInstruments, 1); // dentro de los 10 s
});

// I1: el cache se indexa por dia; la ventana exacta debe recortarse al leer.
test('getCandles 1m: dos ventanas del mismo dia devuelven cada una su tramo', async () => {
  const f = fakes();
  const day = Date.UTC(2026, 9, 2);
  f.client.getChartData = async (a) => {
    f.calls.getChartData.push(a);
    const ticks = [];
    for (let t = day; t < day + DAY; t += 3_600_000) ticks.push(t); // una vela por hora
    const v = ticks.map(() => 0.01);
    return { ticks, open: v, high: v, low: v, close: v, volume: v.map(() => 1) };
  };
  const svc = createDeribitOptionsService({ client: f.client, marketData: f.marketData, now: () => NOW });
  const H = 3_600_000;
  const late = await svc.getCandles({ instrument: 'ETH-2OCT26-2400-C', timeframe: '1m', startMs: day + 15 * H, endMs: day + 23 * H });
  const early = await svc.getCandles({ instrument: 'ETH-2OCT26-2400-C', timeframe: '1m', startMs: day + 7 * H, endMs: day + 15 * H });
  assert.equal(f.calls.getChartData.length, 2); // la segunda ventana sale del cache (opcion + perpetuo)
  assert.equal(late[0].time, day + 15 * H);
  assert.equal(late[late.length - 1].time, day + 23 * H);
  assert.equal(early[0].time, day + 7 * H);
  assert.equal(early[early.length - 1].time, day + 15 * H);
});

// I4: un viernes que falla no tumba la lista.
test('listExpiries: un viernes que falla se omite y el resto se devuelve', async () => {
  const f = fakes({
    live: ['ETH-31OCT26-3000-C'],
    existing: ['ETH-9OCT26-2400-C', 'ETH-2OCT26-2400-C'],
  });
  const md = {
    async getCandles(asset, tf, opts) {
      if (opts.limit > 5) throw new Error('binance caido'); // sin prefetch: dia por dia
      if (opts.startTime <= Date.UTC(2026, 8, 25) && opts.endTime >= Date.UTC(2026, 8, 25)) {
        throw new Error('sin vela diaria'); // spot del viernes 2 OCT (-7 d)
      }
      return f.marketData.getCandles(asset, tf, opts);
    },
  };
  const svc = createDeribitOptionsService({ client: f.client, marketData: md, now: () => NOW });
  const list = await svc.listExpiries('ETH');
  assert.deepEqual(list.filter((e) => e.live).map((e) => e.code), ['31OCT26']);
  assert.deepEqual(list.filter((e) => !e.live).map((e) => e.code), ['9OCT26']);
  // el veredicto no se cacheo: al recuperarse Binance aparece
  const svc2md = f.marketData;
  md.getCandles = (...a) => svc2md.getCandles(...a);
  const again = await svc.listExpiries('ETH');
  assert.deepEqual(again.filter((e) => !e.live).map((e) => e.code), ['9OCT26', '2OCT26']);
});

// I5: solo vencidos que listExpiries puede ofrecer.
test('getStrikesJob: rechaza vencidos que no son viernes del ultimo anio', () => {
  const { client, marketData } = fakes();
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  assert.throws(() => svc.getStrikesJob('ETH', '6JAN23'), { name: 'ValidationError' });
  assert.throws(() => svc.getStrikesJob('ETH', '3OCT26'), { name: 'ValidationError' }); // sabado
  assert.throws(() => svc.getStrikesJob('ETH', '17OCT25'), { name: 'ValidationError' }); // > 366 d
  assert.equal(svc.getStrikesJob('ETH', '24OCT25').status, 'running'); // viernes dentro del anio
  assert.equal(svc.getStrikesJob('ETH', '28OCT26').status, 'running'); // vigente (miercoles)
});

test('getStrikesJob: el mapa de trabajos se acota a 200 terminados', async () => {
  const { client, marketData } = fakes();
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  // 250 codigos vigentes distintos (cada dia desde manana)
  const codes = [];
  const { formatExpiryCode } = require('../src/services/deribit/deribit-instruments');
  for (let i = 1; i <= 250; i++) codes.push(formatExpiryCode(Date.UTC(2026, 9, 21, 8) + i * DAY));
  for (const c of codes) {
    svc.getStrikesJob('ETH', c);
    await settle(svc, 'ETH', c);
  }
  // el primero fue expulsado: consultarlo relanza el trabajo (running) en vez de devolver 'done'
  assert.equal(svc.getStrikesJob('ETH', codes[0]).status, 'running');
  // el ultimo sigue en el mapa
  assert.equal(svc.getStrikesJob('ETH', codes[codes.length - 1]).status, 'done');
});
