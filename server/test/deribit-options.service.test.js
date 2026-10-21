const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeribitOptionsService } = require('../src/services/deribit/deribit-options.service');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 12); // 2026-10-21
const EXP = Date.UTC(2026, 9, 3, 8); // viernes 3 OCT 2026

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
    existing: ['ETH-3OCT26-2400-C', 'ETH-3OCT26-2450-P'],
  });
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  const first = svc.getStrikesJob('ETH', '3OCT26');
  assert.equal(first.status, 'running');
  const job = await settle(svc, 'ETH', '3OCT26');
  assert.equal(job.status, 'done');
  assert.equal(job.spotRef, 2418);
  assert.deepEqual(job.strikes.map((s) => s.strike), [2400, 2450]);
  assert.equal(job.strikes[0].call, 'ETH-3OCT26-2400-C');
  assert.equal(job.strikes[0].put, null);
  assert.equal(job.strikes[1].put, 'ETH-3OCT26-2450-P');
  assert.ok(Math.abs(job.strikes[0].distancePct - -0.744) < 0.01);
  assert.equal(job.probed, job.total);
  assert.ok(job.total > 20);
});

test('error a mitad de sondeo: status error y conserva lo hallado', async () => {
  const { client, marketData } = fakes({
    existing: ['ETH-3OCT26-1750-C'],
    failOn: 'ETH-3OCT26-2800-C',
  });
  const svc = createDeribitOptionsService({ client, marketData, now: () => NOW });
  svc.getStrikesJob('ETH', '3OCT26');
  const job = await settle(svc, 'ETH', '3OCT26');
  assert.equal(job.status, 'error');
  assert.match(job.error, /red caida/);
  assert.deepEqual(job.strikes.map((s) => s.strike), [1750]);
  // con retry se reintenta
  client.getInstrument = async () => null;
  assert.equal(svc.getStrikesJob('ETH', '3OCT26').status, 'error'); // sondear no reinicia
  const again = svc.getStrikesJob('ETH', '3OCT26', { retry: true });
  assert.equal(again.status, 'running');
  await settle(svc, 'ETH', '3OCT26');
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
