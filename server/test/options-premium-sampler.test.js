const test = require('node:test');
const assert = require('node:assert/strict');

const { OptionsPremiumSampler, closePrice } = require('../src/services/options/options-premium-sampler.service');

const NOW = Date.UTC(2026, 9, 28, 10, 0);
const silent = { info() {}, warn() {}, error() {} };

test('closePrice: bid al comprar, ask al vender; sin lado ejecutable no hay precio', () => {
  const t = { bidPrice: '1410', askPrice: '1660' };
  assert.equal(closePrice({ side: 'BUY' }, t), 1410);
  assert.equal(closePrice({ side: 'SELL' }, t), 1660);
  assert.equal(closePrice({ side: 'BUY' }, { bidPrice: '0', askPrice: '5' }), null);
  assert.equal(closePrice({ side: 'BUY' }, undefined), null);
});

test('muestrea cada posición abierta con una sola petición de tickers', async () => {
  const recorded = [];
  let tickerCalls = 0;
  const sampler = new OptionsPremiumSampler({
    now: () => NOW,
    logger: silent,
    repo: {
      async listAllOpenPositions() {
        return [
          { id: 1, symbol: 'BTC-261030-81500-P', side: 'BUY' },
          { id: 2, symbol: 'ETH-261030-2400-C', side: 'SELL' },
          { id: 3, symbol: 'BTC-261030-90000-C', side: 'BUY' }, // sin bid
          { id: 4, symbol: 'BTC-261031-70000-P', side: 'BUY' }, // sin ticker
        ];
      },
      async recordPremiumSample(id, price, at) { recorded.push([id, price, at]); return true; },
    },
    async getTickers() {
      tickerCalls += 1;
      return [
        { symbol: 'BTC-261030-81500-P', bidPrice: '1410', askPrice: '1660' },
        { symbol: 'ETH-261030-2400-C', bidPrice: '20.5', askPrice: '22' },
        { symbol: 'BTC-261030-90000-C', bidPrice: '0', askPrice: '5' },
      ];
    },
  });
  assert.deepEqual(await sampler.sample(), { sampled: 2 });
  assert.equal(tickerCalls, 1);
  assert.deepEqual(recorded, [[1, 1410, NOW], [2, 22, NOW]]);
});

test('sin posiciones abiertas no pide tickers; un fallo de escritura no frena a las demás', async () => {
  let tickerCalls = 0;
  const empty = new OptionsPremiumSampler({
    logger: silent,
    repo: { async listAllOpenPositions() { return []; } },
    async getTickers() { tickerCalls += 1; return []; },
  });
  assert.deepEqual(await empty.sample(), { sampled: 0 });
  assert.equal(tickerCalls, 0);

  const warnings = [];
  const sampler = new OptionsPremiumSampler({
    now: () => NOW,
    logger: { ...silent, warn: (msg) => warnings.push(msg) },
    repo: {
      async listAllOpenPositions() { return [{ id: 1, symbol: 'A', side: 'BUY' }, { id: 2, symbol: 'B', side: 'BUY' }]; },
      async recordPremiumSample(id) { if (id === 1) throw new Error('db'); return true; },
    },
    async getTickers() { return [{ symbol: 'A', bidPrice: '1' }, { symbol: 'B', bidPrice: '2' }]; },
  });
  assert.deepEqual(await sampler.sample(), { sampled: 1 });
  assert.deepEqual(warnings, ['options_premium_sample_write_failed']);
});

test('no solapa pasadas', async () => {
  let release;
  const sampler = new OptionsPremiumSampler({
    logger: silent,
    repo: { listAllOpenPositions: () => new Promise((r) => { release = () => r([]); }) },
    async getTickers() { return []; },
  });
  const first = sampler.sample();
  assert.deepEqual(await sampler.sample(), { skipped: true });
  release();
  assert.deepEqual(await first, { sampled: 0 });
});
