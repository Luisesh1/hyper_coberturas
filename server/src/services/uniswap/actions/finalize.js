const { ethers } = require('ethers');
const { ValidationError, ExternalServiceError } = require('../../../errors/app-error');
const {
  TRANSFER_EVENT_ABI,
} = require('../abis');
const {
  DEFAULT_SLIPPAGE_BPS,
  CLOSE_ACTIONS,
} = require('../constants');
const uniswapService = require('../../uniswap.service');
const protectedPoolRepo = require('../../../repositories/protected-uniswap-pool.repository');
const protectedPoolRefreshService = require('../../protected-pool-refresh.service');
const protectedPoolDeltaNeutralService = require('../../protected-pool-delta-neutral.service');
const smartPoolCreatorService = require('../../smart-pool-creator.service');
const logger = require('../../logger.service');
const onChainManager = require('../../onchain-manager.service');

const {
  normalizeAddress,
  getNetworkConfig,
  getProvider,
  ensureSupportedAction,
  loadV3PositionContext,
  loadV4PositionContext,
  loadWalletPoolSnapshot,
} = require('./helpers');

const {
  prepareIncreaseLiquidity,
  prepareDecreaseLiquidity,
  prepareCollectFees,
  prepareReinvestFees,
  prepareModifyRange,
  prepareRebalance,
  prepareCloseKeepAssets,
  prepareCloseToUsdc,
  prepareCreatePosition,
} = require('./prepare-v3');

const {
  prepareIncreaseLiquidityV4,
  prepareDecreaseLiquidityV4,
  prepareReinvestFeesV4,
  prepareModifyRangeV4,
  prepareCreatePositionV4,
  prepareRebalanceV4,
  prepareCloseKeepAssetsV4,
  prepareCloseToUsdcV4,
} = require('./prepare-v4');

// ─── Module-level state ──────────────────────────────────────────────

const _finalizeCache = new Map();
const FINALIZE_CACHE_TTL_MS = 300_000; // 5 min

// ─── Main router ─────────────────────────────────────────────────────

async function preparePositionAction({ action, payload }) {
  ensureSupportedAction(action);
  const version = String(payload.version || '').toLowerCase();
  if (!['v3', 'v4'].includes(version)) {
    throw new ValidationError('Solo v3 y v4 estan soportados');
  }

  const normalizedPayload = {
    ...payload,
    version,
    network: String(payload.network || '').toLowerCase(),
  };

  let result;
  switch (action) {
    case 'increase-liquidity':
      result = await (version === 'v4'
        ? prepareIncreaseLiquidityV4(normalizedPayload)
        : prepareIncreaseLiquidity(normalizedPayload));
      break;
    case 'decrease-liquidity':
      result = await (version === 'v4'
        ? prepareDecreaseLiquidityV4(normalizedPayload)
        : prepareDecreaseLiquidity(normalizedPayload));
      break;
    case 'collect-fees':
      result = await prepareCollectFees(normalizedPayload);
      break;
    case 'reinvest-fees':
      result = await (version === 'v4'
        ? prepareReinvestFeesV4(normalizedPayload)
        : prepareReinvestFees(normalizedPayload));
      break;
    case 'modify-range':
      result = await (version === 'v4'
        ? prepareModifyRangeV4(normalizedPayload)
        : prepareModifyRange(normalizedPayload));
      break;
    case 'rebalance':
      result = await (version === 'v4'
        ? prepareRebalanceV4(normalizedPayload)
        : prepareRebalance(normalizedPayload));
      break;
    case 'create-position':
      result = await (version === 'v4'
        ? prepareCreatePositionV4(normalizedPayload)
        : prepareCreatePosition(normalizedPayload));
      break;
    case 'close-to-usdc':
      result = await (version === 'v4'
        ? prepareCloseToUsdcV4(normalizedPayload)
        : prepareCloseToUsdc(normalizedPayload));
      break;
    case 'close-keep-assets':
      result = await (version === 'v4'
        ? prepareCloseKeepAssetsV4(normalizedPayload)
        : prepareCloseKeepAssets(normalizedPayload));
      break;
    default:
      throw new ValidationError(`Accion no soportada: ${action}`);
  }

  if (Array.isArray(result.txPlan)) {
    result.txPlan.forEach((tx, i) => { if (tx) tx.sequence = i; });
  }

  result.preparedAt = Date.now();
  result.expiresAt = Date.now() + 600_000; // 10 minutes

  return result;
}

// ─── Receipt / Finalize helpers ──────────────────────────────────────

async function waitForReceipt(networkConfig, txHash) {
  try {
    return await onChainManager.waitForReceipt({
      networkConfig,
      txHash,
      confirmations: 1,
      timeoutMs: 90_000,
      scope: 'uniswap-position-actions',
    });
  } catch (err) {
    throw new ExternalServiceError(`No se pudo obtener el receipt de ${txHash}: ${err.message}`);
  }
}

