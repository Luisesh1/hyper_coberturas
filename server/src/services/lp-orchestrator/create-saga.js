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
      ...strategy,
      rangeWidthPct,
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
  async commitIntent({ userId, operationKey, finalizeResult }) {
    const operation = await this.operationRepo.getByOperationKey(userId, operationKey);
    if (!operation) {
      throw new Error(`No existe la intención ${operationKey}`);
    }
    if (operation.status === 'done' || operation.status === 'compensated') {
      return operation.result;
    }

    const positionIdentifier = resolvePositionIdentifier(finalizeResult);
    await this.operationRepo.updateState(operation.id, {
      status: 'committing',
      step: 'committing',
      txHashes: finalizeResult?.txHashes || [],
      positionIdentifier,
    });

    const result = await this.commit({ userId, plan: operation.plan, finalizeResult });

    await this.operationRepo.updateState(operation.id, {
      status: result.status === 'completed' ? 'done' : 'compensated',
      step: result.status === 'completed' ? 'done' : 'compensated',
      result,
      errorMessage: result.reason || null,
      finishedAt: Date.now(),
    });

    return result;
  }

  /**
   * @returns {Promise<{status:'completed'|'compensated', orchestrator?:object,
   *   reason?:string, compensations?:Array, survivingLp?:object, needsManualReview?:boolean}>}
   */
  async commit({ userId, plan, finalizeResult }) {
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
        ...buildOrchestratorPayload(plan),
      });

      const attached = await this.orchestratorService.attachLp({
        userId,
        orchestratorId: orchestrator.id,
        finalizeResult,
        protectionConfig: buildOrchestratorPayload(plan).protectionConfig,
        // El punto entero de la saga: que un fallo de cobertura llegue aquí
        // como excepción en vez de quedar en un `logger.warn`.
        protectionFailureMode: 'strict',
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
  async _compensate({ userId, plan, orchestrator, positionIdentifier }) {
    const steps = [];

    // 1. La protección puede haberse creado (y el hedge abierto) aunque
    //    `attachLp` fallara después. Se busca por identidad porque el
    //    orquestador nunca llegó a guardar su id.
    try {
      const protection = await this.protectedPoolRepository.findReusableByIdentity(userId, {
        network: plan.network,
        version: plan.version,
        walletAddress: plan.walletAddress,
        positionIdentifier,
      });

      if (protection?.status === 'active') {
        await this.protectionService.deactivateProtectedPool(userId, protection.id);
        steps.push({ id: 'hedge', ok: true, detail: `Protección #${protection.id} desactivada` });
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
        await this.repo.remove(userId, orchestrator.id);
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
