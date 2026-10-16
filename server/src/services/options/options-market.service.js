/**
 * options-market.service.js
 *
 * Datos de mercado de Binance Opciones construidos solo con endpoints
 * públicos (no necesita API key):
 *
 * - exchangeInfo → subyacentes, símbolos, strikes y vencimientos.
 * - mark         → precio mark, IV y griegas.
 * - ticker       → mejor bid/ask por snapshot; depth se usa en preflight de ejecución.
 * - index        → spot del subyacente.
 * - openInterest → interés abierto por vencimiento.
 *
 * Caché en memoria de 30 s para datos públicos y 10 min para metadatos, compartiendo promesas en
 * curso para no repetir llamadas concurrentes.
 *
 * Convenciones: `iv` es una fracción (0.52 = 52 %), como la publica Binance;
 * un bid/ask a cero se devuelve como null (sin liquidez en ese lado).
 */

const { createBinanceOptionsClient } = require('./binance-options.client');
const { NotFoundError, ValidationError } = require('../../errors/app-error');
const { hourlyAtr } = require('./options-take-profit');

const DEFAULT_TTL_MS = 30_000;
const METADATA_TTL_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNDERLYING_ORDER = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'];
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const SYMBOL_REGEX = /^([A-Z0-9]+)-(\d{6})-(\d+(?:\.\d+)?)-([CP])$/;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveOrNull(value) {
  const n = num(value);
  return n != null && n > 0 ? n : null;
}

function parseSymbol(symbol) {
  const match = SYMBOL_REGEX.exec(String(symbol || '').toUpperCase());
  if (!match) return null;
  return {
    symbol: match[0],
    underlying: match[1],
    expiry: match[2],
    strike: Number(match[3]),
    type: match[4],
  };
}

// YYMMDD → timestamp del vencimiento (Binance liquida a las 08:00 UTC).
function expiryCodeToMs(code) {
  const yy = Number(code.slice(0, 2));
  const mm = Number(code.slice(2, 4));
  const dd = Number(code.slice(4, 6));
  return Date.UTC(2000 + yy, mm - 1, dd, 8, 0, 0);
}

function expiryLabel(code) {
  const mm = Number(code.slice(2, 4));
  const dd = Number(code.slice(4, 6));
  return `${dd} ${MONTHS_ES[mm - 1] || '?'} ${code.slice(0, 2)}`;
}

function normalizeUnderlying(value) {
  const u = String(value || '').trim().toUpperCase().replace(/USDT$/, '');
  if (!/^[A-Z0-9]{2,10}$/.test(u)) {
    throw new ValidationError('underlying inválido');
  }
  return u;
}

function emptyLeg(symbol = null) {
  return {
    symbol,
    bid: null,
    ask: null,
    mark: null,
    iv: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    openInterest: null,
  };
}

function buildLeg(symbol, { mark, ticker, openInterest }) {
  return {
    symbol,
    bid: positiveOrNull(ticker?.bidPrice),
    ask: positiveOrNull(ticker?.askPrice),
    mark: num(mark?.markPrice),
    iv: num(mark?.markIV),
    delta: num(mark?.delta),
    gamma: num(mark?.gamma),
    theta: num(mark?.theta),
    vega: num(mark?.vega),
    openInterest: openInterest ?? null,
  };
}

function bySymbol(list) {
  const map = new Map();
  if (Array.isArray(list)) {
    for (const item of list) if (item?.symbol) map.set(item.symbol, item);
  }
  return map;
}

