/**
 * notifier.js
 *
 * Emisor de alertas del orquestador. Envía mensajes a Telegram (por usuario)
 * y registra eventos de notificación en el action_log.
 *
 * Mantiene la promesa de "repetir cada N min hasta resolución" delegando
 * en el servicio principal la decisión de cuándo invocar `urgentOutOfRange`
 * (primera vez) vs `repeatUrgentOutOfRange` (recordatorio).
 */

const telegramRegistry = require('../telegram.registry');
const logger = require('../logger.service');

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

class LpOrchestratorNotifier {
  constructor(deps = {}) {
    this.telegramRegistry = deps.telegramRegistry || telegramRegistry;
    this.logger = deps.logger || logger;
  }

  async _sendTelegram(userId, text) {
    try {
      const tg = await this.telegramRegistry.getOrCreate(userId);
      if (tg && tg.enabled) {
        await tg.send(text);
      }
    } catch (err) {
      this.logger.warn('lp_orchestrator_telegram_send_failed', {
        userId,
        error: err.message,
      });
    }
  }

  _header(orchestrator) {
    const pair = `${orchestrator.token0Symbol}/${orchestrator.token1Symbol}`;
    return `<b>🎛 ${escapeHtml(orchestrator.name)}</b>\n${pair} · ${orchestrator.network}/${orchestrator.version}`;
  }

  async urgentOutOfRange(orchestrator, evaluation, { repeat = false } = {}) {
    const head = this._header(orchestrator);
    const side = evaluation?.outOfRangeSide === 'below' ? '⬇ por debajo' : '⬆ por encima';
    const intro = repeat
      ? '🔁 <b>RECORDATORIO — Precio fuera de rango</b>'
      : '🚨 <b>Precio fuera de rango — ajustar AHORA</b>';
    const body = [
      head,
      '',
      intro,
      `Precio ${side} del rango.`,
      `Precio actual: ${evaluation?.priceCurrent ?? 'N/A'}`,
      `Rango: [${orchestrator.lastEvaluation?.poolSnapshot?.rangeLowerPrice ?? '?'} — ${orchestrator.lastEvaluation?.poolSnapshot?.rangeUpperPrice ?? '?'}]`,
    ].join('\n');
    await this._sendTelegram(orchestrator.userId, body);
  }

  async recommendRebalance(orchestrator, { evaluation, costEstimate, netEarnings } = {}) {
    const head = this._header(orchestrator);
    const lines = [
      head,
      '',
      '⚠️ <b>Rebalanceo recomendado</b>',
      `Precio cerca del borde (${evaluation?.nearEdgeSide || '?'})`,
      `Costo estimado: ${fmtUsd(costEstimate?.totalCostUsd)}`,
      `Ganancias netas LP: ${fmtUsd(netEarnings)}`,
      `Ratio coste/recompensa: ${costEstimate?.totalCostUsd && netEarnings
        ? (costEstimate.totalCostUsd / netEarnings).toFixed(2)
        : 'N/A'}`,
    ];
    await this._sendTelegram(orchestrator.userId, lines.join('\n'));
  }

  async recommendCollectFees(orchestrator, { feesUsd } = {}) {
    const head = this._header(orchestrator);
    const lines = [
      head,
      '',
      '💰 <b>Fees acumuladas listas para cobrar</b>',
      `Fees no cobradas: ${fmtUsd(feesUsd)}`,
    ];
    await this._sendTelegram(orchestrator.userId, lines.join('\n'));
  }

  async actionFinalized(orchestrator, { action, drifts = [] } = {}) {
    const head = this._header(orchestrator);
    const status = drifts.length === 0 ? '✅ verificada' : '⚠️ con drift';
    const lines = [
      head,
      '',
      `${status} <b>${action}</b>`,
    ];
    if (drifts.length) {
      lines.push('Drifts detectados:');
      for (const d of drifts) {
        lines.push(`  • ${d.field || '?'}: ${d.kind || '?'}`);
      }
    }
    await this._sendTelegram(orchestrator.userId, lines.join('\n'));
  }

  async verificationFailed(orchestrator, { drifts = [], action } = {}) {
    const head = this._header(orchestrator);
    const lines = [
      head,
      '',
      `❌ <b>Verificación fallida</b> tras ${action || 'acción'}`,
    ];
    for (const d of drifts) {
      lines.push(`  • ${d.field || '?'} → ${d.kind || '?'}`);
    }
    lines.push('Estado: <b>failed</b>. Requiere revisión humana.');
    await this._sendTelegram(orchestrator.userId, lines.join('\n'));
  }

  async lpKilled(orchestrator) {
    const head = this._header(orchestrator);
    const lines = [
      head,
      '',
      '🔪 <b>LP cerrado</b>',
      'El orquestador queda en idle, listo para crear un LP nuevo o ser archivado.',
    ];
    await this._sendTelegram(orchestrator.userId, lines.join('\n'));
  }

  async positionMissing(orchestrator) {
    const head = this._header(orchestrator);
    const lines = [
      head,
      '',
      '❗ <b>Posición no encontrada en el escaneo</b>',
      'El LP pudo haber sido cerrado externamente. Estado: <b>failed</b>.',
    ];
    await this._sendTelegram(orchestrator.userId, lines.join('\n'));
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = LpOrchestratorNotifier;
module.exports.default = LpOrchestratorNotifier;
