/**
 * Validación exacta de filtros de Binance Options ANTES de crear
 * intenciones duraderas o enviar un POST.
 * Valores decimales se comparan con BigInt; jamás aproximar el tick o lote.
 */

function decimal(value) {
  const raw = String(value ?? '');
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const parts = raw.split('.');
  const places = (parts[1] || '').length;
  if (places > 18) return null;
  return { integer: BigInt(parts.join('')), places };
}

function matchesStep(value, min, step) {
  const a = decimal(value);
  const m = decimal(min);
  const s = decimal(step);
  if (!a || !m || !s || s.integer <= 0n) return false;
  const places = Math.max(a.places, m.places, s.places);
  const scaled = (x) => x.integer * 10n ** BigInt(places - x.places);
  return (scaled(a) - scaled(m)) % scaled(s) === 0n;
}

function numberPositive(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

function requireOrderFilters(exchange, leg, nowMs, deadlineAt) {
  const item = (exchange?.optionSymbols || []).find((s) => s.symbol === leg.symbol);
  if (!item || item.status !== 'TRADING' || item.quoteAsset !== 'USDT') {
    throw new Error('Option contract not in TRADING state with USDT quote');
  }
  const expiry = Number(item.expiryDate);
  if (!Number.isFinite(expiry) || expiry <= Math.max(nowMs, deadlineAt)) {
    throw new Error('Option expires before the order deadline');
  }
  const price = numberPositive(leg.price);
  const qty = numberPositive(leg.quantity);
  if (price == null || qty == null) throw new Error('Invalid positive order price or quantity');
  const filter = (item.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
  const lot = (item.filters || []).find((f) => f.filterType === 'LOT_SIZE') || filter || {};
  if (!filter || numberPositive(filter.tickSize) == null ||
      numberPositive(lot.stepSize) == null || numberPositive(lot.minQty) == null) {
    throw new Error('Exchange price or quantity filter unavailable');
  }

  const minPrice = filter.minPrice ?? '0';
  const maxPrice = filter.maxPrice ?? '0';
  const minQty = numberPositive(lot.minQty);
  const maxQty = numberPositive(lot.maxQty ?? item.maxQty);
  if ((Number(minPrice) > 0 && price < Number(minPrice)) ||
      (Number(maxPrice) > 0 && price > Number(maxPrice)) ||
      qty < minQty || (maxQty != null && qty > maxQty)) {
    throw new Error('Order violates exchange price/quantity limits');
  }
  if (!matchesStep(leg.price, minPrice, filter.tickSize) ||
      !matchesStep(leg.quantity, lot.minQty, lot.stepSize)) {
    throw new Error('Order violates exact tickSize or stepSize (minPrice/minQty anchored)');
  }
  return true;
}

function validateBinanceOrderBatch(exchange, legs, nowMs, deadlineAt) {
  if (!Array.isArray(legs) || !legs.length) throw new Error('Empty order batch');
  if (!exchange || !Array.isArray(exchange.optionSymbols)) {
    throw new Error('Invalid Binance exchangeInfo response');
  }
  for (const leg of legs) requireOrderFilters(exchange, leg, nowMs, deadlineAt);
  return true;
}

module.exports = { decimal, matchesStep, requireOrderFilters, validateBinanceOrderBatch };
