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
  constructor() {
    this.token   = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId  = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.token && this.chatId);

    if (this.enabled) {
      console.log('[Telegram] Notificaciones activadas.');
    } else {
      console.warn('[Telegram] No configurado. Agrega TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en .env para habilitar notificaciones.');
    }
  }

  // ------------------------------------------------------------------
  // Configuración en caliente
  // ------------------------------------------------------------------

  /**
   * Actualiza token y chatId en tiempo de ejecución (sin reiniciar el servidor).
   */
  configure(token, chatId) {
    this.token   = token  || '';
    this.chatId  = chatId || '';
    this.enabled = !!(this.token && this.chatId);
    console.log(`[Telegram] Reconfigurado. ${this.enabled ? 'Activo.' : 'Inactivo.'}`);
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
    return parseFloat(price).toLocaleString('en-US', {
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

  // ------------------------------------------------------------------
  // Coberturas automaticas (hedge events)
  // ------------------------------------------------------------------

  notifyHedgeCreated(hedge) {
    const lines = [
      `🟡 <b>Cobertura creada</b>`,
      `Activo: <b>${hedge.asset}</b> | SHORT | ${hedge.leverage}x`,
      `Entrada si precio ≤ $${this._fmtPrice(hedge.entryPrice)}`,
      `Salida si precio ≥ $${this._fmtPrice(hedge.exitPrice)}`,
      `Tamaño: ${hedge.size} ${hedge.asset}`,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this.send(lines.filter(Boolean).join('\n'));
  }

  notifyHedgeOpened(hedge) {
    const notional = (parseFloat(hedge.size) * parseFloat(hedge.openPrice)).toFixed(2);
    const lines = [
      `🔴 <b>SHORT activado</b>`,
      `Activo: <b>${hedge.asset}</b> | ${hedge.leverage}x isolated`,
      `Precio entrada: $${this._fmtPrice(hedge.openPrice)}`,
      `Tamaño: ${hedge.size} ${hedge.asset} (~$${notional})`,
      hedge.label ? `Cobertura: ${hedge.label}` : null,
    ];
    return this.send(lines.filter(Boolean).join('\n'));
  }

  notifyHedgeClosed(hedge) {
    const pnl = this._fmtPnl(hedge.openPrice, hedge.closePrice, hedge.size, true);
    const lines = [
      `✅ <b>Cobertura completada</b>`,
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
      `Activo: <b>${hedge.asset}</b>`,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this.send(lines.filter(Boolean).join('\n'));
  }

  notifyHedgeError(hedge, err) {
    const lines = [
      `❌ <b>Error en cobertura</b> #${hedge.id}`,
      `Activo: <b>${hedge.asset}</b> | Estado: ${hedge.status}`,
      `Error: ${err.message}`,
      hedge.label ? `Etiqueta: ${hedge.label}` : null,
    ];
    return this.send(lines.filter(Boolean).join('\n'));
  }

  // ------------------------------------------------------------------
  // Trading manual
  // ------------------------------------------------------------------

  notifyTradeOpen({ asset, side, size, leverage, marginMode, orderPrice }) {
    const emoji   = side === 'long' ? '📈' : '📉';
    const notional = (parseFloat(size) * parseFloat(orderPrice)).toFixed(2);
    const lines = [
      `${emoji} <b>Posicion abierta</b>`,
      `Activo: <b>${asset}</b> | ${side.toUpperCase()} | ${leverage}x | ${marginMode}`,
      `Precio: $${this._fmtPrice(orderPrice)}`,
      `Tamano: ${size} ${asset} (~$${notional})`,
    ];
    return this.send(lines.join('\n'));
  }

  notifyTradeClose({ asset, closedSide, closedSize, closePrice }) {
    const emoji = closedSide === 'long' ? '📉' : '📈';
    const lines = [
      `${emoji} <b>Posicion cerrada</b>`,
      `Activo: <b>${asset}</b> | ${closedSide.toUpperCase()}`,
      `Precio cierre: $${this._fmtPrice(closePrice)}`,
      `Tamano: ${closedSize} ${asset}`,
    ];
    return this.send(lines.join('\n'));
  }
}

module.exports = new TelegramService();
