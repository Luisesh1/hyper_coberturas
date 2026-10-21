/**
 * collector.js — lee, fuente por fuente, todo lo que vale una wallet:
 *   tokens:<red>  nativo + ERC-20 en cada red mainnet soportada
 *   lps:<red>     posiciones Uniswap v3/v4 de la wallet en esa red
 *   hl            cuenta Hyperliquid de la misma direccion (perps + spot)
 *
 * Cada fuente devuelve `{ ok: true, usd, items }` o `{ ok: false, error }`.
 * Nunca convierte un fallo en un cero: esa decision es de `mergeSources`.
 */

const logger = require('../logger.service');
const walletBalanceService = require('../wallet-balance.service');
const uniswapService = require('../uniswap.service');
const HyperliquidService = require('../hyperliquid.service');
const config = require('../../config');
const { SUPPORTED_NETWORKS } = require('../uniswap/networks');
const { isStableSymbol } = require('../uniswap/pricing');
const walletMetricsRepo = require('../../repositories/wallet-metrics.repository');
const { valueLpPosition, valueHyperliquid } = require('./valuation');

const SOURCE_TIMEOUT_MS = 3 * 60_000;
const SPOT_META_TTL_MS = 5 * 60_000;
const ABSTRACTION_TTL_MS = 6 * 60 * 60_000;
const HL_INFO_URL = `${config.hyperliquid.apiUrl}/info`;

const hl = new HyperliquidService({});
let spotMetaCache = { at: 0, priceByToken: null };
const abstractionCache = new Map();

