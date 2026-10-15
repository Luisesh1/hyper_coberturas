/**
 * Liquidaciones REALES con evidencia Binance exerciseRecord + bill.
 * Estado y eventos se escriben en una sola transacción; recordId es único.
 */
const defaultDb = require('../db');
const { parseSymbol, grossPnl, signedPremium, oppositeSide } = require('../services/options/options-utils');

const EPS = 1e-8;
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= EPS;

function createOptionsLiveExercisesRepository({ db = defaultDb, now = Date.now } = {}) {
  async function listExpiredGroups(at = now()) {
    const { rows } = await db.query(
      "SELECT user_id, symbol, side, SUM(quantity) AS quantity FROM options_strategy_positions " +
      "WHERE mode='live' AND closed_at IS NULL GROUP BY user_id, symbol, side"
    );
    return rows.filter((r) => {
      const meta = parseSymbol(r.symbol);
      return meta && meta.expiryMs <= at;
    }).map((r) => ({
      userId: Number(r.user_id), symbol: r.symbol, side: r.side,
      quantity: Number(r.quantity),
      expiryMs: parseSymbol(r.symbol).expiryMs,
    }));
  }

  async function applyExercise(proof) {
    const { userId, symbol, side, recordId, quantity, payoffUsdt, feeUsdt, exercisedAt } = proof;
    if (!Number.isSafeInteger(userId) || !['BUY','SELL'].includes(side) ||
        !parseSymbol(symbol) || !/^[0-9]+$/.test(String(recordId)) ||
        !(Number.isFinite(quantity) && quantity > 0) ||
        !(Number.isFinite(payoffUsdt) && payoffUsdt >= 0) ||
        !(Number.isFinite(feeUsdt) && feeUsdt >= 0) ||
        !Number.isFinite(exercisedAt)) throw new Error('Invalid confirmed exercise proof');
    return db.transaction(async (tx) => {
      // Mismo lock por usuario que la apertura y la conciliación de fills.
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [userId]);
      const { rows: existing } = await tx.query(
        'SELECT * FROM options_live_exercises WHERE user_id=$1 AND exercise_record_id=$2 FOR UPDATE',
        [userId, String(recordId)]
      );
      if (existing.length) {
        const p = existing[0];
        if (p.symbol !== symbol || p.position_side !== (side === 'BUY' ? 'LONG' : 'SHORT') ||
            !near(p.quantity, quantity) || !near(p.payoff_usdt, payoffUsdt) ||
            !near(p.fee_usdt, feeUsdt)) {
          throw new Error('Previously reconciled exercise record differs from Binance');
        }
        return false;
      }
      const { rows: positions } = await tx.query(
        "SELECT * FROM options_strategy_positions WHERE user_id=$1 AND mode='live' " +
        "AND symbol=$2 AND side=$3 AND closed_at IS NULL ORDER BY id FOR UPDATE",
        [userId, symbol, side]
      );
      const held = positions.reduce((sum, p) => sum + Number(p.quantity), 0);
      if (!positions.length || !near(held, quantity)) {
        throw new Error('Exercise quantity does not match open local positions');
      }
      const perUnit = payoffUsdt / quantity;
      const recordFee = feeUsdt;
      if (!Number.isFinite(perUnit) || perUnit < 0) throw new Error('Invalid payoff price');
      await tx.query(
        "INSERT INTO options_live_exercises (user_id,exercise_record_id,symbol,position_side," +
        "quantity,payoff_usdt,fee_usdt,exercised_at,reconciled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [userId, String(recordId), symbol, side === 'BUY' ? 'LONG' : 'SHORT',
          quantity, payoffUsdt, recordFee, exercisedAt, now()]
      );
      for (const p of positions) {
        const qty = Number(p.quantity);
        const allocatedFee = recordFee * qty / quantity;
        const fees = Number(p.fees_usdt || 0) + allocatedFee;
        const pnl = grossPnl({
          side, entryPrice: Number(p.entry_price), exitPrice: perUnit, quantity: qty,
        }) - fees;
        const { rowCount } = await tx.query(
          'UPDATE options_strategy_positions SET exit_price=$2,closed_at=$3,pnl_usdt=$4,fees_usdt=$5 ' +
          'WHERE id=$1 AND closed_at IS NULL',
          [p.id, perUnit, exercisedAt, pnl, fees]
        );
        if (rowCount !== 1) throw new Error('Position changed during exercise reconciliation');
        await tx.query(
          "INSERT INTO options_strategy_events " +
          "(strategy_id,user_id,mode,action,detail,legs,premium_usdt,created_at) " +
          "VALUES ($1,$2,'live','close',$3,$4,$5,$6)",
          [p.strategy_id, userId,
            'Vencimiento confirmado por Binance; ejercicio ' + String(recordId),
            JSON.stringify([{
              symbol, side: oppositeSide(side), quantity: qty,
              price: perUnit, fee: allocatedFee, exerciseRecordId: String(recordId),
            }]),
            signedPremium(oppositeSide(side), perUnit, qty), exercisedAt]
        );
      }
      return true;
    });
  }

  return { listExpiredGroups, applyExercise };
}

module.exports = createOptionsLiveExercisesRepository();
module.exports.createOptionsLiveExercisesRepository = createOptionsLiveExercisesRepository;
