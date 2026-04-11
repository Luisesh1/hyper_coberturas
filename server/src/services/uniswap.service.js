const { ethers } = require('ethers');
const config = require('../config');
const settingsService = require('./settings.service');
const etherscanQueueService = require('./etherscan-queue.service');
const timeInRangeService = require('./time-in-range.service');
const logger = require('./logger.service');
const onChainManager = require('./onchain-manager.service');
const {
  ValidationError,
} = require('../errors/app-error');
const {
  compactNumber,
  tickToPrice,
  tickToRawSqrtRatio,
  sqrtPriceX96ToFloat,
  liquidityToTokenAmounts,
  computeDistanceToRange,
  computePnlMetrics,
} = require('./uniswap/pool-math');
const {
  estimateTvlApproxUsd,
  estimateUsdValueFromPair,
} = require('./uniswap/pricing');
const {
  computeV3UnclaimedFees,
  computeV4UnclaimedFees,
} = require('./uniswap/fee-calculator');
const {
  normalizeAddress,
  lower,
  formatTokenAmount,
  buildLiquiditySummary,
  buildWarningsWithDedup,
  extractMintInputAmounts,
  resolveInitialValuation,
  decodeV4PositionInfo,
  resolveHistoricalSpotPrice,
  computeRangeVisual,
  buildLpMeta,
  getExplorerLink,
} = require('./uniswap/scan-helpers');

const {
  ERC20_ABI,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V3_POSITION_MANAGER_ABI,
  V4_STATE_VIEW_ABI,
  V4_POSITION_MANAGER_ABI,
} = require('./uniswap/abis');

const V1_EXCHANGE_ABI = [
  'function totalSupply() view returns (uint256)',
];

const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
];

const EVENT_ABIS = {
  v1: 'event NewExchange(address indexed token, address indexed exchange)',
  v2: 'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
  v3: 'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  v4: 'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
};

const DEFAULT_TIMEOUT_MS = config.uniswap.scanTimeoutMs;
const TXLIST_PAGE_SIZE = 1000;
const MAX_TXLIST_PAGES = 5;
const NFT_PAGE_SIZE = 100;
const MAX_NFT_PAGES = 5;
const tokenCache = new Map();
const receiptCache = new Map();
const blockCache = new Map();

const { SUPPORTED_NETWORKS } = require('./uniswap/networks');

function annotatePoolsForUser(args) {
  const { annotatePoolsWithProtection } = require('./uniswap-protection.service');
  return annotatePoolsWithProtection(args);
}

function getSupportMatrix() {
  const networks = Object.values(SUPPORTED_NETWORKS).map((network) => ({
    id: network.id,
    label: network.label,
    chainId: network.chainId,
    nativeSymbol: network.nativeSymbol,
    explorerUrl: network.explorerUrl,
    versions: network.versions,
  }));

  return {
    networks,
    versions: ['v1', 'v2', 'v3', 'v4'],
  };
}

function validateRequest({ wallet, network, version }) {
  if (!wallet || !network || !version) {
    throw new ValidationError('wallet, network y version son requeridos');
  }

  let normalizedWallet;
  try {
    normalizedWallet = ethers.getAddress(wallet);
  } catch {
    throw new ValidationError('wallet invalida');
  }

  const networkConfig = SUPPORTED_NETWORKS[network];
  if (!networkConfig) {
    throw new ValidationError(`network no soportada: ${network}`);
  }

  if (!networkConfig.versions.includes(version)) {
    throw new ValidationError(`${version.toUpperCase()} no esta soportada en ${networkConfig.label}`);
  }

  return { wallet: normalizedWallet, networkConfig, version };
}

function getProvider(networkConfig) {
  return onChainManager.getProvider(networkConfig, { scope: 'uniswap.service' });
}

function getContract(networkConfig, address, abi) {
  return onChainManager.getContract({
    networkConfig,
    address,
    abi,
    scope: 'uniswap.service',
  });
}

