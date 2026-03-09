const { Router } = require('express');
const authRoutes     = require('./auth.routes');
const usersRoutes    = require('./users.routes');
const marketRoutes   = require('./market.routes');
const tradingRoutes  = require('./trading.routes');
const hedgeRoutes    = require('./hedge.routes');
const settingsRoutes = require('./settings.routes');

const router = Router();

router.use('/auth',     authRoutes);
router.use('/users',    usersRoutes);
router.use('/market',   marketRoutes);
router.use('/trading',  tradingRoutes);
router.use('/hedge',    hedgeRoutes);
router.use('/settings', settingsRoutes);

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
