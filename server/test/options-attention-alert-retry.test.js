const test = require('node:test');
const assert = require('node:assert/strict');
const { OptionsLiveExecution } =
  require('../src/services/options/options-live-execution.service');
const { createOptionsLiveOrdersRepository } =
  require('../src/repositories/options-live-orders.repository');

const CLOCK = Date.UTC(2026, 9, 17, 19);
const ORDER_ID = 42;

test('Telegram outage releases only its own attention claim and retries next scan', async () => {
  let claimAt = 0;
  let notifications = 0;
  let releases = 0;
  const logger = { warn() {}, info() {}, error() {} };
  const db = {
    async query(sql, params) {
      if (sql.startsWith('SELECT id FROM options_live_orders')) {
        return { rows: [{ id: ORDER_ID }] };
      }
      if (sql.includes('SET attention_notified_at=$2')) {
        if (claimAt > CLOCK - 15 * 60_000) return { rows: [] };
        claimAt = params[1];
        return { rows: [{
          id: ORDER_ID, user_id: 1, strategy_id: 2, symbol: 'ETH-261023-2500-C',
          client_order_id: 'HC-ALERT', last_error: 'partial TP GTC',
          attention_notified_at: claimAt,
        }] };
      }
      if (sql.includes('SET attention_notified_at=0')) {
        releases++;
        const [id, token] = params;
        if (id !== ORDER_ID || token !== claimAt) return { rows: [] };
        claimAt = 0;
        return { rows: [{ id }] };
      }
      throw new Error('Unexpected query: ' + sql);
    },
  };
  const repo = createOptionsLiveOrdersRepository({ db, now: () => CLOCK });
  const engine = new OptionsLiveExecution({
    repo, now: () => CLOCK, logger, enabled: false,
    notify: async () => {
      notifications++;
      if (notifications === 1) throw new Error('Telegram unavailable');
    },
  });
  assert.equal(await engine.alertAttention(), 0);
  assert.equal(releases, 1);
  assert.equal(claimAt, 0, 'failed send does not impose a fifteen-minute silence');
  assert.equal(await engine.alertAttention(), 1);
  assert.equal(notifications, 2);
  assert.equal(claimAt, CLOCK);
  assert.equal(await engine.alertAttention(), 0, 'successful send is deduplicated');
  assert.equal(notifications, 2);
});

test('an older worker cannot release a newer claim or clear an order in a different status', async () => {
  let claimedAt = CLOCK + 2;
  let status = 'attention';
  const db = {
    async query(sql, params) {
      assert.match(sql, /status='attention'/);
      assert.match(sql, /attention_notified_at=\$2/);
      if (status !== 'attention' || params[1] !== claimedAt) return { rows: [] };
      claimedAt = 0;
      return { rows: [{ id: ORDER_ID }] };
    },
  };
  const repo = createOptionsLiveOrdersRepository({ db });
  assert.equal(await repo.releaseAttentionNotification(ORDER_ID, CLOCK), false);
  assert.equal(claimedAt, CLOCK + 2);
  status = 'final';
  assert.equal(await repo.releaseAttentionNotification(ORDER_ID, CLOCK + 2), false);
  assert.equal(claimedAt, CLOCK + 2);
  status = 'attention';
  assert.equal(await repo.releaseAttentionNotification(ORDER_ID, CLOCK + 2), true);
  assert.equal(claimedAt, 0);
  await assert.rejects(() => repo.releaseAttentionNotification(ORDER_ID, 0),
    /Invalid attention alert release token/);
});

test('claim-release DB outage does not abort alert loop or submit an order', async () => {
  let attempted = 0;
  const warnings = [];
  const engine = new OptionsLiveExecution({
    repo: {
      listAttentionOrders: async () => [ORDER_ID],
      claimAttentionNotification: async () => ({
        id: ORDER_ID, user_id: 1, strategy_id: 2,
        symbol: 'ETH-261023-2500-C', client_order_id: 'HC-ALERT',
        attention_notified_at: CLOCK, last_error: 'partial fill',
      }),
      releaseAttentionNotification: async () => { throw new Error('DB unavailable'); },
    },
    now: () => CLOCK, enabled: false,
    notify: async () => { attempted++; throw new Error('Telegram unavailable'); },
    logger: { warn: name => warnings.push(name), info() {}, error() {} },
  });
  assert.equal(await engine.alertAttention(), 0);
  assert.equal(attempted, 1);
  assert.deepEqual(warnings, [
    'options_live_attention_notify_failed',
    'options_live_attention_claim_release_failed',
  ]);
});
