import { request } from '../../services/api';

// Llamadas de las pestañas Estrategias y Backtesting del módulo de Opciones.
// Contratos: docs/superpowers/specs/2026-10-14-options-module-design.md
// (Backend B). El resto de /options/* vive en services/api.js.

const enc = (id) => encodeURIComponent(id);

export const optionsStrategiesApi = {
  // [{ id, label, defaultParams, paramSchema }]
  listTemplates: () => request('GET', '/options/strategies/templates'),
  // [{ id, name, template, underlying, mode, status, pnl30d: { shadow, live } }]
  list: () => request('GET', '/options/strategies'),
  // { name, template, underlying, params, limits }
  create: (data) => request('POST', '/options/strategies', data),
  // Estrategia + { kpis, equity: [{ t, shadow, live }], events }
  // `since` (ms) filtra kpis, curva y cerradas por apertura.
  get: (id, { since } = {}) => request('GET', `/options/strategies/${enc(id)}${since != null ? `?since=${enc(since)}` : ''}`),
  update: (id, data) => request('PUT', `/options/strategies/${enc(id)}`, data),
  // `live` exige confirm: true; sin él el servidor responde 400.
  setMode: (id, mode, { confirm = false } = {}) => request(
    'PUT',
    `/options/strategies/${enc(id)}/mode`,
    mode === 'live' ? { mode, confirm: confirm === true } : { mode },
  ),
  remove: (id) => request('DELETE', `/options/strategies/${enc(id)}`),
};

export const optionsBacktestsApi = {
  // { strategyId | template+params, underlying, from, to, capitalUsdt,
  //   source, spreadPct, feePct, volPremiumPct } → tarea en cola
  create: (config) => request('POST', '/options/backtests', config),
  list: () => request('GET', '/options/backtests'),
  get: (id) => request('GET', `/options/backtests/${enc(id)}`),
};
