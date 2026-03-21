/**
 * bot.registry.js
 *
 * Mantiene una instancia de BotRuntime por usuario y bot.
 * Gestiona el ciclo de vida (activate, pause, stop) de cada bot.
 */

const botsRepository = require('../repositories/bots.repository');
const { BotRuntime } = require('./bot.service');
const tgRegistry = require('./telegram.registry');
const { ValidationError } = require('../errors/app-error');
const { createRegistry } = require('./registry.factory');

const registry = createRegistry({
  name: 'BotRegistry',
  keyFn: (userId, botId) => `${userId}:${botId}`,
  async buildFn(userId, botId) {
    const [row, tg] = await Promise.all([
      botsRepository.getById(userId, botId),
      tgRegistry.getOrCreate(userId),
    ]);
    if (!row) throw new Error(`Bot ${botId} no encontrado`);
    const runtime = new BotRuntime(userId, row, { tg });
    if (runtime.bot.status === 'active') runtime.startLoop();
    return runtime;
  },
  destroyFn(runtime) {
    runtime.stopLoop();
  },
});

async function getOrCreateActiveForUser(userId) {
  const rows = await botsRepository.listActiveByUser(userId);
  return Promise.all(rows.map((row) => registry.getOrCreate(userId, row.id)));
}

async function activate(userId, botId) {
  const row = await botsRepository.getById(userId, botId);
  if (!row) throw new Error('Bot no encontrado');
  const collisionCount = await botsRepository.countOtherActiveByAsset(
    userId, row.hyperliquid_account_id, row.asset, botId,
  );
  if (collisionCount > 0) {
    throw new ValidationError('Ya existe otro bot activo para esa cuenta y asset');
  }
  const runtime = await registry.getOrCreate(userId, botId);
  return runtime.activate();
}

async function pause(userId, botId) {
  const runtime = await registry.getOrCreate(userId, botId);
  return runtime.pause();
}

async function stop(userId, botId) {
  const runtime = await registry.getOrCreate(userId, botId);
  return runtime.stop();
}

module.exports = {
  activate,
  destroy: registry.destroy,
  destroyAll: registry.destroyAll,
  get: registry.get,
  getOrCreate: registry.getOrCreate,
  getOrCreateActiveForUser,
  onCreate: registry.onCreate,
  pause,
  stop,
};
