const test = require('node:test');
const assert = require('node:assert/strict');

const templates = require('../src/services/options/templates');
const alertSignal = require('../src/services/options/templates/alert-signal');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { parseSymbol, HOUR_MS } = require('../src/services/options/options-utils');

const NOW = Date.UTC(2026, 9, 16, 9);
const SPOT = 60000;

function chainFor(days) {
  const expiry = templates.pickExpiry(syntheticExpiries(NOW), days);
  return buildSyntheticChain({ underlying: 'BTC', spot: SPOT, now: NOW, expiry, atmIv: 0.55, spreadPct: 4 });
}

function params(overrides = {}) {
  return templates.validateParams('alert_signal', { alertIds: [1], ...overrides });
}

function position({ id = 1, side, type, entryPrice = 1000, quote = { bid: 1000, ask: 1000, mark: 1000 }, hoursLeft = 100 }) {
  const expiryMs = NOW + hoursLeft * HOUR_MS;
  return { id, symbol: `BTC-261023-${type === 'C' ? 65000 : 55000}-${type}`, side, type, quantity: 0.01, entryPrice, expiryMs, quote };
}

function run(p, { signal, positions = [], tradesToday = 0, chain = chainFor(p.expiryDays) } = {}) {
  return alertSignal.evaluate({ now: NOW, underlying: 'BTC', spot: SPOT, chain, positions, params: p, signal, tradesToday });
}

test('alert_signal: registrado pero fuera de la lista de plantillas de Estrategias', () => {
  assert.equal(templates.getTemplate('alert_signal').id, 'alert_signal');
  assert.ok(templates.isSignalDriven('alert_signal'));
  assert.ok(!templates.isSignalDriven('short_strangle'));
  assert.ok(!templates.listTemplates().some((t) => t.id === 'alert_signal'));
});

test('alert_signal: valores por defecto según la estructura y validación', () => {
  const buy = params();
  assert.deepEqual(
    { s: buy.structure, d: buy.targetDelta, tp: buy.takeProfitPct, sl: buy.stopLossPct, o: buy.onOpposite },
    { s: 'buy_with', d: 0.35, tp: 80, sl: 50, o: 'reverse' }
  );
  assert.equal(buy.expiryDays, 7);
  assert.equal(buy.exitHoursBeforeExpiry, 12);
  assert.equal(buy.maxOpenPositions, 1);
  assert.equal(buy.maxTradesPerDay, 4);
  assert.deepEqual(buy.alertIds, [1]);

  const sell = params({ structure: 'sell_against', maxPremiumUsdt: 50 });
  assert.deepEqual([sell.targetDelta, sell.takeProfitPct, sell.stopLossPct], [0.25, 50, 200]);
  assert.equal(sell.maxPremiumUsdt, null, 'la prima máxima solo aplica al comprar');

  assert.throws(() => params({ structure: 'straddle' }), /Estructura/);
  assert.throws(() => params({ onOpposite: 'flip' }), /Señal contraria/);
  assert.throws(() => params({ alertIds: ['x'] }), /Alertas/);
  assert.throws(() => params({ targetDelta: 2 }), /máximo/);
  assert.throws(() => params({ maxOpenPositions: 1.5 }), /entero/);
});

for (const [structure, direction, side, type] of [
  ['buy_with', 'bullish', 'BUY', 'C'],
  ['buy_with', 'bearish', 'BUY', 'P'],
  ['sell_against', 'bullish', 'SELL', 'P'],
  ['sell_against', 'bearish', 'SELL', 'C'],
]) {
  test(`alert_signal ${structure} + ${direction} → ${side} ${type} por delta`, () => {
    const p = params({ structure, quantity: 0.02 });
    const actions = run(p, { signal: { direction } });
    assert.equal(actions.length, 1);
    const [open] = actions;
    assert.equal(open.type, 'open');
    assert.equal(open.legs.length, 1);
    const leg = open.legs[0];
    assert.equal(leg.side, side);
    assert.equal(leg.optionType, type);
    assert.equal(leg.quantity, 0.02);
    assert.equal(parseSymbol(leg.symbol).expiry, chainFor(7).expiry);
    if (type === 'C') assert.ok(leg.strike > SPOT); else assert.ok(leg.strike < SPOT);
    assert.ok(Math.abs(Math.abs(leg.delta) - p.targetDelta) < 0.05, `delta ${leg.delta}`);
    assert.match(open.detail, direction === 'bullish' ? /alcista/ : /bajista/);
  });
}

