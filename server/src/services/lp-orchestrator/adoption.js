/**
 * adoption.js
 *
 * Adopción de un LP que ya existe en la wallet por un orquestador NUEVO.
 *
 * La posición cuenta casi todo lo que el orquestador necesita: red, versión,
 * par, fee, PoolKey v4, rango y valor. Este módulo lo convierte en el payload
 * de `createOrchestrator` (con la procedencia de cada campo, para que la UI
 * distinga lo leído de la cadena de lo derivado o por defecto) y ejecuta la
 * adopción con compensación.
 *
 * Reglas de la saga (más corta que la de creación porque no hay firmas):
 *   - la identidad se relee de la cadena; el cliente solo manda campos editables,
 *   - la cobertura nueva va en modo `strict`: si falla, se borra el orquestador
 *     y se desactiva la protección creada en esta llamada. El LP no se toca,
 *   - la contabilidad empieza en la adopción: se siembra `lastEvaluation` con
 *     el snapshot de adopción para que las fees sin cobrar previas y la deriva
 *     anterior no cuenten como resultado del orquestador.
 */

const { AppError, ValidationError } = require('../../errors/app-error');
const {
  SWAP_DELTA_HOOK_POLICIES,
  classifyHook,
  isLiquidityDeltaReturning,
  isZeroHook,
  DYNAMIC_FEE_FLAG,
} = require('../uniswap/v4-hook-safety');
const {
  strategyConfigSchema,
  strategyConfigPatchSchema,
} = require('../../schemas/lp-orchestrator.schema');

const ORCHESTRABLE_VERSIONS = ['v3', 'v4'];
// Mismo default que el asistente de creación (useUnifiedLpFlow).
const DEFAULT_EDGE_MARGIN_PCT = 40;
const DEFAULT_MIN_RANGE_WIDTH_PCT = 1;
const DEFAULT_MAX_RANGE_WIDTH_PCT = 30;

const lc = (value) => String(value || '').toLowerCase();

function hasLiquidity(pool) {
  try { return BigInt(pool?.liquidity || 0) > 0n; } catch { return Number(pool?.liquidity || 0) > 0; }
}

/**
 * Semiancho del rango en % de su centro geométrico. Un rango de Uniswap son
 * ticks: su centro real es √(inf·sup), no el precio actual (que puede estar
 * descentrado o fuera) ni la media aritmética.
 */
function deriveRangeWidthPct(lower, upper) {
  const lo = Number(lower);
  const hi = Number(upper);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= lo) return null;
  const center = Math.sqrt(lo * hi);
  return Math.round(((hi - lo) / 2 / center) * 100 * 100) / 100;
}

function poolFee(pool) {
  const fee = pool?.fee ?? pool?.feeTier;
  return fee != null && Number.isFinite(Number(fee)) ? Number(fee) : null;
}

function feeLabel(fee) {
  if (fee == null) return '';
  if (Number(fee) === DYNAMIC_FEE_FLAG) return 'dinámica';
  return `${Number((Number(fee) / 10_000).toFixed(4))}%`;
}

function ownerOf(pool) {
  return pool?.owner || pool?.creator || pool?.walletAddress || null;
}

function isActiveOrchestrator(orch) {
  return orch && orch.status !== 'archived' && orch.activePositionIdentifier != null;
}

function findManagingOrchestrator(pool, orchestrators = []) {
  const wallet = lc(ownerOf(pool));
  return orchestrators.find((orch) => isActiveOrchestrator(orch)
    && orch.network === pool.network
    && orch.version === pool.version
    && lc(orch.walletAddress) === wallet
    && String(orch.activePositionIdentifier) === String(pool.identifier)) || null;
}

/**
 * Configuración de orquestador equivalente a una protección que ya opera:
 * lo que hay es lo que se guarda, para que editar la config o un
 * kill+recreate posterior reproduzcan la misma cobertura.
 */