async function getTokenMeta(provider, networkConfig, address) {
  const normalized = normalizeAddress(address);

  if (!normalized || normalized === ethers.ZeroAddress) {
    return {
      address: ethers.ZeroAddress,
      symbol: networkConfig.nativeSymbol,
      decimals: 18,
      isNative: true,
    };
  }

  const key = `${networkConfig.id}:${normalized}`;
  if (tokenCache.has(key)) return tokenCache.get(key);

  const contract = onChainManager.getContract({ runner: provider, address: normalized, abi: ERC20_ABI });
  let symbol = `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
  let decimals = 18;

  try {
    symbol = await contract.symbol();
  } catch {
    // noop
  }

  try {
    decimals = Number(await contract.decimals());
  } catch {
    // noop
  }

  const meta = {
    address: normalized,
    symbol,
    decimals,
    isNative: false,
  };

  tokenCache.set(key, meta);
  return meta;
}

async function getReceipt(provider, txHash) {
  if (receiptCache.has(txHash)) return receiptCache.get(txHash);
  const receipt = await provider.getTransactionReceipt(txHash);
  receiptCache.set(txHash, receipt);
  return receipt;
}

async function getBlockTimestamp(provider, networkConfig, blockNumber) {
  const key = `${networkConfig.id}:${blockNumber}`;
  if (blockCache.has(key)) return blockCache.get(key);

  const block = await provider.getBlock(blockNumber);
  const timestamp = Number(block?.timestamp || 0);
  blockCache.set(key, timestamp);
  return timestamp;
}

function buildInterface(version) {
  return new ethers.Interface([EVENT_ABIS[version]]);
}

function getEventName(version) {
  if (version === 'v1') return 'NewExchange';
  if (version === 'v2') return 'PairCreated';
  if (version === 'v3') return 'PoolCreated';
  return 'Initialize';
}

function parseCreationLogs(version, receipt, eventSource) {
  const iface = buildInterface(version);
  const eventName = getEventName(version);
  const expectedSource = lower(eventSource);

  return receipt.logs
    .filter((log) => lower(log.address) === expectedSource)
    .map((log) => {
      try {
        const parsed = iface.parseLog(log);
        if (!parsed || parsed.name !== eventName) return null;
        return { log, parsed };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildBaseRecord(networkConfig, version, tx, parsedEntry, source = 'etherscan') {
  const args = parsedEntry.parsed.args;
  const logIndex = parsedEntry.log.index ?? parsedEntry.log.logIndex ?? 0;

  if (version === 'v1') {
    return {
      id: `${version}:${networkConfig.id}:${tx.hash}:${logIndex}`,
      version,
      network: networkConfig.id,
      networkLabel: networkConfig.label,
      chainId: networkConfig.chainId,
      creator: tx.from,
      txHash: tx.hash,
      txUrl: getExplorerLink(networkConfig.explorerUrl, 'tx', tx.hash),
      blockNumber: tx.blockNumber,
      createdAt: tx.timestamp || null,
      explorerUrl: networkConfig.explorerUrl,
      source,
      completeness: 'full',
      token0Address: ethers.ZeroAddress,
      token1Address: normalizeAddress(args.token),
      poolAddress: normalizeAddress(args.exchange),
      identifier: normalizeAddress(args.exchange),
      factoryAddress: normalizeAddress(networkConfig.deployments.v1.eventSource),
    };
  }

  if (version === 'v2') {
    return {
      id: `${version}:${networkConfig.id}:${tx.hash}:${logIndex}`,
      version,
      network: networkConfig.id,
      networkLabel: networkConfig.label,
      chainId: networkConfig.chainId,
      creator: tx.from,
      txHash: tx.hash,
      txUrl: getExplorerLink(networkConfig.explorerUrl, 'tx', tx.hash),
      blockNumber: tx.blockNumber,
      createdAt: tx.timestamp || null,
      explorerUrl: networkConfig.explorerUrl,
      source,
      completeness: 'full',
      token0Address: normalizeAddress(args.token0),
      token1Address: normalizeAddress(args.token1),
      poolAddress: normalizeAddress(args.pair),
      identifier: normalizeAddress(args.pair),
      factoryAddress: normalizeAddress(networkConfig.deployments.v2.eventSource),
    };
  }

  if (version === 'v3') {
    return {
      id: `${version}:${networkConfig.id}:${tx.hash}:${logIndex}`,
      version,
      network: networkConfig.id,
      networkLabel: networkConfig.label,
      chainId: networkConfig.chainId,
      creator: tx.from,
      txHash: tx.hash,
      txUrl: getExplorerLink(networkConfig.explorerUrl, 'tx', tx.hash),
      blockNumber: tx.blockNumber,
      createdAt: tx.timestamp || null,
      explorerUrl: networkConfig.explorerUrl,
      source,
      completeness: 'full',
      token0Address: normalizeAddress(args.token0),
      token1Address: normalizeAddress(args.token1),
      poolAddress: normalizeAddress(args.pool),
      identifier: normalizeAddress(args.pool),
      fee: Number(args.fee),
      tickSpacing: Number(args.tickSpacing),
      factoryAddress: normalizeAddress(networkConfig.deployments.v3.eventSource),
    };
  }

  return {
    id: `${version}:${networkConfig.id}:${tx.hash}:${logIndex}`,
    version,
    network: networkConfig.id,
    networkLabel: networkConfig.label,
    chainId: networkConfig.chainId,
    creator: tx.from,
    txHash: tx.hash,
    txUrl: getExplorerLink(networkConfig.explorerUrl, 'tx', tx.hash),
    blockNumber: tx.blockNumber,
    createdAt: tx.timestamp || null,
    explorerUrl: networkConfig.explorerUrl,
    source,
    completeness: 'full',
    token0Address: normalizeAddress(args.currency0),
    token1Address: normalizeAddress(args.currency1),
    poolAddress: null,
    identifier: String(args.id),
    fee: Number(args.fee),
    tickSpacing: Number(args.tickSpacing),
    hooks: normalizeAddress(args.hooks),
    poolManagerAddress: normalizeAddress(networkConfig.deployments.v4.eventSource),
    initialSqrtPriceX96: String(args.sqrtPriceX96),
    initialTick: Number(args.tick),
  };
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function consume() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

function getConfiguredApiKey(userConfig) {
  const apiKey = String(userConfig?.apiKey || '').trim();
  if (!apiKey) {
    throw new ValidationError('Configura tu API key de Etherscan en Config antes de escanear pools');
  }
  return apiKey;
}

async function etherscanRequest(apiKey, params) {
  return etherscanQueueService.request(apiKey, params, {
    requestTimeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

async function fetchWalletTransactions(apiKey, networkConfig, wallet) {
  const all = [];
  let truncated = false;

  for (let page = 1; page <= MAX_TXLIST_PAGES; page += 1) {
    const rows = await etherscanRequest(apiKey, {
      chainid: networkConfig.chainId,
      module: 'account',
      action: 'txlist',
      address: wallet,
      startblock: 0,
      endblock: 99999999,
      sort: 'desc',
      page,
      offset: TXLIST_PAGE_SIZE,
    });

    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);

    if (rows.length < TXLIST_PAGE_SIZE) break;
    if (page === MAX_TXLIST_PAGES) {
      truncated = true;
    }
  }

  return { rows: all, truncated };
}

async function fetchWalletNftTransfers(apiKey, networkConfig, wallet, contractAddress) {
  const all = [];
  let truncated = false;

  for (let page = 1; page <= MAX_NFT_PAGES; page += 1) {
    const rows = await etherscanRequest(apiKey, {
      chainid: networkConfig.chainId,
      module: 'account',
      action: 'tokennfttx',
      address: wallet,
      contractaddress: contractAddress,
      page,
      offset: NFT_PAGE_SIZE,
      sort: 'asc',
    });

    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);

    if (rows.length < NFT_PAGE_SIZE) break;
    if (page === MAX_NFT_PAGES) {
      truncated = true;
    }
  }

  return { rows: all, truncated };
}

function collectHeldTokenIds(wallet, transfers) {
  const ownership = new Map();
  const firstInbound = new Map();
  const normalizedWallet = lower(wallet);

  for (const row of transfers) {
    const tokenId = String(row.tokenID || '');
    if (!tokenId) continue;

    if (lower(row.to) === normalizedWallet) {
      ownership.set(tokenId, true);
      if (!firstInbound.has(tokenId)) {
        firstInbound.set(tokenId, {
          txHash: row.hash || null,
          createdAt: Number(row.timeStamp || 0) || null,
          blockNumber: Number(row.blockNumber || 0) || null,
        });
      }
      continue;
    }

    if (lower(row.from) === normalizedWallet) {
      ownership.set(tokenId, false);
    }
  }

  return {
    tokenIds: [...ownership.entries()]
      .filter(([, owned]) => owned)
      .map(([tokenId]) => tokenId),
    firstInbound,
  };
}

async function getUserApiKey(userId) {
  const etherscan = await settingsService.getEtherscan(userId);
  return getConfiguredApiKey(etherscan);
}

async function testUserEtherscanKey(userId) {
  const apiKey = await getUserApiKey(userId);
  const result = await etherscanRequest(apiKey, {
    chainid: 1,
    module: 'account',
    action: 'balance',
    address: ethers.ZeroAddress,
    tag: 'latest',
  });

  return {
    valid: true,
    sampleResult: result,
  };
}

async function enrichV1Record(provider, networkConfig, record) {
  const [token0, token1] = await Promise.all([
    getTokenMeta(provider, networkConfig, ethers.ZeroAddress),
    getTokenMeta(provider, networkConfig, record.token1Address),
  ]);

  const tokenContract = onChainManager.getContract({ runner: provider, address: token1.address, abi: ERC20_ABI });
  const exchangeContract = onChainManager.getContract({ runner: provider, address: record.poolAddress, abi: V1_EXCHANGE_ABI });

  const [ethReserveRaw, tokenReserveRaw, totalSupplyRaw] = await Promise.all([
    provider.getBalance(record.poolAddress),
    tokenContract.balanceOf(record.poolAddress),
    exchangeContract.totalSupply().catch(() => 0n),
  ]);

  const reserve0 = formatTokenAmount(ethReserveRaw, token0.decimals);
  const reserve1 = formatTokenAmount(tokenReserveRaw, token1.decimals);
  const totalSupply = formatTokenAmount(totalSupplyRaw, 18);
  const active = ethReserveRaw > 0n && tokenReserveRaw > 0n;
  const priceApprox = Number(reserve1) > 0 && Number(reserve0) > 0
    ? compactNumber(Number(reserve1) / Number(reserve0), 6)
    : null;
  const tvlApproxUsd = estimateTvlApproxUsd(token0, reserve0, token1, reserve1);

  return {
    ...record,
    token0,
    token1,
    poolUrl: getExplorerLink(networkConfig.explorerUrl, 'address', record.poolAddress),
    status: active ? 'active' : 'empty',
    liquidity: null,
    totalSupply,
    reserve0,
    reserve1,
    priceApprox,
    priceQuoteSymbol: token1.symbol,
    priceBaseSymbol: token0.symbol,
    tvlApproxUsd,
    liquiditySummary: buildLiquiditySummary(active ? 'active' : 'empty', [
      `ETH: ${compactNumber(reserve0, 4) ?? 0}`,
      `${token1.symbol}: ${compactNumber(reserve1, 2) ?? 0}`,
      totalSupply ? `LP supply: ${compactNumber(totalSupply, 2) ?? 0}` : null,
    ]),
  };
}

async function enrichV2Record(provider, networkConfig, record) {
  const [token0, token1] = await Promise.all([
    getTokenMeta(provider, networkConfig, record.token0Address),
    getTokenMeta(provider, networkConfig, record.token1Address),
  ]);

  const pair = onChainManager.getContract({ runner: provider, address: record.poolAddress, abi: V2_PAIR_ABI });
  const [{ reserve0: reserve0Raw, reserve1: reserve1Raw }, totalSupplyRaw] = await Promise.all([
    pair.getReserves(),
    pair.totalSupply().catch(() => 0n),
  ]);

  const reserve0 = formatTokenAmount(reserve0Raw, token0.decimals);
  const reserve1 = formatTokenAmount(reserve1Raw, token1.decimals);
  const totalSupply = formatTokenAmount(totalSupplyRaw, 18);
  const active = reserve0Raw > 0n && reserve1Raw > 0n;
  const priceApprox = Number(reserve0) > 0 ? compactNumber(Number(reserve1) / Number(reserve0), 6) : null;
  const tvlApproxUsd = estimateTvlApproxUsd(token0, reserve0, token1, reserve1);

  return {
    ...record,
    token0,
    token1,
    poolUrl: getExplorerLink(networkConfig.explorerUrl, 'address', record.poolAddress),
    status: active ? 'active' : 'empty',
    liquidity: null,
    totalSupply,
    reserve0,
    reserve1,
    priceApprox,
    priceQuoteSymbol: token1.symbol,
    priceBaseSymbol: token0.symbol,
    tvlApproxUsd,
    liquiditySummary: buildLiquiditySummary(active ? 'active' : 'empty', [
      `${token0.symbol}: ${compactNumber(reserve0, 4) ?? 0}`,
      `${token1.symbol}: ${compactNumber(reserve1, 4) ?? 0}`,
      totalSupply ? `LP supply: ${compactNumber(totalSupply, 2) ?? 0}` : null,
    ]),
  };
}

async function enrichV3Record(provider, networkConfig, record, apiKey = null, options = {}) {
  const lightweight = options.lightweight === true;
  const [token0, token1] = await Promise.all([
    getTokenMeta(provider, networkConfig, record.token0Address),
    getTokenMeta(provider, networkConfig, record.token1Address),
  ]);

  const pool = onChainManager.getContract({ runner: provider, address: record.poolAddress, abi: V3_POOL_ABI });
  const token0Contract = token0.isNative ? null : onChainManager.getContract({ runner: provider, address: token0.address, abi: ERC20_ABI });
  const token1Contract = token1.isNative ? null : onChainManager.getContract({ runner: provider, address: token1.address, abi: ERC20_ABI });

  // Multicall3: 8 reads del pool en 1 sola RPC. Si Multicall3 no existe en
  // la red caemos al path legacy con Promise.all (8 roundtrips).
  let liquidityRaw;
  let slot0;
  let balance0Raw;
  let balance1Raw;
  let fg0Raw;
  let fg1Raw;
  let tickLowerInfo;
  let tickUpperInfo;
  try {
    const calls = [
      { target: record.poolAddress, abi: V3_POOL_ABI, method: 'liquidity' },
      { target: record.poolAddress, abi: V3_POOL_ABI, method: 'slot0' },
      { target: record.poolAddress, abi: V3_POOL_ABI, method: 'feeGrowthGlobal0X128', allowFailure: true },
      { target: record.poolAddress, abi: V3_POOL_ABI, method: 'feeGrowthGlobal1X128', allowFailure: true },
      { target: record.poolAddress, abi: V3_POOL_ABI, method: 'ticks', args: [record.tickLower], allowFailure: true },
      { target: record.poolAddress, abi: V3_POOL_ABI, method: 'ticks', args: [record.tickUpper], allowFailure: true },
    ];
    if (token0.isNative) {
      calls.push({ target: onChainManager.MULTICALL3_ADDRESS || '0xcA11bde05977b3631167028862bE2a173976CA11', abi: ['function getEthBalance(address) view returns (uint256)'], method: 'getEthBalance', args: [record.poolAddress], allowFailure: true });
    } else {
      calls.push({ target: token0.address, abi: ERC20_ABI, method: 'balanceOf', args: [record.poolAddress], allowFailure: true });
    }
    if (token1.isNative) {
      calls.push({ target: onChainManager.MULTICALL3_ADDRESS || '0xcA11bde05977b3631167028862bE2a173976CA11', abi: ['function getEthBalance(address) view returns (uint256)'], method: 'getEthBalance', args: [record.poolAddress], allowFailure: true });
    } else {
      calls.push({ target: token1.address, abi: ERC20_ABI, method: 'balanceOf', args: [record.poolAddress], allowFailure: true });
    }

    const results = await onChainManager.aggregate({
      networkConfig,
      scope: 'uniswap-service-enrich-v3',
      calls,
    });
    liquidityRaw = BigInt(results[0].value);
    slot0 = results[1].value;
    fg0Raw = results[2].success ? BigInt(results[2].value) : 0n;
    fg1Raw = results[3].success ? BigInt(results[3].value) : 0n;
    if (results[4].success) {
      tickLowerInfo = results[4].value;
    } else {
      logger.warn('pool tick read failed (multicall)', { tick: record.tickLower, error: results[4].error?.message });
      tickLowerInfo = null;
    }
    if (results[5].success) {
      tickUpperInfo = results[5].value;
    } else {
      logger.warn('pool tick read failed (multicall)', { tick: record.tickUpper, error: results[5].error?.message });
      tickUpperInfo = null;
    }
    balance0Raw = results[6].success ? BigInt(results[6].value) : 0n;
    balance1Raw = results[7].success ? BigInt(results[7].value) : 0n;
  } catch (mcErr) {
    logger.warn('enrich_v3_record_multicall_fallback', {
      poolAddress: record.poolAddress,
      network: networkConfig?.id,
      error: mcErr?.message,
      code: mcErr?.code,
    });
    [liquidityRaw, slot0, balance0Raw, balance1Raw, fg0Raw, fg1Raw, tickLowerInfo, tickUpperInfo] = await Promise.all([
      pool.liquidity(),
      pool.slot0(),
      token0.isNative ? provider.getBalance(record.poolAddress) : token0Contract.balanceOf(record.poolAddress),
      token1.isNative ? provider.getBalance(record.poolAddress) : token1Contract.balanceOf(record.poolAddress),
      pool.feeGrowthGlobal0X128().catch(() => 0n),
      pool.feeGrowthGlobal1X128().catch(() => 0n),
      pool.ticks(record.tickLower).catch((err) => { logger.warn('pool tick read failed', { tick: record.tickLower, error: err.message }); return null; }),
      pool.ticks(record.tickUpper).catch((err) => { logger.warn('pool tick read failed', { tick: record.tickUpper, error: err.message }); return null; }),
    ]);
  }

  const reserve0 = formatTokenAmount(balance0Raw, token0.decimals);
  const reserve1 = formatTokenAmount(balance1Raw, token1.decimals);
  const poolLiquidity = String(liquidityRaw);
  const positionLiquidity = String(record.positionLiquidity || '0');
  const active = BigInt(positionLiquidity) > 0n;
  const priceCurrent = compactNumber(tickToPrice(slot0.tick, token0.decimals, token1.decimals), 6);
  const tvlApproxUsd = estimateTvlApproxUsd(token0, reserve0, token1, reserve1);
  const rangeLowerPrice = compactNumber(tickToPrice(record.tickLower, token0.decimals, token1.decimals), 6);
  const rangeUpperPrice = compactNumber(tickToPrice(record.tickUpper, token0.decimals, token1.decimals), 6);
  const historicalPrice = lightweight
    ? { tick: null, price: null, sqrtPriceX96: null, accuracy: 'unavailable', blockNumber: null }
    : await resolveHistoricalSpotPrice({
      blockNumber: record.mintBlockNumber,
      fetchAtBlock: async (blockTag) => {
        const historicalSlot0 = await pool.slot0({ blockTag });
        return {
          tick: Number(historicalSlot0.tick),
          price: tickToPrice(historicalSlot0.tick, token0.decimals, token1.decimals),
          sqrtPriceX96: historicalSlot0.sqrtPriceX96,
        };
      },
    });
  const inRange =
    record.tickLower != null &&
    record.tickUpper != null &&
    Number(slot0.tick) >= Number(record.tickLower) &&
    Number(slot0.tick) <= Number(record.tickUpper);
  const lpMeta = buildLpMeta(record);
  const currentAmounts = liquidityToTokenAmounts({
    liquidity: positionLiquidity,
    sqrtPriceX96: slot0.sqrtPriceX96,
    tickLower: record.tickLower,
    tickUpper: record.tickUpper,
    token0Decimals: token0.decimals,
    token1Decimals: token1.decimals,
  });
  const initialAmounts = historicalPrice.tick != null
    ? liquidityToTokenAmounts({
      liquidity: positionLiquidity,
      sqrtPriceX96: historicalPrice.sqrtPriceX96,
      tickCurrent: historicalPrice.tick,
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      token0Decimals: token0.decimals,
      token1Decimals: token1.decimals,
    })
    : { amount0: null, amount1: null };
  // Calcular fees reales desde fee growth del pool (tokensOwed solo tiene fees pre-snapshotted)
  let unclaimedFees0, unclaimedFees1;
  if (tickLowerInfo && tickUpperInfo) {
    const realFees = computeV3UnclaimedFees({
      liquidity: positionLiquidity,
      tickCurrent: Number(slot0.tick),
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      feeGrowthGlobal0X128: String(fg0Raw),
      feeGrowthGlobal1X128: String(fg1Raw),
      feeGrowthOutsideLower0X128: String(tickLowerInfo.feeGrowthOutside0X128),
      feeGrowthOutsideLower1X128: String(tickLowerInfo.feeGrowthOutside1X128),
      feeGrowthOutsideUpper0X128: String(tickUpperInfo.feeGrowthOutside0X128),
      feeGrowthOutsideUpper1X128: String(tickUpperInfo.feeGrowthOutside1X128),
      feeGrowthInside0LastX128: record.feeGrowthInside0LastX128,
      feeGrowthInside1LastX128: record.feeGrowthInside1LastX128,
      tokensOwed0: record.tokensOwed0,
      tokensOwed1: record.tokensOwed1,
    });
    unclaimedFees0 = compactNumber(formatTokenAmount(realFees.fees0, token0.decimals), 8);
    unclaimedFees1 = compactNumber(formatTokenAmount(realFees.fees1, token1.decimals), 8);
  } else {
    // Fallback a tokensOwed si no se pudieron leer los ticks
    unclaimedFees0 = compactNumber(formatTokenAmount(record.tokensOwed0 || '0', token0.decimals), 8);
    unclaimedFees1 = compactNumber(formatTokenAmount(record.tokensOwed1 || '0', token1.decimals), 8);
  }
  const currentValueUsd = estimateUsdValueFromPair(
    token0,
    token1,
    currentAmounts.amount0,
    currentAmounts.amount1,
    priceCurrent
  );
  const unclaimedFeesUsd = estimateUsdValueFromPair(
    token0,
    token1,
    unclaimedFees0,
    unclaimedFees1,
    priceCurrent
  );
  const valuationResult = lightweight
    ? {
      priceAtOpen: null,
      priceAtOpenAccuracy: 'unavailable',
      priceAtOpenSource: 'unavailable',
      priceAtOpenBlock: null,
      initialAmount0: initialAmounts.amount0,
      initialAmount1: initialAmounts.amount1,
      initialValueUsd: currentValueUsd,
      initialValueUsdAccuracy: 'approximate',
      initialValueUsdSource: 'current_price_proxy',
      valuationAccuracy: 'approximate',
      valuationWarnings: ['Snapshot ligero: valuation histórica omitida para ahorrar RPC.'],
    }
    : await resolveInitialValuation({
      provider,
      networkConfig,
      apiKey,
      record,
      positionLiquidity,
      token0,
      token1,
      historicalPrice,
      historicalAmounts: initialAmounts,
      currentValueUsd,
      unclaimedFeesUsd,
      priceCurrent,
    });
  const rangeVisual = computeRangeVisual(
    rangeLowerPrice,
    rangeUpperPrice,
    valuationResult.priceAtOpen,
    priceCurrent
  );
  const pnlMetrics = computePnlMetrics(valuationResult.initialValueUsd, currentValueUsd, unclaimedFeesUsd);
  const distanceMetrics = computeDistanceToRange(rangeLowerPrice, rangeUpperPrice, priceCurrent);
  const valuationWarnings = buildWarningsWithDedup([
    'P&L best-effort: no reconstruye aumentos, reducciones o collects posteriores al mint.',
    ...(valuationResult.valuationWarnings || []),
  ]);

  return {
    ...record,
    token0,
    token1,
    poolUrl: getExplorerLink(networkConfig.explorerUrl, 'address', record.poolAddress),
    status: active ? 'active' : 'empty',
    liquidity: positionLiquidity,
    poolLiquidity,
    totalSupply: null,
    reserve0,
    reserve1,
    currentTick: Number(slot0.tick),
    sqrtPriceX96: String(slot0.sqrtPriceX96),
    openedAt: lpMeta.openedAt,
    activeForMs: lpMeta.activeForMs,
    rangeLowerPrice,
    rangeUpperPrice,
    priceAtOpen: valuationResult.priceAtOpen,
    priceAtOpenAccuracy: valuationResult.priceAtOpenAccuracy,
    priceAtOpenSource: valuationResult.priceAtOpenSource,
    priceAtOpenBlock: valuationResult.priceAtOpenBlock,
    inRange,
    currentOutOfRangeSide: rangeVisual.currentOutOfRangeSide,
    priceCurrent,
    priceApprox: priceCurrent,
    priceQuoteSymbol: token1.symbol,
    priceBaseSymbol: token0.symbol,
    tvlApproxUsd,
    positionAmount0: currentAmounts.amount0,
    positionAmount1: currentAmounts.amount1,
    initialAmount0: valuationResult.initialAmount0,
    initialAmount1: valuationResult.initialAmount1,
    currentValueUsd,
    initialValueUsd: valuationResult.initialValueUsd,
    initialValueUsdAccuracy: valuationResult.initialValueUsdAccuracy,
    initialValueUsdSource: valuationResult.initialValueUsdSource,
    unclaimedFees0,
    unclaimedFees1,
    unclaimedFeesUsd,
    pnlTotalUsd: pnlMetrics.pnlTotalUsd,
    pnlTotalPct: pnlMetrics.pnlTotalPct,
    yieldPct: pnlMetrics.yieldPct,
    distanceToRangePct: distanceMetrics.distanceToRangePct,
    distanceToRangePrice: distanceMetrics.distanceToRangePrice,
    valuationAccuracy: valuationResult.valuationAccuracy,
    valuationWarnings,
    liquiditySummary: buildLiquiditySummary(active ? 'active' : 'empty', [
      `Posición #${record.identifier}`,
      `Liquidity: ${positionLiquidity}`,
      record.tickLower != null && record.tickUpper != null
        ? `Rango: ${record.tickLower}..${record.tickUpper}`
        : null,
      inRange ? 'Dentro de rango' : 'Fuera de rango',
      `${token0.symbol}: ${compactNumber(reserve0, 4) ?? 0}`,
      `${token1.symbol}: ${compactNumber(reserve1, 4) ?? 0}`,
    ]),
  };
}

