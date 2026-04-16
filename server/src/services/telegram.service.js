/**
 * telegram.service.js
 *
 * Envia notificaciones al bot de Telegram cuando ocurren eventos de trading.
 * Requiere en .env:
 *   TELEGRAM_BOT_TOKEN  - Token del bot (obtenido de @BotFather)
 *   TELEGRAM_CHAT_ID    - ID del chat/grupo donde enviar mensajes
 *
 * Si no estan configurados, el servicio se deshabilita silenciosamente.
 */

const httpClient = require('../shared/platform/http/http-client');
const config = require('../config');
const logger = require('./logger.service');
const {
  computeBackoffMs,
  extractTelegramRetryAfterMs,
  isTelegramRetryableError,
  sleep,
} = require('./external-service-helpers');

// ------------------------------------------------------------------
// Alert ring buffer (compartido entre todas las instancias)
// Sirve de fuente de datos para /alertas. Se resetea al reiniciar.
// ------------------------------------------------------------------
const ALERT_BUFFER_MAX_ITEMS = 50;
const ALERT_BUFFER_WINDOW_MS = 24 * 60 * 60 * 1000;
const alertBufferByUser = new Map();

function recordAlert(userId, alert) {
  if (!userId) return;
  const key = String(userId);
  const list = alertBufferByUser.get(key) || [];
  list.push({
    timestamp: Number(alert.timestamp) || Date.now(),
    category: alert.category || 'other',
    severity: alert.severity || 'medium',
    title: String(alert.title || '').slice(0, 120),
    summary: String(alert.summary || '').slice(0, 250),
  });
  while (list.length > ALERT_BUFFER_MAX_ITEMS) list.shift();
  const cutoff = Date.now() - ALERT_BUFFER_WINDOW_MS;
  while (list.length && list[0].timestamp < cutoff) list.shift();
  alertBufferByUser.set(key, list);
}

function listRecentAlerts(userId, { limit = 20 } = {}) {
  const list = alertBufferByUser.get(String(userId)) || [];
  const cutoff = Date.now() - ALERT_BUFFER_WINDOW_MS;
  return list.filter((a) => a.timestamp >= cutoff).slice(-limit).reverse();
}

// ------------------------------------------------------------------
// Digest buffer para eventos runtime
// ------------------------------------------------------------------
const digestBuffers = new Map(); // `${userId}:${botId}` -> { items, timer, botKey }

