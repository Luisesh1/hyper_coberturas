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
const marketService = require('../services/market.service');

const router = Router();

router.get('/prices', async (req, res, next) => {
  try {
    const prices = await marketService.getAllPrices();
    res.json({ success: true, data: prices });
  } catch (err) {
    next(err);
  }
});

router.get('/prices/:asset', async (req, res, next) => {
  try {
    const { asset } = req.params;
    const data = await marketService.getPrice(asset);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.get('/assets', async (req, res, next) => {
  try {
    const assets = await marketService.getAvailableAssets();
    res.json({ success: true, data: assets });
  } catch (err) {
    next(err);
  }
});

router.get('/contexts', async (req, res, next) => {
  try {
    const contexts = await marketService.getAssetContexts();
    res.json({ success: true, data: contexts });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
