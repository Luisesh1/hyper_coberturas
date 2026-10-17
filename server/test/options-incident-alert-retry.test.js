const test = require('node:test');
const assert = require('node:assert/strict');
const { OptionsLiveExecution } =
  require('../src/services/options/options-live-execution.service');
const { createOptionsLiveOrdersRepository } =
  require('../src/repositories/options-live-orders.repository');

const NOW = Date.UTC(2026, 9, 17, 19);
const USER_ID = 1;
const POSITION_ID = 212;

function notificationDb() {
  const last = new Map();
  return {
    last,
    db: {
      async query(sql, args) {
        if (sql.startsWith('INSERT INTO options_live_incident_notifications')) {
          const [user, kind, resource, now, lower] = args;
          const key = [user, kind, resource].join(':');
          const prev = last.get(key);
          if (prev != null && prev > lower) return { rows: [] };
          last.set(key, now);
          return { rows: [{ last_notified_at: String(now) }] };
        }
        if (sql.startsWith('UPDATE options_live_incident_notifications SET last_notified_at=0')) {
          const [user, kind, resource, claimedAt] = args;
          const key = [user, kind, resource].join(':');
          if (last.get(key) !== Number(claimedAt)) return { rows: [] };
          last.set(key, 0);
          return { rows: [{ user_id: user }] };
        }
        throw new Error('Unexpected test SQL: ' + sql);
      },
    },
  };
}

test('Telegram outage for UNPROTECTED_TP retries next cycle, then deduplicates success', async () => {
  const state = notificationDb();
  const notices = [];
  const warnings = [];
  let attempts = 0;
  const repo = createOptionsLiveOrdersRepository({ db: state.db, now: () => NOW });
  repo.listUnprotectedLivePositions = async () => [{
    userId: USER_ID, positionId: POSITION_ID, openedAt: NOW - 5 * 60_000,
  }];
  const engine = new OptionsLiveExecution({
    repo, now: () => NOW, enabled: false,
    notify: async (_userId, msg) => {
      attempts++;
      if (attempts === 1) throw new Error('Telegram down');
      notices.push(msg);
    },
    logger: { warn: name => warnings.push(name), info() {}, error() {} },
  });
  let first = await engine.scanUnprotectedPositions();
  assert.equal(first.incidents, 1);
  assert.equal(first.alerts, 0);
  assert.deepEqual(warnings, ['options_unprotected_tp_notification_failed']);
  assert.equal(state.last.get('1:UNPROTECTED_TP:212'), 0,
    'failed delivery must release this notification token');
  const second = await engine.scanUnprotectedPositions();
  assert.equal(second.alerts, 1);
  assert.equal(attempts, 2);
  assert.match(notices[0], /Posición sin TP confirmado/);
  assert.equal((await engine.scanUnprotectedPositions()).alerts, 0);
  assert.equal(attempts, 2, 'successful delivery stays deduplicated');
});

test('TP_NOT_PROTECTED incident also retries after delivery failure', async () => {
  const { db } = notificationDb();
  const repo = createOptionsLiveOrdersRepository({ db, now: () => NOW });
  let attempts = 0;
  const engine = new OptionsLiveExecution({
    repo, now: () => NOW, enabled: false,
    notify: async () => {
      attempts++;
      if (attempts === 1) throw new Error('Telegram down');
    },
    logger: { warn() {}, info() {}, error() {} },
  });
  await assert.rejects(
    () => engine.sendIncidentAlert(USER_ID, 'TP_NOT_PROTECTED', String(POSITION_ID), 'urgent'),
    /Telegram down/);
  assert.equal(await engine.sendIncidentAlert(USER_ID, 'TP_NOT_PROTECTED', String(POSITION_ID), 'urgent'), true);
  assert.equal(attempts, 2);
  assert.equal(await engine.sendIncidentAlert(USER_ID, 'TP_NOT_PROTECTED', String(POSITION_ID), 'urgent'), false);
});

test('only the exact failed claim can be released; a newer delivery stays claimed', async () => {
  const state = notificationDb();
  const repo = createOptionsLiveOrdersRepository({ db: state.db, now: () => NOW });
  const resource = String(POSITION_ID);
  const original = await repo.claimIncidentNotificationToken(USER_ID, 'UNPROTECTED_TP', resource);
  assert.equal(original, NOW);
  state.last.set('1:UNPROTECTED_TP:212', NOW + 1);
  assert.equal(await repo.releaseIncidentNotification(USER_ID, 'UNPROTECTED_TP', resource, original), false);
  assert.equal(state.last.get('1:UNPROTECTED_TP:212'), NOW + 1);
  assert.equal(await repo.releaseIncidentNotification(USER_ID, 'UNPROTECTED_TP', resource, NOW + 1), true);
  assert.equal(state.last.get('1:UNPROTECTED_TP:212'), 0);
  await assert.rejects(
    () => repo.releaseIncidentNotification(USER_ID, 'UNPROTECTED_TP', resource, 0),
    /Invalid incident notification token/);
});
