/**
 * Contrato READ-ONLY de Binance Opciones para certificar el VPS.
 * Solo usa GET (públicos/firmados) y SELECT: jamás POST/DELETE, ni órdenes
 * de prueba, ni imprime saldos, posiciones, símbolos, identificadores o keys.
 *
 * node src/scripts/options-live-contract-check.js <user-id>
 */
const credentials = require('../services/options/options-credentials.service');
const db = require('../db');

function positiveNumber(value) {
  return value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
}

/** Igual que el ledger: un HTTP 200 no certifica fills sin datos contabilizables. */
function usableUserTrade(row) {
  return row != null && typeof row === 'object' &&
    /^[0-9]+$/.test(String(row.tradeId ?? row.id ?? '')) &&
    /^[0-9]+$/.test(String(row.orderId ?? '')) &&
    typeof row.symbol === 'string' && row.symbol.length > 0 &&
    ['BUY', 'SELL'].includes(row.side) &&
    positiveNumber(row.quantity) && positiveNumber(row.price) &&
    row.fee != null && row.fee !== '' && Number.isFinite(Number(row.fee)) &&
    row.quoteAsset === 'USDT' &&
    Number.isFinite(Number(row.time)) && Number(row.time) > 0;
}

/** La reconciliación exige estos campos para verificar estado y cantidad. */
function usableOrder(row, symbol, id) {
  return row != null && typeof row === 'object' &&
    String(row.orderId ?? '') === String(id) &&
    row.symbol === symbol && ['BUY', 'SELL'].includes(row.side) &&
    typeof row.status === 'string' &&
    positiveNumber(row.quantity) &&
    row.executedQty != null && Number.isFinite(Number(row.executedQty)) &&
    Number(row.executedQty) >= 0 &&
    Number(row.executedQty) <= Number(row.quantity);
}

function shapeOf(data) {
  if (Array.isArray(data)) return data[0] && typeof data[0] === 'object'
    ? Object.keys(data[0]).sort() : [];
  if (data && typeof data === 'object') return Object.keys(data).sort();
  return [];
}

