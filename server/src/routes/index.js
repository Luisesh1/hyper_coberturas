const { Router } = require('express');
const config        = require('../config');
const authRoutes     = require('./auth.routes');
const usersRoutes    = require('./users.routes');
const marketRoutes   = require('./market.routes');
const tradingRoutes  = require('./trading.routes');
const hedgeRoutes    = require('./hedge.routes');
const settingsRoutes = require('./settings.routes');
const healthRoutes   = require('./health.routes');
const uniswapRoutes  = require('./uniswap.routes');
const lpOrchestratorRoutes = require('./lp-orchestrator.routes');
const orchestratorMetricsRoutes = require('./orchestrator-metrics.routes');
const strategiesRoutes = require('./strategies.routes');
const indicatorsRoutes = require('./indicators.routes');
const botsRoutes = require('./bots.routes');
const backtestingRoutes = require('./backtesting.routes');

const router = Router();

router.use('/auth',     authRoutes);
router.use('/users',    usersRoutes);
router.use('/market',   marketRoutes);
router.use('/trading',  tradingRoutes);
router.use('/hedge',    hedgeRoutes);
router.use('/settings', settingsRoutes);
router.use('/health',   healthRoutes);
router.use('/uniswap',  uniswapRoutes);
router.use('/lp-orchestrators', lpOrchestratorRoutes);
router.use('/orchestrator-metrics', orchestratorMetricsRoutes);
router.use('/strategies', strategiesRoutes);
router.use('/indicators', indicatorsRoutes);
router.use('/bots', botsRoutes);
router.use('/backtesting', backtestingRoutes);

// Endpoints solo dev: snapshot/stream de logs y batch upload de errores
// del cliente. En producción la ruta literalmente no se monta para que
// devuelva 404 sin posibilidad de filtrar por header.
if (config.server.nodeEnv === 'development') {
  // eslint-disable-next-line global-require
  const devRoutes = require('./dev.routes');
  router.use('/dev', devRoutes);
}

module.exports = router;
