import { request } from '../../services/api';

// Llamadas de la pestaña «Trading automatizado» (bots que operan opciones
// cuando se disparan alertas alcistas o bajistas).
// Contrato: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md (B).
// Detalle, cambio de modo y borrado van por /options/strategies/:id
// (optionsAutomationApi.optionsStrategiesApi): un bot es una estrategia con
// template = 'alert_signal'.

const enc = (id) => encodeURIComponent(id);

export const SIGNAL_FILTERS = ['all', 'traded', 'ignored'];

export const autoBotsApi = {
  // [{ ...estrategia, alerts: [{ id, name, direction, assetList }], pnl30d: { shadow, live }, status, lastSignal }]
  list: () => request('GET', '/options/auto-bots'),
  // [{ id, name, direction, assetList, thresholdPercent }] (sólo no neutrales del subyacente)
  eligibleAlerts: (underlying) => request('GET', `/options/auto-bots/eligible-alerts?underlying=${enc(underlying)}`),
  // { name, underlying, alertIds, params, limits? } → se crea en modo sombra
  create: (data) => request('POST', '/options/auto-bots', data),
  // { name?, alertIds?, params?, limits? }
  update: (id, data) => request('PUT', `/options/auto-bots/${enc(id)}`, data),
  // [{ id, alertId, alertName, direction, asset, score, decision, detail, createdAt }]
  signals: (id, { limit = 100, filter = 'all' } = {}) => {
    const f = SIGNAL_FILTERS.includes(filter) ? filter : 'all';
    return request('GET', `/options/auto-bots/${enc(id)}/signals?limit=${enc(limit)}&filter=${f}`);
  },
  // Cierre manual en el libro del modo actual (Real → órdenes LIMIT reales).
  // Sin positionIds cierra todas. → { status: 'closed' | 'pending' | 'nothing_to_close' | 'not_submitted', detail }
  close: (id, { positionIds } = {}) => request('POST', `/options/auto-bots/${enc(id)}/close`, { positionIds, confirm: true }),
  // Pide cancelar una entrada real pendiente (las salidas y el TP no se cancelan). → orden con cancelRequested
  cancelOrder: (id, orderId) => request('POST', `/options/auto-bots/${enc(id)}/orders/${enc(orderId)}/cancel`),
};
