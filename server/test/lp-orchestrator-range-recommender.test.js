const test = require('node:test');
const assert = require('node:assert/strict');

const { recommendRangeWidthPct, recommendEthUsdcHalfWidthPct } = require('../src/services/lp-orchestrator/range-recommender');

test('ETH/USDC recomienda semiancho max(4.2%, 3×ATR14h/precio) y conserva widthPct legado', () => {
  const r = recommendEthUsdcHalfWidthPct({ atr14h: 40, price: 2000 });
  assert.deepEqual(r, { halfWidthPct: 6, widthPct: 12, source: 'max_4_2pct_or_3atr', requiresConfirmation: false });
});

test('ETH/USDC cae a ±5% sin ATR y pide confirmación si el ancho total supera 20%', () => {
  assert.deepEqual(recommendEthUsdcHalfWidthPct({}), { halfWidthPct: 5, widthPct: 10, source: 'fallback_5pct', requiresConfirmation: false });
  assert.equal(recommendEthUsdcHalfWidthPct({ atr14h: 100, price: 1000 }).requiresConfirmation, true);
});

test('ancho base proporcional a la volatilidad (k·RV)', () => {
  const r = recommendRangeWidthPct({ rvPct: 60, currentWidthPct: 5, volMultiplier: 0.15 });
  // 60 * 0.15 = 9
  assert.equal(r.baseWidthPct, 9);
  assert.equal(r.recommendedWidthPct, 9);
  assert.equal(r.source, 'volatility');
});

test('time-in-range bajo (34%) ensancha el rango respecto al actual', () => {
  const r = recommendRangeWidthPct({
    rvPct: 60, timeInRangePct: 34, currentWidthPct: 5, volMultiplier: 0.15,
  });
  // max(9, 5) * 1.25 = 11.25 → debe superar tanto el actual (5) como el base (9)
  assert.equal(r.feedback, 'widen_low_time_in_range');
  assert.ok(r.recommendedWidthPct > 9, `esperado > 9, fue ${r.recommendedWidthPct}`);
  assert.equal(r.recommendedWidthPct, 11.25);
});

test('time-in-range alto (95%) angosta el rango para ganar más fees', () => {
  const r = recommendRangeWidthPct({
    rvPct: 40, timeInRangePct: 95, currentWidthPct: 8, volMultiplier: 0.15,
  });
  // min(6, 8) * 0.85 = 5.1
  assert.equal(r.feedback, 'narrow_high_time_in_range');
  assert.ok(r.recommendedWidthPct < 8, `esperado < 8, fue ${r.recommendedWidthPct}`);
  assert.equal(r.recommendedWidthPct, 5.1);
});

test('time-in-range medio no aplica feedback (mantiene base de vol)', () => {
  const r = recommendRangeWidthPct({
    rvPct: 50, timeInRangePct: 70, currentWidthPct: 5, volMultiplier: 0.15,
  });
  assert.equal(r.feedback, null);
  assert.equal(r.recommendedWidthPct, 7.5);
});

test('sin RV cae al ancho actual como base', () => {
  const r = recommendRangeWidthPct({ currentWidthPct: 6 });
  assert.equal(r.source, 'current_width');
  assert.equal(r.recommendedWidthPct, 6);
  assert.equal(r.rvPct, null);
});

test('respeta cotas min/max', () => {
  const hi = recommendRangeWidthPct({ rvPct: 1000, currentWidthPct: 5, maxWidthPct: 30 });
  assert.equal(hi.recommendedWidthPct, 30);
  const lo = recommendRangeWidthPct({ rvPct: 1, currentWidthPct: 5, minWidthPct: 1, volMultiplier: 0.15 });
  assert.equal(lo.recommendedWidthPct, 1); // 0.15 → clamp a 1
});

test('caso histórico: ETH ±5% con 34% TIR recomienda ensanchar de forma accionable', () => {
  // Sin RV disponible, solo el feedback empírico de time-in-range.
  const r = recommendRangeWidthPct({ timeInRangePct: 34, currentWidthPct: 5 });
  assert.equal(r.feedback, 'widen_low_time_in_range');
  assert.equal(r.recommendedWidthPct, 6.25); // 5 * 1.25
  assert.equal(r.source, 'tir');
});

