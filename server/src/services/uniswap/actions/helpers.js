const { ethers } = require('ethers');
const { ValidationError } = require('../../../errors/app-error');
const {
  ERC20_ABI,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V3_POSITION_MANAGER_ABI,
} = require('../abis');
const {
  MAX_UINT256,
  DEFAULT_SLIPPAGE_BPS,
  V3_SWAP_ROUTER_ADDRESS,
  CLOSE_SWAP_BUFFER_BPS,
  ACTIONS,
} = require('../constants');
const {
  buildApprovalRequirement,
  maybeBuildApprovalTx,
  buildWrapNativeTx,
  buildUnwrapNativeTx,
} = require('../tx-encoders');
const {
  buildV3SwapTx,
} = require('../tx-builders-v3');
const {
  buildPermit2ApprovalRequirement,
  buildPermit2ApproveTx,
  getPermit2State,
} = require('../permit2-helpers');
const {
  estimateTxPlanCostUsd,
} = require('../gas-cost-estimator');
const {
  isZeroAddress,
} = require('../position-math');
const uniswapService = require('../../uniswap.service');
const smartPoolCreatorService = require('../../smart-pool-creator.service');
const marketService = require('../../market.service');
const { isStableSymbol } = require('../../delta-neutral-math.service');
const logger = require('../../logger.service');
const onChainManager = require('../../onchain-manager.service');
const {
  PERMIT2_ADDRESS,
  V4_POSITION_MANAGER_ABI,
  V4_STATE_VIEW_ABI,
  computeV4PoolId,
  hasHooks,
  normalizeHooksAddress,
} = require('../../uniswap-v4-helpers.service');
const { SUPPORTED_NETWORKS } = require('../networks');
const {
  amountOutMin,
} = require('../../../domains/uniswap/pools/domain/position-action-math');

const {
  computeV4UnclaimedFees,
  decodeV4PositionInfo,
  liquidityToTokenAmounts,
} = uniswapService;

// ─── Address / Config ────────────────────────────────────────────────

function normalizeAddress(address, label = 'address') {
  try {
    return ethers.getAddress(String(address || '').trim());
  } catch {
    throw new ValidationError(`${label} invalida`);
  }
}

function normalizeCreatePositionPoolOrder({
  token0,
  token1,
  amount0Desired,
  amount1Desired,
  rangeLowerPrice,
  rangeUpperPrice,
  poolToken0Address,
  poolToken1Address,
}) {
  const normalizedPoolToken0 = normalizeAddress(poolToken0Address, 'poolToken0Address');
  const normalizedPoolToken1 = normalizeAddress(poolToken1Address, 'poolToken1Address');
  const reversed = normalizedPoolToken0.toLowerCase() !== token0.address.toLowerCase()
    && normalizedPoolToken1.toLowerCase() === token0.address.toLowerCase();

  if (!reversed) {
    return {
      reversed: false,
      token0,
      token1,
      amount0Desired,
      amount1Desired,
      rangeLowerPrice: Number(rangeLowerPrice),
      rangeUpperPrice: Number(rangeUpperPrice),
    };
  }

  const canonicalRange = smartPoolCreatorService.orientRangeToCanonicalOrder(rangeLowerPrice, rangeUpperPrice, true);
  return {
    reversed: true,
    token0: token1,
    token1: token0,
    amount0Desired: amount1Desired,
    amount1Desired: amount0Desired,
    rangeLowerPrice: canonicalRange.rangeLowerPrice,
    rangeUpperPrice: canonicalRange.rangeUpperPrice,
  };
}

function getProvider(networkConfig) {
  return onChainManager.getProvider(networkConfig, { scope: 'uniswap-position-actions' });
}

function getNetworkConfig(network) {
  const networkConfig = SUPPORTED_NETWORKS[String(network || '').toLowerCase()];
  if (!networkConfig) {
    throw new ValidationError(`network no soportada: ${network}`);
  }
  return networkConfig;
}

function ensureSupportedAction(action) {
  if (!ACTIONS.has(action)) {
    throw new ValidationError(`Accion no soportada: ${action}`);
  }
}

// ─── Token Queries ───────────────────────────────────────────────────

