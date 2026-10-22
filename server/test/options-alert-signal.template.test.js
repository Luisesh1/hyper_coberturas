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

test('alert_signal: sin spot no abre (no puede distinguir strikes OTM ni dimensionar)', () => {
  const p = params();
  const actions = alertSignal.evaluate({ now: NOW, underlying: 'BTC', spot: null, chain: chainFor(p.expiryDays),
    positions: [], params: p, signal: { direction: 'bullish', eventId: 1 }, tradesToday: 0 });
  assert.ok(!actions.some((a) => a.type === 'open'));
  assert.ok(actions.some((a) => a.reason === 'no_spot'));
});

// ---------- modo atr_band (objetivo fijo al llenarse, sin otras salidas) ----------

test('alert_signal atr_band: valores por defecto, rangos y combinaciones', () => {
  const p = params({ takeProfitMode: 'atr_band', onOpposite: 'reverse', exitHoursBeforeExpiry: 12 });
  assert.equal(p.takeProfitMode, 'atr_band');
  assert.equal(p.atrBandInterval, '1h');
  assert.equal(p.atrBandLength, 14);
  assert.equal(p.atrBandMultiplier, 2);
  assert.equal(p.tpMaxGainPct, 200);
  assert.equal(p.onOpposite, 'ignore', 'atr_band fuerza ignorar la señal contraria');
  assert.equal(p.exitHoursBeforeExpiry, 0, 'atr_band no tiene salida por tiempo');
  assert.equal(params({ takeProfitMode: 'atr_band', exitHoursBeforeExpiry: 0 }).exitHoursBeforeExpiry, 0);

  const custom = params({ takeProfitMode: 'atr_band', atrBandInterval: '4h', atrBandLength: 20, atrBandMultiplier: 1.5, tpMaxGainPct: 500 });
  assert.deepEqual([custom.atrBandInterval, custom.atrBandLength, custom.atrBandMultiplier, custom.tpMaxGainPct], ['4h', 20, 1.5, 500]);

  assert.throws(() => params({ takeProfitMode: 'atr_band', structure: 'sell_against' }), (err) => err.name === 'ValidationError');
  assert.throws(() => params({ takeProfitMode: 'atr_band', atrBandInterval: '2h' }), /Temporalidad/);
  assert.throws(() => params({ takeProfitMode: 'atr_band', atrBandLength: 1 }), /mínimo 2/);
  assert.throws(() => params({ takeProfitMode: 'atr_band', atrBandLength: 101 }), /máximo 100/);
  assert.throws(() => params({ takeProfitMode: 'atr_band', atrBandLength: 14.5 }), /entero/);
  assert.throws(() => params({ takeProfitMode: 'atr_band', atrBandMultiplier: 0.1 }), /mínimo 0.25/);
  assert.throws(() => params({ takeProfitMode: 'atr_band', atrBandMultiplier: 11 }), /máximo 10/);
  assert.throws(() => params({ takeProfitMode: 'atr_band', tpMaxGainPct: 5 }), /mínimo 10/);
  assert.throws(() => params({ takeProfitMode: 'atr_band', tpMaxGainPct: 2001 }), /máximo 2000/);

  // Los bots existentes sin la clave siguen en 'fixed' con sus salidas.
  const legacy = params({});
  assert.equal(legacy.takeProfitMode, 'fixed');
  assert.equal(legacy.onOpposite, 'reverse');
  assert.equal(legacy.exitHoursBeforeExpiry, 12);
  // sell_against sigue igual en los demás modos.
  assert.equal(params({ structure: 'sell_against' }).takeProfitMode, 'fixed');
});

