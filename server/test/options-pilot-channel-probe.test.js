const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectChannel, outputLines, TEST_TEXT } =
  require('../src/scripts/options-pilot-channel-probe');

const env = {
  OPTIONS_LIVE_TRADING_ENABLED: 'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED: 'false',
  OPTIONS_LIVE_PILOT_AUTHORIZED: 'false',
};
const strategy = {
  status: 'strategy_candidate', candidateStrategyId: 2,
  readOnly: true, pilotReady: false,
};
const eligible = [
  { id: 31, name: 'Estrategia ETH secreta', direction: 'bullish' },
  { id: 32, name: 'Venta ETH', direction: 'bearish' },
];
const config = {
  token: 'sampleSECRET_not_to_log', chatId: 'PRIVATE_CHAT_894',
};
const deps = {
  env,
  strategyFn: async () => strategy,
  repo: { getStrategy: async () => ({
    mode: 'paused', params: { alertIds: [31] },
  }) },
  listEligible: async () => eligible,
  getTelegram: async () => config,
  sendTest: async () => ({ ok: true, result: { message_id: 3 } }),
};

test('read-only mode identifies candidate signal without sending Telegram or orders', async () => {
  let calls = 0;
  const r = await inspectChannel({ ...deps,
    sendTest: async () => { calls++; throw Error('must not send'); } });
  assert.equal(r.status, 'channel_candidate');
  assert.equal(r.telegramTest, 'not_requested');
  assert.equal(r.eligibleAlerts, 2);
  assert.equal(r.bullish, 1);
  assert.equal(r.bearish, 1);
  assert.equal(calls, 0);
  const lines = outputLines(r).join('\n');
  assert.match(lines, /pilot_channel_signalBound=pass/);
  assert.match(lines, /pilot_ready=no/);
  assert.doesNotMatch(lines, /sampleSECRET|PRIVATE_CHAT|Estrategia ETH secreta|31|894/);
});

test('paused pilot with no alertIds is never a signal-ready candidate', async () => {
  const r = await inspectChannel({ ...deps,
    repo: { getStrategy: async () => ({
      mode: 'paused', params: { alertIds: [] },
    }) } });
  assert.equal(r.status, 'blocked');
  assert.equal(r.checks.signalBound, false);
  assert.match(outputLines(r).join('\n'), /pilot_channel_signalBound=fail/);
});

test('stale or unrelated alerts never establish readiness', async () => {
  for (const ids of [[900],[31,900]]) {
    const r = await inspectChannel({ ...deps,
      repo: { getStrategy: async () => ({
        mode: 'paused', params: { alertIds: ids },
      }) } });
    assert.equal(r.checks.signalBound, false);
  }
});

test('Telegram send-test requires OFF flags, detects ack not human receipt', async () => {
  let sent = 0;
  const r = await inspectChannel({ ...deps, mode: '--send-test',
    sendTest: async (token, chatId) => {
      assert.equal(token, config.token);
      assert.equal(chatId, config.chatId);
      sent++;
      return { ok: true, result: { message_id: 123 } };
    } });
  assert.equal(sent, 1);
  assert.equal(r.telegramTest, 'ack');
  assert.match(outputLines(r).join('\n'), /pilot_channel_telegram_human_receipt=unverified/);
  assert.match(TEST_TEXT, /trading real sigue APAGADO/);
});

test('Telegram missing or rejected never claims successful delivery', async () => {
  const r = await inspectChannel({ ...deps, mode: '--send-test',
    sendTest: async () => null });
  assert.equal(r.telegramTest, 'fail');
  const noCfg = await inspectChannel({ ...deps, mode: '--send-test',
    getTelegram: async () => ({ token: '', chatId: '' }) });
  assert.equal(noCfg.telegramTest, 'skipped');
  assert.equal(noCfg.checks.telegramConfigured, false);
});

test('both modes fail closed before inspecting anything when live flags ON', async () => {
  for (const mode of ['--read-only','--send-test']) {
    let calls=0;
    const r = await inspectChannel({
      ...deps, mode,
      env: { ...env, OPTIONS_LIVE_TRADING_ENABLED: 'true' },
      strategyFn: async () => { calls++; return strategy; },
      listEligible: async () => { calls++; return eligible; },
      getTelegram: async () => { calls++; return config; },
      sendTest: async () => { calls++; throw Error('must not send'); },
    });
    assert.equal(calls, 0);
    assert.equal(r.status,'blocked');
    assert.equal(r.checks.tradingDisabled,false);
    assert.match(outputLines(r).join('\n'), /pilot_ready=no/);
  }
});

test('source never modifies strategy, orders, or Binance flags', () => {
  const script=fs.readFileSync(path.resolve(__dirname,
    '../src/scripts/options-pilot-channel-probe.js'),'utf8');
  assert.doesNotMatch(script, /\.placeOrder\(|\.cancelOrder\(|\.setMode\(|\.updateStrategy\(|\.setLimits\(/);
});
