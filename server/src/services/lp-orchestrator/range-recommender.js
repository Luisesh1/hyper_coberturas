/**
 * range-recommender.js
 *
 * Helper puro: recomienda un `rangeWidthPct` para el LP combinando dos señales:
 *
 *  1) Volatilidad realizada (RV anualizada, de `computeVolatilityStats`):
 *     define un ancho base proporcional ≈ k · RV. Más vol → rango más ancho
 *     para no salirse de rango; menos vol → rango más angosto para concentrar
 *     liquidez y ganar más fees.
 *
 *  2) Feedback empírico de time-in-range (lo que el orquestador YA mide y hoy
 *     no usa): si el LP vivió poco tiempo en rango, el modelo de vol se quedó
 *     corto → ensanchar. Si vivió casi siempre en rango, hay margen para
 *     angostar y ganar más fees.
 *
 * El análisis histórico mostró time-in-range del 34% con rango fijo ±5%, que
 * es el problema raíz que este helper corrige. La recomendación es ADVISORY:
 * el re-range lo firma el usuario, este módulo solo sugiere el ancho.
 *
 * Sin IO. Sin dependencias. 100% testeable en aislamiento.
 */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {object} args
 * @param {number} [args.rvPct]           - RV anualizada (%), max(rv4h, rv24h). Opcional.
 * @param {number} [args.timeInRangePct]  - tiempo en rango observado (0-100). Opcional.
 * @param {number} [args.currentWidthPct] - rangeWidthPct configurado actual.
 * @param {number} [args.volMultiplier]   - k: fracción de la RV anualizada → ancho base.
 * @param {number} [args.minWidthPct]
 * @param {number} [args.maxWidthPct]
 * @param {number} [args.tirLowPct]       - bajo este TIR se ensancha.
 * @param {number} [args.tirHighPct]      - sobre este TIR se considera angostar.
 * @param {number} [args.widenFactor]
 * @param {number} [args.narrowFactor]
 * @returns {{ recommendedWidthPct, baseWidthPct, feedback, source, rvPct, timeInRangePct }}
 */
function recommendRangeWidthPct({
  rvPct,
  timeInRangePct,
  currentWidthPct,
  volMultiplier = 0.15,
  minWidthPct = 1,
  maxWidthPct = 30,
  tirLowPct = 50,
  tirHighPct = 90,
  widenFactor = 1.25,
  narrowFactor = 0.85,
} = {}) {
  const fallbackWidth = isFiniteNumber(currentWidthPct) && currentWidthPct > 0
    ? currentWidthPct
    : 5;

  // 1) Ancho base desde volatilidad (si hay RV); si no, parte del actual.
  const hasRv = isFiniteNumber(rvPct) && rvPct > 0;
  const baseWidthPct = hasRv ? rvPct * volMultiplier : fallbackWidth;
  let width = baseWidthPct;
  let source = hasRv ? 'volatility' : 'current_width';

  // 2) Feedback por time-in-range. Anclamos al mayor entre el ancho del modelo
  //    y el actual antes de ensanchar (para garantizar que ensanchar suba),
  //    y al menor antes de angostar (para garantizar que angostar baje).
  let feedback = null;
  if (isFiniteNumber(timeInRangePct)) {
    if (timeInRangePct < tirLowPct) {
      width = Math.max(baseWidthPct, fallbackWidth) * widenFactor;
      feedback = 'widen_low_time_in_range';
      source = hasRv ? 'volatility+tir' : 'tir';
    } else if (timeInRangePct > tirHighPct) {
      width = Math.min(baseWidthPct, fallbackWidth) * narrowFactor;
      feedback = 'narrow_high_time_in_range';
      source = hasRv ? 'volatility+tir' : 'tir';
    }
  }

  const recommendedWidthPct = round2(clamp(width, minWidthPct, maxWidthPct));

  return {
    recommendedWidthPct,
    baseWidthPct: round2(clamp(baseWidthPct, minWidthPct, maxWidthPct)),
    feedback,
    source,
    rvPct: hasRv ? round2(rvPct) : null,
    timeInRangePct: isFiniteNumber(timeInRangePct) ? round2(timeInRangePct) : null,
  };
}

module.exports = {
  recommendRangeWidthPct,
};
