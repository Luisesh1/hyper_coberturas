const { ethers } = require('ethers');
const { ValidationError, ExternalServiceError } = require('../errors/app-error');
const uniswapService = require('./uniswap.service');
const claimFeesService = require('./uniswap-claim-fees.service');
const protectedPoolRepo = require('../repositories/protected-uniswap-pool.repository');
const protectedPoolRefreshService = require('./protected-pool-refresh.service');
const smartPoolCreatorService = require('./smart-pool-creator.service');
const logger = require('./logger.service');
const {
  DEFAULT_PERMIT2_EXPIRATION_SECONDS,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  UNIVERSAL_ROUTER_ABI,
  V4_ACTIONS,
  V4_POSITION_MANAGER_ABI,
  V4_STATE_VIEW_ABI,
  buildPermit2ApproveCalldata,
  buildUniversalRouterCalldata,
  buildV4ModifyLiquiditiesCalldata,
  computeV4PoolId,
  encodeV4CloseCurrencyParams,
  encodeV4MintParams,
  encodeV4ModifyLiquidityParams,
  encodeV4SettleAllParams,
  encodeV4SwapExactInSingleParams,
  encodeV4TakeAllParams,
  getUniversalRouterAddress,
  hasHooks,
  normalizeHooksAddress,
} = require('./uniswap-v4-helpers.service');

const {
  SUPPORTED_NETWORKS,
  computeV4UnclaimedFees,
  decodeV4PositionInfo,
  liquidityToTokenAmounts,
  tickToRawSqrtRatio,
} = uniswapService;

const _finalizeCache = new Map();
const FINALIZE_CACHE_TTL_MS = 300_000; // 5 min

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const WRAPPED_NATIVE_ABI = [
  'function deposit() payable',
  'function withdraw(uint256)',
];

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const V3_POOL_ABI = [
  'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const V3_POSITION_MANAGER_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

const V3_SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

const PERMIT2_APPROVAL_ABI = PERMIT2_ABI;

const TRANSFER_EVENT_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

const MAX_UINT128 = (1n << 128n) - 1n;
const DEFAULT_DEADLINE_SECONDS = 1800;
const DEFAULT_SLIPPAGE_BPS = 100;
const V3_SWAP_ROUTER_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const MAX_UINT256 = (1n << 256n) - 1n;
const CLOSE_SWAP_BUFFER_BPS = 9800n;
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

const ACTIONS = new Set([
  'increase-liquidity',
  'decrease-liquidity',
  'collect-fees',
  'reinvest-fees',
  'modify-range',
  'rebalance',
  'create-position',
  'close-to-usdc',
  'close-keep-assets',
]);

const CLOSE_ACTIONS = new Set([
  'close-to-usdc',
  'close-keep-assets',
]);

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
  if (!getProvider.cache) getProvider.cache = new Map();
  if (!getProvider.cache.has(networkConfig.id)) {
    getProvider.cache.set(
      networkConfig.id,
      new ethers.JsonRpcProvider(networkConfig.rpcUrl, networkConfig.chainId, { staticNetwork: true })
    );
  }
  return getProvider.cache.get(networkConfig.id);
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

function encodeTx(to, data, { value = '0x0', chainId, label, kind, sequence, gas, meta = {} } = {}) {
  const tx = {
    to,
    data,
    value,
    chainId,
    label: label || kind || 'transaction',
    kind: kind || 'contract_call',
    sequence: sequence ?? null,
    ...meta,
  };
  if (gas) tx.gas = gas;
  return tx;
}

async function getTokenInfo(provider, address) {
  const tokenAddress = normalizeAddress(address, 'token');
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
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
  const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
  const [balance, allowance] = await Promise.all([
    contract.balanceOf(walletAddress).catch(() => 0n),
    spender ? contract.allowance(walletAddress, spender).catch(() => 0n) : Promise.resolve(0n),
  ]);

  return {
    balance,
    allowance,
  };
}

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

function amountOutMin(rawAmountOut, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  const bps = BigInt(Math.max(0, Math.min(5000, Number(slippageBps) || DEFAULT_SLIPPAGE_BPS)));
  return rawAmountOut - ((rawAmountOut * bps) / 10_000n);
}

function roundNullable(value, digits = 4) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function estimateSwapValueUsd(ctx, swap) {
  if (!swap || swap.amountIn <= 0n) return 0;
  if (swap.tokenIn.address.toLowerCase() === ctx.token0.address.toLowerCase()) {
    return Number(ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals)) * Number(ctx.priceCurrent);
  }
  return Number(ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals));
}

async function buildEstimatedCosts(ctx, txPlan, { slippageCostUsd = 0 } = {}) {
  const filteredTxPlan = txPlan.filter(Boolean);
  let totalGasUnits = 0;
  const txBreakdown = filteredTxPlan.map((tx) => {
    const gas = GAS_PER_TX_TYPE[tx.kind] || 150_000;
    totalGasUnits += gas;
    return { label: tx.label || tx.kind, gasUnits: gas };
  });

  let gasCostUsd = null;
  let gasCostEth = null;
  try {
    const feeData = await getProvider(ctx.networkConfig).getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
    const totalGasWei = gasPrice * BigInt(totalGasUnits);
    gasCostEth = Number(ethers.formatEther(totalGasWei));
    const nativeUsdPrice = ctx.priceCurrent > 1 ? ctx.priceCurrent : (1 / ctx.priceCurrent);
    gasCostUsd = gasCostEth * nativeUsdPrice;
  } catch {
    // Best effort.
  }

  const totalEstimatedCostUsd = (gasCostUsd || 0) + (slippageCostUsd || 0);
  return {
    gasCostEth: roundNullable(gasCostEth, 8),
    gasCostUsd: roundNullable(gasCostUsd, 4),
    slippageCostUsd: roundNullable(slippageCostUsd || 0, 4),
    totalEstimatedCostUsd: roundNullable(totalEstimatedCostUsd, 4) ?? 0,
    txCount: filteredTxPlan.length,
    txBreakdown,
  };
}

function deadlineFromNow(seconds = DEFAULT_DEADLINE_SECONDS) {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

function buildApprovalRequirement(token, spender, amount) {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    spender,
    amount: amount.toString(),
    formattedAmount: ethers.formatUnits(amount, token.decimals),
  };
}

function maybeBuildApprovalTx(token, spender, amount, chainId) {
  if (amount <= 0n) return null;
  const iface = new ethers.Interface(ERC20_ABI);
  return encodeTx(
    token.address,
    iface.encodeFunctionData('approve', [spender, MAX_UINT256]),
    {
      chainId,
      kind: 'approval',
      label: `Approve ${token.symbol}`,
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        spender,
        amount: MAX_UINT256.toString(),
      },
    }
  );
}

function buildWrapNativeTx(token, amount, chainId) {
  if (amount <= 0n) return null;
  const iface = new ethers.Interface(WRAPPED_NATIVE_ABI);
  return encodeTx(
    token.address,
    iface.encodeFunctionData('deposit', []),
    {
      chainId,
      kind: 'wrap_native',
      label: `Wrap native to ${token.symbol}`,
      value: ethers.toBeHex(amount),
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        amount: amount.toString(),
      },
    }
  );
}

function buildUnwrapNativeTx(token, amount, chainId) {
  if (amount <= 0n) return null;
  const iface = new ethers.Interface(WRAPPED_NATIVE_ABI);
  return encodeTx(
    token.address,
    iface.encodeFunctionData('withdraw', [amount]),
    {
      chainId,
      kind: 'unwrap_native',
      label: `Unwrap ${token.symbol} to native`,
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        amount: amount.toString(),
      },
    }
  );
}

function applyCloseBuffer(amount, bps = CLOSE_SWAP_BUFFER_BPS) {
  if (amount <= 0n) return 0n;
  const buffered = (amount * bps) / 10_000n;
  return buffered > 0n ? buffered : amount;
}

function getCanonicalUsdcTokenForNetwork(network) {
  const token = smartPoolCreatorService.getCanonicalUsdcToken(network);
  if (!token?.address) {
    throw new ValidationError(`No hay USDC canónico configurado para ${network}`);
  }
  return {
    address: normalizeAddress(token.address, 'usdc'),
    symbol: token.symbol,
    decimals: Number(token.decimals),
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
    throw new ValidationError(`No se encontró una ruta simple de ${tokenIn.symbol} a ${tokenOut.symbol}`);
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

function priceToNearestTick(price, token0Decimals, token1Decimals, tickSpacing, direction = 'nearest') {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new ValidationError('Precio de rango invalido');
  }

  const decimalDelta = token0Decimals - token1Decimals;
  const rawTick = Math.log(numeric / (10 ** decimalDelta)) / Math.log(1.0001);
  const spacing = Number(tickSpacing);
  if (!Number.isFinite(spacing) || spacing <= 0) {
    throw new ValidationError('tickSpacing invalido');
  }

  if (direction === 'down') return Math.floor(rawTick / spacing) * spacing;
  if (direction === 'up') return Math.ceil(rawTick / spacing) * spacing;
  return Math.round(rawTick / spacing) * spacing;
}

function isZeroAddress(value) {
  return String(value || '').toLowerCase() === ethers.ZeroAddress.toLowerCase();
}

function amountToNumber(rawAmount) {
  const numeric = Number(rawAmount);
  if (Number.isFinite(numeric)) return numeric;
  try {
    return Number(rawAmount.toString());
  } catch {
    return 0;
  }
}

function estimateLiquidityForAmounts({
  amount0Raw,
  amount1Raw,
  tickCurrent,
  tickLower,
  tickUpper,
}) {
  const sqrtCurrent = tickToRawSqrtRatio(tickCurrent);
  const sqrtLower = tickToRawSqrtRatio(tickLower);
  const sqrtUpper = tickToRawSqrtRatio(tickUpper);
  if (
    !Number.isFinite(sqrtCurrent) ||
    !Number.isFinite(sqrtLower) ||
    !Number.isFinite(sqrtUpper) ||
    sqrtLower <= 0 ||
    sqrtUpper <= 0
  ) {
    throw new ValidationError('No se pudo estimar la liquidez del rango seleccionado');
  }

  const lower = Math.min(sqrtLower, sqrtUpper);
  const upper = Math.max(sqrtLower, sqrtUpper);
  const amount0 = amountToNumber(amount0Raw);
  const amount1 = amountToNumber(amount1Raw);
  let liquidity = 0;

  if (sqrtCurrent <= lower) {
    liquidity = amount0 * ((lower * upper) / (upper - lower));
  } else if (sqrtCurrent < upper) {
    const liquidity0 = amount0 * ((sqrtCurrent * upper) / (upper - sqrtCurrent));
    const liquidity1 = amount1 / (sqrtCurrent - lower);
    liquidity = Math.min(liquidity0, liquidity1);
  } else {
    liquidity = amount1 / (upper - lower);
  }

  if (!Number.isFinite(liquidity) || liquidity <= 0) {
    throw new ValidationError('Los montos elegidos no generan liquidez util para este rango');
  }

  return BigInt(Math.max(1, Math.floor(liquidity)));
}

function buildPermit2ApprovalRequirement(token, spender, amount, permit2Address) {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    spender,
    permit2Address,
    amount: amount.toString(),
    formattedAmount: ethers.formatUnits(amount, token.decimals),
    type: 'permit2_approval',
  };
}

function buildPermit2ApproveTx(token, spender, amount, chainId, permit2Address) {
  if (amount <= 0n) return null;
  return encodeTx(
    permit2Address,
    buildPermit2ApproveCalldata(
      token.address,
      spender,
      amount,
      BigInt(Math.floor(Date.now() / 1000) + DEFAULT_PERMIT2_EXPIRATION_SECONDS)
    ),
    {
      chainId,
      kind: 'permit2_approval',
      label: `Permit2 approve ${token.symbol}`,
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        spender,
        amount: amount.toString(),
        permit2Address,
      },
    }
  );
}

