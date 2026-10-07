const { AppError } = require('../../../errors/app-error');

const ROUNDING_TOLERANCE_BPS = 1;

/**
 * El mínimo que garantiza la ruta no puede quedar por debajo de lo esperado
 * menos el slippage pedido: si el proveedor devuelve un mínimo más laxo, la
 * tx aceptaría perder más de lo que el usuario autorizó.
 */
function assertMinOut({ provider, toAmountRaw, toAmountMinRaw, slippageBps }) {
  if (toAmountRaw == null || toAmountMinRaw == null) {
    throw new AppError(`${provider} no informó el monto mínimo a recibir.`, { status: 502, code: 'BRIDGE_SLIPPAGE_TOO_HIGH' });
  }
  // 1 bp de tolerancia: los proveedores redondean el mínimo (Li.Fi devolvió
  // 50,0045 bps con un slippage pedido de 50).
  const floor = (BigInt(toAmountRaw) * BigInt(10_000 - Number(slippageBps) - ROUNDING_TOLERANCE_BPS)) / 10_000n;
  if (BigInt(toAmountMinRaw) < floor) {
    throw new AppError(
      `${provider} garantiza menos de lo permitido por el slippage (${Number(slippageBps) / 100} %).`,
      { status: 502, code: 'BRIDGE_SLIPPAGE_TOO_HIGH', details: { provider, toAmountRaw: String(toAmountRaw), toAmountMinRaw: String(toAmountMinRaw) } }
    );
  }
}

module.exports = { assertMinOut };
