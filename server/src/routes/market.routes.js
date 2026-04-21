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
const { CATEGORIES, listAssets } = require('../services/marketdata-providers/asset-catalog');

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

// GET /api/market/catalog
// Devuelve el catálogo curado de activos por datasource/categoría. Usado
// por el selector de pares de la gráfica.
router.get('/catalog', asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: {
      categories: CATEGORIES,
      assets: listAssets(),
    },
  });
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