async function getPermit2State(provider, token, walletAddress, spender, permit2Address = PERMIT2_ADDRESS) {
  const tokenContract = new ethers.Contract(token.address, ERC20_ABI, provider);
  const permit2 = new ethers.Contract(permit2Address, PERMIT2_APPROVAL_ABI, provider);
  const [[balance, tokenAllowance], permit2Allowance] = await Promise.all([
    Promise.all([
      tokenContract.balanceOf(walletAddress).catch(() => 0n),
      tokenContract.allowance(walletAddress, permit2Address).catch(() => 0n),
    ]),
    permit2.allowance(walletAddress, token.address, spender).catch(() => [0n, 0n, 0n]),
  ]);

  return {
    balance,
    tokenAllowanceToPermit2: BigInt(tokenAllowance || 0n),
    permit2AllowanceAmount: BigInt(Array.isArray(permit2Allowance) ? permit2Allowance[0] || 0n : 0n),
  };
}

async function loadV3PositionContext({ network, walletAddress, positionIdentifier }) {
  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(walletAddress, 'walletAddress');
  const tokenId = String(positionIdentifier);
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v3.positionManager, 'positionManager');
  const factoryAddress = normalizeAddress(networkConfig.deployments.v3.eventSource, 'factory');
  const pm = new ethers.Contract(positionManagerAddress, V3_POSITION_MANAGER_ABI, provider);
  const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider);

  const owner = normalizeAddress(await pm.ownerOf(tokenId), 'owner');
  if (owner.toLowerCase() !== normalizedWallet.toLowerCase()) {
    throw new ValidationError('La wallet proporcionada no es dueña de esta posicion');
  }

  const position = await pm.positions(tokenId);
  const [token0, token1] = await Promise.all([
    getTokenInfo(provider, position.token0),
    getTokenInfo(provider, position.token1),
  ]);
  const poolAddress = await factory.getPool(position.token0, position.token1, position.fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new ValidationError('No se encontro el pool asociado a la posicion');
  }

  const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
  const [slot0, tickSpacing] = await Promise.all([
    pool.slot0(),
    pool.tickSpacing(),
  ]);

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

async function loadV4PositionContext({ network, walletAddress, positionIdentifier }) {
  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(walletAddress, 'walletAddress');
  const tokenId = String(positionIdentifier);
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager, 'positionManager');
  const stateViewAddress = normalizeAddress(networkConfig.deployments.v4.stateView, 'stateView');
  const positionManager = new ethers.Contract(positionManagerAddress, V4_POSITION_MANAGER_ABI, provider);
  const stateView = new ethers.Contract(stateViewAddress, V4_STATE_VIEW_ABI, provider);

  const owner = normalizeAddress(await positionManager.ownerOf(tokenId), 'owner');
  if (owner.toLowerCase() !== normalizedWallet.toLowerCase()) {
    throw new ValidationError('La wallet proporcionada no es dueña de esta posicion');
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
    universalRouterAddress: getUniversalRouterAddress(networkConfig.id),
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

function buildV3IncreaseTx(ctx, { amount0Desired, amount1Desired, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  const amount0Min = amountOutMin(amount0Desired, slippageBps);
  const amount1Min = amountOutMin(amount1Desired, slippageBps);
  const data = iface.encodeFunctionData('increaseLiquidity', [{
    tokenId: BigInt(ctx.tokenId),
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    deadline: deadlineFromNow(),
  }]);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'increase_liquidity',
    label: 'Increase liquidity',
  });
}

function buildV3DecreaseTx(ctx, { liquidityDelta, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  const data = iface.encodeFunctionData('decreaseLiquidity', [{
    tokenId: BigInt(ctx.tokenId),
    liquidity: liquidityDelta,
    amount0Min: 0n,
    amount1Min: 0n,
    deadline: deadlineFromNow(),
  }]);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'decrease_liquidity',
    label: 'Decrease liquidity',
  });
}

function buildV3MintTx(ctx, {
  tickLower,
  tickUpper,
  amount0Desired,
  amount1Desired,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  recipient,
  amount0Min: overrideAmount0Min,
  amount1Min: overrideAmount1Min,
  gasEstimate,
}) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  const data = iface.encodeFunctionData('mint', [{
    token0: ctx.token0.address,
    token1: ctx.token1.address,
    fee: ctx.position?.fee ?? ctx.fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min: overrideAmount0Min ?? amountOutMin(amount0Desired, slippageBps),
    amount1Min: overrideAmount1Min ?? amountOutMin(amount1Desired, slippageBps),
    recipient,
    deadline: deadlineFromNow(),
  }]);

  const txOpts = {
    chainId: ctx.networkConfig.chainId,
    kind: 'mint_position',
    label: 'Mint new position',
  };
  if (gasEstimate) txOpts.gas = gasEstimate;
  return encodeTx(ctx.positionManagerAddress, data, txOpts);
}

function buildV3SwapTx(ctx, swap) {
  if (!swap || swap.amountIn <= 0n) return null;
  const iface = new ethers.Interface(V3_SWAP_ROUTER_ABI);
  const data = iface.encodeFunctionData('exactInputSingle', [{
    tokenIn: swap.tokenIn.address,
    tokenOut: swap.tokenOut.address,
    fee: swap.fee ?? ctx.position?.fee ?? ctx.fee,
    recipient: ctx.normalizedWallet,
    amountIn: swap.amountIn,
    amountOutMinimum: swap.amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  }]);

  return encodeTx(V3_SWAP_ROUTER_ADDRESS, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'swap',
    label: `Swap ${swap.tokenIn.symbol} -> ${swap.tokenOut.symbol}`,
  });
}

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

function buildPostPreview({
  network,
  version,
  positionIdentifier,
  tickLower,
  tickUpper,
  amount0Desired,
  amount1Desired,
  token0,
  token1,
  priceCurrent,
}) {
  const lowerPrice = uniswapService.tickToPrice(tickLower, token0.decimals, token1.decimals);
  const upperPrice = uniswapService.tickToPrice(tickUpper, token0.decimals, token1.decimals);

  return {
    network,
    version,
    positionIdentifier: positionIdentifier ? String(positionIdentifier) : null,
    token0,
    token1,
    rangeLowerPrice: Number(lowerPrice.toFixed(6)),
    rangeUpperPrice: Number(upperPrice.toFixed(6)),
    priceCurrent: Number(priceCurrent.toFixed(6)),
    desiredAmounts: {
      amount0: ethers.formatUnits(amount0Desired, token0.decimals),
      amount1: ethers.formatUnits(amount1Desired, token1.decimals),
    },
  };
}

