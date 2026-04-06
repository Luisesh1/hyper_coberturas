/**
 * Helpers puros del wizard SmartCreatePoolModal.
 * Sin estado interno ni dependencias de React.
 */

/**
 * Convierte la lista `selectedFundingAssets` (que puede tener entradas duplicadas
 * por assetId con distintos roles de funding) en un mapa `{assetId: {enabled, amount}}`
 * acumulando los montos.
 */
export function buildSelectionMap(selectedFundingAssets = []) {
  return selectedFundingAssets.reduce((acc, asset) => {
    const previous = acc[asset.assetId];
    const nextAmount = Number(asset.useAmount || 0);
    const previousAmount = Number(previous?.amount || 0);
    const totalAmount = previous ? (previousAmount + nextAmount) : nextAmount;
    acc[asset.assetId] = {
      enabled: true,
      amount: Number.isFinite(totalAmount) ? totalAmount.toFixed(12).replace(/\.?0+$/, '') : String(asset.useAmount || ''),
    };
    return acc;
  }, {});
}

export function getSelectedPreset(suggestions, presetKey) {
  return suggestions?.suggestions?.find((item) => item.preset === presetKey) || null;
}

/**
 * Calcula los `amount0Desired`/`amount1Desired` para el modo "Personalizado"
 * a partir del USD target y el porcentaje de Token0.
 */
export function computeCustomAmounts(suggestions, totalUsdTarget, token0Pct) {
  const token0UsdPrice = Number(suggestions?.token0?.usdPrice || 0);
  const token1UsdPrice = Number(suggestions?.token1?.usdPrice || 0);
  if (!Number.isFinite(token0UsdPrice) || token0UsdPrice <= 0 || !Number.isFinite(token1UsdPrice) || token1UsdPrice <= 0) {
    return { amount0Desired: '0', amount1Desired: '0' };
  }

  const amount0Usd = Number(totalUsdTarget || 0) * (Number(token0Pct || 0) / 100);
  const amount1Usd = Number(totalUsdTarget || 0) * ((100 - Number(token0Pct || 0)) / 100);
  const amount0Desired = amount0Usd > 0 ? amount0Usd / token0UsdPrice : 0;
  const amount1Desired = amount1Usd > 0 ? amount1Usd / token1UsdPrice : 0;

  return {
    amount0Desired: amount0Desired.toFixed(Math.min(6, Number(suggestions?.token0?.decimals || 6))),
    amount1Desired: amount1Desired.toFixed(Math.min(6, Number(suggestions?.token1?.decimals || 6))),
  };
}

export function buildOptionalPoolContext(suggestions) {
  const optional = {};
  if (suggestions?.tickSpacing != null) optional.tickSpacing = suggestions.tickSpacing;
  if (suggestions?.hooks) optional.hooks = suggestions.hooks;
  if (suggestions?.poolId) optional.poolId = suggestions.poolId;
  return optional;
}

export function deriveFundingIssue(err) {
  if (!err) return null;
  return {
    code: err.code || 'UNKNOWN_FUNDING_ERROR',
    message: err.message || 'No se pudo construir el plan de fondeo.',
    details: err.details || null,
  };
}

export function formatFundingIssueTitle(issue) {
  switch (issue?.code) {
    case 'INSUFFICIENT_BALANCE_AFTER_GAS_RESERVE':
      return 'Saldo insuficiente después de reservar gas';
    case 'INSUFFICIENT_SAME_NETWORK_BALANCE':
      return 'Saldo insuficiente en la red seleccionada';
    case 'NO_SUPPORTED_SWAP_ROUTE':
      return 'No hay ruta de swap soportada';
    case 'INSUFFICIENT_DIRECT_OR_SWAP_OUTPUT':
      return 'El capital no alcanza para fondear el LP';
    default:
      return 'No se pudo construir el plan de fondeo';
  }
}
