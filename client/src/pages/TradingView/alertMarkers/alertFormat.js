import { OVERLAY_TF_MS } from '../overlays/useChartOverlays.js';
import { clientBaseTfMs, ruleConditions } from './useAlertBacktest.js';

// '15m' para la temporalidad más baja de la alerta.
export function baseTfLabel(alert) {
  const ms = clientBaseTfMs(alert);
  return Object.keys(OVERLAY_TF_MS).find((k) => OVERLAY_TF_MS[k] === ms) || '';
}

export const ruleCountLabel = (alert) => {
  const n = (alert?.rules || []).length;
  return `${n} ${n === 1 ? 'regla' : 'reglas'}`;
};

// "RSI 15m · EMA 4h"
export const conditionsLabel = (rule) =>
  ruleConditions(rule).map((c) => `${c.indicatorType} ${c.timeframe}`).join(' · ');

export const formatDateTime = (ms) =>
  new Date(ms).toLocaleString('es', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

export const formatPct = (n) => `${Math.round(Number(n) || 0)}%`;
