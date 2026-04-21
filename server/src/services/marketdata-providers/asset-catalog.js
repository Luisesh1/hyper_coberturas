// Catalogo curado de activos populares por datasource/categoria.
// Cada entrada: { id, symbol, name, datasource, category }

const CATEGORIES = {
  crypto_perp: 'Cripto (perp)',
  crypto_spot: 'Cripto (spot)',
  index: 'Índices',
  commodity: 'Commodities',
  stock: 'Acciones',
  forex: 'Forex',
};

const ASSETS = [
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

function listAssets() {
  return ASSETS.map((a) => ({ ...a }));
}

function findAsset(datasource, symbol) {
  return ASSETS.find((a) => a.datasource === datasource && a.symbol === symbol) || null;
}

module.exports = {
  ASSETS,
  CATEGORIES,
  listAssets,
  findAsset,
};
