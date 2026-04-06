/**
 * Builders de objetos de presentación / preview que el cliente consume.
 *
 * Estas funciones convierten datos internos (montos en raw, ticks, etc.) en
 * estructuras serializables para mostrar previews y avisos al usuario.
 */

const { ethers } = require('ethers');
const uniswapService = require('../uniswap.service');

/**
 * Construye el "preview" del estado de la posición tras ejecutar una acción.
 * Se usa en la pantalla de review para mostrar el rango y montos resultantes.
 */
function buildPostPreview({
  network,
  version,
  positionIdentifier,
  tickLower,
  tickUpper,
  amount0Desired,
  amount1Desired,
  token0,
  token1,
  priceCurrent,
}) {
  const lowerPrice = uniswapService.tickToPrice(tickLower, token0.decimals, token1.decimals);
  const upperPrice = uniswapService.tickToPrice(tickUpper, token0.decimals, token1.decimals);

  return {
    network,
    version,
    positionIdentifier: positionIdentifier ? String(positionIdentifier) : null,
    token0,
    token1,
    rangeLowerPrice: Number(lowerPrice.toFixed(6)),
    rangeUpperPrice: Number(upperPrice.toFixed(6)),
    priceCurrent: Number(priceCurrent.toFixed(6)),
    desiredAmounts: {
      amount0: ethers.formatUnits(amount0Desired, token0.decimals),
      amount1: ethers.formatUnits(amount1Desired, token1.decimals),
    },
  };
}

/**
 * Indica si una acción puede causar una migración de positionId (típicamente
 * cuando se mintea una nueva NFT en lugar de modificar la existente). Esta
 * info se usa para avisar al usuario que sus protecciones se moverán al
 * nuevo positionId tras la operación.
 */
function buildProtectionImpact(positionIdentifier, nextPositionIdentifier = null) {
  return {
    hasPotentialMigration: nextPositionIdentifier != null && String(nextPositionIdentifier) !== String(positionIdentifier),
    oldPositionIdentifier: positionIdentifier ? String(positionIdentifier) : null,
    expectedNewPositionIdentifier: nextPositionIdentifier ? String(nextPositionIdentifier) : null,
  };
}

module.exports = {
  buildPostPreview,
  buildProtectionImpact,
};
