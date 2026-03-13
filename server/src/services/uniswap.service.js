const axios = require('axios');
const { ethers } = require('ethers');
const config = require('../config');
const settingsService = require('./settings.service');
const {
  ExternalServiceError,
  ValidationError,
} = require('../errors/app-error');

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
];

const V1_EXCHANGE_ABI = [
  'function totalSupply() view returns (uint256)',
];

const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
];

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const V3_POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const V3_POSITION_MANAGER_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
];

const V4_POSITION_MANAGER_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks), uint256)',
];

const EVENT_ABIS = {
  v1: 'event NewExchange(address indexed token, address indexed exchange)',
  v2: 'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
  v3: 'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  v4: 'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
};

const STABLE_SYMBOLS = new Set([
  'USDC',
  'USDC.E',
  'USDBC',
  'USDT',
  'USDT0',
  'USD₮0',
  'DAI',
  'LUSD',
  'FDUSD',
  'USDE',
]);

const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api';
const DEFAULT_TIMEOUT_MS = config.uniswap.scanTimeoutMs;
const TXLIST_PAGE_SIZE = 1000;
const MAX_TXLIST_PAGES = 5;
const NFT_PAGE_SIZE = 100;
const MAX_NFT_PAGES = 5;
const HISTORICAL_PRICE_BLOCK_OFFSETS = [0, 50, 250, 1000, 5000];

const providerCache = new Map();
const tokenCache = new Map();
const receiptCache = new Map();
const blockCache = new Map();

const RPC_DEFAULTS = config.uniswap.rpcUrls;

const SUPPORTED_NETWORKS = {
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    chainId: 1,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://etherscan.io',
    rpcUrl: RPC_DEFAULTS.ethereum,
    versions: ['v1', 'v2', 'v3', 'v4'],
    deployments: {
      v1: {
        kind: 'factory',
        eventSource: '0xc0a47dFe034B400B47bDaD5FecDa2621De6c4d95',
      },
      v2: {
        kind: 'factory',
        eventSource: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x000000000004444c5dc75cB358380D2e3dE08A90',
        stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
        positionManager: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
      },
    },
  },
  arbitrum: {
    id: 'arbitrum',
    label: 'Arbitrum One',
    chainId: 42161,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://arbiscan.io',
    rpcUrl: RPC_DEFAULTS.arbitrum,
    versions: ['v2', 'v3', 'v4'],
    deployments: {
      v2: {
        kind: 'factory',
        eventSource: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
        stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
        positionManager: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
      },
    },
  },
  base: {
    id: 'base',
    label: 'Base',
    chainId: 8453,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://basescan.org',
    rpcUrl: RPC_DEFAULTS.base,
    versions: ['v2', 'v3', 'v4'],
    deployments: {
      v2: {
        kind: 'factory',
        eventSource: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
        positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x498581ff718922c3f8e6a244956af099b2652b2b',
        stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
        positionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
      },
    },
  },
  optimism: {
    id: 'optimism',
    label: 'Optimism',
    chainId: 10,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://optimistic.etherscan.io',
    rpcUrl: RPC_DEFAULTS.optimism,
    versions: ['v2', 'v3', 'v4'],
    deployments: {
      v2: {
        kind: 'factory',
        eventSource: '0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
        stateView: '0xc18a3169788f4f75a170290584eca6395c75ecdb',
        positionManager: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017',
      },
    },
  },
  polygon: {
    id: 'polygon',
    label: 'Polygon',
    chainId: 137,
    nativeSymbol: 'POL',
    explorerUrl: 'https://polygonscan.com',
    rpcUrl: RPC_DEFAULTS.polygon,
    versions: ['v2', 'v3', 'v4'],
    deployments: {
      v2: {
        kind: 'factory',
        eventSource: '0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x67366782805870060151383f4bbff9dab53e5cd6',
        stateView: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a',
        positionManager: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
      },
    },
  },
};

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

