/**
 * Helpers de estado del formulario de PositionActionModal.
 *
 * - `getInitialState`: construye el estado inicial dependiendo de la acción.
 * - `buildPayload`: convierte el estado del form al payload que espera el server.
 *
 * Extraído de `PositionActionModal.jsx`.
 */

export function getInitialState(action, pool, defaults) {
  if (action === 'create-position') {
    return {
      network: defaults.network || 'ethereum',
      version: defaults.version || 'v3',
      walletAddress: defaults.walletAddress || '',
      token0Address: pool?.token0Address || '',
      token1Address: pool?.token1Address || '',
      fee: pool?.fee ? String(pool.fee) : '3000',
      tickSpacing: pool?.tickSpacing != null ? String(pool.tickSpacing) : '',
      hooks: pool?.hooks || '',
      poolId: pool?.poolId || '',
      amount0Desired: '',
      amount1Desired: '',
      rangeLowerPrice: '',
      rangeUpperPrice: '',
      slippageBps: '100',
    };
  }

  return {
    network: pool?.network || defaults.network || 'ethereum',
    version: pool?.version || defaults.version || 'v3',
    walletAddress: defaults.walletAddress || '',
    positionIdentifier: String(pool?.identifier || pool?.positionIdentifier || ''),
    poolId: pool?.poolId || '',
    tickSpacing: pool?.tickSpacing != null ? String(pool.tickSpacing) : '',
    hooks: pool?.hooks || '',
    amount0Desired: pool?.positionAmount0 != null ? String(pool.positionAmount0) : '',
    amount1Desired: pool?.positionAmount1 != null ? String(pool.positionAmount1) : '',
    liquidityPercent: '25',
    rangeLowerPrice: pool?.rangeLowerPrice != null ? String(pool.rangeLowerPrice) : '',
    rangeUpperPrice: pool?.rangeUpperPrice != null ? String(pool.rangeUpperPrice) : '',
    targetWeightToken0Pct: '50',
    slippageBps: '100',
  };
}

/**
 * Convierte el `formState` interno al payload tipado que esperan los endpoints
 * del server. Cada acción tiene su propia forma porque acepta distintos params.
 */
export function buildPayload(action, formState) {
  switch (action) {
    case 'increase-liquidity':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        amount0Desired: formState.amount0Desired,
        amount1Desired: formState.amount1Desired,
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'decrease-liquidity':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        liquidityPercent: Number(formState.liquidityPercent || 100),
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'collect-fees':
    case 'reinvest-fees':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'modify-range':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        rangeLowerPrice: Number(formState.rangeLowerPrice),
        rangeUpperPrice: Number(formState.rangeUpperPrice),
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'rebalance':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        targetWeightToken0Pct: Number(formState.targetWeightToken0Pct),
        rangeLowerPrice: Number(formState.rangeLowerPrice),
        rangeUpperPrice: Number(formState.rangeUpperPrice),
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'create-position':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        token0Address: formState.token0Address,
        token1Address: formState.token1Address,
        fee: Number(formState.fee),
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        amount0Desired: formState.amount0Desired,
        amount1Desired: formState.amount1Desired,
        rangeLowerPrice: Number(formState.rangeLowerPrice),
        rangeUpperPrice: Number(formState.rangeUpperPrice),
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'close-to-usdc':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'close-keep-assets':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
      };
    default:
      return formState;
  }
}

/**
 * Helpers de conversión precio ↔ porcentaje desde el precio actual del pool.
 * Usados por `ModifyRangeFields`.
 */
export function pctToPrice(priceCurrent, pct) {
  return priceCurrent * (1 + pct / 100);
}

export function priceToPct(priceCurrent, price) {
  if (!priceCurrent || priceCurrent <= 0) return 0;
  return ((price - priceCurrent) / priceCurrent) * 100;
}
