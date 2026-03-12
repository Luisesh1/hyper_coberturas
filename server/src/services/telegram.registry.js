/**
 * telegram.registry.js
 *
 * Mantiene una instancia de TelegramService por usuario.
 * La config se carga desde la tabla settings (key='telegram').
 */

const TelegramService = require('./telegram.service');
const settingsService = require('./settings.service');

const registry = new Map(); // userId -> TelegramService

async function getOrCreate(userId) {
  if (registry.has(userId)) return registry.get(userId);

  const cfg     = await settingsService.getTelegram(userId);
  const service = new TelegramService(cfg.token || '', cfg.chatId || '');
  registry.set(userId, service);
  return service;
}

/** Recarga la instancia cuando el usuario actualiza su config */
async function reload(userId) {
  const cfg     = await settingsService.getTelegram(userId);
  const service = new TelegramService(cfg.token || '', cfg.chatId || '');
  registry.set(userId, service);
  return service;
}

function get(userId) {
  return registry.get(userId) || null;
}

module.exports = { getOrCreate, reload, get };
