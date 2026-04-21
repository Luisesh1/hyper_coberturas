const { ethers } = require('ethers');
const logger = require('./logger.service');
const marketDataService = require('./market-data.service');
const marketService = require('./market.service');
const { atr } = require('./indicator-library');
const { normalizeSymbol, isStableSymbol } = require('./delta-neutral-math.service');
const { AppError, ValidationError } = require('../errors/app-error');
const uniswapService = require('./uniswap.service');
const onChainManager = require('./onchain-manager.service');
const { MULTICALL3_ADDRESS } = onChainManager;
const {
  computeV4PoolId,
  hasHooks,
  normalizeHooksAddress,
  ZERO_HOOKS_ADDRESS,
} = require('./uniswap-v4-helpers.service');

const { SUPPORTED_NETWORKS } = require('./uniswap/networks');
const {
  ERC20_ABI,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V4_STATE_VIEW_ABI,
} = require('./uniswap/abis');

const DEFAULT_FEE_TIERS = [100, 500, 3000, 10000];
const DEFAULT_MAX_SLIPPAGE_BPS = 50;
const DEFAULT_POOL_VALUE_BUFFER = 1.05;
// Mínimo USD por swap. Por debajo de este umbral los costos de gas + slippage
// superan el valor del swap, así que es preferible aceptar ese sub-déficit y
// dejar el dust en la wallet en vez de generar una tx extra (approve + swap).
const MIN_SWAP_USD = 1.5;
const DEFAULT_V4_TICK_SPACING_BY_FEE = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};
const GAS_RESERVE_BY_NETWORK = {
  ethereum: '0.01',
  arbitrum: '0.002',
  base: '0.0015',
  optimism: '0.0015',
  polygon: '1',
};

