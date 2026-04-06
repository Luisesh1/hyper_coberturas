/**
 * Constructores de transacciones para Uniswap V4 (PositionManager y Universal Router).
 */

const { ValidationError } = require('../../errors/app-error');
const {
  buildV4ModifyLiquiditiesCalldata,
  buildUniversalRouterCalldata,
} = require('../uniswap-v4-helpers.service');
const { encodeTx, deadlineFromNow } = require('./tx-encoders');

/**
 * Construye una tx que llama a `modifyLiquidities` en el PositionManager V4.
 */
function buildV4ModifyTx(ctx, { actionCodes, params, label, kind, meta = {} }) {
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
