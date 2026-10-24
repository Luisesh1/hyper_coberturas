/**
 * Repositorio de tramos en memoria para los tests del orquestador. Misma
 * interfaz que `lp-orchestrator-segment.repository.js` (executor al final,
 * ignorado aquí).
 */

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeSegmentFakeRepo() {
  const segments = [];
  let nextId = 1;
  const repo = {
    segments,
    async create(input) {
      const seq = segments
        .filter((s) => s.orchestratorId === input.orchestratorId)
        .reduce((max, s) => Math.max(max, s.seq), 0) + 1;
      const row = {
        accuracy: 'exact',
        closedAt: null,
        closePrice: null,
        closeValueUsd: null,
        closeReason: null,
        closeTxHashes: null,
        accounting: {},
        hedgeCloseQty: null,
        coverage: null,
        closingStartedAt: null,
        ...clone(input),
        id: nextId++,
        seq,
        status: 'open',
      };
      segments.push(row);
      return clone(row);
    },
    async getActive(orchestratorId) {
      const row = segments.find((s) => s.orchestratorId === orchestratorId
        && (s.status === 'open' || s.status === 'closing'));
      return clone(row) || null;
    },
    async getById(orchestratorId, id) {
      return clone(segments.find((s) => s.orchestratorId === orchestratorId && s.id === id)) || null;
    },
    async listByOrchestrator(orchestratorId) {
      return clone(segments.filter((s) => s.orchestratorId === orchestratorId).sort((a, b) => b.seq - a.seq));
    },
    async markClosing(id, { at = Date.now() } = {}) {
      const row = segments.find((s) => s.id === id && s.status === 'open');
      if (!row) return null;
      row.status = 'closing';
      row.closingStartedAt = at;
      return id;
    },
    async reopen(id) {
      const row = segments.find((s) => s.id === id && s.status === 'closing');
      if (!row) return null;
      row.status = 'open';
      row.closingStartedAt = null;
      return id;
    },
    async close(id, patch = {}) {
      const row = segments.find((s) => s.id === id && (s.status === 'open' || s.status === 'closing'));
      if (!row) return null;
      Object.assign(row, clone({
        ...patch,
        accounting: patch.accounting ?? row.accounting,
        coverage: patch.coverage ?? row.coverage,
      }), { status: 'closed' });
      return id;
    },
  };
  return repo;
}

module.exports = { makeSegmentFakeRepo };
