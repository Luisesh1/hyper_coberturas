/**
 * lp-orchestrator.service.js
 *
 * Capa delgada de coordinación que gestiona el ciclo de vida de un LP a
 * través del tiempo. NUNCA firma transacciones — solo evalúa, contabiliza,
 * persiste decisiones y notifica al usuario.
 *
 * Patrón de DI igual que `protected-pool-refresh.service.js` y
 * `protected-pool-dynamic.service.js`.
 */

const config = require('../config');
const db = require('../db');
const lpOrchestratorRepository = require('../repositories/lp-orchestrator.repository');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const uniswapService = require('./uniswap.service');
const positionActionsService = require('./uniswap-position-actions.service');
const uniswapProtectionService = require('./uniswap-protection.service');
const protectedPoolRefreshService = require('./protected-pool-refresh.service');
const logger = require('./logger.service');
const onChainManager = require('./onchain-manager.service');
const { ValidationError } = require('../errors/app-error');
const { computeSnapshotHash } = require('./delta-neutral-snapshot.service');

// ABIs mínimos usados por `_inspectPositionTokensOwed` y el chequeo
// directo `ownerOf`. NO toca otras funciones del PositionManager.
const V3_POSITION_MANAGER_ABI_MIN = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];
const V4_POSITION_MANAGER_ABI_MIN = [
  'function ownerOf(uint256 tokenId) view returns (address)',
];

function _getRecoveryProvider(network) {
  const networkConfig = uniswapService.SUPPORTED_NETWORKS?.[String(network || '').toLowerCase()];
  if (!networkConfig?.rpcUrl) return null;
  return onChainManager.getProvider(networkConfig, { scope: 'lp-orchestrator-recovery' });
}

const rangeEvaluator = require('./lp-orchestrator/range-evaluator');
const accounting = require('./lp-orchestrator/accounting');
const LpOrchestratorCostEstimator = require('./lp-orchestrator/cost-estimator');
const verifier = require('./lp-orchestrator/verifier');
const LpOrchestratorNotifier = require('./lp-orchestrator/notifier');

const FAILED_COOLDOWN_MS = 60 * 60 * 1000; // 1 h tras drift detectado
const POSITION_MISSING_CONFIRMATIONS = config.deltaNeutral.positionMissingConfirmations || 2;
const POSITION_MISSING_CONFIRMATION_GAP_MS = config.deltaNeutral.positionMissingConfirmationGapMs || (3 * 60_000);

class LpOrchestratorService {
  constructor(deps = {}) {
    this.repo = deps.lpOrchestratorRepository || lpOrchestratorRepository;
    this.protectedPoolRepo = deps.protectedPoolRepository || protectedPoolRepository;
    this.uniswapService = deps.uniswapService || uniswapService;
    this.positionActionsService = deps.positionActionsService || positionActionsService;
    this.uniswapProtectionService = deps.uniswapProtectionService || uniswapProtectionService;
    this.protectedPoolRefreshService = deps.protectedPoolRefreshService || protectedPoolRefreshService;
    this.rangeEvaluator = deps.rangeEvaluator || rangeEvaluator;
    this.accounting = deps.accounting || accounting;
    this.costEstimator = deps.costEstimator || new LpOrchestratorCostEstimator({
      positionActionsService: this.positionActionsService,
      logger: deps.logger || logger,
    });
    this.verifier = deps.verifier || verifier;
    this.notifier = deps.notifier || new LpOrchestratorNotifier({ logger: deps.logger || logger });
    this.logger = deps.logger || logger;
    // Inyectable para tests: si el caller no pasa `db`, usamos el real.
    // Tests con repos fake pueden pasar un stub que ejecute fn(undefined)
    // (modo no-transaccional) sin tocar el pool pg.
    this._db = deps.db || db;
  }

  /**
   * Ejecuta una secuencia de escrituras dentro de una transacción. Si el
   * `db` inyectado no soporta transacciones (tests con fake), degrada a
   * ejecución directa — los repos aceptan `executor=undefined` y usan el
   * pool global. En prod siempre hay transacción real.
   */
  async _withTransaction(fn) {
    if (this._db && typeof this._db.transaction === 'function') {
      return this._db.transaction(fn);
    }
    return fn(undefined);
  }

  // ---------- LIFECYCLE: CREATE / ATTACH / KILL / ARCHIVE ------------------

  async createOrchestrator({ userId, ...input }) {
    if (!userId) throw new ValidationError('userId es requerido');
    if (!input.name) throw new ValidationError('name es requerido');
    if (!input.network || !input.version) throw new ValidationError('network y version son requeridos');
    if (!input.walletAddress) throw new ValidationError('walletAddress es requerido');
    if (!input.token0Address || !input.token1Address) {
      throw new ValidationError('token0Address y token1Address son requeridos');
    }
    if (!input.token0Symbol || !input.token1Symbol) {
      throw new ValidationError('token0Symbol y token1Symbol son requeridos');
    }
    if (!Number.isFinite(Number(input.initialTotalUsd)) || Number(input.initialTotalUsd) <= 0) {
      throw new ValidationError('initialTotalUsd debe ser positivo');
    }
    if (!input.strategyConfig || typeof input.strategyConfig !== 'object') {
      throw new ValidationError('strategyConfig es requerido');
    }

    const now = Date.now();
    const id = await this.repo.create({
      userId,
      accountId: input.accountId ?? null,
      name: input.name,
      network: input.network,
      version: input.version,
      walletAddress: input.walletAddress,
      token0Address: input.token0Address,
      token1Address: input.token1Address,
      token0Symbol: input.token0Symbol,
      token1Symbol: input.token1Symbol,
      inferredAsset: input.inferredAsset || null,
      feeTier: input.feeTier ?? null,
      phase: 'idle',
      status: 'active',
      initialTotalUsd: Number(input.initialTotalUsd),
      strategyConfig: input.strategyConfig,
      protectionConfig: input.protectionConfig || null,
      strategyState: {},
      lastEvaluation: null,
      lastEvaluationAt: null,
      accounting: { ...this.accounting.DEFAULT_ACCOUNTING },
      createdAt: now,
      updatedAt: now,
    });

    if (!id) throw new Error('No se pudo crear el orquestador');
    return this.repo.getById(userId, id);
  }

  /**
   * Llamado por la UI tras firmar un create-position. Marca el LP como
   * activo, crea la protección si está configurada y asienta el primer
   * snapshot de contabilidad.
   */
  async attachLp({ userId, orchestratorId, finalizeResult, protectionConfig }) {
    const orch = await this._loadOrThrow(userId, orchestratorId);
    if (orch.activePositionIdentifier) {
      throw new ValidationError('Este orquestador ya tiene un LP activo. Mátalo antes de adjuntar otro.');
    }

    const newPositionIdentifier = finalizeResult?.positionChanges?.newPositionIdentifier
      || finalizeResult?.positionIdentifier
      || null;
    if (!newPositionIdentifier) {
      throw new ValidationError('No se pudo resolver la nueva positionIdentifier desde finalizeResult');
    }
    const refreshedSnapshot = finalizeResult?.refreshedSnapshot || null;

    let protectedPoolId = null;
    if (protectionConfig && protectionConfig.enabled !== false) {
      try {
        const pool = refreshedSnapshot || {
          identifier: newPositionIdentifier,
          network: orch.network,
          version: orch.version,
        };
        const protectionResult = await this.uniswapProtectionService.createProtectedPool({
          userId,
          pool,
          accountId: protectionConfig.accountId,
          leverage: protectionConfig.leverage,
          configuredNotionalUsd: protectionConfig.configuredNotionalUsd,
          stopLossDifferencePct: protectionConfig.stopLossDifferencePct,
          protectionMode: 'delta_neutral',
          bandMode: protectionConfig.bandMode,
          baseRebalancePriceMovePct: protectionConfig.baseRebalancePriceMovePct,
          rebalanceIntervalSec: protectionConfig.rebalanceIntervalSec,
          targetHedgeRatio: protectionConfig.targetHedgeRatio,
          minRebalanceNotionalUsd: protectionConfig.minRebalanceNotionalUsd,
          maxSlippageBps: protectionConfig.maxSlippageBps,
          twapMinNotionalUsd: protectionConfig.twapMinNotionalUsd,
        });
        protectedPoolId = protectionResult?.id || protectionResult?.protectedPoolId || null;
      } catch (err) {
        this.logger.warn('lp_orchestrator_protection_creation_failed', {
          orchestratorId,
          error: err.message,
        });
        // No abortamos: el LP quedó creado. Solo registramos el fallo.
      }
    }

    const newAccounting = this.accounting.incrementLpCount(orch.accounting);
    // Commit atómico de estado post-creación de LP: accounting + activeLp +
    // strategyState + log. Si algo falla entre estas escrituras el estado
    // del orquestador quedaría inconsistente con la LP ya creada on-chain.
    await this._withTransaction(async (client) => {
      await this.repo.updateAccounting(userId, orchestratorId, newAccounting, client);
      await this.repo.updateActiveLp(userId, orchestratorId, {
        activePositionIdentifier: String(newPositionIdentifier),
        activePoolAddress: refreshedSnapshot?.poolAddress || null,
        activeProtectedPoolId: protectedPoolId,
        phase: 'lp_active',
      }, client);
      // Reset del baseline del hedge y del tracking de time-in-range:
      // el próximo tick los tomará como inicio (sin computar delta) para
      // evitar doble conteo del estado del nuevo hedge / nuevo LP.
      await this.repo.updateStrategyState(userId, orchestratorId, {
        strategyState: { ...orch.strategyState, hedgeBaseline: null, timeTracking: null },
      }, client);
      await this.repo.appendActionLog({
        orchestratorId,
        kind: 'attach_lp',
        action: 'create-position',
        positionIdentifier: newPositionIdentifier,
        txHashes: finalizeResult?.txHashes || null,
        snapshotHash: refreshedSnapshot ? computeSnapshotHash(refreshedSnapshot) : null,
        payload: { protectedPoolId, protectionEnabled: !!protectionConfig?.enabled },
        createdAt: Date.now(),
      }, client);
    });

    return this.repo.getById(userId, orchestratorId);
  }

