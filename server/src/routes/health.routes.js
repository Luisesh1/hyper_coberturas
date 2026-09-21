const { Router } = require('express');
const asyncHandler   = require('../middleware/async-handler');
const db = require('../db');
const hlWsClient = require('../websocket/hyperliquidWs');
const runtimeStatus = require('../runtime/status');
const metrics = require('../services/metrics.service');
const hedgeAlertsRepository = require('../repositories/hedge-alerts.repository');

const router = Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    requestId: req.requestId,
  });
});

router.get('/ready', asyncHandler(async (req, res) => {
  let dbReady = true;
  try {
    await db.ensureConnection();
  } catch {
    dbReady = false;
  }

  const runtime = runtimeStatus.snapshot();
  const ready = dbReady && runtime.bootstrapped;

  // Estado de las coberturas. Va como CAMPO, no como 503: un pool descubierto
  // es un problema de negocio, no una razon para que el contenedor se declare
  // no-listo. `docker-compose.prod.yml` usa `depends_on: service_healthy`, asi
  // que un 503 aqui podria frenar el arranque de nginx en el proximo deploy y
  // convertir una alerta en una caida.
  let hedge = null;
  if (dbReady) {
    hedge = await hedgeAlertsRepository.summarizeOpen().catch(() => null);
  }

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    requestId: req.requestId,
    checks: {
      db: dbReady,
      hyperliquidWs: !!hlWsClient.isConnected,
      bootstrapped: runtime.bootstrapped,
      // false cuando hay al menos un episodio de cobertura abierto.
      hedgeCoverage: hedge ? hedge.openEpisodes === 0 : null,
    },
    hedge,
    runtime,
    timestamp: new Date().toISOString(),
  });
}));

// ── Prometheus-compatible /metrics ──────────────────────────────────
// Expuesto bajo /api/health/metrics para reutilizar el mount actual.
// Sin autenticación aquí para que Prometheus pueda scrapear sin
// secretos; en prod se recomienda aislarlo por red o restringirlo vía
// nginx (`allow <prometheus-ip>; deny all;` en una location específica).
router.get('/metrics', asyncHandler(async (req, res) => {
  // Cobertura: el canal de alerta que NO depende de que Telegram entregue.
  // Un episodio abierto de exposición direccional queda visible acá aunque el
  // mensaje saliente se haya perdido, que es lo que pasó las 72 h de pp27.
  try {
    const hedge = await hedgeAlertsRepository.summarizeOpen();
    metrics.gauge('hedge_open_alert_episodes', null, 'Open hedge alert episodes').set(hedge.openEpisodes);
    for (const [severity, count] of Object.entries(hedge.bySeverity)) {
      metrics.gauge(`hedge_open_alert_episodes_${severity}`, null, `Open hedge alert episodes (${severity})`).set(count);
    }
  } catch { /* swallow: /metrics nunca debe tumbarse por la db */ }

  // Snapshot de gauges básicas
  try {
    const runtime = runtimeStatus.snapshot();
    metrics.gauge('app_bootstrapped', null, 'Bootstrap completed flag').set(runtime.bootstrapped ? 1 : 0);
    metrics.gauge('hl_ws_connected', null, 'Hyperliquid WS connection state').set(hlWsClient.isConnected ? 1 : 0);
    metrics.gauge('app_uptime_seconds', null, 'Process uptime').set(Math.floor(process.uptime()));
    const mem = process.memoryUsage();
    metrics.gauge('app_memory_rss_bytes', null, 'Resident set size').set(mem.rss);
    metrics.gauge('app_memory_heap_used_bytes', null, 'Heap used').set(mem.heapUsed);
    // Circuit breaker state del endpoint EXCHANGE de Hyperliquid.
    const hlService = require('../services/hyperliquid.service');
    if (typeof hlService.getExchangeBreakerState === 'function') {
      const s = hlService.getExchangeBreakerState();
      metrics.gauge('hl_exchange_breaker_open', null, 'HL exchange circuit breaker open flag').set(s.open ? 1 : 0);
      metrics.gauge('hl_exchange_breaker_consecutive_failures', null, 'HL exchange consecutive failures').set(s.consecutiveFailures);
    }
    // Circuit breaker state RPC provider (Alchemy + publicnodes).
    try {
      const onchain = require('../services/onchain-manager.service');
      if (typeof onchain.getRpcBreakerState === 'function') {
        const s = onchain.getRpcBreakerState();
        metrics.gauge('rpc_breaker_open', null, 'RPC circuit breaker open flag').set(s.state === 'open' ? 1 : 0);
        metrics.gauge('rpc_breaker_consecutive_failures', null, 'RPC consecutive failures').set(s.consecutiveFailures);
      }
    } catch { /* swallow */ }
  } catch { /* swallow */ }

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(metrics.render());
}));

module.exports = router;
