/**
 * alerts.service.js
 *
 * Capa de negocio para alertas: validación con zod, parseo/serialización
 * JSON, builder del mensaje de Telegram con deep link a TradingView.
 *
 * El scheduler la importa para `evaluateAlertOnAsset` y `triggerNow`.
 */

const { z } = require('zod');
const { ValidationError, NotFoundError } = require('../../errors/app-error');
const config = require('../../config');
const logger = require('../logger.service');
const alertsRepo = require('../../repositories/alerts.repository');
const marketData = require('../market-data.service');
const telegramRegistry = require('../telegram.registry');
const evaluator = require('./indicator-evaluator');

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const DATASOURCES = ['hyperliquid', 'binance', 'yahoo'];

// ------------------------------------------------------------------
// Schemas zod
// ------------------------------------------------------------------

const operandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('constant'), value: z.number() }),
  z.object({ kind: z.literal('between'), lower: z.number(), upper: z.number() }),
  z.object({
    kind: z.literal('series'),
    indicatorType: z.string(),
    indicatorParams: z.record(z.string(), z.any()).optional().default({}),
    timeframe: z.enum(TIMEFRAMES),
    operandSeries: z.string().optional(),
  }),
  z.object({ kind: z.literal('price') }),
  // Mismo indicador y serie de la regla, pero desplazado N velas atrás.
  // Útil para detectar cambios de dirección: "RSI > RSI[-1]" o
  // "EMA cruza al alza su valor de hace 5 velas".
  z.object({ kind: z.literal('self_offset'), offset: z.number().int().positive() }),
  z.object({ kind: z.literal('none') }),
]);

const conditionSchema = z.object({
  indicatorType: z.string(),
  indicatorParams: z.record(z.string(), z.any()).optional().default({}),
  timeframe: z.enum(TIMEFRAMES),
  operandSeries: z.string().optional(),
  operator: z.enum([
    '>', '<', '=', '>=', '<=', 'between',
    'cross_up', 'cross_down',
    'above_upper', 'below_lower', 'above_middle', 'below_middle',
    'squeeze_on', 'squeeze_off',
    'momentum_positive', 'momentum_negative',
    'momentum_redirect_bullish', 'momentum_redirect_bearish',
  ]),
  operand: operandSchema,
});

// Una regla acepta:
//   - Forma nueva: { id?, conditions: [Condition...], joiners: ['and'|'or'...], weight }
//     joiners.length === conditions.length - 1 (asociación izquierda-a-derecha).
//   - Forma plana (legacy / regla simple): los campos de Condition al
//     mismo nivel + weight. Se normaliza a la forma nueva con 1 condición.
const ruleSchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Array.isArray(raw.conditions)) return raw;
    if (raw.indicatorType) {
      const { id, label, weight, indicatorType, indicatorParams, timeframe, operandSeries, operator, operand } = raw;
      return {
        id,
        label,
        weight,
        conditions: [{ indicatorType, indicatorParams, timeframe, operandSeries, operator, operand }],
        joiners: [],
      };
    }
  }
  return raw;
}, z.object({
  id: z.string().optional(),
  label: z.string().trim().max(120).optional().default(''),
  conditions: z.array(conditionSchema).min(1),
  joiners: z.array(z.enum(['and', 'or'])).optional().default([]),
  weight: z.number().nonnegative().default(1),
}));

const alertSchema = z.object({
  name: z.string().min(1).max(255),
  isActive: z.boolean().default(true),
  thresholdPercent: z.number().min(0).max(100).default(70),
  assetList: z.array(z.string().min(1).max(40)).min(1),
  rules: z.array(ruleSchema).default([]),
  telegramEnabled: z.boolean().default(true),
  cooldownSeconds: z.number().int().nonnegative().default(900),
  datasource: z.enum(DATASOURCES).default('binance'),
});

// Compatibilidad operador → kinds aceptados de operand.
const OPERATOR_OPERAND_KIND = {
  '>':  ['constant', 'series', 'price', 'self_offset'],
  '<':  ['constant', 'series', 'price', 'self_offset'],
  '=':  ['constant', 'series', 'price', 'self_offset'],
  '>=': ['constant', 'series', 'price', 'self_offset'],
  '<=': ['constant', 'series', 'price', 'self_offset'],
  'between': ['between'],
  'cross_up':   ['constant', 'series', 'price', 'self_offset'],
  'cross_down': ['constant', 'series', 'price', 'self_offset'],
  'above_upper': ['none'], 'below_lower': ['none'],
  'above_middle': ['none'], 'below_middle': ['none'],
  'squeeze_on': ['none'], 'squeeze_off': ['none'],
  'momentum_positive': ['none'], 'momentum_negative': ['none'],
  'momentum_redirect_bullish': ['none'], 'momentum_redirect_bearish': ['none'],
};

