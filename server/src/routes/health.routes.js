const { Router } = require('express');
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

router.get('/ready', async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

module.exports = router;