function buildProtectionImpact(positionIdentifier, nextPositionIdentifier = null) {
  return {
    hasPotentialMigration: nextPositionIdentifier != null && String(nextPositionIdentifier) !== String(positionIdentifier),
    oldPositionIdentifier: positionIdentifier ? String(positionIdentifier) : null,
    expectedNewPositionIdentifier: nextPositionIdentifier ? String(nextPositionIdentifier) : null,
  };
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

async function prepareIncreaseLiquidity(payload) {
  const ctx = await loadV3PositionContext(payload);
  const amount0Desired = toBigIntAmount(payload.amount0Desired, ctx.token0.decimals, 'amount0Desired');
  const amount1Desired = toBigIntAmount(payload.amount1Desired, ctx.token1.decimals, 'amount1Desired');
  const [token0State, token1State] = await Promise.all([
    getBalanceAndAllowance(ctx.provider, ctx.token0, ctx.normalizedWallet, ctx.positionManagerAddress),
    getBalanceAndAllowance(ctx.provider, ctx.token1, ctx.normalizedWallet, ctx.positionManagerAddress),
  ]);

  if (token0State.balance < amount0Desired || token1State.balance < amount1Desired) {
    throw new ValidationError('La wallet no tiene balance suficiente para aumentar liquidez');
  }

  const requiresApproval = [];
  const txPlan = [];
  if (token0State.allowance < amount0Desired) {
    requiresApproval.push(buildApprovalRequirement(ctx.token0, ctx.positionManagerAddress, amount0Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token0, ctx.positionManagerAddress, amount0Desired, ctx.networkConfig.chainId));
  }
  if (token1State.allowance < amount1Desired) {
    requiresApproval.push(buildApprovalRequirement(ctx.token1, ctx.positionManagerAddress, amount1Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token1, ctx.positionManagerAddress, amount1Desired, ctx.networkConfig.chainId));
  }
  txPlan.push(buildV3IncreaseTx(ctx, { amount0Desired, amount1Desired, slippageBps: payload.slippageBps }));

  return {
    action: 'increase-liquidity',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      amount0Desired: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      currentAmounts: ctx.currentAmounts,
      liquidity: ctx.position.liquidity.toString(),
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v3',
      positionIdentifier: ctx.tokenId,
      tickLower: Number(ctx.position.tickLower),
      tickUpper: Number(ctx.position.tickUpper),
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareDecreaseLiquidity(payload) {
  const ctx = await loadV3PositionContext(payload);
  const percent = Number(payload.liquidityPercent ?? 100);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new ValidationError('liquidityPercent debe estar entre 0 y 100');
  }

  const liquidityDelta = (BigInt(ctx.position.liquidity) * BigInt(Math.round(percent * 100))) / 10_000n;
  if (liquidityDelta <= 0n) {
    throw new ValidationError('La liquidez a retirar es demasiado pequena');
  }

  return {
    action: 'decrease-liquidity',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      liquidityPercent: percent,
      estimatedCurrentAmounts: ctx.currentAmounts,
      currentLiquidity: ctx.position.liquidity.toString(),
      liquidityDelta: liquidityDelta.toString(),
    },
    requiresApproval: [],
    txPlan: [buildV3DecreaseTx(ctx, { liquidityDelta, slippageBps: payload.slippageBps })],
    postActionPositionPreview: {
      network: ctx.networkConfig.id,
      version: 'v3',
      positionIdentifier: ctx.tokenId,
      estimatedRemainingLiquidity: (BigInt(ctx.position.liquidity) - liquidityDelta).toString(),
    },
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareCollectFees(payload) {
  const claim = await claimFeesService.prepareClaimFees(payload);
  return {
    action: 'collect-fees',
    network: claim.claimSummary.network,
    version: claim.claimSummary.version,
    positionIdentifier: String(claim.claimSummary.positionIdentifier),
    walletAddress: claim.claimSummary.recipient,
    quoteSummary: claim.claimSummary,
    requiresApproval: [],
    txPlan: [encodeTx(claim.tx.to, claim.tx.data, {
      value: claim.tx.value,
      chainId: claim.tx.chainId,
      kind: 'collect_fees',
      label: 'Collect fees',
    })],
    postActionPositionPreview: {
      network: claim.claimSummary.network,
      version: claim.claimSummary.version,
      positionIdentifier: String(claim.claimSummary.positionIdentifier),
    },
    protectionImpact: buildProtectionImpact(claim.claimSummary.positionIdentifier),
  };
}

async function prepareReinvestFees(payload) {
  const ctx = await loadV3PositionContext(payload);
  const amount0Desired = BigInt(ctx.position.tokensOwed0);
  const amount1Desired = BigInt(ctx.position.tokensOwed1);
  if (amount0Desired <= 0n && amount1Desired <= 0n) {
    throw new ValidationError('No hay fees pendientes para reinvertir');
  }

  const txPlan = [
    ...(await prepareCollectFees(payload)).txPlan,
  ];
  const requiresApproval = [];
  if (amount0Desired > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token0, ctx.positionManagerAddress, amount0Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token0, ctx.positionManagerAddress, amount0Desired, ctx.networkConfig.chainId));
  }
  if (amount1Desired > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token1, ctx.positionManagerAddress, amount1Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token1, ctx.positionManagerAddress, amount1Desired, ctx.networkConfig.chainId));
  }
  txPlan.push(buildV3IncreaseTx(ctx, { amount0Desired, amount1Desired, slippageBps: payload.slippageBps }));

  return {
    action: 'reinvest-fees',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      feesToReinvest: {
        amount0: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      },
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v3',
      positionIdentifier: ctx.tokenId,
      tickLower: Number(ctx.position.tickLower),
      tickUpper: Number(ctx.position.tickUpper),
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

function computeOptimalWeightToken0Pct(priceCurrent, lowerPrice, upperPrice) {
  if (priceCurrent <= lowerPrice) return 100;
  if (priceCurrent >= upperPrice) return 0;
  const sqrtP = Math.sqrt(priceCurrent);
  const sqrtL = Math.sqrt(lowerPrice);
  const sqrtU = Math.sqrt(upperPrice);
  const amount0Value = priceCurrent * (sqrtU - sqrtP) / (sqrtP * sqrtU);
  const amount1Value = sqrtP - sqrtL;
  const total = amount0Value + amount1Value;
  if (!Number.isFinite(total) || total <= 0) return 50;
  return Math.max(1, Math.min(99, (amount0Value / total) * 100));
}

function buildModifyRangeRedeployPlan(ctx, {
  amount0Available,
  amount1Available,
  lowerPrice,
  upperPrice,
  slippageBps,
}) {
  const optimalWeight = computeOptimalWeightToken0Pct(ctx.priceCurrent, lowerPrice, upperPrice);
  const swapTargetWeightToken0Pct = Math.max(1, Math.min(99, Number(optimalWeight)));
  const swap = buildRebalanceSwap(ctx, {
    amount0Available,
    amount1Available,
    targetWeightToken0Pct: swapTargetWeightToken0Pct,
    slippageBps,
  });

  return {
    optimalWeight,
    swapTargetWeightToken0Pct,
    swap,
    amount0Desired: swap?.postAmount0 ?? amount0Available,
    amount1Desired: swap?.postAmount1 ?? amount1Available,
  };
}

async function prepareModifyRange(payload) {
  const ctx = await loadV3PositionContext(payload);
  const lowerPrice = Number(payload.rangeLowerPrice);
  const upperPrice = Number(payload.rangeUpperPrice);
  if (!Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice) || lowerPrice <= 0 || upperPrice <= lowerPrice) {
    throw new ValidationError('El rango nuevo es invalido');
  }

  const positionLiquidity = BigInt(ctx.position.liquidity);
  const tokensOwed0 = BigInt(ctx.position.tokensOwed0);
  const tokensOwed1 = BigInt(ctx.position.tokensOwed1);
  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');

  // If position was already emptied (e.g. from a prior failed modify-range), use wallet balances
  const provider = getProvider(ctx.networkConfig);
  let amount0Available, amount1Available;
  if (positionLiquidity === 0n && amount0Current === 0n && amount1Current === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
    const [bal0, bal1] = await Promise.all([
      getBalanceAndAllowance(provider, ctx.token0, ctx.normalizedWallet, ctx.positionManagerAddress),
      getBalanceAndAllowance(provider, ctx.token1, ctx.normalizedWallet, ctx.positionManagerAddress),
    ]);
    amount0Available = bal0.balance;
    amount1Available = bal1.balance;
    if (amount0Available === 0n && amount1Available === 0n) {
      throw new ValidationError('La posición no tiene liquidez ni hay tokens en la wallet para crear una nueva.');
    }
  } else {
    amount0Available = amount0Current + tokensOwed0;
    amount1Available = amount1Current + tokensOwed1;
  }

  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  if (tickLower >= tickUpper) {
    throw new ValidationError('El rango nuevo genera ticks invalidos');
  }

  const txPlan = [];
  const requiresApproval = [];

  // Only decrease + collect if there's liquidity or pending fees
  if (positionLiquidity > 0n) {
    txPlan.push(buildV3DecreaseTx(ctx, { liquidityDelta: positionLiquidity, slippageBps: payload.slippageBps }));
  }
  if (positionLiquidity > 0n || tokensOwed0 > 0n || tokensOwed1 > 0n) {
    txPlan.push(...(await prepareCollectFees(payload)).txPlan);
  }

  const {
    optimalWeight,
    swap,
    amount0Desired,
    amount1Desired,
  } = buildModifyRangeRedeployPlan(ctx, {
    amount0Available,
    amount1Available,
    lowerPrice,
    upperPrice,
    slippageBps: payload.slippageBps,
  });

  if (swap?.amountIn > 0n) {
    requiresApproval.push(buildApprovalRequirement(swap.tokenIn, V3_SWAP_ROUTER_ADDRESS, swap.amountIn));
    txPlan.push(maybeBuildApprovalTx(swap.tokenIn, V3_SWAP_ROUTER_ADDRESS, swap.amountIn, ctx.networkConfig.chainId));
    txPlan.push(buildV3SwapTx(ctx, swap));
  }

  if (amount0Desired > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token0, ctx.positionManagerAddress, amount0Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token0, ctx.positionManagerAddress, amount0Desired, ctx.networkConfig.chainId));
  }
  if (amount1Desired > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token1, ctx.positionManagerAddress, amount1Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token1, ctx.positionManagerAddress, amount1Desired, ctx.networkConfig.chainId));
  }

  txPlan.push(buildV3MintTx(ctx, {
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    slippageBps: payload.slippageBps,
    recipient: ctx.normalizedWallet,
    amount0Min: 0n,
    amount1Min: 0n,
  }));

  const slippageCostUsd = estimateSwapValueUsd(ctx, swap) * (Number(payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10_000);
  const estimatedCosts = await buildEstimatedCosts(ctx, txPlan, { slippageCostUsd });

  return {
    action: 'modify-range',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      oldRange: {
        tickLower: Number(ctx.position.tickLower),
        tickUpper: Number(ctx.position.tickUpper),
      },
      newRange: {
        tickLower,
        tickUpper,
        rangeLowerPrice: lowerPrice,
        rangeUpperPrice: upperPrice,
      },
      optimalWeightToken0Pct: Number(optimalWeight.toFixed(2)),
      swap: swap ? {
        direction: swap.direction,
        amountIn: ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals),
        tokenIn: swap.tokenIn.symbol,
        tokenOut: swap.tokenOut.symbol,
        minAmountOut: ethers.formatUnits(swap.amountOutMinimum, swap.tokenOut.decimals),
      } : null,
      expectedRedeployAmounts: {
        amount0: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      },
      estimatedCosts,
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v3',
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId, 'new_position_pending'),
  };
}

function buildRebalanceSwap(ctx, {
  amount0Available,
  amount1Available,
  targetWeightToken0Pct,
  slippageBps,
}) {
  const price = Number(ctx.priceCurrent);
  if (!Number.isFinite(price) || price <= 0) return null;
  const targetPct = Number(targetWeightToken0Pct);
  if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct >= 100) {
    throw new ValidationError('targetWeightToken0Pct debe estar entre 0 y 100');
  }

  const value0 = Number(ethers.formatUnits(amount0Available, ctx.token0.decimals)) * price;
  const value1 = Number(ethers.formatUnits(amount1Available, ctx.token1.decimals));
  const totalValue = value0 + value1;
  if (!Number.isFinite(totalValue) || totalValue <= 0) return null;

  const targetValue0 = totalValue * (targetPct / 100);
  if (value0 > targetValue0) {
    const valueToSwap = value0 - targetValue0;
    const amountIn = ethers.parseUnits(String((valueToSwap / price).toFixed(8)), ctx.token0.decimals);
    if (amountIn <= 0n) return null;
    const expectedOut = ethers.parseUnits(String(valueToSwap.toFixed(6)), ctx.token1.decimals);
    const minimumOut = amountOutMin(expectedOut, slippageBps);
    return {
      tokenIn: ctx.token0,
      tokenOut: ctx.token1,
      amountIn,
      amountOutMinimum: minimumOut,
      postAmount0: amount0Available - amountIn,
      postAmount1: amount1Available + minimumOut,
      direction: 'token0_to_token1',
    };
  }

  const valueToSwap = value1 - (totalValue - targetValue0);
  const amountIn = ethers.parseUnits(String(valueToSwap.toFixed(6)), ctx.token1.decimals);
  if (amountIn <= 0n) return null;
  const expectedToken0 = ethers.parseUnits(String((valueToSwap / price).toFixed(8)), ctx.token0.decimals);
  const minimumToken0 = amountOutMin(expectedToken0, slippageBps);
  return {
    tokenIn: ctx.token1,
    tokenOut: ctx.token0,
    amountIn,
    amountOutMinimum: minimumToken0,
    postAmount0: amount0Available + minimumToken0,
    postAmount1: amount1Available - amountIn,
    direction: 'token1_to_token0',
  };
}

async function prepareRebalance(payload) {
  const ctx = await loadV3PositionContext(payload);
  const lowerPrice = Number(payload.rangeLowerPrice || uniswapService.tickToPrice(Number(ctx.position.tickLower), ctx.token0.decimals, ctx.token1.decimals));
  const upperPrice = Number(payload.rangeUpperPrice || uniswapService.tickToPrice(Number(ctx.position.tickUpper), ctx.token0.decimals, ctx.token1.decimals));
  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  const amount0Available = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current') + BigInt(ctx.position.tokensOwed0);
  const amount1Available = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current') + BigInt(ctx.position.tokensOwed1);
  const swap = buildRebalanceSwap(ctx, {
    amount0Available,
    amount1Available,
    targetWeightToken0Pct: payload.targetWeightToken0Pct,
    slippageBps: payload.slippageBps,
  });

  const txPlan = [
    buildV3DecreaseTx(ctx, { liquidityDelta: BigInt(ctx.position.liquidity), slippageBps: payload.slippageBps }),
    ...(await prepareCollectFees(payload)).txPlan,
  ];
  const requiresApproval = [];

  if (swap?.amountIn > 0n) {
    requiresApproval.push(buildApprovalRequirement(swap.tokenIn, V3_SWAP_ROUTER_ADDRESS, swap.amountIn));
    txPlan.push(maybeBuildApprovalTx(swap.tokenIn, V3_SWAP_ROUTER_ADDRESS, swap.amountIn, ctx.networkConfig.chainId));
    txPlan.push(buildV3SwapTx(ctx, swap));
  }

  const finalAmount0 = swap?.postAmount0 ?? amount0Available;
  const finalAmount1 = swap?.postAmount1 ?? amount1Available;
  if (finalAmount0 > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token0, ctx.positionManagerAddress, finalAmount0));
    txPlan.push(maybeBuildApprovalTx(ctx.token0, ctx.positionManagerAddress, finalAmount0, ctx.networkConfig.chainId));
  }
  if (finalAmount1 > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token1, ctx.positionManagerAddress, finalAmount1));
    txPlan.push(maybeBuildApprovalTx(ctx.token1, ctx.positionManagerAddress, finalAmount1, ctx.networkConfig.chainId));
  }
  txPlan.push(buildV3MintTx(ctx, {
    tickLower,
    tickUpper,
    amount0Desired: finalAmount0,
    amount1Desired: finalAmount1,
    slippageBps: payload.slippageBps,
    recipient: ctx.normalizedWallet,
  }));

  return {
    action: 'rebalance',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      targetWeightToken0Pct: Number(payload.targetWeightToken0Pct),
      swap: swap ? {
        direction: swap.direction,
        amountIn: ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals),
        tokenIn: swap.tokenIn.symbol,
        tokenOut: swap.tokenOut.symbol,
        minAmountOut: ethers.formatUnits(swap.amountOutMinimum, swap.tokenOut.decimals),
      } : null,
      newRange: {
        tickLower,
        tickUpper,
        rangeLowerPrice: lowerPrice,
        rangeUpperPrice: upperPrice,
      },
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v3',
      tickLower,
      tickUpper,
      amount0Desired: finalAmount0,
      amount1Desired: finalAmount1,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId, 'new_position_pending'),
  };
}

