/**
 * wallet-balance.service.js
 *
 * Lee todos los balances ERC-20 + ETH nativo de una wallet en Arbitrum via
 * Alchemy RPC y los valua en USD. Se usa desde orchestrator-metrics.service
 * para construir el componente "wallet" del snapshot horario.
 *
 * Estrategia de pricing:
 *  - stables (USDC, USDT, DAI, ...): $1
 *  - ETH / WETH: precio mid de Hyperliquid (allMids)
 *  - otros tokens: intenta allMids por simbolo. Si no existe, devuelve
 *    valor 0 pero incluye el token en el breakdown con `priced: false`.
 */

const httpClient = require('../shared/platform/http/http-client');
const config = require('../config');
const logger = require('./logger.service');
const { isStableSymbol } = require('./uniswap/pricing');
const {
  computeBackoffMs,
  isAlchemyRateLimitError,
  sleep,
} = require('./external-service-helpers');

const HL_INFO_URL = `${config.hyperliquid.apiUrl}/info`;
const DEFILLAMA_PRICES_URL = 'https://coins.llama.fi/prices/current';
// Chains DefiLlama (llama-key): arbitrum, ethereum, etc. Debe alinearse con
// las keys de `config.uniswap.rpcUrls`.
const DEFILLAMA_CHAIN_BY_NETWORK = {
  arbitrum: 'arbitrum',
  ethereum: 'ethereum',
  base: 'base',
  optimism: 'optimism',
  polygon: 'polygon',
};

