const { Router } = require('express');
const authRoutes     = require('./auth.routes');
const usersRoutes    = require('./users.routes');
const marketRoutes   = require('./market.routes');
const tradingRoutes  = require('./trading.routes');
const hedgeRoutes    = require('./hedge.routes');
const settingsRoutes = require('./settings.routes');
const healthRoutes   = require('./health.routes');
const uniswapRoutes  = require('./uniswap.routes');

const router = Router();

router.use('/auth',     authRoutes);
router.use('/users',    usersRoutes);
router.use('/market',   marketRoutes);
router.use('/trading',  tradingRoutes);
router.use('/hedge',    hedgeRoutes);
router.use('/settings', settingsRoutes);
router.use('/health',   healthRoutes);
router.use('/uniswap',  uniswapRoutes);

module.exports = router;