function protectionConfigFromExisting(protection) {
  const defined = (entries) => Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value != null && !Number.isNaN(value))
  );
  const state = protection?.strategyState || {};
  return defined({
    enabled: true,
    accountId: Number(protection.accountId),
    leverage: Number(protection.leverage),
    configuredNotionalUsd: Number(protection.configuredHedgeNotionalUsd || protection.hedgeNotionalUsd) || null,
    stopLossDifferencePct: protection.stopLossDifferencePct,
    bandMode: protection.bandMode,
    baseRebalancePriceMovePct: protection.baseRebalancePriceMovePct,
    rebalanceIntervalSec: protection.rebalanceIntervalSec,
    targetHedgeRatio: protection.targetHedgeRatio,
    minRebalanceNotionalPct: protection.minRebalanceNotionalPct,
    centerDeadZonePct: protection.centerDeadZonePct,
    maxSlippageBps: protection.maxSlippageBps,
    twapMinNotionalUsd: protection.twapMinNotionalUsd,
    policyVersion: protection.policyVersion || state.policyVersion,
    terminalRangeConfig: state.terminalRangeConfig,
    executionIntent: state.executionIntent,
  });
}

function describeProtectionOptions(pool, swapReturnsDelta) {
  const allowedPolicies = swapReturnsDelta ? [...SWAP_DELTA_HOOK_POLICIES] : null;
  const existing = pool?.protection && pool.protection.status !== 'inactive' ? pool.protection : null;
  const candidate = pool?.protectionCandidate || null;
  const candidateSummary = candidate?.eligible
    ? {
      inferredAsset: candidate.inferredAsset || null,
      defaultLeverage: candidate.defaultLeverage ?? null,
      maxLeverage: candidate.maxLeverage ?? null,
      hedgeNotionalUsd: candidate.hedgeNotionalUsd ?? null,
    }
    : null;

  if (existing) {
    if (existing.protectionMode === 'delta_neutral') {
      return {
        modes: ['reuse'], defaultMode: 'reuse', allowedPolicies, existing, candidate: candidateSummary, warning: null,
      };
    }
    return {
      modes: ['none'],
      defaultMode: 'none',
      allowedPolicies,
      existing,
      candidate: candidateSummary,
      warning: `La posición ya tiene una cobertura ${existing.protectionMode || 'estática'} activa. `
        + 'Para cubrirla desde el orquestador, desactívala antes; si no, se adopta sin cobertura.',
    };
  }
  if (!candidateSummary) {
    return {
      modes: ['none'],
      defaultMode: 'none',
      allowedPolicies,
      existing: null,
      candidate: null,
      warning: `No se puede cubrir en Hyperliquid: ${candidate?.reason || 'activo no disponible'}.`,
    };
  }
  return {
    modes: ['new', 'none'], defaultMode: 'new', allowedPolicies, existing: null, candidate: candidateSummary, warning: null,
  };
}

/**
 * Evalúa una posición escaneada como candidata a adopción.
 *
 * @param {object} pool  Posición de `scanPoolsCreatedByWallet` (anotada).
 * @param {object} ctx   { activeOrchestrators, verifiedHooks }
 */
