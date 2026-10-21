const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeribitClient } = require('../src/services/deribit/deribit.client');

const httpErr = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

test('getInstrument devuelve null si el instrumento no existe', async () => {
  const http = { get: async () => { throw httpErr(400, { error: { data: { reason: 'instrument not found' } } }); } };
  const c = createDeribitClient({ http, sleep: async () => {} });
  assert.equal(await c.getInstrument('ETH-1JAN20-1-C'), null);
});

test('getInstrument devuelve result y usa la URL pública', async () => {
  const calls = [];
  const http = { get: async (url, opts) => { calls.push({ url, opts }); return { data: { result: { instrument_name: 'X' } } }; } };
  const c = createDeribitClient({ http });
  assert.deepEqual(await c.getInstrument('X'), { instrument_name: 'X' });
  assert.equal(calls[0].url, 'https://www.deribit.com/api/v2/public/get_instrument');
  assert.deepEqual(calls[0].opts.params, { instrument_name: 'X' });
});

test('getInstruments y getChartData pasan los parámetros', async () => {
  const calls = [];
  const http = { get: async (url, opts) => { calls.push({ url, opts }); return { data: { result: url.endsWith('get_instruments') ? [1] : { ticks: [1] } } }; } };
  const c = createDeribitClient({ http });
  assert.deepEqual(await c.getInstruments({ currency: 'ETH' }), [1]);
  assert.deepEqual(calls[0].opts.params, { currency: 'ETH', kind: 'option', expired: false });
  await c.getChartData({ instrument: 'A', resolution: '60', startMs: 1, endMs: 2 });
  assert.deepEqual(calls[1].opts.params, { instrument_name: 'A', start_timestamp: 1, end_timestamp: 2, resolution: '60' });
});

test('reintenta ante 429 y devuelve el resultado', async () => {
  let n = 0; const sleeps = [];
  const http = { get: async () => { if (n++ === 0) throw httpErr(429, {}); return { data: { result: [] } }; } };
  const c = createDeribitClient({ http, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await c.getInstruments({ currency: 'BTC' }), []);
  assert.equal(n, 2);
  assert.deepEqual(sleeps, [250]);
});

test('limita la concurrencia', async () => {
  let inflight = 0, max = 0;
  const http = { get: async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setImmediate(r)); inflight--; return { data: { result: {} } }; } };
  const c = createDeribitClient({ http, concurrency: 2 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => c.getInstrument(`I${i}`)));
  assert.equal(max, 2);
});