async function getTokenInfo(provider, address) {
  const tokenAddress = normalizeAddress(address, 'token');
  const contract = onChainManager.getContract({ runner: provider, address: tokenAddress, abi: ERC20_ABI });
  const [symbol, decimals] = await Promise.all([
    contract.symbol().catch(() => 'UNKNOWN'),
    contract.decimals().catch(() => 18),
  ]);

  return {
    address: tokenAddress,
    symbol,
    decimals: Number(decimals),
  };
}

async function getBalanceAndAllowance(provider, token, walletAddress, spender) {
  const contract = onChainManager.getContract({ runner: provider, address: token.address, abi: ERC20_ABI });
  const [balance, allowance] = await Promise.all([
    contract.balanceOf(walletAddress).catch(() => 0n),
    spender ? contract.allowance(walletAddress, spender).catch(() => 0n) : Promise.resolve(0n),
  ]);

  return {
    balance,
    allowance,
  };
}

/**
 * Version batched: lee balance+allowance de N tokens contra el mismo spender
 * en una sola RPC call via Multicall3. Devuelve el resultado en el mismo
 * orden que el array de tokens. Si Multicall3 no esta disponible cae al
 * path legacy (Promise.all de getBalanceAndAllowance).
 */
async function getBalancesAndAllowancesBatch({ provider, networkConfig, tokens, walletAddress, spender, scope = 'uniswap-position-actions' }) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];

  try {
    const calls = [];
    for (const token of tokens) {
      calls.push({ target: token.address, abi: ERC20_ABI, method: 'balanceOf', args: [walletAddress], allowFailure: true });
      if (spender) {
        calls.push({ target: token.address, abi: ERC20_ABI, method: 'allowance', args: [walletAddress, spender], allowFailure: true });
      }
    }
    const results = await onChainManager.aggregate({ networkConfig, scope, calls });
    const out = [];
    let cursor = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const balanceR = results[cursor++];
      const balance = balanceR?.success ? BigInt(balanceR.value) : 0n;
      let allowance = 0n;
      if (spender) {
        const allowanceR = results[cursor++];
        allowance = allowanceR?.success ? BigInt(allowanceR.value) : 0n;
      }
      out.push({ balance, allowance });
    }
    return out;
  } catch (mcErr) {
    logger.warn('balances_allowances_batch_multicall_fallback', {
      network: networkConfig?.id,
      tokenCount: tokens.length,
      error: mcErr?.message,
      code: mcErr?.code,
    });
    return Promise.all(tokens.map((token) => getBalanceAndAllowance(provider, token, walletAddress, spender)));
  }
}

// ─── Amount / Price ──────────────────────────────────────────────────

function toBigIntAmount(value, decimals, field) {
  if (value == null || value === '') return 0n;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new ValidationError(`${field} invalido`);
  }
  // Truncate excess decimals to avoid NUMERIC_FAULT underflow
  let str = String(value);
  const dotIdx = str.indexOf('.');
  if (dotIdx !== -1 && str.length - dotIdx - 1 > decimals) {
    str = str.slice(0, dotIdx + 1 + decimals);
  }
  return ethers.parseUnits(str, decimals);
}

// Mapeo del simbolo nativo de la red al simbolo usado en el feed de
// Hyperliquid (algunas redes renombraron su token, ej. MATIC -> POL).
const NATIVE_SYMBOL_TO_HL_SYMBOL = {
  ETH: 'ETH',
  POL: 'MATIC',
  MATIC: 'MATIC',
  BNB: 'BNB',
  AVAX: 'AVAX',
};

const _nativePriceCache = new Map(); // hlSymbol -> { price, fetchedAt }
const NATIVE_PRICE_TTL_MS = 60_000;

async function getNativeUsdPrice(networkConfig) {
  const nativeSymbol = String(networkConfig?.nativeSymbol || '').toUpperCase();
  const hlSymbol = NATIVE_SYMBOL_TO_HL_SYMBOL[nativeSymbol] || nativeSymbol;
  if (!hlSymbol) return null;

  const cached = _nativePriceCache.get(hlSymbol);
  if (cached && Date.now() - cached.fetchedAt < NATIVE_PRICE_TTL_MS) {
    return cached.price;
  }

  try {
    const mids = await marketService.getAllPrices();
    const raw = mids?.[hlSymbol];
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      _nativePriceCache.set(hlSymbol, { price: numeric, fetchedAt: Date.now() });
      return numeric;
    }
  } catch (err) {
    logger.warn('native_usd_price_fetch_failed', {
      network: networkConfig?.id,
      nativeSymbol,
      error: err.message,
    });
  }
  return null;
}