async function enrichV4Record(provider, networkConfig, record, apiKey = null, options = {}) {
  const lightweight = options.lightweight === true;
  const [token0, token1] = await Promise.all([
    getTokenMeta(provider, networkConfig, record.token0Address),
    getTokenMeta(provider, networkConfig, record.token1Address),
  ]);

  const stateView = onChainManager.getContract({
    runner: provider,
    address: normalizeAddress(networkConfig.deployments.v4.stateView),
    abi: V4_STATE_VIEW_ABI,
  });
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager);
  const positionManager = onChainManager.getContract({
    runner: provider,
    address: positionManagerAddress,
    abi: V4_POSITION_MANAGER_ABI,
  });
  const poolId = record.poolId || record.identifier;
  const tokenId = BigInt(record.identifier);
  const salt = ethers.zeroPadValue(ethers.toBeHex(tokenId), 32);
  const positionId = ethers.solidityPackedKeccak256(
    ['address', 'int24', 'int24', 'bytes32'],
    [positionManagerAddress, Number(record.tickLower), Number(record.tickUpper), salt]
  );

  const [slot0, poolLiquidityRaw, positionLiquidityRaw, positionInfo, feeGrowthInside] = await Promise.all([
    stateView.getSlot0(poolId),
    stateView.getLiquidity(poolId),
    positionManager.getPositionLiquidity(tokenId),
    stateView.getPositionInfo(poolId, positionId),
    stateView.getFeeGrowthInside(poolId, Number(record.tickLower), Number(record.tickUpper)),
  ]);

  const liquidity = String(positionLiquidityRaw);
  const poolLiquidity = String(poolLiquidityRaw);
  const active = positionLiquidityRaw > 0n;
  const priceCurrent = compactNumber(tickToPrice(slot0.tick, token0.decimals, token1.decimals), 6);
  const rangeLowerPrice = compactNumber(tickToPrice(record.tickLower, token0.decimals, token1.decimals), 6);
  const rangeUpperPrice = compactNumber(tickToPrice(record.tickUpper, token0.decimals, token1.decimals), 6);
  const historicalPrice = lightweight
    ? { tick: null, price: null, sqrtPriceX96: null, accuracy: 'unavailable', blockNumber: null }
    : await resolveHistoricalSpotPrice({
      blockNumber: record.mintBlockNumber,
      fetchAtBlock: async (blockTag) => {
        const historicalSlot0 = await stateView.getSlot0(poolId, { blockTag });
        return {
          tick: Number(historicalSlot0.tick),
          price: tickToPrice(historicalSlot0.tick, token0.decimals, token1.decimals),
          sqrtPriceX96: historicalSlot0.sqrtPriceX96,
        };
      },
    });
  const inRange =
    record.tickLower != null &&
    record.tickUpper != null &&
    Number(slot0.tick) >= Number(record.tickLower) &&
    Number(slot0.tick) <= Number(record.tickUpper);
  const lpMeta = buildLpMeta(record);
  const currentAmounts = liquidityToTokenAmounts({
    liquidity,
    sqrtPriceX96: slot0.sqrtPriceX96,
    tickLower: record.tickLower,
    tickUpper: record.tickUpper,
    token0Decimals: token0.decimals,
    token1Decimals: token1.decimals,
  });
  const initialAmounts = historicalPrice.tick != null
    ? liquidityToTokenAmounts({
      liquidity,
      sqrtPriceX96: historicalPrice.sqrtPriceX96,
      tickCurrent: historicalPrice.tick,
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      token0Decimals: token0.decimals,
      token1Decimals: token1.decimals,
    })
    : { amount0: null, amount1: null };
  const unclaimedFeesRaw = computeV4UnclaimedFees({
    liquidity: positionInfo.liquidity,
    feeGrowthInside0LastX128: positionInfo.feeGrowthInside0LastX128,
    feeGrowthInside1LastX128: positionInfo.feeGrowthInside1LastX128,
    feeGrowthInside0X128: feeGrowthInside.feeGrowthInside0X128,
    feeGrowthInside1X128: feeGrowthInside.feeGrowthInside1X128,
  });
  const unclaimedFees0 = compactNumber(formatTokenAmount(unclaimedFeesRaw.fees0, token0.decimals), 8);
  const unclaimedFees1 = compactNumber(formatTokenAmount(unclaimedFeesRaw.fees1, token1.decimals), 8);
  const currentValueUsd = estimateUsdValueFromPair(
    token0,
    token1,
    currentAmounts.amount0,
    currentAmounts.amount1,
    priceCurrent
  );
  const unclaimedFeesUsd = estimateUsdValueFromPair(
    token0,
    token1,
    unclaimedFees0,
    unclaimedFees1,
    priceCurrent
  );
  const valuationResult = lightweight
    ? {
      priceAtOpen: null,
      priceAtOpenAccuracy: 'unavailable',
      priceAtOpenSource: 'unavailable',
      priceAtOpenBlock: null,
      initialAmount0: initialAmounts.amount0,
      initialAmount1: initialAmounts.amount1,
      initialValueUsd: currentValueUsd,
      initialValueUsdAccuracy: 'approximate',
      initialValueUsdSource: 'current_price_proxy',
      valuationAccuracy: 'approximate',
      valuationWarnings: ['Snapshot ligero: valuation histórica omitida para ahorrar RPC.'],
    }
    : await resolveInitialValuation({
      provider,
      networkConfig,
      apiKey,
      record,
      positionLiquidity: liquidity,
      token0,
      token1,
      historicalPrice,
      historicalAmounts: initialAmounts,
      currentValueUsd,
      unclaimedFeesUsd,
      priceCurrent,
    });
  const rangeVisual = computeRangeVisual(
    rangeLowerPrice,
    rangeUpperPrice,
    valuationResult.priceAtOpen,
    priceCurrent
  );
  const pnlMetrics = computePnlMetrics(valuationResult.initialValueUsd, currentValueUsd, unclaimedFeesUsd);
  const distanceMetrics = computeDistanceToRange(rangeLowerPrice, rangeUpperPrice, priceCurrent);
  const valuationWarnings = buildWarningsWithDedup([
    'P&L best-effort: no reconstruye aumentos, reducciones o collects posteriores al mint.',
    ...(valuationResult.valuationWarnings || []),
  ]);

  return {
    ...record,
    token0,
    token1,
    poolUrl: null,
    status: active ? 'active' : 'empty',
    liquidity,
    poolLiquidity,
    totalSupply: null,
    reserve0: null,
    reserve1: null,
    currentTick: Number(slot0.tick),
    sqrtPriceX96: String(slot0.sqrtPriceX96),
    openedAt: lpMeta.openedAt,
    activeForMs: lpMeta.activeForMs,
    rangeLowerPrice,
    rangeUpperPrice,
    priceAtOpen: valuationResult.priceAtOpen,
    priceAtOpenAccuracy: valuationResult.priceAtOpenAccuracy,
    priceAtOpenSource: valuationResult.priceAtOpenSource,
    priceAtOpenBlock: valuationResult.priceAtOpenBlock,
    inRange,
    currentOutOfRangeSide: rangeVisual.currentOutOfRangeSide,
    priceCurrent,
    priceApprox: priceCurrent,
    priceQuoteSymbol: token1.symbol,
    priceBaseSymbol: token0.symbol,
    tvlApproxUsd: null,
    poolId,
    positionAmount0: currentAmounts.amount0,
    positionAmount1: currentAmounts.amount1,
    initialAmount0: valuationResult.initialAmount0,
    initialAmount1: valuationResult.initialAmount1,
    currentValueUsd,
    initialValueUsd: valuationResult.initialValueUsd,
    initialValueUsdAccuracy: valuationResult.initialValueUsdAccuracy,
    initialValueUsdSource: valuationResult.initialValueUsdSource,
    unclaimedFees0,
    unclaimedFees1,
    unclaimedFeesUsd,
    pnlTotalUsd: pnlMetrics.pnlTotalUsd,
    pnlTotalPct: pnlMetrics.pnlTotalPct,
    yieldPct: pnlMetrics.yieldPct,
    distanceToRangePct: distanceMetrics.distanceToRangePct,
    distanceToRangePrice: distanceMetrics.distanceToRangePrice,
    valuationAccuracy: valuationResult.valuationAccuracy,
    valuationWarnings,
    liquiditySummary: buildLiquiditySummary(active ? 'active' : 'empty', [
      `Posición #${record.identifier}`,
      `Liquidity: ${liquidity}`,
      record.hooks ? `Hooks: ${record.hooks.slice(0, 8)}...` : null,
    ]),
  };
}

