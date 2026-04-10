const onChainManager = require('./onchain-manager.service');

function getRpcProvider(networkConfig, scope = 'default') {
  return onChainManager.getProvider(networkConfig, { scope });
}

module.exports = {
  getRpcProvider,
  onChainManager,
};
