/**
 * Entradas simuladas en memoria, con la misma semántica que
 * options-shadow-entries.repository: solo se resuelve desde 'pending'.
 */
function createFakeShadowEntries({ now = Date.now } = {}) {
  const entries = [];
  let seq = 1;
  const clone = (e) => ({ ...e });
  return {
    entries,
    async insertEntry(row) {
      const entry = { id: seq++, autoSignalId: null, alertEventId: null, spot: null, status: 'pending',
        createdAt: now(), resolvedAt: null, ...row };
      entries.push(entry);
      return clone(entry);
    },
    async listPending({ strategyId = null } = {}) {
      return entries.filter((e) => e.status === 'pending' && (strategyId == null || e.strategyId === strategyId))
        .map(clone);
    },
    async resolveEntry(id, status, at) {
      const entry = entries.find((e) => e.id === id && e.status === 'pending');
      if (!entry) return null;
      Object.assign(entry, { status, resolvedAt: at ?? now() });
      return clone(entry);
    },
    async cancelEntries(ids, at) {
      const out = [];
      for (const entry of entries) {
        if (ids.map(Number).includes(entry.id) && entry.status === 'pending') {
          Object.assign(entry, { status: 'canceled', resolvedAt: at ?? now() });
          out.push(clone(entry));
        }
      }
      return out;
    },
  };
}

/**
 * Llena las entradas simuladas pendientes de `runner`: un libro cruzado un
 * instante (ask ≤ límite al comprar, bid ≥ límite al vender) y una pasada.
 */
async function fillShadowEntries({ runner, market }) {
  const original = market.getQuote;
  market.getQuote = async (symbol, opts) => {
    const q = await original(symbol, opts);
    return { ...q, bid: q.ask, ask: q.bid };
  };
  try {
    return await runner.processShadowEntries();
  } finally {
    market.getQuote = original;
  }
}

module.exports = { createFakeShadowEntries, fillShadowEntries };