/** La salida puede publicarse en CI, no incluye valores privados. */
async function checkContracts({ userId, client, database, at = Date.now() }) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid user id');
  const startTime = at - 24 * 60 * 60_000;
  const results = [];
  const checked = async (name, call, { array = true } = {}) => {
    try {
      const data = await call();
      if (array ? !Array.isArray(data) : !(data && typeof data === 'object' && !Array.isArray(data))) {
        throw new Error('Unexpected Binance response shape');
      }
      results.push({ endpoint: name, ok: true,
        count: Array.isArray(data) ? data.length : undefined,
        shape: shapeOf(data) });
      return data;
    } catch (err) {
      // No exponer mensajes: podrían contener parámetros o información
      // privada proporcionada por un proveedor.
      results.push({ endpoint: name, ok: false, code: 'CONTRACT_CHECK_FAILED' });
      return null;
    }
  };

  const exchange = await checked('exchangeInfo', () => client.getExchangeInfo(), { array: false });
  const active = (exchange?.optionSymbols || []).find((row) =>
    row.status === 'TRADING' && typeof row.symbol === 'string' &&
    /^[A-Z0-9]+-\d{6}-[0-9.]+-[CP]$/.test(row.symbol));
  if (active) {
    // Verificar tick/lot/fechas antes de permitir TP o sizing en real.
    const filter = (active.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
    const tick = Number(filter?.tickSize);
    const step = Number(filter?.stepSize);
    const expiry = Number(active.expiryDate);
    const valid = tick > 0 && step > 0 && expiry > at && Number.isFinite(expiry);
    results.push({ endpoint: 'optionFilters', ok: valid, fields: ['tickSize', 'stepSize', 'expiryDate'] });
    const underlying = String(active.underlying || '').toUpperCase();
    if (/^[A-Z0-9]{3,20}$/.test(underlying) && typeof client.getSpotKlines === 'function') {
      await checked('spotKlines1h', async () => {
        const candles = await client.getSpotKlines(underlying, '1h', 17);
        if (!Array.isArray(candles) || !candles.every((k) =>
          Array.isArray(k) && k.length >= 7)) throw new Error('Invalid candlesticks');
        return candles;
      });
    } else {
      results.push({ endpoint: 'spotKlines1h', ok: false, code: 'INVALID_UNDERLYING' });
    }
  } else {
    results.push({ endpoint: 'optionFilters', ok: false, code: 'NO_TRADING_SYMBOL' });
    results.push({ endpoint: 'spotKlines1h', ok: false, code: 'NO_TRADING_SYMBOL' });
  }

  // Barrera de cuenta aislada: la clave no debe poder retirar fondos y
  // debe estar restringida a las IP conocidas del VPS. No se reportan
  // direcciones ni el valor de ningún permiso, solo estado agregado.
  try {
    if (typeof client.getApiRestrictions !== 'function') {
      throw new Error('API restrictions endpoint unavailable');
    }
    const perms = await client.getApiRestrictions();
    const valid = perms && perms.ipRestrict === true &&
      perms.enableWithdrawals === false && perms.enableReading === true &&
      perms.enableVanillaOptions === true;
    results.push({
      endpoint: 'apiPermissions', ok: Boolean(valid),
      ...(!valid ? { code: 'UNSAFE_OR_INCOMPLETE_API_PERMISSIONS' } : {}),
    });
  } catch (_) {
    results.push({ endpoint: 'apiPermissions', ok: false, code: 'PERMISSION_CHECK_UNAVAILABLE' });
  }

  const endpoints = [
    ['marginAccount', () => client.getAccount(), false],
    ['positions', () => client.getPositions(), true],
    ['openOrders', () => client.getOpenOrders(), true],
    ['exerciseRecord', () => client.getExerciseRecords({ startTime, endTime: at, limit: 100 }), true],
    ['bill', () => client.getBills({ currency: 'USDT', startTime, endTime: at, limit: 100 }), true],
  ];
  const accountRows = {};
  for (const [name, call, array] of endpoints) {
    const data = await checked(name, call, { array });
    if (name === 'positions' || name === 'openOrders') accountRows[name] = data;
  }

  // Un piloto nuevo necesita una cuenta aislada sin órdenes manuales
  // pendientes ni contratos ya expuestos. El resumen jamás revela montos.
  const positions = accountRows.positions;
  const openOrders = accountRows.openOrders;
  const isolated = Array.isArray(positions) && Array.isArray(openOrders) &&
    openOrders.length === 0 && positions.every((p) =>
      p && typeof p.symbol === 'string' && p.symbol.length > 0 &&
      p.quantity != null && p.quantity !== '' &&
      Number.isFinite(Number(p.quantity)) && Math.abs(Number(p.quantity)) <= 1e-12);
  results.push({
    endpoint: 'isolatedAccount', ok: Boolean(isolated),
    ...(!isolated ? { code: 'NONZERO_EXPOSURE_OR_OPEN_ORDERS' } : {}),
  });

  // getOrder necesita identidad real de una orden que ya exista. No crear
  // órdenes solo para probar el contrato; usar ledger histórico si lo hay.
  try {
    const { rows } = await database.query(
      "SELECT symbol,exchange_order_id FROM options_live_orders " +
      "WHERE user_id=$1 AND exchange_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    const existing = rows[0];
    if (existing?.symbol && existing.exchange_order_id != null) {
      const order = await checked('getOrder', () => client.getOrder({
        symbol: existing.symbol, orderId: String(existing.exchange_order_id),
      }), { array: false });
      if (order && !usableOrder(order, existing.symbol, existing.exchange_order_id)) {
        const row = results.find((r) => r.endpoint === 'getOrder');
        row.ok = false;
        row.code = 'INCOMPATIBLE_ORDER_SHAPE';
      }
      const trades = await checked('userTrades', () => client.getUserTrades({
        symbol: existing.symbol, startTime, endTime: at, limit: 100,
      }));
      if (Array.isArray(trades)) {
        const row = results.find((r) => r.endpoint === 'userTrades');
        if (!trades.length) {
          // HTTP 200 con [] no demuestra el esquema de fills reales.
          row.ok = null;
          row.skipped = 'NO_RECENT_TRADES';
        } else if (!trades.every(usableUserTrade)) {
          // No filtrar valores privados: solo indicar incompatibilidad.
          row.ok = false;
          row.code = 'INCOMPATIBLE_TRADE_SHAPE';
        }
      }
    } else {
      results.push({ endpoint: 'getOrder', ok: null, skipped: 'NO_HISTORICAL_ORDER' });
      results.push({ endpoint: 'userTrades', ok: null, skipped: 'NO_HISTORICAL_ORDER' });
    }
  } catch (_) {
    results.push({ endpoint: 'getOrder', ok: false, code: 'LEDGER_UNAVAILABLE' });
    results.push({ endpoint: 'userTrades', ok: false, code: 'LEDGER_UNAVAILABLE' });
  }
  return {
    readOnly: true,
    ready: results.every((r) => r.ok === true),
    results,
  };
}

async function main() {
  const userId = Number(process.argv[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Se necesita user-id entero positivo');
  }
  const client = await credentials.getClientForUser(userId);
  const report = await checkContracts({ userId, client, database: db });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ready) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(() => {
    // Sin mensajes de error del proveedor en salida de CI.
    process.stderr.write('Binance read-only contract check failed\n');
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = { checkContracts, shapeOf, usableUserTrade, usableOrder };
