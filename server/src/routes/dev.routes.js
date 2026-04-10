/**
 * dev.routes.js
 *
 * Endpoints exclusivos del modo desarrollo. Solo se montan cuando
 * `config.server.nodeEnv === 'development'` (ver routes/index.js).
 *
 * - GET  /api/dev/info             — capabilities del modo dev
 * - GET  /api/dev/logs/snapshot    — últimos N entries del ring buffer
 * - POST /api/dev/client-logs      — recibe batch de logs del cliente
 *                                    (window.onerror, unhandledrejection,
 *                                    ErrorBoundary, fetch 4xx/5xx)
 * - POST /api/dev/recover-position-fees — simula collect() y devuelve tx
 *                                          ready-to-sign para recuperar
 *                                          fondos atascados en una posición
 *                                          v3 con liquidity=0 + tokensOwed>0.
 *
 * Estos endpoints NO requieren autenticación: son útiles ANTES de loguearse
 * (errores en la pantalla de login deben capturarse igual). El daño máximo
 * es que un atacante en localhost pueda spammear el ring buffer en dev,
 * cosa que no afecta producción porque la ruta no se monta.
 */

const { Router } = require('express');
const { ethers } = require('ethers');
const asyncHandler = require('../middleware/async-handler');
const { validate } = require('../middleware/validate.middleware');
const { z } = require('zod');
const devLogSink = require('../services/dev-log-sink.service');
const onChainManager = require('../services/onchain-manager.service');
const uniswapService = require('../services/uniswap.service');
const { clientLogsBatchSchema } = require('../schemas/dev.schema');

const router = Router();

router.get('/info', asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: {
      mode: 'development',
      ringCapacity: devLogSink.RING_CAPACITY,
      bufferSize: devLogSink.snapshot().length,
    },
  });
}));

router.get('/logs/snapshot', asyncHandler(async (req, res) => {
  const limit = Math.min(devLogSink.RING_CAPACITY, Number(req.query.limit) || devLogSink.RING_CAPACITY);
  const entries = devLogSink.snapshot({ limit });
  res.json({ success: true, data: { entries } });
}));

router.post('/logs/clear', asyncHandler(async (_req, res) => {
  devLogSink.clear();
  res.json({ success: true, data: { cleared: true } });
}));

router.post('/client-logs', validate(clientLogsBatchSchema), asyncHandler(async (req, res) => {
  const count = devLogSink.publishMany(req.body.entries, { source: undefined });
  res.json({ success: true, data: { received: count } });
}));

// ─────────────────────────────────────────────────────────────────────────
// Telemetría on-chain — visible vía DevLogPanel "RPC stats" tab
// ─────────────────────────────────────────────────────────────────────────
//
// Cada llamada al `onChainManager` (call, estimateGas, getBalance,
// aggregate3, waitForReceipt) está instrumentada con _track(scope, method)
// y acumula count + p50/p99 + errors. Estos endpoints exponen el snapshot
// para que el dev pueda validar reducciones de RPC tras una optimización.

router.get('/onchain-stats', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: onChainManager.getStats() });
}));

router.post('/onchain-stats/reset', asyncHandler(async (_req, res) => {
  onChainManager.resetStats();
  res.json({ success: true, data: { reset: true } });
}));

// ─────────────────────────────────────────────────────────────────────────
// Recuperación de fondos atascados en posiciones Uniswap V3
// ─────────────────────────────────────────────────────────────────────────
//
// Cuando un orquestador firma `decreaseLiquidity` pero el `collect()` nunca
// se ejecuta (por ej. el cliente abortó por timeout, o el modal se cerró
// antes de firmar la 2da tx del plan), los tokens quedan dentro del pool
// con `tokensOwed0/1 > 0` y `liquidity = 0`. La UI nueva de Uniswap oculta
// estas posiciones, así que el usuario no puede recuperarlas vía la UI.
//
// Este endpoint:
//   1. Verifica on-chain que la wallet sea el `ownerOf(tokenId)`.
//   2. Lee `positions(tokenId)` y reporta `tokensOwed0/1` reales.
//   3. Simula `collect()` con `eth_call` (sin firmar) para confirmar el
//      monto exacto recuperable.
//   4. Devuelve un objeto `tx` listo para que el frontend pase a
//      `walletConn.sendTransaction(tx)`.

const recoverPositionFeesSchema = z.object({
  network: z.string().min(1),
  tokenId: z.union([z.string().min(1), z.number().int().positive()]),
  walletAddress: z.string().min(1),
  recipient: z.string().min(1).optional(),
});

const POSITION_MANAGER_BY_NETWORK = {
  arbitrum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  ethereum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  optimism: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  base: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
  polygon: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
};

const PM_RECOVERY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
];
const ERC20_RECOVERY_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];
const MAX_UINT128 = (1n << 128n) - 1n;

