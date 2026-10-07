/**
 * Ensambla el servicio de fondeo cross-chain con sus dependencias reales.
 * Las rutas llaman a `module.exports.service.<método>` para que los tests
 * puedan sustituir métodos sin tocar la red.
 */

const marketService = require('../market.service');
const onChainManager = require('../onchain-manager.service');
const smartPoolCreatorService = require('../smart-pool-creator.service');
const { getNetworkConfig } = require('../uniswap/networks');
const repo = require('../../repositories/cross-chain-plan.repository');
const balances = require('./multichain-balances');
const feeOracle = require('./fee-oracle');
const planner = require('./bridge-planner');
const lifi = require('./providers/lifi.provider');
const across = require('./providers/across.provider');
const { createCrossChainFundingService } = require('./cross-chain-funding.service');

const service = createCrossChainFundingService({
  balances,
  feeOracle,
  planner,
  repo,
  providers: { lifi, across },
  getPrices: () => marketService.getAllPrices(),
  getWrappedNativeToken: (network) => smartPoolCreatorService.getWrappedNativeToken(network),
  getProvider: (network) => onChainManager.getProvider(getNetworkConfig(network), { scope: 'cross-chain' }),
});

module.exports = { service };
