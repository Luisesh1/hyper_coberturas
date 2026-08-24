/**
 * Constructores de transacciones para Uniswap V4 (PositionManager y Universal Router).
 */

const { ethers } = require('ethers');
const { ValidationError } = require('../../errors/app-error');
const { V4_POSITION_MANAGER_ABI } = require('./abis');
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
 * Inicializa una PoolKey V4 nueva antes de mintear su primera posición. La
 * inicialización debe confirmarse como transacción separada: PositionManager
 * no puede mintear contra un pool que aún no existe en PoolManager.
 */
function buildV4InitializePoolTx(ctx, { poolKey, sqrtPriceX96 }) {
  const iface = new ethers.Interface(V4_POSITION_MANAGER_ABI);
  const normalizedPoolKey = {
    currency0: ethers.getAddress(poolKey.currency0),
    currency1: ethers.getAddress(poolKey.currency1),
    fee: Number(poolKey.fee),
    tickSpacing: Number(poolKey.tickSpacing),
    hooks: ethers.getAddress(poolKey.hooks),
  };
  return encodeTx(
    ethers.getAddress(ctx.positionManagerAddress),
    iface.encodeFunctionData('initializePool', [[
      normalizedPoolKey.currency0,
      normalizedPoolKey.currency1,
      normalizedPoolKey.fee,
      normalizedPoolKey.tickSpacing,
      normalizedPoolKey.hooks,
    ], BigInt(sqrtPriceX96)]),
    {
      chainId: ctx.networkConfig.chainId,
      kind: 'initialize_pool_v4',
      label: 'Initialize pool (v4)',
      meta: {
        poolKey: {
          ...normalizedPoolKey,
        },
        sqrtPriceX96: BigInt(sqrtPriceX96).toString(),
      },
    }
  );
}

/**
 * Construye una tx que llama a `execute` en el Universal Router para
 * encadenar acciones V4 con swaps universales.
 */
function buildV4RouterTx(ctx, { actionCodes, params, label, kind, meta = {}, value }) {
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
      // Un swap que ENTREGA ETH nativo lo manda como value: address(0) no se
      // puede aprobar ni transferir con transferFrom.
      ...(value != null && BigInt(value) > 0n ? { value: ethers.toQuantity(BigInt(value)) } : {}),
      meta,
    }
  );
}

module.exports = {
  buildV4InitializePoolTx,
  buildV4ModifyTx,
  buildV4RouterTx,
};
