/**
 * alerts-scheduler.service.js
 *
 * Scheduler global que evalúa todas las alertas activas al cierre de cada
 * vela del timeframe MÁS BAJO entre sus reglas (por alerta).
 *
 * - tick cada 1s
 * - cache de alertas activas en memoria, refresh cada 30s o por invalidación
 * - buffer post-cierre para que el provider publique la última vela cerrada
 * - una evaluación por (alertId, asset, boundary)
 */

const logger = require('../logger.service');
const marketData = require('../market-data.service');
const alertsRepo = require('../../repositories/alerts.repository');
const alertsService = require('./alerts.service');

const TICK_MS = 1_000;
const CACHE_REFRESH_MS = 30_000;
const POST_CLOSE_BUFFER_MS = 3_000;

const TF_MS = marketData.TIMEFRAME_TO_MS;

let tickTimer = null;
let refreshTimer = null;
let activeAlerts = [];   // dtos
const lastBoundary = new Map(); // alertId -> ts

async function reloadCache() {
  try {
    const rows = await alertsRepo.listAllActive();
    activeAlerts = rows.map(alertsService.rowToDto);
  } catch (err) {
    logger.warn('alerts_scheduler_reload_failed', { error: err.message });
  }
}

function invalidateCache() {
  // Llamar tras cualquier CRUD para que el próximo tick recoja el cambio.
  reloadCache().catch(() => null);
}

function tick() {
  const now = Date.now();
  for (const alert of activeAlerts) {
    if (!Array.isArray(alert.rules) || alert.rules.length === 0) continue;
    const lowestTf = alertsService.lowestTimeframe(alert.rules);
    const tfMs = TF_MS[lowestTf];
    if (!tfMs) continue;
    // boundary = el último cierre de vela del lowest TF que ya quedó atrás
    // por al menos POST_CLOSE_BUFFER_MS (para dar tiempo al provider).
    const adjusted = now - POST_CLOSE_BUFFER_MS;
    const boundary = Math.floor(adjusted / tfMs) * tfMs;
    const prev = lastBoundary.get(alert.id) || 0;
    if (boundary <= prev) continue;
    lastBoundary.set(alert.id, boundary);

    // Disparar evaluaciones por activo en paralelo (allSettled).
    const assets = Array.isArray(alert.assetList) && alert.assetList.length > 0
      ? alert.assetList
      : [];
    if (assets.length === 0) continue;

    Promise.allSettled(
      assets.map((asset) => alertsService.evaluateAlertOnAsset(alert, asset, {
        ignoreCooldown: false,
        sendTelegram: true,
      }))
    ).then((results) => {
      // Refrescar dto en cache si hubo trigger (para actualizar lastTriggeredAt).
      const anyTriggered = results.some((r) => r.status === 'fulfilled' && r.value?.triggered);
      if (anyTriggered) reloadCache().catch(() => null);
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          logger.warn('alerts_eval_rejected', {
            alertId: alert.id, asset: assets[i], error: r.reason?.message || String(r.reason),
          });
        }
      });
    });
  }
}

async function triggerNow(userId, alertId, opts) {
  return alertsService.testAlertNow(userId, alertId, opts);
}

async function start() {
  if (tickTimer) return;
  alertsService.setSchedulerCacheInvalidator(invalidateCache);
  await reloadCache();
  refreshTimer = setInterval(reloadCache, CACHE_REFRESH_MS);
  refreshTimer.unref?.();
  tickTimer = setInterval(tick, TICK_MS);
  tickTimer.unref?.();
  logger.info('alerts_scheduler_started', { activeAlerts: activeAlerts.length });
}

function stop() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  lastBoundary.clear();
  activeAlerts = [];
}

module.exports = {
  invalidateCache,
  start,
  stop,
  triggerNow,
};
