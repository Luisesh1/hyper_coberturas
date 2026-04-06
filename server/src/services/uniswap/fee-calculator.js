/**
 * Cálculo de fees no reclamadas para posiciones Uniswap V3 y V4.
 *
 * El position manager solo expone `tokensOwed` (fees pre-snapshotted post-collect),
 * no las fees pendientes reales. Estas funciones derivan las fees reales desde
 * `feeGrowthInside` del pool y la posición.
 *
 * Extraído de `uniswap.service.js` para reducir tamaño y permitir reutilización.
 */

const Q128 = 2n ** 128n;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Calcula las fees no reclamadas de una posicion V3 usando fee growth del pool.
 * tokensOwed del position manager solo contiene fees pre-acumuladas (post-collect),
 * NO las fees pendientes reales. Para obtener las fees reales hay que calcular
 * feeGrowthInside a partir de los ticks y el estado global del pool.
 */
function computeV3UnclaimedFees({
  liquidity,
  tickCurrent,
  tickLower,
  tickUpper,
  feeGrowthGlobal0X128,
  feeGrowthGlobal1X128,
  feeGrowthOutsideLower0X128,
  feeGrowthOutsideLower1X128,
  feeGrowthOutsideUpper0X128,
  feeGrowthOutsideUpper1X128,
  feeGrowthInside0LastX128,
  feeGrowthInside1LastX128,
  tokensOwed0,
  tokensOwed1,
}) {
  const liq = BigInt(liquidity || 0);
  const tick = Number(tickCurrent);
  const tl = Number(tickLower);
  const tu = Number(tickUpper);

  if (liq <= 0n) {
    return { fees0: BigInt(tokensOwed0 || 0), fees1: BigInt(tokensOwed1 || 0) };
  }

  const fg0 = BigInt(feeGrowthGlobal0X128 || 0);
  const fg1 = BigInt(feeGrowthGlobal1X128 || 0);
  const foLow0 = BigInt(feeGrowthOutsideLower0X128 || 0);
  const foLow1 = BigInt(feeGrowthOutsideLower1X128 || 0);
  const foUp0 = BigInt(feeGrowthOutsideUpper0X128 || 0);
  const foUp1 = BigInt(feeGrowthOutsideUpper1X128 || 0);
  const fgLast0 = BigInt(feeGrowthInside0LastX128 || 0);
  const fgLast1 = BigInt(feeGrowthInside1LastX128 || 0);

  // feeGrowthBelow = tick >= tickLower ? feeGrowthOutside : feeGrowthGlobal - feeGrowthOutside
  const fBelow0 = tick >= tl ? foLow0 : (fg0 - foLow0) & MAX_UINT256;
  const fBelow1 = tick >= tl ? foLow1 : (fg1 - foLow1) & MAX_UINT256;
  // feeGrowthAbove = tick < tickUpper ? feeGrowthOutside : feeGrowthGlobal - feeGrowthOutside
  const fAbove0 = tick < tu ? foUp0 : (fg0 - foUp0) & MAX_UINT256;
  const fAbove1 = tick < tu ? foUp1 : (fg1 - foUp1) & MAX_UINT256;

  const fInside0 = (fg0 - fBelow0 - fAbove0) & MAX_UINT256;
  const fInside1 = (fg1 - fBelow1 - fAbove1) & MAX_UINT256;

  const delta0 = (fInside0 - fgLast0) & MAX_UINT256;
  const delta1 = (fInside1 - fgLast1) & MAX_UINT256;

  return {
    fees0: (delta0 * liq) / Q128 + BigInt(tokensOwed0 || 0),
    fees1: (delta1 * liq) / Q128 + BigInt(tokensOwed1 || 0),
  };
}

/**
 * Calcula fees no reclamadas para Uniswap V4. La aritmetica modular evita
 * perder fees legitimas cuando el snapshot previo está cerca de uint256 max.
 */
function computeV4UnclaimedFees({
  liquidity,
  feeGrowthInside0LastX128,
  feeGrowthInside1LastX128,
  feeGrowthInside0X128,
  feeGrowthInside1X128,
}) {
  const liq = BigInt(liquidity || 0);
  const growthLast0 = BigInt(feeGrowthInside0LastX128 || 0);
  const growthLast1 = BigInt(feeGrowthInside1LastX128 || 0);
  const growth0 = BigInt(feeGrowthInside0X128 || 0);
  const growth1 = BigInt(feeGrowthInside1X128 || 0);

  if (liq <= 0n) {
    return {
      fees0: 0n,
      fees1: 0n,
    };
  }

  const delta0 = (growth0 - growthLast0) & MAX_UINT256;
  const delta1 = (growth1 - growthLast1) & MAX_UINT256;

  return {
    fees0: (delta0 * liq) / Q128,
    fees1: (delta1 * liq) / Q128,
  };
}

module.exports = {
  computeV3UnclaimedFees,
  computeV4UnclaimedFees,
};
