const { Router } = require('express');
const asyncHandler   = require('../middleware/async-handler');
const db = require('../db');
const hlWsClient = require('../websocket/hyperliquidWs');
const runtimeStatus = require('../runtime/status');

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

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    requestId: req.requestId,
    checks: {
      db: dbReady,
      hyperliquidWs: !!hlWsClient.isConnected,
      bootstrapped: runtime.bootstrapped,
    },
    runtime,
    timestamp: new Date().toISOString(),
  });
}));

module.exports = router;