function _isQuietHour(prefs, now = new Date()) {
  if (!prefs?.quietHours) return false;
  const { start, end, tz } = prefs.quietHours;
  try {
    const hhmm = now.toLocaleTimeString('en-GB', {
      timeZone: tz || 'America/Mexico_City',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    if (start <= end) return hhmm >= start && hhmm < end;
    return hhmm >= start || hhmm < end;
  } catch {
    return false;
  }
}

function _shouldSuppress(prefs, category, severity, now = Date.now()) {
  if (!prefs) return null;
  if (prefs.categories && prefs.categories[category] === false) {
    return 'category_disabled';
  }
  if (severity === 'critical') return null;
  if (prefs.silencedUntil && Number(prefs.silencedUntil) > now) return 'silenced';
  if (_isQuietHour(prefs)) return 'quiet_hours';
  return null;
}

class TelegramService {
  /**
   * @param {string} token  - Bot token de Telegram
   * @param {string} chatId - Chat ID destino
   */
  constructor(token = '', chatId = '', options = {}) {
    this.token   = token;
    this.chatId  = chatId;
    this.enabled = !!(token && chatId);
    this._sendQueue = Promise.resolve();
    this._nextRequestAt = 0;
    this.userId = options.userId != null ? Number(options.userId) : null;
    this.notificationPrefs = options.notificationPrefs || null;
    this.getPrefs = typeof options.getPrefs === 'function' ? options.getPrefs : null;
  }

  /**
   * Actualiza token y chatId en tiempo de ejecución (sin reiniciar el servidor).
   */
  configure(token, chatId, options = {}) {
    this.token   = token  || '';
    this.chatId  = chatId || '';
    this.enabled = !!(this.token && this.chatId);
    if (options.userId !== undefined) {
      this.userId = options.userId != null ? Number(options.userId) : null;
    }
    if (options.notificationPrefs !== undefined) {
      this.notificationPrefs = options.notificationPrefs || null;
    }
    if (options.getPrefs !== undefined) {
      this.getPrefs = typeof options.getPrefs === 'function' ? options.getPrefs : null;
    }
  }

  setNotificationPrefs(prefs) {
    this.notificationPrefs = prefs || null;
  }

  async _resolvePrefs() {
    if (this.getPrefs && this.userId) {
      try {
        return await this.getPrefs(this.userId);
      } catch (err) {
        logger.warn('telegram_prefs_resolve_failed', { error: err.message });
      }
    }
    return this.notificationPrefs;
  }

  _firstLine(text) {
    return String(text || '').split('\n')[0].replace(/<[^>]+>/g, '').trim();
  }

  async _dispatch(meta, text, options = {}) {
    const category = meta.category || 'other';
    const severity = meta.severity || 'medium';
    const title = meta.title || this._firstLine(text);
    const summary = meta.summary || this._firstLine(text);

    recordAlert(this.userId, { category, severity, title, summary });

    const prefs = await this._resolvePrefs();
    const suppressReason = _shouldSuppress(prefs, category, severity);
    if (suppressReason) {
      (logger.debug || logger.info)?.call(logger, 'telegram.notification_suppressed', {
        userId: this.userId,
        category,
        severity,
        reason: suppressReason,
      });
      return null;
    }

    if (category === 'runtime' && prefs?.digest?.enabled && meta.botId != null) {
      return this._bufferDigest({ prefs, meta, text, options });
    }

    return this.send(text, options);
  }

  _bufferDigest({ prefs, meta, text, options }) {
    const key = `${this.userId || 0}:${meta.botId}`;
    const entry = digestBuffers.get(key) || { items: [], timer: null, botKey: meta.botKey || `Bot #${meta.botId}` };
    entry.items.push({ text, options, at: Date.now(), line: this._firstLine(text) });
    entry.botKey = meta.botKey || entry.botKey;
    digestBuffers.set(key, entry);

    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        const snap = digestBuffers.get(key);
        digestBuffers.delete(key);
        if (!snap) return;
        if (snap.items.length >= (prefs.digest.minEvents || 3)) {
          const secs = Math.round((prefs.digest.windowMs || 30_000) / 1000);
          const lines = [
            `🤖 <b>${snap.botKey}</b> — ${snap.items.length} eventos en ${secs}s`,
            ...snap.items.slice(0, 10).map((item, idx) => `${idx + 1}. ${item.line}`),
          ];
          if (snap.items.length > 10) lines.push(`... y ${snap.items.length - 10} más`);
          this.send(lines.join('\n')).catch(() => null);
        } else {
          for (const item of snap.items) {
            this.send(item.text, item.options).catch(() => null);
          }
        }
      }, prefs.digest.windowMs || 30_000);
      entry.timer.unref?.();
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Core
  // ------------------------------------------------------------------

  async _request(method, payload) {
    if (!this.enabled) return null;
    const task = async () => {
      const minIntervalMs = config.services?.telegram?.sendMinIntervalMs || 400;
      const maxAttempts = Math.max(1, Number(config.services?.telegram?.retryMaxAttempts) || 4);

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const waitMs = Math.max(0, this._nextRequestAt - Date.now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        try {
          const { data } = await httpClient.post(
            `https://api.telegram.org/bot${this.token}/${method}`,
            payload,
            { timeout: 5000 }
          );
          this._nextRequestAt = Date.now() + minIntervalMs;
          return data;
        } catch (err) {
          const retryAfterMs = extractTelegramRetryAfterMs(err);
          const retryable = isTelegramRetryableError(err);
          const lastAttempt = attempt >= maxAttempts - 1;
          if (!retryable || lastAttempt) {
            logger.error('telegram_api_error', {
              method,
              error: err.message,
              retryAfterMs: retryAfterMs || null,
              attempt: attempt + 1,
            });
            return null;
          }

          const delayMs = retryAfterMs || computeBackoffMs(attempt, {
            baseMs: minIntervalMs,
            capMs: 8_000,
            jitterMs: 250,
          });
          this._nextRequestAt = Date.now() + delayMs;
          logger.warn('telegram_api_retry_scheduled', {
            method,
            attempt: attempt + 1,
            delayMs,
            retryAfterMs: retryAfterMs || null,
            error: err.message,
          });
          await sleep(delayMs);
        }
      }

      return null;
    };

    const queuedTask = this._sendQueue.then(task, task);
    this._sendQueue = queuedTask.catch(() => null);
    return queuedTask;
  }

  /**
   * Envia un mensaje de texto con formato HTML al chat configurado.
   * No lanza excepciones — los errores se loggean y se ignoran.
   * @param {string} text - Mensaje en formato HTML
   */
  async send(text, options = {}) {
    return this.sendToChat(this.chatId, text, options);
  }

  async sendToChat(chatId, text, options = {}) {
    if (!this.enabled || !chatId) return null;

    const payload = {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || 'HTML',
      disable_web_page_preview: options.disableWebPagePreview !== false,
    };
    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }

    return this._request('sendMessage', payload);
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    if (!this.enabled || !callbackQueryId) return null;
    return this._request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: options.text || undefined,
      show_alert: options.showAlert === true,
    });
  }

  // ------------------------------------------------------------------
  // Helpers de formato
  // ------------------------------------------------------------------

  _fmtPrice(price) {
    const value = parseFloat(price);
    if (!Number.isFinite(value)) return 'N/A';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  _fmtPnl(openPrice, closePrice, size, isShort) {
    if (!openPrice || !closePrice) return null;
    const diff = (parseFloat(closePrice) - parseFloat(openPrice)) * parseFloat(size);
    const pnl  = isShort ? -diff : diff;
    return this._fmtPnlValue(pnl);
  }

  _fmtPnlValue(pnl) {
    const value = parseFloat(pnl);
    if (!Number.isFinite(value)) return null;
    const sign = value >= 0 ? '+' : '';
    return `${sign}$${value.toFixed(2)}`;
  }

  _resolveTradePnl({ pnl, openPrice, closePrice, size, isShort }) {
    if (pnl != null) return this._fmtPnlValue(pnl);
    return this._fmtPnl(openPrice, closePrice, size, isShort);
  }

  _fmtAccount(account) {
    if (!account) return null;
    const alias = account.alias || account.label || account.shortAddress || account.address;
    const wallet = account.shortAddress
      || (account.address ? `${account.address.slice(0, 6)}...${account.address.slice(-4)}` : '');
    return wallet && alias !== wallet
      ? `Cuenta: <b>${alias}</b> (${wallet})`
      : `Cuenta: <b>${alias}</b>`;
  }

  // ------------------------------------------------------------------
  // Coberturas automaticas (hedge events)
  // ------------------------------------------------------------------

  notifyHedgeCreated(hedge) {
    const side = (hedge.direction || 'short').toUpperCase();
    const entryRule = side === 'LONG' ? 'Entrada si precio ≥' : 'Entrada si precio ≤';
    const exitRule = side === 'LONG' ? 'SL si precio ≤' : 'SL si precio ≥';
    const lines = [
      `🟡 <b>Cobertura creada</b>`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b> | ${side} | ${hedge.leverage}x`,
      `${entryRule} $${this._fmtPrice(hedge.entryPrice)}`,
      `${exitRule} $${this._fmtPrice(hedge.exitPrice)}`,
      `Tamaño: ${hedge.size} ${hedge.asset}`,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this._dispatch(
      { category: 'hedge', severity: 'medium', title: 'Cobertura creada' },
      lines.filter(Boolean).join('\n'),
    );
  }

  notifyHedgeOpened(hedge) {
    const side = (hedge.direction || 'short').toUpperCase();
    const emoji = side === 'LONG' ? '🟢' : '🔴';
    const notional = (parseFloat(hedge.size) * parseFloat(hedge.openPrice)).toFixed(2);
    const lines = [
      `${emoji} <b>${side} activado</b>`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b> | ${hedge.leverage}x isolated`,
      `Precio entrada: $${this._fmtPrice(hedge.openPrice)}`,
      `Tamaño: ${hedge.size} ${hedge.asset} (~$${notional})`,
      hedge.label ? `Cobertura: ${hedge.label}` : null,
    ];
    return this._dispatch(
      { category: 'hedge', severity: 'high', title: `${side} activado` },
      lines.filter(Boolean).join('\n'),
    );
  }

  notifyHedgePartialCoverage(hedge, payload = {}) {
    const lines = [
      `🟠 <b>Cobertura parcial</b> #${hedge.id}`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b> | Estado: ${hedge.status}`,
      `Esperado: ${payload.expectedSize} ${hedge.asset}`,
      `Abierto: ${payload.actualSize} ${hedge.asset}`,
      `Faltante: ${payload.missingSize} ${hedge.asset}`,
      payload.message ? `Detalle: ${payload.message}` : null,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this._dispatch(
      { category: 'hedge', severity: 'high', title: 'Cobertura parcial' },
      lines.filter(Boolean).join('\n'),
    );
  }

  notifyHedgeClosed(hedge) {
    const isShort = (hedge.direction || 'short') !== 'long';
    const pnl = this._resolveTradePnl({
      pnl: hedge.netPnl ?? hedge.closedPnl,
      openPrice: hedge.openPrice,
      closePrice: hedge.closePrice,
      size: hedge.size,
      isShort,
    });
    const lines = [
      `✅ <b>Cobertura completada</b>`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b>`,
      `Apertura: $${this._fmtPrice(hedge.openPrice)}`,
      `Cierre:   $${this._fmtPrice(hedge.closePrice)}`,
      pnl ? `PnL: ${pnl}` : null,
      hedge.label ? `Cobertura: ${hedge.label}` : null,
    ];
    return this._dispatch(
      { category: 'hedge', severity: 'high', title: 'Cobertura completada' },
      lines.filter(Boolean).join('\n'),
    );
  }

  notifyHedgeCancelled(hedge) {
    const lines = [
      `🚫 <b>Cobertura cancelada</b> #${hedge.id}`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b>`,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this._dispatch(
      { category: 'hedge', severity: 'medium', title: 'Cobertura cancelada' },
      lines.filter(Boolean).join('\n'),
    );
  }

  notifyHedgeError(hedge, err) {
    const lines = [
      `❌ <b>Error en cobertura</b> #${hedge.id}`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b> | Estado: ${hedge.status}`,
      `Error: ${err.message}`,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this._dispatch(
      { category: 'hedge', severity: 'critical', title: 'Error en cobertura' },
      lines.filter(Boolean).join('\n'),
    );
  }

  // ------------------------------------------------------------------
  // Trading manual
  // ------------------------------------------------------------------

  notifyTradeOpen({ account, asset, side, size, leverage, marginMode, orderPrice, fillPrice }) {
    const emoji   = side === 'long' ? '📈' : '📉';
    const displayPrice = fillPrice ?? parseFloat(orderPrice);
    const notional = (parseFloat(size) * displayPrice).toFixed(2);
    const lines = [
      `${emoji} <b>Posicion abierta</b>`,
      this._fmtAccount(account),
      `Activo: <b>${asset}</b> | ${side.toUpperCase()} | ${leverage}x | ${marginMode}`,
      `Precio: $${this._fmtPrice(displayPrice)}`,
      `Tamano: ${size} ${asset} (~$${notional})`,
    ];
    return this._dispatch(
      { category: 'trade', severity: 'critical', title: 'Posicion abierta' },
      lines.join('\n'),
    );
  }

  notifyTradeClose({ account, asset, closedSide, closedSize, closePrice, openPrice, pnl }) {
    const emoji = closedSide === 'long' ? '📉' : '📈';
    const formattedPnl = this._resolveTradePnl({
      pnl,
      openPrice,
      closePrice,
      size: closedSize,
      isShort: closedSide !== 'long',
    });
    const lines = [
      `${emoji} <b>Posicion cerrada</b>`,
      this._fmtAccount(account),
      `Activo: <b>${asset}</b> | ${closedSide.toUpperCase()}`,
      openPrice != null ? `Precio entrada: $${this._fmtPrice(openPrice)}` : null,
      `Precio cierre: $${this._fmtPrice(closePrice)}`,
      `Tamano: ${closedSize} ${asset}`,
      formattedPnl ? `PnL: ${formattedPnl}` : null,
    ];
    return this._dispatch(
      { category: 'trade', severity: 'critical', title: 'Posicion cerrada' },
      lines.filter(Boolean).join('\n'),
    );
  }

  notifyBotRuntimeEvent(event, bot, payload = {}) {
    const labels = {
      runtime_warning: { emoji: '⚠️', title: 'Bot con incidente' },
      runtime_retry_scheduled: { emoji: '🔁', title: 'Bot reintentando' },
      runtime_fallback_applied: { emoji: '🛟', title: 'Fallback aplicado' },
      runtime_recovered: { emoji: '✅', title: 'Bot recuperado' },
      runtime_paused: { emoji: '⛔', title: 'Bot pausado por seguridad' },
    };
    const meta = labels[event] || { emoji: 'ℹ️', title: 'Bot runtime' };
    const when = new Date(payload.timestamp || Date.now()).toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const lines = [
      `${meta.emoji} <b>${meta.title}</b>`,
      bot?.account ? this._fmtAccount(bot.account) : null,
      `Bot: <b>#${bot?.id || '?'}</b> | ${bot?.asset || 'N/A'} | estado ${bot?.status || 'N/A'}`,
      payload.stage ? `Etapa: ${payload.stage}` : null,
      payload.message ? `Error: ${payload.message}` : null,
      payload.actionTaken ? `Medida: ${payload.actionTaken}` : null,
      payload.nextRetryAt ? `Proximo reintento: ${new Date(payload.nextRetryAt).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}` : null,
      `Fecha: ${when}`,
    ];
    const severity = event === 'runtime_paused' ? 'critical'
      : event === 'runtime_recovered' ? 'medium'
      : 'medium';
    const botKey = bot?.id ? `Bot #${bot.id}${bot.asset ? ` (${bot.asset})` : ''}` : 'Bot';
    return this._dispatch(
      {
        category: 'runtime',
        severity,
        title: meta.title,
        botId: bot?.id || null,
        botKey,
      },
      lines.filter(Boolean).join('\n'),
    );
  }
  // ------------------------------------------------------------------
  // Bloqueos de proteccion delta-neutral
  // ------------------------------------------------------------------

  notifyDeltaNeutralBlock({ protection, blockType, reason, detail, extra = {} }) {
    const labels = {
      insufficient_margin:       { emoji: '💸', title: 'Margen insuficiente' },
      spread_too_wide:           { emoji: '📊', title: 'Spread demasiado amplio' },
      execution_fee_too_high:    { emoji: '🏷️', title: 'Costo de ejecucion muy alto' },
      snapshot_invalid:          { emoji: '📸', title: 'Snapshot no disponible' },
      cooldown_active:           { emoji: '⏳', title: 'Cooldown activo' },
      risk_paused_margin_mode:   { emoji: '🛑', title: 'Proteccion pausada — modo margen' },
      risk_paused_manual_long:   { emoji: '🛑', title: 'Proteccion pausada — posicion manual' },
      risk_paused_liq_distance:  { emoji: '🛑', title: 'Proteccion pausada — liquidacion cercana' },
      margin_pending_topup:      { emoji: '⚠️', title: 'Top-up de margen fallido' },
      rate_limited:              { emoji: '🚦', title: 'Rate limit de Hyperliquid' },
      margin_pending_execution:  { emoji: '💸', title: 'Margen insuficiente en ejecucion' },
      spot_stale:                { emoji: '📡', title: 'Precio spot obsoleto' },
      below_min_order_notional:  { emoji: '📏', title: 'Orden por debajo del minimo del exchange' },
    };
    const meta = labels[blockType] || { emoji: '⚠️', title: 'Bloqueo delta-neutral' };
    const pair = `${protection.token0Symbol || '?'}/${protection.token1Symbol || '?'}`;
    const when = new Date().toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

    const lines = [
      `${meta.emoji} <b>${meta.title}</b>`,
      `Proteccion: <b>#${protection.id}</b> | ${pair}`,
      `Activo: <b>${protection.inferredAsset || 'N/A'}</b>`,
      reason ? `Motivo: ${reason}` : null,
      detail ? `Detalle: ${detail}` : null,
      extra.positionObserved != null ? `Posicion detectada: ${extra.positionObserved ? 'si' : 'no'}` : null,
      extra.positionReadSource ? `Lectura posicion: ${extra.positionReadSource}` : null,
      extra.actualQty != null ? `Actual qty: ${Number(extra.actualQty).toFixed(6)}` : null,
      extra.targetQty != null ? `Target qty: ${Number(extra.targetQty).toFixed(6)}` : null,
      extra.withdrawable != null ? `Disponible: $${this._fmtPrice(extra.withdrawable)}` : null,
      extra.requiredMargin != null ? `Requerido: $${this._fmtPrice(extra.requiredMargin)}` : null,
      extra.spreadBps != null ? `Spread: ${Number(extra.spreadBps).toFixed(1)} bps` : null,
      extra.maxSpreadBps != null ? `Limite spread: ${Number(extra.maxSpreadBps).toFixed(1)} bps` : null,
      extra.estimatedCost != null ? `Costo estimado: $${this._fmtPrice(extra.estimatedCost)}` : null,
      extra.maxCost != null ? `Limite costo: $${this._fmtPrice(extra.maxCost)}` : null,
      extra.liquidationDistancePct != null ? `Distancia a liquidacion: ${Number(extra.liquidationDistancePct).toFixed(1)}%` : null,
      extra.cooldownReason ? `Cooldown por: ${extra.cooldownReason}` : null,
      extra.driftUsd != null ? `Drift: $${Number(extra.driftUsd).toFixed(2)}` : null,
      extra.minNotionalUsd != null ? `Minimo requerido: $${Number(extra.minNotionalUsd).toFixed(2)}` : null,
      `Fecha: ${when}`,
    ];
    const criticalBlockTypes = new Set(['risk_paused_margin_mode', 'risk_paused_manual_long', 'risk_paused_liq_distance', 'margin_pending_topup']);
    const severity = criticalBlockTypes.has(blockType) ? 'critical'
      : blockType === 'insufficient_margin' ? 'high'
      : 'medium';
    return this._dispatch(
      { category: 'deltaNeutralBlock', severity, title: meta.title },
      lines.filter(Boolean).join('\n'),
    );
  }
}

TelegramService.recordAlert = recordAlert;
TelegramService.listRecentAlerts = listRecentAlerts;

module.exports = TelegramService;