function validatePayload(input) {
  const parsed = alertSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Payload inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ')}`);
  }
  const data = parsed.data;
  for (const [i, rule] of data.rules.entries()) {
    if (rule.joiners.length !== Math.max(0, rule.conditions.length - 1)) {
      throw new ValidationError(`regla ${i}: joiners debe tener ${rule.conditions.length - 1} elemento(s), recibido ${rule.joiners.length}`);
    }
    for (const [j, cond] of rule.conditions.entries()) {
      const allowed = OPERATOR_OPERAND_KIND[cond.operator] || [];
      if (!allowed.includes(cond.operand.kind)) {
        throw new ValidationError(`regla ${i}, condición ${j}: operador '${cond.operator}' no admite operand kind '${cond.operand.kind}'`);
      }
      if (!evaluator.SUPPORTED_INDICATORS.has(cond.indicatorType)) {
        throw new ValidationError(`regla ${i}, condición ${j}: indicador '${cond.indicatorType}' no soportado`);
      }
      if (cond.operand.kind === 'series' && !evaluator.SUPPORTED_INDICATORS.has(cond.operand.indicatorType)) {
        throw new ValidationError(`regla ${i}, condición ${j}: operand.indicatorType '${cond.operand.indicatorType}' no soportado`);
      }
    }
  }
  return data;
}

// ------------------------------------------------------------------
// Mappers DB ↔ payload
// ------------------------------------------------------------------

function rowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    isActive: row.is_active,
    thresholdPercent: Number(row.threshold_percent),
    assetList: safeParse(row.asset_list_json, []),
    rules: safeParse(row.rules_json, []),
    telegramEnabled: row.telegram_enabled,
    cooldownSeconds: Number(row.cooldown_seconds),
    lastTriggeredAt: row.last_triggered_at_json || {},
    datasource: row.datasource,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function safeParse(text, fallback) {
  if (text == null) return fallback;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return fallback; }
}

function dtoToRowPayload(data) {
  return {
    name: data.name,
    isActive: data.isActive,
    thresholdPercent: data.thresholdPercent,
    assetListJson: JSON.stringify(data.assetList),
    rulesJson: JSON.stringify(data.rules),
    telegramEnabled: data.telegramEnabled,
    cooldownSeconds: data.cooldownSeconds,
    datasource: data.datasource,
    now: Date.now(),
  };
}

// ------------------------------------------------------------------
// CRUD
// ------------------------------------------------------------------

async function listAlerts(userId) {
  const rows = await alertsRepo.listByUser(userId);
  return rows.map(rowToDto);
}

async function getAlert(userId, alertId) {
  const row = await alertsRepo.getById(userId, alertId);
  if (!row) throw new NotFoundError(`alerta ${alertId} no encontrada`);
  return rowToDto(row);
}

async function createAlert(userId, payload) {
  const data = validatePayload(payload);
  const row = await alertsRepo.create(userId, dtoToRowPayload(data));
  invalidateSchedulerCache();
  return rowToDto(row);
}

async function updateAlert(userId, alertId, payload) {
  await getAlert(userId, alertId);
  const data = validatePayload(payload);
  const row = await alertsRepo.update(userId, alertId, dtoToRowPayload(data));
  invalidateSchedulerCache();
  return rowToDto(row);
}

async function deleteAlert(userId, alertId) {
  const removed = await alertsRepo.remove(userId, alertId);
  if (!removed) throw new NotFoundError(`alerta ${alertId} no encontrada`);
  invalidateSchedulerCache();
  return { id: alertId, removed: true };
}

async function listAlertEvents(userId, alertId, opts) {
  await getAlert(userId, alertId);
  return alertsRepo.listEventsForAlert(userId, alertId, opts);
}

// ------------------------------------------------------------------
// Evaluación de una alerta sobre un activo
// ------------------------------------------------------------------

const TF_MS = marketData.TIMEFRAME_TO_MS;
const CANDLE_FETCH_LIMIT = 250;

function ruleConditions(rule) {
  if (Array.isArray(rule?.conditions)) return rule.conditions;
  if (rule?.indicatorType) return [rule];
  return [];
}

function lowestTimeframe(rules) {
  let lowest = null;
  let lowestMs = Infinity;
  for (const timeframe of distinctTimeframes(rules)) {
    const ms = TF_MS[timeframe];
    if (ms != null && ms < lowestMs) {
      lowestMs = ms;
      lowest = timeframe;
    }
  }
  return lowest;
}