router.post('/recover-position-fees', validate(recoverPositionFeesSchema), asyncHandler(async (req, res) => {
  const { network, tokenId: rawTokenId, walletAddress: rawWallet, recipient: rawRecipient } = req.body;
  const network_ = String(network).toLowerCase();
  const positionManager = POSITION_MANAGER_BY_NETWORK[network_];
  if (!positionManager) {
    return res.status(400).json({ success: false, error: `Network no soportada: ${network}` });
  }
  const tokenId = BigInt(rawTokenId);
  const walletAddress = ethers.getAddress(rawWallet);
  const recipient = rawRecipient ? ethers.getAddress(rawRecipient) : walletAddress;

  const networkConfig = uniswapService.SUPPORTED_NETWORKS[network_];
  if (!networkConfig) {
    return res.status(400).json({ success: false, error: `Network no encontrada en SUPPORTED_NETWORKS: ${network_}` });
  }
  const provider = onChainManager.getProvider(networkConfig, { scope: 'dev.routes.recover-position-fees' });
  const pm = onChainManager.getContract({
    runner: provider,
    address: positionManager,
    abi: PM_RECOVERY_ABI,
  });

  // 1. Verificar owner del NFT
  let owner;
  try {
    owner = await pm.ownerOf(tokenId);
  } catch (err) {
    return res.status(404).json({
      success: false,
      error: `El NFT ${tokenId} no existe o fue quemado: ${err.message}`,
    });
  }
  if (owner.toLowerCase() !== walletAddress.toLowerCase()) {
    return res.status(403).json({
      success: false,
      error: `La wallet ${walletAddress} no es dueña del NFT ${tokenId}. Owner real: ${owner}`,
    });
  }

  // 2. Leer estado de la posición
  const pos = await pm.positions(tokenId);
  const token0 = pos.token0;
  const token1 = pos.token1;
  const liquidity = pos.liquidity;
  const tokensOwed0 = pos.tokensOwed0;
  const tokensOwed1 = pos.tokensOwed1;

  // 3. Metadata de los tokens
  const t0 = onChainManager.getContract({ runner: provider, address: token0, abi: ERC20_RECOVERY_ABI });
  const t1 = onChainManager.getContract({ runner: provider, address: token1, abi: ERC20_RECOVERY_ABI });
  const [sym0, dec0, sym1, dec1] = await Promise.all([
    t0.symbol().catch(() => 'TOKEN0'),
    t0.decimals().catch(() => 18),
    t1.symbol().catch(() => 'TOKEN1'),
    t1.decimals().catch(() => 18),
  ]);

  // 4. Construir calldata de collect()
  const iface = new ethers.Interface(PM_RECOVERY_ABI);
  const collectCalldata = iface.encodeFunctionData('collect', [{
    tokenId,
    recipient,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  }]);

  // 5. Simular el collect() vía eth_call (sin firmar)
  let simulated = null;
  try {
    const resultHex = await onChainManager.call({
      networkConfig,
      scope: 'dev.routes.recover-position-fees',
      tx: { from: walletAddress, to: positionManager, data: collectCalldata },
    });
    const decoded = iface.decodeFunctionResult('collect', resultHex);
    simulated = {
      amount0Raw: BigInt(decoded[0].toString()).toString(),
      amount1Raw: BigInt(decoded[1].toString()).toString(),
      amount0: ethers.formatUnits(decoded[0], Number(dec0)),
      amount1: ethers.formatUnits(decoded[1], Number(dec1)),
    };
  } catch (err) {
    return res.status(409).json({
      success: false,
      error: `La simulación de collect() revertió: ${err?.message?.slice(0, 200)}`,
    });
  }

  // 6. Estimar gas
  let gasEstimateHex = null;
  try {
    const gas = await onChainManager.estimateGas({
      networkConfig,
      scope: 'dev.routes.recover-position-fees',
      tx: { from: walletAddress, to: positionManager, data: collectCalldata },
    });
    gasEstimateHex = '0x' + gas.toString(16);
  } catch {
    gasEstimateHex = '0x' + (250_000n).toString(16);
  }

  res.json({
    success: true,
    data: {
      network: network_,
      chainId: networkConfig.chainId,
      tokenId: tokenId.toString(),
      owner,
      walletAddress,
      recipient,
      positionManager,
      token0: { address: token0, symbol: sym0, decimals: Number(dec0) },
      token1: { address: token1, symbol: sym1, decimals: Number(dec1) },
      liquidity: liquidity.toString(),
      tokensOwed0: tokensOwed0.toString(),
      tokensOwed1: tokensOwed1.toString(),
      tokensOwed0Formatted: ethers.formatUnits(tokensOwed0, Number(dec0)),
      tokensOwed1Formatted: ethers.formatUnits(tokensOwed1, Number(dec1)),
      simulated,
      tx: {
        to: positionManager,
        data: collectCalldata,
        value: '0x0',
        chainId: networkConfig.chainId,
        gas: gasEstimateHex,
        kind: 'collect',
        label: `Recover ${simulated.amount0} ${sym0} + ${simulated.amount1} ${sym1} from position #${tokenId}`,
      },
    },
  });
}));

module.exports = router;
