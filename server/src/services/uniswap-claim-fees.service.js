const { ethers } = require('ethers');
const { ValidationError, ExternalServiceError } = require('../errors/app-error');
const protectedPoolRefreshService = require('./protected-pool-refresh.service');
const protectedPoolRepo = require('../repositories/protected-uniswap-pool.repository');
const logger = require('./logger.service');
const onChainManager = require('./onchain-manager.service');
const {
  V4_ACTIONS,
  V4_POSITION_MANAGER_ABI,
  buildV4ModifyLiquiditiesCalldata,
  encodeV4CloseCurrencyParams,
  encodeV4ModifyLiquidityParams,
  hasHooks,
  normalizeHooksAddress,
} = require('./uniswap-v4-helpers.service');

const { SUPPORTED_NETWORKS } = require('./uniswap/networks');

const {
  ERC20_ABI,
  V3_POSITION_MANAGER_ABI: V3_COLLECT_ABI,
} = require('./uniswap/abis');

const MAX_UINT128 = (1n << 128n) - 1n;

// --- Helpers -----------------------------------------------------------

function normalizeAddress(address) {
  if (!address) return null;
  try {
    return ethers.getAddress(address);
  } catch {
    return null;
  }
}

function lower(a) {
  return a?.toLowerCase?.() ?? '';
}

function getProviderCached(networkConfig) {
  return onChainManager.getProvider(networkConfig, { scope: 'uniswap-claim-fees' });
}

async function getTokenInfo(provider, address, networkConfig) {
  const normalized = normalizeAddress(address);
  if (!normalized || normalized === ethers.ZeroAddress) {
    return { symbol: networkConfig.nativeSymbol, decimals: 18, address: ethers.ZeroAddress };
  }
  const contract = onChainManager.getContract({ runner: provider, address: normalized, abi: ERC20_ABI });
  const [symbol, decimals] = await Promise.all([
    contract.symbol().catch(() => 'UNKNOWN'),
    contract.decimals().catch(() => 18),
  ]);
  return { symbol, decimals: Number(decimals), address: normalized };
}

// --- Validate inputs ---------------------------------------------------

function validateClaimInput({ network, version, positionIdentifier, walletAddress }) {
  if (!network || !version || !positionIdentifier || !walletAddress) {
    throw new ValidationError('network, version, positionIdentifier y walletAddress son requeridos');
  }

  if (!['v3', 'v4'].includes(version)) {
    throw new ValidationError('Claim de fees solo soportado para v3 y v4');
  }

  const networkConfig = SUPPORTED_NETWORKS[network];
  if (!networkConfig) {
    throw new ValidationError(`network no soportada: ${network}`);
  }

  if (!networkConfig.versions.includes(version)) {
    throw new ValidationError(`${version.toUpperCase()} no soportada en ${networkConfig.label}`);
  }

  let normalizedWallet;
  try {
    normalizedWallet = ethers.getAddress(walletAddress);
  } catch {
    throw new ValidationError('walletAddress invalida');
  }

  return { networkConfig, normalizedWallet, tokenId: String(positionIdentifier) };
}

// --- V3 Prepare --------------------------------------------------------

async function prepareV3Collect({ networkConfig, normalizedWallet, tokenId }) {
  const provider = getProviderCached(networkConfig);
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v3.positionManager);
  const pm = onChainManager.getContract({ runner: provider, address: positionManagerAddress, abi: V3_COLLECT_ABI });

  // Verify ownership
  const owner = normalizeAddress(await pm.ownerOf(tokenId));
  if (lower(owner) !== lower(normalizedWallet)) {
    throw new ValidationError('La wallet proporcionada no es dueña de esta posición');
  }

  // Read position data to get token addresses
  const position = await pm.positions(tokenId);
  const [token0Info, token1Info] = await Promise.all([
    getTokenInfo(provider, position.token0, networkConfig),
    getTokenInfo(provider, position.token1, networkConfig),
  ]);

  // Encode the collect call — max amounts to collect everything
  const collectParams = {
    tokenId: BigInt(tokenId),
    recipient: normalizedWallet,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };

  const iface = new ethers.Interface(V3_COLLECT_ABI);
  const data = iface.encodeFunctionData('collect', [collectParams]);

  return {
    tx: {
      to: positionManagerAddress,
      data,
      value: '0x0',
      chainId: networkConfig.chainId,
    },
    claimSummary: {
      recipient: normalizedWallet,
      token0: token0Info,
      token1: token1Info,
      positionIdentifier: tokenId,
      version: 'v3',
      network: networkConfig.id,
      networkLabel: networkConfig.label,
    },
  };
}

// --- V4 Prepare --------------------------------------------------------