function normalizeAddress(address) {
  if (!address) return null;
  try {
    return ethers.getAddress(address);
  } catch {
    return null;
  }
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function compactNumber(value, digits = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function formatTokenAmount(value, decimals) {
  try {
    return ethers.formatUnits(value, decimals);
  } catch {
    return '0';
  }
}

function tickToPrice(tick, token0Decimals, token1Decimals) {
  const decimalDelta = token0Decimals - token1Decimals;
  return Math.pow(1.0001, Number(tick)) * Math.pow(10, decimalDelta);
}

function isStableSymbol(symbol) {
  return STABLE_SYMBOLS.has(String(symbol || '').toUpperCase());
}

function estimateTvlApproxUsd(token0, amount0, token1, amount1) {
  const reserve0 = Number(amount0);
  const reserve1 = Number(amount1);

  if (!Number.isFinite(reserve0) || !Number.isFinite(reserve1)) return null;
  if (reserve0 <= 0 && reserve1 <= 0) return null;

  const stable0 = isStableSymbol(token0.symbol);
  const stable1 = isStableSymbol(token1.symbol);

  if (stable0 && stable1) return compactNumber(reserve0 + reserve1, 2);
  if (stable0) return compactNumber(reserve0 * 2, 2);
  if (stable1) return compactNumber(reserve1 * 2, 2);
  return null;
}

function buildLiquiditySummary(status, parts) {
  return {
    status,
    text: parts.filter(Boolean).join(' · '),
  };
}

function buildWarningsWithDedup(warnings) {
  return [...new Set(warnings.filter(Boolean))];
}

function decodeSigned24(value) {
  const masked = Number(BigInt(value) & 0xFFFFFFn);
  return (masked & 0x800000) !== 0 ? masked - 0x1000000 : masked;
}

function decodeV4PositionInfo(info) {
  const packed = BigInt(info);
  return {
    hasSubscriber: Boolean(packed & 0xFFn),
    tickLower: decodeSigned24(packed >> 8n),
    tickUpper: decodeSigned24(packed >> 32n),
  };
}

async function resolveHistoricalSpotPrice({ blockNumber, fetchAtBlock }) {
  const baseBlock = Number(blockNumber);
  if (!Number.isFinite(baseBlock) || baseBlock <= 0) {
    return {
      price: null,
      tick: null,
      blockNumber: null,
      accuracy: 'unavailable',
    };
  }

  for (const offset of HISTORICAL_PRICE_BLOCK_OFFSETS) {
    const targetBlock = baseBlock + offset;
    try {
      const value = await fetchAtBlock(targetBlock);
      if (value && Number.isFinite(Number(value.tick)) && Number.isFinite(Number(value.price))) {
        return {
          price: compactNumber(value.price, 6),
          tick: Number(value.tick),
          blockNumber: targetBlock,
          accuracy: offset === 0 ? 'exact' : 'approximate',
        };
      }
    } catch {
      // Intentamos el siguiente checkpoint si el nodo no tiene estado histórico.
    }
  }

  return {
    price: null,
    tick: null,
    blockNumber: null,
    accuracy: 'unavailable',
  };
}

function computeRangeVisual(rangeLowerPrice, rangeUpperPrice, priceAtOpen, priceCurrent) {
  const lower = Number(rangeLowerPrice);
  const upper = Number(rangeUpperPrice);
  const open = Number(priceAtOpen);
  const current = Number(priceCurrent);

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower === upper) {
    return {
      currentOutOfRangeSide: null,
    };
  }

  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  const side =
    Number.isFinite(current) && current < min
      ? 'below'
      : Number.isFinite(current) && current > max
        ? 'above'
        : null;

  return {
    currentOutOfRangeSide: side,
    openMarkerPct: Number.isFinite(open)
      ? Math.max(0, Math.min(100, ((open - min) / (max - min)) * 100))
      : null,
    currentMarkerPct: Number.isFinite(current)
      ? Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100))
      : null,
  };
}