/**
 * Wrapper que adapta el ctx interno al formato esperado por
 * `estimateTxPlanCostUsd`. Mantiene la API legacy para los call sites existentes.
 */
async function buildEstimatedCosts(ctx, txPlan, { slippageCostUsd = 0 } = {}) {
  const provider = getProvider(ctx.networkConfig);
  const nativeUsdPrice = await getNativeUsdPrice(ctx.networkConfig);
  return estimateTxPlanCostUsd({ provider, txPlan, nativeUsdPrice, slippageCostUsd });
}

// ─── Close Operations ────────────────────────────────────────────────

function applyCloseBuffer(amount, bps = CLOSE_SWAP_BUFFER_BPS) {
  if (amount <= 0n) return 0n;
  const buffered = (amount * bps) / 10_000n;
  return buffered > 0n ? buffered : amount;
}

function getCanonicalUsdcTokenForNetwork(network) {
  const token = smartPoolCreatorService.getCanonicalUsdcToken(network);
  if (!token?.address) {
    throw new ValidationError(`No hay USDC canonico configurado para ${network}`);
  }
  return {
    address: normalizeAddress(token.address, 'usdc'),
    symbol: token.symbol,
    decimals: Number(token.decimals),
  };
}

/**
 * Determina el stablecoin destino al cerrar una posicion LP.
 *
 * Si el par YA contiene un stablecoin reconocido (USDC, USDT, USDT0, DAI...),
 * cerramos contra ESE stable: evita un swap stable->stable innecesario que
 * generaria fees, slippage y, en algunos casos, falla porque no hay un pool
 * directo con liquidez (ej. USDT0/USDC en Arbitrum V3).
 *
 * Si el par no tiene ningun stable, caemos al USDC canonico de la red -- que
 * es el comportamiento historico.
 *
 * @param {{ token0: { symbol, address, decimals }, token1: { symbol, address, decimals } }} ctx
 * @param {string} networkId
 */
function resolveCloseTargetStable(ctx, networkId) {
  const candidates = [ctx?.token0, ctx?.token1].filter(Boolean);
  for (const token of candidates) {
    if (isStableSymbol(token.symbol)) {
      return {
        address: normalizeAddress(token.address, 'closeTargetStable'),
        symbol: token.symbol,
        decimals: Number(token.decimals),
        sourceFromPair: true,
      };
    }
  }
  return {
    ...getCanonicalUsdcTokenForNetwork(networkId),
    sourceFromPair: false,
  };
}

function getWrappedNativeTokenForNetwork(network) {
  const token = smartPoolCreatorService.getWrappedNativeToken(network);
  if (!token?.address) return null;
  return {
    address: normalizeAddress(token.address, 'wrappedNative'),
    symbol: token.symbol,
    decimals: Number(token.decimals),
  };
}

function getGasReserveRaw(network) {
  return ethers.parseUnits(smartPoolCreatorService.getGasReserveAmount(network), 18);
}

function buildClosedPositionPreview(network, version, token0, token1, extra = {}) {
  return {
    network,
    version,
    status: 'closed',
    token0,
    token1,
    ...extra,
  };
}

async function appendV3SwapToToken({
  provider,
  networkConfig,
  normalizedWallet,
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
  txPlan,
  requiresApproval,
}) {
  if (amountIn <= 0n) return null;

  const route = await smartPoolCreatorService.resolveBestDirectRoute({
    provider,
    networkConfig,
    tokenIn,
    tokenOut,
    amountInRaw: amountIn,
  });
  if (!route) {
    throw new ValidationError(`No se encontro una ruta simple de ${tokenIn.symbol} a ${tokenOut.symbol}`);
  }

  const allowanceState = await getBalanceAndAllowance(provider, tokenIn, normalizedWallet, V3_SWAP_ROUTER_ADDRESS);
  if (allowanceState.allowance < amountIn) {
    requiresApproval.push(buildApprovalRequirement(tokenIn, V3_SWAP_ROUTER_ADDRESS, amountIn));
    txPlan.push(maybeBuildApprovalTx(tokenIn, V3_SWAP_ROUTER_ADDRESS, amountIn, networkConfig.chainId));
  }

  const amountOutMinimum = amountOutMin(route.expectedOutRaw, slippageBps);
  const swap = {
    tokenIn,
    tokenOut,
    fee: Number(route.fee),
    amountIn,
    amountOutMinimum,
  };
  txPlan.push(buildV3SwapTx({
    networkConfig,
    normalizedWallet,
  }, swap));

  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMinimum,
    routePoolAddress: route.poolAddress,
    fee: Number(route.fee),
    expectedOutRaw: route.expectedOutRaw,
    currentPrice: route.currentPrice,
  };
}