function evaluateAdoptionCandidate(pool, { activeOrchestrators = [], verifiedHooks = [] } = {}) {
  const fee = poolFee(pool);
  const isV4 = pool.version === 'v4';
  const hooks = isV4 && pool.hooks && !isZeroHook(pool.hooks) ? pool.hooks : null;
  const hookClass = hooks ? classifyHook(hooks) : null;
  const verified = hooks
    ? verifiedHooks.find((item) => lc(item?.deployment?.address) === lc(hooks)) || null
    : null;
  const swapReturnsDelta = !!hookClass && !hookClass.safe && !isLiquidityDeltaReturning(hooks);

  const rangeWidthPct = deriveRangeWidthPct(pool.rangeLowerPrice, pool.rangeUpperPrice);
  const valueUsd = Number(pool.currentValueUsd);
  const token0Symbol = pool.token0?.symbol || null;
  const token1Symbol = pool.token1?.symbol || null;

  let blockedCode = null;
  let blockedReason = null;
  const managing = findManagingOrchestrator(pool, activeOrchestrators);
  if (!ORCHESTRABLE_VERSIONS.includes(pool.version)) {
    blockedCode = 'unsupported_version';
    blockedReason = `El orquestador no gestiona posiciones ${pool.version}.`;
  } else if (!hasLiquidity(pool)) {
    blockedCode = 'no_liquidity';
    blockedReason = 'La posición no tiene liquidez.';
  } else if (managing) {
    blockedCode = 'already_orchestrated';
    blockedReason = `Ya la gestiona el orquestador «${managing.name || `#${managing.id}`}».`;
  } else if (hooks && isLiquidityDeltaReturning(hooks)) {
    blockedCode = 'hook_liquidity_delta';
    blockedReason = 'El hook del pool altera los importes al añadir o retirar liquidez; el orquestador no puede gestionarla.';
  } else if (!Number.isFinite(valueUsd) || valueUsd <= 0) {
    blockedCode = 'no_valuation';
    blockedReason = 'No se pudo valorar la posición en USD.';
  } else if (rangeWidthPct == null || rangeWidthPct >= 100) {
    blockedCode = 'invalid_range';
    blockedReason = 'No se pudo leer el rango de la posición.';
  } else if (!token0Symbol || !token1Symbol) {
    blockedCode = 'unknown_tokens';
    blockedReason = 'No se pudieron identificar los tokens del pool.';
  }

  const strategyConfig = {
    rangeWidthPct,
    edgeMarginPct: DEFAULT_EDGE_MARGIN_PCT,
    minRangeWidthPct: rangeWidthPct != null ? Math.min(DEFAULT_MIN_RANGE_WIDTH_PCT, rangeWidthPct) : DEFAULT_MIN_RANGE_WIDTH_PCT,
    maxRangeWidthPct: rangeWidthPct != null ? Math.max(DEFAULT_MAX_RANGE_WIDTH_PCT, Math.min(99, rangeWidthPct)) : DEFAULT_MAX_RANGE_WIDTH_PCT,
    ...(isV4 && pool.tickSpacing != null ? { v4TickSpacing: Number(pool.tickSpacing) } : {}),
    ...(hooks ? { v4Hooks: hooks } : {}),
    ...(verified ? { v4DynamicFeeHookVersionId: Number(verified.id) } : {}),
  };

  const prefill = {
    name: [`${token0Symbol}/${token1Symbol}`, feeLabel(fee), `#${pool.identifier}`].filter(Boolean).join(' '),
    network: pool.network,
    version: pool.version,
    walletAddress: ownerOf(pool),
    token0Address: pool.token0?.address || pool.token0Address,
    token1Address: pool.token1?.address || pool.token1Address,
    token0Symbol,
    token1Symbol,
    inferredAsset: pool.protectionCandidate?.inferredAsset || null,
    feeTier: fee,
    initialTotalUsd: Number.isFinite(valueUsd) ? Math.round(valueUsd * 100) / 100 : null,
    strategyConfig,
  };

  const provenance = {
    network: 'chain',
    version: 'chain',
    walletAddress: 'chain',
    tokens: 'chain',
    feeTier: 'chain',
    v4TickSpacing: 'chain',
    v4Hooks: 'chain',
    v4DynamicFeeHookVersionId: 'derived',
    inferredAsset: 'derived',
    initialTotalUsd: 'derived',
    rangeWidthPct: 'derived',
    minRangeWidthPct: strategyConfig.minRangeWidthPct !== DEFAULT_MIN_RANGE_WIDTH_PCT ? 'derived' : 'default',
    maxRangeWidthPct: strategyConfig.maxRangeWidthPct !== DEFAULT_MAX_RANGE_WIDTH_PCT ? 'derived' : 'default',
    edgeMarginPct: 'default',
    name: 'derived',
  };

  return {
    position: {
      identifier: String(pool.identifier),
      network: pool.network,
      version: pool.version,
      walletAddress: ownerOf(pool),
      token0: pool.token0 || null,
      token1: pool.token1 || null,
      fee,
      tickSpacing: pool.tickSpacing ?? null,
      hooks,
      poolId: pool.poolId || null,
      poolAddress: pool.poolAddress || null,
      rangeLowerPrice: pool.rangeLowerPrice ?? null,
      rangeUpperPrice: pool.rangeUpperPrice ?? null,
      priceCurrent: pool.priceCurrent ?? null,
      inRange: pool.inRange === true,
      currentValueUsd: Number.isFinite(valueUsd) ? valueUsd : null,
      unclaimedFeesUsd: pool.unclaimedFeesUsd ?? null,
      openedAt: pool.openedAt || pool.createdAt || null,
    },
    eligible: blockedCode == null,
    blockedCode,
    blockedReason,
    managedBy: managing ? { id: managing.id, name: managing.name || null } : null,
    hook: hooks
      ? {
        address: hooks,
        swapReturnsDelta,
        verifiedVersionId: verified ? Number(verified.id) : null,
      }
      : null,
    prefill,
    provenance,
    protection: describeProtectionOptions(pool, swapReturnsDelta),
  };
}