function extractMintedPositionId(receipts, positionManagerAddress, walletAddress) {
  const iface = new ethers.Interface(TRANSFER_EVENT_ABI);
  let minted = null;
  for (const receipt of receipts) {
    for (const log of receipt.logs || []) {
      if (String(log.address || '').toLowerCase() !== String(positionManagerAddress || '').toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (
          parsed?.name === 'Transfer' &&
          String(parsed.args.from || '').toLowerCase() === ethers.ZeroAddress.toLowerCase() &&
          String(parsed.args.to || '').toLowerCase() === String(walletAddress || '').toLowerCase()
        ) {
          minted = parsed.args.tokenId.toString();
        }
      } catch {
        // Ignore unrelated logs.
      }
    }
  }
  return minted;
}

async function updateProtectionRecords({
  userId,
  action,
  network,
  version,
  walletAddress,
  oldPositionIdentifier,
  newPositionIdentifier,
  txHashes,
  refreshedSnapshot,
}) {
  if (!oldPositionIdentifier) {
    return {
      migratedCount: 0,
      migratedProtectionIds: [],
      refreshed: false,
    };
  }

  const protections = await protectedPoolRepo.findByPositionIdentifier(oldPositionIdentifier, network, version);
  const userProtections = protections.filter((item) => item.userId === userId);
  if (!userProtections.length) {
    return {
      affectedCount: 0,
      deactivatedCount: 0,
      migratedCount: 0,
      migratedProtectionIds: [],
      refreshed: false,
    };
  }

  if (CLOSE_ACTIONS.has(action)) {
    const now = Date.now();
    for (const protection of userProtections) {
      await protectedPoolRepo.updateOnchainOperation(userId, protection.id, {
        lastOnchainAction: action,
        lastTxHash: txHashes[txHashes.length - 1] || null,
        lastTxAt: now,
      });

      // CRITICO: cerrar el hedge en Hyperliquid ANTES de marcar la
      // proteccion como inactive en BD. Si solo marcamos inactive en BD
      // (como haciamos antes), la posicion short queda huerfana en la
      // cuenta del usuario -- el LP se cierra pero la cobertura sigue
      // sangrando funding/PnL.
      //
      // `deactivateProtectedPool` delega en
      // `protectedPoolDeltaNeutralService.requestDeactivate` para modo
      // delta-neutral, que ejecuta `closePosition` y reconcilia los fills
      // antes de persistir el `deactivatedAt` final.
      let closedHedgeOk = false;
      if (protection.protectionMode === 'delta_neutral') {
        try {
          await protectedPoolDeltaNeutralService.requestDeactivate(protection);
          closedHedgeOk = true;
        } catch (err) {
          logger.error('uniswap_position_action_hedge_close_failed', {
            action,
            userId,
            protectionId: protection.id,
            asset: protection.inferredAsset,
            error: err.message,
          });
          // No re-lanzamos: el LP ya se cerro on-chain. Marcamos la
          // proteccion con `lastError` y la dejamos en `deactivation_pending`
          // para que el monitor reintente cerrar el hedge.
          await protectedPoolRepo.updateStrategyState(userId, protection.id, {
            strategyState: {
              ...(protection.strategyState || {}),
              status: 'deactivation_pending',
              lastError: `hedge_close_failed_on_lp_close: ${err.message}`,
              deactivationRequestedAt: now,
            },
          }).catch((stateErr) => logger.warn('hedge_close_state_persist_failed', { protectionId: protection.id, error: stateErr.message }));
        }
      }

      // Si el hedge ya se cerro arriba (delta-neutral path lo hizo
      // dentro de `_continueDeactivation`), evitamos doble-deactivate.
      // Si no es delta-neutral, o si delta-neutral fallo, marcamos
      // inactive aqui para mantener compatibilidad con el comportamiento
      // legacy (legacy hedges no abren posiciones automaticamente).
      if (!closedHedgeOk || protection.protectionMode !== 'delta_neutral') {
        await protectedPoolRepo.deactivate(userId, protection.id, {
          deactivatedAt: now,
          poolSnapshot: refreshedSnapshot || protection.poolSnapshot || null,
          rangeFrozenAt: now,
        });
      }
    }

    try {
      await protectedPoolRefreshService.refreshUser(userId);
    } catch (err) {
      logger.warn('uniswap_position_action_refresh_failed', {
        action,
        userId,
        network,
        version,
        oldPositionIdentifier,
        newPositionIdentifier,
        error: err.message,
      });
    }

    return {
      affectedCount: userProtections.length,
      deactivatedCount: userProtections.length,
      migratedCount: 0,
      migratedProtectionIds: userProtections.map((item) => item.id),
      refreshed: true,
    };
  }

  for (const protection of userProtections) {
    if (newPositionIdentifier && newPositionIdentifier !== oldPositionIdentifier) {
      await protectedPoolRepo.updateOnchainOperation(userId, protection.id, {
        lastOnchainAction: action,
        lastTxHash: txHashes[txHashes.length - 1] || null,
        lastTxAt: Date.now(),
        replacedByPositionIdentifier: newPositionIdentifier,
      });

      await protectedPoolRepo.migratePositionIdentity(userId, protection.id, {
        network,
        version,
        walletAddress,
        poolAddress: refreshedSnapshot?.poolAddress || protection.poolAddress,
        positionIdentifier: newPositionIdentifier,
        token0Address: refreshedSnapshot?.token0Address || protection.token0Address,
        token1Address: refreshedSnapshot?.token1Address || protection.token1Address,
        token0Symbol: refreshedSnapshot?.token0?.symbol || protection.token0Symbol,
        token1Symbol: refreshedSnapshot?.token1?.symbol || protection.token1Symbol,
        rangeLowerPrice: refreshedSnapshot?.rangeLowerPrice || protection.rangeLowerPrice,
        rangeUpperPrice: refreshedSnapshot?.rangeUpperPrice || protection.rangeUpperPrice,
        priceCurrent: refreshedSnapshot?.priceCurrent || protection.priceCurrent,
        poolSnapshot: refreshedSnapshot || protection.poolSnapshot,
        lastOnchainAction: action,
        lastTxHash: txHashes[txHashes.length - 1] || null,
        lastTxAt: Date.now(),
      });
      continue;
    }

    await protectedPoolRepo.updateOnchainOperation(userId, protection.id, {
      lastOnchainAction: action,
      lastTxHash: txHashes[txHashes.length - 1] || null,
      lastTxAt: Date.now(),
    });
  }

  try {
    await protectedPoolRefreshService.refreshUser(userId);
  } catch (err) {
    logger.warn('uniswap_position_action_refresh_failed', {
      action,
      userId,
      network,
      version,
      oldPositionIdentifier,
      newPositionIdentifier,
      error: err.message,
    });
  }

  return {
    affectedCount: userProtections.length,
    deactivatedCount: 0,
    migratedCount: userProtections.length,
    migratedProtectionIds: userProtections.map((item) => item.id),
    refreshed: true,
  };
}