async function prepareCloseKeepAssets(payload) {
  const ctx = await loadV3PositionContext(payload);
  const positionLiquidity = BigInt(ctx.position.liquidity);
  const tokensOwed0 = BigInt(ctx.position.tokensOwed0);
  const tokensOwed1 = BigInt(ctx.position.tokensOwed1);
  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');
  const amount0Expected = amount0Current + tokensOwed0;
  const amount1Expected = amount1Current + tokensOwed1;

  if (positionLiquidity <= 0n && amount0Expected <= 0n && amount1Expected <= 0n) {
    throw new ValidationError('La posición no tiene liquidez ni fondos pendientes por retirar');
  }

  const txPlan = [];
  if (positionLiquidity > 0n) {
    txPlan.push(buildV3DecreaseTx(ctx, { liquidityDelta: positionLiquidity, slippageBps: payload.slippageBps }));
  }
  txPlan.push(...(await prepareCollectFees(payload)).txPlan);

  return {
    action: 'close-keep-assets',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      closeMode: 'keep_assets',
      token0: ctx.token0,
      token1: ctx.token1,
      expectedReceipts: {
        amount0: ethers.formatUnits(amount0Expected, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Expected, ctx.token1.decimals),
      },
      receivesDirectlyInWallet: true,
      txCount: txPlan.filter(Boolean).length,
    },
    requiresApproval: [],
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildClosedPositionPreview(ctx.networkConfig.id, 'v3', ctx.token0, ctx.token1, {
      expectedWalletReceipts: {
        amount0: ethers.formatUnits(amount0Expected, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Expected, ctx.token1.decimals),
      },
    }),
    protectionImpact: {
      ...buildProtectionImpact(ctx.tokenId),
      willDeactivateProtection: true,
    },
  };
}

async function prepareCloseToUsdc(payload) {
  const ctx = await loadV3PositionContext(payload);
  const usdc = getCanonicalUsdcTokenForNetwork(ctx.networkConfig.id);
  const wrappedNative = getWrappedNativeTokenForNetwork(ctx.networkConfig.id);
  const reserveRaw = getGasReserveRaw(ctx.networkConfig.id);
  const nativeBalanceRaw = await ctx.provider.getBalance(ctx.normalizedWallet).catch(() => 0n);
  const positionLiquidity = BigInt(ctx.position.liquidity);
  const tokensOwed0 = BigInt(ctx.position.tokensOwed0);
  const tokensOwed1 = BigInt(ctx.position.tokensOwed1);
  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');
  const estimatedAmount0 = amount0Current + tokensOwed0;
  const estimatedAmount1 = amount1Current + tokensOwed1;

  if (positionLiquidity <= 0n && estimatedAmount0 <= 0n && estimatedAmount1 <= 0n) {
    throw new ValidationError('La posición no tiene liquidez ni fondos pendientes por retirar');
  }

  const txPlan = [];
  if (positionLiquidity > 0n) {
    txPlan.push(buildV3DecreaseTx(ctx, { liquidityDelta: positionLiquidity, slippageBps: payload.slippageBps }));
  }
  txPlan.push(...(await prepareCollectFees(payload)).txPlan);

  const requiresApproval = [];
  const warnings = [];
  const expectedReceipts = [];
  const swapPlan = [];
  let expectedUsdcRaw = 0n;

  let token0SwapAmount = estimatedAmount0;
  let token1SwapAmount = estimatedAmount1;
  const reserveDeficitRaw = nativeBalanceRaw >= reserveRaw ? 0n : reserveRaw - nativeBalanceRaw;
  let unwrapAmountRaw = 0n;
  let unwrapToken = null;

  if (reserveDeficitRaw > 0n) {
    if (wrappedNative && ctx.token0.address.toLowerCase() === wrappedNative.address.toLowerCase() && token0SwapAmount > 0n) {
      unwrapAmountRaw = reserveDeficitRaw > token0SwapAmount ? token0SwapAmount : reserveDeficitRaw;
      token0SwapAmount -= unwrapAmountRaw;
      unwrapToken = ctx.token0;
    } else if (wrappedNative && ctx.token1.address.toLowerCase() === wrappedNative.address.toLowerCase() && token1SwapAmount > 0n) {
      unwrapAmountRaw = reserveDeficitRaw > token1SwapAmount ? token1SwapAmount : reserveDeficitRaw;
      token1SwapAmount -= unwrapAmountRaw;
      unwrapToken = ctx.token1;
    }

    if (unwrapAmountRaw > 0n && unwrapToken) {
      txPlan.push(buildUnwrapNativeTx(unwrapToken, unwrapAmountRaw, ctx.networkConfig.chainId));
    }

    const remainingDeficit = reserveDeficitRaw > unwrapAmountRaw ? reserveDeficitRaw - unwrapAmountRaw : 0n;
    if (remainingDeficit > 0n) {
      throw new ValidationError(`No hay ${ctx.networkConfig.nativeSymbol} suficiente para conservar la reserva de gas requerida.`);
    }
  }

  const assetsToConvert = [
    { token: ctx.token0, estimatedAmount: token0SwapAmount },
    { token: ctx.token1, estimatedAmount: token1SwapAmount },
  ];

  for (const entry of assetsToConvert) {
    if (entry.estimatedAmount <= 0n) continue;
    if (entry.token.address.toLowerCase() === usdc.address.toLowerCase()) {
      expectedUsdcRaw += entry.estimatedAmount;
      expectedReceipts.push({
        symbol: entry.token.symbol,
        amount: ethers.formatUnits(entry.estimatedAmount, entry.token.decimals),
        conversion: 'direct_usdc',
      });
      continue;
    }

    const amountIn = applyCloseBuffer(entry.estimatedAmount);
    const swap = await appendV3SwapToToken({
      provider: ctx.provider,
      networkConfig: ctx.networkConfig,
      normalizedWallet: ctx.normalizedWallet,
      tokenIn: entry.token,
      tokenOut: usdc,
      amountIn,
      slippageBps: payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      txPlan,
      requiresApproval,
    });
    expectedUsdcRaw += swap.amountOutMinimum;
    swapPlan.push({
      tokenIn: entry.token.symbol,
      tokenOut: usdc.symbol,
      amountIn: ethers.formatUnits(amountIn, entry.token.decimals),
      minAmountOut: ethers.formatUnits(swap.amountOutMinimum, usdc.decimals),
      routePoolAddress: swap.routePoolAddress,
    });
    expectedReceipts.push({
      symbol: entry.token.symbol,
      amount: ethers.formatUnits(entry.estimatedAmount, entry.token.decimals),
      conversion: 'swap_to_usdc',
    });
    if (amountIn < entry.estimatedAmount) {
      warnings.push(`Se deja un pequeño remanente de ${entry.token.symbol} para evitar fallos por estimación.`);
    }
  }

  return {
    action: 'close-to-usdc',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      closeMode: 'to_usdc',
      targetStableSymbol: usdc.symbol,
      token0: ctx.token0,
      token1: ctx.token1,
      expectedReceipts,
      expectedUsdcOut: ethers.formatUnits(expectedUsdcRaw, usdc.decimals),
      gasReserve: {
        symbol: ctx.networkConfig.nativeSymbol,
        reservedAmount: ethers.formatUnits(reserveRaw, 18),
        nativeBalance: ethers.formatUnits(nativeBalanceRaw, 18),
      },
      unwrapNative: unwrapAmountRaw > 0n ? {
        tokenSymbol: unwrapToken?.symbol || wrappedNative?.symbol || 'WRAPPED_NATIVE',
        amount: ethers.formatUnits(unwrapAmountRaw, unwrapToken?.decimals || 18),
      } : null,
      swapPlan,
      txCount: txPlan.filter(Boolean).length,
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    warnings,
    postActionPositionPreview: buildClosedPositionPreview(ctx.networkConfig.id, 'v3', ctx.token0, ctx.token1, {
      targetStableSymbol: usdc.symbol,
      expectedUsdcOut: ethers.formatUnits(expectedUsdcRaw, usdc.decimals),
      reservedNative: ethers.formatUnits(reserveRaw, 18),
    }),
    protectionImpact: {
      ...buildProtectionImpact(ctx.tokenId),
      willDeactivateProtection: true,
    },
  };
}