async function prepareV4Collect({ networkConfig, normalizedWallet, tokenId }) {
  const provider = getProviderCached(networkConfig);
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager);
  const pm = onChainManager.getContract({ runner: provider, address: positionManagerAddress, abi: V4_POSITION_MANAGER_ABI });

  // Verify ownership
  const owner = normalizeAddress(await pm.ownerOf(tokenId));
  if (lower(owner) !== lower(normalizedWallet)) {
    throw new ValidationError('La wallet proporcionada no es dueña de esta posición');
  }

  // Get pool key and position info
  const [poolKey] = await pm.getPoolAndPositionInfo(tokenId);
  if (hasHooks(normalizeHooksAddress(poolKey.hooks))) {
    throw new ValidationError('Los pools v4 con hooks no estan soportados en gestion on-chain por ahora');
  }

  const [token0Info, token1Info] = await Promise.all([
    getTokenInfo(provider, poolKey.currency0, networkConfig),
    getTokenInfo(provider, poolKey.currency1, networkConfig),
  ]);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const data = buildV4ModifyLiquiditiesCalldata({
    actions: [
      V4_ACTIONS.DECREASE_LIQUIDITY,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4ModifyLiquidityParams({
        tokenId,
        liquidity: 0n,
        amount0Limit: 0n,
        amount1Limit: 0n,
      }),
      encodeV4CloseCurrencyParams(poolKey.currency0),
      encodeV4CloseCurrencyParams(poolKey.currency1),
    ],
    deadline,
  });

  return {
    tx: {
      to: positionManagerAddress,
      data,
      value: '0x0',
      chainId: networkConfig.chainId,
    },
    claimSummary: {
      recipient: normalizedWallet,
      token0: token0Info,
      token1: token1Info,
      positionIdentifier: tokenId,
      version: 'v4',
      network: networkConfig.id,
      networkLabel: networkConfig.label,
    },
  };
}

// --- Public: prepare ---------------------------------------------------

async function prepareClaimFees({ network, version, positionIdentifier, walletAddress }) {
  const { networkConfig, normalizedWallet, tokenId } = validateClaimInput({
    network, version, positionIdentifier, walletAddress,
  });

  if (version === 'v3') {
    return prepareV3Collect({ networkConfig, normalizedWallet, tokenId });
  }

  return prepareV4Collect({ networkConfig, normalizedWallet, tokenId });
}

async function waitForClaimReceipt({ network, version, positionIdentifier, walletAddress, txHash, onProgress }) {
  if (!txHash) {
    throw new ValidationError('txHash es requerido');
  }

  const { networkConfig, normalizedWallet, tokenId } = validateClaimInput({
    network, version, positionIdentifier, walletAddress,
  });

  const provider = getProviderCached(networkConfig);

  onProgress?.('waiting_receipts', { txHash });
  let receipt;
  try {
    receipt = await onChainManager.waitForReceipt({
      networkConfig,
      txHash,
      confirmations: 1,
      timeoutMs: 60_000,
      scope: 'uniswap-claim-fees',
    });
  } catch (err) {
    throw new ExternalServiceError(`No se pudo obtener el receipt de ${txHash}: ${err.message}`);
  }

  if (!receipt) {
    throw new ExternalServiceError(`Timeout esperando receipt de ${txHash}`);
  }

  if (receipt.status !== 1) {
    throw new ValidationError('La transacción falló on-chain (status 0)');
  }

  return {
    txHash,
    receipt,
    tokenId,
    networkConfig,
    normalizedWallet,
  };
}

// --- Public: finalize --------------------------------------------------

async function finalizeClaimFeesAfterReceipt({
  network,
  version,
  positionIdentifier,
  walletAddress,
  txHash,
  receipt,
  onProgress,
}) {
  const { networkConfig, tokenId } = validateClaimInput({
    network, version, positionIdentifier, walletAddress,
  });

  // Verify the tx was sent to the expected contract
  const expectedTo = version === 'v3'
    ? normalizeAddress(networkConfig.deployments.v3.positionManager)
    : normalizeAddress(networkConfig.deployments.v4.positionManager);

  if (lower(receipt.to) !== lower(expectedTo)) {
    throw new ValidationError('El txHash no corresponde a una operación de claim en el contrato esperado');
  }

  // Refresh any protected pool that matches this position
  let updatedProtection = null;
  onProgress?.('refreshing_snapshot', { positionIdentifier: tokenId });
  try {
    const protections = await protectedPoolRepo.findByPositionIdentifier(
      tokenId, network, version
    );
    if (protections.length > 0) {
      // Trigger a refresh for each matching protection's user
      const userIds = [...new Set(protections.map((p) => p.userId))];
      for (const uid of userIds) {
        await protectedPoolRefreshService.refreshUser(uid).catch((err) => {
          logger.warn('claim_fees_refresh_protection_failed', {
            userId: uid,
            positionIdentifier: tokenId,
            error: err.message,
          });
        });
      }
      // Re-fetch after refresh
      const refreshed = await protectedPoolRepo.findByPositionIdentifier(
        tokenId, network, version
      );
      updatedProtection = refreshed[0] || null;
    }
  } catch (err) {
    logger.warn('claim_fees_protection_lookup_failed', {
      positionIdentifier: tokenId,
      error: err.message,
    });
    throw err;
  }

  return {
    txHash,
    receipt: {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString(),
    },
    updatedProtection,
  };
}

async function finalizeClaimFees({ network, version, positionIdentifier, walletAddress, txHash, onProgress }) {
  const { receipt } = await waitForClaimReceipt({
    network,
    version,
    positionIdentifier,
    walletAddress,
    txHash,
    onProgress,
  });

  return finalizeClaimFeesAfterReceipt({
    network,
    version,
    positionIdentifier,
    walletAddress,
    txHash,
    receipt,
    onProgress,
  });
}

module.exports = {
  prepareClaimFees,
  finalizeClaimFees,
  waitForClaimReceipt,
  finalizeClaimFeesAfterReceipt,
};