async function collectFinalizeReceipts({
  action,
  network,
  version: _version,
  walletAddress,
  txHashes,
  onProgress,
}) {
  ensureSupportedAction(action);
  if (!Array.isArray(txHashes) || txHashes.length === 0) {
    throw new ValidationError('txHashes es requerido');
  }

  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(walletAddress, 'walletAddress');
  const receipts = [];
  for (const txHash of txHashes) {
    onProgress?.('waiting_receipts', { txHash });
    const receipt = await waitForReceipt(networkConfig, txHash);
    if (!receipt) throw new ExternalServiceError(`Timeout esperando receipt de ${txHash}`);
    if (receipt.status !== 1) throw new ValidationError(`La transaccion ${txHash} fallo on-chain`);
    receipts.push(receipt);
  }

  return {
    networkConfig,
    provider,
    normalizedWallet,
    receipts,
  };
}

async function finalizePositionActionAfterReceipts({
  userId,
  action,
  network,
  version,
  walletAddress,
  positionIdentifier,
  txHashes,
  receipts,
  onProgress,
}) {
  ensureSupportedAction(action);
  if (!Array.isArray(txHashes) || txHashes.length === 0) {
    throw new ValidationError('txHashes es requerido');
  }

  const _finalizeCacheKey = [...txHashes].sort().join(':');
  const _cachedFinalize = _finalizeCache.get(_finalizeCacheKey);
  if (_cachedFinalize && Date.now() - _cachedFinalize.ts < FINALIZE_CACHE_TTL_MS) {
    return _cachedFinalize.result;
  }

  const networkConfig = getNetworkConfig(network);
  const normalizedWallet = normalizeAddress(walletAddress, 'walletAddress');

  const positionManagerAddress = version === 'v3'
    ? normalizeAddress(networkConfig.deployments.v3.positionManager)
    : normalizeAddress(networkConfig.deployments.v4.positionManager);
  const mintedPositionIdentifier = extractMintedPositionId(receipts, positionManagerAddress, normalizedWallet);
  const finalPositionIdentifier = mintedPositionIdentifier || (positionIdentifier ? String(positionIdentifier) : null);

  let refreshedSnapshot = null;
  if (finalPositionIdentifier) {
    onProgress?.('refreshing_snapshot', { positionIdentifier: finalPositionIdentifier });
    try {
      refreshedSnapshot = await loadWalletPoolSnapshot(userId, {
        network,
        version,
        walletAddress: normalizedWallet,
        positionIdentifier: finalPositionIdentifier,
      });
    } catch (err) {
      logger.warn('uniswap_position_action_snapshot_refresh_failed', {
        action,
        userId,
        network,
        version,
        positionIdentifier: finalPositionIdentifier,
        error: err.message,
      });
    }
  }

  onProgress?.('migrating_protection', {
    oldPositionIdentifier: positionIdentifier ? String(positionIdentifier) : null,
    newPositionIdentifier: mintedPositionIdentifier || null,
  });
  const protectionMigration = await updateProtectionRecords({
    userId,
    action,
    network,
    version,
    walletAddress: normalizedWallet,
    oldPositionIdentifier: positionIdentifier ? String(positionIdentifier) : null,
    newPositionIdentifier: mintedPositionIdentifier || null,
    txHashes,
    refreshedSnapshot,
  });

  const finalResult = {
    action,
    txHashes,
    receipts: receipts.map((receipt) => ({
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString() || null,
      status: receipt.status,
      to: receipt.to || null,
    })),
    positionChanges: {
      oldPositionIdentifier: positionIdentifier ? String(positionIdentifier) : null,
      newPositionIdentifier: mintedPositionIdentifier || null,
    },
    protectionMigration,
    refreshedSnapshot,
  };
  _finalizeCache.set(_finalizeCacheKey, { result: finalResult, ts: Date.now() });
  return finalResult;
}