async function prepareCreatePosition(payload) {
  const usingSmartFunding = payload.totalUsdTarget != null
    || Array.isArray(payload.fundingSelections)
    || Array.isArray(payload.importTokenAddresses);
  if (usingSmartFunding) {
    const plan = await smartPoolCreatorService.buildFundingPlan({
      network: payload.network,
      version: 'v3',
      walletAddress: payload.walletAddress,
      token0Address: payload.token0Address,
      token1Address: payload.token1Address,
      fee: payload.fee,
      totalUsdTarget: Number(payload.totalUsdTarget),
      targetWeightToken0Pct: Number(payload.targetWeightToken0Pct),
      rangeLowerPrice: Number(payload.rangeLowerPrice),
      rangeUpperPrice: Number(payload.rangeUpperPrice),
      fundingSelections: payload.fundingSelections,
      importTokenAddresses: payload.importTokenAddresses || [],
      maxSlippageBps: payload.maxSlippageBps ?? payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    });
    const networkConfig = getNetworkConfig(payload.network);
    const provider = getProvider(networkConfig);
    const normalizedWallet = normalizeAddress(payload.walletAddress, 'walletAddress');
    const canonicalPlan = normalizeCreatePositionPoolOrder({
      token0: plan.token0,
      token1: plan.token1,
      amount0Desired: BigInt(plan.expectedPostSwapBalances.amount0Raw),
      amount1Desired: BigInt(plan.expectedPostSwapBalances.amount1Raw),
      rangeLowerPrice: payload.rangeLowerPrice,
      rangeUpperPrice: payload.rangeUpperPrice,
      poolToken0Address: plan.poolToken0Address || plan.token0.address,
      poolToken1Address: plan.poolToken1Address || plan.token1.address,
    });
    const token0 = canonicalPlan.token0;
    const token1 = canonicalPlan.token1;
    const amount0Desired = canonicalPlan.amount0Desired;
    const amount1Desired = canonicalPlan.amount1Desired;
    const tickLower = priceToNearestTick(canonicalPlan.rangeLowerPrice, token0.decimals, token1.decimals, Number(plan.tickSpacing), 'down');
    const tickUpper = priceToNearestTick(canonicalPlan.rangeUpperPrice, token0.decimals, token1.decimals, Number(plan.tickSpacing), 'up');
    if (tickLower >= tickUpper) throw new ValidationError('El rango nuevo es invalido');

    const pmAddress = normalizeAddress(networkConfig.deployments.v3.positionManager);
    const [token0State, token1State] = await Promise.all([
      getBalanceAndAllowance(provider, token0, normalizedWallet, pmAddress),
      getBalanceAndAllowance(provider, token1, normalizedWallet, pmAddress),
    ]);
    const dummyCtx = {
      networkConfig,
      normalizedWallet,
      positionManagerAddress: pmAddress,
      fee: Number(payload.fee),
      token0,
      token1,
    };
    const txPlan = [];
    const requiresApproval = [];
    const allowanceCache = new Map();

    // Seed cache with already-fetched allowances
    allowanceCache.set(`${token0.address}:${pmAddress}`, { ...token0State });
    allowanceCache.set(`${token1.address}:${pmAddress}`, { ...token1State });

    // Combine ALL native wraps (direct deposits + swap sources) into a single wrap tx
    let totalNativeWrapRaw = 0n;
    for (const asset of (plan.selectedFundingAssets || [])) {
      if (asset.isNative && (asset.fundingRole === 'direct_token0' || asset.fundingRole === 'direct_token1')) {
        totalNativeWrapRaw += BigInt(asset.useAmountRaw || 0);
      }
    }
    for (const swap of (plan.swapPlan || [])) {
      if (swap.requiresWrapNative) {
        totalNativeWrapRaw += BigInt(swap.amountInRaw || 0);
      }
    }
    if (totalNativeWrapRaw > 0n) {
      const wrapToken = token0.address.toLowerCase() === plan.wrappedNativeAddress?.toLowerCase()
        ? token0
        : token1.address.toLowerCase() === plan.wrappedNativeAddress?.toLowerCase()
          ? token1
          : token0;
      txPlan.push(buildWrapNativeTx(wrapToken, totalNativeWrapRaw, networkConfig.chainId));
    }

    // Strip individual wraps from swapPlan since we already wrapped everything above
    const swapPlanNoWraps = (plan.swapPlan || []).map((s) => ({ ...s, requiresWrapNative: false }));
    await appendFundingSwapTransactions({
      provider,
      networkConfig,
      normalizedWallet,
      swapPlan: swapPlanNoWraps,
      requiresApproval,
      txPlan,
      allowanceCache,
    });

    // After swaps, check PM approvals — but skip if already approved with MaxUint256 for swap router
    // (the swap approval set allowance to MaxUint256 which covers PM too if same token)
    const token0PmKey = `${token0.address}:${pmAddress}`;
    const token1PmKey = `${token1.address}:${pmAddress}`;
    const token0PmState = allowanceCache.get(token0PmKey) || token0State;
    const token1PmState = allowanceCache.get(token1PmKey) || token1State;

    // Need approval if: current on-chain allowance is insufficient AND we didn't already approve
    // via swap router (which wouldn't help PM since it's a different spender)
    const token0NeedsApproval = token0PmState.allowance < amount0Desired;
    const token1NeedsApproval = token1PmState.allowance < amount1Desired;

    if (token0NeedsApproval) {
      requiresApproval.push(buildApprovalRequirement(token0, pmAddress, amount0Desired));
      txPlan.push(maybeBuildApprovalTx(token0, pmAddress, amount0Desired, networkConfig.chainId));
    }
    if (token1NeedsApproval) {
      requiresApproval.push(buildApprovalRequirement(token1, pmAddress, amount1Desired));
      txPlan.push(maybeBuildApprovalTx(token1, pmAddress, amount1Desired, networkConfig.chainId));
    }
    const mintSlippageBps = payload.maxSlippageBps ?? payload.slippageBps;

    // expectedPostSwapBalances now uses amountOutMinimumRaw (guaranteed swap output),
    // so amount0Desired/amount1Desired are conservative — the wallet will always have
    // at least this much. No additional buffer needed. amount0Min/amount1Min = 0
    // for safety; gas is estimated client-side at signing time using the fresh state
    // after the prior wraps/swaps/approvals are confirmed.
    logger.info('create_position_mint_params', {
      network: networkConfig.id,
      chainId: networkConfig.chainId,
      pmAddress,
      token0: { address: token0.address, symbol: token0.symbol, decimals: token0.decimals },
      token1: { address: token1.address, symbol: token1.symbol, decimals: token1.decimals },
      tickLower,
      tickUpper,
      amount0Desired: amount0Desired.toString(),
      amount1Desired: amount1Desired.toString(),
      amount0DesiredFormatted: ethers.formatUnits(amount0Desired, token0.decimals),
      amount1DesiredFormatted: ethers.formatUnits(amount1Desired, token1.decimals),
      amount0Min: '0',
      amount1Min: '0',
      mintSlippageBps,
      fee: Number(payload.fee),
      recipient: normalizedWallet,
    });
    txPlan.push(buildV3MintTx(dummyCtx, {
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: normalizedWallet,
    }));

    return {
      action: 'create-position',
      network: networkConfig.id,
      version: 'v3',
      positionIdentifier: null,
      walletAddress: normalizedWallet,
      quoteSummary: {
        token0,
        token1,
        fee: Number(payload.fee),
        poolAddress: plan.poolAddress,
        amount0Desired: ethers.formatUnits(amount0Desired, token0.decimals),
        amount1Desired: ethers.formatUnits(amount1Desired, token1.decimals),
        currentPrice: plan.currentPrice,
        rangeLowerPrice: Number(payload.rangeLowerPrice),
        rangeUpperPrice: Number(payload.rangeUpperPrice),
        gasReserve: plan.gasReserve,
        fundingPlan: plan.fundingPlan,
        swapCount: plan.swapPlan.length,
      },
      requiresApproval,
      txPlan: txPlan.filter(Boolean),
      fundingPlan: {
        ...plan.fundingPlan,
        gasReserve: plan.gasReserve,
        selectedFundingAssets: plan.selectedFundingAssets,
      },
      swapPlan: plan.swapPlan,
      warnings: plan.warnings,
      postActionPositionPreview: buildPostPreview({
        network: networkConfig.id,
        version: 'v3',
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        token0,
        token1,
        priceCurrent: plan.currentPrice,
      }),
      protectionImpact: buildProtectionImpact(null, 'new_position_pending'),
    };
  }

  const networkConfig = getNetworkConfig(payload.network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(payload.walletAddress, 'walletAddress');
  const token0 = await getTokenInfo(provider, payload.token0Address);
  const token1 = await getTokenInfo(provider, payload.token1Address);
  const fee = Number(payload.fee);
  if (!Number.isInteger(fee) || fee <= 0) {
    throw new ValidationError('fee invalido');
  }

  const factory = new ethers.Contract(normalizeAddress(networkConfig.deployments.v3.eventSource), V3_FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(token0.address, token1.address, fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new ValidationError('Solo se soporta crear posicion sobre pools existentes');
  }

  const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
  const [tickSpacing, slot0, poolToken0Address, poolToken1Address] = await Promise.all([
    pool.tickSpacing(),
    pool.slot0(),
    pool.token0(),
    pool.token1(),
  ]);
  const canonicalPlan = normalizeCreatePositionPoolOrder({
    token0,
    token1,
    amount0Desired: toBigIntAmount(payload.amount0Desired, token0.decimals, 'amount0Desired'),
    amount1Desired: toBigIntAmount(payload.amount1Desired, token1.decimals, 'amount1Desired'),
    rangeLowerPrice: payload.rangeLowerPrice,
    rangeUpperPrice: payload.rangeUpperPrice,
    poolToken0Address,
    poolToken1Address,
  });
  const canonicalToken0 = canonicalPlan.token0;
  const canonicalToken1 = canonicalPlan.token1;
  const amount0Desired = canonicalPlan.amount0Desired;
  const amount1Desired = canonicalPlan.amount1Desired;
  const pmAddress = normalizeAddress(networkConfig.deployments.v3.positionManager);
  const [token0State, token1State] = await Promise.all([
    getBalanceAndAllowance(provider, canonicalToken0, normalizedWallet, pmAddress),
    getBalanceAndAllowance(provider, canonicalToken1, normalizedWallet, pmAddress),
  ]);
  if (token0State.balance < amount0Desired || token1State.balance < amount1Desired) {
    throw new ValidationError('La wallet no tiene balance suficiente para crear la posicion');
  }

  const tickLower = priceToNearestTick(canonicalPlan.rangeLowerPrice, canonicalToken0.decimals, canonicalToken1.decimals, Number(tickSpacing), 'down');
  const tickUpper = priceToNearestTick(canonicalPlan.rangeUpperPrice, canonicalToken0.decimals, canonicalToken1.decimals, Number(tickSpacing), 'up');
  if (tickLower >= tickUpper) throw new ValidationError('El rango nuevo es invalido');

  const dummyCtx = {
    networkConfig,
    positionManagerAddress: pmAddress,
    fee,
    token0: canonicalToken0,
    token1: canonicalToken1,
  };
  const txPlan = [];
  const requiresApproval = [];
  if (token0State.allowance < amount0Desired) {
    requiresApproval.push(buildApprovalRequirement(canonicalToken0, pmAddress, amount0Desired));
    txPlan.push(maybeBuildApprovalTx(canonicalToken0, pmAddress, amount0Desired, networkConfig.chainId));
  }
  if (token1State.allowance < amount1Desired) {
    requiresApproval.push(buildApprovalRequirement(canonicalToken1, pmAddress, amount1Desired));
    txPlan.push(maybeBuildApprovalTx(canonicalToken1, pmAddress, amount1Desired, networkConfig.chainId));
  }
  txPlan.push(buildV3MintTx(dummyCtx, {
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    slippageBps: payload.slippageBps,
    recipient: normalizedWallet,
  }));

  return {
    action: 'create-position',
    network: networkConfig.id,
    version: 'v3',
    positionIdentifier: null,
    walletAddress: normalizedWallet,
    quoteSummary: {
      token0: canonicalToken0,
      token1: canonicalToken1,
      fee,
      poolAddress: normalizeAddress(poolAddress),
      amount0Desired: ethers.formatUnits(amount0Desired, canonicalToken0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, canonicalToken1.decimals),
      currentPrice: smartPoolCreatorService.orientPriceToSelectedOrder(
        uniswapService.tickToPrice(Number(slot0.tick), canonicalToken0.decimals, canonicalToken1.decimals),
        canonicalPlan.reversed
      ),
      rangeLowerPrice: Number(payload.rangeLowerPrice),
      rangeUpperPrice: Number(payload.rangeUpperPrice),
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: networkConfig.id,
      version: 'v3',
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      token0: canonicalToken0,
      token1: canonicalToken1,
      priceCurrent: uniswapService.tickToPrice(Number(slot0.tick), canonicalToken0.decimals, canonicalToken1.decimals),
    }),
    protectionImpact: buildProtectionImpact(null, 'new_position_pending'),
  };
}

async function prepareIncreaseLiquidityV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const amount0Desired = toBigIntAmount(payload.amount0Desired, ctx.token0.decimals, 'amount0Desired');
  const amount1Desired = toBigIntAmount(payload.amount1Desired, ctx.token1.decimals, 'amount1Desired');
  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: amount0Desired,
    amount1Raw: amount1Desired,
    tickCurrent: ctx.currentTick,
    tickLower: ctx.tickLower,
    tickUpper: ctx.tickUpper,
  });

  const requiresApproval = [];
  const txPlan = [];
  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token0,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: amount0Desired,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });
  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token1,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: amount1Desired,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });

  txPlan.push(buildV4ModifyTx(ctx, {
    actionCodes: [
      V4_ACTIONS.INCREASE_LIQUIDITY,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4ModifyLiquidityParams({
        tokenId: ctx.tokenId,
        liquidity: liquidityDelta,
        amount0Limit: amount0Desired,
        amount1Limit: amount1Desired,
      }),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
    ],
    label: 'Increase liquidity (v4)',
    kind: 'increase_liquidity_v4',
    meta: {
      v4Actions: ['INCREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
    },
  }));

  return {
    action: 'increase-liquidity',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      amount0Desired: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      liquidityDelta: liquidityDelta.toString(),
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: ['INCREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v4',
      positionIdentifier: ctx.tokenId,
      tickLower: ctx.tickLower,
      tickUpper: ctx.tickUpper,
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareDecreaseLiquidityV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const percent = Number(payload.liquidityPercent ?? 100);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new ValidationError('liquidityPercent debe estar entre 0 y 100');
  }
  const liquidityDelta = (ctx.positionLiquidity * BigInt(Math.round(percent * 100))) / 10_000n;
  if (liquidityDelta <= 0n) {
    throw new ValidationError('La liquidez a retirar es demasiado pequena');
  }

  return {
    action: 'decrease-liquidity',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      liquidityPercent: percent,
      estimatedCurrentAmounts: ctx.currentAmounts,
      currentLiquidity: ctx.positionLiquidity.toString(),
      liquidityDelta: liquidityDelta.toString(),
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval: [],
    txPlan: [
      buildV4ModifyTx(ctx, {
        actionCodes: [
          V4_ACTIONS.DECREASE_LIQUIDITY,
          V4_ACTIONS.CLOSE_CURRENCY,
          V4_ACTIONS.CLOSE_CURRENCY,
        ],
        params: [
          encodeV4ModifyLiquidityParams({
            tokenId: ctx.tokenId,
            liquidity: liquidityDelta,
            amount0Limit: 0n,
            amount1Limit: 0n,
          }),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
        ],
        label: 'Decrease liquidity (v4)',
        kind: 'decrease_liquidity_v4',
        meta: {
          v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
          poolId: ctx.poolId,
          tickSpacing: ctx.tickSpacing,
          hooks: ctx.poolKey.hooks,
        },
      }),
    ],
    postActionPositionPreview: {
      network: ctx.networkConfig.id,
      version: 'v4',
      positionIdentifier: ctx.tokenId,
      estimatedRemainingLiquidity: (ctx.positionLiquidity - liquidityDelta).toString(),
      poolId: ctx.poolId,
    },
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareReinvestFeesV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const amount0Fees = BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Fees = BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);
  if (amount0Fees <= 0n && amount1Fees <= 0n) {
    throw new ValidationError('No hay fees pendientes para reinvertir');
  }

  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: amount0Fees,
    amount1Raw: amount1Fees,
    tickCurrent: ctx.currentTick,
    tickLower: ctx.tickLower,
    tickUpper: ctx.tickUpper,
  });

  return {
    action: 'reinvest-fees',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      feesToReinvest: {
        amount0: ethers.formatUnits(amount0Fees, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Fees, ctx.token1.decimals),
      },
      liquidityDelta: liquidityDelta.toString(),
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: ['DECREASE_LIQUIDITY', 'INCREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval: [],
    txPlan: [
      buildV4ModifyTx(ctx, {
        actionCodes: [
          V4_ACTIONS.DECREASE_LIQUIDITY,
          V4_ACTIONS.INCREASE_LIQUIDITY,
          V4_ACTIONS.CLOSE_CURRENCY,
          V4_ACTIONS.CLOSE_CURRENCY,
        ],
        params: [
          encodeV4ModifyLiquidityParams({
            tokenId: ctx.tokenId,
            liquidity: 0n,
            amount0Limit: 0n,
            amount1Limit: 0n,
          }),
          encodeV4ModifyLiquidityParams({
            tokenId: ctx.tokenId,
            liquidity: liquidityDelta,
            amount0Limit: amount0Fees,
            amount1Limit: amount1Fees,
          }),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
        ],
        label: 'Reinvest fees (v4)',
        kind: 'reinvest_fees_v4',
        meta: {
          v4Actions: ['DECREASE_LIQUIDITY', 'INCREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
          poolId: ctx.poolId,
          tickSpacing: ctx.tickSpacing,
          hooks: ctx.poolKey.hooks,
        },
      }),
    ],
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v4',
      positionIdentifier: ctx.tokenId,
      tickLower: ctx.tickLower,
      tickUpper: ctx.tickUpper,
      amount0Desired: amount0Fees,
      amount1Desired: amount1Fees,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareModifyRangeV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const lowerPrice = Number(payload.rangeLowerPrice);
  const upperPrice = Number(payload.rangeUpperPrice);
  if (!Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice) || lowerPrice <= 0 || upperPrice <= lowerPrice) {
    throw new ValidationError('El rango nuevo es invalido');
  }

  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');
  const amount0Available = amount0Current + BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Available = amount1Current + BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);
  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  if (tickLower >= tickUpper) {
    throw new ValidationError('El rango nuevo genera ticks invalidos');
  }

  const {
    optimalWeight,
    swap,
    amount0Desired: redeployAmount0,
    amount1Desired: redeployAmount1,
  } = buildModifyRangeRedeployPlan(ctx, {
    amount0Available,
    amount1Available,
    lowerPrice,
    upperPrice,
    slippageBps: payload.slippageBps,
  });
  const txPlan = [
    buildV4ModifyTx(ctx, {
      actionCodes: [
        V4_ACTIONS.DECREASE_LIQUIDITY,
        V4_ACTIONS.CLOSE_CURRENCY,
        V4_ACTIONS.CLOSE_CURRENCY,
      ],
      params: [
        encodeV4ModifyLiquidityParams({
          tokenId: ctx.tokenId,
          liquidity: ctx.positionLiquidity,
          amount0Limit: 0n,
          amount1Limit: 0n,
        }),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
      ],
      label: 'Withdraw current v4 position',
      kind: 'decrease_liquidity_v4',
      meta: {
        v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
        poolId: ctx.poolId,
        tickSpacing: ctx.tickSpacing,
        hooks: ctx.poolKey.hooks,
      },
    }),
  ];
  const requiresApproval = [];

  let amount0Desired = redeployAmount0;
  let amount1Desired = redeployAmount1;
  if (swap?.amountIn > 0n) {
    await appendPermit2Approvals({
      provider: ctx.provider,
      token: swap.tokenIn,
      walletAddress: ctx.normalizedWallet,
      spender: ctx.universalRouterAddress,
      amount: swap.amountIn,
      chainId: ctx.networkConfig.chainId,
      requiresApproval,
      txPlan,
    });
    txPlan.push(buildV4RouterTx(ctx, {
      actionCodes: [
        V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
        V4_ACTIONS.SETTLE_ALL,
        V4_ACTIONS.TAKE_ALL,
      ],
      params: [
        encodeV4SwapExactInSingleParams({
          poolKey: ctx.poolKey,
          zeroForOne: swap.direction === 'token0_to_token1',
          amountIn: swap.amountIn,
          amountOutMinimum: swap.amountOutMinimum,
        }),
        encodeV4SettleAllParams(swap.tokenIn.address, MAX_UINT256),
        encodeV4TakeAllParams(swap.tokenOut.address, swap.amountOutMinimum),
      ],
      label: `Swap ${swap.tokenIn.symbol} -> ${swap.tokenOut.symbol} (v4)`,
      kind: 'swap_v4',
      meta: {
        v4Actions: ['SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL'],
        routerAddress: ctx.universalRouterAddress,
        poolId: ctx.poolId,
      },
    }));
  }

  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token0,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: amount0Desired,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });
  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token1,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: amount1Desired,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });

  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: amount0Desired,
    amount1Raw: amount1Desired,
    tickCurrent: ctx.currentTick,
    tickLower,
    tickUpper,
  });

  txPlan.push(buildV4ModifyTx(ctx, {
    actionCodes: [
      V4_ACTIONS.MINT_POSITION,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4MintParams({
        poolKey: ctx.poolKey,
        tickLower,
        tickUpper,
        liquidity: liquidityDelta,
        amount0Max: amount0Desired,
        amount1Max: amount1Desired,
        owner: ctx.normalizedWallet,
      }),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
    ],
    label: 'Mint rebalanced v4 position',
    kind: 'mint_position_v4',
    meta: {
      v4Actions: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      createsNewPosition: true,
    },
  }));

  const slippageCostUsd = estimateSwapValueUsd(ctx, swap) * (Number(payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10_000);
  const estimatedCosts = await buildEstimatedCosts(ctx, txPlan, { slippageCostUsd });

  return {
    action: 'modify-range',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      oldRange: {
        tickLower: ctx.tickLower,
        tickUpper: ctx.tickUpper,
      },
      newRange: {
        tickLower,
        tickUpper,
        rangeLowerPrice: lowerPrice,
        rangeUpperPrice: upperPrice,
      },
      optimalWeightToken0Pct: Number(optimalWeight.toFixed(2)),
      swap: swap ? {
        direction: swap.direction,
        amountIn: ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals),
        tokenIn: swap.tokenIn.symbol,
        tokenOut: swap.tokenOut.symbol,
        minAmountOut: ethers.formatUnits(swap.amountOutMinimum, swap.tokenOut.decimals),
      } : null,
      expectedRedeployAmounts: {
        amount0: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      },
      estimatedCosts,
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: swap
        ? ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL', 'MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY']
        : ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v4',
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId, 'new_position_pending'),
  };
}