test('alert_signal atr_band: señal contraria con posición abierta se ignora sin cerrar', () => {
  const p = params({ takeProfitMode: 'atr_band', onOpposite: 'reverse' });
  const call = { ...position({ side: 'BUY', type: 'C', entryPrice: 100, quote: { bid: 50, ask: 55 } }), tpTargetPrice: 300 };
  const actions = run(p, { signal: { direction: 'bearish' }, positions: [call] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'skip');
  assert.equal(actions[0].reason, 'opposite_ignored');
  assert.ok(!actions.some((a) => a.type === 'close'));
});

test('alert_signal atr_band: ni stop ni salida por tiempo, aun con pérdida del 90 % y a 2 h del vencimiento', () => {
  const p = params({ takeProfitMode: 'atr_band', stopLossPct: 50 });
  const losing = { ...position({ side: 'BUY', type: 'C', entryPrice: 100, quote: { bid: 10, ask: 12 }, hoursLeft: 2 }), tpTargetPrice: 300 };
  const actions = run(p, { positions: [losing] });
  assert.ok(!actions.some((a) => a.type === 'close'), JSON.stringify(actions));
  assert.equal(actions[0].type, 'hold');
  assert.equal(actions[0].reason, 'in_position');
  // Sin cotización tampoco cierra.
  const noQuote = { ...losing, quote: null };
  assert.ok(!run(p, { positions: [noQuote] }).some((a) => a.type === 'close'));
});

test('alert_signal atr_band: cierra con take_profit_atr_band cuando el bid alcanza el objetivo', () => {
  const p = params({ takeProfitMode: 'atr_band' });
  const base = position({ side: 'BUY', type: 'C', entryPrice: 100, quote: { bid: 299.9, ask: 310, mark: 400 } });
  const below = run(p, { positions: [{ ...base, tpTargetPrice: 300 }] });
  assert.equal(below[0].type, 'hold', 'el mark no cuenta: solo el bid');
  const hit = run(p, { positions: [{ ...base, quote: { bid: 300, ask: 310 }, tpTargetPrice: 300 }] });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].type, 'close');
  assert.equal(hit[0].reason, 'take_profit_atr_band');
  assert.equal(hit[0].legs[0].side, 'SELL');
  assert.equal(hit[0].legs[0].targetPrice, 300);
  assert.equal(hit[0].legs[0].positionId, base.id);
});

test('alert_signal atr_band: sin objetivo guardado espera (hold) y no inventa salida', () => {
  const p = params({ takeProfitMode: 'atr_band' });
  const pending = position({ side: 'BUY', type: 'C', entryPrice: 100, quote: { bid: 900, ask: 950 } });
  const actions = run(p, { positions: [{ ...pending, tpTargetPrice: null }] });
  assert.equal(actions[0].type, 'hold');
  assert.equal(actions[0].reason, 'atr_band_tp_pending');
});

test('alert_signal: notify por defecto {trades:true, errors:true} y se valida', () => {
  assert.deepEqual(params().notify, { trades: true, errors: true });
  assert.deepEqual(alertSignal.defaultParams.notify, { trades: true, errors: true });
  assert.deepEqual(params({ notify: { trades: false, errors: true } }).notify, { trades: false, errors: true });
  assert.deepEqual(params({ notify: { trades: false } }).notify, { trades: false, errors: true });
  assert.throws(() => params({ notify: { trades: 'si', errors: true } }), /notify/);
  assert.throws(() => params({ notify: 5 }), /notify/);
});

// ---------- presupuesto total en fracciones (Task 11) ----------

function runBudget(p, { committedUsdt, positions = [], direction = 'bullish' } = {}) {
  return alertSignal.evaluate({ now: NOW, underlying: 'BTC', spot: SPOT, chain: chainFor(p.expiryDays),
    positions, params: p, signal: { direction }, tradesToday: 0, committedUsdt });
}
const legCost = (l) => l.price * l.quantity;

test('alert_signal: budgetUsdt/budgetFractions por defecto y validación', () => {
  const p = params();
  assert.equal(p.budgetUsdt, null);
  assert.equal(p.budgetFractions, 4);
  assert.equal(params({ budgetUsdt: 48, budgetFractions: 20 }).budgetFractions, 20);
  assert.equal(params({ budgetUsdt: '' }).budgetUsdt, null);
  assert.throws(() => params({ budgetFractions: 0 }), /budgetFractions/);
  assert.throws(() => params({ budgetFractions: 21 }), /budgetFractions/);
  assert.throws(() => params({ budgetFractions: 2.5 }), /budgetFractions/);
  assert.throws(() => params({ budgetUsdt: -1 }), /budgetUsdt/);
});

test('alert_signal: presupuesto 48 en 4 fracciones, nada comprometido → 12 por señal, ≤ 4 USDT por contrato', () => {
  const p = params({ budgetUsdt: 48, budgetFractions: 4, contractCount: 3, maxOpenPositions: 3, quantity: 1, capitalUsdt: 1000 });
  const [open] = runBudget(p, { committedUsdt: 0 });
  assert.equal(open.type, 'open');
  assert.equal(open.legs.length, 3);
  for (const leg of open.legs) {
    assert.ok(legCost(leg) <= 4 + 1e-9, `pata ${legCost(leg)} > 4`);
    assert.ok(legCost(leg) > 3, 'el presupuesto se aprovecha (redondeo hacia abajo al step)');
  }
});

