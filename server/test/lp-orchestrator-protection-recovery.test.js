const test = require('node:test');
const assert = require('node:assert/strict');

const {
  needsProtectionRecovery,
  shouldAttemptNow,
  nextRetryState,
  MAX_PROTECTION_RETRY_ATTEMPTS,
} = require('../src/services/lp-orchestrator/protection-recovery');

function makeOrch(overrides = {}) {
  return {
    id: 26,
    userId: 3,
    status: 'active',
    phase: 'lp_active',
    activePositionIdentifier: '191720',
    activeProtectedPoolId: null,
    protectionConfig: { enabled: true, accountId: 8, configuredNotionalUsd: 50 },
    strategyState: {},
    ...overrides,
  };
}

test('detecta un LP activo que pidio cobertura y no la tiene', () => {
  assert.equal(needsProtectionRecovery(makeOrch()), true);
});

test('no toca orquestadores ya cubiertos ni los que no pidieron cobertura', () => {
  assert.equal(needsProtectionRecovery(makeOrch({ activeProtectedPoolId: 77 })), false);
  assert.equal(needsProtectionRecovery(makeOrch({ protectionConfig: { enabled: false } })), false);
  assert.equal(needsProtectionRecovery(makeOrch({ protectionConfig: null })), false);
  assert.equal(needsProtectionRecovery(makeOrch({ activePositionIdentifier: null })), false);
  assert.equal(needsProtectionRecovery(makeOrch({ status: 'archived' })), false);
});

test('el primer intento es inmediato', () => {
  assert.equal(shouldAttemptNow(makeOrch(), 1_000_000), true);
});

test('respeta el backoff persistido', () => {
  const orch = makeOrch({
    strategyState: { protectionRetry: { attempts: 1, nextAttemptAt: 2_000_000 } },
  });
  assert.equal(shouldAttemptNow(orch, 1_999_999), false);
  assert.equal(shouldAttemptNow(orch, 2_000_000), true);
});

test('deja de reintentar tras agotar los intentos', () => {
  const orch = makeOrch({
    strategyState: {
      protectionRetry: { attempts: MAX_PROTECTION_RETRY_ATTEMPTS, nextAttemptAt: 0 },
    },
  });
  assert.equal(shouldAttemptNow(orch, 9_999_999), false);
});

test('el backoff crece y se corona a 4 h', () => {
  const now = 1_000_000;
  const first = nextRetryState(null, { ok: false, error: 'boom', now });
  assert.equal(first.attempts, 1);
  assert.equal(first.nextAttemptAt, now + 5 * 60_000);
  assert.equal(first.lastError, 'boom');
  assert.equal(first.exhausted, false);

  const second = nextRetryState(first, { ok: false, error: 'boom', now });
  assert.equal(second.attempts, 2);
  assert.equal(second.nextAttemptAt, now + 10 * 60_000);

  let state = second;
  for (let i = 0; i < 10; i += 1) state = nextRetryState(state, { ok: false, error: 'boom', now });
  assert.equal(state.nextAttemptAt, now + 4 * 60 * 60_000);
  assert.equal(state.exhausted, true);
});

test('el exito limpia el estado de reintento', () => {
  const failed = nextRetryState(null, { ok: false, error: 'boom', now: 1_000_000 });
  assert.equal(nextRetryState(failed, { ok: true, now: 1_000_000 }), null);
});