test('alert_signal: onOpposite reverse cierra la contraria y abre', () => {
  const p = params();
  const put = position({ side: 'BUY', type: 'P' });
  const actions = run(p, { signal: { direction: 'bullish' }, positions: [put] });
  assert.deepEqual(actions.map((a) => a.type), ['close', 'open']);
  assert.equal(actions[0].legs[0].positionId, put.id);
  assert.equal(actions[0].legs[0].side, 'SELL');
  assert.equal(actions[1].legs[0].optionType, 'C');
});

test('alert_signal: onOpposite close solo cierra', () => {
  const p = params({ structure: 'sell_against', onOpposite: 'close' });
  // Venta de call = bajista; una señal alcista la cierra (recompra).
  const call = position({ side: 'SELL', type: 'C' });
  const actions = run(p, { signal: { direction: 'bullish' }, positions: [call] });
  assert.deepEqual(actions.map((a) => a.type), ['close']);
  assert.equal(actions[0].legs[0].side, 'BUY');
});

test('alert_signal: onOpposite ignore no toca nada', () => {
  const p = params({ onOpposite: 'ignore' });
  const actions = run(p, { signal: { direction: 'bearish' }, positions: [position({ side: 'BUY', type: 'C' })] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'skip');
  assert.equal(actions[0].reason, 'opposite_ignored');
});

test('alert_signal: motivos de skip', () => {
  const p = params();
  const sameSide = run(p, { signal: { direction: 'bullish' }, positions: [position({ side: 'BUY', type: 'C' })] });
  assert.deepEqual(sameSide.map((a) => a.reason), ['max_open_positions']);
  assert.match(sameSide[0].detail, /Máximo de 1 posición/);

  const trades = run(p, { signal: { direction: 'bullish' }, tradesToday: 4 });
  assert.deepEqual(trades.map((a) => a.reason), ['max_trades_per_day']);

  // Al dar la vuelta, cierra igual aunque no pueda abrir.
  const reverseCapped = run(p, { signal: { direction: 'bullish' }, positions: [position({ side: 'BUY', type: 'P' })], tradesToday: 4 });
  assert.deepEqual(reverseCapped.map((a) => a.type), ['close', 'skip']);

  const premium = run(params({ maxPremiumUsdt: 0.01 }), { signal: { direction: 'bullish' } });
  assert.equal(premium[0].reason, 'max_premium');

  assert.equal(run(p, { signal: { direction: 'bullish' }, chain: null })[0].reason, 'no_chain');
  assert.equal(run(p, { signal: { direction: 'neutral' } })[0].reason, 'neutral');
});

test('alert_signal: sin señal solo evalúa salidas', () => {
  const p = params();
  assert.deepEqual(run(p).map((a) => a.reason), ['waiting_signal']);

  // Compra: ganancia = (valor − prima) / prima.
  const tp = run(p, { positions: [position({ side: 'BUY', type: 'C', entryPrice: 100, quote: { bid: 190, ask: 200 } })] });
  assert.equal(tp[0].reason, 'take_profit');
  const sl = run(p, { positions: [position({ side: 'BUY', type: 'C', entryPrice: 100, quote: { bid: 40, ask: 45 } })] });
  assert.equal(sl[0].reason, 'stop_loss');
  const time = run(p, { positions: [position({ side: 'BUY', type: 'C', hoursLeft: 6 })] });
  assert.equal(time[0].reason, 'time_exit');
  const holdIt = run(p, { positions: [position({ side: 'BUY', type: 'C', entryPrice: 100, quote: { bid: 110, ask: 120 } })] });
  assert.equal(holdIt[0].type, 'hold');

  // Venta: ganancia = (prima − recompra) / prima; stop 200 %.
  const sp = params({ structure: 'sell_against' });
  const sellTp = run(sp, { positions: [position({ side: 'SELL', type: 'P', entryPrice: 100, quote: { bid: 40, ask: 45 } })] });
  assert.equal(sellTp[0].reason, 'take_profit');
  const sellSl = run(sp, { positions: [position({ side: 'SELL', type: 'P', entryPrice: 100, quote: { bid: 290, ask: 310 } })] });
  assert.equal(sellSl[0].reason, 'stop_loss');
});