async function enrichRecord(provider, networkConfig, record, apiKey = null) {
  if (record.version === 'v1') return enrichV1Record(provider, networkConfig, record);
  if (record.version === 'v2') return enrichV2Record(provider, networkConfig, record);
  if (record.version === 'v3') return enrichV3Record(provider, networkConfig, record, apiKey);
  return enrichV4Record(provider, networkConfig, record, apiKey);
}

async function getPoolSpotData({
  network,
  version,
  poolAddress,
  poolId,
  token0Decimals,
  token1Decimals,
}) {
  const networkConfig = SUPPORTED_NETWORKS[String(network || '').toLowerCase()];
  if (!networkConfig) {
    throw new ValidationError(`Red no soportada para spot price: ${network}`);
  }
  const normalizedVersion = String(version || '').toLowerCase();
  const provider = getProvider(networkConfig);

  if (normalizedVersion === 'v3') {
    const pool = onChainManager.getContract({
      runner: provider,
      address: normalizeAddress(poolAddress),
      abi: V3_POOL_ABI,
    });
    const slot0 = await pool.slot0();
    return {
      version: normalizedVersion,
      tick: Number(slot0.tick),
      sqrtPriceX96: String(slot0.sqrtPriceX96),
      priceCurrent: compactNumber(tickToPrice(slot0.tick, token0Decimals, token1Decimals), 6),
    };
  }

  if (normalizedVersion === 'v4') {
    const stateView = onChainManager.getContract({
      runner: provider,
      address: normalizeAddress(networkConfig.deployments.v4.stateView),
      abi: V4_STATE_VIEW_ABI,
    });
    const slot0 = await stateView.getSlot0(poolId);
    return {
      version: normalizedVersion,
      tick: Number(slot0.tick),
      sqrtPriceX96: String(slot0.sqrtPriceX96),
      priceCurrent: compactNumber(tickToPrice(slot0.tick, token0Decimals, token1Decimals), 6),
    };
  }

  throw new ValidationError('Solo v3/v4 soportan spot price on-chain para delta-neutral');
}