// ─── Approval ────────────────────────────────────────────────────────

async function appendPermit2Approvals({
  provider,
  token,
  walletAddress,
  spender,
  permit2Address = PERMIT2_ADDRESS,
  amount,
  chainId,
  requiresApproval,
  txPlan,
  enforceBalance = true,
}) {
  if (amount <= 0n) return;
  const state = await getPermit2State(provider, token, walletAddress, spender, permit2Address);
  if (enforceBalance && state.balance < amount) {
    throw new ValidationError(`La wallet no tiene balance suficiente de ${token.symbol}`);
  }

  if (state.tokenAllowanceToPermit2 < amount) {
    requiresApproval.push(buildApprovalRequirement(token, permit2Address, amount));
    txPlan.push(maybeBuildApprovalTx(token, permit2Address, amount, chainId));
  }

  if (state.permit2AllowanceAmount < amount) {
    requiresApproval.push(buildPermit2ApprovalRequirement(token, spender, amount, permit2Address));
    txPlan.push(buildPermit2ApproveTx(token, spender, amount, chainId, permit2Address));
  }
}

async function appendFundingSwapTransactions({
  provider,
  networkConfig,
  normalizedWallet,
  swapPlan = [],
  requiresApproval,
  txPlan,
  allowanceCache: externalCache,
}) {
  const allowanceCache = externalCache || new Map();

  for (const swap of swapPlan) {
    if (swap.requiresWrapNative && swap.wrapToken?.address) {
      txPlan.push(buildWrapNativeTx({
        address: swap.wrapToken.address,
        symbol: swap.wrapToken.symbol,
      }, BigInt(swap.amountInRaw), networkConfig.chainId));
    }

    const tokenIn = {
      address: normalizeAddress(swap.tokenIn.address, 'tokenIn'),
      symbol: swap.tokenIn.symbol,
      decimals: Number(swap.tokenIn.decimals),
    };
    const amountIn = BigInt(swap.amountInRaw);
    const cacheKey = `${tokenIn.address}:${V3_SWAP_ROUTER_ADDRESS}`;
    let allowanceState = allowanceCache.get(cacheKey);
    if (!allowanceState) {
      allowanceState = await getBalanceAndAllowance(provider, tokenIn, normalizedWallet, V3_SWAP_ROUTER_ADDRESS);
      allowanceCache.set(cacheKey, allowanceState);
    }
    if (allowanceState.allowance < amountIn) {
      requiresApproval.push(buildApprovalRequirement(tokenIn, V3_SWAP_ROUTER_ADDRESS, amountIn));
      txPlan.push(maybeBuildApprovalTx(tokenIn, V3_SWAP_ROUTER_ADDRESS, amountIn, networkConfig.chainId));
      allowanceState.allowance = MAX_UINT256;
      allowanceCache.set(cacheKey, allowanceState);
    }

    txPlan.push(buildV3SwapTx({
      networkConfig,
      normalizedWallet,
    }, {
      tokenIn,
      tokenOut: {
        address: normalizeAddress(swap.tokenOut.address, 'tokenOut'),
        symbol: swap.tokenOut.symbol,
        decimals: Number(swap.tokenOut.decimals),
      },
      fee: Number(swap.fee),
      amountIn,
      amountOutMinimum: BigInt(swap.amountOutMinimumRaw),
    }));
  }
}

// ─── Context Loaders ─────────────────────────────────────────────────

