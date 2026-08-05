/**
 * create-saga.js
 *
 * Commit de la creación de un LP orquestado, con compensación.
 *
 * Se ejecuta DESPUÉS de que el usuario haya firmado el mint, así que arranca
 * con un hecho irreversible ya consumado: la posición existe on-chain. A
 * partir de ahí solo quedan pasos reversibles, y el trabajo de este módulo
 * es garantizar que se aplican todos o ninguno:
 *
 *   5. abrir el hedge + crear la protección   (reversible: deactivate)
 *   6. crear el orquestador y vincularlo      (reversible: delete)
 *
 * Si algo falla, se compensa y se reporta el LP como superviviente para que
 * la UI le ofrezca al usuario las tres salidas (cerrarlo, reintentar la
 * cobertura, o conservarlo sin cobertura). Lo que NO se hace nunca es dejar
 * un orquestador activo sin el hedge que dice tener.
 */

/**
 * Traduce el plan del wizard al payload de `createOrchestrator`.
 *
 * Aquí vive la regla de la fuente única del ancho de rango: el paso Rango
 * manda y `rangeWidthPct` se deriva del rango elegido, salvo que el usuario
 * lo haya desacoplado explícitamente.
 */
function buildOrchestratorPayload(plan) {
  const strategy = plan.strategy || {};
  const lower = Number(plan.rangeLowerPrice);
  const upper = Number(plan.rangeUpperPrice);
  const center = Number(plan.priceCurrent);

  let rangeWidthPct = Number(strategy.rangeWidthPct);
  if (!strategy.rangeWidthDecoupled) {
    if (Number.isFinite(lower) && Number.isFinite(upper) && Number.isFinite(center) && center > 0) {
      rangeWidthPct = Math.round(((upper - lower) / 2 / center) * 100 * 100) / 100;
    }
  }

  const capitalUsd = Number(plan.capitalUsd);
  const protection = plan.protection || {};

  // `rangeWidthDecoupled` es un flag de la UI: describe cómo se llegó al
  // ancho, no cómo debe operar el orquestador. No se persiste.
  const { rangeWidthDecoupled: _uiFlag, v4TickSpacing, ...strategyRest } = strategy;

  // El tickSpacing solo tiene sentido en v4, donde forma parte de la
  // identidad del pool (poolId = keccak(...tickSpacing...)). En v3 se
  // descarta para no ensuciar la config con un campo inerte.
  const v4Identity = plan.version === 'v4' && v4TickSpacing != null
    ? { v4TickSpacing: Number(v4TickSpacing) }
    : {};

  return {
    name: plan.name,
    network: plan.network,
    version: plan.version,
    walletAddress: plan.walletAddress,
    token0Address: plan.token0Address,
    token1Address: plan.token1Address,
    token0Symbol: plan.token0Symbol,
    token1Symbol: plan.token1Symbol,
    feeTier: plan.feeTier != null ? Number(plan.feeTier) : null,
    // Un solo capital: el que se despliega es el que persiste el orquestador.
    initialTotalUsd: capitalUsd,
    strategyConfig: {
      ...strategyRest,
      rangeWidthPct,
      ...v4Identity,
    },
    protectionConfig: protection.enabled === false
      ? { enabled: false }
      : {
        ...protection,
        enabled: true,
        // Sin notional explícito, la cobertura se dimensiona con el mismo
        // capital del LP.
        configuredNotionalUsd: Number(protection.configuredNotionalUsd) > 0
          ? Number(protection.configuredNotionalUsd)
          : capitalUsd,
      },
  };
}

function resolvePositionIdentifier(finalizeResult) {
  return finalizeResult?.positionChanges?.newPositionIdentifier
    || finalizeResult?.positionIdentifier
    || null;
}

/**
 * Lo que sobrevive a una compensación: el LP minado. Se reporta siempre,
 * incluso cuando no se pudo resolver su identificador — los txHashes son la
 * única pista que le queda al usuario para encontrarlo.
 */
