/**
 * Dimensionado del hedge a partir del delta real del LP.
 *
 * Para una posición Uniswap v3 con rango [Pa, Pb] y precio P:
 *
 *   x = L(1/√P − 1/√Pb)      cantidad de token volátil
 *   y = L(√P − √Pa)          cantidad de token estable
 *   V = x·P + y = L(2√P − P/√Pb − √Pa)
 *   dV/dP = L(1/√P − 1/√Pb) = x
 *
 * O sea: el delta en unidades de token **es** la cantidad de token volátil que
 * la posición mantiene. El notional a cubrir es el valor USD de esa pata, y la
 * liquidez `L` se cancela al dividir, así que basta con P, Pa y Pb — sin math
 * de Uniswap ni conocer la posición todavía (el LP aún no está minteado cuando
 * el wizard pide este número).
 *
 * No aplica `targetHedgeRatio` a propósito: el ratio efectivo del motor es
 * `targetHedgeRatio × zoneMultiplier` bajo legacy, y exactamente 1 bajo
 * net_profit_v1 en operación real, así que multiplicar aquí acertaría menos, no
 * más. El análisis completo está en
 * docs/superpowers/specs/2026-08-17-notional-auto-delta-design.md
 */

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Fracción del valor del LP que está en el token volátil, entre 0 y 1.
 * Exportada para que la UI pueda explicar el número ("88% del capital") sin
 * recalcularlo a partir del notional.
 */
export function computeVolatileFraction({ currentPrice, rangeLowerPrice, rangeUpperPrice }) {
  const price = finitePositive(currentPrice);
  const lower = finitePositive(rangeLowerPrice);
  const upper = finitePositive(rangeUpperPrice);
  if (price == null || lower == null || upper == null || upper <= lower) return null;

  // Fuera de rango la posición está enteramente en un solo token.
  if (price <= lower) return 1;
  if (price >= upper) return 0;

  const sqrtP = Math.sqrt(price);
  const volatileLeg = sqrtP - (price / Math.sqrt(upper));
  const totalValue = (2 * sqrtP) - (price / Math.sqrt(upper)) - Math.sqrt(lower);
  if (!(totalValue > 0)) return null;

  return volatileLeg / totalValue;
}

/**
 * Notional USD a cubrir con el hedge. Devuelve `null` cuando no hay datos
 * suficientes, para que el llamador caiga en su heurística de reserva.
 */
export function computeDeltaNotionalUsd({
  capitalUsd,
  currentPrice,
  rangeLowerPrice,
  rangeUpperPrice,
}) {
  const capital = finitePositive(capitalUsd);
  if (capital == null) return null;

  const fraction = computeVolatileFraction({ currentPrice, rangeLowerPrice, rangeUpperPrice });
  if (fraction == null) return null;

  return capital * fraction;
}

/**
 * Consecuencia de dimensionar el hedge: margen inmovilizado y a qué distancia
 * queda la liquidación. Es una aproximación de primer orden — ignora el margen
 * de mantenimiento de Hyperliquid, así que la liquidación real llega algo
 * *antes* de este porcentaje. Sirve para dimensionar de un vistazo, no para
 * apurar el margen; el número exacto lo da el pre-flight contra la cuenta.
 */
export function computeHedgeConsequence({ notionalUsd, leverage }) {
  const notional = finitePositive(notionalUsd);
  const lev = finitePositive(leverage);
  if (notional == null || lev == null) return null;

  return {
    requiredMarginUsd: notional / lev,
    liquidationMovePct: (100 / lev).toFixed(1),
  };
}