function trackedNetworks() {
  return Object.values(SUPPORTED_NETWORKS).filter((n) => !n.isTestnet);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout ${Math.round(ms / 1000)}s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function settle(label, fn) {
  try {
    return await withTimeout(fn(), SOURCE_TIMEOUT_MS, label);
  } catch (err) {
    logger.warn('wallet_metrics_source_failed', { source: label, error: err.message });
    return { ok: false, error: err.message };
  }
}

// ------------------------------------------------------------------
// Tokens
// ------------------------------------------------------------------

async function collectTokens(address, network) {
  const res = await walletBalanceService.getAllTokenBalancesUsd(address, {
    network: network.id,
    nativeSymbol: network.nativeSymbol,
  });
  if (res.errors?.length) return { ok: false, error: res.errors.join('; ') };
  const items = res.tokens.map((t) => ({
    network: network.id,
    symbol: t.symbol,
    address: t.address,
    balance: t.balance,
    priceUsd: t.priced ? t.priceUsd : null,
    usd: t.priced ? Math.round(t.valueUsd * 100) / 100 : 0,
    priced: t.priced,
    priceSource: t.priceSource || (t.priced ? 'hyperliquid' : null),
  }));
  return {
    ok: true,
    usd: items.reduce((sum, t) => sum + t.usd, 0),
    items,
    meta: { unpricedCount: res.unpricedCount || 0 },
  };
}

// ------------------------------------------------------------------
// LPs
// ------------------------------------------------------------------

/**
 * Precio USD por token para valorar LPs: estables a $1, los precios que ya
 * resolvio el escaneo de tokens de la wallet, mids de Hyperliquid y DefiLlama
 * por direccion. Lo que quede sin precio se deduce del pool en valueLpPosition.
 */
async function buildLpPriceResolver(network, positions, walletTokenItems) {
  const mids = await walletBalanceService.getHyperliquidMids();
  const byAddress = new Map();
  for (const t of walletTokenItems || []) {
    if (t.priced && t.address) byAddress.set(String(t.address).toLowerCase(), t.priceUsd);
  }

  const marketPrice = (token) => {
    if (!token) return null;
    const symbol = String(token.symbol || '').toUpperCase();
    if (isStableSymbol(symbol)) return 1;
    if (token.isNative) return walletBalanceService.priceFromMids(mids, network.nativeSymbol);
    const known = byAddress.get(String(token.address || '').toLowerCase());
    if (known) return known;
    return walletBalanceService.priceFromMids(mids, symbol);
  };

  const missing = new Set();
  for (const p of positions) {
    for (const token of [p.token0, p.token1]) {
      if (token?.address && !token.isNative && marketPrice(token) == null) {
        missing.add(String(token.address).toLowerCase());
      }
    }
  }
  if (missing.size) {
    try {
      const prices = await walletBalanceService.fetchDefillamaPrices(network.id, [...missing]);
      for (const [addr, entry] of prices) byAddress.set(addr, entry.price);
    } catch (err) {
      logger.warn('wallet_metrics_lp_defillama_failed', { network: network.id, error: err.message });
    }
  }
  return marketPrice;
}

function toLpItem(position, valuation) {
  return {
    id: position.id,
    network: position.network,
    version: position.version,
    tokenId: position.identifier,
    token0Symbol: position.token0?.symbol || null,
    token1Symbol: position.token1?.symbol || null,
    fee: position.fee ?? null,
    inRange: position.inRange ?? null,
    rangeLowerPrice: position.rangeLowerPrice ?? null,
    rangeUpperPrice: position.rangeUpperPrice ?? null,
    priceCurrent: position.priceCurrent ?? null,
    amount0: position.positionAmount0 ?? null,
    amount1: position.positionAmount1 ?? null,
    fees0: position.unclaimedFees0 ?? null,
    fees1: position.unclaimedFees1 ?? null,
    positionUsd: valuation.positionUsd,
    feesUsd: valuation.feesUsd,
    usd: valuation.usd,
    priceSource0: valuation.priceSource0,
    priceSource1: valuation.priceSource1,
  };
}

async function collectLps({ userId, address, network, walletTokenItems }) {
  const versions = ['v3', 'v4'].filter((v) => network.versions.includes(v));
  const positions = [];
  const discovery = {};
  for (const version of versions) {
    const knownTokenIds = version === 'v4'
      ? await walletMetricsRepo.listKnownV4PositionIds(address, network.id)
      : null;
    const scan = await uniswapService.scanPoolsCreatedByWallet({
      userId, wallet: address, network: network.id, version, lightweight: true, knownTokenIds,
    });
    if (scan.failedIdentifiers?.length) {
      throw new Error(`${version}: no se pudieron leer las posiciones ${scan.failedIdentifiers.join(', ')}`);
    }
    if (scan.discoverySource) discovery[version] = scan.discoverySource;
    positions.push(...(scan.pools || []));
  }
  const priceOf = await buildLpPriceResolver(network, positions, walletTokenItems);
  const items = positions.map((p) => toLpItem(p, valueLpPosition(p, priceOf)));
  // `known_ids`: la red no tiene indexador y solo se ven los LPs de la app.
  const knownOnly = Object.entries(discovery).filter(([, src]) => src === 'known_ids').map(([v]) => v);
  return { ok: true, items, meta: knownOnly.length ? { knownIdsOnly: knownOnly } : null };
}

// ------------------------------------------------------------------
// Hyperliquid
// ------------------------------------------------------------------

async function getSpotPriceByToken() {
  if (spotMetaCache.priceByToken && Date.now() - spotMetaCache.at < SPOT_META_TTL_MS) {
    return spotMetaCache.priceByToken;
  }
  const [meta, ctxs] = await hl._post(HL_INFO_URL, { type: 'spotMetaAndAssetCtxs' }, { endpoint: 'spotMetaAndAssetCtxs' });
  const priceByToken = new Map();
  (meta?.universe || []).forEach((pair, i) => {
    const [base, quote] = pair.tokens || [];
    if (quote !== 0 || priceByToken.has(base)) return; // solo pares contra USDC
    const ctx = ctxs?.[i];
    const px = Number(ctx?.midPx ?? ctx?.markPx);
    if (Number.isFinite(px) && px > 0) priceByToken.set(base, px);
  });
  spotMetaCache = { at: Date.now(), priceByToken };
  return priceByToken;
}

async function getAbstraction(address) {
  const cached = abstractionCache.get(address);
  if (cached && Date.now() - cached.at < ABSTRACTION_TTL_MS) return cached.value;
  const value = await hl._post(HL_INFO_URL, { type: 'userAbstraction', user: address }, { endpoint: 'userAbstraction' });
  abstractionCache.set(address, { value: typeof value === 'string' ? value : null, at: Date.now() });
  return abstractionCache.get(address).value;
}

async function collectHyperliquid(address) {
  const [perp, spot, abstraction] = await Promise.all([
    hl.getClearinghouseState(address),
    hl._post(HL_INFO_URL, { type: 'spotClearinghouseState', user: address }, { endpoint: 'spotClearinghouseState' }),
    getAbstraction(address).catch(() => null),
  ]);
  const needsSpotPrices = (spot?.balances || [])
    .some((b) => Number(b.token) !== 0 && Number(b.total) > 0 && !isStableSymbol(b.coin));
  const priceByToken = needsSpotPrices ? await getSpotPriceByToken() : new Map();
  const value = valueHyperliquid({
    perp,
    spot,
    abstraction,
    spotPriceOf: (b) => {
      if (Number(b.token) === 0 || isStableSymbol(b.coin)) return 1;
      return priceByToken.get(Number(b.token)) ?? null;
    },
  });
  return {
    ok: true,
    usd: value.usd,
    items: value.spot,
    meta: {
      perpUsd: value.perpUsd,
      spotUsd: value.spotUsd,
      unified: value.unified,
      abstraction: value.abstraction,
      positionsCount: value.positionsCount,
      withdrawable: Number(perp?.withdrawable) || 0,
    },
  };
}

// ------------------------------------------------------------------

/**
 * Lee todas las fuentes de una direccion. Redes en paralelo; dentro de cada
 * red, tokens primero porque sus precios sirven para valorar los LPs.
 * `userId` solo decide que claves de Etherscan/Alchemy se usan.
 */
async function collectWallet({ userId, address }) {
  const fresh = {};
  const networkJobs = trackedNetworks().map(async (network) => {
    const tokens = await settle(`tokens:${network.id}`, () => collectTokens(address, network));
    fresh[`tokens:${network.id}`] = tokens;
    fresh[`lps:${network.id}`] = await settle(`lps:${network.id}`, () => collectLps({
      userId, address, network, walletTokenItems: tokens.ok ? tokens.items : [],
    }));
  });
  const hlJob = settle('hl', () => collectHyperliquid(address)).then((r) => { fresh.hl = r; });
  await Promise.all([...networkJobs, hlJob]);
  return fresh;
}

module.exports = {
  collectWallet,
  trackedNetworks,
  // expuestos para tests
  collectHyperliquid,
  collectTokens,
  collectLps,
};
