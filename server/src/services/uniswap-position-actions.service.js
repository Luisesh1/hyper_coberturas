const { ethers } = require('ethers');
const { ValidationError, ExternalServiceError } = require('../errors/app-error');
const uniswapService = require('./uniswap.service');
const claimFeesService = require('./uniswap-claim-fees.service');
const protectedPoolRepo = require('../repositories/protected-uniswap-pool.repository');
const protectedPoolRefreshService = require('./protected-pool-refresh.service');
const logger = require('./logger.service');

const { SUPPORTED_NETWORKS, liquidityToTokenAmounts } = uniswapService;

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const V3_POOL_ABI = [
  'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
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

const TRANSFER_EVENT_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

const MAX_UINT128 = (1n << 128n) - 1n;
const DEFAULT_DEADLINE_SECONDS = 1800;
const DEFAULT_SLIPPAGE_BPS = 100;
const V3_SWAP_ROUTER_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

const ACTIONS = new Set([
  'increase-liquidity',
  'decrease-liquidity',
  'collect-fees',
  'reinvest-fees',
  'modify-range',
  'rebalance',
  'create-position',
]);

function normalizeAddress(address, label = 'address') {
  try {
    return ethers.getAddress(String(address || '').trim());
  } catch {
    throw new ValidationError(`${label} invalida`);
  }
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

function encodeTx(to, data, { value = '0x0', chainId, label, kind, meta = {} } = {}) {
  return {
    to,
    data,
    value,
    chainId,
    label: label || kind || 'transaction',
    kind: kind || 'contract_call',
    ...meta,
  };
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
  return ethers.parseUnits(String(value), decimals);
}

function amountOutMin(rawAmountOut, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  const bps = BigInt(Math.max(0, Math.min(5000, Number(slippageBps) || DEFAULT_SLIPPAGE_BPS)));
  return rawAmountOut - ((rawAmountOut * bps) / 10_000n);
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
    iface.encodeFunctionData('approve', [spender, amount]),
    {
      chainId,
      kind: 'approval',
      label: `Approve ${token.symbol}`,
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        spender,
        amount: amount.toString(),
      },
    }
  );
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
    amount0Min: amountOutMin(amount0Desired, slippageBps),
    amount1Min: amountOutMin(amount1Desired, slippageBps),
    recipient,
    deadline: deadlineFromNow(),
  }]);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'mint_position',
    label: 'Mint new position',
  });
}