  /**
   * Lee directamente `positions(tokenId)` y `ownerOf(tokenId)` del
   * NonfungiblePositionManager (V3) para detectar el caso "decrease firmada
   * sin collect": liquidity = 0 pero tokensOwed > 0. Si el NFT ya no existe
   * o no es propiedad de la wallet, devuelve `null`. NO usa el scanner
   * indexado por etherscan — es una llamada eth_call directa, mucho más
   * barata y resiliente a fallas del scanner.
   *
   * @param {object} orch
   * @param {string|number|bigint} tokenId
   * @returns {Promise<{ tokenId, owner, liquidity, tokensOwed0, tokensOwed1, hasTokensOwed, hasLiquidity }|null>}
   */
  async _inspectPositionOnChain(orch, tokenId) {
    if (!tokenId) return null;
    const network = String(orch.network || '').toLowerCase();
    const networkConfig = uniswapService.SUPPORTED_NETWORKS?.[network];
    const version = String(orch.version || '').toLowerCase();
    const pmAddress = networkConfig?.deployments?.[version]?.positionManager;
    if (!networkConfig || !pmAddress) return null;
    const provider = _getRecoveryProvider(network);
    if (!provider) return null;

    try {
      // V4 no expone `positions()` con la misma forma que V3, así que solo
      // chequeamos `ownerOf` para v4 — el flujo de "decrease sin collect"
      // (que es lo que buscamos detectar acá) solo aplica al manager v3.
      if (version === 'v4') {
        const pm = onChainManager.getContract({ runner: provider, address: pmAddress, abi: V4_POSITION_MANAGER_ABI_MIN });
        const owner = await pm.ownerOf(BigInt(tokenId));
        if (String(owner).toLowerCase() !== String(orch.walletAddress).toLowerCase()) {
          return null;
        }
        return {
          tokenId: String(tokenId),
          owner,
          liquidity: 0n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
          hasTokensOwed: false,
          hasLiquidity: false,
        };
      }

      // Multicall3: ownerOf + positions en 1 sola RPC. Si la red no
      // soporta Multicall3 caemos al path legacy con 2 calls paralelas.
      let owner;
      let pos;
      try {
        const batch = await onChainManager.aggregate({
          networkConfig,
          scope: 'lp-orchestrator-inspect',
          calls: [
            { target: pmAddress, abi: V3_POSITION_MANAGER_ABI_MIN, method: 'ownerOf', args: [BigInt(tokenId)] },
            { target: pmAddress, abi: V3_POSITION_MANAGER_ABI_MIN, method: 'positions', args: [BigInt(tokenId)] },
          ],
        });
        owner = batch[0].value;
        pos = batch[1].value;
      } catch (mcErr) {
        this.logger.warn('lp_orchestrator_inspect_multicall_fallback', {
          orchestratorId: orch.id,
          tokenId: String(tokenId),
          network,
          error: mcErr?.message,
          code: mcErr?.code,
        });
        const pm = onChainManager.getContract({ runner: provider, address: pmAddress, abi: V3_POSITION_MANAGER_ABI_MIN });
        [owner, pos] = await Promise.all([
          pm.ownerOf(BigInt(tokenId)),
          pm.positions(BigInt(tokenId)),
        ]);
      }
      if (String(owner).toLowerCase() !== String(orch.walletAddress).toLowerCase()) {
        return null;
      }
      const liquidity = BigInt(pos.liquidity ?? 0);
      const tokensOwed0 = BigInt(pos.tokensOwed0 ?? 0);
      const tokensOwed1 = BigInt(pos.tokensOwed1 ?? 0);
      return {
        tokenId: String(tokenId),
        owner,
        liquidity,
        tokensOwed0,
        tokensOwed1,
        hasTokensOwed: tokensOwed0 > 0n || tokensOwed1 > 0n,
        hasLiquidity: liquidity > 0n,
      };
    } catch (err) {
      // Tx revierte si el NFT fue quemado o no existe — eso ya nos sirve
      // como respuesta ("no hay nada que recuperar acá"). Cualquier otro
      // error lo logueamos y devolvemos null para que el caller no lo
      // confunda con "verificado y vacío".
      const msg = String(err?.message || '');
      if (/nonexistent token|owner query for nonexistent|invalid token id/i.test(msg)) {
        return null;
      }
      this.logger.warn('lp_orchestrator_inspect_position_failed', {
        orchestratorId: orch.id,
        tokenId: String(tokenId),
        network,
        version,
        error: msg.slice(0, 200),
      });
      // Devolvemos un sentinel para que el caller distinga "fallo de RPC"
      // de "verificado y limpio". Lo marcamos con `inspectFailed`.
      return { tokenId: String(tokenId), inspectFailed: true };
    }
  }