async function loadV3PositionContext({ network, walletAddress, positionIdentifier }) {
  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(walletAddress, 'walletAddress');
  const tokenId = String(positionIdentifier);
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v3.positionManager, 'positionManager');
  const factoryAddress = normalizeAddress(networkConfig.deployments.v3.eventSource, 'factory');
  const pm = onChainManager.getContract({ runner: provider, address: positionManagerAddress, abi: V3_POSITION_MANAGER_ABI });
  const factory = onChainManager.getContract({ runner: provider, address: factoryAddress, abi: V3_FACTORY_ABI });

  // Path optimizado via Multicall3: 3 round-trips en lugar de 8 reads
  // sequenciales (ownerOf, positions, 4x token meta, getPool, slot0, tickSpacing).
  // Si Multicall3 no existe en la red caemos al path legacy con un warning.
  let owner;
  let position;
  let token0;
  let token1;
  let poolAddress;
  let slot0Result;
  let tickSpacingResult;

  try {
    // Multicall #1: ownerOf + positions (ambos en el mismo PM)
    const batch1 = await onChainManager.aggregate({
      networkConfig,
      scope: 'uniswap-position-actions',
      calls: [
        { target: positionManagerAddress, abi: V3_POSITION_MANAGER_ABI, method: 'ownerOf', args: [tokenId] },
        { target: positionManagerAddress, abi: V3_POSITION_MANAGER_ABI, method: 'positions', args: [tokenId] },
      ],
    });
    owner = normalizeAddress(batch1[0].value, 'owner');
    if (owner.toLowerCase() !== normalizedWallet.toLowerCase()) {
      throw new ValidationError('La wallet proporcionada no es duena de esta posicion');
    }
    position = batch1[1].value;

    // Multicall #2: getPool + 4x token meta (necesitamos position.token0/token1 antes)
    const token0Address = normalizeAddress(position.token0, 'token0');
    const token1Address = normalizeAddress(position.token1, 'token1');
    const batch2 = await onChainManager.aggregate({
      networkConfig,
      scope: 'uniswap-position-actions',
      calls: [
        { target: factoryAddress, abi: V3_FACTORY_ABI, method: 'getPool', args: [token0Address, token1Address, position.fee] },
        { target: token0Address, abi: ERC20_ABI, method: 'symbol', allowFailure: true },
        { target: token0Address, abi: ERC20_ABI, method: 'decimals', allowFailure: true },
        { target: token1Address, abi: ERC20_ABI, method: 'symbol', allowFailure: true },
        { target: token1Address, abi: ERC20_ABI, method: 'decimals', allowFailure: true },
      ],
    });
    poolAddress = batch2[0].value;
    token0 = {
      address: token0Address,
      symbol: batch2[1].success ? batch2[1].value : 'UNKNOWN',
      decimals: batch2[2].success ? Number(batch2[2].value) : 18,
    };
    token1 = {
      address: token1Address,
      symbol: batch2[3].success ? batch2[3].value : 'UNKNOWN',
      decimals: batch2[4].success ? Number(batch2[4].value) : 18,
    };

    if (!poolAddress || poolAddress === ethers.ZeroAddress) {
      throw new ValidationError('No se encontro el pool asociado a la posicion');
    }

    // Multicall #3: slot0 + tickSpacing (ya conocemos pool address)
    const batch3 = await onChainManager.aggregate({
      networkConfig,
      scope: 'uniswap-position-actions',
      calls: [
        { target: poolAddress, abi: V3_POOL_ABI, method: 'slot0' },
        { target: poolAddress, abi: V3_POOL_ABI, method: 'tickSpacing' },
      ],
    });
    slot0Result = batch3[0].value;
    tickSpacingResult = batch3[1].value;
  } catch (multicallErr) {
    if (multicallErr instanceof ValidationError) throw multicallErr;
    logger.warn('load_v3_position_context_multicall_fallback', {
      network: networkConfig?.id,
      tokenId,
      error: multicallErr?.message,
      code: multicallErr?.code,
    });

    // Fallback legacy: secuencial sin multicall
    owner = normalizeAddress(await pm.ownerOf(tokenId), 'owner');
    if (owner.toLowerCase() !== normalizedWallet.toLowerCase()) {
      throw new ValidationError('La wallet proporcionada no es duena de esta posicion');
    }

    position = await pm.positions(tokenId);
    [token0, token1] = await Promise.all([
      getTokenInfo(provider, position.token0),
      getTokenInfo(provider, position.token1),
    ]);
    poolAddress = await factory.getPool(position.token0, position.token1, position.fee);
    if (!poolAddress || poolAddress === ethers.ZeroAddress) {
      throw new ValidationError('No se encontro el pool asociado a la posicion');
    }

    const pool = onChainManager.getContract({ runner: provider, address: poolAddress, abi: V3_POOL_ABI });
    [slot0Result, tickSpacingResult] = await Promise.all([
      pool.slot0(),
      pool.tickSpacing(),
    ]);
  }

  const slot0 = slot0Result;
  const tickSpacing = tickSpacingResult;

  const currentAmounts = liquidityToTokenAmounts({
    liquidity: String(position.liquidity),
    sqrtPriceX96: String(slot0.sqrtPriceX96),
    tickCurrent: Number(slot0.tick),
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
    token0Decimals: token0.decimals,
    token1Decimals: token1.decimals,
  });

  return {
    networkConfig,
    provider,
    normalizedWallet,
    tokenId,
    positionManagerAddress,
    position,
    token0,
    token1,
    poolAddress: normalizeAddress(poolAddress, 'poolAddress'),
    tickSpacing: Number(tickSpacing),
    currentTick: Number(slot0.tick),
    sqrtPriceX96: String(slot0.sqrtPriceX96),
    currentAmounts,
    priceCurrent: uniswapService.tickToPrice(Number(slot0.tick), token0.decimals, token1.decimals),
  };
}

