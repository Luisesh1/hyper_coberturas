import { request } from '../../../services/api';

/**
 * «Usada por N bots»: bots de Opciones › Trading automatizado que vinculan
 * cada alerta. Fuente: `GET /options/auto-bots` (contrato B del spec
 * 2026-10-15-alert-auto-trading-design.md).
 */

function botAlertIds(bot) {
  const ids = new Set();
  const fromParams = Array.isArray(bot?.params?.alertIds) ? bot.params.alertIds : [];
  for (const id of fromParams) ids.add(Number(id));
  const fromAlerts = Array.isArray(bot?.alerts) ? bot.alerts : [];
  for (const a of fromAlerts) if (a?.id != null) ids.add(Number(a.id));
  return Array.from(ids).filter(Number.isFinite);
}

// Map alertId → [{ id, name, mode, structure }]
export function buildAlertBotUsage(bots) {
  const usage = new Map();
  if (!Array.isArray(bots)) return usage;
  for (const bot of bots) {
    const entry = {
      id: bot.id,
      name: bot.name,
      mode: bot.mode,
      structure: bot?.params?.structure || 'buy_with',
    };
    for (const alertId of botAlertIds(bot)) {
      if (!usage.has(alertId)) usage.set(alertId, []);
      usage.get(alertId).push(entry);
    }
  }
  return usage;
}

export async function fetchAlertBotUsage() {
  const bots = await request('GET', '/options/auto-bots');
  return buildAlertBotUsage(bots);
}