function distinctTimeframes(rules) {
  const set = new Set();
  for (const r of rules) {
    for (const c of ruleConditions(r)) {
      if (c.timeframe) set.add(c.timeframe);
      if (c.operand?.kind === 'series' && c.operand.timeframe) set.add(c.operand.timeframe);
    }
  }
  return Array.from(set);
}

function timestampMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function candleCloseTimeMs(candle, timeframe) {
  const explicitClose = timestampMs(candle?.closeTime);
  if (explicitClose != null) return explicitClose;
  const openTime = timestampMs(candle?.time);
  const duration = TF_MS[timeframe];
  if (openTime == null || !duration) return null;
  return openTime + duration;
}

function filterClosedCandles(candles, timeframe, now = Date.now()) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((candle) => {
    const closeTime = candleCloseTimeMs(candle, timeframe);
    return closeTime != null && closeTime <= now;
  });
}

function calculateWeightedScore(rules, ruleResults) {
  const totalWeight = rules.reduce(
    (acc, rule) => acc + evaluator.normalizeWeight(rule?.weight),
    0
  );
  const matchedWeight = ruleResults.reduce(
    (acc, result) => acc + (result.matched ? evaluator.normalizeWeight(result.rule?.weight) : 0),
    0
  );
  return {
    totalWeight,
    matchedWeight,
    score: totalWeight > 0 ? (matchedWeight / totalWeight) * 100 : 0,
  };
}

async function evaluateAlertOnAsset(alertDto, asset, { ignoreCooldown = false, sendTelegram = true } = {}) {
  const rules = alertDto.rules || [];
  if (rules.length === 0) {
    return { asset, score: 0, threshold: alertDto.thresholdPercent, matched: [], unmatched: [], wouldTrigger: false, reason: 'sin reglas' };
  }
  const tfs = distinctTimeframes(rules);
  const candlesByTf = {};
  const evaluationTime = Date.now();
  await Promise.all(tfs.map(async (tf) => {
    try {
      const candles = await marketData.getCandles(asset, tf, {
        datasource: alertDto.datasource,
        limit: CANDLE_FETCH_LIMIT,
      });
      candlesByTf[tf] = filterClosedCandles(candles, tf, evaluationTime);
    } catch (err) {
      logger.warn('alerts_candles_fetch_failed', {
        alertId: alertDto.id, asset, tf, error: err.message,
      });
      candlesByTf[tf] = [];
    }
  }));

  const ruleResults = rules.map((rule) => {
    try {
      const r = evaluator.evaluateRule(rule, candlesByTf);
      return { rule, ...r };
    } catch (err) {
      return { rule, matched: false, value: null, threshold: null, reason: `error: ${err.message}` };
    }
  });

  const { score } = calculateWeightedScore(rules, ruleResults);

  const lowestTf = lowestTimeframe(rules);
  const lowestCandles = candlesByTf[lowestTf] || [];
  const lastCandle = lowestCandles[lowestCandles.length - 1];
  const candleCloseTime = candleCloseTimeMs(lastCandle, lowestTf) ?? evaluationTime;

  const wouldTrigger = score >= Number(alertDto.thresholdPercent);
  const cooldownLeftMs = (() => {
    const last = Number(alertDto.lastTriggeredAt?.[asset] || 0);
    if (!last) return 0;
    const elapsed = Date.now() - last;
    const cd = Number(alertDto.cooldownSeconds || 0) * 1000;
    return Math.max(0, cd - elapsed);
  })();

  const matched = ruleResults.filter((r) => r.matched);
  const unmatched = ruleResults.filter((r) => !r.matched);
  const result = {
    asset,
    score,
    threshold: Number(alertDto.thresholdPercent),
    wouldTrigger,
    cooldownLeftMs,
    candleCloseTime,
    lowestTimeframe: lowestTf,
    matched,
    unmatched,
    rules: ruleResults,
  };

  if (!wouldTrigger) return result;
  if (cooldownLeftMs > 0 && !ignoreCooldown) {
    return { ...result, suppressedBy: 'cooldown' };
  }

  // Disparar: registrar evento y enviar telegram
  const alertSentAt = Date.now();
  const messageText = buildAlertMessage({
    alert: alertDto,
    asset,
    score,
    matched,
    total: ruleResults.length,
    candleCloseTime,
    lowestTf,
    sentAt: alertSentAt,
  });

  let telegramSent = false;
  let telegramError = null;
  if (sendTelegram && alertDto.telegramEnabled) {
    try {
      const tg = await telegramRegistry.getOrCreate(alertDto.userId);
      if (tg && tg.enabled) {
        const sendResult = await tg.send(messageText, { parse_mode: 'HTML' });
        telegramSent = sendResult != null;
        if (!telegramSent) telegramError = 'telegram_send_returned_null';
      } else {
        telegramError = 'telegram_no_configurado';
      }
    } catch (err) {
      telegramError = err?.message || 'telegram_send_failed';
      logger.warn('alerts_telegram_send_failed', {
        alertId: alertDto.id, asset, error: telegramError,
      });
    }
  }

  const event = await alertsRepo.recordEvent({
    alertId: alertDto.id,
    userId: alertDto.userId,
    asset,
    timeframe: lowestTf,
    candleCloseTime,
    score,
    thresholdPercent: alertDto.thresholdPercent,
    matchedRulesJson: JSON.stringify(matched.map((m) => ({
      label: m.rule.label || '',
      indicatorType: m.rule.indicatorType,
      indicatorParams: m.rule.indicatorParams,
      timeframe: m.rule.timeframe,
      operator: m.rule.operator,
      operand: m.rule.operand,
      weight: m.rule.weight,
      reason: m.reason,
      value: m.value,
    }))),
    messageText,
    telegramSent,
    telegramError,
    now: alertSentAt,
  });

  await alertsRepo.updateCooldown(alertDto.id, asset, alertSentAt).catch((err) => {
    logger.warn('alerts_cooldown_update_failed', {
      alertId: alertDto.id, asset, error: err.message,
    });
  });

  return {
    ...result,
    triggered: true,
    eventId: event.id,
    telegramSent,
    telegramError,
    messageText,
  };
}

