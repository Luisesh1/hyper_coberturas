/**
 * protection-preflight.js
 *
 * Dry-run de la cobertura delta-neutral ANTES de firmar nada on-chain.
 *
 * El orden de la saga de creación pone el approve/swap/mint en el medio, y
 * esos pasos no se pueden deshacer. Este módulo mueve todo fallo previsible
 * de la cobertura a un punto donde revertir todavía es gratis: si un check
 * no pasa, el wizard no deja avanzar a la pantalla de firma.
 *
 * Trabaja sobre el PLAN, no sobre una posición real — la posición todavía no
 * existe. Eso deja fuera lo que solo se puede validar contra el LP minado
 * (la valuación exacta del snapshot), y es la razón por la que el fallo
 * tardío sigue siendo posible y la saga necesita compensación.
 */

const {
  resolveDeltaNeutralOrientation,
} = require('../delta-neutral-math.service');

// Identidad y orden de los checks. El cliente los pinta en este orden y los
// tests se apoyan en que la lista sea estable.
const PREFLIGHT_CHECKS = [
  { id: 'account', label: 'Cuenta de Hyperliquid operativa' },
  { id: 'asset', label: 'Par elegible y activo soportado' },
  { id: 'leverage', label: 'Leverage dentro del máximo del activo' },
  { id: 'margin', label: 'Margen libre suficiente' },
  { id: 'conflict', label: 'Sin otra protección activa en el mismo activo' },
];