async function prepareCreatePositionV4(payload) {
  const usingSmartFunding = payload.totalUsdTarget != null
    || Array.isArray(payload.fundingSelections)
    || Array.isArray(payload.importTokenAddresses);
  if (usingSmartFunding) {
    const plan = await smartPoolCreatorService.buildFundingPlan({
      network: payload.network,
      version: 'v4',
      walletAddress: payload.walletAddress,
      token0Address: payload.token0Address,
      token1Address: payload.token1Address,
      fee: payload.fee,
      totalUsdTarget: Number(payload.totalUsdTarget),
      targetWeightToken0Pct: Number(payload.targetWeightToken0Pct),
      rangeLowerPrice: Number(payload.rangeLowerPrice),
      rangeUpperPrice: Number(payload.rangeUpperPrice),
      fundingSelections: payload.fundingSelections,
      importTokenAddresses: payload.importTokenAddresses || [],
      maxSlippageBps: payload.maxSlippageBps ?? payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      tickSpacing: payload.tickSpacing,
      hooks: payload.hooks,
      poolId: payload.poolId,
    });
    const networkConfig = getNetworkConfig(payload.network);
    const provider = getProvider(networkConfig);
    const normalizedWallet = normalizeAddress(payload.walletAddress, 'walletAddress');
    const canonicalPlan = normalizeCreatePositionPoolOrder({
      token0: plan.token0,
      token1: plan.token1,
      amount0Desired: BigInt(plan.expectedPostSwapBalances.amount0Raw),
      amount1Desired: BigInt(plan.expectedPostSwapBalances.amount1Raw),
      rangeLowerPrice: payload.rangeLowerPrice,
      rangeUpperPrice: payload.rangeUpperPrice,
      poolToken0Address: plan.poolToken0Address || plan.token0.address,
      poolToken1Address: plan.poolToken1Address || plan.token1.address,
    });
    const token0 = canonicalPlan.token0;
    const token1 = canonicalPlan.token1;
    const amount0Desired = canonicalPlan.amount0Desired;
    const amount1Desired = canonicalPlan.amount1Desired;
    const tickLower = priceToNearestTick(canonicalPlan.rangeLowerPrice, token0.decimals, token1.decimals, Number(plan.tickSpacing), 'down');
    const tickUpper = priceToNearestTick(canonicalPlan.rangeUpperPrice, token0.decimals, token1.decimals, Number(plan.tickSpacing), 'up');
    if (tickLower >= tickUpper) throw new ValidationError('El rango nuevo es invalido');
    const canonicalCurrentPrice = canonicalPlan.reversed ? (1 / Number(plan.currentPrice)) : Number(plan.currentPrice);
    const liquidityDelta = estimateLiquidityForAmounts({
      amount0Raw: amount0Desired,
      amount1Raw: amount1Desired,
      tickCurrent: Math.round(Math.log(canonicalCurrentPrice / (10 ** (token0.decimals - token1.decimals))) / Math.log(1.0001)),
      tickLower,
      tickUpper,
    });
    const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager);
    const requiresApproval = [];
    const txPlan = [];
    await appendFundingSwapTransactions({
      provider,
      networkConfig,
      normalizedWallet,
      swapPlan: plan.swapPlan,
      requiresApproval,
      txPlan,
    });
    await appendPermit2Approvals({
      provider,
      token: token0,
      walletAddress: normalizedWallet,
      spender: positionManagerAddress,
      amount: amount0Desired,
      chainId: networkConfig.chainId,
      requiresApproval,
      txPlan,
      enforceBalance: false,
    });
    await appendPermit2Approvals({
      provider,
      token: token1,
      walletAddress: normalizedWallet,
      spender: positionManagerAddress,
      amount: amount1Desired,
      chainId: networkConfig.chainId,
      requiresApproval,
      txPlan,
      enforceBalance: false,
    });

    const dummyCtx = {
      networkConfig,
      normalizedWallet,
      positionManagerAddress,
      poolKey: {
        currency0: token0.address,
        currency1: token1.address,
        fee: Number(payload.fee),
        tickSpacing: Number(plan.tickSpacing),
        hooks: normalizeHooksAddress(plan.hooks),
      },
      poolId: plan.poolId,
      tickSpacing: Number(plan.tickSpacing),
    };
    txPlan.push(buildV4ModifyTx(dummyCtx, {
      actionCodes: [
        V4_ACTIONS.MINT_POSITION,
        V4_ACTIONS.CLOSE_CURRENCY,
        V4_ACTIONS.CLOSE_CURRENCY,
      ],
      params: [
        encodeV4MintParams({
          poolKey: dummyCtx.poolKey,
          tickLower,
          tickUpper,
          liquidity: liquidityDelta,
          amount0Max: amount0Desired,
          amount1Max: amount1Desired,
          owner: normalizedWallet,
        }),
        encodeV4CloseCurrencyParams(dummyCtx.poolKey.currency0),
        encodeV4CloseCurrencyParams(dummyCtx.poolKey.currency1),
      ],
      label: 'Create position (v4)',
      kind: 'create_position_v4',
      meta: {
        v4Actions: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
        poolId: plan.poolId,
        tickSpacing: Number(plan.tickSpacing),
        hooks: plan.hooks,
        createsNewPosition: true,
      },
    }));

    return {
      action: 'create-position',
      network: networkConfig.id,
      version: 'v4',
      positionIdentifier: null,
      walletAddress: normalizedWallet,
      quoteSummary: {
        token0,
        token1,
        fee: Number(payload.fee),
        poolId: plan.poolId,
        tickSpacing: Number(plan.tickSpacing),
        hooks: plan.hooks,
        amount0Desired: ethers.formatUnits(amount0Desired, token0.decimals),
        amount1Desired: ethers.formatUnits(amount1Desired, token1.decimals),
        currentPrice: plan.currentPrice,
        rangeLowerPrice: Number(payload.rangeLowerPrice),
        rangeUpperPrice: Number(payload.rangeUpperPrice),
        gasReserve: plan.gasReserve,
        fundingPlan: plan.fundingPlan,
        v4ActionPlan: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      },
      requiresApproval,
      txPlan: txPlan.filter(Boolean),
      fundingPlan: {
        ...plan.fundingPlan,
        gasReserve: plan.gasReserve,
        selectedFundingAssets: plan.selectedFundingAssets,
      },
      swapPlan: plan.swapPlan,
      warnings: plan.warnings,
      postActionPositionPreview: buildPostPreview({
        network: networkConfig.id,
        version: 'v4',
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        token0,
        token1,
        priceCurrent: plan.currentPrice,
      }),
      protectionImpact: buildProtectionImpact(null, 'new_position_pending'),
    };
  }

  const networkConfig = getNetworkConfig(payload.network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(payload.walletAddress, 'walletAddress');
  const token0 = await getTokenInfo(provider, payload.token0Address);
  const token1 = await getTokenInfo(provider, payload.token1Address);
  const fee = Number(payload.fee);
  const tickSpacing = Number(payload.tickSpacing);
  const hooks = normalizeHooksAddress(payload.hooks);
  if (!Number.isInteger(fee) || fee <= 0) throw new ValidationError('fee invalido');
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new ValidationError('tickSpacing es requerido para crear una posicion v4');
  if (hasHooks(hooks)) throw new ValidationError('Los pools v4 con hooks no estan soportados en gestion on-chain por ahora');

  const orderedPair = smartPoolCreatorService.sortTokensByAddress(token0, token1);
  const canonicalPlan = normalizeCreatePositionPoolOrder({
    token0,
    token1,
    amount0Desired: toBigIntAmount(payload.amount0Desired, token0.decimals, 'amount0Desired'),
    amount1Desired: toBigIntAmount(payload.amount1Desired, token1.decimals, 'amount1Desired'),
    rangeLowerPrice: payload.rangeLowerPrice,
    rangeUpperPrice: payload.rangeUpperPrice,
    poolToken0Address: orderedPair.token0.address,
    poolToken1Address: orderedPair.token1.address,
  });
  const canonicalToken0 = canonicalPlan.token0;
  const canonicalToken1 = canonicalPlan.token1;
  const amount0Desired = canonicalPlan.amount0Desired;
  const amount1Desired = canonicalPlan.amount1Desired;
  const poolKey = {
    currency0: canonicalToken0.address,
    currency1: canonicalToken1.address,
    fee,
    tickSpacing,
    hooks,
  };
  if (isZeroAddress(poolKey.currency0) || isZeroAddress(poolKey.currency1)) {
    throw new ValidationError('Los pools v4 con token nativo no estan soportados en gestion on-chain por ahora');
  }
  const poolId = payload.poolId || computeV4PoolId(poolKey);
  const stateView = new ethers.Contract(normalizeAddress(networkConfig.deployments.v4.stateView), V4_STATE_VIEW_ABI, provider);
  let slot0;
  try {
    slot0 = await stateView.getSlot0(poolId);
  } catch (err) {
    throw new ValidationError(`No se pudo cargar el pool v4: ${err.message}`);
  }
  if (!slot0?.sqrtPriceX96 || BigInt(slot0.sqrtPriceX96) <= 0n) {
    throw new ValidationError('Solo se soporta crear posicion sobre pools v4 existentes');
  }

  const tickLower = priceToNearestTick(canonicalPlan.rangeLowerPrice, canonicalToken0.decimals, canonicalToken1.decimals, tickSpacing, 'down');
  const tickUpper = priceToNearestTick(canonicalPlan.rangeUpperPrice, canonicalToken0.decimals, canonicalToken1.decimals, tickSpacing, 'up');
  if (tickLower >= tickUpper) throw new ValidationError('El rango nuevo es invalido');
  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: amount0Desired,
    amount1Raw: amount1Desired,
    tickCurrent: Number(slot0.tick),
    tickLower,
    tickUpper,
  });

  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager);
  const requiresApproval = [];
  const txPlan = [];
  await appendPermit2Approvals({
    provider,
    token: canonicalToken0,
    walletAddress: normalizedWallet,
    spender: positionManagerAddress,
    amount: amount0Desired,
    chainId: networkConfig.chainId,
    requiresApproval,
    txPlan,
  });
  await appendPermit2Approvals({
    provider,
    token: canonicalToken1,
    walletAddress: normalizedWallet,
    spender: positionManagerAddress,
    amount: amount1Desired,
    chainId: networkConfig.chainId,
    requiresApproval,
    txPlan,
  });

  const dummyCtx = {
    networkConfig,
    normalizedWallet,
    positionManagerAddress,
    poolKey,
    poolId,
    tickSpacing,
  };
  txPlan.push(buildV4ModifyTx(dummyCtx, {
    actionCodes: [
      V4_ACTIONS.MINT_POSITION,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4MintParams({
        poolKey,
        tickLower,
        tickUpper,
        liquidity: liquidityDelta,
        amount0Max: amount0Desired,
        amount1Max: amount1Desired,
        owner: normalizedWallet,
      }),
      encodeV4CloseCurrencyParams(poolKey.currency0),
      encodeV4CloseCurrencyParams(poolKey.currency1),
    ],
    label: 'Create position (v4)',
    kind: 'create_position_v4',
    meta: {
      v4Actions: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      poolId,
      tickSpacing,
      hooks,
      createsNewPosition: true,
    },
  }));

  return {
    action: 'create-position',
    network: networkConfig.id,
    version: 'v4',
    positionIdentifier: null,
    walletAddress: normalizedWallet,
    quoteSummary: {
      token0: canonicalToken0,
      token1: canonicalToken1,
      fee,
      poolId,
      tickSpacing,
      hooks,
      amount0Desired: ethers.formatUnits(amount0Desired, canonicalToken0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, canonicalToken1.decimals),
      currentPrice: smartPoolCreatorService.orientPriceToSelectedOrder(
        uniswapService.tickToPrice(Number(slot0.tick), canonicalToken0.decimals, canonicalToken1.decimals),
        canonicalPlan.reversed
      ),
      rangeLowerPrice: Number(payload.rangeLowerPrice),
      rangeUpperPrice: Number(payload.rangeUpperPrice),
      v4ActionPlan: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: networkConfig.id,
      version: 'v4',
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      token0: canonicalToken0,
      token1: canonicalToken1,
      priceCurrent: uniswapService.tickToPrice(Number(slot0.tick), canonicalToken0.decimals, canonicalToken1.decimals),
    }),
    protectionImpact: buildProtectionImpact(null, 'new_position_pending'),
  };
}

