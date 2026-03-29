export function getExplorerLink(baseUrl, kind, value) {
  if (!baseUrl || !value) return null;
  if (kind === 'tx') return `${baseUrl}/tx/${value}`;
  if (kind === 'address') return `${baseUrl}/address/${value}`;
  return null;
}

export function getPoolStatus(pool) {
  if (pool.currentOutOfRangeSide === 'below') {
    return { label: 'Fuera por abajo', tone: 'alert', detail: 'El precio se movio por debajo del rango protegido.' };
  }
  if (pool.currentOutOfRangeSide === 'above') {
    return { label: 'Fuera por arriba', tone: 'alert', detail: 'El precio se movio por encima del rango protegido.' };
  }
  if (pool.inRange === true) {
    return { label: 'Dentro de rango', tone: 'positive', detail: 'La posicion sigue operando dentro del rango activo.' };
  }
  if (pool.protection) {
    return { label: 'Protegido', tone: 'neutral', detail: 'Este pool ya tiene coberturas ligadas activas.' };
  }
  if (pool.status === 'inactive') {
    return { label: 'Inactiva', tone: 'neutral', detail: 'La proteccion del pool esta desactivada.' };
  }
  return { label: 'Activa', tone: 'neutral', detail: 'Pool detectado y listo para revisar.' };
}

export function isPoolEligible(pool) {
  return !!(pool?.protectionCandidate?.eligible || pool?.protectionCandidate?.deltaNeutralEligible);
}

export function getProtectionButtonState(pool, hasAccounts) {
  const isLpPosition = pool.mode === 'lp_position' || pool.mode === 'lp_positions';
  const isProtectible = isPoolEligible(pool);
  if (!isLpPosition || !['v3', 'v4'].includes(pool.version)) return null;
  if (pool.protection) {
    return { disabled: true, label: 'Protegido', reason: 'Este pool ya tiene una proteccion activa.' };
  }
  if (!hasAccounts) {
    return { disabled: true, label: 'Aplicar cobertura', reason: 'Configura una cuenta de Hyperliquid antes de activar protecciones.' };
  }
  if (!isProtectible) {
    return {
      disabled: true,
      label: 'Aplicar cobertura',
      reason: pool.protectionCandidate?.reason || pool.protectionCandidate?.deltaNeutralReason || 'Este pool no es elegible para proteccion automatica.',
    };
  }
  return { disabled: false, label: 'Aplicar cobertura', reason: null };
}

export function getRangeBarData(pool) {
  const lower = Number(pool.rangeLowerPrice);
  const upper = Number(pool.rangeUpperPrice);
  const open = Number(pool.priceAtOpen);
  const current = Number(pool.priceCurrent);

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower === upper) return null;

  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  const padding = Math.max((max - min) * 0.15, max * 0.015);
  const visMin = min - padding;
  const visMax = max + padding;
  const normalize = (value) => {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, ((value - visMin) / (visMax - visMin)) * 100));
  };

  return {
    rangeLowPct: normalize(min),
    rangeHighPct: normalize(max),
    openPct: normalize(open),
    currentPct: normalize(current),
    openPrice: open,
    currentPrice: current,
    lowerPrice: min,
    upperPrice: max,
    currentOutOfRangeSide: pool.currentOutOfRangeSide,
  };
}

export function getPoolValue(pool) {
  const currentValue = Number(pool.currentValueUsd);
  if (Number.isFinite(currentValue) && currentValue > 0) return currentValue;
  const tvl = Number(pool.tvlApproxUsd);
  if (Number.isFinite(tvl) && tvl > 0) return tvl;
  return null;
}

export function getPoolTimestamp(pool) {
  const openedAt = Number(pool.openedAt || pool.createdAt);
  return Number.isFinite(openedAt) ? openedAt : 0;
}
