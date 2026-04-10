/**
 * range-evaluator.js
 *
 * Helper puro: evalúa la posición del precio actual con respecto al rango
 * del LP y la "banda central" definida por edgeMarginPct.
 *
 * - rango LP: [rangeLowerPrice, rangeUpperPrice]
 * - banda central:
 *      lower + (upper - lower) * edgeMarginPct/100
 *      upper - (upper - lower) * edgeMarginPct/100
 *   con edgeMarginPct=40 → la banda central es el 20% central del rango.
 *
 * Sin IO. Sin dependencias. Es 100% testeable en aislamiento.
 */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function evaluateRangePosition({
  priceCurrent,
  rangeLowerPrice,
  rangeUpperPrice,
  edgeMarginPct,
}) {
  if (
    !isFiniteNumber(priceCurrent) ||
    !isFiniteNumber(rangeLowerPrice) ||
    !isFiniteNumber(rangeUpperPrice) ||
    rangeLowerPrice <= 0 ||
    rangeUpperPrice <= rangeLowerPrice
  ) {
    return {
      ok: false,
      reason: 'invalid_range_or_price',
      inRange: false,
      outOfRangeSide: null,
      centralBandLower: null,
      centralBandUpper: null,
      inCentralBand: false,
      distanceToNearEdgePct: null,
      nearEdgeSide: null,
      summary: 'invalid',
    };
  }

  const margin = isFiniteNumber(edgeMarginPct) ? Math.max(0, Math.min(50, edgeMarginPct)) : 40;
  const width = rangeUpperPrice - rangeLowerPrice;
  const centralBandLower = rangeLowerPrice + (width * margin) / 100;
  const centralBandUpper = rangeUpperPrice - (width * margin) / 100;

  const belowRange = priceCurrent < rangeLowerPrice;
  const aboveRange = priceCurrent > rangeUpperPrice;
  const inRange = !belowRange && !aboveRange;

  let inCentralBand = false;
  if (inRange && centralBandUpper > centralBandLower) {
    inCentralBand = priceCurrent >= centralBandLower && priceCurrent <= centralBandUpper;
  }

  // distancia al borde más cercano (en %): 0 = en el borde, 100 = en el centro
  let distanceToNearEdgePct = null;
  let nearEdgeSide = null;
  if (inRange && width > 0) {
    const distLower = ((priceCurrent - rangeLowerPrice) / width) * 100;
    const distUpper = ((rangeUpperPrice - priceCurrent) / width) * 100;
    if (distLower <= distUpper) {
      distanceToNearEdgePct = distLower;
      nearEdgeSide = 'lower';
    } else {
      distanceToNearEdgePct = distUpper;
      nearEdgeSide = 'upper';
    }
  }

  let summary;
  if (!inRange) summary = 'out_of_range';
  else if (inCentralBand) summary = 'central';
  else summary = 'edge_warning';

  return {
    ok: true,
    inRange,
    outOfRangeSide: belowRange ? 'below' : aboveRange ? 'above' : null,
    centralBandLower,
    centralBandUpper,
    inCentralBand,
    distanceToNearEdgePct,
    nearEdgeSide,
    summary,
    rangeWidth: width,
    edgeMarginPct: margin,
  };
}

module.exports = {
  evaluateRangePosition,
};