async function loadV3DecreaseLiquidityContext({ network, walletAddress, positionIdentifier }) {
  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(walletAddress, 'walletAddress');
  const tokenId = String(positionIdentifier);
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v3.positionManager, 'positionManager');
  const pm = onChainManager.getContract({ runner: provider, address: positionManagerAddress, abi: V3_POSITION_MANAGER_ABI });

  const owner = normalizeAddress(await pm.ownerOf(tokenId), 'owner');
  if (owner.toLowerCase() !== normalizedWallet.toLowerCase()) {
    throw new ValidationError('La wallet proporcionada no es duena de esta posicion');
  }

  const position = await pm.positions(tokenId);

  return {
    networkConfig,
    provider,
    normalizedWallet,
    tokenId,
    positionManagerAddress,
    position,
  };
}

async function loadV4PositionContext({ network, walletAddress, positionIdentifier }) {
  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(walletAddress, 'walletAddress');
  const tokenId = String(positionIdentifier);
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager, 'positionManager');
  const stateViewAddress = normalizeAddress(networkConfig.deployments.v4.stateView, 'stateView');
  const positionManager = onChainManager.getContract({ runner: provider, address: positionManagerAddress, abi: V4_POSITION_MANAGER_ABI });
  const stateView = onChainManager.getContract({ runner: provider, address: stateViewAddress, abi: V4_STATE_VIEW_ABI });

  const owner = normalizeAddress(await positionManager.ownerOf(tokenId), 'owner');
  if (owner.toLowerCase() !== normalizedWallet.toLowerCase()) {
    throw new ValidationError('La wallet proporcionada no es duena de esta posicion');
  }

  const [poolAndPositionInfo, positionLiquidity] = await Promise.all([
    positionManager.getPoolAndPositionInfo(tokenId),
    positionManager.getPositionLiquidity(tokenId),
  ]);
  const [poolKey, rawPositionInfo] = poolAndPositionInfo;
  const normalizedPoolKey = {
    currency0: normalizeAddress(poolKey.currency0, 'currency0'),
    currency1: normalizeAddress(poolKey.currency1, 'currency1'),
    fee: Number(poolKey.fee),
    tickSpacing: Number(poolKey.tickSpacing),
    hooks: normalizeHooksAddress(poolKey.hooks),
  };
  if (hasHooks(normalizedPoolKey.hooks)) {
    throw new ValidationError('Los pools v4 con hooks no estan soportados en gestion on-chain por ahora');
  }
  if (isZeroAddress(normalizedPoolKey.currency0) || isZeroAddress(normalizedPoolKey.currency1)) {
    throw new ValidationError('Los pools v4 con token nativo no estan soportados en gestion on-chain por ahora');
  }

  const decodedPosition = decodeV4PositionInfo(rawPositionInfo);
  const poolId = computeV4PoolId(normalizedPoolKey);
  const salt = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
  const positionId = ethers.solidityPackedKeccak256(
    ['address', 'int24', 'int24', 'bytes32'],
    [positionManagerAddress, decodedPosition.tickLower, decodedPosition.tickUpper, salt]
  );

  const [slot0, poolLiquidity, positionInfo, feeGrowthInside, token0, token1] = await Promise.all([
    stateView.getSlot0(poolId),
    stateView.getLiquidity(poolId).catch(() => 0n),
    stateView.getPositionInfo(poolId, positionId),
    stateView.getFeeGrowthInside(poolId, decodedPosition.tickLower, decodedPosition.tickUpper),
    getTokenInfo(provider, normalizedPoolKey.currency0),
    getTokenInfo(provider, normalizedPoolKey.currency1),
  ]);

  const currentAmounts = liquidityToTokenAmounts({
    liquidity: String(positionLiquidity),
    sqrtPriceX96: String(slot0.sqrtPriceX96),
    tickCurrent: Number(slot0.tick),
    tickLower: decodedPosition.tickLower,
    tickUpper: decodedPosition.tickUpper,
    token0Decimals: token0.decimals,
    token1Decimals: token1.decimals,
  });
  const unclaimedFeesRaw = computeV4UnclaimedFees({
    liquidity: positionInfo.liquidity,
    feeGrowthInside0LastX128: positionInfo.feeGrowthInside0LastX128,
    feeGrowthInside1LastX128: positionInfo.feeGrowthInside1LastX128,
    feeGrowthInside0X128: feeGrowthInside.feeGrowthInside0X128,
    feeGrowthInside1X128: feeGrowthInside.feeGrowthInside1X128,
  });

  return {
    networkConfig,
    provider,
    normalizedWallet,
    tokenId,
    positionManagerAddress,
    stateViewAddress,
    permit2Address: PERMIT2_ADDRESS,
    universalRouterAddress: require('../../uniswap-v4-helpers.service').getUniversalRouterAddress(networkConfig.id),
    positionManager,
    stateView,
    poolKey: normalizedPoolKey,
    poolId,
    positionInfo,
    token0,
    token1,
    tickLower: decodedPosition.tickLower,
    tickUpper: decodedPosition.tickUpper,
    tickSpacing: normalizedPoolKey.tickSpacing,
    currentTick: Number(slot0.tick),
    sqrtPriceX96: String(slot0.sqrtPriceX96),
    priceCurrent: uniswapService.tickToPrice(Number(slot0.tick), token0.decimals, token1.decimals),
    positionLiquidity: BigInt(positionLiquidity),
    poolLiquidity: BigInt(poolLiquidity),
    currentAmounts,
    unclaimedFeesRaw,
  };
}

