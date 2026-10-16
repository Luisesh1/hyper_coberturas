const test = require('node:test');
const assert = require('node:assert/strict');
const template = require('../src/services/options/templates/alert-signal');
const { OptionsStrategyRunner } = require('../src/services/options/options-strategy-runner.service');
const { createOptionsMarketService } = require('../src/services/options/options-market.service');

const now = Date.UTC(2026, 9, 15, 12);
const base = {
  id: 51, symbol: 'BTC-261030-101000-C', side: 'BUY', type: 'C',
  entryPrice: 100, quantity: 0.1, expiryMs: now + 14 * 86400000,
  quote: { bid: 145, ask: 150, mark: 147 },
  takeProfitTarget: { price: 140 },
};
const params = template.validateParams({ takeProfitMode: 'volatility' });

test('TP ATR/IV cierra solo tras alcanzar el precio de salida ejecutable', () => {
  const result = template.evaluate({ now, params, positions: [base] });
  assert.equal(result[0].reason, 'take_profit_volatility');
  assert.equal(result[0].legs[0].targetPrice, 140);
  assert.equal(result[0].legs[0].side, 'SELL');
  const waiting = template.evaluate({ now, params, positions: [{
    ...base, quote: { bid: 139, ask: 180, mark: 200 },
  }] });
  assert.equal(waiting[0].type, 'hold');
  assert.equal(waiting[0].reason, 'in_position');
});

test('en el lado corto, el TP exige recompra al ask bajo el objetivo', () => {
  const short = { ...base, side: 'SELL', entryPrice: 100,
    quote: { bid: 65, ask: 70, mark: 68 }, takeProfitTarget: { price: 80 } };
  const hit = template.evaluate({ now, params, positions: [short] });
  assert.equal(hit[0].reason, 'take_profit_volatility');
  assert.equal(hit[0].legs[0].side, 'BUY');
  const no = template.evaluate({ now, params, positions: [{
    ...short, quote: { bid: 50, ask: 81, mark: 60 },
  }] });
  assert.equal(no[0].type, 'hold');
});

test('TP dinámico no inventa nivel si faltan IV, tick o ATR; mantiene stop', () => {
  const noTarget = { ...base, takeProfitTarget: null, quote: { bid: 110, ask: 120 } };
  assert.equal(template.evaluate({ now, params, positions: [noTarget] })[0].reason, 'no_volatility_tp');
  const stopped = { ...noTarget, quote: { bid: 40, ask: 50 } };
  assert.equal(template.evaluate({ now, params, positions: [stopped] })[0].reason, 'stop_loss');
  assert.throws(() => template.validateParams({ takeProfitMode: 'auto' }), /Take Profit/);
  assert.throws(() => template.validateParams({ tpAtrMultiplier: 20 }), /ATR/);
});

test('preflight real rechaza TP si el bid/ask fresco ya no alcanza el objetivo', async () => {
  let sent = 0;
  const outcomes = [];
  const runner = new OptionsStrategyRunner({
    repo: {},
    market: { async getQuote() { return { bid: 125, ask: 130, delta: 0.4 }; } },
    liveExecutor: { enabled: true, async submit() { sent++; return { status: 'submitted', sent: 1 }; } },
    logger: { warn() {}, info() {} },
  });
  runner.recordOutcome = async (_s, _m, action) => outcomes.push(action);
  const strategy = { id: 1, userId: 1 };
  const action = { type: 'close', reason: 'take_profit_volatility', legs: [
    { positionId: 51, symbol: base.symbol, side: 'SELL', quantity: 0.1, targetPrice: 140 },
  ] };
  const result = await runner.executeLive(strategy, action, { now, spot: 100000, positions: [], params });
  assert.equal(result, null);
  assert.equal(sent, 0);
  assert.equal(outcomes[0].reason, 'tp_price_moved');
});

test('ATR utiliza 14 velas cerradas y metadatos reales de PRICE_FILTER', async () => {
  const symbol = base.symbol;
  let calls = 0;
  const rows = Array.from({ length: 17 }, (_, i) => [
    now - (17 - i) * 3600000, '100', '105', '95', '100', '0',
    now - (16 - i) * 3600000 - 1,
  ]);
  const service = createOptionsMarketService({ now: () => now, client: {
    async getExchangeInfo() { return { optionSymbols: [
      { symbol, filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }] },
    ] }; },
    async getSpotKlines(pair, interval, limit) {
      assert.equal(pair, 'BTCUSDT'); assert.equal(interval, '1h'); assert.equal(limit, 17);
      calls++;
      return rows;
    },
  } });
  assert.deepEqual(await service.getVolatilityInputs(symbol), { atrHourly: 10, tickSize: 0.1 });
  assert.deepEqual(await service.getVolatilityInputs(symbol), { atrHourly: 10, tickSize: 0.1 });
  assert.equal(calls, 1);
});