test('alert_signal: comprometido 40 de 48 → 8 por señal', () => {
  const p = params({ budgetUsdt: 48, budgetFractions: 4, contractCount: 1, quantity: 1 });
  const [open] = runBudget(p, { committedUsdt: 40 });
  assert.equal(open.type, 'open');
  assert.ok(legCost(open.legs[0]) <= 8 + 1e-9);
  assert.ok(legCost(open.legs[0]) > 7);
});

test('alert_signal: comprometido 48 de 48 → budget_exhausted', () => {
  const p = params({ budgetUsdt: 48, budgetFractions: 4, quantity: 1 });
  const [action] = runBudget(p, { committedUsdt: 48 });
  assert.equal(action.type, 'skip');
  assert.equal(action.reason, 'budget_exhausted');
  assert.equal(action.detail, 'Presupuesto comprometido: 48 de 48 USDT');
});

test('alert_signal: comprometido desconocido (NaN) bloquea la entrada', () => {
  const p = params({ budgetUsdt: 48, quantity: 1 });
  const [action] = runBudget(p, { committedUsdt: NaN });
  assert.equal(action.type, 'skip');
  assert.equal(action.reason, 'budget_unknown');
});

test('alert_signal: con presupuesto, capitalUsdt se ignora', () => {
  const p = params({ budgetUsdt: 48, budgetFractions: 4, quantity: 1, capitalUsdt: 1 });
  const [open] = runBudget(p, { committedUsdt: 0 });
  assert.equal(open.type, 'open');
  assert.ok(legCost(open.legs[0]) > 11 && legCost(open.legs[0]) <= 12 + 1e-9);
});

test('alert_signal: sin presupuesto sigue mandando capitalUsdt', () => {
  const p = params({ quantity: 1, capitalUsdt: 5 });
  const [open] = runBudget(p, { committedUsdt: 1e9 });
  assert.equal(open.type, 'open');
  assert.ok(legCost(open.legs[0]) <= 5 + 1e-9 && legCost(open.legs[0]) > 4);
});

test('alert_signal: al girar, lo comprometido por la posición contraria que se cierra se libera', () => {
  const p = params({ budgetUsdt: 48, budgetFractions: 4, quantity: 1, onOpposite: 'reverse' });
  const opposite = { ...position({ side: 'BUY', type: 'P', entryPrice: 4800 }) };
  const actions = runBudget(p, { committedUsdt: 48, positions: [opposite] });
  assert.deepEqual(actions.map((a) => a.type), ['close', 'open']);
  assert.ok(legCost(actions[1].legs[0]) <= 12 + 1e-9);
});

// ---- Filtros de entrada: spread y apalancamiento ----
function filterChain(calls) {
  return {
    expiry: chainFor(7).expiry,
    rows: calls.map(([strike, delta, bid, ask]) => ({
      strike,
      call: { symbol: `BTC-261023-${strike}-C`, delta, bid, ask, mark: (bid + ask) / 2, stepSize: 0.01, minQty: 0.01 },
      put: null,
    })),
  };
}

test('alert_signal: maxSpreadPct descarta candidatos con spread > máximo y detalla el filtro', () => {
  const p = params({ maxSpreadPct: 10 });
  assert.equal(p.maxSpreadPct, 10);
  const chain = filterChain([[65000, 0.35, 9, 11]]); // spread 20 %
  const [a] = run(p, { signal: { direction: 'bullish' }, chain });
  assert.equal(a.type, 'skip');
  assert.equal(a.reason, 'no_legs');
  assert.match(a.detail, /spread > 10 %/);
  // Sin bid: falla el filtro de spread.
  const [b] = run(p, { signal: { direction: 'bullish' }, chain: filterChain([[65000, 0.35, 0, 11]]) });
  assert.equal(b.reason, 'no_legs');
  // Con un candidato dentro del límite, se elige ese aunque el delta sea peor.
  const [c] = run(p, { signal: { direction: 'bullish' }, chain: filterChain([[65000, 0.35, 9, 11], [70000, 0.2, 99, 101]]) });
  assert.equal(c.type, 'open');
  assert.equal(c.legs[0].symbol, 'BTC-261023-70000-C');
});

