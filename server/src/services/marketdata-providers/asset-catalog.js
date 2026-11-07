// Catalogo de activos por datasource/categoria.
// Cada entrada: { id, symbol, name, datasource, category }

const httpClient = require('../../shared/platform/http/http-client');
const logger = require('../logger.service');

const CATEGORIES = {
  crypto_perp: 'Cripto (perp)',
  crypto_spot: 'Cripto (spot)',
  index: 'Índices',
  commodity: 'Commodities',
  stock_us_top: 'USA Top 100',
  stock_ai: 'Inteligencia artificial',
  stock_quantum: 'Computación cuántica',
  stock: 'Otras acciones',
  etf: 'ETF',
  forex: 'Forex',
};

// Un activo vive en una sola categoría (su id es único), pero puede aparecer también en
// otras cestas temáticas con `extraCategories`: NVIDIA es del Top 100 y también de IA.
const EXTRA_CATEGORIES = {
  NVDA: ['stock_ai'],
  MSFT: ['stock_ai'],
  GOOGL: ['stock_ai', 'stock_quantum'],
  META: ['stock_ai'],
  AMZN: ['stock_ai'],
  AMD: ['stock_ai'],
  AVGO: ['stock_ai'],
  PLTR: ['stock_ai'],
  ORCL: ['stock_ai'],
  MU: ['stock_ai'],
  CRM: ['stock_ai'],
  NOW: ['stock_ai'],
  IBM: ['stock_ai', 'stock_quantum'],
  // Honeywell es la accionista mayoritaria de Quantinuum.
  HON: ['stock_quantum'],
};

// 100 grandes compañías estadounidenses, tomando como base el universo del
// S&P 100. Se conserva una sola clase de Alphabet para mantener 100 símbolos.
// Yahoo Finance usa guion para Berkshire Hathaway (BRK-B).
const USA_TOP_100 = [
  ['AAPL', 'Apple'],
  ['ABBV', 'AbbVie'],
  ['ABT', 'Abbott Laboratories'],
  ['ACN', 'Accenture'],
  ['ADBE', 'Adobe'],
  ['AMAT', 'Applied Materials'],
  ['AMD', 'Advanced Micro Devices'],
  ['AMGN', 'Amgen'],
  ['AMT', 'American Tower'],
  ['AMZN', 'Amazon'],
  ['AVGO', 'Broadcom'],
  ['AXP', 'American Express'],
  ['BA', 'Boeing'],
  ['BAC', 'Bank of America'],
  ['BK', 'BNY Mellon'],
  ['BKNG', 'Booking Holdings'],
  ['BLK', 'BlackRock'],
  ['BMY', 'Bristol Myers Squibb'],
  ['BRK-B', 'Berkshire Hathaway Class B'],
  ['C', 'Citigroup'],
  ['CAT', 'Caterpillar'],
  ['CL', 'Colgate-Palmolive'],
  ['CMCSA', 'Comcast'],
  ['COF', 'Capital One'],
  ['COP', 'ConocoPhillips'],
  ['COST', 'Costco'],
  ['CRM', 'Salesforce'],
  ['CSCO', 'Cisco'],
  ['CVS', 'CVS Health'],
  ['CVX', 'Chevron'],
  ['DE', 'Deere & Company'],
  ['DHR', 'Danaher'],
  ['DIS', 'Walt Disney'],
  ['DUK', 'Duke Energy'],
  ['EMR', 'Emerson Electric'],
  ['FDX', 'FedEx'],
  ['GD', 'General Dynamics'],
  ['GE', 'GE Aerospace'],
  ['GEV', 'GE Vernova'],
  ['GILD', 'Gilead Sciences'],
  ['GM', 'General Motors'],
  ['GOOGL', 'Alphabet Class A'],
  ['GS', 'Goldman Sachs'],
  ['HD', 'Home Depot'],
  ['HON', 'Honeywell'],
  ['IBM', 'IBM'],
  ['INTC', 'Intel'],
  ['INTU', 'Intuit'],
  ['ISRG', 'Intuitive Surgical'],
  ['JNJ', 'Johnson & Johnson'],
  ['JPM', 'JPMorgan Chase'],
  ['KO', 'Coca-Cola'],
  ['LIN', 'Linde'],
  ['LLY', 'Eli Lilly'],
  ['LMT', 'Lockheed Martin'],
  ['LOW', "Lowe's"],
  ['LRCX', 'Lam Research'],
  ['MA', 'Mastercard'],
  ['MCD', "McDonald's"],
  ['MDLZ', 'Mondelez International'],
  ['MDT', 'Medtronic'],
  ['META', 'Meta Platforms'],
  ['MMM', '3M'],
  ['MO', 'Altria'],
  ['MRK', 'Merck'],
  ['MS', 'Morgan Stanley'],
  ['MSFT', 'Microsoft'],
  ['MU', 'Micron Technology'],
  ['NEE', 'NextEra Energy'],
  ['NFLX', 'Netflix'],
  ['NKE', 'Nike'],
  ['NOW', 'ServiceNow'],
  ['NVDA', 'NVIDIA'],
  ['ORCL', 'Oracle'],
  ['PEP', 'PepsiCo'],
  ['PFE', 'Pfizer'],
  ['PG', 'Procter & Gamble'],
  ['PLTR', 'Palantir Technologies'],
  ['PM', 'Philip Morris International'],
  ['QCOM', 'Qualcomm'],
  ['RTX', 'RTX'],
  ['SBUX', 'Starbucks'],
  ['SCHW', 'Charles Schwab'],
  ['SO', 'Southern Company'],
  ['SPG', 'Simon Property Group'],
  ['T', 'AT&T'],
  ['TMO', 'Thermo Fisher Scientific'],
  ['TMUS', 'T-Mobile US'],
  ['TSLA', 'Tesla'],
  ['TXN', 'Texas Instruments'],
  ['UBER', 'Uber'],
  ['UNH', 'UnitedHealth Group'],
  ['UNP', 'Union Pacific'],
  ['UPS', 'United Parcel Service'],
  ['USB', 'U.S. Bancorp'],
  ['V', 'Visa'],
  ['VZ', 'Verizon'],
  ['WFC', 'Wells Fargo'],
  ['WMT', 'Walmart'],
  ['XOM', 'Exxon Mobil'],
].map(([symbol, name]) => ({
  symbol,
  name,
  datasource: 'yahoo',
  category: 'stock_us_top',
  ...(EXTRA_CATEGORIES[symbol] ? { extraCategories: EXTRA_CATEGORIES[symbol] } : {}),
}));

