const test = require('node:test');
const assert = require('node:assert/strict');

const templates = require('../src/services/options/templates');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { parseSymbol, HOUR_MS, DAY_MS } = require('../src/services/options/options-utils');

// Viernes 2026-10-16 09:00 UTC
const FRIDAY_9 = Date.UTC(2026, 9, 16, 9);
const SPOT = 60000;

function chainFor(now, days, { spot = SPOT, atmIv = 0.55, spreadPct = 4 } = {}) {
  const expiry = templates.pickExpiry(syntheticExpiries(now), days);
  return buildSyntheticChain({ underlying: 'BTC', spot, now, expiry, atmIv, spreadPct });
}

function positionFrom(leg, { id = 1, entryPrice, openedAt = FRIDAY_9, quote }) {
  const meta = parseSymbol(leg.symbol);
  return {
    id,
    symbol: leg.symbol,
    side: leg.side,
    quantity: leg.quantity,
    entryPrice: entryPrice ?? leg.price,
    openedAt,
    strike: meta.strike,
    type: meta.type,
    expiry: meta.expiry,
    expiryMs: meta.expiryMs,
    quote,
  };
}

test('registro: tres templates con defaultParams válidos según su paramSchema', () => {
  const list = templates.listTemplates();
  assert.deepEqual(list.map((t) => t.id), ['short_strangle', 'covered_call', 'protective_put']);
  for (const t of list) {
    assert.deepEqual(templates.validateParams(t.id, {}), t.defaultParams);
    assert.ok(t.paramSchema.every((f) => f.key && f.label && f.type));
  }
  assert.throws(() => templates.validateParams('short_strangle', { targetDelta: 0.9 }), /máximo/);
  assert.throws(() => templates.validateParams('short_strangle', { quantity: 'x' }), /número/);
  assert.throws(() => templates.getTemplate('iron_condor'), /desconocido/);
});

test('short strangle abre call Δ≈+0.15 y put Δ≈−0.15 en la ventana de entrada', () => {
  const t = templates.getTemplate('short_strangle');
  const params = templates.validateParams('short_strangle', {});
  const chain = chainFor(FRIDAY_9, params.expiryDays);
  const [action] = t.evaluate({ now: FRIDAY_9, spot: SPOT, chain, positions: [], params, lastOpenedAt: null });
  assert.equal(action.type, 'open');
  assert.equal(action.legs.length, 2);
  const call = action.legs.find((l) => l.optionType === 'C');
  const put = action.legs.find((l) => l.optionType === 'P');
  assert.equal(call.side, 'SELL');
  assert.equal(put.side, 'SELL');
  assert.ok(call.strike > SPOT && put.strike < SPOT);
  assert.ok(Math.abs(call.delta - 0.15) < 0.03, `call delta ${call.delta}`);
  assert.ok(Math.abs(put.delta + 0.15) < 0.03, `put delta ${put.delta}`);
  assert.equal(call.quantity, 0.01);
  assert.equal(call.price, chain.rows.find((r) => r.strike === call.strike).call.bid);
  // ~7 días
  assert.ok(Math.abs((parseSymbol(call.symbol).expiryMs - FRIDAY_9) / DAY_MS - 7) < 1);
});

test('short strangle se salta fuera de la ventana, con IV baja o si ya entró', () => {
  const t = templates.getTemplate('short_strangle');
  const params = templates.validateParams('short_strangle', {});
  const chain = chainFor(FRIDAY_9, 7);
  const base = { spot: SPOT, chain, positions: [], params, lastOpenedAt: null };
  assert.equal(t.evaluate({ ...base, now: FRIDAY_9 + HOUR_MS })[0].reason, 'outside_window');
  assert.equal(t.evaluate({ ...base, now: FRIDAY_9 - DAY_MS })[0].reason, 'outside_window');
  const lowIv = chainFor(FRIDAY_9, 7, { atmIv: 0.2 });
  const low = t.evaluate({ ...base, now: FRIDAY_9, chain: lowIv })[0];
  assert.equal(low.type, 'skip');
  assert.equal(low.reason, 'low_iv');
  assert.equal(t.evaluate({ ...base, now: FRIDAY_9, lastOpenedAt: FRIDAY_9 - 10 * 60_000 })[0].reason, 'outside_window');
  assert.equal(t.evaluate({ ...base, now: FRIDAY_9, chain: null })[0].reason, 'no_chain');
});

