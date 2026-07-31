/**
 * Constructores de transacciones para Uniswap V4 (PositionManager y Universal Router).
 */

const { ethers } = require('ethers');
const { ValidationError } = require('../../errors/app-error');
const {
  buildV4ModifyLiquiditiesCalldata,
  buildUniversalRouterCalldata,
} = require('../uniswap-v4-helpers.service');
const { encodeTx, deadlineFromNow } = require('./tx-encoders');

/**
 * Construye una tx que llama a `modifyLiquidities` en el PositionManager V4.
 *
 * `value` solo se usa cuando una de las currencies del pool es ETH nativo: en
 * v4 el nativo no se aprueba ni se transfiere con transferFrom, se envia con
 * la transaccion. Debe cubrir el techo con slippage, y el sobrante se
 * recupera con la accion SWEEP.
 */
function buildV4ModifyTx(ctx, { actionCodes, params, label, kind, meta = {}, value }) {
  return encodeTx(
    ctx.positionManagerAddress,
    buildV4ModifyLiquiditiesCalldata({
      actions: actionCodes,
      params,
      deadline: deadlineFromNow(),
    }),
    {
      chainId: ctx.networkConfig.chainId,
      kind,
      label,
      ...(value != null && BigInt(value) > 0n ? { value: ethers.toQuantity(BigInt(value)) } : {}),
      meta,
    }
  );
}

/**
 * Construye una tx que llama a `execute` en el Universal Router para
 * encadenar acciones V4 con swaps universales.
 */
function buildV4RouterTx(ctx, { actionCodes, params, label, kind, meta = {} }) {
  if (!ctx.universalRouterAddress) {
    throw new ValidationError(`No hay Universal Router configurado para ${ctx.networkConfig.label}`);
  }
  return encodeTx(
    ctx.universalRouterAddress,
    buildUniversalRouterCalldata({
      actions: actionCodes,
      params,
      deadline: deadlineFromNow(),
    }),
    {
      chainId: ctx.networkConfig.chainId,
      kind,
      label,
      meta,
    }
  );
}

module.exports = {
  buildV4ModifyTx,
  buildV4RouterTx,
};