// Lista curada de ERC-20 comunes por red — usada como fallback cuando el
// RPC no soporta métodos Alchemy-propietarios (`alchemy_getTokenBalances`).
// Con RPCs públicos (publicnode, ankr, etc.) es la única forma estándar de
// escanear balances sin un indexador externo. Cubre >95% de USD típico.
const CURATED_TOKENS_BY_NETWORK = {
  arbitrum: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC',   decimals: 6 },
    { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', symbol: 'USDC.E', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT',   decimals: 6 },
    { address: '0xDA10009cBd5D07dD0CeCc66161FC93D7c9000da1', symbol: 'DAI',    decimals: 18 },
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH',   decimals: 18 },
    { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC',   decimals: 8 },
    { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB',    decimals: 18 },
    { address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', symbol: 'LINK',   decimals: 18 },
    { address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', symbol: 'GMX',    decimals: 18 },
    { address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8', symbol: 'PENDLE', decimals: 18 },
    { address: '0x3082CC23568eA640225c2467653dB90e9250AaA0', symbol: 'RDNT',   decimals: 18 },
    { address: '0x539bdE0d7Dbd336b79148AA742883198BBF60342', symbol: 'MAGIC',  decimals: 18 },
    { address: '0x5979D7b546E38E414F7E9822514be443A4800529', symbol: 'wstETH', decimals: 18 },
    { address: '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe', symbol: 'weETH',  decimals: 18 },
    { address: '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8', symbol: 'rETH',   decimals: 18 },
    { address: '0x5AFFeBD4A567F79e1a8d06c4F0C8d53D1a1F85bD', symbol: 'cbETH',  decimals: 18 },
    { address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', symbol: 'UNI',    decimals: 18 },
    { address: '0xBA5DdD1f9d7F570dc94a51479a000E3BCE967196', symbol: 'AAVE',   decimals: 18 },
  ],
  ethereum: [
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC',   decimals: 6 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT',   decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI',    decimals: 18 },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH',   decimals: 18 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC',   decimals: 8 },
  ],
  optimism: [
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC',   decimals: 6 },
    { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT',   decimals: 6 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH',   decimals: 18 },
  ],
  base: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC',   decimals: 6 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH',   decimals: 18 },
  ],
  polygon: [
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC',   decimals: 6 },
    { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC.E', decimals: 6 },
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT',   decimals: 6 },
    { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH',   decimals: 18 },
  ],
};

// Selector de balanceOf(address): keccak256("balanceOf(address)")[0..4]
const BALANCE_OF_SELECTOR = '0x70a08231';

function encodeBalanceOfCall(walletAddress) {
  const clean = String(walletAddress).toLowerCase().replace(/^0x/, '');
  return `${BALANCE_OF_SELECTOR}${'0'.repeat(64 - clean.length)}${clean}`;
}

// Cache de precios HL: 60s (evita pegar a HL por cada orquestador)
let _hlMidsCache = { value: null, at: 0 };
const HL_MIDS_CACHE_TTL_MS = 60_000;
// Cache de precios DefiLlama: 10 min por contract address
const DEFILLAMA_CACHE_TTL_MS = 10 * 60_000;
const _defillamaCache = new Map();
let _alchemyLastDispatchAt = 0;
let _alchemyInFlight = 0;
let _alchemyTimer = null;
const _alchemyQueue = [];
const _alchemyTokenMetadataCache = new Map();

async function getHyperliquidMids() {
  if (_hlMidsCache.value && (Date.now() - _hlMidsCache.at) < HL_MIDS_CACHE_TTL_MS) {
    return _hlMidsCache.value;
  }
  try {
    const { data } = await httpClient.post(HL_INFO_URL, { type: 'allMids' }, { timeout: 10_000 });
    _hlMidsCache = { value: data, at: Date.now() };
    return data;
  } catch (err) {
    logger.warn('hl_all_mids_fetch_failed', { error: err.message });
    return _hlMidsCache.value || {};
  }
}

function priceFromMids(mids, symbol) {
  if (!mids || !symbol) return null;
  // Hyperliquid usa simbolos como "ETH", "BTC", etc. (spot y perp).
  // Los stables no estan en allMids; ya los filtramos antes.
  const key = String(symbol).toUpperCase();
  const candidates = [key, key.replace(/^W/, ''), `@${key}`];
  for (const candidate of candidates) {
    const raw = mids[candidate];
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function normalizeSymbol(sym) {
  return String(sym || '').trim().toUpperCase();
}

async function alchemyRpc(network, method, params) {
  return new Promise((resolve, reject) => {
    _alchemyQueue.push({ network, method, params, resolve, reject });
    scheduleAlchemyQueue();
  });
}

function scheduleAlchemyQueue() {
  if (_alchemyTimer || _alchemyQueue.length === 0) return;

  const maxConcurrent = Math.max(1, Number(config.services?.alchemy?.maxConcurrent) || 2);
  if (_alchemyInFlight >= maxConcurrent) return;

  const minIntervalMs = Math.max(0, Number(config.services?.alchemy?.minIntervalMs) || 120);
  const waitMs = Math.max(0, (_alchemyLastDispatchAt + minIntervalMs) - Date.now());
  _alchemyTimer = setTimeout(() => {
    _alchemyTimer = null;
    void processAlchemyQueue();
  }, waitMs);
}

async function processAlchemyQueue() {
  const maxConcurrent = Math.max(1, Number(config.services?.alchemy?.maxConcurrent) || 2);

  while (_alchemyQueue.length > 0 && _alchemyInFlight < maxConcurrent) {
    const job = _alchemyQueue.shift();
    _alchemyInFlight += 1;
    _alchemyLastDispatchAt = Date.now();
    executeAlchemyJob(job)
      .then(job.resolve)
      .catch(job.reject)
      .finally(() => {
        _alchemyInFlight = Math.max(0, _alchemyInFlight - 1);
        scheduleAlchemyQueue();
      });
  }
}

async function executeAlchemyJob(job) {
  const url = config.uniswap.rpcUrls[job.network];
  if (!url) throw new Error(`RPC no configurado para ${job.network}`);

  const maxAttempts = Math.max(1, Number(config.services?.alchemy?.retryMaxAttempts) || 4);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const { data } = await httpClient.post(
        url,
        { jsonrpc: '2.0', id: 1, method: job.method, params: job.params },
        { timeout: 15_000 }
      );
      if (data.error) {
        throw new Error(data.error.message || `RPC error: ${job.method}`);
      }
      return data.result;
    } catch (err) {
      const retryable = isAlchemyRateLimitError(err);
      const lastAttempt = attempt >= maxAttempts - 1;
      if (!retryable || lastAttempt) {
        throw err;
      }

      const delayMs = computeBackoffMs(attempt, {
        baseMs: 500,
        capMs: 10_000,
        jitterMs: 250,
      });
      logger.warn('alchemy_rpc_retry_scheduled', {
        network: job.network,
        method: job.method,
        attempt: attempt + 1,
        delayMs,
        error: err.message,
      });
      await sleep(delayMs);
    }
  }

  throw new Error(`RPC error: ${job.method}`);
}

/**
 * Fallback de pricing: DefiLlama expone precios USD de miles de tokens por
 * `chain:address` sin autenticación. Cachea por 10 minutos por token.
 * @returns {Promise<Map<string, { price: number, symbol: string }>>} mapa de
 *   contract-address (lowercase) a { price, symbol }.
 */
async function fetchDefillamaPrices(network, addresses) {
  const chain = DEFILLAMA_CHAIN_BY_NETWORK[network];
  if (!chain || !Array.isArray(addresses) || addresses.length === 0) return new Map();

  const now = Date.now();
  const result = new Map();
  const toFetch = [];
  for (const addr of addresses) {
    if (!addr) continue;
    const key = String(addr).toLowerCase();
    const cached = _defillamaCache.get(`${chain}:${key}`);
    if (cached && (now - cached.at) < DEFILLAMA_CACHE_TTL_MS) {
      if (cached.value) result.set(key, cached.value);
      continue;
    }
    toFetch.push(key);
  }
  if (toFetch.length === 0) return result;

  // DefiLlama acepta hasta 100 coins por request (separados por comma).
  for (let i = 0; i < toFetch.length; i += 100) {
    const batch = toFetch.slice(i, i + 100);
    const coins = batch.map((addr) => `${chain}:${addr}`).join(',');
    try {
      const { data } = await httpClient.get(
        `${DEFILLAMA_PRICES_URL}/${encodeURIComponent(coins)}?searchWidth=4h`,
        { timeout: 10_000 }
      );
      const fetchedMap = data?.coins || {};
      for (const addr of batch) {
        const entry = fetchedMap[`${chain}:${addr}`];
        const price = Number(entry?.price);
        const value = Number.isFinite(price) && price > 0
          ? { price, symbol: entry?.symbol || null }
          : null;
        _defillamaCache.set(`${chain}:${addr}`, { value, at: now });
        if (value) result.set(addr, value);
      }
    } catch (err) {
      logger.warn('defillama_prices_fetch_failed', { chain, count: batch.length, error: err.message });
      // Marcamos los batched como "consultados sin éxito" para no martillar.
      for (const addr of batch) {
        _defillamaCache.set(`${chain}:${addr}`, { value: null, at: now });
      }
    }
  }
  return result;
}

async function getTokenMetadata(network, contractAddress) {
  const key = `${network}:${String(contractAddress).toLowerCase()}`;
  const ttlMs = Math.max(60_000, Number(config.services?.alchemy?.metadataCacheTtlMs) || (6 * 60 * 60_000));
  const cached = _alchemyTokenMetadataCache.get(key);
  if (cached && (Date.now() - cached.at) < ttlMs) {
    return cached.value;
  }
  try {
    const value = await alchemyRpc(network, 'alchemy_getTokenMetadata', [contractAddress]);
    _alchemyTokenMetadataCache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    // Fallback para RPCs no-Alchemy: usar la tabla curada si está ahí.
    const curated = (CURATED_TOKENS_BY_NETWORK[network] || []).find(
      (t) => t.address.toLowerCase() === String(contractAddress).toLowerCase()
    );
    if (curated) {
      const value = { symbol: curated.symbol, decimals: curated.decimals, name: curated.symbol };
      _alchemyTokenMetadataCache.set(key, { value, at: Date.now() });
      return value;
    }
    // Sin curated: propagar para que el llamador skip-ee este token.
    throw err;
  }
}

/**
 * Fallback de escaneo de balances cuando el RPC no soporta
 * `alchemy_getTokenBalances`. Consulta `balanceOf(wallet)` en cada token de
 * la lista curada vía `eth_call` estándar (ERC-20 selector 0x70a08231).
 * Limita concurrencia respetando el scheduler de `alchemyRpc` (que en realidad
 * sólo garantiza throttling — funciona contra cualquier JSON-RPC).
 */
async function scanCuratedTokens(network, walletAddress) {
  const list = CURATED_TOKENS_BY_NETWORK[network] || [];
  if (list.length === 0) return [];
  const data = encodeBalanceOfCall(walletAddress);
  const results = await Promise.all(list.map(async (token) => {
    try {
      const hex = await alchemyRpc(network, 'eth_call', [
        { to: token.address, data },
        'latest',
      ]);
      if (!hex || hex === '0x') return null;
      const raw = BigInt(hex);
      if (raw <= 0n) return null;
      return { contractAddress: token.address, tokenBalance: hex };
    } catch (err) {
      logger.warn('wallet_balance_curated_balanceOf_failed', {
        network, token: token.symbol, error: err.message,
      });
      return null;
    }
  }));
  return results.filter(Boolean);
}

/**
 * Devuelve todos los balances de la wallet en Arbitrum valuados en USD.
 * @returns {Promise<{
 *   totalUsd: number,
 *   pricedUsd: number,
 *   unpricedCount: number,
 *   tokens: Array<{ symbol, address, balance, decimals, priceUsd, valueUsd, priced }>
 * }>}
 */
async function getAllTokenBalancesUsd(walletAddress, { network = 'arbitrum' } = {}) {
  if (!walletAddress) {
    return { totalUsd: 0, pricedUsd: 0, unpricedCount: 0, tokens: [] };
  }

  const mids = await getHyperliquidMids();
  const tokens = [];

  // 1) ETH nativo
  try {
    const wei = await alchemyRpc(network, 'eth_getBalance', [walletAddress, 'latest']);
    const balanceEth = Number(BigInt(wei)) / 1e18;
    if (balanceEth > 0) {
      const priceUsd = priceFromMids(mids, 'ETH') || 0;
      tokens.push({
        symbol: 'ETH',
        address: '0x0000000000000000000000000000000000000000',
        balance: balanceEth,
        decimals: 18,
        priceUsd,
        valueUsd: balanceEth * priceUsd,
        priced: priceUsd > 0,
      });
    }
  } catch (err) {
    logger.warn('wallet_balance_eth_fetch_failed', { walletAddress, error: err.message });
  }

  // 2) Tokens ERC-20.
  // Estrategia:
  //  (a) Intentar `alchemy_getTokenBalances` con 'erc20' — escanea TODO.
  //      Sin el segundo arg, Alchemy filtra por DEFAULT_TOKENS (top-100) y
  //      omite tokens comunes de Arbitrum (USDC.e, GMX, MAGIC, etc.).
  //  (b) Fallback a lista curada + `eth_call(balanceOf)` estándar cuando
  //      el RPC no es Alchemy (publicnode, ankr, infura-free, etc.) y no
  //      expone el método propietario.
  let tokenBalances = [];
  try {
    const result = await alchemyRpc(network, 'alchemy_getTokenBalances', [walletAddress, 'erc20']);
    tokenBalances = (result?.tokenBalances || []).filter((t) => {
      const raw = t.tokenBalance;
      if (!raw) return false;
      try {
        return BigInt(raw) > 0n;
      } catch {
        return false;
      }
    });
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    const isMethodMissing = msg.includes('does not exist')
      || msg.includes('not available')
      || msg.includes('method not found')
      || msg.includes('unsupported');
    if (isMethodMissing) {
      tokenBalances = await scanCuratedTokens(network, walletAddress);
      logger.info('wallet_balance_fallback_curated', {
        walletAddress,
        network,
        scanned: tokenBalances.length,
      });
    } else {
      logger.warn('wallet_balance_erc20_scan_failed', { walletAddress, error: err.message });
    }
  }

  // 3) Metadata + valuacion (concurrencia limitada a 5)
  const unpricedForFallback = [];
  const chunks = [];
  const BATCH = Math.max(1, Number(config.services?.alchemy?.maxConcurrent) || 2);
  for (let i = 0; i < tokenBalances.length; i += BATCH) {
    chunks.push(tokenBalances.slice(i, i + BATCH));
  }
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (tb) => {
      try {
        const meta = await getTokenMetadata(network, tb.contractAddress);
        const decimals = Number(meta?.decimals ?? 18);
        const symbol = normalizeSymbol(meta?.symbol || '?');
        const balance = Number(BigInt(tb.tokenBalance)) / Math.pow(10, decimals);
        if (!Number.isFinite(balance) || balance <= 0) return;

        let priceUsd;
        if (isStableSymbol(symbol)) {
          priceUsd = 1;
        } else if (symbol === 'WETH') {
          priceUsd = priceFromMids(mids, 'ETH') || 0;
        } else {
          priceUsd = priceFromMids(mids, symbol) || 0;
        }

        const token = {
          symbol,
          address: tb.contractAddress,
          balance,
          decimals,
          priceUsd,
          valueUsd: balance * priceUsd,
          priced: priceUsd > 0,
          priceSource: priceUsd > 0 ? (isStableSymbol(symbol) ? 'stable' : 'hyperliquid') : null,
        };
        tokens.push(token);
        if (!token.priced) unpricedForFallback.push(token);
      } catch (err) {
        logger.warn('wallet_balance_token_meta_failed', {
          walletAddress,
          token: tb.contractAddress,
          error: err.message,
        });
      }
    }));
  }

  // 4) Fallback de pricing vía DefiLlama para tokens que Hyperliquid no lista.
  // Esto cubre tokens Arbitrum-nativos (GMX, MAGIC, PENDLE, RDNT, etc.) que
  // de otro modo se contarían con valueUsd = 0.
  if (unpricedForFallback.length > 0) {
    try {
      const priceMap = await fetchDefillamaPrices(network, unpricedForFallback.map((t) => t.address));
      for (const token of unpricedForFallback) {
        const key = String(token.address).toLowerCase();
        const entry = priceMap.get(key);
        if (entry && Number.isFinite(entry.price) && entry.price > 0) {
          token.priceUsd = entry.price;
          token.valueUsd = token.balance * entry.price;
          token.priced = true;
          token.priceSource = 'defillama';
        }
      }
    } catch (err) {
      logger.warn('wallet_balance_defillama_fallback_failed', { walletAddress, error: err.message });
    }
  }

  const totalUsd = tokens.reduce((sum, t) => sum + (t.valueUsd || 0), 0);
  const pricedUsd = tokens.filter((t) => t.priced).reduce((sum, t) => sum + t.valueUsd, 0);
  const unpricedCount = tokens.filter((t) => !t.priced).length;

  return {
    totalUsd,
    pricedUsd,
    unpricedCount,
    tokens,
  };
}

module.exports = {
  getAllTokenBalancesUsd,
  getHyperliquidMids, // exportado para tests
};
