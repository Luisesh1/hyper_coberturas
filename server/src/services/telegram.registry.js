/**
 * telegram.registry.js
 *
 * Mantiene una instancia de TelegramService por usuario.
 * La config se carga desde la tabla settings (key='telegram').
 */

const TelegramService = require('./telegram.service');
const settingsService = require('./settings.service');
const { createRegistry } = require('./registry.factory');

async function resolvePrefs(userId) {
  try {
    return await settingsService.getTelegramNotificationPrefs(userId);
  } catch {
    return settingsService.getDefaultNotificationPrefs();
  }
}

const registry = createRegistry({
  name: 'TelegramRegistry',
  keyFn: (userId) => String(userId),
  async buildFn(userId) {
    const cfg = await settingsService.getTelegram(userId);
    return new TelegramService(cfg.token || '', cfg.chatId || '', {
      userId,
      notificationPrefs: cfg.notificationPrefs,
      getPrefs: (id) => resolvePrefs(id),
    });
  },
});

async function refreshPrefs(userId) {
  const instance = registry.get(userId);
  if (!instance) return null;
  const prefs = await resolvePrefs(userId);
  instance.setNotificationPrefs(prefs);
  return prefs;
}

module.exports = {
  getOrCreate: registry.getOrCreate,
  reload: registry.reload,
  get: registry.get,
  refreshPrefs,
};
