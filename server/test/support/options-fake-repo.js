/**
 * Repositorio en memoria con la misma API que options-strategies.repository,
 * para probar el runner y el servicio de estrategias sin Postgres.
 */

function createFakeOptionsRepo({ now = () => Date.now() } = {}) {
  const strategies = [];
  const positions = [];
  const events = [];
  const signals = [];
  let seq = 1;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  const repo = {
    strategies,
    positions,
    events,
    signals,

    async createStrategy({ userId, name, template, underlying, params, limits, mode = 'paused' }) {
      const s = { id: seq++, userId, name, template, underlying, params: params || {}, limits: limits || {}, mode, state: {}, createdAt: now(), updatedAt: now() };
      strategies.push(s);
      return clone(s);
    },
    async getStrategy(userId, id) {
      const s = strategies.find((x) => x.id === id && x.userId === userId);
      return s ? clone(s) : null;
    },
    async getStrategyById(id) {
      const s = strategies.find((x) => x.id === id);
      return s ? clone(s) : null;
    },
    async listStrategies(userId) {
      return strategies.filter((s) => s.userId === userId).map(clone);
    },
    async listActiveStrategies() {
      return strategies.filter((s) => s.mode === 'shadow' || s.mode === 'live').map(clone);
    },
    async listActiveAlertBots(userId) {
      return strategies
        .filter((s) => s.userId === userId && s.template === 'alert_signal' && (s.mode === 'shadow' || s.mode === 'live'))
        .map(clone);
    },
    async countLiveStrategies(userId, excludeId = null) {
      return strategies.filter((s) => s.userId === userId && s.mode === 'live' && s.id !== excludeId).length;
    },
    async updateStrategy(userId, id, patch) {
      const s = strategies.find((x) => x.id === id && x.userId === userId);
      if (!s) return null;
      for (const k of ['name', 'underlying', 'params', 'limits']) if (patch[k] != null) s[k] = patch[k];
      s.updatedAt = now();
      return clone(s);
    },
    async setMode(userId, id, mode) {
      const s = strategies.find((x) => x.id === id && x.userId === userId);
      if (!s) return null;
      s.mode = mode;
      return clone(s);
    },
    async setState(id, state) {
      const s = strategies.find((x) => x.id === id);
      // Igual que el repo real: los bloqueos guardados nunca se pisan.
      if (s) s.state = { ...clone(state || {}), blockedUnderlyings: clone(s.state?.blockedUnderlyings || {}) };
    },
    async deleteStrategy(userId, id) {
      const i = strategies.findIndex((x) => x.id === id && x.userId === userId);
      if (i < 0) return false;
      strategies.splice(i, 1);
      return true;
    },

    async insertPosition(p) {
      const row = { id: seq++, exitPrice: null, closedAt: null, pnlUsdt: null, feesUsdt: 0, ...p };
      positions.push(row);
      return clone(row);
    },
    async setTpTarget(id, price, meta) {
      const p = positions.find((x) => x.id === id);
      if (!p) return null;
      if (p.tpTargetPrice == null) Object.assign(p, { tpTargetPrice: price, tpTargetMeta: clone(meta) });
      return clone(p);
    },
    async closePosition(id, { exitPrice, closedAt, pnlUsdt, feesUsdt, closeReason = null }) {
      const p = positions.find((x) => x.id === id && x.closedAt == null);
      if (!p) return null;
      Object.assign(p, { exitPrice, closedAt, pnlUsdt, feesUsdt, closeReason });
      return clone(p);
    },
    async listOpenPositions(strategyId, mode) {
      return positions.filter((p) => p.strategyId === strategyId && p.mode === mode && p.closedAt == null).map(clone);
    },
    async listOpenPositionsByUser(userId, mode) {
      return positions.filter((p) => p.userId === userId && p.mode === mode && p.closedAt == null).map(clone);
    },
    async listAllOpenPositions() {
      return positions.filter((p) => p.closedAt == null).map(clone);
    },
    async listPositions(strategyId) {
      return positions.filter((p) => p.strategyId === strategyId).map(clone);
    },
    async lastOpenedAt(strategyId, mode) {
      const times = positions.filter((p) => p.strategyId === strategyId && p.mode === mode).map((p) => p.openedAt);
      return times.length ? Math.max(...times) : null;
    },
    async realizedPnlSince({ userId, strategyId = null, mode, since }) {
      return positions
        .filter((p) => p.userId === userId && p.mode === mode && p.closedAt != null && p.closedAt >= since && (strategyId == null || p.strategyId === strategyId))
        .reduce((a, p) => a + p.pnlUsdt, 0);
    },
    async pnlByStrategySince(userId, since) {
      const map = new Map();
      for (const p of positions) {
        if (p.userId !== userId || p.closedAt == null || p.closedAt < since) continue;
        const key = `${p.strategyId}:${p.mode}`;
        map.set(key, (map.get(key) || 0) + p.pnlUsdt);
      }
      return [...map.entries()].map(([k, pnlUsdt]) => {
        const [strategyId, mode] = k.split(':');
        return { strategyId: Number(strategyId), mode, pnlUsdt };
      });
    },
    async openCountsByStrategy(userId) {
      const map = new Map();
      for (const p of positions) {
        if (p.userId !== userId || p.closedAt != null) continue;
        const key = `${p.strategyId}:${p.mode}`;
        map.set(key, (map.get(key) || 0) + 1);
      }
      return [...map.entries()].map(([k, count]) => {
        const [strategyId, mode] = k.split(':');
        return { strategyId: Number(strategyId), mode, count };
      });
    },

    async insertEvent(e) {
      const row = { id: seq++, detail: null, legs: null, premiumUsdt: null, createdAt: now(), ...e };
      events.push(row);
      return clone(row);
    },
    async listEvents(strategyId, { limit = 100 } = {}) {
      return events.filter((e) => e.strategyId === strategyId).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id).slice(0, limit).map(clone);
    },
    async lastEventsByUser(userId) {
      const map = new Map();
      for (const e of events) if (e.userId === userId) map.set(e.strategyId, e);
      return [...map.values()].map(clone);
    },
    async countEventsSince(strategyId, mode, action, since) {
      return events.filter((e) => e.strategyId === strategyId && e.mode === mode && e.action === action && e.createdAt >= since).length;
    },

    async claimAutoSignal(row) {
      if (row.alertEventId != null && signals.some((x) => x.strategyId === row.strategyId && x.alertEventId === row.alertEventId)) return null;
      const s = { id: seq++, alertId: null, alertEventId: null, alertName: null, direction: null, asset: null, score: null, detail: null, simulated: false, createdAt: now(), ...row };
      signals.push(s);
      return clone(s);
    },
    async finishAutoSignal(id, { decision, detail }) {
      const s = signals.find((x) => x.id === id);
      if (!s) return null;
      Object.assign(s, { decision, detail: detail ?? null });
      return clone(s);
    },
    // Igual que el repo real: solo resuelve una señal 'pending' u 'opened'.
    async resolveAutoSignal(id, { decision, detail, feesUsdt, feesEstimated } = {}) {
      const s = signals.find((x) => x.id === id);
      if (!s || !['pending', 'opened'].includes(s.decision)) return null;
      Object.assign(s, { decision, detail: detail ?? null });
      if (feesUsdt != null) s.feesUsdt = feesUsdt;
      if (feesEstimated != null) s.feesEstimated = feesEstimated;
      return clone(s);
    },
    async listAutoSignals(strategyId, { limit = 100, filter = 'all' } = {}) {
      const ok = (d) => (filter === 'traded' ? ['opened', 'closed', 'reversed'].includes(d) : filter === 'ignored' ? d === 'ignored' : true);
      return signals
        .filter((x) => x.strategyId === strategyId && ok(x.decision) && !(filter === 'traded' && x.simulated))
        .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
        .slice(0, limit)
        .map(clone);
    },
    async lastAutoSignalsByUser(userId) {
      const map = new Map();
      for (const x of [...signals].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)) if (x.userId === userId && !x.simulated) map.set(x.strategyId, x);
      return [...map.values()].map(clone);
    },

    async countOrdersSince(strategyId, mode, since) {
      return events
        .filter((e) => e.strategyId === strategyId && e.mode === mode && ['open', 'close'].includes(e.action) && e.createdAt >= since && Array.isArray(e.legs))
        .reduce((a, e) => a + e.legs.filter((l) => 'orderId' in l).length, 0);
    },
  };
  return repo;
}

module.exports = { createFakeOptionsRepo };
