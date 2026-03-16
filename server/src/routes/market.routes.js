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

const router = Router();

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