async function finalizePositionAction({
  userId,
  action,
  network,
  version,
  walletAddress,
  positionIdentifier,
  txHashes,
  onProgress,
}) {
  const { receipts } = await collectFinalizeReceipts({
    action,
    network,
    version,
    walletAddress,
    txHashes,
    onProgress,
  });

  return finalizePositionActionAfterReceipts({
    userId,
    action,
    network,
    version,
    walletAddress,
    positionIdentifier,
    txHashes,
    receipts,
    onProgress,
  });
}

/**
 * Resuelve el plan de fondeo (preview) para un increase-liquidity smart
 * sobre una posicion existente. El cliente lo llama desde el paso FUNDING
 * del modal para iterar selecciones de assets sin construir el txPlan
 * completo cada vez. Carga la posicion, deriva rango/tokens/fee y delega
 * en `smartPoolCreatorService.buildIncreaseLiquidityFundingPlan`.
 */
async function buildIncreaseLiquidityFundingPlanFromPosition(payload) {
  const version = String(payload.version || 'v3').toLowerCase();
  if (version === 'v4') {
    const ctx = await loadV4PositionContext(payload);
    const rangeLowerPrice = uniswapService.tickToPrice(ctx.tickLower, ctx.token0.decimals, ctx.token1.decimals);
    const rangeUpperPrice = uniswapService.tickToPrice(ctx.tickUpper, ctx.token0.decimals, ctx.token1.decimals);
    return smartPoolCreatorService.buildIncreaseLiquidityFundingPlan({
      network: payload.network,
      version: 'v4',
      walletAddress: payload.walletAddress,
      token0Address: ctx.token0.address,
      token1Address: ctx.token1.address,
      fee: Number(ctx.poolKey.fee),
      tickSpacing: Number(ctx.poolKey.tickSpacing),
      hooks: ctx.poolKey.hooks,
      poolId: ctx.poolId,
      rangeLowerPrice,
      rangeUpperPrice,
      currentPrice: ctx.priceCurrent,
      totalUsdTarget: Number(payload.totalUsdTarget),
      fundingSelections: payload.fundingSelections,
      importTokenAddresses: payload.importTokenAddresses || [],
      maxSlippageBps: payload.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
    });
  }

  const ctx = await loadV3PositionContext(payload);
  const rangeLowerPrice = uniswapService.tickToPrice(
    Number(ctx.position.tickLower),
    ctx.token0.decimals,
    ctx.token1.decimals,
  );
  const rangeUpperPrice = uniswapService.tickToPrice(
    Number(ctx.position.tickUpper),
    ctx.token0.decimals,
    ctx.token1.decimals,
  );
  return smartPoolCreatorService.buildIncreaseLiquidityFundingPlan({
    network: payload.network,
    version: 'v3',
    walletAddress: payload.walletAddress,
    token0Address: ctx.token0.address,
    token1Address: ctx.token1.address,
    fee: Number(ctx.position.fee),
    rangeLowerPrice,
    rangeUpperPrice,
    currentPrice: ctx.priceCurrent,
    totalUsdTarget: Number(payload.totalUsdTarget),
    fundingSelections: payload.fundingSelections,
    importTokenAddresses: payload.importTokenAddresses || [],
    maxSlippageBps: payload.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
  });
}

module.exports = {
  preparePositionAction,
  finalizePositionAction,
  collectFinalizeReceipts,
  finalizePositionActionAfterReceipts,
  buildIncreaseLiquidityFundingPlanFromPosition,
};
