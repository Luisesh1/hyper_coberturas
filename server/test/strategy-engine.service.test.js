const test = require('node:test');
const assert = require('node:assert/strict');

const strategyEngine = require('../src/services/strategy-engine.service');

function buildCandles(closes) {
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  return closes.map((close, index) => ({
    time: start + (index * 60_000),
    closeTime: start + ((index + 1) * 60_000),
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 100 + index,
  }));
}

test('validateStrategy ejecuta una estrategia simple y devuelve signal serializable', async () => {
  const result = await strategyEngine.validateStrategy({
    source: `module.exports.evaluate = async function evaluate(ctx) {
      const candles = ctx.market.candles({ limit: 2 });
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      if (last.close > prev.close) return signal.long({ sizeMultiplier: 2 });
      return signal.hold();
    };`,
    context: {
      market: { candles: buildCandles([100, 102, 105]) },
      account: { position: null },
      params: {},
    },
    customIndicators: [],
  });

  assert.equal(result.signal.type, 'long');
  assert.equal(result.signal.sizeMultiplier, 2);
  assert.equal(result.diagnostics.candles, 3);
});

test('validateStrategy soporta indicadores custom dentro del sandbox', async () => {
  const result = await strategyEngine.validateStrategy({
    source: `module.exports.evaluate = async function evaluate(ctx) {
      const candles = ctx.market.candles({ limit: 5 });
      const values = ctx.indicators.custom('double-close', candles, {});
      const last = values[values.length - 1];
      return last > 200 ? signal.long() : signal.hold();
    };`,
    context: {
      market: { candles: buildCandles([90, 91, 95, 102, 110]) },
      account: { position: null },
      params: {},
    },
    customIndicators: [{
      slug: 'double-close',
      scriptSource: `module.exports.compute = function compute(input) {
        return input.map((item) => Number(item.close) * 2);
      };`,
    }],
  });

  assert.equal(result.signal.type, 'long');
});

test('backtestStrategy produce métricas deterministas sobre una serie conocida', async () => {
  const result = await strategyEngine.backtestStrategy({
    source: `module.exports.evaluate = async function evaluate(ctx) {
      const candles = ctx.market.candles({ limit: 100 });
      const position = ctx.account.position();
      const closes = candles.map((item) => item.close);
      const last = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      if (!position && last > prev) return signal.long();
      if (position?.side === 'long' && last < prev) return signal.close();
      return signal.hold();
    };`,
    baseContext: {
      market: { candles: buildCandles([100, 103, 106, 104, 101, 105, 109, 108]) },
      account: { position: null },
      params: {},
    },
    customIndicators: [],
    tradeSize: 1,
  });

  assert.equal(result.metrics.trades, 2);
  assert.equal(result.trades.length, 2);
  assert.ok(result.metrics.netPnl !== 0);
  assert.ok(Object.hasOwn(result.metrics, 'expectancy'));
  assert.ok(Object.hasOwn(result.metrics, 'feePaid'));
  assert.ok(Object.hasOwn(result.metrics, 'avgBarsInTrade'));
});

test('validateStrategy corta scripts que exceden el timeout', async () => {
  await assert.rejects(
    strategyEngine.validateStrategy({
      source: `module.exports.evaluate = async function evaluate() {
        while (true) {}
      };`,
      context: {
        market: { candles: buildCandles([100, 101, 102]) },
        account: { position: null },
        params: {},
      },
      customIndicators: [],
    }),
    /timeout/i
  );
});

test('simulateBacktest usa sizeUsd para derivar qty y devuelve series ricas', async () => {
  const result = await strategyEngine.simulateBacktest({
    source: `module.exports.evaluate = async function evaluate(ctx) {
      const candles = ctx.market.candles({ limit: 10 });
      const position = ctx.account.position();
      if (!position && candles.length === 2) return signal.long();
      if (position && candles.length >= 4) return signal.close();
      return signal.hold();
    };`,
    baseContext: {
      market: { candles: buildCandles([100, 101, 103, 104, 105]) },
      account: { position: null },
      params: {},
    },
    customIndicators: [],
    sizingMode: 'usd',
    sizeUsd: 100,
    leverage: 10,
    overlayRequests: [{ kind: 'builtin', slug: 'ema', params: { period: 2 }, pane: 'price' }],
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].sizeUsd, 100);
  assert.equal(result.trades[0].marginUsed, 10);
  assert.ok(result.trades[0].qty > 0.95 && result.trades[0].qty < 1.05);
  assert.equal(result.equitySeries.length, 5);
  assert.equal(result.overlays.length, 1);
  assert.equal(result.overlays[0].series.length, 1);
  assert.ok(result.metrics.exposurePct > 0);
  assert.ok(result.metrics.longTrades >= 1);
});

test('simulateBacktest ejecuta stop loss primero cuando SL y TP se tocan en la misma vela', async () => {
  const candles = buildCandles([100, 100, 100, 100]);
  candles[1].high = 103;
  candles[1].low = 97;

  const result = await strategyEngine.simulateBacktest({
    source: `module.exports.evaluate = async function evaluate(ctx) {
      const position = ctx.account.position();
      if (!position && ctx.market.candles({ limit: 10 }).length === 1) return signal.long();
      return signal.hold();
    };`,
    baseContext: {
      market: { candles },
      account: { position: null },
      params: {},
    },
    customIndicators: [],
    sizingMode: 'usd',
    sizeUsd: 100,
    stopLossPct: 2,
    takeProfitPct: 2,
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, 'stop_loss');
  assert.ok(result.trades[0].pnl < 0);
});

test('simulateBacktest soporta overlays custom', async () => {
  const result = await strategyEngine.simulateBacktest({
    source: `module.exports.evaluate = async function evaluate() {
      return signal.hold();
    };`,
    baseContext: {
      market: { candles: buildCandles([90, 91, 92, 93]) },
      account: { position: null },
      params: {},
    },
    customIndicators: [{
      slug: 'double-close',
      scriptSource: `module.exports.compute = function compute(input) {
        return input.map((item) => Number(item.close) * 2);
      };`,
    }],
    sizingMode: 'usd',
    sizeUsd: 100,
    overlayRequests: [{ kind: 'custom', slug: 'double-close', pane: 'separate' }],
  });

  assert.equal(result.overlays.length, 1);
  assert.equal(result.overlays[0].kind, 'custom');
  assert.equal(result.overlays[0].series[0].points[3].value, 186);
});