function buildSurvivingLp(plan, finalizeResult) {
  const snapshot = finalizeResult?.refreshedSnapshot || null;
  return {
    positionIdentifier: resolvePositionIdentifier(finalizeResult),
    poolAddress: snapshot?.poolAddress || null,
    network: plan?.network || null,
    version: plan?.version || null,
    token0Symbol: plan?.token0Symbol || null,
    token1Symbol: plan?.token1Symbol || null,
    feeTier: plan?.feeTier ?? null,
    valueUsd: snapshot?.currentValueUsd ?? null,
    txHashes: finalizeResult?.txHashes || [],
  };
}

class LpCreateSaga {
  constructor(deps = {}) {
    this.logger = deps.logger || require('../logger.service');
    this.orchestratorService = deps.orchestratorService || require('../lp-orchestrator.service');
    this.protectionService = deps.protectionService || require('../uniswap-protection.service');
    this.protectedPoolRepository = deps.protectedPoolRepository
      || require('../../repositories/protected-uniswap-pool.repository');
    this.repo = deps.repo || require('../../repositories/lp-orchestrator.repository');
    this.operationRepo = deps.operationRepo
      || require('../../repositories/uniswap-operation.repository');
    this.newOperationKey = deps.newOperationKey
      || (() => `orch_lp_create:${require('node:crypto').randomUUID()}`);
  }

  /**
   * Registra la intención ANTES de la primera firma. A partir de aquí existe
   * un rastro en el servidor de qué se pretendía crear, así que un cliente
   * que desaparezca a mitad no deja el LP huérfano y sin explicación.
   */
  async beginIntent({ userId, plan }) {
    if (process.env.ORCHESTRATED_LP_CREATE_ENABLED === 'false') {
      const disabled = new Error('La creación de LP orquestados está temporalmente pausada.');
      disabled.code = 'ORCHESTRATED_LP_CREATE_DISABLED';
      disabled.statusCode = 503;
      throw disabled;
    }
    const operationKey = this.newOperationKey();
    const operation = await this.operationRepo.createOrReuse({
      userId,
      operationKey,
      kind: 'orchestrated_lp_create',
      action: 'create-position',
      network: plan.network,
      version: plan.version,
      walletAddress: plan.walletAddress,
      txHashes: [],
      status: 'awaiting_signature',
      step: 'awaiting_signature',
      plan,
    });
    return { operationKey, operationId: operation.id };
  }

