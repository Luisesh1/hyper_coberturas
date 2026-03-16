/**
 * telegram.registry.js
 *
 * Mantiene una instancia de TelegramService por usuario.
 * La config se carga desde la tabla settings (key='telegram').
 */

const TelegramService = require('./telegram.service');
const settingsService = require('./settings.service');
const { createRegistry } = require('./registry.factory');

const registry = createRegistry({
  name: 'TelegramRegistry',
  keyFn: (userId) => String(userId),
  async buildFn(userId) {
    const cfg = await settingsService.getTelegram(userId);
    return new TelegramService(cfg.token || '', cfg.chatId || '');
  },
});

module.exports = {
  getOrCreate: registry.getOrCreate,
  reload: registry.reload,
  get: registry.get,
};