function buildLpMeta(record, scannedAt = Date.now()) {
  const openedAt = Number(record.openedAt || record.createdAt || 0) || null;
  return {
    openedAt,
    activeForMs: openedAt ? Math.max(0, scannedAt - (openedAt * 1000)) : null,
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
  if (providerCache.has(networkConfig.id)) return providerCache.get(networkConfig.id);

  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl, networkConfig.chainId, {
    staticNetwork: true,
  });

  providerCache.set(networkConfig.id, provider);
  return provider;
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

  const contract = new ethers.Contract(normalized, ERC20_ABI, provider);
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

function getExplorerLink(baseUrl, kind, value) {
  if (!baseUrl || !value) return null;
  if (kind === 'tx') return `${baseUrl}/tx/${value}`;
  if (kind === 'address') return `${baseUrl}/address/${value}`;
  return null;
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

function normalizeEtherscanError(result) {
  const message = String(result?.result || result?.message || 'Error desconocido');
  const lowered = message.toLowerCase();
  if (
    lowered.includes('invalid api key') ||
    lowered.includes('missing or unsupported chainid') ||
    lowered.includes('unauthorized') ||
    lowered.includes('invalid key')
  ) {
    throw new ValidationError('Etherscan API key invalida o sin permisos para esta red');
  }
  if (lowered.includes('max rate limit')) {
    throw new ExternalServiceError('Etherscan rate limit excedido');
  }
  throw new ExternalServiceError(`Etherscan error: ${message}`);
}

async function etherscanRequest(apiKey, params) {
  try {
    const { data } = await axios.get(ETHERSCAN_API_URL, {
      params: {
        ...params,
        apikey: apiKey,
      },
      timeout: DEFAULT_TIMEOUT_MS,
    });

    if (data?.status === '1') {
      return data.result;
    }

    const noResults =
      (params.action === 'txlist' || params.action === 'tokennfttx') &&
      data?.status === '0' &&
      (
        String(data?.message || '').toLowerCase().includes('no transactions') ||
        String(data?.result || '').toLowerCase().includes('no transactions')
      );

    if (noResults) {
      return [];
    }

    normalizeEtherscanError(data);
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ExternalServiceError) throw err;
    throw new ExternalServiceError(`Etherscan request fallo: ${err.message}`);
  }
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

  const tokenContract = new ethers.Contract(token1.address, ERC20_ABI, provider);
  const exchangeContract = new ethers.Contract(record.poolAddress, V1_EXCHANGE_ABI, provider);

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

  const pair = new ethers.Contract(record.poolAddress, V2_PAIR_ABI, provider);
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

async function enrichV3Record(provider, networkConfig, record) {
  const [token0, token1] = await Promise.all([
    getTokenMeta(provider, networkConfig, record.token0Address),
    getTokenMeta(provider, networkConfig, record.token1Address),
  ]);

  const pool = new ethers.Contract(record.poolAddress, V3_POOL_ABI, provider);
  const token0Contract = token0.isNative ? null : new ethers.Contract(token0.address, ERC20_ABI, provider);
  const token1Contract = token1.isNative ? null : new ethers.Contract(token1.address, ERC20_ABI, provider);

  const [liquidityRaw, slot0, balance0Raw, balance1Raw] = await Promise.all([
    pool.liquidity(),
    pool.slot0(),
    token0.isNative ? provider.getBalance(record.poolAddress) : token0Contract.balanceOf(record.poolAddress),
    token1.isNative ? provider.getBalance(record.poolAddress) : token1Contract.balanceOf(record.poolAddress),
  ]);

  const reserve0 = formatTokenAmount(balance0Raw, token0.decimals);
  const reserve1 = formatTokenAmount(balance1Raw, token1.decimals);
  const poolLiquidity = String(liquidityRaw);
  const positionLiquidity = String(record.positionLiquidity || '0');
  const active = BigInt(positionLiquidity) > 0n;
  const priceCurrent = compactNumber(tickToPrice(slot0.tick, token0.decimals, token1.decimals), 6);
  const tvlApproxUsd = estimateTvlApproxUsd(token0, reserve0, token1, reserve1);
  const rangeLowerPrice = compactNumber(tickToPrice(record.tickLower, token0.decimals, token1.decimals), 6);
  const rangeUpperPrice = compactNumber(tickToPrice(record.tickUpper, token0.decimals, token1.decimals), 6);
  const historicalPrice = await resolveHistoricalSpotPrice({
    blockNumber: record.mintBlockNumber,
    fetchAtBlock: async (blockTag) => {
      const historicalSlot0 = await pool.slot0({ blockTag });
      return {
        tick: Number(historicalSlot0.tick),
        price: tickToPrice(historicalSlot0.tick, token0.decimals, token1.decimals),
      };
    },
  });
  const rangeVisual = computeRangeVisual(
    rangeLowerPrice,
    rangeUpperPrice,
    historicalPrice.price,
    priceCurrent
  );
  const inRange =
    record.tickLower != null &&
    record.tickUpper != null &&
    Number(slot0.tick) >= Number(record.tickLower) &&
    Number(slot0.tick) <= Number(record.tickUpper);
  const lpMeta = buildLpMeta(record);

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
    priceAtOpen: historicalPrice.price,
    priceAtOpenAccuracy: historicalPrice.accuracy,
    priceAtOpenBlock: historicalPrice.blockNumber,
    inRange,
    currentOutOfRangeSide: rangeVisual.currentOutOfRangeSide,
    priceCurrent,
    priceApprox: priceCurrent,
    priceQuoteSymbol: token1.symbol,
    priceBaseSymbol: token0.symbol,
    tvlApproxUsd,
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

async function enrichV4Record(provider, networkConfig, record) {
  const [token0, token1] = await Promise.all([
    getTokenMeta(provider, networkConfig, record.token0Address),
    getTokenMeta(provider, networkConfig, record.token1Address),
  ]);

  const stateView = new ethers.Contract(
    normalizeAddress(networkConfig.deployments.v4.stateView),
    V4_STATE_VIEW_ABI,
    provider
  );
  const poolId = record.poolId || record.identifier;

  const [slot0, liquidityRaw] = await Promise.all([
    stateView.getSlot0(poolId),
    stateView.getLiquidity(poolId),
  ]);

  const liquidity = String(liquidityRaw);
  const active = liquidityRaw > 0n;
  const priceCurrent = compactNumber(tickToPrice(slot0.tick, token0.decimals, token1.decimals), 6);
  const rangeLowerPrice = compactNumber(tickToPrice(record.tickLower, token0.decimals, token1.decimals), 6);
  const rangeUpperPrice = compactNumber(tickToPrice(record.tickUpper, token0.decimals, token1.decimals), 6);
  const historicalPrice = await resolveHistoricalSpotPrice({
    blockNumber: record.mintBlockNumber,
    fetchAtBlock: async (blockTag) => {
      const historicalSlot0 = await stateView.getSlot0(poolId, { blockTag });
      return {
        tick: Number(historicalSlot0.tick),
        price: tickToPrice(historicalSlot0.tick, token0.decimals, token1.decimals),
      };
    },
  });
  const rangeVisual = computeRangeVisual(
    rangeLowerPrice,
    rangeUpperPrice,
    historicalPrice.price,
    priceCurrent
  );
  const inRange =
    record.tickLower != null &&
    record.tickUpper != null &&
    Number(slot0.tick) >= Number(record.tickLower) &&
    Number(slot0.tick) <= Number(record.tickUpper);
  const lpMeta = buildLpMeta(record);

  return {
    ...record,
    token0,
    token1,
    poolUrl: null,
    status: active ? 'active' : 'empty',
    liquidity,
    totalSupply: null,
    reserve0: null,
    reserve1: null,
    currentTick: Number(slot0.tick),
    sqrtPriceX96: String(slot0.sqrtPriceX96),
    openedAt: lpMeta.openedAt,
    activeForMs: lpMeta.activeForMs,
    rangeLowerPrice,
    rangeUpperPrice,
    priceAtOpen: historicalPrice.price,
    priceAtOpenAccuracy: historicalPrice.accuracy,
    priceAtOpenBlock: historicalPrice.blockNumber,
    inRange,
    currentOutOfRangeSide: rangeVisual.currentOutOfRangeSide,
    priceCurrent,
    priceApprox: priceCurrent,
    priceQuoteSymbol: token1.symbol,
    priceBaseSymbol: token0.symbol,
    tvlApproxUsd: null,
    poolId,
    liquiditySummary: buildLiquiditySummary(active ? 'active' : 'empty', [
      `Posición #${record.identifier}`,
      `Liquidity: ${liquidity}`,
      record.hooks ? `Hooks: ${record.hooks.slice(0, 8)}...` : null,
    ]),
  };
}

async function enrichRecord(provider, networkConfig, record) {
  if (record.version === 'v1') return enrichV1Record(provider, networkConfig, record);
  if (record.version === 'v2') return enrichV2Record(provider, networkConfig, record);
  if (record.version === 'v3') return enrichV3Record(provider, networkConfig, record);
  return enrichV4Record(provider, networkConfig, record);
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
  const positionManager = new ethers.Contract(positionManagerAddress, V3_POSITION_MANAGER_ABI, provider);
  const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider);

  const balance = await positionManager.balanceOf(wallet);
  const tokenIds = [];
  for (let i = 0n; i < balance; i += 1n) {
    tokenIds.push(String(await positionManager.tokenOfOwnerByIndex(wallet, i)));
  }

  const apiKey = await getUserApiKey(userId).catch(() => null);
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
    const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
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
      tokensOwed0: String(position.tokensOwed0),
      tokensOwed1: String(position.tokensOwed1),
    };
  });

  const enriched = await mapConcurrent(records, 4, async (record) => {
    try {
      return await enrichV3Record(provider, networkConfig, record);
    } catch (err) {
      warnings.push(`No se pudo enriquecer posición v3 ${record.identifier}: ${err.message}`);
      return null;
    }
  });

  const pools = enriched.filter(Boolean).filter(isRelevantRecord);
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
    count: pools.length,
    filteredOutCount: records.length - pools.length,
    inspectedTxCount: records.length,
    totalTxCount: records.length,
    scannedAt: Date.now(),
    warnings: buildWarningsWithDedup(warnings),
    pools,
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
  const positionManager = new ethers.Contract(positionManagerAddress, V4_POSITION_MANAGER_ABI, provider);

  const { rows, truncated } = await fetchWalletNftTransfers(apiKey, networkConfig, wallet, positionManagerAddress);
  const { tokenIds, firstInbound } = collectHeldTokenIds(wallet, rows);
  if (truncated) {
    warnings.push(`Etherscan truncó el historial NFT a ${MAX_NFT_PAGES * NFT_PAGE_SIZE} transferencias`);
  }

  const records = await mapConcurrent(tokenIds, 3, async (tokenId) => {
    const owner = normalizeAddress(await positionManager.ownerOf(tokenId).catch(() => null));
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
      return enrichV4Record(provider, networkConfig, record);
    } catch (err) {
      warnings.push(`No se pudo enriquecer posición v4 ${record.identifier}: ${err.message}`);
      return null;
    }
  });

  const pools = enriched.filter(Boolean).filter(isRelevantRecord);
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
    count: pools.length,
    filteredOutCount: records.filter(Boolean).length - pools.length,
    inspectedTxCount: records.filter(Boolean).length,
    totalTxCount: rows.length,
    scannedAt: Date.now(),
    warnings: buildWarningsWithDedup(warnings),
    pools,
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
      return await enrichRecord(provider, networkConfig, record);
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
    count: pools.length,
    filteredOutCount,
    inspectedTxCount: uniqueTxHashes.length,
    totalTxCount: transactions.length,
    scannedAt: Date.now(),
    warnings,
    pools,
  };
}

module.exports = {
  scanPoolsCreatedByWallet,
  testUserEtherscanKey,
  getSupportMatrix,
  SUPPORTED_NETWORKS,
  computeRangeVisual,
  decodeV4PositionInfo,
  resolveHistoricalSpotPrice,
  tickToPrice,
  parseCreationLogs,
  estimateTvlApproxUsd,
};
