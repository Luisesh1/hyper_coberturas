// Catalogo de activos por datasource/categoria.
// Cada entrada: { id, symbol, name, datasource, category }

const httpClient = require('../../shared/platform/http/http-client');
const logger = require('../logger.service');

const CATEGORIES = {
  crypto_perp: 'Cripto (perp)',
  crypto_spot: 'Cripto (spot)',
  index: 'Índices',
  commodity: 'Commodities',
  stock: 'Acciones',
  forex: 'Forex',
};

const CURATED_ASSETS = [
  // ---------- Hyperliquid perps ----------
  { symbol: 'BTC',  name: 'Bitcoin',       datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'ETH',  name: 'Ethereum',      datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'SOL',  name: 'Solana',        datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'ARB',  name: 'Arbitrum',      datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'OP',   name: 'Optimism',      datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'DOGE', name: 'Dogecoin',      datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'AVAX', name: 'Avalanche',     datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'BNB',  name: 'BNB',           datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'MATIC', name: 'Polygon',      datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'LINK', name: 'Chainlink',     datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'AAVE', name: 'Aave',          datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'SUI',  name: 'Sui',           datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'APT',  name: 'Aptos',         datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'TIA',  name: 'Celestia',      datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'INJ',  name: 'Injective',     datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'SEI',  name: 'Sei',           datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'LTC',  name: 'Litecoin',      datasource: 'hyperliquid', category: 'crypto_perp' },
  { symbol: 'HYPE', name: 'Hyperliquid',   datasource: 'hyperliquid', category: 'crypto_perp' },

  // ---------- Binance spot ----------
  { symbol: 'BTCUSDT',  name: 'Bitcoin/USDT',   datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'ETHUSDT',  name: 'Ethereum/USDT',  datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'SOLUSDT',  name: 'Solana/USDT',    datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'XRPUSDT',  name: 'XRP/USDT',       datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'BNBUSDT',  name: 'BNB/USDT',       datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin/USDT',  datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'ADAUSDT',  name: 'Cardano/USDT',   datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'DOTUSDT',  name: 'Polkadot/USDT',  datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'MATICUSDT', name: 'Polygon/USDT',  datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'AVAXUSDT', name: 'Avalanche/USDT', datasource: 'binance', category: 'crypto_spot' },
  { symbol: 'LINKUSDT', name: 'Chainlink/USDT', datasource: 'binance', category: 'crypto_spot' },

  // ---------- Indices (Yahoo) ----------
  { symbol: '^GSPC', name: 'S&P 500',            datasource: 'yahoo', category: 'index' },
  { symbol: '^NDX',  name: 'Nasdaq 100',         datasource: 'yahoo', category: 'index' },
  { symbol: '^DJI',  name: 'Dow Jones',          datasource: 'yahoo', category: 'index' },
  { symbol: '^RUT',  name: 'Russell 2000',       datasource: 'yahoo', category: 'index' },
  { symbol: '^VIX',  name: 'VIX (volatilidad)',  datasource: 'yahoo', category: 'index' },
  { symbol: '^IXIC', name: 'Nasdaq Composite',   datasource: 'yahoo', category: 'index' },
  { symbol: '^FTSE', name: 'FTSE 100 (UK)',      datasource: 'yahoo', category: 'index' },
  { symbol: '^N225', name: 'Nikkei 225 (Japón)', datasource: 'yahoo', category: 'index' },

  // ---------- Commodities (Yahoo futuros) ----------
  { symbol: 'GC=F', name: 'Oro',              datasource: 'yahoo', category: 'commodity' },
  { symbol: 'SI=F', name: 'Plata',            datasource: 'yahoo', category: 'commodity' },
  { symbol: 'CL=F', name: 'Petróleo WTI',     datasource: 'yahoo', category: 'commodity' },
  { symbol: 'BZ=F', name: 'Petróleo Brent',   datasource: 'yahoo', category: 'commodity' },
  { symbol: 'NG=F', name: 'Gas natural',      datasource: 'yahoo', category: 'commodity' },
  { symbol: 'HG=F', name: 'Cobre',            datasource: 'yahoo', category: 'commodity' },
  { symbol: 'PL=F', name: 'Platino',          datasource: 'yahoo', category: 'commodity' },
  { symbol: 'ZC=F', name: 'Maíz',             datasource: 'yahoo', category: 'commodity' },

  // ---------- Stocks (Yahoo) ----------
  { symbol: 'AAPL', name: 'Apple',          datasource: 'yahoo', category: 'stock' },
  { symbol: 'MSFT', name: 'Microsoft',      datasource: 'yahoo', category: 'stock' },
  { symbol: 'NVDA', name: 'NVIDIA',         datasource: 'yahoo', category: 'stock' },
  { symbol: 'TSLA', name: 'Tesla',          datasource: 'yahoo', category: 'stock' },
  { symbol: 'AMZN', name: 'Amazon',         datasource: 'yahoo', category: 'stock' },
  { symbol: 'GOOGL', name: 'Alphabet',      datasource: 'yahoo', category: 'stock' },
  { symbol: 'META', name: 'Meta Platforms', datasource: 'yahoo', category: 'stock' },
  { symbol: 'AMD',  name: 'AMD',            datasource: 'yahoo', category: 'stock' },
  { symbol: 'INTC', name: 'Intel',          datasource: 'yahoo', category: 'stock' },
  { symbol: 'NFLX', name: 'Netflix',        datasource: 'yahoo', category: 'stock' },
  { symbol: 'COIN', name: 'Coinbase',       datasource: 'yahoo', category: 'stock' },
  { symbol: 'MSTR', name: 'MicroStrategy',  datasource: 'yahoo', category: 'stock' },
  { symbol: 'SPY',  name: 'SPDR S&P 500 ETF', datasource: 'yahoo', category: 'stock' },
  { symbol: 'QQQ',  name: 'Invesco Nasdaq 100 ETF', datasource: 'yahoo', category: 'stock' },
  { symbol: 'GLD',  name: 'SPDR Gold ETF',  datasource: 'yahoo', category: 'stock' },

  // ---------- Forex (Yahoo) ----------
  { symbol: 'EURUSD=X', name: 'EUR/USD', datasource: 'yahoo', category: 'forex' },
  { symbol: 'GBPUSD=X', name: 'GBP/USD', datasource: 'yahoo', category: 'forex' },
  { symbol: 'USDJPY=X', name: 'USD/JPY', datasource: 'yahoo', category: 'forex' },
  { symbol: 'USDMXN=X', name: 'USD/MXN', datasource: 'yahoo', category: 'forex' },
  { symbol: 'USDCAD=X', name: 'USD/CAD', datasource: 'yahoo', category: 'forex' },
  { symbol: 'AUDUSD=X', name: 'AUD/USD', datasource: 'yahoo', category: 'forex' },
].map((a) => ({ ...a, id: `${a.datasource}:${a.symbol}` }));

const CACHE_TTL_MS = 10 * 60 * 1000;
let catalogCache = null;

const LEVERAGED_TOKEN_PATTERN = /(UP|DOWN|BULL|BEAR)USDT$/;

function decorate(asset) {
  return { ...asset, id: `${asset.datasource}:${asset.symbol}` };
}

function sortAssets(assets) {
  return assets.slice().sort((a, b) => {
    if (a.datasource !== b.datasource) return a.datasource.localeCompare(b.datasource);
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.symbol.localeCompare(b.symbol);
  });
}

function listAssets() {
  return CURATED_ASSETS.map((a) => ({ ...a }));
}

function findAsset(datasource, symbol) {
  return CURATED_ASSETS.find((a) => a.datasource === datasource && a.symbol === symbol) || null;
}

function curatedByDatasource(datasource) {
  return CURATED_ASSETS.filter((a) => a.datasource === datasource).map((a) => ({ ...a }));
}

async function listBinanceAssets() {
  const { data } = await httpClient.get('https://api.binance.com/api/v3/exchangeInfo', { timeout: 15_000 });
  const symbols = Array.isArray(data?.symbols) ? data.symbols : [];

  return symbols
    .filter((s) =>
      s?.status === 'TRADING' &&
      s?.quoteAsset === 'USDT' &&
      s?.isSpotTradingAllowed !== false &&
      typeof s.symbol === 'string' &&
      s.symbol.endsWith('USDT') &&
      !LEVERAGED_TOKEN_PATTERN.test(s.symbol)
    )
    .map((s) => decorate({
      symbol: s.symbol,
      name: `${s.baseAsset}/${s.quoteAsset}`,
      datasource: 'binance',
      category: 'crypto_spot',
      source: 'exchange',
    }));
}

async function listHyperliquidAssets() {
  const { data } = await httpClient.post('https://api.hyperliquid.xyz/info', { type: 'meta' }, { timeout: 10_000 });
  const universe = Array.isArray(data?.universe) ? data.universe : [];

  return universe
    .filter((asset) => typeof asset?.name === 'string' && asset.name.trim())
    .map((asset) => decorate({
      symbol: asset.name,
      name: asset.name,
      datasource: 'hyperliquid',
      category: 'crypto_perp',
      source: 'exchange',
    }));
}

async function safeDynamicAssets(datasource, loader) {
  try {
    const assets = await loader();
    if (assets.length > 0) return assets;
  } catch (err) {
    logger.warn?.('asset_catalog_dynamic_fetch_failed', { datasource, error: err.message });
  }
  return curatedByDatasource(datasource).map((asset) => ({ ...asset, source: 'curated' }));
}

async function listCatalogAssets({ refresh = false } = {}) {
  if (!refresh && catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.assets.map((a) => ({ ...a }));
  }

  const [hyperliquid, binance] = await Promise.all([
    safeDynamicAssets('hyperliquid', listHyperliquidAssets),
    safeDynamicAssets('binance', listBinanceAssets),
  ]);
  const yahoo = curatedByDatasource('yahoo').map((asset) => ({ ...asset, source: 'curated' }));
  const assets = sortAssets([...hyperliquid, ...binance, ...yahoo]);

  catalogCache = {
    assets,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  return assets.map((a) => ({ ...a }));
}

function clearCatalogCache() {
  catalogCache = null;
}

module.exports = {
  ASSETS: CURATED_ASSETS,
  CATEGORIES,
  listAssets,
  listCatalogAssets,
  findAsset,
  clearCatalogCache,
};