// Inteligencia artificial fuera del Top 100: chips, infraestructura (nube de GPU, redes,
// energía de centros de datos) y software de IA. Las grandes del Top 100 entran por
// EXTRA_CATEGORIES.
const AI_STOCKS = [
  ['TSM', 'Taiwan Semiconductor (TSMC)'],
  ['ASML', 'ASML Holding'],
  ['ARM', 'Arm Holdings'],
  ['MRVL', 'Marvell Technology'],
  ['SMCI', 'Super Micro Computer'],
  ['DELL', 'Dell Technologies'],
  ['ANET', 'Arista Networks'],
  ['VRT', 'Vertiv'],
  ['CRDO', 'Credo Technology'],
  ['ALAB', 'Astera Labs'],
  ['CRWV', 'CoreWeave'],
  ['NBIS', 'Nebius Group'],
  ['SNOW', 'Snowflake'],
  ['AI', 'C3.ai'],
  ['PATH', 'UiPath'],
  ['SOUN', 'SoundHound AI'],
  ['BBAI', 'BigBear.ai'],
  ['TEM', 'Tempus AI'],
].map(([symbol, name]) => ({
  symbol,
  name,
  datasource: 'yahoo',
  category: 'stock_ai',
}));

const QUANTUM_STOCKS = [
  ['QNT', 'Quantinuum'],
  ['INFQ', 'Infleqtion'],
  ['IONQ', 'IonQ'],
  ['QBTS', 'D-Wave Quantum'],
  ['RGTI', 'Rigetti Computing'],
  ['QUBT', 'Quantum Computing Inc.'],
  ['ARQQ', 'Arqit Quantum'],
  ['LAES', 'SEALSQ'],
  ['BTQ', 'BTQ Technologies'],
  ['XNDU', 'Xanadu Quantum Technologies'],
  // Cotiza en la bolsa de Toronto (TSX Venture), en CAD.
  ['QNC.V', 'Quantum eMotion'],
].map(([symbol, name]) => ({
  symbol,
  name,
  datasource: 'yahoo',
  category: 'stock_quantum',
}));

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
  { symbol: '^SOX',  name: 'PHLX Semiconductores', datasource: 'yahoo', category: 'index' },
  { symbol: '^GDAXI', name: 'DAX (Alemania)',      datasource: 'yahoo', category: 'index' },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50',    datasource: 'yahoo', category: 'index' },
  { symbol: '^STOXX', name: 'Stoxx Europe 600',    datasource: 'yahoo', category: 'index' },
  { symbol: '^FCHI', name: 'CAC 40 (Francia)',     datasource: 'yahoo', category: 'index' },
  { symbol: '^HSI',  name: 'Hang Seng (Hong Kong)', datasource: 'yahoo', category: 'index' },
  { symbol: '000001.SS', name: 'Shanghai Composite (China)', datasource: 'yahoo', category: 'index' },
  { symbol: '^KS11', name: 'KOSPI (Corea del Sur)', datasource: 'yahoo', category: 'index' },
  { symbol: '^NSEI', name: 'Nifty 50 (India)',     datasource: 'yahoo', category: 'index' },
  { symbol: '^AXJO', name: 'S&P/ASX 200 (Australia)', datasource: 'yahoo', category: 'index' },
  { symbol: '^GSPTSE', name: 'S&P/TSX (Canadá)',   datasource: 'yahoo', category: 'index' },
  { symbol: '^MXX',  name: 'S&P/BMV IPC (México)', datasource: 'yahoo', category: 'index' },
  { symbol: '^BVSP', name: 'Ibovespa (Brasil)',    datasource: 'yahoo', category: 'index' },

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
  ...USA_TOP_100,
  ...AI_STOCKS,
  ...QUANTUM_STOCKS,
  { symbol: 'COIN', name: 'Coinbase',       datasource: 'yahoo', category: 'stock' },
  { symbol: 'MSTR', name: 'MicroStrategy',  datasource: 'yahoo', category: 'stock' },
  { symbol: 'SPY',  name: 'SPDR S&P 500 ETF', datasource: 'yahoo', category: 'etf' },
  { symbol: 'QQQ',  name: 'Invesco Nasdaq 100 ETF', datasource: 'yahoo', category: 'etf' },
  { symbol: 'GLD',  name: 'SPDR Gold ETF',  datasource: 'yahoo', category: 'etf' },
  { symbol: 'BOTZ', name: 'Global X Robotics & AI ETF', datasource: 'yahoo', category: 'etf', extraCategories: ['stock_ai'] },
  { symbol: 'AIQ',  name: 'Global X AI & Technology ETF', datasource: 'yahoo', category: 'etf', extraCategories: ['stock_ai'] },
  { symbol: 'QTUM', name: 'Defiance Quantum ETF', datasource: 'yahoo', category: 'etf', extraCategories: ['stock_quantum'] },

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