  /**
   * Reconcilia el `activePositionIdentifier` del orquestador escaneando la
   * wallet en on-chain. Esto cubre el caso en el que el cliente abortó el
   * `recordTxFinalized` (ej. timeout del HTTP client) tras un modify-range
   * o rebalance que CAMBIÓ el tokenId, dejando al orquestador apuntando a
   * una posición vieja vacía mientras la nueva ya existe en la wallet.
   *
   * Reglas:
   *  - Si la posición actual existe y tiene liquidez > 0 → no toca nada,
   *    devuelve el pool encontrado.
   *  - Si la posición actual está vacía o no existe, busca la posición
   *    MÁS RECIENTE de la misma wallet en la misma red/versión que coincida
   *    con los tokens del orquestador (token0/token1, ignorando orden) y
   *    tenga liquidez > 0. Si la encuentra, actualiza el orquestador y la
   *    devuelve.
   *  - Si NO hay candidato vivo, ANTES de declarar alreadyClosed verifica
   *    on-chain `positions(oldIdentifier).tokensOwed`: si > 0, devuelve
   *    `{ pool: null, needsCollect: { tokenId, tokensOwed0, tokensOwed1 } }`
   *    para que el caller pueda preparar un `collect-fees` en lugar de
   *    archivar el orquestador y dejar los fondos atascados.
   *  - Si el scan on-chain falla (RPC down, timeout), devuelve
   *    `{ pool: null, reconciled: false, scanFailed: true }`. El caller
   *    debe abortar la decisión y mostrar un error temporal al usuario en
   *    lugar de asumir "wallet vacía".
   *
   * @param {object} orch
   * @returns {Promise<{ pool: object|null, reconciled: boolean, oldIdentifier: string|null, scanFailed?: boolean, needsCollect?: object }>}
   */
  async _reconcileActivePosition(orch) {
    const oldIdentifier = orch.activePositionIdentifier || null;
    let scanResult;
    let scanFailed = false;
    try {
      scanResult = await this.uniswapService.scanPoolsCreatedByWallet({
        userId: orch.userId,
        wallet: orch.walletAddress,
        network: orch.network,
        version: orch.version,
      });
    } catch (err) {
      this.logger.warn('lp_orchestrator_reconcile_scan_failed', {
        orchestratorId: orch.id,
        error: err.message,
      });
      scanFailed = true;
    }

    const pools = Array.isArray(scanResult?.pools) ? scanResult.pools : [];
    const hasLiquidity = (p) => {
      try { return BigInt(p?.liquidity || 0) > 0n; } catch { return Number(p?.liquidity || 0) > 0; }
    };

    // 1) Si la posición actual sigue viva, ya estamos.
    if (!scanFailed && oldIdentifier) {
      const current = pools.find((p) => String(p.identifier || '') === String(oldIdentifier));
      if (current && hasLiquidity(current)) {
        return { pool: current, reconciled: false, oldIdentifier };
      }
    }

    // 2) Buscar candidata: misma wallet, mismo par (en cualquier orden),
    //    misma fee tier si está definida, liquidez > 0, la más reciente.
    //    Si el scan falló, saltamos directo al fallback on-chain del NFT
    //    específico (paso 3) sin asumir que la wallet está vacía.
    const lc = (s) => String(s || '').toLowerCase();
    const tokenA = lc(orch.token0Address);
    const tokenB = lc(orch.token1Address);
    const expectedFee = orch.feeTier != null ? Number(orch.feeTier) : null;

    let newest = null;
    if (!scanFailed) {
      const candidates = pools.filter((p) => {
        if (!hasLiquidity(p)) return false;
        const t0 = lc(p.token0?.address);
        const t1 = lc(p.token1?.address);
        const matchesPair = (t0 === tokenA && t1 === tokenB) || (t0 === tokenB && t1 === tokenA);
        if (!matchesPair) return false;
        if (expectedFee != null && p.feeTier != null && Number(p.feeTier) !== expectedFee) return false;
        return true;
      });

      candidates.sort((a, b) => (Number(b.openedAt || b.createdAt || 0) - Number(a.openedAt || a.createdAt || 0)));
      newest = candidates[0] || null;
    }

    if (!newest) {
      // 3) No encontramos un candidato vivo en el scan. Antes de declarar
      //    "LP cerrado", consultamos directamente el NFT en la chain:
      //    si liquidity=0 PERO tokensOwed>0, los fondos están atascados
      //    esperando un collect() — NO debemos archivar el orquestador.
      //    Esto es exactamente el caso del bug que perdió tus fondos en el
      //    orquestador "glglgl" #11 (NFT 5412248).
      const inspection = oldIdentifier ? await this._inspectPositionOnChain(orch, oldIdentifier) : null;

      if (inspection?.inspectFailed) {
        // El RPC también falló al consultar el NFT específico. NO podemos
        // tomar una decisión segura — devolvemos scanFailed para que el
        // caller aborte y muestre un error temporal al usuario.
        return { pool: null, reconciled: false, oldIdentifier, scanFailed: true };
      }

      if (inspection?.hasTokensOwed) {
        this.logger.warn('lp_orchestrator_position_needs_collect', {
          orchestratorId: orch.id,
          tokenId: inspection.tokenId,
          tokensOwed0: inspection.tokensOwed0.toString(),
          tokensOwed1: inspection.tokensOwed1.toString(),
        });
        await this.repo.appendActionLog({
          orchestratorId: orch.id,
          kind: 'recovery',
          reason: 'needs_collect_detected',
          payload: {
            tokenId: inspection.tokenId,
            tokensOwed0: inspection.tokensOwed0.toString(),
            tokensOwed1: inspection.tokensOwed1.toString(),
          },
          createdAt: Date.now(),
        });
        return {
          pool: null,
          reconciled: false,
          oldIdentifier,
          needsCollect: {
            tokenId: inspection.tokenId,
            owner: inspection.owner,
            tokensOwed0: inspection.tokensOwed0.toString(),
            tokensOwed1: inspection.tokensOwed1.toString(),
          },
        };
      }

      if (scanFailed) {
        // Scan falló y la inspección directa del NFT (a) no encontró
        // tokensOwed o (b) devolvió null porque el NFT no nos pertenece.
        // Si ni siquiera la inspección directa nos confirmó que está vacío,
        // marcamos scanFailed para no romper nada por error.
        if (!inspection) {
          return { pool: null, reconciled: false, oldIdentifier, scanFailed: true };
        }
      }

      // El NFT existe y está completamente vacío (liquidity=0,
      // tokensOwed=0), o el NFT ya no nos pertenece. Camino seguro:
      // declarar alreadyClosed.
      return { pool: null, reconciled: false, oldIdentifier };
    }

    if (oldIdentifier && String(newest.identifier) === String(oldIdentifier)) {
      // El identificador no cambió, solo confirmamos que existe.
      return { pool: newest, reconciled: false, oldIdentifier };
    }

    // 4) Es una nueva posición distinta — actualizar el orquestador.
    //    Replicamos lo que haría `recordTxFinalized` para que la
    //    contabilidad quede coherente cuando el cliente no pudo registrar
    //    el cambio (timeout, navegador cerrado, etc.):
    //      - incrementamos lpCount (cuenta como un nuevo LP)
    //      - actualizamos activePositionIdentifier + activePoolAddress
    //      - si venía de failed, volvemos a lp_active
    //      - si hay protección activa, disparamos el refresh del hedge
    //      - logueamos en action_log como recovery con detalle
    const newAccounting = this.accounting.incrementLpCount(orch.accounting);
    // Commit atómico: accounting + activeLp + phase + log.
    await this._withTransaction(async (client) => {
      await this.repo.updateAccounting(orch.userId, orch.id, newAccounting, client);
      await this.repo.updateActiveLp(orch.userId, orch.id, {
        activePositionIdentifier: String(newest.identifier),
        activePoolAddress: newest.poolAddress || orch.activePoolAddress,
        activeProtectedPoolId: orch.activeProtectedPoolId,
      }, client);
      if (orch.phase === 'failed') {
        await this.repo.updatePhase(orch.userId, orch.id, {
          phase: 'lp_active',
          lastError: null,
          nextEligibleAttemptAt: null,
          cooldownReason: null,
        }, client);
      }
    });
    // Refresh del hedge cuando hay protección, igual que recordTxFinalized.
    if (orch.activeProtectedPoolId) {
      try {
        await this.protectedPoolRefreshService.refreshProtection(orch.userId, orch.activeProtectedPoolId);
      } catch (err) {
        this.logger.warn('lp_orchestrator_reconcile_protection_refresh_failed', {
          orchestratorId: orch.id,
          error: err.message,
        });
      }
    }
    // Invalidar cache del cost-estimator porque el snapshot cambió.
    if (typeof this.costEstimator?.invalidate === 'function') {
      this.costEstimator.invalidate(orch.id);
    }
    await this.repo.appendActionLog({
      orchestratorId: orch.id,
      kind: 'recovery',
      reason: 'reconciled_position_identifier',
      payload: {
        oldIdentifier,
        newIdentifier: String(newest.identifier),
        newPoolAddress: newest.poolAddress || null,
        triggeredBy: 'monitor_or_kill_lp',
        appliedLpCount: true,
      },
      createdAt: Date.now(),
    });
    this.logger.info('lp_orchestrator_position_reconciled', {
      orchestratorId: orch.id,
      oldIdentifier,
      newIdentifier: String(newest.identifier),
      lpCount: newAccounting.lpCount,
    });
    return { pool: newest, reconciled: true, oldIdentifier };
  }

