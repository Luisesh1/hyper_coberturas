/**
 * valuation.js — reglas puras de la valoracion por wallet.
 *
 * Una captura se compone de fuentes independientes: `tokens:<red>`,
 * `lps:<red>` y `hl`. Una fuente caida reutiliza su ultimo valor conocido (sin
 * limite de antiguedad) y marca el punto como parcial; asi un RPC caido no
 * dibuja una caida falsa en la grafica. Lo mismo vale, a nivel de posicion,
 * para un LP cuyo precio no se pudo resolver.
 */

const USDC_TOKEN_INDEX = 0;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function kindOf(key) {
  if (key.startsWith('tokens:')) return 'tokensUsd';
  if (key.startsWith('lps:')) return 'lpUsd';
  if (key === 'hl') return 'hlUsd';
  return null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Resuelve los items de LP de una fuente sana: un LP sin precio (`usd` null)
 * reutiliza el valor que tuvo en la captura anterior.
 */
function mergeLpItems(items, previousItems, now, staleSources) {
  const prevById = new Map((previousItems || []).map((item) => [item.id, item]));
  return items.map((item) => {
    if (item.usd != null) return { ...item, stale: false, lastOkAt: now };
    const prev = prevById.get(item.id);
    const lastOkAt = prev?.lastOkAt ?? null;
    staleSources.push({ key: `lp:${item.id}`, lastOkAt });
    return { ...item, usd: finite(prev?.usd) ?? 0, stale: true, lastOkAt };
  });
}

/**
 * @param {Record<string, {ok: boolean, usd?: number, items?: object[], error?: string}>} fresh
 * @param {{sources?: object}|null} previousDetail  `last_detail` de la wallet
 * @param {number} now
 */
function mergeSources(fresh, previousDetail, now) {
  const previous = previousDetail?.sources || {};
  const sources = {};
  const staleSources = [];
  const totals = { tokensUsd: 0, lpUsd: 0, hlUsd: 0, totalUsd: 0 };

  for (const [key, result] of Object.entries(fresh)) {
    const kind = kindOf(key);
    if (!kind) continue;
    let entry;
    if (result.ok) {
      const items = key.startsWith('lps:')
        ? mergeLpItems(result.items || [], previous[key]?.items, now, staleSources)
        : (result.items || []);
      const usd = key.startsWith('lps:')
        ? items.reduce((sum, item) => sum + (finite(item.usd) || 0), 0)
        : (finite(result.usd) || 0);
      entry = { usd, items, lastOkAt: now, stale: false, error: null, meta: result.meta || null };
    } else {
      const prev = previous[key];
      const lastOkAt = prev?.lastOkAt ?? null;
      staleSources.push({ key, lastOkAt });
      entry = {
        usd: finite(prev?.usd) || 0,
        items: prev?.items || [],
        lastOkAt,
        stale: true,
        error: result.error || 'error desconocido',
        meta: prev?.meta || null,
      };
    }
    sources[key] = entry;
    totals[kind] += entry.usd;
  }

  totals.tokensUsd = round2(totals.tokensUsd);
  totals.lpUsd = round2(totals.lpUsd);
  totals.hlUsd = round2(totals.hlUsd);
  totals.totalUsd = round2(totals.tokensUsd + totals.lpUsd + totals.hlUsd);

  return { sources, totals, staleSources, isPartial: staleSources.length > 0 };
}

/**
 * Valora una posicion LP. `priceOf(token)` devuelve el precio USD conocido
 * del token o null; si solo un lado tiene precio, el otro se deduce del
 * precio del propio pool (`priceCurrent` = token1 por token0).
 */
function valueLpPosition(position, priceOf) {
  const poolPrice = finite(position.priceCurrent);
  let p0 = finite(priceOf(position.token0 || {}));
  let p1 = finite(priceOf(position.token1 || {}));
  let priceSource0 = p0 != null && p0 > 0 ? 'market' : null;
  let priceSource1 = p1 != null && p1 > 0 ? 'market' : null;
  if (!priceSource0) p0 = null;
  if (!priceSource1) p1 = null;

  if (p0 == null && p1 != null && poolPrice != null && poolPrice > 0) {
    p0 = poolPrice * p1;
    priceSource0 = 'pool';
  } else if (p1 == null && p0 != null && poolPrice != null && poolPrice > 0) {
    p1 = p0 / poolPrice;
    priceSource1 = 'pool';
  }

  if (p0 == null || p1 == null) {
    return { usd: null, positionUsd: null, feesUsd: null, price0: p0, price1: p1, priceSource0, priceSource1 };
  }

  const a0 = finite(position.positionAmount0) || 0;
  const a1 = finite(position.positionAmount1) || 0;
  const f0 = finite(position.unclaimedFees0) || 0;
  const f1 = finite(position.unclaimedFees1) || 0;
  const positionUsd = round2(a0 * p0 + a1 * p1);
  const feesUsd = round2(f0 * p0 + f1 * p1);
  return {
    usd: round2(positionUsd + feesUsd),
    positionUsd,
    feesUsd,
    price0: p0,
    price1: p1,
    priceSource0,
    priceSource1,
  };
}

/**
 * Valor de la cuenta Hyperliquid de una direccion.
 *  - perps: `marginSummary.accountValue` (incluye margen aislado y PnL abierto).
 *  - spot: cada balance con su precio. En una cuenta unificada el USDC de spot
 *    es el colateral de perps y ya esta dentro de accountValue: no se suma.
 */
function valueHyperliquid({ perp, spot, abstraction, spotPriceOf }) {
  const perpUsd = finite(perp?.marginSummary?.accountValue) || 0;
  const unified = abstraction != null && abstraction !== 'disabled';
  const balances = (spot?.balances || []).map((b) => {
    const amount = finite(b.total) || 0;
    const price = finite(spotPriceOf(b));
    const priced = price != null && price > 0;
    const countedInPerp = unified && Number(b.token) === USDC_TOKEN_INDEX;
    return {
      coin: b.coin,
      token: b.token,
      amount,
      priceUsd: priced ? price : null,
      usd: priced ? round2(amount * price) : 0,
      priced,
      countedInPerp,
    };
  }).filter((b) => b.amount > 0);

  const spotUsd = round2(balances
    .filter((b) => !b.countedInPerp)
    .reduce((sum, b) => sum + b.usd, 0));

  return {
    usd: round2(perpUsd + spotUsd),
    perpUsd,
    spotUsd,
    unified,
    abstraction: abstraction || null,
    positionsCount: Array.isArray(perp?.assetPositions) ? perp.assetPositions.length : 0,
    spot: balances,
  };
}

module.exports = {
  mergeSources,
  valueLpPosition,
  valueHyperliquid,
};