async function inspectPositionByIdentifier({
  userId,
  wallet,
  network,
  version,
  positionIdentifier,
  lightweight = true,
}) {
  if (!userId) {
    throw new ValidationError('userId es requerido');
  }
  if (!positionIdentifier) {
    throw new ValidationError('positionIdentifier es requerido');
  }

  const { wallet: normalizedWallet, networkConfig } = validateRequest({ wallet, network, version });
  const provider = getProvider(networkConfig);
  const apiKey = lightweight
    ? null
    : await getUserApiKey(userId).catch((err) => {
      logger.warn('getUserApiKey failed', { userId, error: err.message });
      return null;
    });
  const normalizedVersion = String(version || '').toLowerCase();

  if (normalizedVersion === 'v3') {
    const tokenId = BigInt(positionIdentifier);
    const pmAddress = normalizeAddress(networkConfig.deployments.v3.positionManager);
    const factoryAddress = normalizeAddress(networkConfig.deployments.v3.eventSource);
    const positionManager = getContract(networkConfig, pmAddress, V3_POSITION_MANAGER_ABI);
    const factory = getContract(networkConfig, factoryAddress, V3_FACTORY_ABI);

    const owner = normalizeAddress(await positionManager.ownerOf(tokenId).catch(() => null));
    if (!owner || lower(owner) !== lower(normalizedWallet)) return null;

    const position = await positionManager.positions(tokenId);
    const poolAddress = await factory.getPool(position.token0, position.token1, position.fee);
    const pool = onChainManager.getContract({ runner: provider, address: poolAddress, abi: V3_POOL_ABI });
    const tickSpacing = Number(await pool.tickSpacing().catch(() => 0));

    // Cuando NO es lightweight, intentamos obtener el bloque de mint vía
    // Etherscan NFT transfers para que enrichV3Record pueda resolver
    // el precio histórico (priceAtOpen).
    let mintInfo = { txHash: null, blockNumber: null, createdAt: null };
    if (!lightweight && apiKey) {
      try {
        const nftRows = await fetchWalletNftTransfers(apiKey, networkConfig, normalizedWallet, pmAddress);
        const { firstInbound } = collectHeldTokenIds(normalizedWallet, nftRows.rows);
        const inbound = firstInbound.get(String(positionIdentifier));
        if (inbound) {
          mintInfo = inbound;
        }
      } catch (err) {
        logger.warn('inspect_position_nft_transfer_lookup_failed', {
          positionIdentifier,
          error: err.message,
        });
      }
    }

    const record = {
      id: `v3:${networkConfig.id}:${positionIdentifier}`,
      mode: 'lp_position',
      version: 'v3',
      network: networkConfig.id,
      networkLabel: networkConfig.label,
      chainId: networkConfig.chainId,
      creator: normalizedWallet,
      owner: normalizedWallet,
      txHash: mintInfo.txHash,
      blockNumber: mintInfo.blockNumber,
      mintBlockNumber: mintInfo.blockNumber,
      createdAt: mintInfo.createdAt,
      openedAt: mintInfo.createdAt,
      explorerUrl: networkConfig.explorerUrl,
      source: 'direct_position_inspect',
      completeness: lightweight ? 'lightweight' : 'full',
      token0Address: normalizeAddress(position.token0),
      token1Address: normalizeAddress(position.token1),
      poolAddress: normalizeAddress(poolAddress),
      identifier: String(positionIdentifier),
      fee: Number(position.fee),
      tickSpacing: tickSpacing || null,
      tickLower: Number(position.tickLower),
      tickUpper: Number(position.tickUpper),
      positionLiquidity: String(position.liquidity),
      feeGrowthInside0LastX128: String(position.feeGrowthInside0LastX128),
      feeGrowthInside1LastX128: String(position.feeGrowthInside1LastX128),
      tokensOwed0: String(position.tokensOwed0),
      tokensOwed1: String(position.tokensOwed1),
    };
    return enrichV3Record(provider, networkConfig, record, apiKey, { lightweight });
  }

  if (normalizedVersion === 'v4') {
    const tokenId = BigInt(positionIdentifier);
    const pmAddress = normalizeAddress(networkConfig.deployments.v4.positionManager);
    const positionManager = getContract(networkConfig, pmAddress, V4_POSITION_MANAGER_ABI);
    const owner = normalizeAddress(await positionManager.ownerOf(tokenId).catch(() => null));
    if (!owner || lower(owner) !== lower(normalizedWallet)) return null;

    const [poolKey, positionInfo] = await positionManager.getPoolAndPositionInfo(tokenId);
    const decodedInfo = decodeV4PositionInfo(positionInfo);
    const poolId = computeV4PoolId(poolKey);

    let mintInfo = { txHash: null, blockNumber: null, createdAt: null };
    if (!lightweight && apiKey) {
      try {
        const nftRows = await fetchWalletNftTransfers(apiKey, networkConfig, normalizedWallet, pmAddress);
        const { firstInbound } = collectHeldTokenIds(normalizedWallet, nftRows.rows);
        const inbound = firstInbound.get(String(positionIdentifier));
        if (inbound) {
          mintInfo = inbound;
        }
      } catch (err) {
        logger.warn('inspect_position_nft_transfer_lookup_failed', {
          positionIdentifier,
          error: err.message,
        });
      }
    }

    const record = {
      id: `v4:${networkConfig.id}:${positionIdentifier}`,
      mode: 'lp_position',
      version: 'v4',
      network: networkConfig.id,
      networkLabel: networkConfig.label,
      chainId: networkConfig.chainId,
      creator: normalizedWallet,
      owner: normalizedWallet,
      txHash: mintInfo.txHash,
      blockNumber: mintInfo.blockNumber,
      mintBlockNumber: mintInfo.blockNumber,
      createdAt: mintInfo.createdAt,
      openedAt: mintInfo.createdAt,
      explorerUrl: networkConfig.explorerUrl,
      source: 'direct_position_inspect',
      completeness: lightweight ? 'lightweight' : 'full',
      token0Address: normalizeAddress(poolKey.currency0),
      token1Address: normalizeAddress(poolKey.currency1),
      poolAddress: null,
      identifier: String(positionIdentifier),
      poolId,
      fee: Number(poolKey.fee),
      tickSpacing: Number(poolKey.tickSpacing),
      hooks: normalizeAddress(poolKey.hooks),
      tickLower: decodedInfo.tickLower,
      tickUpper: decodedInfo.tickUpper,
    };
    return enrichV4Record(provider, networkConfig, record, apiKey, { lightweight });
  }

  throw new ValidationError('Solo v3/v4 soportan inspeccion directa de posicion');
}

