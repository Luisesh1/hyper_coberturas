/**
 * hl-weight-budget.service.js
 *
 * Medidor global de peso (weight) contra la API REST de Hyperliquid.
 *
 * T&C Hyperliquid (2026): 1,200 weight/min agregado por IP. Los endpoints
 * tienen pesos distintos:
 *   - clearinghouseState / allMids / l2Book / orderStatus: 2
 *   - openOrders / userFills / meta: 20
 *   - candleSnapshot: 20+ (mas peso por cada 60 items)
 *   - userRole: 60
 *
 * Este servicio NO limita activamente las requests (el flujo de trading no
 * debe bloquearse), solo observa y alerta cuando acercamos el techo.
 * El handling de 429/Retry-After en hyperliquid.service.js se encarga del
 * enforcement del lado del servidor.
 */

const logger = require('./logger.service');

const WINDOW_MS = 60_000;
const HARD_LIMIT = 1200;
const WARN_THRESHOLD = 0.80; // 80% -> warn
const CRIT_THRESHOLD = 0.95; // 95% -> critical warn

const WEIGHTS = Object.freeze({
  // weight 2
  clearinghouseState: 2,
  allMids: 2,
  l2Book: 2,
  orderStatus: 2,
  exchangeStatus: 2,
  spotClearinghouseState: 2,
  // weight 20 (mas extras)
  openOrders: 20,
  userFills: 20,
  meta: 20,
  metaAndAssetCtxs: 20,
  candleSnapshot: 20,
  // weight 60
  userRole: 60,
  // default
  _default: 2,
});

class HlWeightBudgetService {
  constructor() {
    this.events = [];
    this._lastWarnLevel = 0; // 0 ok, 1 warn, 2 crit
  }

  _prune(now = Date.now()) {
    const cutoff = now - WINDOW_MS;
    while (this.events.length && this.events[0].t < cutoff) {
      this.events.shift();
    }
  }

  getWeight(endpoint) {
    if (!endpoint) return WEIGHTS._default;
    return WEIGHTS[endpoint] ?? WEIGHTS._default;
  }

  record(endpoint, { weightOverride, extraWeight = 0, timestamp = Date.now() } = {}) {
    const weight = (weightOverride != null ? Number(weightOverride) : this.getWeight(endpoint))
      + Number(extraWeight || 0);
    this.events.push({ t: timestamp, w: weight, endpoint });
    this._prune(timestamp);
    this._maybeWarn();
    return weight;
  }

  getSnapshot(now = Date.now()) {
    this._prune(now);
    let used = 0;
    const byEndpoint = {};
    for (const ev of this.events) {
      used += ev.w;
      byEndpoint[ev.endpoint] = (byEndpoint[ev.endpoint] || 0) + ev.w;
    }
    return {
      windowMs: WINDOW_MS,
      hardLimit: HARD_LIMIT,
      used,
      remaining: Math.max(HARD_LIMIT - used, 0),
      utilizationPct: Math.round((used / HARD_LIMIT) * 1000) / 10,
      byEndpoint,
    };
  }

  _maybeWarn() {
    const snap = this.getSnapshot();
    const ratio = snap.used / HARD_LIMIT;
    let level = 0;
    if (ratio >= CRIT_THRESHOLD) level = 2;
    else if (ratio >= WARN_THRESHOLD) level = 1;

    if (level > this._lastWarnLevel) {
      const event = level === 2 ? 'hl_rest_weight_critical' : 'hl_rest_weight_warning';
      logger.warn(event, {
        used: snap.used,
        limit: HARD_LIMIT,
        utilizationPct: snap.utilizationPct,
        byEndpoint: snap.byEndpoint,
      });
      this._lastWarnLevel = level;
    } else if (level < this._lastWarnLevel) {
      // Recovery: bajamos de nivel
      logger.info('hl_rest_weight_recovered', {
        used: snap.used,
        utilizationPct: snap.utilizationPct,
      });
      this._lastWarnLevel = level;
    }
  }
}

module.exports = new HlWeightBudgetService();
module.exports.WEIGHTS = WEIGHTS;
