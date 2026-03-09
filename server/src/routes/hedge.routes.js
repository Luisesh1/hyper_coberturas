/**
 * hedge.routes.js
 *
 * Rutas REST para gestionar coberturas automaticas.
 *
 * GET    /api/hedge          -> Lista todas las coberturas
 * GET    /api/hedge/:id      -> Detalle de una cobertura
 * POST   /api/hedge          -> Crear nueva cobertura
 * DELETE /api/hedge/:id      -> Cancelar cobertura (solo si esta en 'waiting')
 */

const { Router } = require('express');
const hedgeService = require('../services/hedge.service');

const router = Router();

router.get('/', (req, res) => {
  const hedges = hedgeService.getAll();
  res.json({ success: true, data: hedges });
});

router.get('/:id', (req, res, next) => {
  try {
    const hedge = hedgeService.getById(parseInt(req.params.id, 10));
    res.json({ success: true, data: hedge });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { asset, entryPrice, exitPrice, size, leverage, label } = req.body;

    if (!asset || !entryPrice || !exitPrice || !size || !leverage) {
      const err = new Error(
        'Parametros requeridos: asset, entryPrice, exitPrice, size, leverage'
      );
      err.status = 400;
      throw err;
    }

    const hedge = await hedgeService.createHedge({
      asset,
      entryPrice,
      exitPrice,
      size,
      leverage,
      label,
    });

    res.status(201).json({ success: true, data: hedge });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      const err = new Error('ID invalido');
      err.status = 400;
      throw err;
    }
    const hedge = await hedgeService.cancelHedge(id);
    res.json({ success: true, data: hedge });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