test('alert_signal: minLeverage descarta apalancamiento nominal spot/ask menor', () => {
  const p = params({ minLeverage: 20 });
  const chain = filterChain([[65000, 0.35, 190, 200]]); // 60000/200 = 300×... usar ask alto
  chain.rows[0].call.ask = 4000; chain.rows[0].call.bid = 3900; // 15×
  const [a] = run(p, { signal: { direction: 'bullish' }, chain });
  assert.equal(a.reason, 'no_legs');
  assert.match(a.detail, /apalancamiento < 20×/);
  chain.rows[0].call.ask = 2900; chain.rows[0].call.bid = 2850; // ~20,7×
  assert.equal(run(p, { signal: { direction: 'bullish' }, chain })[0].type, 'open');
});

test('alert_signal: si ambos filtros eliminan candidatos se mencionan los dos', () => {
  const p = params({ maxSpreadPct: 10, minLeverage: 20 });
  const chain = filterChain([[65000, 0.35, 3000, 4500], [66000, 0.3, 3900, 4000]]);
  const [a] = run(p, { signal: { direction: 'bullish' }, chain });
  assert.match(a.detail, /spread > 10 %/);
  assert.match(a.detail, /apalancamiento < 20×/);
});

test('alert_signal: filtros null o ausentes no cambian la selección; minLeverage no aplica a sell_against', () => {
  const chain = filterChain([[65000, 0.35, 9, 11]]);
  const base = run(params(), { signal: { direction: 'bullish' }, chain });
  assert.equal(base[0].type, 'open');
  const nulls = run(params({ maxSpreadPct: null, minLeverage: '' }), { signal: { direction: 'bullish' }, chain });
  assert.deepEqual(nulls, base);
  assert.equal(params({ structure: 'sell_against', minLeverage: 5 }).minLeverage, null);
  assert.throws(() => params({ maxSpreadPct: -1 }), /Spread máximo/);
  assert.throws(() => params({ minLeverage: 0.0 + 'x' }), /Apalancamiento/);
});

test('alert_signal: underlyings opcional — 1 a 6, de la lista, únicos, en mayúsculas', () => {
  assert.equal(params().underlyings, undefined, 'sin underlyings el bot opera solo su subyacente');
  assert.deepEqual(params({ underlyings: ['btc', 'Eth'] }).underlyings, ['BTC', 'ETH']);
  assert.throws(() => params({ underlyings: [] }), /al menos uno/);
  assert.throws(() => params({ underlyings: ['BTC', 'PEPE'] }), /no soportado: PEPE/);
  assert.throws(() => params({ underlyings: ['BTC', 'btc'] }), /repitas/);
  assert.throws(() => params({ underlyings: 'BTC' }), /lista/);
  assert.equal(params({ underlyings: ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'] }).underlyings.length, 6);
});

test('botUnderlyings: params.underlyings si no está vacío; si no, [strategy.underlying]', () => {
  const { botUnderlyings } = require('../src/services/options/bot-underlyings');
  assert.deepEqual(botUnderlyings({ underlying: 'BTC', params: { underlyings: ['BTC', 'ETH'] } }), ['BTC', 'ETH']);
  assert.deepEqual(botUnderlyings({ underlying: 'BTC', params: { underlyings: [] } }), ['BTC']);
  assert.deepEqual(botUnderlyings({ underlying: 'ETH', params: {} }), ['ETH']);
});

test('alert_signal: maxOpenPositions cuenta ctx.openCountAll (todo el bot) cuando existe', () => {
  const p = params({ maxOpenPositions: 1 });
  // Sin posiciones de este subyacente, pero una de otro: tope alcanzado.
  const [capped] = alertSignal.evaluate({ now: NOW, spot: SPOT, chain: chainFor(p.expiryDays), positions: [], openCountAll: 1, params: p, signal: { direction: 'bullish' }, tradesToday: 0 });
  assert.equal(capped.reason, 'max_open_positions');
  // Sin openCountAll: igual que antes (cuenta ctx.positions).
  const [open] = alertSignal.evaluate({ now: NOW, spot: SPOT, chain: chainFor(p.expiryDays), positions: [], params: p, signal: { direction: 'bullish' }, tradesToday: 0 });
  assert.equal(open.type, 'open');
});

test('alert_signal: con openCountAll el giro descuenta las contrarias que cierra', () => {
  const p = params({ maxOpenPositions: 2 });
  const put = position({ side: 'BUY', type: 'P' });
  // 2 abiertas en el bot (1 put de este subyacente + 1 de otro): cierra la put y abre.
  const actions = alertSignal.evaluate({ now: NOW, spot: SPOT, chain: chainFor(p.expiryDays), positions: [put], openCountAll: 2, params: p, signal: { direction: 'bullish' }, tradesToday: 0 });
  assert.deepEqual(actions.map((a) => a.type), ['close', 'open']);
});
