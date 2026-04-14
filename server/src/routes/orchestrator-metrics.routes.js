const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const lpOrchestratorRepository = require('../repositories/lp-orchestrator.repository');
const orchestratorMetricsRepo = require('../repositories/orchestrator-metrics.repository');
const orchestratorMetricsService = require('../services/orchestrator-metrics.service');

const router = Router();
router.use(authenticate);

async function loadOwnedOrchestrator(req, res) {
  const id = requireIntParam(req, 'id');
  const orch = await lpOrchestratorRepository.getById(req.user.userId, id);
  if (!orch) {
    res.status(404).json({ success: false, error: 'Orquestador no encontrado' });
    return null;
  }
  return orch;
}

/**
 * GET /:id/snapshots?startAt=&endAt=&limit=
 * Devuelve la serie temporal de snapshots horarios del orquestador.
 */
router.get('/:id/snapshots', asyncHandler(async (req, res) => {
  const orch = await loadOwnedOrchestrator(req, res);
  if (!orch) return;

  const startAt = req.query.startAt != null ? Number(req.query.startAt) : null;
  const endAt = req.query.endAt != null ? Number(req.query.endAt) : null;
  const limit = req.query.limit != null ? Number(req.query.limit) : 5000;

  const data = await orchestratorMetricsRepo.listSnapshots(orch.id, {
    startAt: Number.isFinite(startAt) ? startAt : null,
    endAt: Number.isFinite(endAt) ? endAt : null,
    limit: Number.isFinite(limit) ? limit : 5000,
  });
  res.json({ success: true, data });
}));

/**
 * GET /:id/current
 * Calcula el breakdown actual on-demand (sin persistir). Util para el
 * header de la pagina con los valores en tiempo cercano al real.
 */
router.get('/:id/current', asyncHandler(async (req, res) => {
  const orch = await loadOwnedOrchestrator(req, res);
  if (!orch) return;

  const breakdown = await orchestratorMetricsService.computeBreakdown(orch);
  const totalUsd = (breakdown.walletUsd || 0)
    + (breakdown.lpUsd || 0)
    + (breakdown.hlAccountUsd || 0);
  res.json({
    success: true,
    data: {
      capturedAt: Date.now(),
      totalUsd,
      walletUsd: breakdown.walletUsd,
      lpUsd: breakdown.lpUsd,
      hlAccountUsd: breakdown.hlAccountUsd,
      breakdown,
    },
  });
}));

module.exports = router;