function isRelevantRecord(record) {
  return record.status !== 'empty';
}

async function buildRecordsFromTransaction(provider, networkConfig, version, txHash) {
  const receipt = await getReceipt(provider, txHash);
  if (!receipt) return [];

  const tx = await provider.getTransaction(txHash);
  const timestamp = await getBlockTimestamp(provider, networkConfig, receipt.blockNumber);
  const normalizedTx = {
    hash: txHash,
    from: normalizeAddress(tx?.from),
    blockNumber: receipt.blockNumber,
    timestamp,
  };

  const parsedEntries = parseCreationLogs(version, receipt, networkConfig.deployments[version].eventSource);
  return parsedEntries.map((entry) => buildBaseRecord(networkConfig, version, normalizedTx, entry));
}

async function scanV3PositionsByWallet({ userId, wallet, networkConfig }) {
  const provider = getProvider(networkConfig);
  const warnings = [];
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v3.positionManager);
  const factoryAddress = normalizeAddress(networkConfig.deployments.v3.eventSource);
  const positionManager = getContract(networkConfig, positionManagerAddress, V3_POSITION_MANAGER_ABI);
  const factory = getContract(networkConfig, factoryAddress, V3_FACTORY_ABI);

  const balance = await positionManager.balanceOf(wallet);
  const tokenIds = [];
  for (let i = 0n; i < balance; i += 1n) {
    tokenIds.push(String(await positionManager.tokenOfOwnerByIndex(wallet, i)));
  }

  const apiKey = await getUserApiKey(userId).catch((err) => { logger.warn('getUserApiKey failed', { userId, error: err.message }); return null; });
  let firstInbound = new Map();
  if (apiKey) {
    try {
      const nftRows = await fetchWalletNftTransfers(apiKey, networkConfig, wallet, positionManagerAddress);
      firstInbound = collectHeldTokenIds(wallet, nftRows.rows).firstInbound;
      if (nftRows.truncated) {
        warnings.push(`Etherscan truncó el historial NFT a ${MAX_NFT_PAGES * NFT_PAGE_SIZE} transferencias`);
      }
    } catch (err) {
      warnings.push(`No se pudo cargar historial NFT v3: ${err.message}`);
    }
  }

  const records = await mapConcurrent(tokenIds, 4, async (tokenId) => {
    const position = await positionManager.positions(tokenId);
    const poolAddress = await factory.getPool(position.token0, position.token1, position.fee);
    const pool = onChainManager.getContract({ runner: provider, address: poolAddress, abi: V3_POOL_ABI });
    const tickSpacing = Number(await pool.tickSpacing().catch(() => 0));
    const inbound = firstInbound.get(String(tokenId));

    return {
      id: `v3:${networkConfig.id}:${tokenId}`,
      mode: 'lp_position',
      version: 'v3',
      network: networkConfig.id,
      networkLabel: networkConfig.label,
      chainId: networkConfig.chainId,
      creator: wallet,
      owner: wallet,
      txHash: inbound?.txHash || null,
      blockNumber: inbound?.blockNumber || null,
      mintBlockNumber: inbound?.blockNumber || null,
      createdAt: inbound?.createdAt || null,
      openedAt: inbound?.createdAt || null,
      explorerUrl: networkConfig.explorerUrl,
      source: 'onchain_position_manager',
      completeness: 'full',
      token0Address: normalizeAddress(position.token0),
      token1Address: normalizeAddress(position.token1),
      poolAddress: normalizeAddress(poolAddress),
      identifier: String(tokenId),
      fee: Number(position.fee),
      tickSpacing: tickSpacing || null,
      tickLower: Number(position.tickLower),
      tickUpper: Number(position.tickUpper),
      positionLiquidity: String(position.liquidity),
      feeGrowthInside0LastX128: String(position.feeGrowthInside0LastX128),
      feeGrowthInside1LastX128: String(position.feeGrowthInside1LastX128),
      tokensOwed0: String(position.tokensOwed0),
      tokensOwed1: String(position.tokensOwed1),
    };
  });

  const enriched = await mapConcurrent(records, 4, async (record) => {
    try {
      return await enrichV3Record(provider, networkConfig, record, apiKey);
    } catch (err) {
      warnings.push(`No se pudo enriquecer posición v3 ${record.identifier}: ${err.message}`);
      return null;
    }
  });

  const pools = await annotatePoolsForUser({
    userId,
    pools: enriched.filter(Boolean).filter(isRelevantRecord),
  });
  const poolsWithRange = await timeInRangeService.annotatePoolsWithTimeInRange(pools);
  return {
    wallet,
    network: {
      id: networkConfig.id,
      label: networkConfig.label,
      chainId: networkConfig.chainId,
      explorerUrl: networkConfig.explorerUrl,
    },
    version: 'v3',
    mode: 'lp_positions',
    source: 'onchain_position_manager',
    completeness: 'full',
    count: poolsWithRange.length,
    filteredOutCount: records.length - poolsWithRange.length,
    inspectedTxCount: records.length,
    totalTxCount: records.length,
    scannedAt: Date.now(),
    warnings: buildWarningsWithDedup(warnings),
    pools: poolsWithRange,
  };
}