function buildV3SwapTx(ctx, swap) {
  if (!swap || swap.amountIn <= 0n) return null;
  const iface = new ethers.Interface(V3_SWAP_ROUTER_ABI);
  const data = iface.encodeFunctionData('exactInputSingle', [{
    tokenIn: swap.tokenIn.address,
    tokenOut: swap.tokenOut.address,
    fee: ctx.position.fee,
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

async function prepareModifyRange(payload) {
  const ctx = await loadV3PositionContext(payload);
  const lowerPrice = Number(payload.rangeLowerPrice);
  const upperPrice = Number(payload.rangeUpperPrice);
  if (!Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice) || lowerPrice <= 0 || upperPrice <= lowerPrice) {
    throw new ValidationError('El rango nuevo es invalido');
  }

  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');
  const amount0Desired = amount0Current + BigInt(ctx.position.tokensOwed0);
  const amount1Desired = amount1Current + BigInt(ctx.position.tokensOwed1);

  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  if (tickLower >= tickUpper) {
    throw new ValidationError('El rango nuevo genera ticks invalidos');
  }

  const txPlan = [
    buildV3DecreaseTx(ctx, { liquidityDelta: BigInt(ctx.position.liquidity), slippageBps: payload.slippageBps }),
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
  txPlan.push(buildV3MintTx(ctx, {
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    slippageBps: payload.slippageBps,
    recipient: ctx.normalizedWallet,
  }));

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
      expectedRedeployAmounts: {
        amount0: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      },
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
    const expectedOut = ethers.parseUnits(String(valueToSwap.toFixed(6)), ctx.token1.decimals);
    return {
      tokenIn: ctx.token0,
      tokenOut: ctx.token1,
      amountIn,
      amountOutMinimum: amountOutMin(expectedOut, slippageBps),
      postAmount0: amount0Available - amountIn,
      postAmount1: amount1Available + expectedOut,
      direction: 'token0_to_token1',
    };
  }

  const valueToSwap = value1 - (totalValue - targetValue0);
  const amountIn = ethers.parseUnits(String(valueToSwap.toFixed(6)), ctx.token1.decimals);
  const expectedToken0 = ethers.parseUnits(String((valueToSwap / price).toFixed(8)), ctx.token0.decimals);
  return {
    tokenIn: ctx.token1,
    tokenOut: ctx.token0,
    amountIn,
    amountOutMinimum: amountOutMin(expectedToken0, slippageBps),
    postAmount0: amount0Available + expectedToken0,
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

async function prepareCreatePosition(payload) {
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
  const [tickSpacing, slot0, token0State, token1State] = await Promise.all([
    pool.tickSpacing(),
    pool.slot0(),
    getBalanceAndAllowance(provider, token0, normalizedWallet, normalizeAddress(networkConfig.deployments.v3.positionManager)),
    getBalanceAndAllowance(provider, token1, normalizedWallet, normalizeAddress(networkConfig.deployments.v3.positionManager)),
  ]);

  const amount0Desired = toBigIntAmount(payload.amount0Desired, token0.decimals, 'amount0Desired');
  const amount1Desired = toBigIntAmount(payload.amount1Desired, token1.decimals, 'amount1Desired');
  if (token0State.balance < amount0Desired || token1State.balance < amount1Desired) {
    throw new ValidationError('La wallet no tiene balance suficiente para crear la posicion');
  }

  const tickLower = priceToNearestTick(payload.rangeLowerPrice, token0.decimals, token1.decimals, Number(tickSpacing), 'down');
  const tickUpper = priceToNearestTick(payload.rangeUpperPrice, token0.decimals, token1.decimals, Number(tickSpacing), 'up');
  if (tickLower >= tickUpper) throw new ValidationError('El rango nuevo es invalido');

  const pmAddress = normalizeAddress(networkConfig.deployments.v3.positionManager);
  const dummyCtx = {
    networkConfig,
    positionManagerAddress: pmAddress,
    fee,
    token0,
    token1,
  };
  const txPlan = [];
  const requiresApproval = [];
  if (token0State.allowance < amount0Desired) {
    requiresApproval.push(buildApprovalRequirement(token0, pmAddress, amount0Desired));
    txPlan.push(maybeBuildApprovalTx(token0, pmAddress, amount0Desired, networkConfig.chainId));
  }
  if (token1State.allowance < amount1Desired) {
    requiresApproval.push(buildApprovalRequirement(token1, pmAddress, amount1Desired));
    txPlan.push(maybeBuildApprovalTx(token1, pmAddress, amount1Desired, networkConfig.chainId));
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
      token0,
      token1,
      fee,
      poolAddress: normalizeAddress(poolAddress),
      amount0Desired: ethers.formatUnits(amount0Desired, token0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, token1.decimals),
      currentPrice: uniswapService.tickToPrice(Number(slot0.tick), token0.decimals, token1.decimals),
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
      token0,
      token1,
      priceCurrent: uniswapService.tickToPrice(Number(slot0.tick), token0.decimals, token1.decimals),
    }),
    protectionImpact: buildProtectionImpact(null, 'new_position_pending'),
  };
}

async function preparePositionAction({ action, payload }) {
  ensureSupportedAction(action);
  const version = String(payload.version || '').toLowerCase();
  if (!['v3', 'v4'].includes(version)) {
    throw new ValidationError('Solo v3 y v4 estan soportados');
  }

  if (version === 'v4' && action !== 'collect-fees') {
    throw new ValidationError(`La accion ${action} aun no esta soportada para v4 en esta version`);
  }

  const normalizedPayload = {
    ...payload,
    version,
    network: String(payload.network || '').toLowerCase(),
  };

  switch (action) {
    case 'increase-liquidity':
      return prepareIncreaseLiquidity(normalizedPayload);
    case 'decrease-liquidity':
      return prepareDecreaseLiquidity(normalizedPayload);
    case 'collect-fees':
      return prepareCollectFees(normalizedPayload);
    case 'reinvest-fees':
      return prepareReinvestFees(normalizedPayload);
    case 'modify-range':
      return prepareModifyRange(normalizedPayload);
    case 'rebalance':
      return prepareRebalance(normalizedPayload);
    case 'create-position':
      return prepareCreatePosition(normalizedPayload);
    default:
      throw new ValidationError(`Accion no soportada: ${action}`);
  }
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
      migratedCount: 0,
      migratedProtectionIds: [],
      refreshed: false,
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

  return {
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
}

module.exports = {
  ACTIONS: [...ACTIONS],
  preparePositionAction,
  finalizePositionAction,
};
