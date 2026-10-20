/**
 * Conciliación de vencimientos reales de Binance Options.
 *
 * Nunca se utiliza spot/mark ni un precio supuesto: exige prueba de ejercicio
 * + movimientos de cuenta + desaparición de la posición en Binance.
 * Si hay datos ambiguos, conserva la posición y exige revisión manual.
 */
const defaultRepo = require('../../repositories/options-live-exercises.repository');
const ordersDefault = require('../../repositories/options-live-orders.repository');
const credentialsDefault = require('./options-credentials.service');
const loggerDefault = require('../logger.service');

const EPS = 1e-8;
const MAX_LOOKBACK_MS = 89 * 24 * 60 * 60_000;
const MAX_GROUPS = 25;
const finite = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const close = (a,b) => Math.abs(a - b) <= EPS;
const signedSide = (side) => side === 'BUY' ? 'LONG' : 'SHORT';

function validateProof(group, records, bills, positions, openOrders, at) {
  if (!Array.isArray(records) || records.length >= 1000 ||
      !Array.isArray(bills) || bills.length >= 1000 ||
      !Array.isArray(positions) || !Array.isArray(openOrders)) {
    throw new Error('Exercise evidence missing, truncated, or invalid');
  }
  if (openOrders.some((o) => o.symbol === group.symbol)) {
    throw new Error('Pending Binance orders at expiry; manual reconciliation required');
  }
  if (positions.some((p) => p.symbol === group.symbol && Number(p.quantity) !== 0)) {
    throw new Error('Expired contract still has live exposure in Binance');
  }
  const matches = records.filter((r) => r.symbol === group.symbol &&
    r.positionSide === signedSide(group.side));
  if (matches.length !== 1) throw new Error('Expected exactly one matching Binance exercise record');
  const record = matches[0];
  const amount = Number(record.amount);
  const fee = Number(record.fee);
  const quantity = Number(record.quantity);
  const exercisedAt = Number(record.createDate);
  if (!/^[0-9]+$/.test(String(record.id)) ||
      record.currency !== 'USDT' || record.quoteAsset !== 'USDT' ||
      !finite(record.quantity) || !finite(record.amount) || !finite(record.fee) ||
      !finite(record.createDate) || !close(quantity, group.quantity) ||
      fee < -EPS || quantity <= 0 ||
      (group.side === 'BUY' && amount < -EPS) ||
      (group.side === 'SELL' && amount > EPS) ||
      exercisedAt < group.expiryMs - 5 * 60_000 || exercisedAt > at) {
    throw new Error('Binance exercise record inconsistent with local position');
  }
  // Verificar contra el movimiento monetario real; los registros de bill
  // anteriores sin symbol no se asignan por aproximación de tiempo.
  const around = bills.filter((b) => Number(b.createDate) >= exercisedAt - 60_000 &&
    Number(b.createDate) <= exercisedAt + 60_000);
  if (around.some((b) => ['EXERCISE_PNL','EXERCISE_FEE'].includes(b.type) && !b.symbol)) {
    throw new Error('Unattributable Binance exercise bill: manual reconciliation required');
  }
  const exerciseBills = around.filter((b) =>
    b.symbol === group.symbol && ['EXERCISE_PNL','EXERCISE_FEE'].includes(b.type));
  if (exerciseBills.some((b) => b.asset !== 'USDT' || !finite(b.amount))) {
    throw new Error('Invalid Binance exercise bill');
  }
  const pnlBill = exerciseBills.filter((b) => b.type === 'EXERCISE_PNL')
    .reduce((sum, b) => sum + Number(b.amount), 0);
  const feeBill = exerciseBills.filter((b) => b.type === 'EXERCISE_FEE')
    .reduce((sum, b) => sum + Number(b.amount), 0);
  if (!close(pnlBill, amount) || !close(feeBill, -fee)) {
    throw new Error('Binance exercise amounts or fees disagree with funding bill');
  }
  return {
    userId: group.userId, symbol: group.symbol, side: group.side,
    recordId: String(record.id), quantity, payoffUsdt: Math.abs(amount),
    feeUsdt: fee, exercisedAt,
  };
}