function computeV4PoolId(poolKey) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'],
    [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]]
  );
  return ethers.keccak256(encoded);
}

async function scanV4PositionsByWallet({ userId, wallet, networkConfig }) {
  const provider = getProvider(networkConfig);
  const warnings = [];
  const apiKey = await getUserApiKey(userId);
  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager);
  const positionManager = getContract(networkConfig, positionManagerAddress, V4_POSITION_MANAGER_ABI);

  const { rows, truncated } = await fetchWalletNftTransfers(apiKey, networkConfig, wallet, positionManagerAddress);
  const { tokenIds, firstInbound } = collectHeldTokenIds(wallet, rows);
  if (truncated) {
    warnings.push(`Etherscan truncó el historial NFT a ${MAX_NFT_PAGES * NFT_PAGE_SIZE} transferencias`);
  }

  const records = await mapConcurrent(tokenIds, 3, async (tokenId) => {
    const owner = normalizeAddress(await positionManager.ownerOf(tokenId).catch((err) => { logger.warn('ownerOf failed', { tokenId, error: err.message }); return null; }));
    if (lower(owner) !== lower(wallet)) return null;

    const [poolKey, positionInfo] = await positionManager.getPoolAndPositionInfo(tokenId);
    const decodedInfo = decodeV4PositionInfo(positionInfo);
    const poolId = computeV4PoolId(poolKey);
    const inbound = firstInbound.get(String(tokenId));

    return {
      id: `v4:${networkConfig.id}:${tokenId}`,
      mode: 'lp_position',
      version: 'v4',
      network: networkConfig.id,
      networkLabel: networkConfig.label,
      chainId: networkConfig.chainId,
      creator: wallet,
      owner: wallet,
      txHash: inbound?.txHash || null,
      blockNumber: inbound?.blockNumber || null,
      mintBlockNumber: inbound?.blockNumber || null,
      createdAt: inbound?.createdAt || null,
      openedAt: inbound?.createdAt || null,
      explorerUrl: networkConfig.explorerUrl,
      source: 'etherscan+nft_position_manager',
      completeness: 'full',
      token0Address: normalizeAddress(poolKey.currency0),
      token1Address: normalizeAddress(poolKey.currency1),
      poolAddress: null,
      identifier: String(tokenId),
      poolId,
      fee: Number(poolKey.fee),
      tickSpacing: Number(poolKey.tickSpacing),
      hooks: normalizeAddress(poolKey.hooks),
      tickLower: decodedInfo.tickLower,
      tickUpper: decodedInfo.tickUpper,
    };
  });

  const enriched = await mapConcurrent(records.filter(Boolean), 3, async (record) => {
    try {
      return enrichV4Record(provider, networkConfig, record, apiKey);
    } catch (err) {
      warnings.push(`No se pudo enriquecer posición v4 ${record.identifier}: ${err.message}`);
      return null;
    }
  });

  const pools = await annotatePoolsForUser({
    userId,
    pools: enriched.filter(Boolean).filter(isRelevantRecord),
  });
  const poolsWithRange = await timeInRangeService.annotatePoolsWithTimeInRange(pools);
  return {
    wallet,
    network: {
      id: networkConfig.id,
      label: networkConfig.label,
      chainId: networkConfig.chainId,
      explorerUrl: networkConfig.explorerUrl,
    },
    version: 'v4',
    mode: 'lp_positions',
    source: 'etherscan+nft_position_manager',
    completeness: truncated ? 'partial' : 'full',
    count: poolsWithRange.length,
    filteredOutCount: records.filter(Boolean).length - poolsWithRange.length,
    inspectedTxCount: records.filter(Boolean).length,
    totalTxCount: rows.length,
    scannedAt: Date.now(),
    warnings: buildWarningsWithDedup(warnings),
    pools: poolsWithRange,
  };
}