function createOptionsMarketService({
  client = null,
  clientFactory = () => createBinanceOptionsClient(),
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  let publicClient = client;
  const cache = new Map();

  function getClient() {
    if (!publicClient) publicClient = clientFactory();
    return publicClient;
  }

  function cached(key, loader, lifetimeMs = ttlMs) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < lifetimeMs) return hit.promise;
    const promise = Promise.resolve().then(loader);
    cache.set(key, { at: now(), promise });
    promise.catch(() => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    return promise;
  }

  const getExchangeInfo = () => cached('exchangeInfo', () => getClient().getExchangeInfo(), METADATA_TTL_MS);
  const getMarks = () => cached('mark', () => getClient().getMark());
  const getTickers = () => cached('ticker', () => getClient().getTicker());
  const getSpot = (underlying) => cached(`index:${underlying}`, async () => {
    const data = await getClient().getIndex(`${underlying}USDT`);
    return num(data?.indexPrice);
  });
  const getOpenInterestMap = (underlying, expiry) => cached(`oi:${underlying}:${expiry}`, async () => {
    try {
      const list = await getClient().getOpenInterest(underlying, expiry);
      const map = new Map();
      if (Array.isArray(list)) {
        for (const item of list) map.set(item.symbol, num(item.sumOpenInterest));
      }
      return map;
    } catch {
      // El interés abierto es informativo: si falla, la cadena sigue.
      return new Map();
    }
  });

  async function getSymbolsFor(underlying) {
    const info = await getExchangeInfo();
    const pair = `${underlying}USDT`;
    const out = [];
    for (const item of info?.optionSymbols || []) {
      const parsed = parseSymbol(item.symbol);
      if (!parsed) continue;
      if (item.underlying ? item.underlying !== pair : parsed.underlying !== underlying) continue;
      out.push({
        ...parsed,
        expiryMs: num(item.expiryDate) ?? expiryCodeToMs(parsed.expiry),
      });
    }
    return out;
  }

  async function listUnderlyings() {
    const info = await getExchangeInfo();
    const bases = new Set();
    for (const contract of info?.optionContracts || []) {
      if (contract?.baseAsset) bases.add(String(contract.baseAsset).toUpperCase());
    }
    if (bases.size === 0) {
      for (const item of info?.optionSymbols || []) {
        const parsed = parseSymbol(item.symbol);
        if (parsed) bases.add(parsed.underlying);
      }
    }
    const list = [...bases].sort((a, b) => {
      const ia = UNDERLYING_ORDER.indexOf(a);
      const ib = UNDERLYING_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });

    const changes = await cached('spot24h', async () => {
      try {
        const rows = await getClient().getSpotTicker24h(list.map((u) => `${u}USDT`));
        const map = new Map();
        for (const row of Array.isArray(rows) ? rows : []) {
          map.set(String(row.symbol).replace(/USDT$/, ''), num(row.priceChangePercent));
        }
        return map;
      } catch {
        return new Map();
      }
    });

    return Promise.all(list.map(async (underlying) => ({
      underlying,
      spot: await getSpot(underlying).catch(() => null),
      change24hPct: changes.get(underlying) ?? null,
    })));
  }

  async function getChain(rawUnderlying, rawExpiry) {
    const underlying = normalizeUnderlying(rawUnderlying);
    const symbols = await getSymbolsFor(underlying);
    if (symbols.length === 0) {
      throw new NotFoundError(`No hay opciones listadas para ${underlying}`);
    }

    const nowMs = now();
    const expiryMap = new Map();
    for (const s of symbols) {
      if (s.expiryMs <= nowMs) continue;
      if (!expiryMap.has(s.expiry)) expiryMap.set(s.expiry, s.expiryMs);
    }
    const expiries = [...expiryMap.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([code, ms]) => ({ code, label: expiryLabel(code), dte: Math.max(0, Math.ceil((ms - nowMs) / DAY_MS)) }));

    let expiry = rawExpiry ? String(rawExpiry).trim() : null;
    if (expiry && !/^\d{6}$/.test(expiry)) {
      throw new ValidationError('expiry debe tener el formato YYMMDD');
    }
    if (expiry && !expiryMap.has(expiry)) {
      throw new NotFoundError(`El vencimiento ${expiry} no está listado para ${underlying}`);
    }
    if (!expiry) expiry = expiries[0]?.code || null;

    const [spot, marks, tickers, oi] = await Promise.all([
      getSpot(underlying).catch(() => null),
      getMarks(),
      getTickers().catch(() => []),
      expiry ? getOpenInterestMap(underlying, expiry) : new Map(),
    ]);
    const markMap = bySymbol(marks);
    const tickerMap = bySymbol(tickers);

    const strikes = new Map();
    for (const s of symbols) {
      if (s.expiry !== expiry) continue;
      if (!strikes.has(s.strike)) strikes.set(s.strike, { strike: s.strike, call: emptyLeg(), put: emptyLeg() });
      const leg = buildLeg(s.symbol, {
        mark: markMap.get(s.symbol),
        ticker: tickerMap.get(s.symbol),
        openInterest: oi.get(s.symbol),
      });
      strikes.get(s.strike)[s.type === 'C' ? 'call' : 'put'] = leg;
    }
    const rows = [...strikes.values()].sort((a, b) => a.strike - b.strike);

    return { underlying, spot, expiries, expiry, rows };
  }

  async function getQuote(rawSymbol, { fresh = false } = {}) {
    const parsed = parseSymbol(rawSymbol);
    if (!parsed) throw new ValidationError('symbol inválido (formato BTC-261031-68000-C)');
    const { symbol, underlying, expiry, strike, type } = parsed;

    // Pantalla: snapshots compartidos para reducir consumo de IP.
    // Preflight real: libro, mark e índice consultados sin caché, antes del POST.
    // No degradar silenciosamente el libro al snapshot cuando fresh=true.
    const [markList, tickerList, spot, oi] = fresh
      ? await Promise.all([
        getClient().getMark(symbol),
        getClient().getDepth(symbol, 5),
        getClient().getIndex(`${underlying}USDT`).then((v) => num(v?.indexPrice)),
        getOpenInterestMap(underlying, expiry),
      ])
      : await Promise.all([
        getMarks(), getTickers(), getSpot(underlying).catch(() => null),
        getOpenInterestMap(underlying, expiry),
      ]);
    const mark = Array.isArray(markList) ? bySymbol(markList).get(symbol) : markList;
    if (!mark || (mark.symbol && mark.symbol !== symbol)) {
      throw new NotFoundError(`Sin datos de mercado para ${symbol}`);
    }
    const ticker = fresh ? {
      bidPrice: Array.isArray(tickerList?.bids?.[0]) ? tickerList.bids[0][0] : null,
      askPrice: Array.isArray(tickerList?.asks?.[0]) ? tickerList.asks[0][0] : null,
    } : (bySymbol(tickerList).get(symbol) || {});

    if (fresh && (!positiveOrNull(ticker.bidPrice) || !positiveOrNull(ticker.askPrice) || !positiveOrNull(spot))) {
      throw new ValidationError('Libro o índice incompleto para ejecución real');
    }
    return {
      ...buildLeg(symbol, { mark, ticker, openInterest: oi.get(symbol) }),
      underlying, strike, type, expiry, spot,
    };
  }

  // Requiere metadatos reales del tick y 14 velas cerradas (sin suponer
  // precisión de cotización ni ATR cuando Binance no los proporciona).
  async function getVolatilityInputs(rawSymbol) {
    const parsed = parseSymbol(rawSymbol);
    if (!parsed) throw new ValidationError('Símbolo de opción inválido para TP');
    const info = await getExchangeInfo();
    const item = (info?.optionSymbols || []).find((s) => s.symbol === parsed.symbol);
    const filter = (item?.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
    const tickSize = positiveOrNull(filter?.tickSize);
    const atrHourly = await cached(`atr1h:${parsed.underlying}`, async () => {
      const candles = await getClient().getSpotKlines(`${parsed.underlying}USDT`, '1h', 17);
      return hourlyAtr(candles, 14, now());
    }, 60_000);
    return { atrHourly, tickSize };
  }

  function clearCache() {
    cache.clear();
  }

  return { listUnderlyings, getChain, getQuote, getMarks, getVolatilityInputs, clearCache };
}

// Instancia por defecto (cliente público sin credenciales).
const defaultService = createOptionsMarketService();

module.exports = {
  createOptionsMarketService,
  parseSymbol,
  expiryCodeToMs,
  expiryLabel,
  listUnderlyings: (...args) => defaultService.listUnderlyings(...args),
  getChain: (...args) => defaultService.getChain(...args),
  getQuote: (...args) => defaultService.getQuote(...args),
  getMarks: (...args) => defaultService.getMarks(...args),
  getVolatilityInputs: (...args) => defaultService.getVolatilityInputs(...args),
  clearCache: () => defaultService.clearCache(),
};