class LpAdoptionService {
  constructor(deps = {}) {
    this.logger = deps.logger || require('../logger.service');
    this.uniswapService = deps.uniswapService || require('../uniswap.service');
    this.repo = deps.repo || require('../../repositories/lp-orchestrator.repository');
    this.protectedPoolRepo = deps.protectedPoolRepo
      || require('../../repositories/protected-uniswap-pool.repository');
    this.verifiedHooksRepository = deps.verifiedHooksRepository
      || require('../../repositories/smart-contract-registry.repository');
    this.protectionService = deps.protectionService || require('../uniswap-protection.service');
    this.loadWalletPoolSnapshot = deps.loadWalletPoolSnapshot
      || require('../uniswap/actions/helpers').loadWalletPoolSnapshot;
    // Perezoso: lp-orchestrator.service carga muchos módulos y la ruta ya lo tiene.
    this._orchestratorService = deps.orchestratorService || null;
  }

  get orchestratorService() {
    if (!this._orchestratorService) this._orchestratorService = require('../lp-orchestrator.service');
    return this._orchestratorService;
  }

  async _context(userId, network) {
    const [activeOrchestrators, verifiedHooks] = await Promise.all([
      this.repo.listForUser(userId),
      this.verifiedHooksRepository.listVerifiedHooks(userId, network).catch((err) => {
        this.logger.warn?.('lp_adoption_verified_hooks_failed', { network, error: err.message });
        return [];
      }),
    ]);
    return { activeOrchestrators, verifiedHooks };
  }

