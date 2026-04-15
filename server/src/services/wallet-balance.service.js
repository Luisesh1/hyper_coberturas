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

// Cache de precios HL: 60s (evita pegar a HL por cada orquestador)
let _hlMidsCache = { value: null, at: 0 };
const HL_MIDS_CACHE_TTL_MS = 60_000;
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

async function getTokenMetadata(network, contractAddress) {
  const key = `${network}:${String(contractAddress).toLowerCase()}`;
  const ttlMs = Math.max(60_000, Number(config.services?.alchemy?.metadataCacheTtlMs) || (6 * 60 * 60_000));
  const cached = _alchemyTokenMetadataCache.get(key);
  if (cached && (Date.now() - cached.at) < ttlMs) {
    return cached.value;
  }
  const value = await alchemyRpc(network, 'alchemy_getTokenMetadata', [contractAddress]);
  _alchemyTokenMetadataCache.set(key, { value, at: Date.now() });
  return value;
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

  // 2) Tokens ERC-20 via alchemy_getTokenBalances
  let tokenBalances = [];
  try {
    const result = await alchemyRpc(network, 'alchemy_getTokenBalances', [walletAddress]);
    tokenBalances = (result?.tokenBalances || []).filter((t) => {
      const n = t.tokenBalance && BigInt(t.tokenBalance);
      return n && n > 0n;
    });
  } catch (err) {
    logger.warn('wallet_balance_erc20_scan_failed', { walletAddress, error: err.message });
  }

  // 3) Metadata + valuacion (concurrencia limitada a 5)
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

        tokens.push({
          symbol,
          address: tb.contractAddress,
          balance,
          decimals,
          priceUsd,
          valueUsd: balance * priceUsd,
          priced: priceUsd > 0,
        });
      } catch (err) {
        logger.warn('wallet_balance_token_meta_failed', {
          walletAddress,
          token: tb.contractAddress,
          error: err.message,
        });
      }
    }));
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