  /**
   * Commit idempotente. La misma intención se puede reintentar (el cliente
   * reintenta, o el worker la retoma) sin duplicar orquestadores ni hedges:
   * una operación ya terminada devuelve su resultado guardado.
   */
  async commitIntent({ userId, operationKey, finalizeResult, claimToken = null, claimOwner = null }) {
    let operation = await this.operationRepo.getByOperationKey(userId, operationKey);
    if (!operation) {
      throw new Error(`No existe la intención ${operationKey}`);
    }
    if (operation.status === 'done' || operation.status === 'compensated') {
      return operation.result;
    }

    const leaseMs = 120_000;
    let ownedClaimToken = claimToken;
    const canClaim = typeof this.operationRepo.claimByOperationKey === 'function';
    if (canClaim) {
      const suppliedClaimIsCurrent = claimToken
        && operation.claimToken === claimToken
        && Number(operation.claimLeaseUntil || 0) > Date.now();
      if (!suppliedClaimIsCurrent) {
        ownedClaimToken = require('node:crypto').randomUUID();
        operation = await this.operationRepo.claimByOperationKey(userId, operationKey, {
          claimToken: ownedClaimToken,
          claimOwner: claimOwner || `lp-create-http:${process.pid}`,
          leaseMs,
        });
      }
      if (!operation) {
        const latest = await this.operationRepo.getByOperationKey(userId, operationKey);
        if (latest?.status === 'done' || latest?.status === 'compensated') {
          return latest.result;
        }
        const busy = new Error('La creación ya está siendo procesada. Consulta el estado de la operación.');
        busy.code = 'OPERATION_IN_PROGRESS';
        busy.statusCode = 409;
        throw busy;
      }
    }

    const heartbeat = canClaim && typeof this.operationRepo.renewClaim === 'function'
      ? setInterval(() => {
        this.operationRepo.renewClaim(operation.id, ownedClaimToken, leaseMs).catch((err) => {
          this.logger.warn?.('lp_create_saga_lease_renew_failed', {
            operationId: operation.id,
            error: err.message,
          });
        });
      }, 40_000)
      : null;
    heartbeat?.unref?.();

    try {
      const positionIdentifier = resolvePositionIdentifier(finalizeResult);
      await this.operationRepo.updateState(operation.id, {
        status: 'committing',
        step: 'committing',
        // Es el payload mínimo de recuperación. Si el proceso muere después
        // de confirmar las firmas, el worker necesita el snapshot completo
        // para reanudar sin volver a depender del navegador.
        result: { finalizeResult },
        txHashes: finalizeResult?.txHashes || [],
        positionIdentifier,
      });

      const result = await this.commit({
        userId,
        plan: operation.plan,
        finalizeResult,
        operationId: operation.id,
      });

      await this.operationRepo.updateState(operation.id, {
        status: result.status === 'completed' ? 'done' : 'compensated',
        step: result.status === 'completed' ? 'done' : 'compensated',
        result,
        errorMessage: result.reason || null,
        finishedAt: Date.now(),
      });

      return result;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (canClaim && typeof this.operationRepo.releaseClaim === 'function') {
        await this.operationRepo.releaseClaim(operation.id, ownedClaimToken).catch((err) => {
          this.logger.warn?.('lp_create_saga_lease_release_failed', {
            operationId: operation.id,
            error: err.message,
          });
        });
      }
    }
  }

  /**
   * @returns {Promise<{status:'completed'|'compensated', orchestrator?:object,
   *   reason?:string, compensations?:Array, survivingLp?:object, needsManualReview?:boolean}>}
   */
  async commit({ userId, plan, finalizeResult, operationId = null }) {
    const survivingLp = buildSurvivingLp(plan, finalizeResult);

    // El flujo standalone (desde Uniswap Pools) termina en el mint: no hay
    // orquestador ni cobertura que vincular, así que no hay saga que correr.
    if (plan?.mode === 'standalone') {
      return { status: 'completed', orchestrator: null, survivingLp };
    }

    if (!survivingLp.positionIdentifier) {
      // Sin identificador no se puede vincular nada. Se corta antes de crear
      // el orquestador para no tener que borrarlo acto seguido.
      return {
        status: 'compensated',
        reason: 'No se pudo resolver el identificador de la posición recién creada.',
        compensations: [],
        survivingLp,
        needsManualReview: false,
      };
    }

    let orchestrator = null;
    try {
      orchestrator = await this.orchestratorService.createOrchestrator({
        userId,
        creationOperationId: operationId,
        ...buildOrchestratorPayload(plan),
      });

      if (orchestrator.activePositionIdentifier) {
        if (String(orchestrator.activePositionIdentifier) !== String(survivingLp.positionIdentifier)) {
          throw new Error('La operación ya creó un orquestador vinculado a otra posición.');
        }
        const expectedProtection = buildOrchestratorPayload(plan).protectionConfig?.enabled !== false;
        if (expectedProtection && !orchestrator.activeProtectedPoolId) {
          throw new Error('El orquestador recuperado tiene LP activo pero no tiene protección vinculada.');
        }
        return { status: 'completed', orchestrator, survivingLp, recovered: true };
      }

      const attached = await this.orchestratorService.attachLp({
        userId,
        orchestratorId: orchestrator.id,
        finalizeResult,
        protectionConfig: buildOrchestratorPayload(plan).protectionConfig,
        // El punto entero de la saga: que un fallo de cobertura llegue aquí
        // como excepción en vez de quedar en un `logger.warn`.
        protectionFailureMode: 'strict',
        creationOperationId: operationId,
      });

      return { status: 'completed', orchestrator: attached, survivingLp };
    } catch (err) {
      this.logger.warn?.('lp_orchestrator_create_saga_failed', {
        userId,
        orchestratorId: orchestrator?.id || null,
        error: err.message,
      });
      const compensations = await this._compensate({
        userId,
        plan,
        orchestrator,
        operationId,
        positionIdentifier: survivingLp.positionIdentifier,
      });
      return {
        status: 'compensated',
        reason: err.message,
        compensations,
        survivingLp,
        needsManualReview: compensations.some((step) => step.ok === false),
      };
    }
  }