  /**
   * Prepara el cierre del LP activo. La acción usada es `close-to-usdc` por
   * defecto (consistente con la decisión de producto: al cerrar al final
   * convertimos a stablecoin). El usuario sigue firmando vía
   * PositionActionModal.
   *
   * Antes de preparar el tx intenta reconciliar el `activePositionIdentifier`
   * con la wallet on-chain — esto cubre el caso en el que el orquestador
   * quedó apuntando a una posición vacía tras un modify-range cuyo
   * `recordTxFinalized` no llegó al backend (timeout del cliente, etc).
   *
   * Si tras reconciliar NO hay ninguna posición viva del par en la wallet,
   * devuelve `{ alreadyClosed: true }` y limpia el `activePositionIdentifier`
   * del orquestador para que el caller pueda archivarlo directamente.
   */
  async killLp({ userId, orchestratorId, mode = 'auto' }) {
    const orch = await this._loadOrThrow(userId, orchestratorId);
    if (!orch.activePositionIdentifier) {
      throw new ValidationError('No hay LP activo para cerrar');
    }

    // Intento de recovery: si la posición está vacía o el identificador
    // está desactualizado, intentamos engancharnos a la nueva posición o
    // detectar que ya no hay nada que cerrar.
    const reconcile = await this._reconcileActivePosition(orch);

    if (reconcile.scanFailed) {
      // El RPC está caído / inestable. NO podemos tomar una decisión
      // segura — abortamos el kill con un error temporal en lugar de
      // archivar el orquestador a ciegas (Bug #3 que perdió fondos).
      this.logger.warn('lp_orchestrator_kill_aborted_scan_failed', {
        orchestratorId,
        previousIdentifier: reconcile.oldIdentifier,
      });
      throw new ValidationError(
        'No se pudo verificar el estado del LP en on-chain (RPC inestable). '
        + 'Esperá unos segundos y volvé a intentar antes de archivar.'
      );
    }

    if (reconcile.needsCollect) {
      // La posición tiene `tokensOwed > 0` (decrease firmado sin collect).
      // En vez de declarar alreadyClosed (que dejaría los fondos
      // atascados), preparamos una acción `collect-fees` para que el
      // usuario firme una sola tx y recupere todo. NO limpiamos el
      // identifier hasta que el collect se confirme on-chain via
      // recordTxFinalized.
      this.logger.info('lp_orchestrator_kill_redirected_to_collect', {
        orchestratorId,
        tokenId: reconcile.needsCollect.tokenId,
        tokensOwed0: reconcile.needsCollect.tokensOwed0,
        tokensOwed1: reconcile.needsCollect.tokensOwed1,
      });
      const prepareResult = await this.positionActionsService.preparePositionAction({
        action: 'collect-fees',
        payload: {
          network: orch.network,
          version: orch.version,
          walletAddress: orch.walletAddress,
          positionIdentifier: reconcile.needsCollect.tokenId,
        },
      });
      await this.repo.appendActionLog({
        orchestratorId,
        kind: 'kill_lp',
        action: 'collect-fees',
        positionIdentifier: reconcile.needsCollect.tokenId,
        payload: {
          mode,
          redirectedToCollect: true,
          reason: 'tokens_owed_pending_collect',
          tokensOwed0: reconcile.needsCollect.tokensOwed0,
          tokensOwed1: reconcile.needsCollect.tokensOwed1,
        },
        createdAt: Date.now(),
      });
      return {
        action: 'collect-fees',
        prepareResult,
        needsCollect: true,
        tokensOwed: {
          token0: reconcile.needsCollect.tokensOwed0,
          token1: reconcile.needsCollect.tokensOwed1,
        },
      };
    }

    if (!reconcile.pool) {
      // No hay ninguna posición viva del par en la wallet → el LP ya está
      // cerrado on-chain. Limpiamos el identificador del orquestador para
      // que el `archive` siguiente no falle, y devolvemos un marcador para
      // que el cliente sepa que no hay nada que firmar.
      await this.repo.updateActiveLp(userId, orchestratorId, {
        activePositionIdentifier: null,
        activePoolAddress: null,
        activeProtectedPoolId: null,
        phase: 'idle',
      });
      await this.repo.appendActionLog({
        orchestratorId,
        kind: 'recovery',
        reason: 'lp_already_closed_on_chain',
        payload: { previousIdentifier: reconcile.oldIdentifier, mode },
        createdAt: Date.now(),
      });
      this.logger.info('lp_orchestrator_kill_skipped_already_closed', {
        orchestratorId,
        previousIdentifier: reconcile.oldIdentifier,
      });
      return { action: null, prepareResult: null, alreadyClosed: true };
    }

    // Releer el orquestador si la reconciliación cambió el identificador.
    const orchEffective = reconcile.reconciled
      ? await this._loadOrThrow(userId, orchestratorId)
      : orch;

    // mode: 'auto' = close-to-usdc si hay stable en el par, sino keep-assets
    // mode: 'usdc' = forzar close-to-usdc, mode: 'keep' = forzar keep-assets
    let action;
    if (mode === 'usdc') action = 'close-to-usdc';
    else if (mode === 'keep') action = 'close-keep-assets';
    else action = this._hasStableInPair(orchEffective) ? 'close-to-usdc' : 'close-keep-assets';

    const prepareResult = await this.positionActionsService.preparePositionAction({
      action,
      payload: {
        network: orchEffective.network,
        version: orchEffective.version,
        walletAddress: orchEffective.walletAddress,
        positionIdentifier: orchEffective.activePositionIdentifier,
      },
    });

    await this.repo.appendActionLog({
      orchestratorId,
      kind: 'kill_lp',
      action,
      positionIdentifier: orchEffective.activePositionIdentifier,
      payload: { mode, reconciled: reconcile.reconciled },
      createdAt: Date.now(),
    });

    return { action, prepareResult, reconciled: reconcile.reconciled };
  }