function roundUsd(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Un check sin evaluar lleva `ok: null`, no `false`: "no se pudo comprobar"
 * y "se comprobó y falla" son estados distintos, y mostrarlos igual haría
 * creer al usuario que hay más cosas rotas de las que hay.
 */
function buildPendingChecks() {
  return PREFLIGHT_CHECKS.map((check) => ({ ...check, ok: null, detail: null }));
}

/**
 * @param {object} params
 * @param {number} params.userId
 * @param {object} params.plan Plan del wizard: par, capital y config de protección.
 * @param {object} deps Colaboradores inyectables (todos con default de producción).
 * @returns {Promise<{ok: boolean, skipped: boolean, checks: Array, computed: object, blockingReason: string|null}>}
 */
async function runProtectionPreflight({ userId, plan }, deps = {}) {
  const protection = plan?.protection || {};

  // Sin cobertura no hay nada que validar y, sobre todo, nada que pueda
  // fallar después del mint: el flujo standalone entra por aquí.
  if (protection.enabled === false) {
    return {
      ok: true,
      skipped: true,
      checks: [],
      computed: null,
      blockingReason: null,
    };
  }

  const accountsService = deps.accountsService || require('../hyperliquid-accounts.service');
  const marketService = deps.marketService || require('../market.service');
  const balanceCache = deps.balanceCache || require('../balance-cache.service');
  const protectedPoolRepository = deps.protectedPoolRepository
    || require('../../repositories/protected-uniswap-pool.repository');

  const checks = buildPendingChecks();
  const setCheck = (id, ok, detail) => {
    const target = checks.find((c) => c.id === id);
    if (target) {
      target.ok = ok;
      target.detail = detail ?? null;
    }
  };

  const computed = {
    asset: null,
    maxLeverage: null,
    leverage: Number(protection.leverage) || null,
    notionalUsd: null,
    requiredMarginUsd: null,
    freeMarginUsd: null,
    accountId: protection.accountId ?? null,
  };

  const finish = (blockingReason) => ({
    ok: !blockingReason,
    skipped: false,
    checks,
    computed,
    blockingReason: blockingReason || null,
  });

  // ── 1. Cuenta ────────────────────────────────────────────────────────────
  // Se corta aquí si falla: sin cuenta no se puede comprobar margen ni
  // conflictos, y evaluar el resto a medias daría un informe engañoso.
  let account;
  try {
    account = await accountsService.resolveAccount(userId, protection.accountId);
    computed.accountId = account?.id ?? protection.accountId ?? null;
    setCheck('account', true, `Cuenta #${computed.accountId}`);
  } catch (err) {
    setCheck('account', false, err.message);
    return finish(`No se pudo resolver la cuenta de Hyperliquid: ${err.message}`);
  }

  // ── 2. Elegibilidad del par + asset soportado ────────────────────────────
  const orientation = resolveDeltaNeutralOrientation({
    token0Symbol: plan.token0Symbol,
    token1Symbol: plan.token1Symbol,
  });
  if (!orientation.eligible) {
    setCheck('asset', false, orientation.reason);
    return finish(orientation.reason);
  }

  let universe;
  try {
    universe = await marketService.getAvailableAssets();
  } catch (err) {
    setCheck('asset', false, `No se pudo leer el catálogo de Hyperliquid: ${err.message}`);
    return finish(`No se pudo leer el catálogo de Hyperliquid: ${err.message}`);
  }

  const volatileSymbol = String(orientation.volatileTokenSymbol || '').toUpperCase();
  const asset = (universe || []).find(
    (item) => String(item?.name || '').trim().toUpperCase() === volatileSymbol
  );
  if (!asset) {
    const detail = `El token volátil ${volatileSymbol} no existe en Hyperliquid.`;
    setCheck('asset', false, detail);
    return finish(detail);
  }

  computed.asset = asset.name;
  computed.maxLeverage = Number(asset.maxLeverage) || null;
  setCheck('asset', true, `${asset.name} · máx ${computed.maxLeverage}x`);

  // ── 3. Leverage ──────────────────────────────────────────────────────────
  // No se corta el flujo: el margen y el conflicto siguen siendo
  // informativos, y ver los tres a la vez ahorra un ciclo de corrección.
  const leverage = Number(protection.leverage);
  let blockingReason = null;
  if (!Number.isFinite(leverage) || leverage <= 0) {
    setCheck('leverage', false, 'El leverage debe ser un número positivo.');
    blockingReason = blockingReason || 'El leverage debe ser un número positivo.';
  } else if (computed.maxLeverage && leverage > computed.maxLeverage) {
    const detail = `${leverage}x supera el máximo de ${computed.maxLeverage}x para ${asset.name}.`;
    setCheck('leverage', false, detail);
    blockingReason = blockingReason || detail;
  } else {
    setCheck('leverage', true, `${leverage}x`);
  }

  // ── 4. Margen libre ──────────────────────────────────────────────────────
  const notionalUsd = Number(protection.configuredNotionalUsd) > 0
    ? Number(protection.configuredNotionalUsd)
    : Number(plan.capitalUsd);
  computed.notionalUsd = Number.isFinite(notionalUsd) ? roundUsd(notionalUsd) : null;

  const effectiveLeverage = Number.isFinite(leverage) && leverage > 0 ? leverage : null;
  computed.requiredMarginUsd = computed.notionalUsd != null && effectiveLeverage
    ? roundUsd(computed.notionalUsd / effectiveLeverage)
    : null;

  try {
    const snapshot = await balanceCache.getSnapshot(userId, computed.accountId);
    computed.freeMarginUsd = roundUsd(snapshot?.withdrawable ?? 0);

    if (computed.requiredMarginUsd == null) {
      setCheck('margin', false, 'No se pudo dimensionar el margen requerido.');
      blockingReason = blockingReason || 'No se pudo dimensionar el margen requerido.';
    } else if (computed.freeMarginUsd < computed.requiredMarginUsd) {
      const detail = `Margen libre $${computed.freeMarginUsd} < $${computed.requiredMarginUsd} requerido.`;
      setCheck('margin', false, detail);
      blockingReason = blockingReason || detail;
    } else {
      setCheck('margin', true, `$${computed.freeMarginUsd} libre · $${computed.requiredMarginUsd} requerido`);
    }
  } catch (err) {
    // Un balance que no se puede leer NO es un balance suficiente. Marcarlo
    // como aprobado dejaría pasar justo el fallo que este módulo evita.
    const detail = `No se pudo leer el balance de Hyperliquid: ${err.message}`;
    setCheck('margin', false, detail);
    blockingReason = blockingReason || detail;
  }

  // ── 5. Conflicto de protección ───────────────────────────────────────────
  // `createDeltaNeutralProtectedPool` rechaza dos protecciones activas sobre
  // el mismo asset y cuenta. Detectarlo aquí evita descubrirlo con el LP ya
  // minado.
  try {
    const active = await protectedPoolRepository.listActiveByUser(userId);
    const conflict = (active || []).find((item) => (
      Number(item.accountId) === Number(computed.accountId)
      && String(item.inferredAsset || '').toUpperCase() === String(computed.asset || '').toUpperCase()
      && item.status === 'active'
    ));
    if (conflict) {
      const detail = `Ya hay una protección activa en ${computed.asset} para la cuenta #${computed.accountId}.`;
      setCheck('conflict', false, detail);
      blockingReason = blockingReason || detail;
    } else {
      setCheck('conflict', true, 'Sin conflictos');
    }
  } catch (err) {
    const detail = `No se pudieron listar las protecciones activas: ${err.message}`;
    setCheck('conflict', false, detail);
    blockingReason = blockingReason || detail;
  }

  return finish(blockingReason);
}

module.exports = { runProtectionPreflight, PREFLIGHT_CHECKS };
