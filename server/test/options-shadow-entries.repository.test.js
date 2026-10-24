const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptionsShadowEntriesRepository } =
  require('../src/repositories/options-shadow-entries.repository');

const SYMBOL = 'BTC-261030-60000-C';

/**
 * BD falsa con estado: interpreta solo las sentencias del repositorio y
 * aplica la guarda `status='pending'` de los UPDATE si la SQL la incluye.
 */
function memoryDb() {
  const rows = [];
  const calls = [];
  let nextId = 1;
  return {
    rows,
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.includes('INSERT INTO options_shadow_entries')) {
        const [strategy_id, user_id, auto_signal_id, alert_event_id, symbol, side, option_type,
          quantity, limit_price, spot, deadline_at, created_at] = args;
        const row = { id: String(nextId++), strategy_id: String(strategy_id), user_id: String(user_id),
          auto_signal_id: auto_signal_id == null ? null : String(auto_signal_id),
          alert_event_id: alert_event_id == null ? null : String(alert_event_id),
          symbol, side, option_type, quantity: String(quantity), limit_price: String(limit_price),
          spot: spot == null ? null : String(spot), deadline_at: String(deadline_at),
          status: 'pending', created_at: String(created_at), resolved_at: null };
        rows.push(row);
        return { rows: [{ ...row }] };
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM options_shadow_entries')) {
        assert.match(sql, /status='pending'/);
        const strategyId = args[0];
        return { rows: rows.filter((r) => r.status === 'pending' &&
          (strategyId == null || Number(r.strategy_id) === Number(strategyId))).map((r) => ({ ...r })) };
      }
      if (sql.startsWith('UPDATE options_shadow_entries')) {
        const guarded = /status='pending'/.test(sql);
        const ids = Array.isArray(args[0]) ? args[0].map(Number) : [Number(args[0])];
        const status = sql.includes("status='canceled'") ? 'canceled' : args[1];
        const at = sql.includes("status='canceled'") ? args[1] : args[2];
        const changed = rows.filter((r) => ids.includes(Number(r.id)) && (!guarded || r.status === 'pending'));
        for (const r of changed) { r.status = status; r.resolved_at = String(at); }
        return { rows: changed.map((r) => ({ ...r })), rowCount: changed.length };
      }
      throw new Error('Unexpected SQL: ' + sql);
    },
  };
}

const entry = (over = {}) => ({
  strategyId: 4, userId: 7, autoSignalId: 31, alertEventId: 9001, symbol: SYMBOL, side: 'BUY',
  optionType: 'CALL', quantity: 0.1, limitPrice: 715, spot: 60250, deadlineAt: 601000, createdAt: 1000,
  ...over,
});

test('sombra: insertEntry → listPending la devuelve mapeada', async () => {
  const db = memoryDb();
  const repo = createOptionsShadowEntriesRepository({ db, now: () => 1000 });
  const saved = await repo.insertEntry(entry());
  assert.deepEqual(saved, {
    id: 1, strategyId: 4, userId: 7, autoSignalId: 31, alertEventId: 9001, symbol: SYMBOL, side: 'BUY',
    optionType: 'CALL', quantity: 0.1, limitPrice: 715, spot: 60250, deadlineAt: 601000,
    status: 'pending', createdAt: 1000, resolvedAt: null,
  });
  await repo.insertEntry(entry({ strategyId: 5, autoSignalId: null, alertEventId: null }));
  const all = await repo.listPending();
  assert.deepEqual(all.map((e) => e.strategyId), [4, 5]);
  assert.equal(all[1].autoSignalId, null);
  assert.equal(all[1].alertEventId, null);
  const only = await repo.listPending({ strategyId: 4 });
  assert.deepEqual(only.map((e) => e.id), [1]);
  const select = db.calls.find((c) => c.sql.startsWith('SELECT'));
  assert.match(select.sql, /ORDER BY created_at,id/);
});

test('sombra: insertEntry rechaza datos inválidos antes de tocar PostgreSQL', async () => {
  const db = memoryDb();
  const repo = createOptionsShadowEntriesRepository({ db });
  await assert.rejects(repo.insertEntry(entry({ side: 'HOLD' })), /Invalid shadow entry/);
  await assert.rejects(repo.insertEntry(entry({ quantity: 0 })), /Invalid shadow entry/);
  await assert.rejects(repo.insertEntry(entry({ limitPrice: -1 })), /Invalid shadow entry/);
  await assert.rejects(repo.insertEntry(entry({ deadlineAt: undefined })), /Invalid shadow entry/);
  assert.equal(db.calls.length, 0);
});

test('sombra: resolveEntry dos veces solo resuelve la primera', async () => {
  const db = memoryDb();
  const repo = createOptionsShadowEntriesRepository({ db });
  const { id } = await repo.insertEntry(entry());
  const first = await repo.resolveEntry(id, 'filled', 5000);
  assert.equal(first.status, 'filled');
  assert.equal(first.resolvedAt, 5000);
  assert.equal(await repo.resolveEntry(id, 'expired', 6000), null);
  assert.equal(db.rows[0].status, 'filled');
  const update = db.calls.find((c) => c.sql.startsWith('UPDATE'));
  assert.match(update.sql, /status='pending'/);
  assert.deepEqual(await repo.listPending(), []);
  await assert.rejects(repo.resolveEntry(id, 'pending', 1), /Invalid shadow entry status/);
});

test('sombra: cancelEntries ignora las no pendientes', async () => {
  const db = memoryDb();
  const repo = createOptionsShadowEntriesRepository({ db });
  const a = await repo.insertEntry(entry());
  const b = await repo.insertEntry(entry());
  await repo.resolveEntry(a.id, 'filled', 2000);
  const canceled = await repo.cancelEntries([a.id, b.id], 3000);
  assert.deepEqual(canceled.map((e) => [e.id, e.status, e.resolvedAt]), [[b.id, 'canceled', 3000]]);
  assert.equal(db.rows[0].status, 'filled');
  const before = db.calls.length;
  assert.deepEqual(await repo.cancelEntries([], 4000), []);
  assert.equal(db.calls.length, before);
});