  /**
   * Llamado tras firmar y finalizar una acción on-chain. Corre el verifier,
   * actualiza la contabilidad y, si la acción cambió el rango y hay
   * protección activa, dispara el refresh del hedge.
   */
  async recordTxFinalized({ userId, orchestratorId, action, finalizeResult, expected = {} }) {
    const orch = await this._loadOrThrow(userId, orchestratorId);

    // Idempotencia: si ya registramos un tx_finalized con cualquiera de
    // los mismos txHashes, evitamos volver a aplicar costos / lpCount.
    // Esto cubre el caso en el que el cliente reintenta tras un timeout
    // (HTTP 4 min de timeout pero la op tomó >5 min, etc).
    const incomingTxHashes = Array.isArray(finalizeResult?.txHashes)
      ? finalizeResult.txHashes.filter(Boolean).map(String)
      : [];
    if (incomingTxHashes.length > 0 && typeof this.repo.findFinalizedByTxHash === 'function') {
      const existing = await this.repo.findFinalizedByTxHash(orchestratorId, incomingTxHashes);
      if (existing) {
        this.logger.info('lp_orchestrator_record_tx_finalized_idempotent_skip', {
          orchestratorId,
          existingLogId: existing.id,
          txHashes: incomingTxHashes,
        });
        return {
          verification: { ok: true, severity: null, drifts: [] },
          orchestrator: orch,
          alreadyRecorded: true,
        };
      }
    }

    await this.repo.updatePhase(userId, orchestratorId, { phase: 'verifying' });

    const refreshedSnapshot = finalizeResult?.refreshedSnapshot || null;
    const verification = this.verifier.verifyExpectedState({
      action,
      expected,
      refreshedSnapshot,
    });

    // Estimar costo realizado del tx (gas + slippage). Usamos los costos
    // estimados que el prepareResult del cliente debió enviar como expected.
    //
    // Para increase-/decrease-liquidity computamos el delta de capital
    // comparando el `currentValueUsd` del refreshedSnapshot (post-tx) contra
    // el del último snapshot evaluado (pre-tx). Esto reusa la misma fuente
    // de valuación que el resto del orquestador y evita pedirle al cliente
    // que envíe el dato. NO afecta el netPnl, solo se acumula en
    // `capitalAdjustmentsUsd` y se usa para resetear el baseline de
    // price-drift abajo, así la próxima evaluación no contabiliza el cambio
    // de capital como deriva de precio.
    const isCapitalAction = action === 'increase-liquidity' || action === 'decrease-liquidity';
    let capitalDeltaUsd = 0;
    if (isCapitalAction && refreshedSnapshot && orch.lastEvaluation?.poolSnapshot) {
      const prevValue = Number(orch.lastEvaluation.poolSnapshot.currentValueUsd) || 0;
      const postValue = Number(refreshedSnapshot.currentValueUsd) || 0;
      capitalDeltaUsd = postValue - prevValue;
    }
    const txCost = {
      gasCostUsd: Number(expected.gasCostUsd) || 0,
      slippageCostUsd: Number(expected.slippageCostUsd) || 0,
      collectedFeesUsd: action === 'collect-fees' || action === 'reinvest-fees'
        ? Number(expected.collectedFeesUsd) || 0
        : 0,
      capitalDeltaUsd,
    };
    // Resolver el possible cambio de positionIdentifier (modify-range, rebalance v3 con redeploy)
    // y aplicar costos + lpCount en una única escritura para no dejar la
    // contabilidad parcialmente actualizada si la segunda escritura falla.
    const newPositionIdentifier = finalizeResult?.positionChanges?.newPositionIdentifier;
    const isNewLp = Boolean(
      newPositionIdentifier && newPositionIdentifier !== orch.activePositionIdentifier
    );
    let newAccounting = this.accounting.applyTxCostDelta(orch.accounting, txCost);
    if (isNewLp) {
      // re-range cuenta como nuevo LP a efectos de lpCount
      newAccounting = this.accounting.incrementLpCount(newAccounting);
    }
    await this.repo.updateAccounting(userId, orchestratorId, newAccounting);

    // Si hubo un cambio de capital (increase/decrease liquidity), reseteamos
    // el baseline de price-drift en `lastEvaluation.poolSnapshot.currentValueUsd`
    // sumando el delta. Así el próximo `_evaluateOne` no contabiliza el
    // capital agregado/retirado como deriva de precio.
    if (capitalDeltaUsd !== 0 && orch.lastEvaluation?.poolSnapshot) {
      const prevValue = Number(orch.lastEvaluation.poolSnapshot.currentValueUsd) || 0;
      const adjustedSnapshot = {
        ...orch.lastEvaluation.poolSnapshot,
        currentValueUsd: prevValue + capitalDeltaUsd,
      };
      await this.repo.updateStrategyState(userId, orchestratorId, {
        lastEvaluation: {
          ...orch.lastEvaluation,
          poolSnapshot: adjustedSnapshot,
        },
      });
    }

    if (isNewLp) {
      await this.repo.updateActiveLp(userId, orchestratorId, {
        activePositionIdentifier: String(newPositionIdentifier),
        activePoolAddress: refreshedSnapshot?.poolAddress || orch.activePoolAddress,
        activeProtectedPoolId: orch.activeProtectedPoolId,
      });
    }

    // Acciones de cierre dejan el orquestador en idle
    let nextPhase = 'lp_active';
    if (action === 'close-to-usdc' || action === 'close-keep-assets') {
      // Flush final del hedge state al accounting del orquestador antes de
      // deslindar la protección. Sin esto, los fills reconciliados durante
      // la desactivación (realized PnL, fees) se pierden porque el
      // orquestador ya no lee la protección después de limpiar el link.
      if (orch.activeProtectedPoolId) {
        try {
          const protection = await this.protectedPoolRepo.getById(userId, orch.activeProtectedPoolId);
          const finalHedgeState = this.accounting.readHedgeStateFromProtection(protection);
          if (finalHedgeState) {
            const prevBaseline = orch.strategyState?.hedgeBaseline || null;
            const result = this.accounting.applyHedgeStateDelta(newAccounting, prevBaseline, finalHedgeState);
            newAccounting = result.accounting;
          }
          // Zeroize unrealized ya que el hedge se está cerrando
          const zeroResult = this.accounting.applyHedgeStateDelta(newAccounting, null, null);
          newAccounting = zeroResult.accounting;
        } catch (err) {
          this.logger.warn('lp_orchestrator_final_hedge_flush_failed', {
            orchestratorId: orch.id, protectedPoolId: orch.activeProtectedPoolId, error: err.message,
          });
        }
      }
      // Commit atómico del cierre: accounting + activeLp reset + strategyState.
      await this._withTransaction(async (client) => {
        await this.repo.updateAccounting(userId, orchestratorId, newAccounting, client);
        await this.repo.updateActiveLp(userId, orchestratorId, {
          activePositionIdentifier: null,
          activePoolAddress: null,
          activeProtectedPoolId: null,
          phase: 'idle',
        }, client);
        // Reset baseline del hedge y del tracking de time-in-range: el siguiente
        // attachLp empezará un hedge fresco y un nuevo conteo de tiempo en rango.
        await this.repo.updateStrategyState(userId, orchestratorId, {
          strategyState: { ...orch.strategyState, hedgeBaseline: null, timeTracking: null },
        }, client);
      });
      nextPhase = 'idle';
      this.notifier.lpKilled(orch).catch((err) => logger.warn('lp_orch_non_critical_failure', { error: err.message }));
    }

    if (!verification.ok && verification.severity === 'critical') {
      await this.repo.updatePhase(userId, orchestratorId, {
        phase: 'failed',
        lastError: `verification_failed:${verification.drifts.map((d) => d.kind).join(',')}`,
        nextEligibleAttemptAt: Date.now() + FAILED_COOLDOWN_MS,
        cooldownReason: 'verification_failed',
      });
      this.notifier.verificationFailed(orch, { drifts: verification.drifts, action }).catch((err) => logger.warn('lp_orch_non_critical_failure', { error: err.message }));
    } else {
      await this.repo.updatePhase(userId, orchestratorId, {
        phase: nextPhase,
        lastError: null,
        nextEligibleAttemptAt: null,
        cooldownReason: null,
      });
      // Una acción exitosa resuelve el estado urgent: limpiamos el alert.
      await this.repo.clearUrgentAlert(userId, orchestratorId).catch((err) => logger.warn('lp_orch_non_critical_failure', { error: err.message }));
      this.notifier.actionFinalized(orch, { action, drifts: verification.drifts }).catch((err) => logger.warn('lp_orch_non_critical_failure', { error: err.message }));
    }

    await this.repo.appendActionLog({
      orchestratorId,
      kind: 'tx_finalized',
      action,
      positionIdentifier: newPositionIdentifier || orch.activePositionIdentifier,
      txHashes: finalizeResult?.txHashes || null,
      verificationStatus: verification.ok ? 'ok' : verification.severity,
      driftDetails: verification.drifts,
      realizedCostUsd: txCost.gasCostUsd + txCost.slippageCostUsd,
      accountingDelta: txCost,
      createdAt: Date.now(),
    });

    // Si hubo cambio de rango y hay protección activa, refrescar protección
    if ((action === 'modify-range' || action === 'rebalance')
        && orch.activeProtectedPoolId) {
      try {
        await this.protectedPoolRefreshService.refreshProtection(userId, orch.activeProtectedPoolId);
      } catch (err) {
        this.logger.warn('lp_orchestrator_protection_refresh_failed', {
          orchestratorId,
          error: err.message,
        });
      }
    }

    // Invalidar cache del cost-estimator porque el snapshot cambió.
    if (typeof this.costEstimator?.invalidate === 'function') {
      this.costEstimator.invalidate(orchestratorId);
    }

    return {
      verification,
      orchestrator: await this.repo.getById(userId, orchestratorId),
    };
  }

  /**
   * Actualiza strategyConfig y/o protectionConfig del orquestador.
   * - `strategyConfig` se mergea campo a campo (patch), conservando los
   *   valores previos para los campos no enviados.
   * - `protectionConfig` se reemplaza completo (el schema es una union
   *   enabled/disabled que no tiene sentido mezclar parcialmente).
   *
   * Los cambios en `protectionConfig` sólo afectan al próximo LP que se
   * adjunte: la proteccion activa ya tiene su configuracion copiada en
   * `protected_uniswap_pools` y mover esos campos en caliente requiere
   * invariantes adicionales (cerrar posicion, reabrir, etc.).
   */
  async updateConfig({ userId, orchestratorId, strategyConfig, protectionConfig }) {
    const orch = await this._loadOrThrow(userId, orchestratorId);
    if (orch.status === 'archived') {
      throw new ValidationError('No se puede editar un orquestador archivado');
    }
    if (!strategyConfig && !protectionConfig) {
      throw new ValidationError('Debe enviarse strategyConfig o protectionConfig');
    }

    const nextStrategy = strategyConfig
      ? { ...(orch.strategyConfig || {}), ...strategyConfig }
      : undefined;
    const nextProtection = protectionConfig !== undefined ? protectionConfig : undefined;

    await this.repo.updateConfig(userId, orchestratorId, {
      strategyConfig: nextStrategy,
      protectionConfig: nextProtection,
    });
    await this.repo.appendActionLog({
      orchestratorId,
      kind: 'config_updated',
      action: 'update_config',
      payload: {
        changedStrategy: nextStrategy ? Object.keys(strategyConfig) : [],
        changedProtection: nextProtection !== undefined,
      },
      createdAt: Date.now(),
    });
    return this.repo.getById(userId, orchestratorId);
  }

  async archive({ userId, orchestratorId }) {
    const orch = await this._loadOrThrow(userId, orchestratorId);
    if (orch.activePositionIdentifier) {
      throw new ValidationError('Cierra el LP activo antes de archivar el orquestador');
    }
    await this.repo.archive(userId, orchestratorId);
    await this.repo.appendActionLog({
      orchestratorId,
      kind: 'archive',
      createdAt: Date.now(),
    });
    return this.repo.getById(userId, orchestratorId);
  }

  // ---------- EVALUATION LOOP ---------------------------------------------

  async evaluateAll() {
    const orchestrators = await this.repo.listActiveForLoop();
    for (const orch of orchestrators) {
      try {
        await this._evaluateOne(orch);
      } catch (err) {
        this.logger.warn('lp_orchestrator_eval_failed', {
          orchestratorId: orch.id,
          userId: orch.userId,
          error: err.message,
        });
      }
    }
    return { evaluated: orchestrators.length };
  }

  async evaluateOne(userId, orchestratorId) {
    const orch = await this._loadOrThrow(userId, orchestratorId);
    return this._evaluateOne(orch);
  }

