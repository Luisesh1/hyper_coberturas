const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const walletMetricsRepo = require('../repositories/wallet-metrics.repository');
const walletMetricsService = require('../services/wallet-metrics.service');

const router = Router();
router.use(authenticate);

/** Resumen de la ultima captura sin el desglose por item (lista ligera). */
function summarize(wallet, lastDetail) {
  return {
    ...wallet,
    latest: lastDetail
      ? {
        capturedAt: lastDetail.capturedAt,
        totals: lastDetail.totals,
        isPartial: lastDetail.isPartial,
        staleSources: lastDetail.staleSources || [],
      }
      : null,
  };
}

async function loadOwnedWallet(req, res) {
  const id = requireIntParam(req, 'id');
  const wallet = await walletMetricsRepo.getForUser(req.user.userId, id);
  if (!wallet) {
    res.status(404).json({ success: false, error: 'Wallet no encontrada' });
    return null;
  }
  return wallet;
}

/**
 * GET /?includeArchived=1
 * Wallets seguidas del usuario con el resumen de su ultima captura. Da de
 * alta antes las wallets de orquestadores nuevos y, si alguna aun no tiene un
 * punto reciente, dispara su captura en segundo plano.
 */
router.get('/', asyncHandler(async (req, res) => {
  await walletMetricsRepo.syncFromOrchestrators();
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  const wallets = await walletMetricsRepo.listForUser(req.user.userId, { includeArchived });
  const details = await Promise.all(
    wallets.map((w) => walletMetricsRepo.getForUser(req.user.userId, w.id))
  );
  walletMetricsService.triggerDueCapture();
  res.json({
    success: true,
    data: wallets.map((w, i) => summarize(w, details[i]?.lastDetail || null)),
  });
}));

/**
 * GET /snapshots?ids=1,2&startAt=
 * Series de varias wallets del usuario en una sola llamada:
 * `{ [walletId]: [{ t, total, tokens, lp, hl, partial }] }`.
 */
router.get('/snapshots', asyncHandler(async (req, res) => {
  const owned = await walletMetricsRepo.listForUser(req.user.userId, { includeArchived: true });
  const ownedIds = new Set(owned.map((w) => w.id));
  const requested = String(req.query.ids || '')
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && ownedIds.has(n));
  const ids = requested.length ? requested : [...ownedIds];
  const startAt = req.query.startAt != null ? Number(req.query.startAt) : null;

  const rows = await walletMetricsRepo.listSnapshots(ids, {
    startAt: Number.isFinite(startAt) ? startAt : null,
  });
  const data = Object.fromEntries(ids.map((id) => [id, []]));
  for (const s of rows) {
    data[s.walletId].push({
      t: s.capturedAt,
      total: s.totalUsd,
      tokens: s.tokensUsd,
      lp: s.lpUsd,
      hl: s.hlUsd,
      partial: s.isPartial,
      stale: s.isPartial ? s.staleSources : undefined,
    });
  }
  res.json({ success: true, data });
}));

/** GET /:id — wallet con el desglose completo de su ultima captura. */
router.get('/:id', asyncHandler(async (req, res) => {
  const wallet = await loadOwnedWallet(req, res);
  if (!wallet) return;
  res.json({ success: true, data: wallet });
}));

/** POST /:id/refresh — recalcula al momento sin guardar un punto. */
router.post('/:id/refresh', asyncHandler(async (req, res) => {
  const wallet = await loadOwnedWallet(req, res);
  if (!wallet) return;
  const lastDetail = await walletMetricsService.computeLive(wallet);
  res.json({ success: true, data: { ...wallet, lastDetail, live: true } });
}));

router.post('/:id/archive', asyncHandler(async (req, res) => {
  const wallet = await loadOwnedWallet(req, res);
  if (!wallet) return;
  const updated = await walletMetricsRepo.setStatus(req.user.userId, wallet.id, 'archived');
  res.json({ success: true, data: updated });
}));

router.post('/:id/unarchive', asyncHandler(async (req, res) => {
  const wallet = await loadOwnedWallet(req, res);
  if (!wallet) return;
  const updated = await walletMetricsRepo.setStatus(req.user.userId, wallet.id, 'active');
  walletMetricsService.triggerDueCapture();
  res.json({ success: true, data: updated });
}));

module.exports = router;
