/**
 * Diagnostico de senal ETH y Telegram para el piloto SUPERVISADO.
 * --read-only: solo SELECT y lectura local, sin mensajes ni ordenes.
 * --send-test: envia UN mensaje de prueba benigno a Telegram (no a Binance).
 * Ambos modos requieren los flags live en OFF. La salida no expone IDs de
 * cuenta, nombres de alertas, token, chatId ni patrimonio.
 */
'use strict';

const USER_ID = 1;
const TEST_TEXT = '<b>Prueba de canal: piloto ETH Options</b>\n' +
  'Este mensaje comprueba el acuse de Telegram. ' +
  'El trading real sigue APAGADO. No se enviaron ordenes.';
const MODES = new Set(['--read-only', '--send-test']);

function disabled(env) {
  return env.OPTIONS_LIVE_TRADING_ENABLED === 'false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED === 'false' &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED !== 'true';
}

function emptyResult(mode, off) {
  return {
    mode, readOnly: mode === '--read-only', pilotReady: false,
    status: 'blocked', checks: {
      tradingDisabled: off, strategyCandidate: false,
      signalBound: false, telegramConfigured: false,
    },
    eligibleAlerts: 0, bullish: 0, bearish: 0,
    telegramTest: mode === '--send-test' ? 'skipped' : 'not_requested',
  };
}

async function inspectChannel({
  env = process.env, mode = '--read-only',
  strategyFn = () => require('./options-pilot-strategy-readiness').inspect({}),
  repo = require('../repositories/options-strategies.repository'),
  listEligible = (id) =>
    require('../services/options/options-auto-trading.service').eligibleAlerts(id, 'ETH'),
  getTelegram = (id) => require('../services/settings.service').getTelegram(id),
  sendTest = async (token, chatId) => {
    const TelegramService = require('../services/telegram.service');
    const client = new TelegramService(token, chatId, { userId: USER_ID });
    return client.send(TEST_TEXT);
  },
} = {}) {
  if (!MODES.has(mode)) throw new Error('Unsupported pilot channel check mode');
  const off = disabled(env);
  const result = emptyResult(mode, off);
  // Ningun GET privado ni envio Telegram si se habilito trading real.
  if (!off) return result;
  const [strategy, eligible, cfg] = await Promise.all([
    strategyFn(), listEligible(USER_ID), getTelegram(USER_ID),
  ]);
  const strategyId = strategy?.candidateStrategyId;
  result.checks.strategyCandidate = strategy?.status === 'strategy_candidate' &&
    strategy?.readOnly === true && strategy.pilotReady === false &&
    Number.isSafeInteger(strategyId) && strategyId > 0;

  if (!Array.isArray(eligible)) throw new Error('Eligible alerts not available');
  // No imprimir nombres, IDs de alerta o activos privados en GitHub Actions.
  const clean = eligible.filter(a => Number.isSafeInteger(Number(a?.id)) &&
    Number(a.id) > 0 && ['bullish','bearish'].includes(a.direction));
  result.eligibleAlerts = clean.length;
  result.bullish = clean.filter(a => a.direction === 'bullish').length;
  result.bearish = clean.filter(a => a.direction === 'bearish').length;
  const strategyRecord = result.checks.strategyCandidate
    ? await repo.getStrategy(USER_ID, strategyId) : null;
  const ids = strategyRecord?.params?.alertIds;
  const eligibleIds = new Set(clean.map(a => Number(a.id)));
  result.checks.signalBound = result.checks.strategyCandidate &&
    strategyRecord?.mode === 'paused' &&
    Array.isArray(ids) && ids.length > 0 && ids.every(id => eligibleIds.has(Number(id)));

  const token = String(cfg?.token || '').trim();
  const chatId = String(cfg?.chatId || '').trim();
  result.checks.telegramConfigured = Boolean(token && chatId);
  if (mode === '--send-test') {
    if (!result.checks.telegramConfigured) {
      result.telegramTest = 'skipped';
    } else {
      // Telegram API devuelve un acuse, no garantiza lectura humana.
      try {
        const response = await sendTest(token, chatId);
        result.telegramTest = response?.ok === true &&
          response?.result?.message_id != null ? 'ack' : 'fail';
      } catch {
        result.telegramTest = 'fail';
      }
    }
  }
  result.status = result.checks.strategyCandidate &&
    result.checks.signalBound && result.checks.telegramConfigured &&
    (mode === '--read-only' || result.telegramTest === 'ack')
    ? 'channel_candidate' : 'blocked';
  return result;
}

function outputLines(r) {
  const names = ['tradingDisabled','strategyCandidate','signalBound','telegramConfigured'];
  if (!r || !MODES.has(r.mode) ||
      r.readOnly !== (r.mode === '--read-only') ||
      r.pilotReady !== false ||
      !['blocked','channel_candidate'].includes(r.status) ||
      !['not_requested','skipped','ack','fail'].includes(r.telegramTest) ||
      names.some(name => typeof r.checks?.[name] !== 'boolean') ||
      [r.eligibleAlerts,r.bullish,r.bearish].some(x => !Number.isSafeInteger(x) || x < 0) ||
      r.bullish + r.bearish !== r.eligibleAlerts ||
      (r.status === 'channel_candidate' && !names.every(name => r.checks[name])) ||
      (r.mode === '--read-only' && r.telegramTest !== 'not_requested') ||
      (r.mode === '--send-test' && r.telegramTest === 'not_requested')) {
    throw new Error('Unsafe pilot channel probe output');
  }
  const check = value => value ? 'pass' : 'fail';
  return [
    'pilot_channel_mode=' + (r.readOnly ? 'read_only' : 'telegram_test_only'),
    'pilot_channel_status=' + r.status,
    ...names.map(name => 'pilot_channel_' + name + '=' + check(r.checks[name])),
    'pilot_channel_eligible_eth_alerts=' + r.eligibleAlerts,
    'pilot_channel_bullish=' + r.bullish,
    'pilot_channel_bearish=' + r.bearish,
    'pilot_channel_telegram_ack=' + r.telegramTest,
    'pilot_channel_telegram_human_receipt=unverified',
    'pilot_channel_orders_sent=0',
    'pilot_ready=no',
  ];
}

async function main() {
  if (process.argv.length !== 3 || !MODES.has(process.argv[2])) {
    throw new Error('Usage: options-pilot-channel-probe.js --read-only|--send-test');
  }
  const outcome = await inspectChannel({ mode: process.argv[2] });
  outputLines(outcome).forEach(line => process.stdout.write(line + '\n'));
}
if (require.main === module) {
  main().catch(() => {
    console.log('pilot_channel_status=unavailable');
    console.log('pilot_channel_orders_sent=0');
    console.log('pilot_ready=no');
    process.exitCode = 1;
  });
}
module.exports = { disabled, inspectChannel, outputLines, TEST_TEXT };