async function scanPoolsCreatedByWallet({ userId, wallet, network, version }) {
  if (!userId) {
    throw new ValidationError('userId es requerido');
  }

  const { wallet: normalizedWallet, networkConfig } = validateRequest({ wallet, network, version });
  if (version === 'v3') {
    return scanV3PositionsByWallet({ wallet: normalizedWallet, networkConfig, userId });
  }

  if (version === 'v4') {
    return scanV4PositionsByWallet({ wallet: normalizedWallet, networkConfig, userId });
  }

  const apiKey = await getUserApiKey(userId);
  const provider = getProvider(networkConfig);
  const warnings = [];

  const { rows: transactions, truncated } = await fetchWalletTransactions(
    apiKey,
    networkConfig,
    normalizedWallet
  );

  if (truncated) {
    warnings.push(`Etherscan truncó el historial a ${MAX_TXLIST_PAGES * TXLIST_PAGE_SIZE} transacciones recientes`);
  }

  const target = lower(networkConfig.deployments[version].eventSource);
  const matchingTransactions = transactions.filter((tx) => lower(tx.to) === target);
  const uniqueTxHashes = [...new Set(matchingTransactions.map((tx) => tx.hash).filter(Boolean))];

  const baseRecordBatches = await mapConcurrent(uniqueTxHashes, 3, async (txHash) => {
    try {
      return await buildRecordsFromTransaction(provider, networkConfig, version, txHash);
    } catch (err) {
      warnings.push(`No se pudo inspeccionar ${txHash}: ${err.message}`);
      return [];
    }
  });

  const baseRecords = baseRecordBatches.flat().filter((record) => lower(record.creator) === lower(normalizedWallet));
  const enriched = await mapConcurrent(baseRecords, 4, async (record) => {
    try {
      return await enrichRecord(provider, networkConfig, record, apiKey);
    } catch (err) {
      warnings.push(`No se pudo enriquecer ${record.txHash}: ${err.message}`);
      return null;
    }
  });

  const pools = [];
  let filteredOutCount = 0;

  for (const record of enriched.filter(Boolean)) {
    if (isRelevantRecord(record)) {
      pools.push(record);
    } else {
      filteredOutCount += 1;
    }
  }

  pools.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.blockNumber - a.blockNumber);
  const annotatedPools = await annotatePoolsForUser({ userId, pools });
  const poolsWithRange = await timeInRangeService.annotatePoolsWithTimeInRange(annotatedPools);

  return {
    wallet: normalizedWallet,
    network: {
      id: networkConfig.id,
      label: networkConfig.label,
      chainId: networkConfig.chainId,
      explorerUrl: networkConfig.explorerUrl,
    },
    version,
    mode: 'created_pools',
    source: 'etherscan',
    completeness: truncated ? 'partial' : 'full',
    count: poolsWithRange.length,
    filteredOutCount,
    inspectedTxCount: uniqueTxHashes.length,
    totalTxCount: transactions.length,
    scannedAt: Date.now(),
    warnings,
    pools: poolsWithRange,
  };
}

/**
 * Returns a networkConfig with the user's Alchemy RPC URLs overlaid if they
 * have configured a personal API key.  Falls back to the global config when
 * the user has no key set.
 */
async function getNetworkConfigForUser(userId, network) {
  const networkConfig = SUPPORTED_NETWORKS[String(network || '').toLowerCase()];
  if (!networkConfig) throw new ValidationError(`network no soportada: ${network}`);

  const { apiKey } = await settingsService.getAlchemy(userId);
  if (!apiKey) return networkConfig;

  const { buildAlchemyRpcUrls } = require('../config');
  const userRpcUrls = buildAlchemyRpcUrls(apiKey);
  const userRpcUrl = userRpcUrls[networkConfig.id];
  if (!userRpcUrl) return networkConfig;

  return { ...networkConfig, rpcUrl: userRpcUrl };
}

async function testUserAlchemyKey(userId) {
  const { apiKey } = await settingsService.getAlchemy(userId);
  if (!apiKey) throw new ValidationError('No hay API key de Alchemy configurada');

  const { buildAlchemyRpcUrls } = require('../config');
  const urls = buildAlchemyRpcUrls(apiKey);
  const provider = new ethers.JsonRpcProvider(urls.ethereum);
  const blockNumber = await provider.getBlockNumber();
  return { valid: true, blockNumber };
}

module.exports = {
  scanPoolsCreatedByWallet,
  testUserEtherscanKey,
  testUserAlchemyKey,
  getNetworkConfigForUser,
  computeDistanceToRange,
  computePnlMetrics,
  getSupportMatrix,
  liquidityToTokenAmounts,
  SUPPORTED_NETWORKS,
  computeRangeVisual,
  computeV4UnclaimedFees,
  decodeV4PositionInfo,
  estimateUsdValueFromPair,
  extractMintInputAmounts,
  resolveHistoricalSpotPrice,
  resolveInitialValuation,
  getPoolSpotData,
  inspectPositionByIdentifier,
  sqrtPriceX96ToFloat,
  tickToRawSqrtRatio,
  tickToPrice,
  parseCreationLogs,
  estimateTvlApproxUsd,
};
