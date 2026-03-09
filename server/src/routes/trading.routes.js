/**
 * trading.routes.js
 *
 * Rutas REST para operaciones de trading (requieren wallet configurada).
 *
 * GET  /api/trading/account          -> Estado de la cuenta y posiciones abiertas
 * GET  /api/trading/orders           -> Ordenes abiertas
 * POST /api/trading/open             -> Abrir posicion apalancada
 * POST /api/trading/close            -> Cerrar posicion
 * DELETE /api/trading/orders/:asset/:oid -> Cancelar orden
 */

const { Router } = require('express');
const tradingService = require('../services/trading.service');

const router = Router();

router.get('/account', async (req, res, next) => {
  try {
    const data = await tradingService.getAccountState();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.get('/orders', async (req, res, next) => {
  try {
    const data = await tradingService.getOpenOrders();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post('/open', async (req, res, next) => {
  try {
    const { asset, side, size, leverage, marginMode, limitPrice } = req.body;

    if (!asset || !side || !size) {
      const err = new Error('Parametros requeridos: asset, side, size');
      err.status = 400;
      throw err;
    }

    if (!['long', 'short'].includes(side)) {
      const err = new Error("El parametro 'side' debe ser 'long' o 'short'");
      err.status = 400;
      throw err;
    }

    if (typeof size !== 'number' || size <= 0) {
      const err = new Error("El parametro 'size' debe ser un numero positivo");
      err.status = 400;
      throw err;
    }

    const data = await tradingService.openPosition({
      asset,
      side,
      size,
      leverage,
      marginMode,
      limitPrice,
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post('/close', async (req, res, next) => {
  try {
    const { asset, size } = req.body;

    if (!asset) {
      const err = new Error("Parametro requerido: 'asset'");
      err.status = 400;
      throw err;
    }

    const data = await tradingService.closePosition({ asset, size });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.delete('/orders/:asset/:oid', async (req, res, next) => {
  try {
    const { asset } = req.params;
    const oid = parseInt(req.params.oid, 10);

    if (isNaN(oid)) {
      const err = new Error('El ID de orden debe ser un numero');
      err.status = 400;
      throw err;
    }

    const data = await tradingService.cancelOrder(asset, oid);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
