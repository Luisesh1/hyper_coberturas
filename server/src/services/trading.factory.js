const TradingService = require('./trading.service');
const hlRegistry = require('./hyperliquid.registry');
const tgRegistry = require('./telegram.registry');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');

async function getTradingService(userId, accountId) {
  const [account, hl, tg] = await Promise.all([
    hyperliquidAccountsService.resolveAccount(userId, accountId),
    hlRegistry.getOrCreate(userId, accountId),
    tgRegistry.getOrCreate(userId),
  ]);
  return new TradingService(userId, account, hl, tg);
}

module.exports = {
  getTradingService,
};