  /**
   * Deshace lo reversible. Cada paso se reporta por separado y con su
   * resultado real: si el cierre del hedge falla, el usuario tiene que
   * enterarse de que puede quedarle un short abierto.
   */
  async _compensate({ userId, plan, orchestrator, positionIdentifier, operationId = null }) {
    const steps = [];

    // 1. La protección puede haberse creado (y el hedge abierto) aunque
    //    `attachLp` fallara después. Se busca por identidad porque el
    //    orquestador nunca llegó a guardar su id.
    try {
      const protection = operationId != null
        && typeof this.protectedPoolRepository.findByCreationOperationId === 'function'
        ? await this.protectedPoolRepository.findByCreationOperationId(userId, operationId)
        : await this.protectedPoolRepository.findReusableByIdentity(userId, {
          network: plan.network,
          version: plan.version,
          walletAddress: plan.walletAddress,
          positionIdentifier,
        });

      const ownedBySaga = operationId == null
        || Number(protection?.creationOperationId) === Number(operationId);
      const activeReference = protection?.id
        && typeof this.repo.findActiveByProtectedPoolId === 'function'
        ? await this.repo.findActiveByProtectedPoolId(userId, protection.id)
        : null;
      if (protection?.status === 'active' && activeReference) {
        steps.push({
          id: 'hedge',
          ok: true,
          detail: `Protección #${protection.id} preservada: está vinculada al orquestador #${activeReference.id}`,
        });
      } else if (protection?.status === 'active' && ownedBySaga) {
        await this.protectionService.deactivateProtectedPool(userId, protection.id);
        steps.push({ id: 'hedge', ok: true, detail: `Protección #${protection.id} desactivada` });
      } else if (protection?.status === 'active') {
        steps.push({ id: 'hedge', ok: true, detail: 'Protección ajena preservada' });
      } else {
        steps.push({ id: 'hedge', ok: true, detail: 'No había hedge que cerrar' });
      }
    } catch (err) {
      steps.push({
        id: 'hedge',
        ok: false,
        detail: `No se pudo cerrar el hedge: ${err.message}. Revisá la cuenta en Hyperliquid.`,
      });
    }

    // 2. El orquestador se borra en duro: se creó hace segundos y nunca
    //    llegó a operar.
    if (orchestrator?.id) {
      try {
        if (operationId != null && typeof this.repo.removeOwnedByOperation === 'function') {
          await this.repo.removeOwnedByOperation(userId, orchestrator.id, operationId);
        } else {
          await this.repo.remove(userId, orchestrator.id);
        }
        steps.push({ id: 'orchestrator', ok: true, detail: 'Orquestador borrado' });
      } catch (err) {
        steps.push({
          id: 'orchestrator',
          ok: false,
          detail: `No se pudo borrar el orquestador: ${err.message}`,
        });
      }
    }

    return steps;
  }
}

module.exports = { LpCreateSaga, buildOrchestratorPayload };