async function prepareRebalanceV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const lowerPrice = Number(payload.rangeLowerPrice || uniswapService.tickToPrice(ctx.tickLower, ctx.token0.decimals, ctx.token1.decimals));
  const upperPrice = Number(payload.rangeUpperPrice || uniswapService.tickToPrice(ctx.tickUpper, ctx.token0.decimals, ctx.token1.decimals));
  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  const amount0Available = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current') + BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Available = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current') + BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);
  const swap = buildRebalanceSwap(ctx, {
    amount0Available,
    amount1Available,
    targetWeightToken0Pct: payload.targetWeightToken0Pct,
    slippageBps: payload.slippageBps,
  });

  const txPlan = [
    buildV4ModifyTx(ctx, {
      actionCodes: [
        V4_ACTIONS.DECREASE_LIQUIDITY,
        V4_ACTIONS.CLOSE_CURRENCY,
        V4_ACTIONS.CLOSE_CURRENCY,
      ],
      params: [
        encodeV4ModifyLiquidityParams({
          tokenId: ctx.tokenId,
          liquidity: ctx.positionLiquidity,
          amount0Limit: 0n,
          amount1Limit: 0n,
        }),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
      ],
      label: 'Withdraw current v4 position',
      kind: 'decrease_liquidity_v4',
      meta: {
        v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
        poolId: ctx.poolId,
        tickSpacing: ctx.tickSpacing,
        hooks: ctx.poolKey.hooks,
      },
    }),
  ];
  const requiresApproval = [];

  let finalAmount0 = amount0Available;
  let finalAmount1 = amount1Available;
  if (swap?.amountIn > 0n) {
    await appendPermit2Approvals({
      provider: ctx.provider,
      token: swap.tokenIn,
      walletAddress: ctx.normalizedWallet,
      spender: ctx.universalRouterAddress,
      amount: swap.amountIn,
      chainId: ctx.networkConfig.chainId,
      requiresApproval,
      txPlan,
    });
    txPlan.push(buildV4RouterTx(ctx, {
      actionCodes: [
        V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
        V4_ACTIONS.SETTLE_ALL,
        V4_ACTIONS.TAKE_ALL,
      ],
      params: [
        encodeV4SwapExactInSingleParams({
          poolKey: ctx.poolKey,
          zeroForOne: swap.direction === 'token0_to_token1',
          amountIn: swap.amountIn,
          amountOutMinimum: swap.amountOutMinimum,
        }),
        encodeV4SettleAllParams(swap.tokenIn.address, MAX_UINT256),
        encodeV4TakeAllParams(swap.tokenOut.address, swap.amountOutMinimum),
      ],
      label: `Swap ${swap.tokenIn.symbol} -> ${swap.tokenOut.symbol} (v4)`,
      kind: 'swap_v4',
      meta: {
        v4Actions: ['SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL'],
        routerAddress: ctx.universalRouterAddress,
        poolId: ctx.poolId,
      },
    }));
    finalAmount0 = swap.postAmount0;
    finalAmount1 = swap.postAmount1;
  }

  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token0,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: finalAmount0,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });
  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token1,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: finalAmount1,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });

  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: finalAmount0,
    amount1Raw: finalAmount1,
    tickCurrent: ctx.currentTick,
    tickLower,
    tickUpper,
  });
  txPlan.push(buildV4ModifyTx(ctx, {
    actionCodes: [
      V4_ACTIONS.MINT_POSITION,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4MintParams({
        poolKey: ctx.poolKey,
        tickLower,
        tickUpper,
        liquidity: liquidityDelta,
        amount0Max: finalAmount0,
        amount1Max: finalAmount1,
        owner: ctx.normalizedWallet,
      }),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
    ],
    label: 'Mint rebalanced v4 position',
    kind: 'mint_position_v4',
    meta: {
      v4Actions: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      createsNewPosition: true,
    },
  }));

  return {
    action: 'rebalance',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      targetWeightToken0Pct: Number(payload.targetWeightToken0Pct),
      swap: swap ? {
        direction: swap.direction,
        amountIn: ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals),
        tokenIn: swap.tokenIn.symbol,
        tokenOut: swap.tokenOut.symbol,
        minAmountOut: ethers.formatUnits(swap.amountOutMinimum, swap.tokenOut.decimals),
      } : null,
      newRange: {
        tickLower,
        tickUpper,
        rangeLowerPrice: lowerPrice,
        rangeUpperPrice: upperPrice,
      },
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: swap
        ? ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL', 'MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY']
        : ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v4',
      tickLower,
      tickUpper,
      amount0Desired: finalAmount0,
      amount1Desired: finalAmount1,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId, 'new_position_pending'),
  };
}