async function testAlertNow(userId, alertId, { dryRun = true } = {}) {
  const alert = await getAlert(userId, alertId);
  const results = [];
  for (const asset of alert.assetList) {
    const r = await evaluateAlertOnAsset(alert, asset, {
      ignoreCooldown: true,
      sendTelegram: !dryRun,
    });
    results.push(r);
  }
  return { alertId: alert.id, dryRun, results };
}

// ------------------------------------------------------------------
// Builder del mensaje
// ------------------------------------------------------------------

function buildAlertMessage({ alert, asset, score, matched, total, candleCloseTime, lowestTf, sentAt = Date.now() }) {
  const base = String(config.server.publicBaseUrl || '').replace(/\/+$/, '');
  const url = `${base}/trading-view?symbol=${encodeURIComponent(asset)}&tf=${encodeURIComponent(lowestTf || '')}`;
  const matchedLabels = matched.map(ruleMessageLabel).filter(Boolean);
  const matchedLines = matchedLabels.length
    ? matchedLabels.map((label) => `  • ${escapeHtml(label)}`).join('\n')
    : '  (sin labels)';
  const when = new Date(candleCloseTime).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
  const sentAtUtc = formatUtcDateTime(sentAt);
  return [
    `🔔 <b>${escapeHtml(alert.name)}</b>`,
    `Activo: <b>${escapeHtml(asset)}</b> · TF: ${escapeHtml(lowestTf || '?')}`,
    `Puntaje: <b>${score.toFixed(1)}%</b> (umbral ${Number(alert.thresholdPercent).toFixed(0)}%)`,
    `Labels de reglas aprobadas (${matchedLabels.length}/${matched.length}, ${total} total):`,
    matchedLines,
    `Cierre vela: ${escapeHtml(when)}`,
    `Enviada UTC: <b>${escapeHtml(sentAtUtc)}</b>`,
    `<a href="${url}">📈 Abrir gráfico</a>`,
  ].join('\n');
}

function ruleMessageLabel(result) {
  const label = String(result?.rule?.label || '').trim();
  return label;
}

function formatUtcDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().replace(/\.\d{3}Z$/, ' UTC').replace('T', ' ');
  return date.toISOString().replace(/\.\d{3}Z$/, ' UTC').replace('T', ' ');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ------------------------------------------------------------------
// Hook al scheduler para invalidar cache (set por scheduler en runtime)
// ------------------------------------------------------------------

let _invalidateSchedulerCache = () => {};
function setSchedulerCacheInvalidator(fn) {
  if (typeof fn === 'function') _invalidateSchedulerCache = fn;
}
function invalidateSchedulerCache() {
  try { _invalidateSchedulerCache(); } catch { /* noop */ }
}

module.exports = {
  TIMEFRAMES,
  DATASOURCES,
  buildAlertMessage,
  calculateWeightedScore,
  createAlert,
  deleteAlert,
  evaluateAlertOnAsset,
  filterClosedCandles,
  getAlert,
  listAlertEvents,
  listAlerts,
  lowestTimeframe,
  rowToDto,
  setSchedulerCacheInvalidator,
  testAlertNow,
  updateAlert,
  validatePayload,
};