  /**
   * Reconcilia el `activePositionIdentifier` del orquestador escaneando la
   * wallet, sin correr el ciclo completo de evaluación. Útil para que la
   * UI dispare un recovery inmediato tras un timeout en finalize sin
   * esperar al loop del monitor.
   */
  async reconcileOne(userId, orchestratorId) {
    const orch = await this._loadOrThrow(userId, orchestratorId);
    if (!orch.activePositionIdentifier && orch.phase !== 'failed') {
      return { skipped: 'no_active_lp', reconciled: false };
    }
    const result = await this._reconcileActivePosition(orch);

    // Si la reconciliacion encontro una posicion viva Y el orquestador
    // estaba en `failed` por `position_not_found`, lo rescatamos: limpiamos
    // el phase, cooldown y contador de missing detections. Esto cubre el
    // caso donde una accion "reduce-liquidity" puso al orquestador en
    // missing_pending -> failed porque un tick transitorio del RPC/scan
    // no vio la posicion, pero on-chain sigue viva. Sin este reset, el
    // usuario llamaba /reconcile y la respuesta decia que la pool existe
    // pero el orquestador seguia en failed hasta que expirara el cooldown.
    let recovered = false;
    if (result.pool && orch.phase === 'failed' && orch.lastError === 'position_not_found') {
      const now = Date.now();
      await this.repo.updatePhase(userId, orchestratorId, {
        phase: 'lp_active',
        lastError: null,
        nextEligibleAttemptAt: null,
        cooldownReason: null,
        updatedAt: now,
      });
      await this.repo.updateStrategyState(userId, orchestratorId, {
        strategyState: {
          ...(orch.strategyState || {}),
          consecutiveMissingDetections: 0,
          lastMissingDetectedAt: null,
        },
      });
      await this.repo.appendActionLog({
        orchestratorId,
        kind: 'recovery',
        reason: 'position_recovered_via_reconcile',
        payload: {
          oldIdentifier: result.oldIdentifier,
          identifier: result.pool.identifier != null ? String(result.pool.identifier) : null,
          liquidity: result.pool.liquidity != null ? String(result.pool.liquidity) : null,
        },
        createdAt: now,
      });
      this.logger.info('lp_orchestrator_position_recovered', {
        orchestratorId,
        oldIdentifier: result.oldIdentifier,
        identifier: result.pool.identifier,
      });
      recovered = true;
    }

    return {
      reconciled: result.reconciled,
      hasPool: Boolean(result.pool),
      oldIdentifier: result.oldIdentifier,
      newIdentifier: result.pool?.identifier ? String(result.pool.identifier) : null,
      recovered,
    };
  }

  /**
   * Escanea la wallet del orquestador buscando posiciones LP existentes
   * que coincidan con el par + red + version + fee tier configurados,
   * y que TODAVÍA tengan liquidez. Devuelve los candidatos para que el
   * usuario pueda "adoptar" uno (vincularlo al orquestador) sin firmar.
   *
   * Caso de uso: si el usuario creó un LP pero el `attachLp` falló (por
   * ejemplo el server estaba reiniciándose), el LP quedó huérfano en la
   * wallet. Esta función lo encuentra para que el usuario pueda
   * adoptarlo desde la UI con un click.
   */
  async discoverAdoptableLps(userId, orchestratorId) {
    const orch = await this._loadOrThrow(userId, orchestratorId);
    if (orch.activePositionIdentifier) {
      return { candidates: [], reason: 'already_has_lp' };
    }

    let scanResult;
    try {
      scanResult = await this.uniswapService.scanPoolsCreatedByWallet({
        userId: orch.userId,
        wallet: orch.walletAddress,
        network: orch.network,
        version: orch.version,
      });
    } catch (err) {
      this.logger.warn('lp_orchestrator_discover_scan_failed', {
        orchestratorId,
        error: err.message,
      });
      return { candidates: [], reason: 'scan_failed', error: err.message };
    }

    const lc = (s) => String(s || '').toLowerCase();
    const tokenA = lc(orch.token0Address);
    const tokenB = lc(orch.token1Address);
    const expectedFee = orch.feeTier != null ? Number(orch.feeTier) : null;
    const hasLiquidity = (p) => {
      try { return BigInt(p?.liquidity || 0) > 0n; } catch { return Number(p?.liquidity || 0) > 0; }
    };

    const candidates = (scanResult?.pools || [])
      .filter((p) => {
        if (!hasLiquidity(p)) return false;
        const t0 = lc(p.token0?.address);
        const t1 = lc(p.token1?.address);
        const matchesPair = (t0 === tokenA && t1 === tokenB) || (t0 === tokenB && t1 === tokenA);
        if (!matchesPair) return false;
        if (expectedFee != null && p.feeTier != null && Number(p.feeTier) !== expectedFee) return false;
        return true;
      })
      .map((p) => ({
        identifier: String(p.identifier || ''),
        poolAddress: p.poolAddress || null,
        token0Symbol: p.token0?.symbol || null,
        token1Symbol: p.token1?.symbol || null,
        feeTier: p.feeTier != null ? Number(p.feeTier) : null,
        liquidity: String(p.liquidity || '0'),
        currentValueUsd: Number(p.currentValueUsd || 0),
        rangeLowerPrice: p.rangeLowerPrice ?? null,
        rangeUpperPrice: p.rangeUpperPrice ?? null,
        inRange: p.inRange === true,
        openedAt: p.openedAt || p.createdAt || null,
      }))
      .sort((a, b) => Number(b.openedAt || 0) - Number(a.openedAt || 0));

    return {
      candidates,
      reason: candidates.length === 0 ? 'no_matches' : 'ok',
    };
  }

  /**
   * Adopta una posición LP existente de la wallet vinculándola al
   * orquestador. Equivalente a `attachLp`, pero en lugar de tomar el
   * `newPositionIdentifier` desde un `finalizeResult` (un create-position
   * recién firmado), lo toma directamente del identifier que el usuario
   * eligió en la lista de candidatos devuelta por `discoverAdoptableLps`.
   *
   * Esto permite recuperar LPs creados pero no vinculados (caso del bug
   * de race condition con shutdown del server durante attach-lp).
   */
  async adoptLp(userId, orchestratorId, { positionIdentifier, protectionConfig } = {}) {
    if (!positionIdentifier) {
      throw new ValidationError('positionIdentifier es requerido para adoptar un LP existente');
    }
    const orch = await this._loadOrThrow(userId, orchestratorId);
    if (orch.activePositionIdentifier) {
      throw new ValidationError('Este orquestador ya tiene un LP activo. No se puede adoptar otro.');
    }

    // Verificar que el NFT realmente le pertenece a la wallet del orquestador
    // y que coincide con el par configurado. _inspectPositionOnChain hace una
    // lectura on-chain directa (multicall ownerOf+positions) sin depender del
    // scanner de etherscan, por si el scan falla.
    const inspection = await this._inspectPositionOnChain(orch, positionIdentifier);
    if (!inspection || inspection.inspectFailed) {
      throw new ValidationError(
        `No se pudo verificar la posición ${positionIdentifier} en la wallet ${orch.walletAddress}`
      );
    }
    if (!inspection.hasLiquidity) {
      throw new ValidationError(
        `La posición ${positionIdentifier} no tiene liquidez activa. No se puede adoptar.`
      );
    }

    // Construimos un finalizeResult sintético para reusar attachLp.
    // refreshedSnapshot lo dejamos null: el monitor lo llenará en la
    // próxima evaluación.
    const syntheticFinalize = {
      action: 'create-position',
      txHashes: [],
      positionChanges: {
        oldPositionIdentifier: null,
        newPositionIdentifier: String(positionIdentifier),
      },
      refreshedSnapshot: null,
    };

    return this.attachLp({
      userId,
      orchestratorId,
      finalizeResult: syntheticFinalize,
      protectionConfig: protectionConfig || orch.protectionConfig || { enabled: false },
    });
  }