  /**
   * Escanea v3 y v4 de la red (las que soporte) y devuelve las posiciones
   * con liquidez, adoptables primero y por valor. Un escaneo fallido no tumba
   * al otro: se reporta en `warnings`.
   */
  async listCandidates({ userId, network, walletAddress }) {
    if (!network || !walletAddress) throw new ValidationError('network y walletAddress son requeridos');
    const support = this.uniswapService.getSupportMatrix();
    const networkInfo = (support?.networks || []).find((item) => item.id === network);
    if (!networkInfo) throw new ValidationError(`Red no soportada: ${network}`);
    const versions = (networkInfo.versions || []).filter((v) => ORCHESTRABLE_VERSIONS.includes(v));

    const [scans, ctx] = await Promise.all([
      Promise.allSettled(versions.map((version) => this.uniswapService.scanPoolsCreatedByWallet({
        userId, wallet: walletAddress, network, version,
      }))),
      this._context(userId, network),
    ]);

    const warnings = [];
    const pools = [];
    scans.forEach((scan, idx) => {
      if (scan.status === 'fulfilled') {
        pools.push(...(scan.value?.pools || []));
        warnings.push(...(scan.value?.warnings || []));
      } else {
        warnings.push(`No se pudo escanear ${versions[idx]}: ${scan.reason?.message || scan.reason}`);
      }
    });

    const candidates = pools
      .filter((pool) => pool?.mode === 'lp_position' || pool?.identifier != null)
      .filter(hasLiquidity)
      .map((pool) => evaluateAdoptionCandidate(pool, ctx))
      .sort((a, b) => (Number(b.eligible) - Number(a.eligible))
        || (Number(b.position.currentValueUsd || 0) - Number(a.position.currentValueUsd || 0)));

    return { candidates, warnings };
  }

  /**
   * Crea el orquestador, le vincula la posición y (según `protection.mode`)
   * abre una cobertura nueva, conserva la existente o no cubre.
   */
  async adopt({
    userId,
    network,
    version,
    walletAddress,
    positionIdentifier,
    name,
    initialTotalUsd,
    strategyConfig: strategyOverrides,
    protection = { mode: 'none' },
  }) {
    const pool = await this.loadWalletPoolSnapshot(userId, {
      network, version, walletAddress, positionIdentifier: String(positionIdentifier), attempts: 1,
    });
    const ctx = await this._context(userId, network);
    const candidate = evaluateAdoptionCandidate(pool, ctx);
    if (!candidate.eligible) throw new ValidationError(candidate.blockedReason);

    const mode = protection?.mode || 'none';
    if (!candidate.protection.modes.includes(mode)) {
      throw new ValidationError(
        `Esta posición no admite la opción de cobertura «${mode}». Opciones: ${candidate.protection.modes.join(', ')}.`
      );
    }

    let protectionConfig = { enabled: false };
    let existingProtectedPoolId = null;
    if (mode === 'new') {
      protectionConfig = protection.config;
      const allowed = candidate.protection.allowedPolicies;
      if (allowed && !allowed.includes(protectionConfig?.policyVersion)) {
        throw new ValidationError(
          `El hook de este pool devuelve deltas en swaps: la política debe ser ${allowed.join(' o ')}.`
        );
      }
    } else if (mode === 'reuse') {
      const existingId = Number(candidate.protection.existing.id);
      const linked = await this.repo.findActiveByProtectedPoolId(userId, existingId);
      if (linked) {
        throw new ValidationError(`La cobertura #${existingId} ya está vinculada al orquestador #${linked.id}.`);
      }
      const existing = await this.protectedPoolRepo.getById(userId, existingId);
      if (!existing || existing.status !== 'active') {
        throw new ValidationError(`La cobertura #${existingId} ya no está activa.`);
      }
      protectionConfig = protectionConfigFromExisting(existing);
      existingProtectedPoolId = existingId;
    }

    const prefill = candidate.prefill;
    const overrides = strategyConfigPatchSchema.parse(strategyOverrides || {});
    const merged = { ...prefill.strategyConfig, ...overrides };
    if (overrides.rangeWidthPct != null) {
      merged.minRangeWidthPct = Math.min(merged.minRangeWidthPct, overrides.rangeWidthPct);
      merged.maxRangeWidthPct = Math.max(merged.maxRangeWidthPct, overrides.rangeWidthPct);
    }
    const strategyConfig = strategyConfigSchema.parse(merged);
    const capital = initialTotalUsd != null ? Number(initialTotalUsd) : prefill.initialTotalUsd;
    if (!Number.isFinite(capital) || capital <= 0) throw new ValidationError('El capital inicial debe ser positivo.');

    const payload = {
      ...prefill,
      name: String(name || '').trim() || prefill.name,
      initialTotalUsd: capital,
      strategyConfig,
      protectionConfig,
    };

    let orchestrator = null;
    let attached = null;
    try {
      orchestrator = await this.orchestratorService.createOrchestrator({ userId, ...payload });
      attached = await this.orchestratorService.attachLp({
        userId,
        orchestratorId: orchestrator.id,
        finalizeResult: {
          action: 'adopt-position',
          txHashes: [],
          positionChanges: { oldPositionIdentifier: null, newPositionIdentifier: String(pool.identifier) },
          refreshedSnapshot: pool,
        },
        protectionConfig,
        existingProtectedPoolId,
        protectionFailureMode: 'strict',
      });
    } catch (err) {
      this.logger.warn?.('lp_adoption_failed', {
        userId, orchestratorId: orchestrator?.id || null, positionIdentifier, error: err.message,
      });
      const compensations = await this._compensate({
        userId, orchestrator, pool, mode, existingProtectedPoolId,
      });
      throw new AppError(`No se pudo adoptar el LP: ${err.message}`, {
        status: 409,
        code: 'ADOPTION_FAILED',
        details: { compensations },
        cause: err,
      });
    }

    // Fuera de la compensación: con el LP ya vinculado el orquestador no se
    // puede borrar, y sin la siembra solo se pierde la línea base contable.
    try {
      await this.repo.updateStrategyState(userId, orchestrator.id, {
        lastEvaluation: { status: 'adopted', poolSnapshot: pool },
        lastEvaluationAt: Date.now(),
      });
    } catch (err) {
      this.logger.warn?.('lp_adoption_baseline_seed_failed', { orchestratorId: orchestrator.id, error: err.message });
    }

    this._evaluateInBackground(userId, orchestrator.id);
    return { status: 'completed', orchestrator: attached || orchestrator, candidate };
  }