const KNOWN_TOKENS = {
  ethereum: [
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, isWrappedNative: true },
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
  ],
  arbitrum: [
    { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, isWrappedNative: true },
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    { symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
  ],
  base: [
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, isWrappedNative: true },
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    { symbol: 'USDbC', address: '0xd9aAEc86B65D86f6A7B5b1b0c42FFA531710b6CA', decimals: 6 },
    { symbol: 'WBTC', address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8 },
    { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  ],
  optimism: [
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, isWrappedNative: true },
    { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CaF62653d097FF85', decimals: 6 },
    { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    { symbol: 'WBTC', address: '0x68f180fcCe6836688e9084f035309E29BF0A2095', decimals: 8 },
    { symbol: 'DAI', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
  ],
  polygon: [
    { symbol: 'WPOL', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18, isWrappedNative: true },
    { symbol: 'USDC', address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
    { symbol: 'USDT', address: '0xc2132D05D31c914A87C6611C10748AEb04B58e8F', decimals: 6 },
    { symbol: 'WETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
    { symbol: 'WBTC', address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
  ],
};

const ATR_MULTIPLIERS = {
  conservative: { multiplier: 5, label: 'Conservador (±5× ATR)' },
  balanced: { multiplier: 3, label: 'Balanceado (±3× ATR)' },
  aggressive: { multiplier: 1.5, label: 'Agresivo (±1.5× ATR)' },
};

const FALLBACK_MULTIPLIERS = {
  conservative: { multiplier: 0.05, label: 'Conservador (±5%)' },
  balanced: { multiplier: 0.03, label: 'Balanceado (±3%)' },
  aggressive: { multiplier: 0.015, label: 'Agresivo (±1.5%)' },
};

function getKnownTokens(network) {
  const normalized = String(network || '').toLowerCase();
  return KNOWN_TOKENS[normalized] || KNOWN_TOKENS.ethereum;
}

function getNetworkConfig(network) {
  const networkConfig = SUPPORTED_NETWORKS[String(network || '').toLowerCase()];
  if (!networkConfig) {
    throw new ValidationError(`network no soportada: ${network}`);
  }
  return networkConfig;
}

function getProvider(networkConfig) {
  return onChainManager.getProvider(networkConfig, { scope: 'smart-pool-creator' });
}

function normalizeTokenList(tokens = []) {
  const seen = new Map();
  for (const token of tokens) {
    if (!token?.address) continue;
    const key = String(token.address).toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, {
      ...token,
      address: ethers.getAddress(token.address),
      decimals: Number(token.decimals ?? 18),
      symbol: String(token.symbol || 'UNKNOWN').toUpperCase(),
    });
  }
  return [...seen.values()];
}

function sortTokensByAddress(tokenA, tokenB) {
  const addressA = ethers.getAddress(tokenA.address);
  const addressB = ethers.getAddress(tokenB.address);
  if (addressA.toLowerCase() <= addressB.toLowerCase()) {
    return {
      token0: { ...tokenA, address: addressA },
      token1: { ...tokenB, address: addressB },
      reversed: false,
    };
  }
  return {
    token0: { ...tokenB, address: addressB },
    token1: { ...tokenA, address: addressA },
    reversed: true,
  };
}

function orientPriceToSelectedOrder(priceInCanonicalOrder, reversed) {
  const numeric = Number(priceInCanonicalOrder);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return reversed ? (1 / numeric) : numeric;
}

function orientRangeToCanonicalOrder(rangeLowerPrice, rangeUpperPrice, reversed) {
  const lower = Number(rangeLowerPrice);
  const upper = Number(rangeUpperPrice);
  if (!reversed) {
    return {
      rangeLowerPrice: lower,
      rangeUpperPrice: upper,
    };
  }
  return {
    rangeLowerPrice: 1 / upper,
    rangeUpperPrice: 1 / lower,
  };
}

function resolveVolatileAsset(token0Symbol, token1Symbol) {
  const norm0 = normalizeSymbol(token0Symbol);
  const norm1 = normalizeSymbol(token1Symbol);
  const is0Stable = isStableSymbol(norm0);
  const is1Stable = isStableSymbol(norm1);

  if (is0Stable && !is1Stable) return norm1;
  if (!is0Stable && is1Stable) return norm0;
  if (!is0Stable && !is1Stable) return norm1;
  throw new ValidationError('Both tokens are stables, cannot determine volatile asset');
}

async function fetchAtr14(volatileAsset) {
  try {
    const candles = await marketDataService.getCandles(volatileAsset, '1h', { limit: 100 });
    if (!Array.isArray(candles) || candles.length < 14) {
      logger.warn('smart_pool_creator_insufficient_candles', {
        asset: volatileAsset,
        count: candles?.length || 0,
      });
      return null;
    }

    const atrSeries = atr(candles, { period: 14 });
    const lastAtr = atrSeries[atrSeries.length - 1];

    if (!Number.isFinite(lastAtr) || lastAtr <= 0) {
      logger.warn('smart_pool_creator_invalid_atr', {
        asset: volatileAsset,
        lastAtr,
      });
      return null;
    }

    return Number(lastAtr);
  } catch (err) {
    logger.warn('smart_pool_creator_atr_fetch_failed', {
      asset: volatileAsset,
      error: err.message,
    });
    return null;
  }
}

function computeRangeSuggestions(currentPrice, atr14, hasAtr) {
  const suggestions = [];
  const multipliers = hasAtr ? ATR_MULTIPLIERS : FALLBACK_MULTIPLIERS;

  Object.entries(multipliers).forEach(([preset, { multiplier, label }]) => {
    const offset = hasAtr ? atr14 * multiplier : currentPrice * multiplier;
    const lowerPrice = Math.max(currentPrice - offset, 0.0001);
    const upperPrice = currentPrice + offset;
    const widthPct = ((upperPrice - lowerPrice) / currentPrice) * 100;

    suggestions.push({
      preset,
      label,
      rangeLowerPrice: Number(lowerPrice.toFixed(2)),
      rangeUpperPrice: Number(upperPrice.toFixed(2)),
      widthPct: Number(widthPct.toFixed(1)),
    });
  });

  return suggestions;
}

function computeToken0Pct(currentPrice, lowerPrice, upperPrice) {
  if (currentPrice <= lowerPrice) return 100;
  if (currentPrice >= upperPrice) return 0;

  const sqrtP = Math.sqrt(currentPrice);
  const sqrtL = Math.sqrt(lowerPrice);
  const sqrtU = Math.sqrt(upperPrice);

  const a0Virtual = (sqrtU - sqrtP) / (sqrtP * sqrtU);
  const a1Virtual = sqrtP - sqrtL;
  const a0Usd = a0Virtual * currentPrice;
  const a1Usd = a1Virtual;

  if (a0Usd + a1Usd <= 0) return 50;
  return Math.max(0, Math.min(100, Number(((a0Usd / (a0Usd + a1Usd)) * 100).toFixed(1))));
}

function floorToDecimals(value, decimals, maxPrecision = 8) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0';
  return numeric.toFixed(Math.min(Number(decimals || 18), maxPrecision));
}

function toRawAmount(value, decimals) {
  const normalized = floorToDecimals(value, decimals, 12);
  return ethers.parseUnits(normalized, decimals);
}

function rawToAmount(raw, decimals) {
  return Number(ethers.formatUnits(BigInt(raw || 0n), decimals));
}

function pickTargetTokenByUsdDeficit({
  remaining0Raw,
  remaining1Raw,
  token0,
  token1,
  token0UsdPrice,
  token1UsdPrice,
}) {
  const remaining0Usd = rawToAmount(remaining0Raw, token0.decimals) * Number(token0UsdPrice || 0);
  const remaining1Usd = rawToAmount(remaining1Raw, token1.decimals) * Number(token1UsdPrice || 0);

  if (remaining0Usd > remaining1Usd) return token0;
  if (remaining1Usd > remaining0Usd) return token1;
  return BigInt(remaining0Raw || 0n) >= BigInt(remaining1Raw || 0n) ? token0 : token1;
}

function buildNativeAsset(networkConfig, balanceRaw) {
  return {
    id: 'native',
    address: 'native',
    symbol: networkConfig.nativeSymbol,
    decimals: 18,
    balanceRaw: balanceRaw.toString(),
    balance: ethers.formatUnits(balanceRaw, 18),
    isNative: true,
    canUseForFunding: true,
  };
}

async function getTokenBalance(provider, tokenAddress, walletAddress) {
  const contract = onChainManager.getContract({ runner: provider, address: tokenAddress, abi: ERC20_ABI });
  return contract.balanceOf(walletAddress).catch(() => 0n);
}

async function getTokenInfoFromChain(provider, tokenAddress) {
  const contract = onChainManager.getContract({ runner: provider, address: tokenAddress, abi: ERC20_ABI });
  const [symbol, decimals] = await Promise.all([
    contract.symbol().catch(() => 'UNKNOWN'),
    contract.decimals().catch(() => 18),
  ]);
  return {
    address: ethers.getAddress(tokenAddress),
    symbol: String(symbol).toUpperCase(),
    decimals: Number(decimals),
  };
}

function getWrappedNativeToken(network) {
  return getKnownTokens(network).find((token) => token.isWrappedNative) || null;
}

function getGasReserveAmount(network) {
  return GAS_RESERVE_BY_NETWORK[String(network || '').toLowerCase()] || '0.002';
}

function getCanonicalUsdcToken(network) {
  return getKnownTokens(network).find((token) => token.symbol === 'USDC') || null;
}

function getUsdPriceForSymbol(symbol, allPrices = {}) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;
  if (isStableSymbol(normalized)) return 1;
  const price = allPrices[normalized];
  const numeric = Number(price);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function computeTargetUsdPrices({
  token0,
  token1,
  currentPrice,
  allPrices,
}) {
  let token0UsdPrice = getUsdPriceForSymbol(token0.symbol, allPrices);
  let token1UsdPrice = getUsdPriceForSymbol(token1.symbol, allPrices);

  if (!token0UsdPrice && token1UsdPrice) {
    token0UsdPrice = token1UsdPrice * Number(currentPrice);
  }
  if (!token1UsdPrice && token0UsdPrice) {
    token1UsdPrice = token0UsdPrice / Number(currentPrice);
  }

  if (!Number.isFinite(token0UsdPrice) || token0UsdPrice <= 0 || !Number.isFinite(token1UsdPrice) || token1UsdPrice <= 0) {
    throw new ValidationError('No se pudo valorar el par seleccionado en USD para crear la posicion');
  }

  return { token0UsdPrice, token1UsdPrice };
}

function computeAmountsFromWeight(token0PctWeight, totalUsd, token0UsdPrice, token1UsdPrice, token0Decimals, token1Decimals) {
  const amount0Usd = totalUsd * (token0PctWeight / 100);
  const amount1Usd = totalUsd * ((100 - token0PctWeight) / 100);
  const amount0 = amount0Usd > 0 ? amount0Usd / token0UsdPrice : 0;
  const amount1 = amount1Usd > 0 ? amount1Usd / token1UsdPrice : 0;

  const amount0Raw = toRawAmount(amount0, token0Decimals);
  const amount1Raw = toRawAmount(amount1, token1Decimals);

  return {
    amount0Desired: ethers.formatUnits(amount0Raw, token0Decimals),
    amount1Desired: ethers.formatUnits(amount1Raw, token1Decimals),
    amount0DesiredRaw: amount0Raw.toString(),
    amount1DesiredRaw: amount1Raw.toString(),
  };
}

function buildFundingDomainError(code, message, details = {}) {
  return new AppError(message, {
    status: 400,
    code,
    details,
  });
}

function logFundingFailure(code, payload = {}) {
  logger.warn('smart_pool_creator_funding_plan_rejected', {
    code,
    ...payload,
  });
}

function summarizeFundingDiagnostics({
  network,
  fundingUniverse,
  availableFundingAssets,
  totalUsdTarget,
  deployableUsd = 0,
  warnings = [],
}) {
  const totalTarget = Number(totalUsdTarget || 0);
  const nativeAsset = (availableFundingAssets || []).find((asset) => asset.isNative) || null;
  const gasReserve = fundingUniverse?.gasReserve || null;
  const usableFundingUsd = (availableFundingAssets || []).reduce((sum, asset) => {
    const usdValue = Number(asset.usdValue || 0);
    if (!Number.isFinite(usdValue)) return sum;
    return sum + usdValue;
  }, 0);

  return {
    network,
    gasReserve,
    nativeBalance: gasReserve
      ? {
          symbol: gasReserve.symbol,
          balance: gasReserve.nativeBalance,
          balanceRaw: gasReserve.nativeBalanceRaw,
        }
      : null,
    usableNative: gasReserve
      ? {
          symbol: gasReserve.symbol,
          balance: gasReserve.usableNative,
          balanceRaw: gasReserve.usableNativeRaw,
        }
      : null,
    availableFundingAssets,
    totalUsdTarget: totalTarget,
    deployableUsd: Number(Number(deployableUsd || 0).toFixed(2)),
    missingUsd: Number(Math.max(totalTarget - Number(deployableUsd || 0), 0).toFixed(2)),
    usableFundingUsd: Number(usableFundingUsd.toFixed(2)),
    warnings,
    sameNetworkOnly: true,
    nativeAsset,
  };
}

async function getV3PoolContext({
  provider,
  networkConfig,
  token0,
  token1,
  fee,
}) {
  const ordered = sortTokensByAddress(token0, token1);
  const factoryAddress = ethers.getAddress(networkConfig.deployments.v3.eventSource);
  const factory = onChainManager.getContract({
    runner: provider,
    address: factoryAddress,
    abi: V3_FACTORY_ABI,
  });
  const poolAddress = await factory.getPool(ordered.token0.address, ordered.token1.address, fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new ValidationError('Solo se soporta crear posicion sobre pools existentes');
  }

  // Multicall3: 4 reads del pool en 1 sola RPC. Fallback a Promise.all
  // si Multicall3 no está disponible.
  let slot0;
  let tickSpacing;
  let actualToken0;
  let actualToken1;
  try {
    const results = await onChainManager.aggregate({
      networkConfig,
      scope: 'smart-pool-creator',
      calls: [
        { target: poolAddress, abi: V3_POOL_ABI, method: 'slot0' },
        { target: poolAddress, abi: V3_POOL_ABI, method: 'tickSpacing' },
        { target: poolAddress, abi: V3_POOL_ABI, method: 'token0' },
        { target: poolAddress, abi: V3_POOL_ABI, method: 'token1' },
      ],
    });
    slot0 = results[0].value;
    tickSpacing = results[1].value;
    actualToken0 = results[2].value;
    actualToken1 = results[3].value;
  } catch (mcErr) {
    logger.warn('get_v3_pool_context_multicall_fallback', {
      poolAddress,
      network: networkConfig?.id,
      error: mcErr?.message,
      code: mcErr?.code,
    });
    const pool = onChainManager.getContract({ runner: provider, address: poolAddress, abi: V3_POOL_ABI });
    [slot0, tickSpacing, actualToken0, actualToken1] = await Promise.all([
      pool.slot0(),
      pool.tickSpacing(),
      pool.token0(),
      pool.token1(),
    ]);
  }
  const actualReversed = actualToken0.toLowerCase() !== token0.address.toLowerCase();
  const canonicalPrice = uniswapService.tickToPrice(
    Number(slot0.tick),
    ordered.token0.decimals,
    ordered.token1.decimals
  );

  return {
    poolExists: true,
    poolAddress: ethers.getAddress(poolAddress),
    tickSpacing: Number(tickSpacing),
    hooks: null,
    poolId: null,
    currentPrice: Number(orientPriceToSelectedOrder(canonicalPrice, actualReversed).toFixed(6)),
    poolToken0Address: ethers.getAddress(actualToken0),
    poolToken1Address: ethers.getAddress(actualToken1),
    requestedTokenOrderReversed: actualReversed,
  };
}

async function getV4PoolContext({
  provider,
  networkConfig,
  token0,
  token1,
  fee,
  tickSpacing,
  hooks,
  poolId,
}) {
  const ordered = sortTokensByAddress(token0, token1);
  const resolvedTickSpacing = Number(tickSpacing || DEFAULT_V4_TICK_SPACING_BY_FEE[fee]);
  if (!Number.isInteger(resolvedTickSpacing) || resolvedTickSpacing <= 0) {
    throw new ValidationError('No se pudo resolver tickSpacing para el pool v4');
  }

  const resolvedHooks = normalizeHooksAddress(hooks);
  if (hasHooks(resolvedHooks)) {
    throw new ValidationError('Los pools v4 con hooks no estan soportados en smart create por ahora');
  }

  const resolvedPoolId = poolId || computeV4PoolId({
    currency0: ordered.token0.address,
    currency1: ordered.token1.address,
    fee,
    tickSpacing: resolvedTickSpacing,
    hooks: resolvedHooks,
  });

  const stateView = onChainManager.getContract({
    runner: provider,
    address: ethers.getAddress(networkConfig.deployments.v4.stateView),
    abi: V4_STATE_VIEW_ABI,
  });
  let slot0;
  try {
    slot0 = await stateView.getSlot0(resolvedPoolId);
  } catch (err) {
    throw new ValidationError(`Solo se soporta crear posicion sobre pools v4 existentes: ${err.message}`);
  }

  if (!slot0?.sqrtPriceX96 || BigInt(slot0.sqrtPriceX96) <= 0n) {
    throw new ValidationError('Solo se soporta crear posicion sobre pools v4 existentes');
  }

  return {
    poolExists: true,
    poolAddress: null,
    tickSpacing: resolvedTickSpacing,
    hooks: resolvedHooks,
    poolId: resolvedPoolId,
    currentPrice: Number(orientPriceToSelectedOrder(
      uniswapService.tickToPrice(Number(slot0.tick), ordered.token0.decimals, ordered.token1.decimals),
      ordered.reversed
    ).toFixed(6)),
    poolToken0Address: ordered.token0.address,
    poolToken1Address: ordered.token1.address,
    requestedTokenOrderReversed: ordered.reversed,
  };
}

async function resolvePoolContext({
  network,
  version,
  token0,
  token1,
  fee,
  tickSpacing,
  hooks,
  poolId,
}) {
  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);
  const normalizedVersion = String(version || 'v3').toLowerCase();

  if (normalizedVersion === 'v4') {
    const ctx = await getV4PoolContext({
      provider,
      networkConfig,
      token0,
      token1,
      fee,
      tickSpacing,
      hooks,
      poolId,
    });
    return { ...ctx, networkConfig, provider, version: 'v4' };
  }

  const ctx = await getV3PoolContext({
    provider,
    networkConfig,
    token0,
    token1,
    fee,
  });
  return { ...ctx, networkConfig, provider, version: 'v3' };
}

async function enrichWalletAssets({
  network,
  walletAddress,
  includeTokenAddresses = [],
}) {
  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = ethers.getAddress(walletAddress);
  const knownTokens = normalizeTokenList([
    ...getKnownTokens(network),
    ...await Promise.all(
      (includeTokenAddresses || []).map(async (address) => {
        try {
          return await getTokenInfoFromChain(provider, address);
        } catch {
          return null;
        }
      })
    ).then((items) => items.filter(Boolean)),
  ]);
  const allPrices = await marketService.getAllPrices().catch(() => ({}));

  // Multicall3: leemos el balance nativo + N balances ERC20 en UNA sola
  // RPC call. Antes esto eran ~21 calls secuenciales (1 getBalance + 20
  // balanceOf), ahora es 1 sola. Si Multicall3 no está deployed o falla,
  // caemos al path legacy con un warning.
  const MULTICALL3_ETH_BALANCE_ABI = [
    'function getEthBalance(address addr) view returns (uint256 balance)',
  ];
  const ERC20_BAL_ABI = [
    'function balanceOf(address account) external view returns (uint256)',
  ];
  let nativeBalanceRaw = 0n;
  let erc20Balances = [];
  try {
    const calls = [
      {
        target: MULTICALL3_ADDRESS,
        abi: MULTICALL3_ETH_BALANCE_ABI,
        method: 'getEthBalance',
        args: [normalizedWallet],
        allowFailure: true,
      },
      ...knownTokens.map((token) => ({
        target: token.address,
        abi: ERC20_BAL_ABI,
        method: 'balanceOf',
        args: [normalizedWallet],
        allowFailure: true,
      })),
    ];
    const results = await onChainManager.aggregate({
      networkConfig,
      calls,
      scope: 'smart-pool-creator',
    });
    nativeBalanceRaw = results[0]?.success ? BigInt(results[0].value) : 0n;
    erc20Balances = knownTokens.map((token, idx) => {
      const r = results[idx + 1];
      return {
        token,
        balanceRaw: r?.success ? BigInt(r.value) : 0n,
      };
    });
  } catch (multicallErr) {
    logger.warn('enrich_wallet_assets_multicall_fallback', {
      network,
      walletAddress: normalizedWallet,
      error: multicallErr?.message,
    });
    nativeBalanceRaw = await provider.getBalance(normalizedWallet).catch(() => 0n);
    erc20Balances = await Promise.all(
      knownTokens.map(async (token) => {
        const balanceRaw = await getTokenBalance(provider, token.address, normalizedWallet);
        return { token, balanceRaw };
      })
    );
  }
  const nativeAsset = buildNativeAsset(networkConfig, nativeBalanceRaw);

  const assets = [nativeAsset];
  for (const { token, balanceRaw } of erc20Balances) {
    const balance = ethers.formatUnits(balanceRaw, token.decimals);
    const usdPrice = getUsdPriceForSymbol(token.symbol, allPrices);
    const usdValue = usdPrice != null ? Number(balance) * usdPrice : null;
    assets.push({
      id: token.address.toLowerCase(),
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      balance,
      balanceRaw: balanceRaw.toString(),
      usdPrice,
      usdValue,
      isNative: false,
      isWrappedNative: token.isWrappedNative === true,
      isStable: isStableSymbol(normalizeSymbol(token.symbol)),
      canUseForFunding: Number(balanceRaw) > 0,
    });
  }

  const reserveRaw = ethers.parseUnits(getGasReserveAmount(network), 18);
  const hydrated = assets
    .map((asset) => {
      const balanceRaw = BigInt(asset.balanceRaw || 0n);
      if (!asset.isNative) {
        return {
          ...asset,
          balanceRaw: balanceRaw.toString(),
          balance: ethers.formatUnits(balanceRaw, asset.decimals),
          usableBalanceRaw: balanceRaw.toString(),
          usableBalance: ethers.formatUnits(balanceRaw, asset.decimals),
        };
      }
      const usable = balanceRaw > reserveRaw ? balanceRaw - reserveRaw : 0n;
      const usdPrice = getUsdPriceForSymbol(asset.symbol, allPrices);
      return {
        ...asset,
        usdPrice,
        usdValue: usdPrice != null ? Number(asset.balance) * usdPrice : null,
        usableBalanceRaw: usable.toString(),
        usableBalance: ethers.formatUnits(usable, asset.decimals),
      };
    })
    .filter((asset) => BigInt(asset.balanceRaw || 0n) > 0n);

  hydrated.sort((left, right) => Number(right.usdValue || 0) - Number(left.usdValue || 0));

  return {
    network: networkConfig.id,
    walletAddress: normalizedWallet,
    gasReserve: {
      symbol: networkConfig.nativeSymbol,
      reservedAmount: getGasReserveAmount(networkConfig.id),
      reservedRaw: reserveRaw.toString(),
      nativeBalanceRaw: nativeBalanceRaw.toString(),
      nativeBalance: ethers.formatUnits(nativeBalanceRaw, 18),
      usableNativeRaw: nativeBalanceRaw > reserveRaw ? (nativeBalanceRaw - reserveRaw).toString() : '0',
      usableNative: nativeBalanceRaw > reserveRaw ? ethers.formatUnits(nativeBalanceRaw - reserveRaw, 18) : '0',
    },
    assets: hydrated,
  };
}

function isAssetDirectFor(asset, targetAddress, wrappedNativeAddress) {
  if (!targetAddress) return false;
  const target = String(targetAddress).toLowerCase();
  if (asset.address && asset.address.toLowerCase() === target) return true;
  if (asset.isNative && wrappedNativeAddress && wrappedNativeAddress.toLowerCase() === target) return true;
  return false;
}

function _buildFundingPriority(asset, { token0Address, token1Address, wrappedNativeAddress }) {
  if (isAssetDirectFor(asset, token0Address, wrappedNativeAddress)) return 0;
  if (isAssetDirectFor(asset, token1Address, wrappedNativeAddress)) return 0;
  if (asset.isNative && asset.isWrappedNative) return 1;
  if (asset.isStable) return 2;
  if (asset.usdValue != null) return 3;
  return 4;
}

/**
 * Selección óptima de assets para fondear un LP minimizando swaps.
 *
 * Algoritmo:
 *   1. Calcula la deuda por lado a partir de `totalUsdTarget` + weight.
 *   2. Asigna primero los assets directos (token0/token1, o native si el
 *      wrapped es uno de los lados) hasta cubrir su lado correspondiente.
 *   3. Si queda déficit en algún lado, agrega assets no-directos del MAYOR
 *      USD value primero, hasta cubrir todo el déficit. Un solo asset puede
 *      cubrir ambos lados en 2 swaps (drenado secuencial); preferimos eso
 *      antes que usar varios assets pequeños con 1 swap cada uno.
 *   4. Solo agrega lo NECESARIO. No infla la selección con assets que no
 *      van a aportar valor al LP.
 *
 * Devuelve `{ selection, estimatedSwapCount, uncoveredUsd }` donde:
 *   - selection: array `{ assetId, enabled }` listo para `fundingSelections`
 *   - estimatedSwapCount: cuántos swaps generará este subset (best-effort)
 *   - uncoveredUsd: cuánto del target no se llegaría a cubrir con este subset
 */
function buildOptimalFundingSelection({
  assets,
  token0Address,
  token1Address,
  totalUsdTarget,
  targetWeightToken0Pct,
  wrappedNativeAddress = null,
}) {
  const target = Number(totalUsdTarget || 0);
  const weight = Number(targetWeightToken0Pct);
  if (target <= 0 || !Number.isFinite(weight)) {
    return { selection: [], estimatedSwapCount: 0, uncoveredUsd: target };
  }

  // 5% buffer sobre cada lado para absorber slippage + fees del DEX. Un
  // 5% es suficiente porque después la lógica de swap también escala los
  // mínimos por slippageBps.
  const SLIPPAGE_BUFFER = DEFAULT_POOL_VALUE_BUFFER;
  let need0 = target * (weight / 100) * SLIPPAGE_BUFFER;
  let need1 = target * (1 - weight / 100) * SLIPPAGE_BUFFER;

  const usable = (assets || []).filter((asset) => {
    if (asset.canUseForFunding === false) return false;
    if (BigInt(asset.usableBalanceRaw || asset.balanceRaw || 0n) <= 0n) return false;
    return Number(asset.usdValue || 0) > 0;
  });

  // Pool de trabajo: cada asset con `remainingUsd` para drenar.
  const pool = usable.map((asset) => ({
    asset,
    remainingUsd: Number(asset.usdValue || 0),
    isDirect0: isAssetDirectFor(asset, token0Address, wrappedNativeAddress),
    isDirect1: isAssetDirectFor(asset, token1Address, wrappedNativeAddress),
  }));

  // Orden: directs primero, después largest USD desc.
  //
  // CRÍTICO: dentro de los directs preferimos NON-NATIVE sobre native.
  // Razón: si el usuario tiene WETH ya en wallet, usarlo es 0 swaps + 0
  // wraps. Usar ETH nativo agrega un wrap tx (con riesgo de OOG por L1
  // calldata fee spikes en Arbitrum) Y reduce el balance ETH disponible
  // para gas en las txs subsiguientes. ETH solo se usa si el WETH no
  // alcanza a cubrir el side completo.
  //
  // Esto previene la falla "Deposit -0.00138 ETH Fallida" que reportó el
  // usuario: el planner estaba wrappeando $3 de ETH cuando ya tenía $27
  // de WETH suficientes para cubrir el side, generando una tx fallida
  // que dejaba al wallet sin ETH para gas del resto del plan.
  pool.sort((a, b) => {
    const aDirect = a.isDirect0 || a.isDirect1;
    const bDirect = b.isDirect0 || b.isDirect1;
    if (aDirect && !bDirect) return -1;
    if (!aDirect && bDirect) return 1;
    if (aDirect && bDirect) {
      // Dentro de los directs: ERC20 antes que native (evita wraps).
      if (!a.asset.isNative && b.asset.isNative) return -1;
      if (a.asset.isNative && !b.asset.isNative) return 1;
    }
    return b.remainingUsd - a.remainingUsd;
  });

  const selection = [];
  let estimatedSwapCount = 0;
  const taken = new Set();
  const take = (assetId) => {
    if (taken.has(assetId)) return;
    taken.add(assetId);
    selection.push({ assetId, enabled: true });
  };

  // Helper: aplica una asignación non-direct (con swap) sobre un item.
  const applyNonDirect = (item) => {
    const helps0 = need0 > 0;
    const helps1 = need1 > 0;
    const totalDeficit = Math.max(0, need0) + Math.max(0, need1);
    if (totalDeficit <= 0 || item.remainingUsd < MIN_SWAP_USD) return;
    const used = Math.min(item.remainingUsd, totalDeficit);

    if (helps0 && helps1) {
      const ratio0 = need0 / (need0 + need1);
      const used0 = used * ratio0;
      const used1 = used - used0;
      need0 -= used0;
      need1 -= used1;
      item.remainingUsd -= used;
      const swapsForThis =
        (used0 >= MIN_SWAP_USD ? 1 : 0) + (used1 >= MIN_SWAP_USD ? 1 : 0);
      estimatedSwapCount += swapsForThis;
    } else if (helps0) {
      const used0 = Math.min(used, need0);
      need0 -= used0;
      item.remainingUsd -= used0;
      estimatedSwapCount += 1;
    } else if (helps1) {
      const used1 = Math.min(used, need1);
      need1 -= used1;
      item.remainingUsd -= used1;
      estimatedSwapCount += 1;
    }
    take(item.asset.id);
  };

  // ── Fase 1: aporte DIRECTO desde NON-NATIVE assets ──
  // Cubre los lados con tokens ERC20 que ya tiene el usuario, sin wraps.
  // Wraps de native se posponen porque agregan una tx extra y, en
  // Arbitrum, son propensos a OOG por L1 calldata fee spikes.
  for (const item of pool) {
    if (need0 <= 0 && need1 <= 0) break;
    if (item.asset.isNative) continue;
    if (item.isDirect0 && need0 > 0) {
      const used = Math.min(item.remainingUsd, need0);
      if (used > 0) {
        need0 -= used;
        item.remainingUsd -= used;
        take(item.asset.id);
      }
    }
    if (item.isDirect1 && need1 > 0 && item.remainingUsd > 0) {
      const used = Math.min(item.remainingUsd, need1);
      if (used > 0) {
        need1 -= used;
        item.remainingUsd -= used;
        take(item.asset.id);
      }
    }
  }

  // ── Fase 2: leftover de directs NON-NATIVE como swap source ──
  // Ej: si WETH cubrió token0 y todavía sobra balance, lo usamos para
  // swappear hacia token1 en 1 sola tx (mejor que traer otro asset).
  for (const item of pool) {
    if (need0 <= 0 && need1 <= 0) break;
    if (item.asset.isNative) continue;
    if (item.remainingUsd < MIN_SWAP_USD) continue;
    if (!(item.isDirect0 || item.isDirect1)) continue;

    if (item.isDirect0 && need1 > 0) {
      const used = Math.min(item.remainingUsd, need1);
      if (used >= MIN_SWAP_USD) {
        need1 -= used;
        item.remainingUsd -= used;
        estimatedSwapCount += 1;
        take(item.asset.id);
      }
    }
    if (item.isDirect1 && need0 > 0) {
      const used = Math.min(item.remainingUsd, need0);
      if (used >= MIN_SWAP_USD) {
        need0 -= used;
        item.remainingUsd -= used;
        estimatedSwapCount += 1;
        take(item.asset.id);
      }
    }
  }

  // ── Fase 3: fillers NON-DIRECT NON-NATIVE (mayor USD primero) ──
  // Greedy: el asset ERC20 más grande primero. Un solo asset puede cubrir
  // ambos sides en 2 swaps (preferimos esto sobre 2 assets pequeños).
  for (const item of pool) {
    if (need0 <= 0 && need1 <= 0) break;
    if (item.asset.isNative) continue;
    if (item.isDirect0 || item.isDirect1) continue;
    applyNonDirect(item);
  }

  // ── Fase 4 (LAST RESORT): native ETH ──
  // Solo se usa si todos los pasos anteriores no alcanzaron a cubrir el
  // target. Wrappear ETH agrega una tx más + riesgo de OOG/L1 fee spikes
  // en Arbitrum, así que es preferible evitarlo cuando sea posible.
  //
  // SKIP Phase 4 si el plan actual YA cumple con el threshold mínimo de
  // cobertura del post-validation (0.93). En ese caso pulleár native solo
  // serviría para satisfacer el buffer de slippage 5%, pero a costa de
  // un wrap tx adicional + riesgo. Mejor aceptar la cobertura actual.
  const projectedCoveredUsd = (target * SLIPPAGE_BUFFER)
    - (Math.max(0, need0) + Math.max(0, need1));
  const POST_VALIDATION_THRESHOLD = 0.93;
  if (projectedCoveredUsd >= target * POST_VALIDATION_THRESHOLD) {
    return {
      selection,
      estimatedSwapCount,
      uncoveredUsd: Math.max(0, need0) + Math.max(0, need1),
    };
  }

  for (const item of pool) {
    if (need0 <= 0 && need1 <= 0) break;
    if (!item.asset.isNative) continue;

    if (item.isDirect0 && need0 > 0) {
      const used = Math.min(item.remainingUsd, need0);
      if (used > 0) {
        need0 -= used;
        item.remainingUsd -= used;
        take(item.asset.id);
      }
    }
    if (item.isDirect1 && need1 > 0 && item.remainingUsd > 0) {
      const used = Math.min(item.remainingUsd, need1);
      if (used > 0) {
        need1 -= used;
        item.remainingUsd -= used;
        take(item.asset.id);
      }
    }
    // Native como swap source para el lado opuesto (last resort de last
    // resort): solo si todavía hay déficit Y el native tiene leftover.
    if (item.isDirect0 && need1 > 0 && item.remainingUsd >= MIN_SWAP_USD) {
      const used = Math.min(item.remainingUsd, need1);
      if (used >= MIN_SWAP_USD) {
        need1 -= used;
        item.remainingUsd -= used;
        estimatedSwapCount += 1;
        take(item.asset.id);
      }
    }
    if (item.isDirect1 && need0 > 0 && item.remainingUsd >= MIN_SWAP_USD) {
      const used = Math.min(item.remainingUsd, need0);
      if (used >= MIN_SWAP_USD) {
        need0 -= used;
        item.remainingUsd -= used;
        estimatedSwapCount += 1;
        take(item.asset.id);
      }
    }
    // Native non-direct (ej: ETH en pool BTC/USDT) → fallback final.
    if (!item.isDirect0 && !item.isDirect1) {
      applyNonDirect(item);
    }
  }

  return {
    selection,
    estimatedSwapCount,
    uncoveredUsd: Math.max(0, need0) + Math.max(0, need1),
  };
}

// Wrapper legacy: mantiene la firma vieja `(assets, token0Address, ...)
// → selectionArray` para los call sites que solo necesitan la selección.
function buildAutoFundingSelection({
  assets,
  token0Address,
  token1Address,
  totalUsdTarget,
  targetWeightToken0Pct = 50,
  wrappedNativeAddress = null,
}) {
  const { selection } = buildOptimalFundingSelection({
    assets,
    token0Address,
    token1Address,
    totalUsdTarget,
    targetWeightToken0Pct,
    wrappedNativeAddress,
  });
  // Agregamos `amount` para preservar la API previa que algunos call sites
  // (tests) pueden depender de.
  return selection.map((s) => {
    const asset = (assets || []).find((a) => a.id === s.assetId);
    return {
      assetId: s.assetId,
      enabled: true,
      amount: asset?.usableBalance || asset?.balance || undefined,
    };
  });
}

async function resolveBestDirectRoute({
  provider,
  networkConfig,
  tokenIn,
  tokenOut,
  amountInRaw,
}) {
  if (!tokenIn?.address || !tokenOut?.address) return null;
  if (String(tokenIn.address).toLowerCase() === String(tokenOut.address).toLowerCase()) return null;

  const factory = onChainManager.getContract({
    runner: provider,
    address: ethers.getAddress(networkConfig.deployments.v3.eventSource),
    abi: V3_FACTORY_ABI,
  });

  let bestRoute = null;
  for (const fee of DEFAULT_FEE_TIERS) {
    try {
      const poolAddress = await factory.getPool(tokenIn.address, tokenOut.address, fee);
      if (!poolAddress || poolAddress === ethers.ZeroAddress) continue;
      const pool = onChainManager.getContract({ runner: provider, address: poolAddress, abi: V3_POOL_ABI });
      const [slot0, poolToken0, poolToken1] = await Promise.all([
        pool.slot0(),
        pool.token0(),
        pool.token1(),
      ]);
      const poolPrice = uniswapService.tickToPrice(
        Number(slot0.tick),
        String(poolToken0).toLowerCase() === String(tokenIn.address).toLowerCase() ? tokenIn.decimals : tokenOut.decimals,
        String(poolToken1).toLowerCase() === String(tokenOut.address).toLowerCase() ? tokenOut.decimals : tokenIn.decimals
      );
      if (!Number.isFinite(poolPrice) || poolPrice <= 0) continue;

      const amountIn = rawToAmount(amountInRaw, tokenIn.decimals);
      const feeRate = 1 - (fee / 1_000_000);
      const zeroForOne = String(poolToken0).toLowerCase() === String(tokenIn.address).toLowerCase();
      const expectedOutValue = zeroForOne
        ? amountIn * poolPrice * feeRate
        : (amountIn / poolPrice) * feeRate;
      if (!Number.isFinite(expectedOutValue) || expectedOutValue <= 0) continue;

      const expectedOutRaw = toRawAmount(expectedOutValue, tokenOut.decimals);
      if (!bestRoute || expectedOutRaw > bestRoute.expectedOutRaw) {
        bestRoute = {
          fee,
          poolAddress: ethers.getAddress(poolAddress),
          expectedOutRaw,
          expectedOut: ethers.formatUnits(expectedOutRaw, tokenOut.decimals),
          currentPrice: Number(poolPrice.toFixed(6)),
        };
      }
    } catch (err) {
      logger.debug?.('smart_pool_creator_direct_route_failed', {
        network: networkConfig.id,
        fee,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        error: err.message,
      });
    }
  }

  return bestRoute;
}

/**
 * Resuelve una ruta de swap tokenIn → tokenOut. Primero intenta un pool V3
 * directo (hop único). Si no encuentra ruta directa, intenta un hop por un
 * pivot (típicamente WETH) para desbloquear casos comunes como USDC → USD₮0
 * donde no hay pool directo V3 pero sí existen USDC/WETH y WETH/USD₮0.
 *
 * Devuelve siempre una ruta con la forma:
 *   {
 *     hops: [
 *       { tokenIn, tokenOut, fee, poolAddress, expectedOutRaw, expectedOut, currentPrice, amountInRaw, amountInMinimumRaw }
 *     ],
 *     expectedOutRaw,          // output del último hop, valuación sin slippage
 *     amountOutMinimumRaw,     // output mínimo del último hop tras slippage por hop
 *     expectedOut,
 *     currentPrice,            // del último hop (legacy, para diagnósticos)
 *   }
 *
 * El consumidor debe hacer push de un swap por cada hop al `swapPlan`.
 */
async function resolveBestRoute({
  provider,
  networkConfig,
  tokenIn,
  tokenOut,
  amountInRaw,
  maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS,
  pivotTokens = [],
}) {
  if (!tokenIn?.address || !tokenOut?.address) return null;
  if (String(tokenIn.address).toLowerCase() === String(tokenOut.address).toLowerCase()) return null;

  const slippageBps = BigInt(Number(maxSlippageBps || DEFAULT_MAX_SLIPPAGE_BPS));

  // 1) Intento directo.
  const direct = await resolveBestDirectRoute({ provider, networkConfig, tokenIn, tokenOut, amountInRaw });
  if (direct) {
    const amountOutMinimumRaw = direct.expectedOutRaw - ((direct.expectedOutRaw * slippageBps) / 10_000n);
    return {
      hops: [{
        tokenIn,
        tokenOut,
        fee: direct.fee,
        poolAddress: direct.poolAddress,
        amountInRaw: BigInt(amountInRaw),
        expectedOutRaw: direct.expectedOutRaw,
        expectedOut: direct.expectedOut,
        amountOutMinimumRaw,
        currentPrice: direct.currentPrice,
      }],
      expectedOutRaw: direct.expectedOutRaw,
      expectedOut: direct.expectedOut,
      amountOutMinimumRaw,
      currentPrice: direct.currentPrice,
    };
  }

  // 2) Fallback multi-hop por cada pivot configurado.
  const tokenInAddr = String(tokenIn.address).toLowerCase();
  const tokenOutAddr = String(tokenOut.address).toLowerCase();
  let bestComposite = null;
  for (const pivot of pivotTokens || []) {
    if (!pivot?.address) continue;
    const pivotAddr = String(pivot.address).toLowerCase();
    if (pivotAddr === tokenInAddr || pivotAddr === tokenOutAddr) continue;

    const leg1 = await resolveBestDirectRoute({
      provider,
      networkConfig,
      tokenIn,
      tokenOut: pivot,
      amountInRaw,
    });
    if (!leg1) continue;
    // Para el segundo hop, usamos el mínimo garantizado del primero como
    // entrada conservadora — cualquier sobrante del leg1 queda en la wallet.
    const leg1MinOutRaw = leg1.expectedOutRaw - ((leg1.expectedOutRaw * slippageBps) / 10_000n);
    if (leg1MinOutRaw <= 0n) continue;

    const leg2 = await resolveBestDirectRoute({
      provider,
      networkConfig,
      tokenIn: pivot,
      tokenOut,
      amountInRaw: leg1MinOutRaw,
    });
    if (!leg2) continue;
    const leg2MinOutRaw = leg2.expectedOutRaw - ((leg2.expectedOutRaw * slippageBps) / 10_000n);

    if (!bestComposite || leg2.expectedOutRaw > bestComposite.expectedOutRaw) {
      bestComposite = {
        hops: [
          {
            tokenIn,
            tokenOut: pivot,
            fee: leg1.fee,
            poolAddress: leg1.poolAddress,
            amountInRaw: BigInt(amountInRaw),
            expectedOutRaw: leg1.expectedOutRaw,
            expectedOut: leg1.expectedOut,
            amountOutMinimumRaw: leg1MinOutRaw,
            currentPrice: leg1.currentPrice,
          },
          {
            tokenIn: pivot,
            tokenOut,
            fee: leg2.fee,
            poolAddress: leg2.poolAddress,
            amountInRaw: leg1MinOutRaw,
            expectedOutRaw: leg2.expectedOutRaw,
            expectedOut: leg2.expectedOut,
            amountOutMinimumRaw: leg2MinOutRaw,
            currentPrice: leg2.currentPrice,
          },
        ],
        expectedOutRaw: leg2.expectedOutRaw,
        expectedOut: leg2.expectedOut,
        amountOutMinimumRaw: leg2MinOutRaw,
        currentPrice: leg2.currentPrice,
      };
    }
  }

  return bestComposite;
}

function buildSelectedFundingAssetsMap(assets, fundingSelections = []) {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const result = (fundingSelections || [])
    .filter((selection) => selection && selection.enabled !== false)
    .map((selection) => {
      const asset = assetMap.get(String(selection.assetId || '').toLowerCase());
      if (!asset) return null;
      const maxRaw = BigInt(asset.usableBalanceRaw || asset.balanceRaw || 0n);
      if (maxRaw <= 0n) return null;
      const requestedRaw = selection.amount != null && selection.amount !== ''
        ? ethers.parseUnits(String(selection.amount), asset.decimals)
        : maxRaw;
      const useRaw = requestedRaw > maxRaw ? maxRaw : requestedRaw;
      if (useRaw <= 0n) return null;
      return {
        asset,
        requestedRaw: useRaw,
      };
    })
    .filter(Boolean);

  // Reordenar: NON-NATIVE primero, NATIVE al final. Esto asegura que el
  // direct loop de buildFundingPlan agote primero los ERC20 y solo dipee
  // en native (con su wrap tx asociado) si los ERC20 no alcanzan.
  // Mantiene el orden relativo dentro de cada grupo (estabilidad).
  result.sort((a, b) => {
    const aNative = a.asset.isNative === true ? 1 : 0;
    const bNative = b.asset.isNative === true ? 1 : 0;
    return aNative - bNative;
  });

  return result;
}

async function buildFundingPlan({
  network,
  version,
  walletAddress,
  token0Address,
  token1Address,
  fee,
  totalUsdTarget,
  targetWeightToken0Pct,
  rangeLowerPrice,
  rangeUpperPrice,
  fundingSelections,
  importTokenAddresses = [],
  maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS,
  tickSpacing,
  hooks,
  poolId,
}) {
  const normalizedWallet = ethers.getAddress(walletAddress);
  const fundingUniverse = await enrichWalletAssets({
    network,
    walletAddress: normalizedWallet,
    includeTokenAddresses: importTokenAddresses,
  });
  const provider = getProvider(getNetworkConfig(network));
  const [token0, token1] = await Promise.all([
    getTokenInfoFromChain(provider, token0Address),
    getTokenInfoFromChain(provider, token1Address),
  ]);
  const poolContext = await resolvePoolContext({
    network,
    version,
    token0,
    token1,
    fee: Number(fee),
    tickSpacing,
    hooks,
    poolId,
  });
  const currentPrice = poolContext.currentPrice;
  const allPrices = await marketService.getAllPrices().catch(() => ({}));
  const { token0UsdPrice, token1UsdPrice } = computeTargetUsdPrices({
    token0,
    token1,
    currentPrice,
    allPrices,
  });

  const targetAmounts = computeAmountsFromWeight(
    Number(targetWeightToken0Pct),
    Number(totalUsdTarget),
    token0UsdPrice,
    token1UsdPrice,
    token0.decimals,
    token1.decimals
  );

  const wrappedNative = getWrappedNativeToken(network);
  // El optimizador necesita conocer el wrapped native para tratar a `ETH`
  // como direct cuando WETH es uno de los lados del par.
  const optimalSelectionResult = buildOptimalFundingSelection({
    assets: fundingUniverse.assets,
    token0Address: token0.address,
    token1Address: token1.address,
    totalUsdTarget,
    targetWeightToken0Pct,
    wrappedNativeAddress: wrappedNative?.address || null,
  });

  const selectedAssets = buildSelectedFundingAssetsMap(
    fundingUniverse.assets,
    fundingSelections?.length
      ? fundingSelections
      : optimalSelectionResult.selection
  );

  const warnings = [];
  const swapPlan = [];
  const selectedFundingAssets = [];
  let remaining0 = BigInt(targetAmounts.amount0DesiredRaw);
  let remaining1 = BigInt(targetAmounts.amount1DesiredRaw);
  let finalAmount0Raw = 0n;
  let finalAmount1Raw = 0n;
  let directValueUsd = 0;
  let swapValueUsd = 0;
  let missingRouteCount = 0;

  for (const entry of selectedAssets) {
    const { asset } = entry;
    let availableRaw = BigInt(entry.requestedRaw);
    if (availableRaw <= 0n) continue;

    const directToken0 = asset.address.toLowerCase() === token0.address.toLowerCase()
      || (asset.isNative && wrappedNative && wrappedNative.address.toLowerCase() === token0.address.toLowerCase());
    const directToken1 = asset.address.toLowerCase() === token1.address.toLowerCase()
      || (asset.isNative && wrappedNative && wrappedNative.address.toLowerCase() === token1.address.toLowerCase());

    if (directToken0 && remaining0 > 0n) {
      const directRaw = availableRaw > remaining0 ? remaining0 : availableRaw;
      finalAmount0Raw += directRaw;
      remaining0 -= directRaw;
      availableRaw -= directRaw;
      directValueUsd += rawToAmount(directRaw, token0.decimals) * token0UsdPrice;
      selectedFundingAssets.push({
        assetId: asset.id,
        address: asset.address,
        symbol: asset.symbol,
        isNative: asset.isNative === true,
        balance: asset.balance,
        balanceRaw: asset.balanceRaw,
        useAmount: ethers.formatUnits(directRaw, asset.decimals),
        useAmountRaw: directRaw.toString(),
        usdValueUsed: rawToAmount(directRaw, token0.decimals) * token0UsdPrice,
        fundingRole: 'direct_token0',
      });
    }

    if (directToken1 && availableRaw > 0n && remaining1 > 0n) {
      const directRaw = availableRaw > remaining1 ? remaining1 : availableRaw;
      finalAmount1Raw += directRaw;
      remaining1 -= directRaw;
      availableRaw -= directRaw;
      directValueUsd += rawToAmount(directRaw, token1.decimals) * token1UsdPrice;
      selectedFundingAssets.push({
        assetId: asset.id,
        address: asset.address,
        symbol: asset.symbol,
        isNative: asset.isNative === true,
        balance: asset.balance,
        balanceRaw: asset.balanceRaw,
        useAmount: ethers.formatUnits(directRaw, asset.decimals),
        useAmountRaw: directRaw.toString(),
        usdValueUsed: rawToAmount(directRaw, token1.decimals) * token1UsdPrice,
        fundingRole: 'direct_token1',
      });
    }

    entry.remainingRaw = availableRaw;
  }

  // Iteración del swap planner: para CADA asset, intentamos drenarlo
  // mientras quede balance Y haya deficit en algún lado. Antes hacíamos
  // una sola pasada por asset (un swap target por iteración), lo cual
  // causaba que un asset con balance grande (ej. USDT $43) solo cubriera
  // UN lado del LP y dejara el otro sin fuente. Ahora el mismo asset
  // puede generar dos swaps: USDT → WETH (token0) + USDT → USDT0 (token1)
  // en secuencia, hasta agotar el balance o cubrir ambos lados.
  //
  // Límite de seguridad: máximo 4 iteraciones por asset (cubre el caso
  // más complejo: 2 sides × 2 hops cada uno). Más que eso indicaría un
  // bug de bookkeeping y queremos detectarlo.
  const MAX_ITERATIONS_PER_ASSET = 4;
  for (const entry of selectedAssets) {
    if (remaining0 <= 0n && remaining1 <= 0n) break;
    const { asset } = entry;

    const sourceToken = asset.isNative ? wrappedNative : asset;
    if (!sourceToken?.address) {
      if (BigInt(entry.remainingRaw || 0n) > 0n) {
        warnings.push(`No se pudo usar ${asset.symbol} como fuente de capital`);
      }
      continue;
    }

    const sourceUsdPrice = asset.address.toLowerCase() === token0.address.toLowerCase()
      ? token0UsdPrice
      : asset.address.toLowerCase() === token1.address.toLowerCase()
        ? token1UsdPrice
        : asset.usdPrice;
    if (!Number.isFinite(sourceUsdPrice) || sourceUsdPrice <= 0) {
      if (BigInt(entry.remainingRaw || 0n) > 0n) {
        warnings.push(`No se pudo valorar ${asset.symbol} en USD para planear swaps`);
      }
      continue;
    }

    let exhaustedTargets = new Set();
    let iterations = 0;
    while (iterations < MAX_ITERATIONS_PER_ASSET) {
      iterations += 1;
      let availableRaw = BigInt(entry.remainingRaw || 0n);
      if (availableRaw <= 0n) break;
      if (remaining0 <= 0n && remaining1 <= 0n) break;

      // Elegimos el lado con mayor déficit que NO hayamos descartado
      // antes (ej. una ruta no encontrada para este asset → ese target
      // queda fuera para los próximos intentos del mismo asset).
      let candidateTarget = pickTargetTokenByUsdDeficit({
        remaining0Raw: exhaustedTargets.has(token0.address.toLowerCase()) ? 0n : remaining0,
        remaining1Raw: exhaustedTargets.has(token1.address.toLowerCase()) ? 0n : remaining1,
        token0,
        token1,
        token0UsdPrice,
        token1UsdPrice,
      });
      const candidateRemainingRaw = candidateTarget.address.toLowerCase() === token0.address.toLowerCase() ? remaining0 : remaining1;
      // Si el candidato elegido tiene deficit 0 (porque el otro lado está
      // lleno y este lado fue marcado exhausted), salimos.
      if (candidateRemainingRaw <= 0n || exhaustedTargets.has(candidateTarget.address.toLowerCase())) break;

      const targetToken = candidateTarget;
      const targetUsdPrice = targetToken.address.toLowerCase() === token0.address.toLowerCase() ? token0UsdPrice : token1UsdPrice;
      const deficitRaw = candidateRemainingRaw;
      const deficitUsd = rawToAmount(deficitRaw, targetToken.decimals) * targetUsdPrice;
      const availableUsd = rawToAmount(availableRaw, asset.decimals) * sourceUsdPrice;
      const useUsd = Math.min(deficitUsd, availableUsd);
      // Skip dust swaps: si el valor del swap es menor que MIN_SWAP_USD,
      // los costos de gas + slippage del approve+swap superan el beneficio.
      // Aceptamos el sub-déficit y dejamos el dust en la wallet para que
      // el txPlan tenga menos firmas manuales.
      if (useUsd < MIN_SWAP_USD) {
        // Marcamos este target como exhausted para que la próxima
        // iteración intente con el otro lado en vez de quedarse loopeando.
        exhaustedTargets.add(targetToken.address.toLowerCase());
        if (exhaustedTargets.size >= 2) break;
        continue;
      }
      const amountInRaw = toRawAmount(useUsd / sourceUsdPrice, asset.decimals);
      if (amountInRaw <= 0n) break;

      const pivotTokens = wrappedNative ? [wrappedNative] : [];
      const route = await resolveBestRoute({
        provider,
        networkConfig: poolContext.networkConfig,
        tokenIn: sourceToken,
        tokenOut: targetToken,
        amountInRaw,
        maxSlippageBps,
        pivotTokens,
      });
      if (!route || !route.hops?.length) {
        // Este asset no tiene ruta a ESTE target. Marcamos el target
        // como exhausted PARA ESTE ASSET y reintentamos con el otro
        // lado (si todavía tiene déficit). NO incrementamos
        // missingRouteCount inmediatamente — solo lo hacemos si después
        // de agotar todos los targets el asset no aportó nada.
        exhaustedTargets.add(targetToken.address.toLowerCase());
        if (exhaustedTargets.size >= 2) {
          // Ambos targets fallaron para este asset. Solo entonces
          // reportamos missingRoute.
          missingRouteCount += 1;
          warnings.push(`No se encontro ruta de ${sourceToken.symbol} a ${targetToken.symbol} (probamos directo${pivotTokens.length ? ' y por ' + pivotTokens.map((p) => p.symbol).join('/') : ''})`);
          break;
        }
        continue;
      }

    // Cada hop es una tx exactInputSingle independiente. El primer hop arranca
    // con el amountIn del asset y los siguientes usan el minOut del anterior
    // como input (conservador: cualquier excedente queda en la wallet).
    for (let hopIndex = 0; hopIndex < route.hops.length; hopIndex += 1) {
      const hop = route.hops[hopIndex];
      const isFirstHop = hopIndex === 0;
      const isLastHop = hopIndex === route.hops.length - 1;
      swapPlan.push({
        sourceAssetId: asset.id,
        sourceSymbol: asset.symbol,
        requiresWrapNative: isFirstHop && asset.isNative === true,
        tokenIn: {
          address: hop.tokenIn.address,
          symbol: hop.tokenIn.symbol,
          decimals: hop.tokenIn.decimals,
        },
        tokenOut: {
          address: hop.tokenOut.address,
          symbol: hop.tokenOut.symbol,
          decimals: hop.tokenOut.decimals,
        },
        fee: hop.fee,
        routePoolAddress: hop.poolAddress,
        amountIn: ethers.formatUnits(hop.amountInRaw, hop.tokenIn.decimals),
        amountInRaw: hop.amountInRaw.toString(),
        estimatedAmountOut: hop.expectedOut,
        estimatedAmountOutRaw: hop.expectedOutRaw.toString(),
        amountOutMinimum: ethers.formatUnits(hop.amountOutMinimumRaw, hop.tokenOut.decimals),
        amountOutMinimumRaw: hop.amountOutMinimumRaw.toString(),
        estimatedSlippageBps: Number(maxSlippageBps),
        direction: isLastHop && targetToken.address.toLowerCase() === token0.address.toLowerCase() ? 'to_token0' : isLastHop ? 'to_token1' : 'hop',
        currentPrice: hop.currentPrice,
        wrapToken: isFirstHop && asset.isNative && wrappedNative ? wrappedNative : null,
        hopIndex,
        hopCount: route.hops.length,
      });
    }

    // Creditamos sólo el minOut del último hop al lado correspondiente del LP.
    const lastHop = route.hops[route.hops.length - 1];
    const creditedOutRaw = lastHop.amountOutMinimumRaw > 0n ? lastHop.amountOutMinimumRaw : lastHop.expectedOutRaw;

    if (targetToken.address.toLowerCase() === token0.address.toLowerCase()) {
      finalAmount0Raw += creditedOutRaw;
      remaining0 = remaining0 > creditedOutRaw ? remaining0 - creditedOutRaw : 0n;
    } else {
      finalAmount1Raw += creditedOutRaw;
      remaining1 = remaining1 > creditedOutRaw ? remaining1 - creditedOutRaw : 0n;
    }
    swapValueUsd += useUsd;
    entry.remainingRaw = availableRaw > amountInRaw ? availableRaw - amountInRaw : 0n;
    selectedFundingAssets.push({
      assetId: asset.id,
      address: asset.address,
      symbol: asset.symbol,
      isNative: asset.isNative === true,
      balance: asset.balance,
      balanceRaw: asset.balanceRaw,
      useAmount: ethers.formatUnits(amountInRaw, asset.decimals),
      useAmountRaw: amountInRaw.toString(),
      usdValueUsed: useUsd,
      fundingRole: 'swap_source',
    });
    // Si este asset todavía tiene balance Y todavía hay deficit en
    // algún lado, el while loop hace una iteración más para drenarlo.
    // El target del próximo iter se elige con pickTargetTokenByUsdDeficit
    // teniendo en cuenta los `exhaustedTargets` de este asset.
    } // ← cierra el while (MAX_ITERATIONS_PER_ASSET)
  }

  const finalValueUsd =
    (rawToAmount(finalAmount0Raw, token0.decimals) * token0UsdPrice)
    + (rawToAmount(finalAmount1Raw, token1.decimals) * token1UsdPrice);

  // Threshold de aceptación del plan: 0.93 (= aceptamos hasta 7% bajo el
  // target). Esto da margen para que el dust skipping (MIN_SWAP_USD) +
  // slippage real durante los swaps no haga fallar el plan en wallets
  // donde el balance es solo marginalmente superior al target.
  // Antes era 0.98 que era demasiado estricto y throwaba en casos válidos.
  if (finalValueUsd < (Number(totalUsdTarget) * 0.93) || finalAmount0Raw <= 0n || finalAmount1Raw <= 0n) {
    const diagnostics = summarizeFundingDiagnostics({
      network: poolContext.networkConfig.id,
      fundingUniverse,
      availableFundingAssets: fundingUniverse.assets,
      totalUsdTarget,
      deployableUsd: finalValueUsd,
      warnings,
    });
    const hasFundingAssets = (fundingUniverse.assets || []).some((asset) => BigInt(asset.usableBalanceRaw || asset.balanceRaw || '0') > 0n);
    const hasUsableNative = BigInt(fundingUniverse.gasReserve?.usableNativeRaw || '0') > 0n;
    const hasAnyDirectFunding = finalAmount0Raw > 0n || finalAmount1Raw > 0n;

    if (!hasFundingAssets) {
      logFundingFailure('INSUFFICIENT_SAME_NETWORK_BALANCE', {
        network: poolContext.networkConfig.id,
        walletAddress: normalizedWallet,
        totalUsdTarget: Number(totalUsdTarget),
        deployableUsd: Number(finalValueUsd.toFixed(2)),
      });
      throw buildFundingDomainError(
        'INSUFFICIENT_SAME_NETWORK_BALANCE',
        `No hay capital suficiente en ${poolContext.networkConfig.label} para fondear esta posición.`,
        diagnostics
      );
    }

    if (!hasUsableNative && (fundingUniverse.assets || []).filter((asset) => asset.isNative).length > 0 && (fundingUniverse.assets || []).length <= 1) {
      logFundingFailure('INSUFFICIENT_BALANCE_AFTER_GAS_RESERVE', {
        network: poolContext.networkConfig.id,
        walletAddress: normalizedWallet,
        totalUsdTarget: Number(totalUsdTarget),
        deployableUsd: Number(finalValueUsd.toFixed(2)),
      });
      throw buildFundingDomainError(
        'INSUFFICIENT_BALANCE_AFTER_GAS_RESERVE',
        `No hay capital suficiente en ${poolContext.networkConfig.label} después de reservar ${fundingUniverse.gasReserve?.reservedAmount || '0'} ${fundingUniverse.gasReserve?.symbol || ''} para gas.`,
        diagnostics
      );
    }

    if (missingRouteCount > 0 && !hasAnyDirectFunding) {
      logFundingFailure('NO_SUPPORTED_SWAP_ROUTE', {
        network: poolContext.networkConfig.id,
        walletAddress: normalizedWallet,
        totalUsdTarget: Number(totalUsdTarget),
        deployableUsd: Number(finalValueUsd.toFixed(2)),
        missingRouteCount,
      });
      throw buildFundingDomainError(
        'NO_SUPPORTED_SWAP_ROUTE',
        `No se encontró una ruta de swap soportada para completar el fondeo en ${poolContext.networkConfig.label}.`,
        diagnostics
      );
    }

    logFundingFailure('INSUFFICIENT_DIRECT_OR_SWAP_OUTPUT', {
      network: poolContext.networkConfig.id,
      walletAddress: normalizedWallet,
      totalUsdTarget: Number(totalUsdTarget),
      deployableUsd: Number(finalValueUsd.toFixed(2)),
      missingRouteCount,
    });
    throw buildFundingDomainError(
      'INSUFFICIENT_DIRECT_OR_SWAP_OUTPUT',
      `No se pudo fondear el LP en ${poolContext.networkConfig.label} respetando la reserva de gas, el slippage y las rutas soportadas.`,
      diagnostics
    );
  }

  return {
    network: poolContext.networkConfig.id,
    version: poolContext.version,
    walletAddress: normalizedWallet,
    token0,
    token1,
    currentPrice,
    poolAddress: poolContext.poolAddress,
    poolId: poolContext.poolId,
    poolToken0Address: poolContext.poolToken0Address,
    poolToken1Address: poolContext.poolToken1Address,
    requestedTokenOrderReversed: poolContext.requestedTokenOrderReversed === true,
    tickSpacing: poolContext.tickSpacing,
    hooks: poolContext.hooks || ZERO_HOOKS_ADDRESS,
    fee: Number(fee),
    rangeLowerPrice: Number(rangeLowerPrice),
    rangeUpperPrice: Number(rangeUpperPrice),
    targetWeightToken0Pct: Number(targetWeightToken0Pct),
    gasReserve: fundingUniverse.gasReserve,
    availableFundingAssets: fundingUniverse.assets,
    selectedFundingAssets,
    fundingPlan: {
      totalUsdTarget: Number(totalUsdTarget),
      deployableUsd: Number(finalValueUsd.toFixed(2)),
      directValueUsd: Number(directValueUsd.toFixed(2)),
      swapValueUsd: Number(swapValueUsd.toFixed(2)),
      estimatedPoolValueUsd: Number(finalValueUsd.toFixed(2)),
      swapCount: swapPlan.length,
    },
    // El planner devuelve la selección óptima (calculada con
    // `buildOptimalFundingSelection`) por separado. Si el usuario manualmente
    // eligió un subset diferente, el cliente puede comparar ambos y mostrar
    // un botón "Usar recomendado" cuando minimice swaps.
    recommendedFundingSelection: optimalSelectionResult.selection,
    recommendedSwapCount: optimalSelectionResult.estimatedSwapCount,
    wrappedNativeAddress: wrappedNative?.address || null,
    swapPlan,
    expectedPostSwapBalances: {
      amount0: ethers.formatUnits(finalAmount0Raw, token0.decimals),
      amount0Raw: finalAmount0Raw.toString(),
      amount1: ethers.formatUnits(finalAmount1Raw, token1.decimals),
      amount1Raw: finalAmount1Raw.toString(),
    },
    warnings,
  };
}

async function getSuggestions({
  network,
  version,
  walletAddress,
  token0Address,
  token1Address,
  fee,
  totalUsdTarget,
  totalUsdHint,
  tickSpacing,
  hooks,
  poolId,
}) {
  try {
    const networkConfig = getNetworkConfig(network);
    const provider = getProvider(networkConfig);
    const knownTokens = getKnownTokens(network);
    const token0Info = knownTokens.find((t) => t.address.toLowerCase() === token0Address.toLowerCase())
      || await getTokenInfoFromChain(provider, token0Address);
    const token1Info = knownTokens.find((t) => t.address.toLowerCase() === token1Address.toLowerCase())
      || await getTokenInfoFromChain(provider, token1Address);
    const poolContext = await resolvePoolContext({
      network,
      version,
      token0: token0Info,
      token1: token1Info,
      fee: Number(fee),
      tickSpacing,
      hooks,
      poolId,
    });
    const balances = await enrichWalletAssets({
      network,
      walletAddress,
      includeTokenAddresses: [token0Info.address, token1Info.address],
    });

    const totalUsd = Number(totalUsdTarget ?? totalUsdHint ?? 0);
    const currentPrice = Number(poolContext.currentPrice);
    const volatileAsset = resolveVolatileAsset(token0Info.symbol, token1Info.symbol);
    const atr14 = await fetchAtr14(volatileAsset);
    const hasAtr = atr14 != null && atr14 > 0;
    const rangeSuggestions = computeRangeSuggestions(currentPrice, atr14, hasAtr);
    const allPrices = await marketService.getAllPrices().catch(() => ({}));
    const { token0UsdPrice, token1UsdPrice } = computeTargetUsdPrices({
      token0: token0Info,
      token1: token1Info,
      currentPrice,
      allPrices,
    });
    const suggestions = rangeSuggestions.map((item) => {
      const token0Pct = computeToken0Pct(currentPrice, item.rangeLowerPrice, item.rangeUpperPrice);
      const amounts = totalUsd > 0
        ? computeAmountsFromWeight(
            token0Pct,
            totalUsd,
            token0UsdPrice,
            token1UsdPrice,
            token0Info.decimals,
            token1Info.decimals
          )
        : {
            amount0Desired: '0',
            amount1Desired: '0',
            amount0DesiredRaw: '0',
            amount1DesiredRaw: '0',
          };

      return {
        ...item,
        targetWeightToken0Pct: token0Pct,
        amount0Desired: amounts.amount0Desired,
        amount1Desired: amounts.amount1Desired,
      };
    });

    const token0Balance = balances.assets.find((asset) => asset.address?.toLowerCase() === token0Info.address.toLowerCase());
    const token1Balance = balances.assets.find((asset) => asset.address?.toLowerCase() === token1Info.address.toLowerCase());

    return {
      token0: {
        address: token0Info.address,
        symbol: token0Info.symbol,
        decimals: token0Info.decimals,
        balance: token0Balance?.balance || '0',
        balanceRaw: token0Balance?.balanceRaw || '0',
        usdPrice: token0UsdPrice,
      },
      token1: {
        address: token1Info.address,
        symbol: token1Info.symbol,
        decimals: token1Info.decimals,
        balance: token1Balance?.balance || '0',
        balanceRaw: token1Balance?.balanceRaw || '0',
        usdPrice: token1UsdPrice,
      },
      currentPrice: Number(currentPrice.toFixed(6)),
      volatileAsset,
      atr14: hasAtr ? Number(atr14.toFixed(4)) : null,
      tickSpacing: poolContext.tickSpacing,
      hooks: poolContext.hooks || ZERO_HOOKS_ADDRESS,
      poolAddress: poolContext.poolAddress,
      poolId: poolContext.poolId,
      poolToken0Address: poolContext.poolToken0Address,
      poolToken1Address: poolContext.poolToken1Address,
      requestedTokenOrderReversed: poolContext.requestedTokenOrderReversed === true,
      validation: {
        poolExists: true,
        hooksSupported: !hasHooks(poolContext.hooks || ZERO_HOOKS_ADDRESS),
      },
      gasReserve: balances.gasReserve,
      suggestions,
    };
  } catch (err) {
    logger.error('smart_pool_creator_get_suggestions_failed', {
      walletAddress,
      token0Address,
      token1Address,
      error: err.message,
    });
    throw err;
  }
}

async function getWalletAssets({ network, walletAddress, importTokenAddresses = [] }) {
  const result = await enrichWalletAssets({
    network,
    walletAddress,
    includeTokenAddresses: importTokenAddresses,
  });
  return {
    network: result.network,
    walletAddress: result.walletAddress,
    gasReserve: result.gasReserve,
    assets: result.assets,
  };
}

/**
 * Wrapper delgado que reusa `buildFundingPlan` para el flujo de
 * increase-liquidity sobre una posición existente. La diferencia clave con
 * el flujo de create-position es que aquí el `targetWeightToken0Pct` NO lo
 * elige el usuario: lo derivamos del rango ya fijo de la posición y del
 * precio actual via `computeToken0Pct`.
 *
 * Si el precio está fuera del rango (rawWeight = 0 o 100), clampeamos a
 * 0.1/99.9 para que `buildFundingPlan` no rechace single-side y agregamos
 * un warning para que el modal informe al usuario.
 */
async function buildIncreaseLiquidityFundingPlan({
  network,
  version,
  walletAddress,
  token0Address,
  token1Address,
  fee,
  tickSpacing,
  hooks,
  poolId,
  rangeLowerPrice,
  rangeUpperPrice,
  currentPrice,
  totalUsdTarget,
  fundingSelections,
  importTokenAddresses = [],
  maxSlippageBps,
}) {
  const rawWeight = computeToken0Pct(
    Number(currentPrice || 0),
    Number(rangeLowerPrice),
    Number(rangeUpperPrice),
  );
  const targetWeightToken0Pct = Math.max(0.1, Math.min(99.9, rawWeight));

  const plan = await buildFundingPlan({
    network,
    version,
    walletAddress,
    token0Address,
    token1Address,
    fee,
    tickSpacing,
    hooks,
    poolId,
    totalUsdTarget,
    targetWeightToken0Pct,
    rangeLowerPrice,
    rangeUpperPrice,
    fundingSelections,
    importTokenAddresses,
    maxSlippageBps,
  });

  if (targetWeightToken0Pct !== rawWeight) {
    plan.warnings.push(
      'El precio actual está fuera del rango de la posición; el fondeo será de un solo lado.'
    );
  }
  return plan;
}

module.exports = {
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_V4_TICK_SPACING_BY_FEE,
  MIN_SWAP_USD,
  buildAutoFundingSelection,
  buildOptimalFundingSelection,
  buildFundingPlan,
  buildIncreaseLiquidityFundingPlan,
  computeAmountsFromWeight,
  computeRangeSuggestions,
  computeToken0Pct,
  getCanonicalUsdcToken,
  getGasReserveAmount,
  getKnownTokens,
  getSuggestions,
  getWrappedNativeToken,
  getWalletAssets,
  orientPriceToSelectedOrder,
  orientRangeToCanonicalOrder,
  pickTargetTokenByUsdDeficit,
  resolveBestDirectRoute,
  resolveBestRoute,
  sortTokensByAddress,
};
