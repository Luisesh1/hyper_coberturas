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
 * @param {number} [args.hedgeCostUsd]    - coste de EJECUCION de la cobertura: execFees + slippage
 *   del hedge. NO incluye el PnL realizado — un hedge sano lo tiene distinto de
 *   cero por diseno y meterlo confundiria cobertura con coste.
 * @param {number} [args.lpFeesUsd]       - fees brutas del LP, en la misma base que `hedgeCostUsd`.
 *   Hoy el llamador pasa ambos ACUMULADOS DE POR VIDA (ver accounting.js), no
 *   ventaneados: da una media de largo plazo, mas estable que una ventana corta
 *   pero que diluye un encarecimiento reciente. Si algun dia se quiere reactivo,
 *   hay que ventanear los DOS a la vez o el ratio queda sin sentido.
 * @param {number} [args.maxHedgeCostRatio] - si hedgeCost/lpFees supera esto, no se angosta.
 * @returns {{ recommendedWidthPct, baseWidthPct, feedback, source, rvPct, timeInRangePct, hedgeCostRatio }}
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
  hedgeCostUsd,
  lpFeesUsd,
  // Mismo umbral coste/beneficio que ya usa `costToRewardThreshold` en
  // lp-orchestrator.service para decidir un modify-range: si cubrir se come mas
  // de un tercio de las fees brutas, concentrar mas liquidez no compensa.
  maxHedgeCostRatio = 0.3333,
} = {}) {
  const fallbackWidth = isFiniteNumber(currentWidthPct) && currentWidthPct > 0
    ? currentWidthPct
    : 5;

  // 1) Ancho base desde volatilidad (si hay RV); si no, parte del actual.
  const hasRv = isFiniteNumber(rvPct) && rvPct > 0;
  const baseWidthPct = hasRv ? rvPct * volMultiplier : fallbackWidth;
  let width = baseWidthPct;
  let source = hasRv ? 'volatility' : 'current_width';

  // 2) Coste de cobertura. Angostar el rango concentra liquidez y sube las
  //   fees, pero tambien sube gamma (~1/ancho^2) y con ella la frecuencia de
  //   re-cobertura: mas taker fees, mas slippage y mas PnL realizado en cada
  //   reversion. Sin este termino la funcion objetivo esta incompleta y el lazo
  //   se realimenta solo — medido el 2026-08-10: los pools 0.05% con rango ~2.5%
  //   rebalanceaban 4.5x mas que el 0.3% con rango ~4.2%, y el orquestador #37
  //   quemaba ~34% anualizado solo en ejecucion con el TIR en 93%.
  //   Nota: solo BLOQUEA el angostamiento; nunca fuerza ensanchar, porque eso
  //   es decision de riesgo (time-in-range), no de coste.
  const hasCostSignal = isFiniteNumber(hedgeCostUsd)
    && isFiniteNumber(lpFeesUsd)
    && lpFeesUsd > 0;
  const hedgeCostRatio = hasCostSignal ? hedgeCostUsd / lpFeesUsd : null;
  // Un umbral no-finito (p.ej. `Number(strategyConfig.maxHedgeCostRatio)` sobre
  // un valor basura da NaN) desactivaria el gate en silencio, porque cualquier
  // comparacion contra NaN es false. Se cae al default en vez de no proteger.
  const costLimit = isFiniteNumber(maxHedgeCostRatio) && maxHedgeCostRatio > 0
    ? maxHedgeCostRatio
    : 0.3333;
  const costBlocksNarrowing = hasCostSignal && hedgeCostRatio > costLimit;

  // 3) Feedback por time-in-range. Anclamos al mayor entre el ancho del modelo
  //    y el actual antes de ensanchar (para garantizar que ensanchar suba),
  //    y al menor antes de angostar (para garantizar que angostar baje).
  let feedback = null;
  if (isFiniteNumber(timeInRangePct)) {
    if (timeInRangePct < tirLowPct) {
      width = Math.max(baseWidthPct, fallbackWidth) * widenFactor;
      feedback = 'widen_low_time_in_range';
      source = hasRv ? 'volatility+tir' : 'tir';
    } else if (timeInRangePct > tirHighPct) {
      if (costBlocksNarrowing) {
        // El LP vive en rango, pero cubrirlo ya cuesta mas de lo que rinde.
        // Angostar empeoraria justo el termino dominante.
        width = fallbackWidth;
        feedback = 'narrow_blocked_by_hedge_cost';
        source = hasRv ? 'volatility+tir+cost' : 'tir+cost';
      } else {
        width = Math.min(baseWidthPct, fallbackWidth) * narrowFactor;
        feedback = 'narrow_high_time_in_range';
        source = hasRv ? 'volatility+tir' : 'tir';
      }
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
    hedgeCostRatio: hedgeCostRatio != null ? round2(hedgeCostRatio) : null,
  };
}

/** Recomendación ETH/WETH+USDC: `halfWidthPct` se muestra como ±X%. */
function recommendEthUsdcHalfWidthPct({ atr14h, price } = {}) {
  const currentPrice = Number(price);
  const atr = Number(atr14h);
  const fromAtr = Number.isFinite(currentPrice) && currentPrice > 0 && Number.isFinite(atr) && atr > 0
    ? (3 * atr / currentPrice) * 100
    : null;
  const halfWidthPct = round2(Math.max(4.2, fromAtr ?? 5));
  return {
    halfWidthPct,
    // Compatibilidad explícita: el campo legado es el ancho total.
    widthPct: round2(halfWidthPct * 2),
    source: fromAtr == null ? 'fallback_5pct' : 'max_4_2pct_or_3atr',
    requiresConfirmation: halfWidthPct * 2 > 20,
  };
}

module.exports = {
  recommendRangeWidthPct,
  recommendEthUsdcHalfWidthPct,
};
