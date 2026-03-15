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
    const accountId = req.query.accountId ? Number(req.query.accountId) : null;
    const services = accountId != null
      ? [await hedgeRegistry.getOrCreate(req.user.userId, accountId)]
      : await hedgeRegistry.getOrCreateAllForUser(req.user.userId);
    const hedges = services
      .flatMap((svc) => svc.getAll())
      .sort((a, b) => b.id - a.id);
    res.json({ success: true, data: hedges });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const services = await hedgeRegistry.getOrCreateAllForUser(req.user.userId);
    const hedge = services
      .map((svc) => svc.hedges.get(parseInt(req.params.id, 10)))
      .find(Boolean);
    if (!hedge) throw new Error(`Cobertura #${req.params.id} no encontrada`);
    res.json({ success: true, data: hedge });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { asset, entryPrice, exitPrice, size, leverage, label, direction, accountId } = req.body;
    if (!asset || !entryPrice || !exitPrice || !size || !leverage) {
      return res.status(400).json({
        success: false,
        error: 'Parametros requeridos: asset, entryPrice, exitPrice, size, leverage',
      });
    }
    const svc   = await hedgeRegistry.getOrCreate(req.user.userId, accountId);
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
    const services = await hedgeRegistry.getOrCreateAllForUser(req.user.userId);
    const svc = services.find((item) => item.hedges.has(id));
    if (!svc) return res.status(404).json({ success: false, error: 'Cobertura no encontrada' });
    const hedge = await svc.cancelHedge(id);
    res.json({ success: true, data: hedge });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
