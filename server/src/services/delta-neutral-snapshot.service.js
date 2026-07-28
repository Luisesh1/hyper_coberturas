const crypto = require('crypto');
const { classifyHook } = require('./uniswap/v4-hook-safety');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Allowlist de hooks v4 auditados (lazy-require del config para no romper
// tests de módulo puro que no cargan config en modo prod).
function getV4HookAllowlist() {
  try {
    return require('../config').deltaNeutral?.v4HookAllowlist || [];
  } catch {
    return [];
  }
}

function isHookAllowlisted(hooksAddress) {
  if (!hooksAddress) return false;
  return getV4HookAllowlist().includes(String(hooksAddress).trim().toLowerCase());
}

function normalizeAddress(value) {
  if (!value) return null;
  return String(value).trim();
}

function normalizeToken(token = {}, fallbackAddress = null) {
  return {
    symbol: token?.symbol ? String(token.symbol).trim().toUpperCase() : null,
    address: normalizeAddress(token?.address || fallbackAddress),
    decimals: Number.isFinite(Number(token?.decimals)) ? Number(token.decimals) : null,
  };
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePoolIdentifier(snapshot = {}) {
  return snapshot.poolId || snapshot.positionIdentifier || snapshot.identifier || null;
}

function normalizeProtectionSnapshot(source = {}, {
  network = null,
  version = null,
  positionIdentifier = null,
  poolAddress = null,
  poolId = null,
  owner = null,
  snapshotFreshAt = Date.now(),
} = {}) {
  const token0 = normalizeToken(source.token0, source.token0Address);
  const token1 = normalizeToken(source.token1, source.token1Address);
  const normalized = {
    mode: source.mode || 'lp_position',
    network: String(network || source.network || '').trim().toLowerCase() || null,
    version: String(version || source.version || '').trim().toLowerCase() || null,
    positionIdentifier: String(positionIdentifier || source.positionIdentifier || source.identifier || '').trim() || null,
    poolAddress: normalizeAddress(poolAddress || source.poolAddress),
    poolId: String(poolId || source.poolId || '').trim() || null,
    owner: normalizeAddress(owner || source.owner || source.creator),
    token0,
    token1,
    tickLower: toNullableNumber(source.tickLower),
    tickUpper: toNullableNumber(source.tickUpper),
    liquidity: toPositiveNumber(source.liquidity),
    rangeLowerPrice: toPositiveNumber(source.rangeLowerPrice),
    rangeUpperPrice: toPositiveNumber(source.rangeUpperPrice),
    priceCurrent: toPositiveNumber(source.priceCurrent),
    currentValueUsd: toPositiveNumber(source.currentValueUsd),
    unclaimedFees0: toNullableNumber(source.unclaimedFees0),
    unclaimedFees1: toNullableNumber(source.unclaimedFees1),
    inRange: source.inRange === true,
    hooks: normalizeAddress(source.hooks),
    snapshotFreshAt: Number(snapshotFreshAt) || Date.now(),
  };

  if (!normalized.poolId) {
    normalized.poolId = String(normalizePoolIdentifier(source) || '').trim() || null;
  }

  return normalized;
}

function validateNormalizedProtectionSnapshot(snapshot = {}) {
  const reasons = [];

  if (!snapshot.network) reasons.push('network_missing');
  if (!['v3', 'v4'].includes(snapshot.version)) reasons.push('unsupported_version');
  if (!snapshot.positionIdentifier) reasons.push('position_identifier_missing');
  if (!snapshot.owner) reasons.push('owner_missing');
  if (!snapshot.token0?.symbol || !snapshot.token1?.symbol) reasons.push('token_symbol_missing');
  if (!snapshot.token0?.address || !snapshot.token1?.address) reasons.push('token_address_missing');
  if (!Number.isFinite(snapshot.token0?.decimals)) reasons.push('token0_decimals_missing');
  if (!Number.isFinite(snapshot.token1?.decimals)) reasons.push('token1_decimals_missing');
  if (!Number.isFinite(snapshot.tickLower)) reasons.push('tick_lower_missing');
  if (!Number.isFinite(snapshot.tickUpper)) reasons.push('tick_upper_missing');
  if (!Number.isFinite(snapshot.liquidity) || snapshot.liquidity <= 0) reasons.push('liquidity_missing');
  if (!Number.isFinite(snapshot.rangeLowerPrice) || !Number.isFinite(snapshot.rangeUpperPrice)) reasons.push('range_missing');
  if (!Number.isFinite(snapshot.currentValueUsd) || snapshot.currentValueUsd <= 0) reasons.push('current_value_missing');
  if (!Number.isFinite(snapshot.priceCurrent) || snapshot.priceCurrent <= 0) reasons.push('price_missing');
  if (snapshot.version === 'v3' && !snapshot.poolAddress) reasons.push('pool_address_missing');
  if (snapshot.version === 'v4' && !snapshot.poolId) reasons.push('pool_id_missing');
  // Pools v4 con hooks: sólo se rechazan los que devuelven deltas (custom
  // accounting), cuya matemática de valor/delta no es modelable con CLAMM. Los
  // hooks "safe" (informativos, fee dinámica, gating, etc.) entran a cobertura
  // igual que un pool v3. Un hook auditado a mano puede forzarse vía allowlist.
  if (snapshot.version === 'v4' && snapshot.hooks && snapshot.hooks !== ZERO_ADDRESS) {
    const { safe, reason } = classifyHook(snapshot.hooks);
    if (!safe && !isHookAllowlisted(snapshot.hooks)) {
      reasons.push(reason || 'hook_returns_delta');
    }
  }

  const unsupportedReasons = ['unsupported_pool_shape', 'hook_returns_delta', 'hook_address_invalid'];
  const unsupported = reasons.find((r) => unsupportedReasons.includes(r));
  const valid = reasons.length === 0;
  return {
    valid,
    status: valid ? 'ready' : unsupported || 'invalid',
    reasons,
  };
}

function computeSnapshotHash(snapshot = {}) {
  const payload = JSON.stringify({
    network: snapshot.network,
    version: snapshot.version,
    positionIdentifier: snapshot.positionIdentifier,
    poolAddress: snapshot.poolAddress,
    poolId: snapshot.poolId,
    owner: snapshot.owner,
    token0: snapshot.token0,
    token1: snapshot.token1,
    tickLower: snapshot.tickLower,
    tickUpper: snapshot.tickUpper,
    liquidity: snapshot.liquidity,
    rangeLowerPrice: snapshot.rangeLowerPrice,
    rangeUpperPrice: snapshot.rangeUpperPrice,
    priceCurrent: snapshot.priceCurrent,
    currentValueUsd: snapshot.currentValueUsd,
    unclaimedFees0: snapshot.unclaimedFees0,
    unclaimedFees1: snapshot.unclaimedFees1,
    inRange: snapshot.inRange,
    hooks: snapshot.hooks,
  });

  return crypto.createHash('sha1').update(payload).digest('hex');
}

module.exports = {
  ZERO_ADDRESS,
  computeSnapshotHash,
  normalizeProtectionSnapshot,
  validateNormalizedProtectionSnapshot,
};
