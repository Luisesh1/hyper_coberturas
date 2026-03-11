/**
 * hedge.routes.js
 *
 * GET    /api/hedge       → Lista coberturas del usuario autenticado
 * GET    /api/hedge/:id   → Detalle de una cobertura
 * POST   /api/hedge       → Crear cobertura
 * DELETE /api/hedge/:id   → Cancelar cobertura
 */

const { Router } = require('express');
const hedgeRegistry    = require('../services/hedge.registry');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const svc    = await hedgeRegistry.getOrCreate(req.user.userId);
    const hedges = svc.getAll();
    res.json({ success: true, data: hedges });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const svc   = await hedgeRegistry.getOrCreate(req.user.userId);
    const hedge = svc.getById(parseInt(req.params.id, 10));
    res.json({ success: true, data: hedge });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { asset, entryPrice, exitPrice, size, leverage, label, direction } = req.body;
    if (!asset || !entryPrice || !exitPrice || !size || !leverage) {
      return res.status(400).json({
        success: false,
        error: 'Parametros requeridos: asset, entryPrice, exitPrice, size, leverage',
      });
    }
    const svc   = await hedgeRegistry.getOrCreate(req.user.userId);
    const hedge = await svc.createHedge({ asset, entryPrice, exitPrice, size, leverage, label, direction });
    res.status(201).json({ success: true, data: hedge });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'ID invalido' });
    const svc   = await hedgeRegistry.getOrCreate(req.user.userId);
    const hedge = await svc.cancelHedge(id);
    res.json({ success: true, data: hedge });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
