/**
 * hyperliquid.registry.js
 *
 * Mantiene una instancia de HyperliquidService por usuario.
 * La wallet se carga desde la tabla settings (key='wallet').
 */

const HyperliquidService = require('./hyperliquid.service');
const settingsService = require('./settings.service');

const registry = new Map(); // userId -> HyperliquidService

async function getOrCreate(userId) {
  if (registry.has(userId)) return registry.get(userId);

  const wallet  = await settingsService.getWallet(userId);
  const service = new HyperliquidService(wallet);
  registry.set(userId, service);
  return service;
}

/** Recarga la instancia cuando el usuario actualiza su wallet */
async function reload(userId) {
  const wallet  = await settingsService.getWallet(userId);
  const service = new HyperliquidService(wallet);
  registry.set(userId, service);
  return service;
}

function get(userId) {
  return registry.get(userId) || null;
}

/** Devuelve todos los usuarios registrados con su wallet address */
function getAllAddresses() {
  const result = [];
  for (const [userId, svc] of registry.entries()) {
    if (svc.address) result.push({ userId, address: svc.address });
  }
  return result;
}

module.exports = { getOrCreate, reload, get, getAllAddresses };