  async _evaluateOne(orch) {
    if (orch.status !== 'active') return { skipped: 'not_active' };
    if (orch.phase === 'idle' || !orch.activePositionIdentifier) {
      return { skipped: 'no_active_lp' };
    }

    const hasLiquidity = (p) => {
      try { return BigInt(p?.liquidity || 0) > 0n; } catch { return Number(p?.liquidity || 0) > 0; }
    };
    let pool = null;
    const canInspectDirectly = typeof this.uniswapService.inspectPositionByIdentifier === 'function';
    // Usamos lightweight para la mayoría de evaluaciones (ahorra RPC).
    // Si no tenemos priceAtOpen previo, hacemos UN scan completo para resolverlo.
    const hasPriceAtOpen = orch.lastEvaluation?.poolSnapshot?.priceAtOpen != null;
    if (canInspectDirectly) {
      try {
        pool = await this.uniswapService.inspectPositionByIdentifier({
          userId: orch.userId,
          wallet: orch.walletAddress,
          network: orch.network,
          version: orch.version,
          positionIdentifier: orch.activePositionIdentifier,
          lightweight: hasPriceAtOpen,
        });
      } catch (err) {
        this.logger.warn('lp_orchestrator_direct_inspect_failed', {
          orchestratorId: orch.id,
          positionIdentifier: orch.activePositionIdentifier,
          error: err.message,
        });
      }
    }

    // Recovery: si la posición original no aparece o está vacía, intentamos
    // reconciliar buscando una nueva posición del mismo par en la wallet.
    // Esto cubre el caso en el que `recordTxFinalized` no pudo correr tras
    // un modify-range que cambió el tokenId (ej. timeout del cliente).
    if (!pool || !hasLiquidity(pool)) {
      const reconcile = await this._reconcileActivePosition(orch);

      if (reconcile.scanFailed) {
        // RPC inestable. NO marcamos failed (sería ruido en el monitor).
        // Saltamos este tick y reintentamos en el siguiente.
        this.logger.warn('lp_orchestrator_eval_skipped_scan_failed', {
          orchestratorId: orch.id,
        });
        return { skipped: 'scan_failed' };
      }

      if (reconcile.needsCollect) {
        // Detectamos `tokensOwed > 0` (decrease firmada sin collect).
        // No marcamos failed: el orquestador sigue activo, solo dejamos
        // un log y una notificación para que el usuario haga el collect
        // manualmente. La acción de collect no se puede disparar
        // automáticamente porque requiere firma.
        this.logger.warn('lp_orchestrator_eval_needs_collect', {
          orchestratorId: orch.id,
          tokenId: reconcile.needsCollect.tokenId,
          tokensOwed0: reconcile.needsCollect.tokensOwed0,
          tokensOwed1: reconcile.needsCollect.tokensOwed1,
        });
        return { skipped: 'needs_collect', needsCollect: reconcile.needsCollect };
      }

      if (reconcile.pool) {
        pool = reconcile.pool;
        if (reconcile.reconciled) {
          // Releemos el orquestador para tener el identificador actualizado
          // antes de continuar con la evaluación.
          orch = await this.repo.getById(orch.userId, orch.id);
        }
      } else {
        const now = Date.now();
        const strategyState = { ...(orch.strategyState || {}) };
        const lastMissingAt = Number(strategyState.lastMissingDetectedAt || 0);
        const withinWindow = lastMissingAt > 0 && (now - lastMissingAt) <= POSITION_MISSING_CONFIRMATION_GAP_MS;
        const consecutiveMissingDetections = withinWindow
          ? Number(strategyState.consecutiveMissingDetections || 0) + 1
          : 1;

        await this.repo.updateStrategyState(orch.userId, orch.id, {
          strategyState: {
            ...strategyState,
            consecutiveMissingDetections,
            lastMissingDetectedAt: now,
          },
          lastEvaluation: {
            ...(orch.lastEvaluation || {}),
            status: 'position_missing_pending',
            consecutiveMissingDetections,
          },
          lastEvaluationAt: now,
          lastDecision: 'truth_pending',
        });

        if (consecutiveMissingDetections < POSITION_MISSING_CONFIRMATIONS) {
          await this.repo.appendActionLog({
            orchestratorId: orch.id,
            kind: 'recovery',
            reason: 'position_missing_pending',
            payload: { consecutiveMissingDetections },
            createdAt: now,
          });
          return { skipped: 'position_missing_pending', confirmations: consecutiveMissingDetections };
        }

        await this.repo.updatePhase(orch.userId, orch.id, {
          phase: 'failed',
          lastError: 'position_not_found',
          nextEligibleAttemptAt: now + FAILED_COOLDOWN_MS,
          cooldownReason: 'position_not_found',
        });
        await this.repo.appendActionLog({
          orchestratorId: orch.id,
          kind: 'recovery',
          reason: 'position_not_found',
          payload: { consecutiveMissingDetections },
          createdAt: now,
        });
        this.notifier.positionMissing(orch).catch((err) => logger.warn('lp_orch_non_critical_failure', { error: err.message }));
        return { decision: 'failed' };
      }
    }

    if (Number(orch.strategyState?.consecutiveMissingDetections || 0) > 0) {
      await this.repo.updateStrategyState(orch.userId, orch.id, {
        strategyState: {
          ...(orch.strategyState || {}),
          consecutiveMissingDetections: 0,
          lastMissingDetectedAt: null,
        },
      });
      orch = await this.repo.getById(orch.userId, orch.id);
    }

    // Auto-recovery: si el orquestador venia en `failed` por
    // `position_not_found` pero ahora hemos encontrado una pool viva
    // (reconcile o inspect), limpiamos el estado de error y el cooldown
    // para que el loop siga operando normalmente.
    if (orch.phase === 'failed' && orch.lastError === 'position_not_found') {
      await this.repo.updatePhase(orch.userId, orch.id, {
        phase: 'lp_active',
        lastError: null,
        nextEligibleAttemptAt: null,
        cooldownReason: null,
      });
      await this.repo.appendActionLog({
        orchestratorId: orch.id,
        kind: 'recovery',
        reason: 'position_auto_recovered',
        payload: {
          identifier: pool.identifier != null ? String(pool.identifier) : null,
          liquidity: pool.liquidity != null ? String(pool.liquidity) : null,
        },
        createdAt: Date.now(),
      });
      this.logger.info('lp_orchestrator_position_auto_recovered', {
        orchestratorId: orch.id,
        identifier: pool.identifier,
      });
      orch = await this.repo.getById(orch.userId, orch.id);
    }

    const snapshotHash = computeSnapshotHash(pool);

    // Carry-forward: el scan lightweight omite priceAtOpen y valuación
    // inicial para ahorrar RPC. Si el snapshot anterior ya los resolvió,
    // los preservamos para que la UI y la contabilidad los tengan siempre.
    const prevSnapshot = orch.lastEvaluation?.poolSnapshot || null;
    if (prevSnapshot && prevSnapshot.priceAtOpen != null) {
      const carryFields = [
        'priceAtOpen', 'priceAtOpenAccuracy', 'priceAtOpenSource', 'priceAtOpenBlock',
      ];
      for (const field of carryFields) {
        if (pool[field] == null || pool[field] === 'unavailable') {
          pool[field] = prevSnapshot[field] ?? pool[field];
        }
      }
    }
    if (prevSnapshot) {
      const valuationFields = [
        'initialValueUsd', 'initialValueUsdAccuracy', 'initialValueUsdSource',
        'initialAmount0', 'initialAmount1',
      ];
      for (const field of valuationFields) {
        if (pool[field] == null && prevSnapshot[field] != null) {
          pool[field] = prevSnapshot[field];
        }
      }
    }

    // 2) Delta de contabilidad del LP (fees acumuladas + deriva de precio).
    //    Gas y slippage de swaps se aplican en recordTxFinalized.

    const delta = this.accounting.computeAccountingDelta(prevSnapshot, pool);
    let newAccounting = this.accounting.applyAccountingDelta(orch.accounting, delta);

    // 2b) Delta de costos del hedge: si la protección está activa, leemos su
    //     strategyState (donde el motor delta-neutral persiste funding,
    //     execution fees, slippage, realized + unrealized PnL) y aplicamos
    //     la diferencia contra el baseline guardado en el orquestador.
    let newHedgeBaseline = orch.strategyState?.hedgeBaseline || null;
    if (orch.activeProtectedPoolId) {
      try {
        const protection = await this.protectedPoolRepo.getById(orch.userId, orch.activeProtectedPoolId);
        const currentHedgeState = this.accounting.readHedgeStateFromProtection(protection);
        if (currentHedgeState) {
          const result = this.accounting.applyHedgeStateDelta(
            newAccounting,
            newHedgeBaseline,
            currentHedgeState
          );
          newAccounting = result.accounting;
          newHedgeBaseline = result.hedgeBaseline;
        }
      } catch (err) {
        this.logger.warn('lp_orchestrator_hedge_state_load_failed', {
          orchestratorId: orch.id,
          protectedPoolId: orch.activeProtectedPoolId,
          error: err.message,
        });
      }
    } else {
      // Sin protección activa: zeroize el unrealized del hedge en el accounting
      // (los acumuladores se preservan porque pueden venir de hedges anteriores).
      const result = this.accounting.applyHedgeStateDelta(newAccounting, null, null);
      newAccounting = result.accounting;
      newHedgeBaseline = null;
    }

    // 3) Range eval
    const evaluation = this.rangeEvaluator.evaluateRangePosition({
      priceCurrent: Number(pool.priceCurrent),
      rangeLowerPrice: Number(pool.rangeLowerPrice),
      rangeUpperPrice: Number(pool.rangeUpperPrice),
      edgeMarginPct: Number(orch.strategyConfig?.edgeMarginPct ?? 40),
    });

    // 3b) Time-in-range tracking incremental.
    //
    // Acumulamos cuánto tiempo ha vivido el LP dentro y fuera del rango.
    // El delta del tick anterior (lastTimeInRangeAt → ahora) se atribuye al
    // ÚLTIMO estado conocido (lastInRange) — esto es la convención de "step
    // function" sobre el tiempo, igual a lo que hace `time-in-range.service`
    // para los pools protegidos. Funciona aunque no haya protección activa.
    const nowTs = Date.now();
    const prevTracking = orch.strategyState?.timeTracking || null;
    const lastSampleAt = Number(prevTracking?.lastSampleAt) || 0;
    const lastInRange = prevTracking?.lastInRange == null
      ? evaluation.inRange   // primer tick: usa el estado actual como semilla
      : prevTracking.lastInRange === true;
    let timeInRangeMs = Number(prevTracking?.timeInRangeMs) || 0;
    let timeTrackedMs = Number(prevTracking?.timeTrackedMs) || 0;
    if (lastSampleAt > 0) {
      const deltaMs = Math.max(0, nowTs - lastSampleAt);
      timeTrackedMs += deltaMs;
      if (lastInRange) timeInRangeMs += deltaMs;
    }
    const timeInRangePct = timeTrackedMs > 0
      ? (timeInRangeMs / timeTrackedMs) * 100
      : null;
    const newTimeTracking = {
      lastSampleAt: nowTs,
      lastInRange: evaluation.inRange,
      timeInRangeMs,
      timeTrackedMs,
      timeInRangePct,
    };

    // 4) Decisión
    let decision = 'hold';
    let reason = 'in_central_band';
    let costEstimate = null;
    const netEarnings = newAccounting.lpFeesUsd - newAccounting.gasSpentUsd - newAccounting.swapSlippageUsd;
    const minEarnings = Number(orch.strategyConfig?.minNetLpEarningsForRebalanceUsd ?? 0);
    const threshold = Number(orch.strategyConfig?.costToRewardThreshold ?? 0.3333);
    const reinvestThreshold = Number(orch.strategyConfig?.reinvestThresholdUsd ?? 0);

    if (!evaluation.inRange) {
      decision = 'urgent_adjust';
      reason = `out_of_range_${evaluation.outOfRangeSide}`;
    } else if (!evaluation.inCentralBand) {
      if (netEarnings <= minEarnings) {
        decision = 'hold';
        reason = 'edge_warning_in_loss';
      } else {
        try {
          costEstimate = await this.costEstimator.estimateModifyRangeCost({
            orchestrator: orch,
            pool,
            snapshotHash,
            rangeWidthPct: Number(orch.strategyConfig?.rangeWidthPct ?? 5),
            slippageBps: Number(orch.strategyConfig?.maxSlippageBps ?? 100),
          });
        } catch (err) {
          costEstimate = { totalCostUsd: 0, gasCostUsd: 0, slippageCostUsd: 0, txCount: 0, reason: 'error' };
        }
        const ratio = costEstimate.totalCostUsd / Math.max(netEarnings, 1e-9);
        if (costEstimate.totalCostUsd > 0 && ratio < threshold) {
          decision = 'recommend_rebalance';
          reason = `cost_${costEstimate.totalCostUsd.toFixed(2)}_vs_earn_${netEarnings.toFixed(2)}`;
        } else {
          decision = 'hold';
          reason = 'edge_warning_unprofitable';
        }
      }
    } else {
      decision = 'hold';
      reason = 'in_central_band';
    }

    // Recomendación paralela: cobrar fees si pasaron del umbral.
    let recommendCollect = false;
    const unclaimedFees = Number(pool.unclaimedFeesUsd) || 0;
    if (reinvestThreshold > 0 && unclaimedFees >= reinvestThreshold) {
      recommendCollect = true;
    }

    // 5) Persistir
    const newPhase =
      decision === 'urgent_adjust' ? 'urgent_adjust'
      : decision === 'recommend_rebalance' ? 'needs_rebalance'
      : 'lp_active';

    await this.repo.updateAccounting(orch.userId, orch.id, newAccounting);
    await this.repo.updateStrategyState(orch.userId, orch.id, {
      strategyState: {
        ...orch.strategyState,
        lastDecision: decision,
        lastReason: reason,
        hedgeBaseline: newHedgeBaseline,
        timeTracking: newTimeTracking,
      },
      lastEvaluation: {
        evaluation,
        costEstimate,
        netEarnings,
        recommendCollect,
        unclaimedFeesUsd: unclaimedFees,
        poolSnapshot: pool,
        snapshotHash,
        timeInRangePct: newTimeTracking.timeInRangePct,
        timeInRangeMs: newTimeTracking.timeInRangeMs,
        timeTrackedMs: newTimeTracking.timeTrackedMs,
      },
      lastEvaluationAt: nowTs,
      lastDecision: decision,
    });

    if (newPhase !== orch.phase) {
      await this.repo.updatePhase(orch.userId, orch.id, {
        phase: newPhase,
        lastError: null,
        nextEligibleAttemptAt: null,
        cooldownReason: null,
      });
    }

    await this.repo.appendActionLog({
      orchestratorId: orch.id,
      kind: 'decision',
      decision,
      reason,
      currentPrice: Number(pool.priceCurrent),
      rangeLowerPrice: Number(pool.rangeLowerPrice),
      rangeUpperPrice: Number(pool.rangeUpperPrice),
      centralBandLower: evaluation.centralBandLower,
      centralBandUpper: evaluation.centralBandUpper,
      estimatedCostUsd: costEstimate?.totalCostUsd ?? null,
      estimatedRewardUsd: netEarnings,
      costToRewardRatio: costEstimate?.totalCostUsd
        ? costEstimate.totalCostUsd / Math.max(netEarnings, 1e-9)
        : null,
      snapshotHash,
      accountingDelta: delta,
      createdAt: Date.now(),
    });

    // 6) Notificaciones (con dedup / repetición temporal)
    await this._maybeNotify(orch, decision, evaluation, costEstimate, netEarnings, recommendCollect, unclaimedFees, pool);

    return { decision, reason, costEstimate, evaluation };
  }

