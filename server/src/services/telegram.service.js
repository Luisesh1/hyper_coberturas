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

const axios = require('axios');

class TelegramService {
  /**
   * @param {string} token  - Bot token de Telegram
   * @param {string} chatId - Chat ID destino
   */
  constructor(token = '', chatId = '') {
    this.token   = token;
    this.chatId  = chatId;
    this.enabled = !!(token && chatId);
  }

  /**
   * Actualiza token y chatId en tiempo de ejecución (sin reiniciar el servidor).
   */
  configure(token, chatId) {
    this.token   = token  || '';
    this.chatId  = chatId || '';
    this.enabled = !!(this.token && this.chatId);
  }

  // ------------------------------------------------------------------
  // Core
  // ------------------------------------------------------------------

  /**
   * Envia un mensaje de texto con formato HTML al chat configurado.
   * No lanza excepciones — los errores se loggean y se ignoran.
   * @param {string} text - Mensaje en formato HTML
   */
  async send(text) {
    if (!this.enabled) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        { chat_id: this.chatId, text, parse_mode: 'HTML' },
        { timeout: 5000 }
      );
    } catch (err) {
      console.error('[Telegram] Error al enviar notificacion:', err.message);
    }
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
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}$${pnl.toFixed(2)}`;
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
    return this.send(lines.filter(Boolean).join('\n'));
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
    return this.send(lines.filter(Boolean).join('\n'));
  }

  notifyHedgeClosed(hedge) {
    const isShort = (hedge.direction || 'short') !== 'long';
    const pnl = this._fmtPnl(hedge.openPrice, hedge.closePrice, hedge.size, isShort);
    const lines = [
      `✅ <b>Cobertura completada</b>`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b>`,
      `Apertura: $${this._fmtPrice(hedge.openPrice)}`,
      `Cierre:   $${this._fmtPrice(hedge.closePrice)}`,
      pnl ? `PnL estimado: ${pnl}` : null,
      hedge.label ? `Cobertura: ${hedge.label}` : null,
    ];
    return this.send(lines.filter(Boolean).join('\n'));
  }

  notifyHedgeCancelled(hedge) {
    const lines = [
      `🚫 <b>Cobertura cancelada</b> #${hedge.id}`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b>`,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this.send(lines.filter(Boolean).join('\n'));
  }

  notifyHedgeError(hedge, err) {
    const lines = [
      `❌ <b>Error en cobertura</b> #${hedge.id}`,
      this._fmtAccount(hedge.account),
      `Activo: <b>${hedge.asset}</b> | Estado: ${hedge.status}`,
      `Error: ${err.message}`,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this.send(lines.filter(Boolean).join('\n'));
  }

  // ------------------------------------------------------------------
  // Trading manual
  // ------------------------------------------------------------------

  notifyTradeOpen({ account, asset, side, size, leverage, marginMode, orderPrice }) {
    const emoji   = side === 'long' ? '📈' : '📉';
    const notional = (parseFloat(size) * parseFloat(orderPrice)).toFixed(2);
    const lines = [
      `${emoji} <b>Posicion abierta</b>`,
      this._fmtAccount(account),
      `Activo: <b>${asset}</b> | ${side.toUpperCase()} | ${leverage}x | ${marginMode}`,
      `Precio: $${this._fmtPrice(orderPrice)}`,
      `Tamano: ${size} ${asset} (~$${notional})`,
    ];
    return this.send(lines.join('\n'));
  }

  notifyTradeClose({ account, asset, closedSide, closedSize, closePrice }) {
    const emoji = closedSide === 'long' ? '📉' : '📈';
    const lines = [
      `${emoji} <b>Posicion cerrada</b>`,
      this._fmtAccount(account),
      `Activo: <b>${asset}</b> | ${closedSide.toUpperCase()}`,
      `Precio cierre: $${this._fmtPrice(closePrice)}`,
      `Tamano: ${closedSize} ${asset}`,
    ];
    return this.send(lines.join('\n'));
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
    return this.send(lines.filter(Boolean).join('\n'));
  }
}

module.exports = TelegramService;