  async _compensate({ userId, orchestrator, pool, mode, existingProtectedPoolId }) {
    const steps = [];
    if (mode === 'new') {
      try {
        const protection = await this.protectedPoolRepo.findReusableByIdentity(userId, {
          network: pool.network,
          version: pool.version,
          walletAddress: ownerOf(pool),
          positionIdentifier: String(pool.identifier),
        });
        // `new` exige que no hubiera cobertura activa al empezar: una activa
        // ahora la abrió esta llamada.
        if (protection?.status === 'active' && Number(protection.id) !== Number(existingProtectedPoolId)) {
          await this.protectionService.deactivateProtectedPool(userId, protection.id);
          steps.push({ id: 'hedge', ok: true, detail: `Protección #${protection.id} desactivada` });
        }
      } catch (err) {
        steps.push({ id: 'hedge', ok: false, detail: `Revisa la cobertura: ${err.message}` });
      }
    }
    if (orchestrator?.id) {
      try {
        const removed = await this.repo.remove(userId, orchestrator.id);
        steps.push(removed
          ? { id: 'orchestrator', ok: true, detail: `Orquestador #${orchestrator.id} eliminado` }
          : { id: 'orchestrator', ok: false, detail: `El orquestador #${orchestrator.id} quedó vinculado al LP; revísalo.` });
      } catch (err) {
        steps.push({ id: 'orchestrator', ok: false, detail: `No se pudo eliminar el orquestador: ${err.message}` });
      }
    }
    return steps;
  }

  _evaluateInBackground(userId, orchestratorId) {
    if (typeof this.orchestratorService.evaluateOne !== 'function') return;
    Promise.resolve()
      .then(() => this.orchestratorService.evaluateOne(userId, orchestratorId))
      .catch((err) => {
        this.logger.warn?.('lp_adoption_initial_evaluation_failed', { orchestratorId, error: err.message });
      });
  }
}

module.exports = {
  LpAdoptionService,
  evaluateAdoptionCandidate,
  deriveRangeWidthPct,
  protectionConfigFromExisting,
};
