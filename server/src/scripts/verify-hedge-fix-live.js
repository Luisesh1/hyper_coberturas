require('dotenv').config();

const db = require('../db');
const hlRegistry = require('../services/hyperliquid.registry');
const hedgeRegistry = require('../services/hedge.registry');
const { formatSize } = require('../utils/format');

const BASE_URL = process.env.VERIFY_HEDGE_BASE_URL || 'http://localhost:3001';
const USERNAME = process.env.VERIFY_HEDGE_USERNAME || 'admin';
const PASSWORD = process.env.VERIFY_HEDGE_PASSWORD || 'admin123';
const ACCOUNT_ID = Number(process.env.VERIFY_HEDGE_ACCOUNT_ID || 5);
const ASSET = 'SOL';
const TARGET_NOTIONAL_USD = Number(process.env.VERIFY_HEDGE_NOTIONAL_USD || 11);
const EXECUTE_LIVE = process.argv.includes('--execute-live');
const POLL_TIMEOUT_MS = Number(process.env.VERIFY_HEDGE_TIMEOUT_MS || 45_000);
const POLL_INTERVAL_MS = Number(process.env.VERIFY_HEDGE_POLL_INTERVAL_MS || 2_000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReduceOnlyOrder(order) {
  if (typeof order?.reduceOnly === 'boolean') return order.reduceOnly;
  if (typeof order?.reduce_only === 'boolean') return order.reduce_only;
  if (typeof order?.r === 'boolean') return order.r;
  return false;
}

function getOrderCoin(order) {
  return String(order?.coin ?? order?.asset ?? '').toUpperCase();
}

function getPositionCoin(position) {
  return String(position?.coin ?? '').toUpperCase();
}

function getPositionSize(position) {
  return Math.abs(parseFloat(position?.szi || 0));
}

function buildLabelPrefix() {
  return `VERIFY-HEDGE-FIX-${ASSET}-${Date.now()}`;
}

async function fetchJson(path, {
  method = 'GET',
  token = null,
  body = null,
  timeoutMs = 20_000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : {};
    if (!response.ok || payload.success === false) {
      throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  const data = await fetchJson('/api/auth/login', {
    method: 'POST',
    body: { username: USERNAME, password: PASSWORD },
  });
  return data;
}

async function getState(token) {
  const [hedges, orders, account] = await Promise.all([
    fetchJson(`/api/hedge?accountId=${ACCOUNT_ID}`, { token }),
    fetchJson(`/api/trading/orders?accountId=${ACCOUNT_ID}&refresh=1`, { token }),
    fetchJson(`/api/trading/account?accountId=${ACCOUNT_ID}&refresh=1`, { token }),
  ]);

  return {
    hedges: Array.isArray(hedges) ? hedges : [],
    orders: Array.isArray(orders?.orders) ? orders.orders : [],
    positions: Array.isArray(account?.positions) ? account.positions : [],
  };
}

function filterAssetOrders(orders) {
  return orders.filter((order) => getOrderCoin(order) === ASSET);
}

function filterAssetPositions(positions) {
  return positions.filter((position) => getPositionCoin(position) === ASSET && getPositionSize(position) > 0);
}

async function cleanupAssetState(token, userId, labelPrefix) {
  const hedges = await fetchJson(`/api/hedge?accountId=${ACCOUNT_ID}`, { token });
  for (const hedge of hedges) {
    if (!String(hedge?.label || '').startsWith(labelPrefix)) continue;
    try {
      await fetchJson(`/api/hedge/${hedge.id}`, { method: 'DELETE', token });
    } catch (err) {
      console.warn(`[verify-hedge-fix-live] No se pudo cancelar hedge #${hedge.id}: ${err.message}`);
    }
  }

  const ordersPayload = await fetchJson(`/api/trading/orders?accountId=${ACCOUNT_ID}&refresh=1`, { token });
  const orders = Array.isArray(ordersPayload?.orders) ? ordersPayload.orders : [];
  for (const order of filterAssetOrders(orders)) {
    try {
      await fetchJson(`/api/trading/orders/${ASSET}/${order.oid}?accountId=${ACCOUNT_ID}`, {
        method: 'DELETE',
        token,
      });
    } catch (err) {
      console.warn(`[verify-hedge-fix-live] No se pudo cancelar orden ${order.oid}: ${err.message}`);
    }
  }

  const account = await fetchJson(`/api/trading/account?accountId=${ACCOUNT_ID}&refresh=1`, { token });
  const positions = Array.isArray(account?.positions) ? account.positions : [];
  const assetPosition = filterAssetPositions(positions)[0];
  if (assetPosition) {
    try {
      await fetchJson('/api/trading/close', {
        method: 'POST',
        token,
        body: { accountId: ACCOUNT_ID, asset: ASSET },
      });
    } catch (err) {
      console.warn(`[verify-hedge-fix-live] No se pudo cerrar posicion residual ${ASSET}: ${err.message}`);
    }
  }

  await sleep(3_000);
  await db.query(
    `DELETE FROM hedges
      WHERE hyperliquid_account_id = $1
        AND label LIKE $2`,
    [ACCOUNT_ID, `${labelPrefix}%`]
  );
  await hedgeRegistry.reload(userId, ACCOUNT_ID).catch(() => {});
}

async function ensureCleanAssetScope(token, labelPrefix) {
  const state = await getState(token);
  const assetOrders = filterAssetOrders(state.orders);
  const assetPositions = filterAssetPositions(state.positions);
  const { rows } = await db.query(
    `SELECT id
       FROM hedges
      WHERE hyperliquid_account_id = $1
        AND label LIKE $2`,
    [ACCOUNT_ID, `${labelPrefix}%`]
  );
  const labelledHedges = rows.map((row) => Number(row.id));

  if (assetOrders.length > 0) {
    throw new Error(`Quedaron ordenes ${ASSET} residuales: ${assetOrders.map((order) => order.oid).join(', ')}`);
  }
  if (assetPositions.length > 0) {
    throw new Error(`Quedo posicion ${ASSET} residual abierta`);
  }
  if (labelledHedges.length > 0) {
    throw new Error(`Quedaron hedges de validacion en servidor: ${labelledHedges.join(', ')}`);
  }
}

async function main() {
  await db.ensureConnection();
  await db.initSchema();

  const { token, user } = await login();
  const labelPrefix = buildLabelPrefix();

  const baseline = await getState(token);
  const baselineAssetOrders = filterAssetOrders(baseline.orders);
  const baselineAssetPositions = filterAssetPositions(baseline.positions);

  if (baselineAssetOrders.length > 0 || baselineAssetPositions.length > 0) {
    throw new Error(`La cuenta ${ACCOUNT_ID} ya tiene actividad previa en ${ASSET}. Aborta para no tocar estado ajeno.`);
  }

  const hl = await hlRegistry.getOrCreate(user.id, ACCOUNT_ID);
  const [mids, meta] = await Promise.all([
    hl.getAllMids(),
    hl.getAssetMeta(ASSET),
  ]);
  const midPrice = parseFloat(mids?.[ASSET]);
  if (!Number.isFinite(midPrice) || midPrice <= 0) {
    throw new Error(`No hay midPrice valido para ${ASSET}`);
  }

  const size = Number.parseFloat(formatSize(TARGET_NOTIONAL_USD / midPrice, meta.szDecimals));
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`No se pudo calcular size valido para ${ASSET}`);
  }

  console.log(`[verify-hedge-fix-live] Preflight OK | asset=${ASSET} | mid=${midPrice} | size=${size}`);
  if (!EXECUTE_LIVE) {
    console.log('[verify-hedge-fix-live] Ejecuta con --execute-live para correr la validacion real.');
    return;
  }

  let hedgeId = null;
  try {
    const entryPrice = midPrice * 1.0015;
    const exitPrice = entryPrice * 1.01;
    const hedge = await fetchJson('/api/hedge', {
      method: 'POST',
      token,
      body: {
        accountId: ACCOUNT_ID,
        asset: ASSET,
        direction: 'short',
        entryPrice,
        exitPrice,
        leverage: 1,
        size,
        label: `${labelPrefix}-SHORT`,
      },
    });
    hedgeId = hedge.id;
    console.log(`[verify-hedge-fix-live] Hedge creado #${hedgeId}`);

    const startedAt = Date.now();
    let exercisedOrderPath = false;
    while ((Date.now() - startedAt) < POLL_TIMEOUT_MS) {
      const [hedgeState, ordersPayload, accountPayload] = await Promise.all([
        fetchJson(`/api/hedge/${hedgeId}`, { token }),
        fetchJson(`/api/trading/orders?accountId=${ACCOUNT_ID}&refresh=1`, { token }),
        fetchJson(`/api/trading/account?accountId=${ACCOUNT_ID}&refresh=1`, { token }),
      ]);

      const orders = Array.isArray(ordersPayload?.orders) ? ordersPayload.orders : [];
      const positions = Array.isArray(accountPayload?.positions) ? accountPayload.positions : [];
      const assetOrders = filterAssetOrders(orders);
      const nonReduceOnlyOrders = assetOrders.filter((order) => !isReduceOnlyOrder(order));
      const assetPosition = filterAssetPositions(positions)[0] || null;

      if (nonReduceOnlyOrders.length > 1) {
        throw new Error(`Se detectaron ${nonReduceOnlyOrders.length} entradas ${ASSET} simultaneas para el hedge`);
      }
      if (hedgeState.status === 'error') {
        throw new Error(`El hedge entro en error: ${hedgeState.error || 'error_desconocido'}`);
      }
      if (assetPosition && getPositionSize(assetPosition) > (size * 1.05)) {
        throw new Error(`La posicion ${ASSET} excedio el size esperado: ${getPositionSize(assetPosition)} > ${size}`);
      }

      if (nonReduceOnlyOrders.length === 1 || assetPosition || hedgeState.partialCoverageInfo) {
        exercisedOrderPath = true;
      }

      if (exercisedOrderPath && (assetPosition || hedgeState.partialCoverageInfo || hedgeState.status === 'open_protected')) {
        console.log('[verify-hedge-fix-live] Flujo de orden ejercitado sin duplicados detectados.');
        break;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    if (!hedgeId) {
      throw new Error('No se creo el hedge de validacion');
    }
  } finally {
    await cleanupAssetState(token, user.id, labelPrefix).catch((err) => {
      console.warn(`[verify-hedge-fix-live] Cleanup con advertencias: ${err.message}`);
    });
    await ensureCleanAssetScope(token, labelPrefix);
  }

  console.log('[verify-hedge-fix-live] Validacion completada y entorno restaurado.');
}

let exitCode = 0;

main()
  .catch((err) => {
    console.error(`[verify-hedge-fix-live] ERROR: ${err.message}`);
    exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
    process.exit(exitCode);
  });
