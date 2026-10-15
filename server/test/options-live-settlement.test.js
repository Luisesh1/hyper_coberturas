const test = require('node:test');
const assert = require('node:assert/strict');
const { OptionsLiveSettlement, validateProof } =
  require('../src/services/options/options-live-settlement.service');

const expiry = Date.UTC(2026, 9, 16, 8);
const now = expiry + 90_000;
const group = { userId: 7, symbol: 'BTC-261016-60000-C',
  side: 'BUY', quantity: 0.2, expiryMs: expiry };
const record = { id: '1125899906842624042', currency: 'USDT',
  quoteAsset: 'USDT', symbol: group.symbol, positionSide: 'LONG',
  quantity: '0.2', amount: '500', fee: '1.25',
  createDate: expiry + 60_000 };
const bills = [
  { id: '333', symbol: group.symbol, asset: 'USDT', type: 'EXERCISE_PNL',
    amount: '500', createDate: record.createDate },
  { id: '334', symbol: group.symbol, asset: 'USDT', type: 'EXERCISE_FEE',
    amount: '-1.25', createDate: record.createDate },
];

test('la prueba de vencimiento exige cantidades, movimientos, comisiones y 64-bit ID exactos', () => {
  const result = validateProof(group, [record], bills, [], [], now);
  assert.deepEqual(result, {
    userId: 7, symbol: group.symbol, side: 'BUY',
    recordId: record.id, quantity: 0.2, payoffUsdt: 500,
    feeUsdt: 1.25, exercisedAt: record.createDate,
  });
});
test('rechaza ejercicio inconsistente aunque la posición ya no figure en Binance', () => {
  assert.throws(() => validateProof(group, [record], [], [], [], now), /amounts or fees/);
  assert.throws(() => validateProof(group, [record], bills,
    [{ symbol: group.symbol, quantity: '0.1' }], [], now), /still has live exposure/);
  assert.throws(() => validateProof(group, [record], bills, [],
    [{ symbol: group.symbol, status: 'NEW' }], now), /Pending Binance orders/);
  assert.throws(() => validateProof(group,
    [{ ...record, quantity: '0.3' }], bills, [], [], now), /inconsistent/);
  assert.throws(() => validateProof(group,
    [{ ...record, amount: '-500' }], bills, [], [], now), /inconsistent/);
  assert.throws(() => validateProof(group, [record, record], bills, [], [], now), /exactly one/);
  assert.throws(() => validateProof(group, [record], [{
    type: 'EXERCISE_PNL', asset: 'USDT', amount: '500',
    createDate: record.createDate,
  }], [], [], now), /Unattributable/);
  assert.throws(() => validateProof(group, Array(1000).fill(record), bills, [], [], now),
    /truncated/);
});
test('el ejercicio short verifica desembolso, no crédito', () => {
  const shortGroup = { ...group, side: 'SELL' };
  const shortRecord = { ...record, positionSide: 'SHORT', amount: '-500' };
  const shortBills = bills.map((b) => b.type === 'EXERCISE_PNL'
    ? { ...b, amount: '-500' } : b);
  const result = validateProof(shortGroup, [shortRecord], shortBills, [], [], now);
  assert.equal(result.payoffUsdt, 500);
  assert.equal(result.side, 'SELL');
});
test('el reconciliador no inventa liquidación si faltan movimientos o hay órdenes sin resolver', async () => {
  const proofs = [];
  const logger = { warn() {}, info() {} };
  const fixture = (unresolved = []) => new OptionsLiveSettlement({
    repo: {
      async listExpiredGroups() { return [group]; },
      async applyExercise(p) { proofs.push(p); return true; },
    },
    orders: { async listUnresolved() { return unresolved; } },
    credentials: { async getClientForUser() {
      return {
        async getExerciseRecords() { return [record]; },
        async getBills() { return []; },
        async getPositions() { return []; },
        async getOpenOrders() { return []; },
      };
    } },
    logger, now: () => now,
  });
  const missing = await fixture().reconcileExpired();
  assert.equal(missing.settled, 0);
  assert.equal(missing.blocked, 1);
  assert.equal(proofs.length, 0);
  const pending = await fixture([{ userId: 7 }]).reconcileExpired();
  assert.equal(pending.blocked, 1);
  assert.equal(proofs.length, 0);
});
test('conciliación confirmada aplica una sola vez; tras reinicio puede reanudar', async () => {
  const proofs = [];
  let expired = [group];
  const repo = {
    async listExpiredGroups() { return expired; },
    async applyExercise(p) { proofs.push(p); expired = []; return true; },
  };
  const service = new OptionsLiveSettlement({
    repo,
    orders: { async listUnresolved() { return []; } },
    credentials: { async getClientForUser() {
      return {
        async getExerciseRecords() { return [record]; },
        async getBills() { return bills; },
        async getPositions() { return []; },
        async getOpenOrders() { return []; },
      };
    } },
    now: () => now, logger: { info() {}, warn() {} },
  });
  assert.deepEqual(await service.reconcileExpired(),
    { checked: 1, settled: 1, blocked: 0, deferred: 0 });
  assert.equal(proofs.length, 1);
  assert.deepEqual(await service.reconcileExpired(),
    { checked: 0, settled: 0, blocked: 0, deferred: 0 });
});