  async _maybeNotify(orch, decision, evaluation, costEstimate, netEarnings, recommendCollect, unclaimedFees, pool) {
    const now = Date.now();
    const repeatMinutes = Number(orch.strategyConfig?.urgentAlertRepeatMinutes ?? 30);
    const repeatMs = Math.max(60_000, repeatMinutes * 60_000);

    if (decision === 'urgent_adjust') {
      const lastAlertAt = orch.lastUrgentAlertAt || 0;
      const isFirst = lastAlertAt === 0;
      if (isFirst || now - lastAlertAt >= repeatMs) {
        try {
          await this.notifier.urgentOutOfRange(
            { ...orch, lastEvaluation: { poolSnapshot: pool } },
            { ...evaluation, priceCurrent: pool?.priceCurrent },
            { repeat: !isFirst }
          );
        } catch (err) {
          this.logger.warn('lp_orchestrator_notify_failed', { error: err.message });
        }
        await this.repo.markUrgentAlertSent(orch.userId, orch.id, { at: now });
        await this.repo.appendActionLog({
          orchestratorId: orch.id,
          kind: 'notification',
          decision: 'urgent_adjust',
          reason: isFirst ? 'first' : 'repeat',
          createdAt: now,
        });
      }
    } else if (decision === 'recommend_rebalance') {
      const lastNotif = await this.repo.findLastNotification(orch.id);
      if (!lastNotif || lastNotif.decision !== 'recommend_rebalance') {
        try {
          await this.notifier.recommendRebalance(orch, { evaluation, costEstimate, netEarnings });
        } catch (err) {
          this.logger.warn('lp_orchestrator_notify_failed', { error: err.message });
        }
        await this.repo.appendActionLog({
          orchestratorId: orch.id,
          kind: 'notification',
          decision: 'recommend_rebalance',
          createdAt: now,
        });
      }
    } else if (decision === 'hold' && orch.lastUrgentAlertAt) {
      // El precio volvió al rango: limpiar el alert para que la próxima salida
      // produzca una notificación de "primera vez" otra vez.
      await this.repo.clearUrgentAlert(orch.userId, orch.id);
    }

    if (recommendCollect) {
      const lastNotif = await this.repo.findLastNotification(orch.id);
      if (!lastNotif
          || lastNotif.decision !== 'recommend_collect_fees'
          || (now - (lastNotif.createdAt || 0)) > repeatMs) {
        try {
          await this.notifier.recommendCollectFees(orch, { feesUsd: unclaimedFees });
        } catch (err) {
          this.logger.warn('lp_orchestrator_notify_failed', { error: err.message });
        }
        await this.repo.appendActionLog({
          orchestratorId: orch.id,
          kind: 'notification',
          decision: 'recommend_collect_fees',
          createdAt: now,
        });
      }
    }
  }

  // ---------- helpers ------------------------------------------------------

  async _loadOrThrow(userId, id) {
    const orch = await this.repo.getById(userId, id);
    if (!orch) throw new ValidationError(`Orquestador ${id} no encontrado`);
    return orch;
  }

  _hasStableInPair(orch) {
    const stableSymbols = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC']);
    return stableSymbols.has(String(orch.token0Symbol || '').toUpperCase())
      || stableSymbols.has(String(orch.token1Symbol || '').toUpperCase());
  }
}

module.exports = new LpOrchestratorService();
module.exports.LpOrchestratorService = LpOrchestratorService;