// --- Termino de coste de cobertura (plan 2026-08-10) ---
// Angostar sube gamma (~1/ancho^2) y con ella la frecuencia de re-cobertura.
// Sin este termino el lazo se realimenta: TIR alto -> angostar -> mas gamma ->
// mas coste de hedge -> el TIR sigue alto -> angostar otra vez.

test('coste de cobertura alto bloquea el angostamiento pese a TIR alto', () => {
  // Cifras reales del orquestador #37 (2026-08-10): execFees 1.00 + slippage
  // 2.02 = 3.02 sobre 7.78 de fees brutas -> ratio 0.388 > 1/3.
  const r = recommendRangeWidthPct({
    rvPct: 40, timeInRangePct: 93, currentWidthPct: 2.5, volMultiplier: 0.15,
    hedgeCostUsd: 3.02, lpFeesUsd: 7.78,
  });
  assert.equal(r.feedback, 'narrow_blocked_by_hedge_cost');
  assert.equal(r.recommendedWidthPct, 2.5, 'debe mantener el ancho, no angostarlo');
  assert.equal(r.hedgeCostRatio, 0.39);
});

test('coste de cobertura bajo permite angostar normalmente', () => {
  // Cifras reales del #35 (fee tier 0.3%): 0.05 + 0.05 sobre 0.90 -> 0.111.
  const r = recommendRangeWidthPct({
    rvPct: 40, timeInRangePct: 95, currentWidthPct: 8, volMultiplier: 0.15,
    hedgeCostUsd: 0.10, lpFeesUsd: 0.90,
  });
  assert.equal(r.feedback, 'narrow_high_time_in_range');
  assert.equal(r.recommendedWidthPct, 5.1);
});

test('el coste NUNCA impide ensanchar (TIR bajo manda: es riesgo, no coste)', () => {
  const r = recommendRangeWidthPct({
    rvPct: 60, timeInRangePct: 34, currentWidthPct: 5, volMultiplier: 0.15,
    hedgeCostUsd: 99, lpFeesUsd: 1,
  });
  assert.equal(r.feedback, 'widen_low_time_in_range');
  assert.equal(r.recommendedWidthPct, 11.25);
});

test('sin senal de coste el comportamiento es identico al previo', () => {
  const sin = recommendRangeWidthPct({
    rvPct: 40, timeInRangePct: 95, currentWidthPct: 8, volMultiplier: 0.15,
  });
  assert.equal(sin.feedback, 'narrow_high_time_in_range');
  assert.equal(sin.hedgeCostRatio, null);
  // lpFees 0 no debe producir division por cero ni bloquear
  const cero = recommendRangeWidthPct({
    rvPct: 40, timeInRangePct: 95, currentWidthPct: 8, volMultiplier: 0.15,
    hedgeCostUsd: 5, lpFeesUsd: 0,
  });
  assert.equal(cero.feedback, 'narrow_high_time_in_range');
  assert.equal(cero.hedgeCostRatio, null);
});

test('un maxHedgeCostRatio basura cae al default en vez de desactivar el gate', () => {
  // Number(strategyConfig.maxHedgeCostRatio) sobre un valor no numerico da NaN.
  // Comparar contra NaN es siempre false, asi que el gate se apagaria en
  // silencio justo cuando deberia proteger.
  for (const basura of [NaN, undefined, null, 0, -1]) {
    const r = recommendRangeWidthPct({
      rvPct: 40, timeInRangePct: 93, currentWidthPct: 2.5, volMultiplier: 0.15,
      hedgeCostUsd: 3.02, lpFeesUsd: 7.78, maxHedgeCostRatio: basura,
    });
    assert.equal(r.feedback, 'narrow_blocked_by_hedge_cost', `umbral: ${String(basura)}`);
  }
});

test('un maxHedgeCostRatio valido si manda sobre el default', () => {
  // 0.39 queda por debajo de 0.5 -> permite angostar.
  const r = recommendRangeWidthPct({
    rvPct: 40, timeInRangePct: 93, currentWidthPct: 2.5, volMultiplier: 0.15,
    hedgeCostUsd: 3.02, lpFeesUsd: 7.78, maxHedgeCostRatio: 0.5,
  });
  assert.equal(r.feedback, 'narrow_high_time_in_range');
});