test('short strangle gestiona: hold, take profit, stop por prima, stop por delta y salida por tiempo', () => {
  const t = templates.getTemplate('short_strangle');
  const params = templates.validateParams('short_strangle', {});
  const chain = chainFor(FRIDAY_9, 7);
  const [open] = t.evaluate({ now: FRIDAY_9, spot: SPOT, chain, positions: [], params });
  const [callLeg, putLeg] = open.legs;
  const mk = (quoteCall, quotePut) => [
    positionFrom(callLeg, { id: 1, entryPrice: 100, quote: quoteCall }),
    positionFrom(putLeg, { id: 2, entryPrice: 100, quote: quotePut }),
  ];
  const now = FRIDAY_9 + DAY_MS;
  const run = (positions, at = now) => t.evaluate({ now: at, spot: SPOT, chain, positions, params })[0];

  assert.equal(run(mk({ ask: 80, delta: 0.1 }, { ask: 80, delta: -0.1 })).type, 'hold');

  const tp = run(mk({ ask: 40, delta: 0.05 }, { ask: 50, delta: -0.05 }));
  assert.equal(tp.type, 'close');
  assert.equal(tp.reason, 'take_profit');
  assert.deepEqual(tp.legs.map((l) => [l.positionId, l.side]), [[1, 'BUY'], [2, 'BUY']]);

  assert.equal(run(mk({ ask: 500, delta: 0.3 }, { ask: 110, delta: -0.05 })).reason, 'stop_loss');
  assert.equal(run(mk({ ask: 150, delta: 0.45 }, { ask: 20, delta: -0.02 })).reason, 'delta_stop');

  const positions = mk({ ask: 80, delta: 0.1 }, { ask: 80, delta: -0.1 });
  const lateAt = positions[0].expiryMs - 5 * HOUR_MS;
  assert.equal(run(positions, lateAt).reason, 'time_exit');
  assert.equal(run(mk(null, null)).reason, 'no_quote');
});

test('covered call vende una call OTM por la tenencia declarada y toma beneficio', () => {
  const t = templates.getTemplate('covered_call');
  const params = templates.validateParams('covered_call', { holdingQty: 0.5 });
  const chain = chainFor(FRIDAY_9, 7);
  const [open] = t.evaluate({ now: FRIDAY_9, spot: SPOT, chain, positions: [], params });
  assert.equal(open.type, 'open');
  assert.equal(open.legs.length, 1);
  const [leg] = open.legs;
  assert.equal(leg.optionType, 'C');
  assert.equal(leg.side, 'SELL');
  assert.equal(leg.quantity, 0.5);
  assert.ok(leg.strike > SPOT && Math.abs(leg.delta - 0.25) < 0.04);

  const pos = (ask) => [positionFrom(leg, { entryPrice: 100, quote: { ask, delta: 0.2 } })];
  assert.equal(t.evaluate({ now: FRIDAY_9 + DAY_MS, spot: SPOT, chain, positions: pos(60), params })[0].type, 'hold');
  const tp = t.evaluate({ now: FRIDAY_9 + DAY_MS, spot: SPOT, chain, positions: pos(15), params })[0];
  assert.equal(tp.reason, 'take_profit');
  // Con salida 0 h se deja vencer (no hay salida por tiempo).
  const nearExpiry = pos(60)[0].expiryMs - HOUR_MS;
  assert.equal(t.evaluate({ now: nearExpiry, spot: SPOT, chain, positions: pos(60), params })[0].type, 'hold');
});

test('protective put compra put Δ≈−0.25 y hace roll antes del vencimiento', () => {
  const t = templates.getTemplate('protective_put');
  const params = templates.validateParams('protective_put', { holdingQty: 0.2 });
  const chain = chainFor(FRIDAY_9, 30);
  const [open] = t.evaluate({ now: FRIDAY_9, spot: SPOT, chain, positions: [], params });
  assert.equal(open.type, 'open');
  const [leg] = open.legs;
  assert.equal(leg.side, 'BUY');
  assert.equal(leg.optionType, 'P');
  assert.equal(leg.quantity, 0.2);
  assert.ok(Math.abs(leg.delta + 0.25) < 0.04);
  assert.equal(leg.price, chain.rows.find((r) => r.strike === leg.strike).put.ask);

  const position = positionFrom(leg, { quote: { bid: 50, delta: -0.2 } });
  assert.equal(t.evaluate({ now: FRIDAY_9 + DAY_MS, spot: SPOT, chain, positions: [position], params })[0].type, 'hold');

  const rollAt = position.expiryMs - 4 * DAY_MS;
  const rollChain = chainFor(rollAt, 30);
  const actions = t.evaluate({ now: rollAt, spot: SPOT, chain: rollChain, positions: [position], params });
  assert.deepEqual(actions.map((a) => a.type), ['close', 'open']);
  assert.equal(actions[0].legs[0].side, 'SELL');
  assert.ok(parseSymbol(actions[1].legs[0].symbol).expiryMs > position.expiryMs);

  const pending = t.evaluate({ now: rollAt, spot: SPOT, chain: null, positions: [position], params });
  assert.equal(pending[0].reason, 'roll_pending');
});
