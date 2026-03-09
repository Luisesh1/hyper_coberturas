const { Router } = require('express');
const marketRoutes   = require('./market.routes');
const tradingRoutes  = require('./trading.routes');
const hedgeRoutes    = require('./hedge.routes');
const settingsRoutes = require('./settings.routes');

const router = Router();

router.use('/market',   marketRoutes);
router.use('/trading',  tradingRoutes);
router.use('/hedge',    hedgeRoutes);
router.use('/settings', settingsRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Cargar configuración persistida al arrancar
settingsRoutes.loadSettings().catch(() => {});

module.exports = router;