async function prepareCloseKeepAssetsV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const amount0Expected = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current') + BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Expected = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current') + BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);

  if (ctx.positionLiquidity <= 0n && amount0Expected <= 0n && amount1Expected <= 0n) {
    throw new ValidationError('La posición no tiene liquidez ni fondos pendientes por retirar');
  }

  return {
    action: 'close-keep-assets',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      closeMode: 'keep_assets',
      token0: ctx.token0,
      token1: ctx.token1,
      expectedReceipts: {
        amount0: ethers.formatUnits(amount0Expected, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Expected, ctx.token1.decimals),
      },
      receivesDirectlyInWallet: true,
      v4ActionPlan: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval: [],
    txPlan: [
      buildV4ModifyTx(ctx, {
        actionCodes: [
          V4_ACTIONS.DECREASE_LIQUIDITY,
          V4_ACTIONS.CLOSE_CURRENCY,
          V4_ACTIONS.CLOSE_CURRENCY,
        ],
        params: [
          encodeV4ModifyLiquidityParams({
            tokenId: ctx.tokenId,
            liquidity: ctx.positionLiquidity,
            amount0Limit: 0n,
            amount1Limit: 0n,
          }),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
        ],
        label: 'Close LP and keep assets (v4)',
        kind: 'close_keep_assets_v4',
        meta: {
          v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
          poolId: ctx.poolId,
          tickSpacing: ctx.tickSpacing,
          hooks: ctx.poolKey.hooks,
        },
      }),
    ],
    postActionPositionPreview: buildClosedPositionPreview(ctx.networkConfig.id, 'v4', ctx.token0, ctx.token1, {
      expectedWalletReceipts: {
        amount0: ethers.formatUnits(amount0Expected, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Expected, ctx.token1.decimals),
      },
    }),
    protectionImpact: {
      ...buildProtectionImpact(ctx.tokenId),
      willDeactivateProtection: true,
    },
  };
}

async function prepareCloseToUsdcV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const usdc = getCanonicalUsdcTokenForNetwork(ctx.networkConfig.id);
  const wrappedNative = getWrappedNativeTokenForNetwork(ctx.networkConfig.id);
  const reserveRaw = getGasReserveRaw(ctx.networkConfig.id);
  const nativeBalanceRaw = await ctx.provider.getBalance(ctx.normalizedWallet).catch(() => 0n);
  const amount0Expected = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current') + BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Expected = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current') + BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);

  if (ctx.positionLiquidity <= 0n && amount0Expected <= 0n && amount1Expected <= 0n) {
    throw new ValidationError('La posición no tiene liquidez ni fondos pendientes por retirar');
  }

  const txPlan = [
    buildV4ModifyTx(ctx, {
      actionCodes: [
        V4_ACTIONS.DECREASE_LIQUIDITY,
        V4_ACTIONS.CLOSE_CURRENCY,
        V4_ACTIONS.CLOSE_CURRENCY,
      ],
      params: [
        encodeV4ModifyLiquidityParams({
          tokenId: ctx.tokenId,
          liquidity: ctx.positionLiquidity,
          amount0Limit: 0n,
          amount1Limit: 0n,
        }),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
      ],
      label: 'Withdraw current v4 position',
      kind: 'close_to_usdc_v4_withdraw',
      meta: {
        v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
        poolId: ctx.poolId,
        tickSpacing: ctx.tickSpacing,
        hooks: ctx.poolKey.hooks,
      },
    }),
  ];
  const requiresApproval = [];
  const warnings = [];
  const expectedReceipts = [];
  const swapPlan = [];
  let expectedUsdcRaw = 0n;

  let token0SwapAmount = amount0Expected;
  let token1SwapAmount = amount1Expected;
  const reserveDeficitRaw = nativeBalanceRaw >= reserveRaw ? 0n : reserveRaw - nativeBalanceRaw;
  let unwrapAmountRaw = 0n;
  let unwrapToken = null;

  if (reserveDeficitRaw > 0n) {
    if (wrappedNative && ctx.token0.address.toLowerCase() === wrappedNative.address.toLowerCase() && token0SwapAmount > 0n) {
      unwrapAmountRaw = reserveDeficitRaw > token0SwapAmount ? token0SwapAmount : reserveDeficitRaw;
      token0SwapAmount -= unwrapAmountRaw;
      unwrapToken = ctx.token0;
    } else if (wrappedNative && ctx.token1.address.toLowerCase() === wrappedNative.address.toLowerCase() && token1SwapAmount > 0n) {
      unwrapAmountRaw = reserveDeficitRaw > token1SwapAmount ? token1SwapAmount : reserveDeficitRaw;
      token1SwapAmount -= unwrapAmountRaw;
      unwrapToken = ctx.token1;
    }

    if (unwrapAmountRaw > 0n && unwrapToken) {
      txPlan.push(buildUnwrapNativeTx(unwrapToken, unwrapAmountRaw, ctx.networkConfig.chainId));
    }

    const remainingDeficit = reserveDeficitRaw > unwrapAmountRaw ? reserveDeficitRaw - unwrapAmountRaw : 0n;
    if (remainingDeficit > 0n) {
      throw new ValidationError(`No hay ${ctx.networkConfig.nativeSymbol} suficiente para conservar la reserva de gas requerida.`);
    }
  }

  const assetsToConvert = [
    { token: ctx.token0, estimatedAmount: token0SwapAmount },
    { token: ctx.token1, estimatedAmount: token1SwapAmount },
  ];

  for (const entry of assetsToConvert) {
    if (entry.estimatedAmount <= 0n) continue;
    if (entry.token.address.toLowerCase() === usdc.address.toLowerCase()) {
      expectedUsdcRaw += entry.estimatedAmount;
      expectedReceipts.push({
        symbol: entry.token.symbol,
        amount: ethers.formatUnits(entry.estimatedAmount, entry.token.decimals),
        conversion: 'direct_usdc',
      });
      continue;
    }

    const amountIn = applyCloseBuffer(entry.estimatedAmount);
    const swap = await appendV3SwapToToken({
      provider: ctx.provider,
      networkConfig: ctx.networkConfig,
      normalizedWallet: ctx.normalizedWallet,
      tokenIn: entry.token,
      tokenOut: usdc,
      amountIn,
      slippageBps: payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      txPlan,
      requiresApproval,
    });
    expectedUsdcRaw += swap.amountOutMinimum;
    swapPlan.push({
      tokenIn: entry.token.symbol,
      tokenOut: usdc.symbol,
      amountIn: ethers.formatUnits(amountIn, entry.token.decimals),
      minAmountOut: ethers.formatUnits(swap.amountOutMinimum, usdc.decimals),
      routePoolAddress: swap.routePoolAddress,
    });
    expectedReceipts.push({
      symbol: entry.token.symbol,
      amount: ethers.formatUnits(entry.estimatedAmount, entry.token.decimals),
      conversion: 'swap_to_usdc',
    });
    if (amountIn < entry.estimatedAmount) {
      warnings.push(`Se deja un pequeño remanente de ${entry.token.symbol} para evitar fallos por estimación.`);
    }
  }

  return {
    action: 'close-to-usdc',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      closeMode: 'to_usdc',
      targetStableSymbol: usdc.symbol,
      token0: ctx.token0,
      token1: ctx.token1,
      expectedReceipts,
      expectedUsdcOut: ethers.formatUnits(expectedUsdcRaw, usdc.decimals),
      gasReserve: {
        symbol: ctx.networkConfig.nativeSymbol,
        reservedAmount: ethers.formatUnits(reserveRaw, 18),
        nativeBalance: ethers.formatUnits(nativeBalanceRaw, 18),
      },
      unwrapNative: unwrapAmountRaw > 0n ? {
        tokenSymbol: unwrapToken?.symbol || wrappedNative?.symbol || 'WRAPPED_NATIVE',
        amount: ethers.formatUnits(unwrapAmountRaw, unwrapToken?.decimals || 18),
      } : null,
      swapPlan,
      txCount: txPlan.filter(Boolean).length,
      v4ActionPlan: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    warnings,
    postActionPositionPreview: buildClosedPositionPreview(ctx.networkConfig.id, 'v4', ctx.token0, ctx.token1, {
      targetStableSymbol: usdc.symbol,
      expectedUsdcOut: ethers.formatUnits(expectedUsdcRaw, usdc.decimals),
      reservedNative: ethers.formatUnits(reserveRaw, 18),
    }),
    protectionImpact: {
      ...buildProtectionImpact(ctx.tokenId),
      willDeactivateProtection: true,
    },
  };
}

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

async function waitForReceipt(provider, txHash) {
  try {
    return await provider.waitForTransaction(txHash, 1, 90_000);
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
      await protectedPoolRepo.deactivate(userId, protection.id, {
        deactivatedAt: now,
        poolSnapshot: refreshedSnapshot || protection.poolSnapshot || null,
        rangeFrozenAt: now,
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

async function finalizePositionAction({
  userId,
  action,
  network,
  version,
  walletAddress,
  positionIdentifier,
  txHashes,
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
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(walletAddress, 'walletAddress');
  const receipts = [];
  for (const txHash of txHashes) {
    const receipt = await waitForReceipt(provider, txHash);
    if (!receipt) throw new ExternalServiceError(`Timeout esperando receipt de ${txHash}`);
    if (receipt.status !== 1) throw new ValidationError(`La transaccion ${txHash} fallo on-chain`);
    receipts.push(receipt);
  }

  const positionManagerAddress = version === 'v3'
    ? normalizeAddress(networkConfig.deployments.v3.positionManager)
    : normalizeAddress(networkConfig.deployments.v4.positionManager);
  const mintedPositionIdentifier = extractMintedPositionId(receipts, positionManagerAddress, normalizedWallet);
  const finalPositionIdentifier = mintedPositionIdentifier || (positionIdentifier ? String(positionIdentifier) : null);

  let refreshedSnapshot = null;
  if (finalPositionIdentifier) {
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

module.exports = {
  ACTIONS: [...ACTIONS],
  preparePositionAction,
  finalizePositionAction,
  __test: {
    buildModifyRangeRedeployPlan,
    buildRebalanceSwap,
    computeOptimalWeightToken0Pct,
  },
};
