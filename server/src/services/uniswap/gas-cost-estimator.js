/**
 * Estimación de costos de gas en USD para un txPlan de Uniswap.
 *
 * Centraliza la tabla de gas units por tipo de transacción y la conversión
 * a USD usando el `feeData` del proveedor RPC. Reemplaza la lógica que vivía
 * inline en `uniswap-position-actions.service.js` y permite reutilizarla
 * desde otros servicios sin acoplamiento.
 */

const { ethers } = require('ethers');

/**
 * Tabla de gas units estimadas por tipo de transacción. Los valores son
 * conservadores (con buffer) para evitar que el cliente subestime y la tx
 * se quede sin gas.
 */
const GAS_PER_TX_TYPE = {
  approval: 50_000,
  permit2_approval: 65_000,
  collect_fees: 120_000,
  decrease_liquidity: 180_000,
  decrease_liquidity_v4: 240_000,
  swap: 200_000,
  swap_v4: 260_000,
  wrap_native: 90_000,
  unwrap_native: 90_000,
  mint_position: 350_000,
  mint_position_v4: 420_000,
  modify_range_v4: 460_000,
};

const DEFAULT_GAS_PER_UNKNOWN_TX = 150_000;

function roundNullable(value, digits = 4) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

/**
 * Calcula gas units totales y desglose por tx para un txPlan.
 *
 * @param {Array<{kind?: string, label?: string}>} txPlan
 * @returns {{ totalGasUnits: number, txBreakdown: Array<{label: string, gasUnits: number}> }}
 */
function buildGasBreakdown(txPlan) {
  const filtered = (txPlan || []).filter(Boolean);
  let totalGasUnits = 0;
  const txBreakdown = filtered.map((tx) => {
    const gasUnits = GAS_PER_TX_TYPE[tx.kind] || DEFAULT_GAS_PER_UNKNOWN_TX;
    totalGasUnits += gasUnits;
    return { label: tx.label || tx.kind, gasUnits };
  });
  return { totalGasUnits, txBreakdown, txCount: filtered.length };
}

/**
 * Estima costo total en USD del txPlan combinando gas + slippage.
 *
 * @param {object} args
 * @param {object} args.provider - Provider ethers compatible con `getFeeData()`.
 * @param {Array} args.txPlan - Lista de transacciones (con campo `kind`).
 * @param {number|null} args.nativeUsdPrice - Precio del token nativo en USD.
 * @param {number} [args.slippageCostUsd=0] - Costo de slippage proyectado.
 * @returns {Promise<{
 *   gasCostEth: number|null,
 *   gasCostUsd: number|null,
 *   slippageCostUsd: number,
 *   totalEstimatedCostUsd: number,
 *   txCount: number,
 *   txBreakdown: Array<{label: string, gasUnits: number}>
 * }>}
 */
async function estimateTxPlanCostUsd({ provider, txPlan, nativeUsdPrice, slippageCostUsd = 0 }) {
  const { totalGasUnits, txBreakdown, txCount } = buildGasBreakdown(txPlan);

  let gasCostEth = null;
  let gasCostUsd = null;
  if (provider && typeof provider.getFeeData === 'function') {
    try {
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
      const totalGasWei = gasPrice * BigInt(totalGasUnits);
      gasCostEth = Number(ethers.formatEther(totalGasWei));
      if (Number.isFinite(nativeUsdPrice) && nativeUsdPrice > 0) {
        gasCostUsd = gasCostEth * nativeUsdPrice;
      }
    } catch {
      // Best effort: si el provider falla devolvemos solo el desglose.
    }
  }

  const totalEstimatedCostUsd = (gasCostUsd || 0) + (slippageCostUsd || 0);
  return {
    gasCostEth: roundNullable(gasCostEth, 8),
    gasCostUsd: roundNullable(gasCostUsd, 4),
    slippageCostUsd: roundNullable(slippageCostUsd || 0, 4) ?? 0,
    totalEstimatedCostUsd: roundNullable(totalEstimatedCostUsd, 4) ?? 0,
    txCount,
    txBreakdown,
  };
}

module.exports = {
  GAS_PER_TX_TYPE,
  DEFAULT_GAS_PER_UNKNOWN_TX,
  buildGasBreakdown,
  estimateTxPlanCostUsd,
};