class OptionsLiveSettlement {
  constructor(deps = {}) {
    this.repo = deps.repo || defaultRepo;
    this.orders = deps.orders || ordersDefault;
    this.credentials = deps.credentials || credentialsDefault;
    this.logger = deps.logger || loggerDefault;
    this.now = deps.now || Date.now;
    this.notify = deps.notify || (async (userId, message) => {
      const registry = require('../telegram.registry');
      const tg = await registry.getOrCreate(userId);
      if (typeof tg?.send !== 'function') throw new Error('Telegram unavailable');
      await tg.send(message);
    });
  }

  async reconcileExpired() {
    const at = this.now();
    const groups = await this.repo.listExpiredGroups(at);
    // Cualquier orden todavía sin conciliar puede llenar mientras se
    // revisa el vencimiento; nunca liquidar en esas condiciones.
    const unresolved = await this.orders.listUnresolved();
    let settled = 0;
    let blocked = 0;
    for (const group of groups.slice(0, MAX_GROUPS)) {
      try {
        if (!Number.isFinite(group.quantity) || group.quantity <= 0 ||
            group.expiryMs > at || at - group.expiryMs > MAX_LOOKBACK_MS) {
          throw new Error('Expired position outside reliable Binance history window');
        }
        if (unresolved.some((o) => o.userId === group.userId)) {
          throw new Error('User has unresolved orders; reconcile fills before exercise');
        }
        const client = await this.credentials.getClientForUser(group.userId);
        if (!['getExerciseRecords','getBills','getPositions','getOpenOrders'].every(
          (name) => typeof client[name] === 'function')) {
          throw new Error('Missing exchange settlement evidence endpoints');
        }
        const startTime = group.expiryMs - 60 * 60_000;
        const [records, bills, positions, openOrders] = await Promise.all([
          client.getExerciseRecords({ symbol: group.symbol, startTime, endTime: at, limit: 1000 }),
          client.getBills({ currency: 'USDT', startTime, endTime: at, limit: 1000 }),
          client.getPositions(group.symbol),
          client.getOpenOrders(group.symbol),
        ]);
        const proof = validateProof(group, records, bills, positions, openOrders, at);
        if (await this.repo.applyExercise(proof)) {
          settled++;
          this.logger.info('options_live_exercise_confirmed', {
            userId: group.userId, symbol: group.symbol, recordId: proof.recordId,
          });
        }
      } catch (err) {
        blocked++;
        this.logger.warn('options_live_exercise_attention', {
          userId: group.userId, symbol: group.symbol, error: err.message,
        });
        // Un vencimiento sin conciliación implica PnL/riesgo desconocidos.
        // Aviso persistente a lo sumo cada 15 min entre réplicas.
        try {
          if (typeof this.orders.claimIncidentNotification === 'function' &&
              await this.orders.claimIncidentNotification(group.userId, 'EXERCISE_ATTENTION', group.symbol)) {
            const symbol = String(group.symbol).replace(/&/g, '&amp;').replace(/</g, '&lt;');
            await this.notify(group.userId,
              '<b>Binance Opciones · Vencimiento pendiente</b>\n' +
              symbol + '\nNo existe evidencia suficiente de liquidación. Revisar Binance y el libro.');
          }
        } catch (notifyErr) {
          this.logger.warn('options_live_exercise_notify_failed', {
            userId: group.userId, error: notifyErr.message,
          });
        }
      }
    }
    return { checked: Math.min(groups.length, MAX_GROUPS), settled,
      blocked, deferred: Math.max(0, groups.length - MAX_GROUPS) };
  }
}

module.exports = new OptionsLiveSettlement();
module.exports.OptionsLiveSettlement = OptionsLiveSettlement;
module.exports.validateProof = validateProof;