async function loadWalletPoolSnapshot(userId, { network, version, walletAddress, positionIdentifier }) {
  const result = await uniswapService.scanPoolsCreatedByWallet({
    userId,
    wallet: walletAddress,
    network,
    version,
  });

  return result.pools.find((pool) => String(pool.identifier) === String(positionIdentifier)) || null;
}

module.exports = {
  // Address/Config
  normalizeAddress,
  normalizeCreatePositionPoolOrder,
  getProvider,
  getNetworkConfig,
  ensureSupportedAction,
  // Token Queries
  getTokenInfo,
  getBalanceAndAllowance,
  getBalancesAndAllowancesBatch,
  // Amount/Price
  toBigIntAmount,
  NATIVE_SYMBOL_TO_HL_SYMBOL,
  _nativePriceCache,
  getNativeUsdPrice,
  buildEstimatedCosts,
  // Close Operations
  applyCloseBuffer,
  getCanonicalUsdcTokenForNetwork,
  resolveCloseTargetStable,
  getWrappedNativeTokenForNetwork,
  getGasReserveRaw,
  buildClosedPositionPreview,
  appendV3SwapToToken,
  // Approval
  appendPermit2Approvals,
  appendFundingSwapTransactions,
  // Context Loaders
  loadV3PositionContext,
  loadV3DecreaseLiquidityContext,
  loadV4PositionContext,
  loadWalletPoolSnapshot,
};
