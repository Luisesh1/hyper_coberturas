/**
 * verifier.js
 *
 * Detección de drift post-acción. Tras una transacción on-chain, se compara
 * el estado refrescado del LP contra lo que esperábamos según la acción.
 * Si hay desalineación significativa el orquestador entra en `failed` y
 * espera revisión humana.
 *
 * Es 100% puro: recibe `expected` y `refreshedSnapshot` y devuelve un
 * objeto con la severidad y los drifts detectados.
 */

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function withinRelTolerance(actual, expected, tolerancePct = 0.5) {
  if (actual == null || expected == null) return false;
  if (expected === 0) return Math.abs(actual) < 1e-9;
  const diffPct = Math.abs((actual - expected) / expected) * 100;
  return diffPct <= tolerancePct;
}

/**
 * @param {object} params
 * @param {string} params.action - 'modify-range' | 'rebalance' | 'collect-fees' | 'reinvest-fees' | 'close-to-usdc' | 'close-keep-assets' | 'create-position'
 * @param {object} params.expected - lo que se espera ver tras la acción
 * @param {object|null} params.refreshedSnapshot - snapshot del LP refrescado tras la tx
 */
function verifyExpectedState({ action, expected, refreshedSnapshot }) {
  const drifts = [];

  if (action === 'create-position') {
    if (!refreshedSnapshot || !refreshedSnapshot.identifier) {
      drifts.push({ field: 'positionIdentifier', kind: 'missing_position' });
    }
    return finalize(drifts);
  }

  // Acciones de cierre: la posición debe haber desaparecido o tener
  // liquidez = 0.
  if (action === 'close-to-usdc' || action === 'close-keep-assets') {
    if (refreshedSnapshot) {
      const liquidity = num(refreshedSnapshot.liquidity, 0);
      const valueUsd = num(refreshedSnapshot.currentValueUsd, 0);
      if (liquidity > 0 && valueUsd > 1) {
        drifts.push({
          field: 'liquidity',
          kind: 'position_not_closed',
          actual: liquidity,
          expected: 0,
        });
      }
    }
    return finalize(drifts);
  }

  // Para el resto, necesitamos snapshot.
  if (!refreshedSnapshot) {
    drifts.push({ field: 'snapshot', kind: 'missing_snapshot' });
    return finalize(drifts);
  }

  if (action === 'modify-range') {
    const expectedLower = num(expected?.rangeLowerPrice);
    const expectedUpper = num(expected?.rangeUpperPrice);
    const actualLower = num(refreshedSnapshot.rangeLowerPrice);
    const actualUpper = num(refreshedSnapshot.rangeUpperPrice);
    if (expectedLower != null && !withinRelTolerance(actualLower, expectedLower, 1)) {
      drifts.push({
        field: 'rangeLowerPrice',
        kind: 'range_mismatch',
        actual: actualLower,
        expected: expectedLower,
      });
    }
    if (expectedUpper != null && !withinRelTolerance(actualUpper, expectedUpper, 1)) {
      drifts.push({
        field: 'rangeUpperPrice',
        kind: 'range_mismatch',
        actual: actualUpper,
        expected: expectedUpper,
      });
    }
    if (num(refreshedSnapshot.liquidity, 0) <= 0) {
      drifts.push({ field: 'liquidity', kind: 'no_liquidity_after_modify' });
    }
  }

  if (action === 'rebalance') {
    if (num(refreshedSnapshot.liquidity, 0) <= 0) {
      drifts.push({ field: 'liquidity', kind: 'no_liquidity_after_rebalance' });
    }
  }

  if (action === 'collect-fees' || action === 'reinvest-fees') {
    const unclaimed = num(refreshedSnapshot.unclaimedFeesUsd, 0);
    // Tras un collect/reinvest exitoso, las fees no cobradas deberían ser ~0.
    // Toleramos hasta $0.50 por dust.
    if (unclaimed > 0.5) {
      drifts.push({
        field: 'unclaimedFeesUsd',
        kind: 'fees_not_collected',
        actual: unclaimed,
      });
    }
    if (action === 'reinvest-fees') {
      const liquidity = num(refreshedSnapshot.liquidity, 0);
      if (liquidity <= 0) {
        drifts.push({ field: 'liquidity', kind: 'no_liquidity_after_reinvest' });
      }
    }
  }

  return finalize(drifts);
}

function finalize(drifts) {
  if (drifts.length === 0) {
    return { ok: true, drifts: [], severity: 'none' };
  }
  const critical = drifts.some((d) =>
    d.kind === 'missing_position'
    || d.kind === 'missing_snapshot'
    || d.kind === 'position_not_closed'
    || d.kind === 'no_liquidity_after_modify'
    || d.kind === 'no_liquidity_after_rebalance'
    || d.kind === 'no_liquidity_after_reinvest'
  );
  return {
    ok: false,
    drifts,
    severity: critical ? 'critical' : 'warn',
  };
}

module.exports = {
  verifyExpectedState,
};
