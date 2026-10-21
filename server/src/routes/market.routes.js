/**
 * market.routes.js
 *
 * Rutas REST para datos de mercado (solo lectura, no requieren wallet).
 *
 * GET /api/market/prices         -> Todos los precios mid
 * GET /api/market/prices/:asset  -> Precio de un activo especifico
 * GET /api/market/assets         -> Lista de activos disponibles
 * GET /api/market/contexts       -> Contexto rico: mark price, funding, OI, etc.
 */

const { Router } = require('express');
const asyncHandler  = require('../middleware/async-handler');
const marketService = require('../services/market.service');
const marketDataService = require('../services/market-data.service');
const { CATEGORIES, listCatalogAssets } = require('../services/marketdata-providers/asset-catalog');
const topVolumeService = require('../services/market-top-volume.service');
const { ValidationError } = require('../errors/app-error');
// Se importa el modulo (no la instancia) para poder sustituir el servicio en tests.
const deribitOptionsModule = require('../services/deribit/deribit-options.service');
const { UNDERLYINGS, parseInstrumentName } = require('../services/deribit/deribit-instruments');
const { resolutionFor } = require('../services/deribit/option-series');

const router = Router();

// GET /api/market/candles?asset=ETH&timeframe=15m&limit=300&datasource=hyperliquid
// Devuelve OHLCV normalizadas (ms epoch + open/high/low/close/volume).
// Delegamos el caching y validación en `marketDataService.getCandles`.
router.get('/candles', asyncHandler(async (req, res) => {
  const { asset, timeframe, limit, datasource, startTime, endTime } = req.query;
  const parseTs = (raw) => {
    if (raw == null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const candles = await marketDataService.getCandles(
    String(asset || 'BTC'),
    String(timeframe || '15m'),
    {
      limit: Number(limit) || 300,
      datasource,
      startTime: parseTs(startTime),
      endTime: parseTs(endTime),
    },
  );
  res.json({ success: true, data: candles });
}));

// --- Opciones Deribit (superposiciones del grafico) ---
const DAY_MS = 24 * 60 * 60 * 1000;

function parsePositiveTs(raw) {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function requireUnderlying(raw) {
  const underlying = String(raw || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(UNDERLYINGS, underlying)) {
    throw new ValidationError(`Subyacente no soportado en Deribit: ${raw}`);
  }
  return underlying;
}

// GET /api/market/options/expiries?underlying=ETH
router.get('/options/expiries', asyncHandler(async (req, res) => {
  const underlying = requireUnderlying(req.query.underlying);
  const data = await deribitOptionsModule.deribitOptionsService.listExpiries(underlying);
  res.json({ success: true, data });
}));

// GET /api/market/options/strikes?underlying=ETH&expiry=10OCT26[&retry=1]
router.get('/options/strikes', asyncHandler(async (req, res) => {
  const underlying = requireUnderlying(req.query.underlying);
  const expiry = String(req.query.expiry || '').toUpperCase();
  if (!expiry) throw new ValidationError('expiry es obligatorio');
  const retry = req.query.retry === '1';
  const data = await deribitOptionsModule.deribitOptionsService.getStrikesJob(underlying, expiry, { retry });
  res.json({ success: true, data });
}));

// GET /api/market/options/candles?instrument=...&timeframe=1h&startTime&endTime
router.get('/options/candles', asyncHandler(async (req, res) => {
  const instrument = String(req.query.instrument || '');
  if (!parseInstrumentName(instrument)) throw new ValidationError(`Instrumento invalido: ${instrument}`);
  const timeframe = String(req.query.timeframe || '15m');
  try { resolutionFor(timeframe); } catch { throw new ValidationError(`Temporalidad no soportada: ${timeframe}`); }
  const endMs = parsePositiveTs(req.query.endTime) ?? Date.now();
  const startMs = parsePositiveTs(req.query.startTime) ?? endMs - 30 * DAY_MS;
  const data = await deribitOptionsModule.deribitOptionsService.getCandles({ instrument, timeframe, startMs, endMs });
  res.json({ success: true, data });
}));

// GET /api/market/catalog
// Devuelve el catálogo de activos por datasource/categoría. Binance e
// Hyperliquid se consultan desde sus exchanges con fallback al catálogo curado.
router.get('/catalog', asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: {
      categories: CATEGORIES,
      assets: await listCatalogAssets(),
    },
  });
}));

// GET /api/market/top-volume?datasource=binance&window=1d&limit=20
// Activos ordenados por volumen 24h / 7d / 30d. Usado en el picker masivo.
router.get('/top-volume', asyncHandler(async (req, res) => {
  const { datasource, window, limit } = req.query;
  const data = await topVolumeService.getTopByVolume({
    datasource: String(datasource || 'binance'),
    window: String(window || '1d'),
    limit: Number(limit) || 20,
  });
  res.json({ success: true, data });
}));

router.get('/prices', asyncHandler(async (req, res) => {
  const prices = await marketService.getAllPrices();
  res.json({ success: true, data: prices });
}));

router.get('/prices/:asset', asyncHandler(async (req, res) => {
  const { asset } = req.params;
  const data = await marketService.getPrice(asset);
  res.json({ success: true, data });
}));

router.get('/assets', asyncHandler(async (req, res) => {
  const assets = await marketService.getAvailableAssets();
  res.json({ success: true, data: assets });
}));

router.get('/contexts', asyncHandler(async (req, res) => {
  const contexts = await marketService.getAssetContexts();
  res.json({ success: true, data: contexts });
}));

module.exports = router;
