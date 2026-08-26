/**
 * orchestrator-metrics.service.js
 *
 * Captura un snapshot horario del valor total de cada orquestador activo:
 *   totalUsd = walletUsd (ETH + todos los ERC-20 en Arbitrum) + lpUsd + hlAccountUsd
 *
 * Persiste en `orchestrator_metrics_snapshots`. Alimenta la pagina /metricas.
 *
 * Diseño:
 *  - Loop alineado a la hora en punto (captura a HH:00 local de UTC).
 *  - Al arranque captura una vez (backfill inicial) para que no quede tabla
 *    vacia hasta la proxima hora.
 *  - Procesa orquestadores en serie para evitar saturar RPC de Alchemy.
 *  - Errores por-orquestador son atrapados (uno fallido no rompe el loop).
 */

const logger = require('./logger.service');
const lpOrchestratorRepository = require('../repositories/lp-orchestrator.repository');
const orchestratorMetricsRepo = require('../repositories/orchestrator-metrics.repository');
const walletBalanceService = require('./wallet-balance.service');
const balanceCacheService = require('./balance-cache.service');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const marketService = require('./market.service');
const { resolveOrchestratorAccountId } = require('./orchestrator-account-resolver');
const { recomputeNetPnl } = require('./lp-orchestrator/accounting');
const { ALL_POLICIES, resolveLivePolicy } = require('./protected-pool-delta-neutral/shadow-policies');

const FUNDING_CACHE_TTL_MS = 60_000;

const HOUR_MS = 60 * 60_000;

function policyFields(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    hedgeRealizedPnlUsd: Number(source.hedgeRealizedPnlUsd ?? source.realizedPnlUsd),
    hedgeUnrealizedPnlUsd: Number(source.hedgeUnrealizedPnlUsd ?? source.unrealizedPnlUsd),
    hedgeFundingUsd: Number(source.hedgeFundingUsd ?? source.fundingUsd),
    hedgeExecutionFeesUsd: Number(source.hedgeExecutionFeesUsd ?? source.executionFeesUsd),
    hedgeSlippageUsd: Number(source.hedgeSlippageUsd ?? source.slippageUsd),
  };
}

function finitePolicyFields(source) {
  const fields = policyFields(source);
  return fields && Object.values(fields).every(Number.isFinite) ? fields : null;
}

function policyNet(fields) {
  return fields.hedgeRealizedPnlUsd
    + fields.hedgeUnrealizedPnlUsd
    + fields.hedgeFundingUsd
    - fields.hedgeExecutionFeesUsd
    - fields.hedgeSlippageUsd;
}

function buildPoliciesBreakdown(accounting, livePolicy, hlAccountUsd) {
  const a = accounting || {};
  const real = finitePolicyFields(a);
  const realNet = real ? policyNet(real) : null;
  return Object.fromEntries(ALL_POLICIES.map((policyVersion) => {
    const isLive = policyVersion === livePolicy;
    const fields = isLive ? real : finitePolicyFields(a.shadowPolicies?.[policyVersion]);
    // Para una política contrafactual, sustituimos únicamente la pata hedge
    // dentro del valor de la cuenta HL. Si falta esa medición, es un hueco,
    // nunca un cero ficticio.
    const policyHlAccountUsd = isLive
      ? hlAccountUsd
      : (fields && realNet != null && Number.isFinite(Number(hlAccountUsd))
        ? Number(hlAccountUsd) - realNet + policyNet(fields)
        : null);
    return [policyVersion, {
      isLive,
      hedgeRealizedPnlUsd: fields?.hedgeRealizedPnlUsd ?? null,
      hedgeUnrealizedPnlUsd: fields?.hedgeUnrealizedPnlUsd ?? null,
      hedgeFundingUsd: fields?.hedgeFundingUsd ?? null,
      hedgeExecutionFeesUsd: fields?.hedgeExecutionFeesUsd ?? null,
      hedgeSlippageUsd: fields?.hedgeSlippageUsd ?? null,
      hlAccountUsd: policyHlAccountUsd,
    }];
  }));
}

class OrchestratorMetricsService {
  constructor() {
    this.timer = null;
    this.running = false;
    // Cache corto de funding por activo: getAssetContexts() trae todos los
    // activos en una llamada; con TTL evitamos pegarle a HL una vez por
    // orquestador durante la captura en serie.
    this._fundingCache = { fetchedAt: 0, byAsset: new Map() };
  }

  /**
   * Funding rate horario (signed) del activo en Hyperliquid. Convención HL:
   * rate > 0 → los longs pagan a los shorts (un hedge corto COBRA funding);
   * rate < 0 → el short PAGA. Devuelve null si no se pudo resolver.
   */
  async _getFundingRate(asset) {
    const key = String(asset || '').toUpperCase();
    if (!key) return null;
    if (Date.now() - this._fundingCache.fetchedAt > FUNDING_CACHE_TTL_MS) {
      try {
        const ctxs = await marketService.getAssetContexts();
        const byAsset = new Map();
        for (const c of ctxs || []) {
          const rate = Number(c.fundingRate);
          if (c.name && Number.isFinite(rate)) byAsset.set(String(c.name).toUpperCase(), rate);
        }
        this._fundingCache = { fetchedAt: Date.now(), byAsset };
      } catch (err) {
        logger.warn('orchestrator_metrics_funding_fetch_failed', { asset: key, error: err.message });
        // Mantenemos el cache viejo si lo hay; si no, devolvemos null abajo.
      }
    }
    const rate = this._fundingCache.byAsset.get(key);
    return Number.isFinite(rate) ? rate : null;
  }

  start() {
    if (this.timer) return;

    // Captura inicial diferida 10s para que el bootstrap termine limpio.
    setTimeout(() => {
      this.captureAll().catch((err) =>
        logger.warn('orchestrator_metrics_initial_capture_failed', { error: err.message })
      );
    }, 10_000).unref?.();

    // Alinea la siguiente ejecucion al proximo cambio de hora (XX:00:00).
    const now = Date.now();
    const msToNextHour = HOUR_MS - (now % HOUR_MS);
    setTimeout(() => {
      this.captureAll().catch((err) =>
        logger.warn('orchestrator_metrics_hourly_capture_failed', { error: err.message })
      );
      this.timer = setInterval(() => {
        this.captureAll().catch((err) =>
          logger.warn('orchestrator_metrics_hourly_capture_failed', { error: err.message })
        );
      }, HOUR_MS);
      this.timer.unref?.();
    }, msToNextHour).unref?.();

    logger.info('orchestrator_metrics_service_started', {
      msToNextCapture: msToNextHour,
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async captureAll() {
    if (this.running) {
      logger.info('orchestrator_metrics_capture_skipped_busy');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    let captured = 0;
    let skipped = 0;
    let failed = 0;

    try {
      // Usamos `listForMetricsCapture` (no `listActiveForLoop`) para NO
      // omitir orquestadores con cooldown activo. Las metricas son
      // observabilidad; el cooldown solo debe afectar operaciones de
      // trading, no lectura de balances.
      const orchestrators = await lpOrchestratorRepository.listForMetricsCapture();
      for (const orch of orchestrators) {
        if (orch.status !== 'active') continue;
        try {
          const snap = await this.captureOne(orch);
          if (snap) captured += 1;
          else skipped += 1;
        } catch (err) {
          failed += 1;
          logger.warn('orchestrator_metrics_capture_failed', {
            orchestratorId: orch.id,
            error: err.message,
          });
        }
      }
    } finally {
      this.running = false;
    }

    logger.info('orchestrator_metrics_capture_completed', {
      captured,
      skipped,
      failed,
      durationMs: Date.now() - startedAt,
    });
  }

  async captureOne(orchestrator) {
    const breakdown = await this.computeBreakdown(orchestrator);
    const totalUsd = (breakdown.walletUsd || 0) + (breakdown.lpUsd || 0) + (breakdown.hlAccountUsd || 0);

    // --- Guard anti-cero-falso de la pata HL ---
    // Si la pata HL vino en 0 sin que la captura reportara 'ok' (típicamente
    // 'not_linked' porque resolveOrchestratorAccountId devolvió null de forma
    // transitoria durante un re-range, o 'unavailable' por fallo de fetch) y la
    // captura anterior tenía saldo real (>$1), es un fallo transitorio: NO es
    // que la cuenta se haya vaciado. Persistir ese 0 mete un total_usd basura
    // que ensucia /metricas y falsea drawdowns. Preferimos SALTAR la captura
    // (hueco honesto de 1h) a escribir un cero falso.
    // Nota: un cero genuino (cuenta realmente vacía) llega con hlStatus 'ok' y
    // no entra aquí; un orquestador sin cuenta no tiene previo sano y persiste 0.
    if (breakdown.hlAccountUsd === 0 && breakdown.hlStatus !== 'ok') {
      let previous = null;
      try {
        previous = await orchestratorMetricsRepo.getLatest(orchestrator.id);
      } catch (err) {
        logger.warn('orchestrator_metrics_anomaly_check_failed', {
          orchestratorId: orchestrator.id,
          error: err.message,
        });
      }
      if (previous && Number(previous.hlAccountUsd) > 1) {
        logger.warn('orchestrator_metrics_hl_capture_skipped', {
          orchestratorId: orchestrator.id,
          reason: 'hl_zero_with_healthy_previous',
          previousHlAccountUsd: Number(previous.hlAccountUsd),
          hlStatus: breakdown.hlStatus,
          hlError: breakdown.hlError,
          walletUsd: breakdown.walletUsd,
          lpUsd: breakdown.lpUsd,
        });
        return null;
      }
    }

    const snapshot = await orchestratorMetricsRepo.insertSnapshot({
      orchestratorId: orchestrator.id,
      capturedAt: Date.now(),
      walletUsd: breakdown.walletUsd,
      lpUsd: breakdown.lpUsd,
      hlAccountUsd: breakdown.hlAccountUsd,
      totalUsd,
      breakdown,
    });

    logger.info('orchestrator_metrics_snapshot_captured', {
      orchestratorId: orchestrator.id,
      totalUsd,
      walletUsd: breakdown.walletUsd,
      lpUsd: breakdown.lpUsd,
      hlAccountUsd: breakdown.hlAccountUsd,
      hlStatus: breakdown.hlStatus,
    });

    return snapshot;
  }

  /**
   * Computa las tres componentes sin persistir. Se expone para que el
   * endpoint `/current` lo reutilice sin escribir en la tabla.
   */
  async computeBreakdown(orchestrator) {
    // --- Wallet Arbitrum (todos los tokens) ---
    let walletUsd = 0;
    let walletDetail = null;
    try {
      walletDetail = await walletBalanceService.getAllTokenBalancesUsd(
        orchestrator.walletAddress,
        { network: orchestrator.network || 'arbitrum' }
      );
      walletUsd = Number(walletDetail.totalUsd || 0);
    } catch (err) {
      logger.warn('orchestrator_metrics_wallet_fetch_failed', {
        orchestratorId: orchestrator.id,
        error: err.message,
      });
    }

    // --- LP Uniswap (del ultimo snapshot del pool) ---
    let lpUsd = 0;
    const lastEval = orchestrator.lastEvaluation || {};
    const poolSnapshot = lastEval.poolSnapshot || null;
    if (poolSnapshot) {
      const currentValue = Number(poolSnapshot.currentValueUsd);
      const unclaimed = Number(poolSnapshot.unclaimedFeesUsd);
      lpUsd = (Number.isFinite(currentValue) ? currentValue : 0)
        + (Number.isFinite(unclaimed) ? unclaimed : 0);
    }

    // --- Cuenta Hyperliquid ---
    const { accountId: resolvedAccountId, source: accountSource } =
      await resolveOrchestratorAccountId(orchestrator);

    let hlAccountUsd = 0;
    let hlAccountSource = null;
    let hlStatus = 'not_linked';
    let hlError = null;
    let hlPositions = null;
    if (resolvedAccountId != null) {
      try {
        const snap = await balanceCacheService.getSnapshot(
          orchestrator.userId,
          resolvedAccountId
        );
        hlAccountUsd = Number(snap.accountValue || 0);
        hlPositions = Array.isArray(snap.positions) ? snap.positions : null;
        hlStatus = 'ok';
        hlAccountSource = {
          accountId: resolvedAccountId,
          derivedFrom: accountSource,
          accountValue: snap.accountValue,
          withdrawable: snap.withdrawable,
          totalMarginUsed: snap.totalMarginUsed,
          positionsCount: Array.isArray(snap.positions) ? snap.positions.length : 0,
          lastUpdatedAt: snap.lastUpdatedAt,
        };
      } catch (err) {
        hlStatus = 'unavailable';
        hlError = err.message;
        logger.warn('orchestrator_metrics_hl_fetch_failed', {
          orchestratorId: orchestrator.id,
          accountId: resolvedAccountId,
          error: err.message,
        });
      }
    }

    // --- Tracking del hedge (KPIs del plan de mejoras) ---
    // Mide cuánto del delta del LP queda sin cubrir por el hedge. Es el
    // componente que el análisis histórico identificó como mayor leak.
    //   trackingErrorUsd = |deltaQty − actualQty| × precio
    //   residualUsd      = (deltaQty − targetQty) × precio  (sub-hedge por zona)
    const hedgeTracking = await this._computeHedgeTracking(
      orchestrator, poolSnapshot, lastEval, hlPositions
    );

    // --- PnL neto acumulado (contabilidad del orquestador) ---
    // A diferencia de `totalUsd` (valor de mercado, contaminado por depositos
    // y retiros de capital), esto es el PnL real: fees del LP, gas, slippage,
    // PnL del hedge (realizado + mark-to-market), funding y deriva de precio.
    // Se congela en cada snapshot para poder computar el PnL de una ventana
    // temporal como diferencia de dos snapshots.
    // Recomputamos el total desde sus componentes en vez de confiar en el
    // `totalNetPnlUsd` persistido: es un no-op cuando la fila esta sana y
    // corrige el valor si quedo desincronizado.
    const accounting = recomputeNetPnl(orchestrator.accounting);
    const policies = buildPoliciesBreakdown(
      accounting,
      hedgeTracking.livePolicy || 'legacy_zones_v1',
      hlAccountUsd,
    );

    return {
      walletUsd,
      lpUsd,
      hlAccountUsd,
      accounting,
      policies,
      wallet: walletDetail,
      lpSource: poolSnapshot ? {
        currentValueUsd: Number(poolSnapshot.currentValueUsd) || 0,
        unclaimedFeesUsd: Number(poolSnapshot.unclaimedFeesUsd) || 0,
        snapshotFreshAt: poolSnapshot.snapshotFreshAt || null,
      } : null,
      hlAccount: hlAccountSource,
      hlStatus,
      hlError,
      hedgeTracking,
    };
  }

  /**
   * Lee el strategy_state de la protección activa y deriva las métricas de
   * tracking del hedge para el snapshot horario. Devuelve null si el
   * orquestador no tiene protección activa o no hay datos suficientes.
   */
  /**
   * Distancia a liquidacion calculada EN VIVO desde la posicion de Hyperliquid.
   *
   * Antes este numero solo existia en `protected_pool_delta_rebalance_log`, que
   * se escribe UNICAMENTE cuando ocurre un rebalanceo. El dashboard y el reporte
   * semanal hacian `min()` sobre esa tabla, asi que sin rebalanceos el valor se
   * congelaba y podia desviarse en los DOS sentidos. Medido el 2026-08-10 con el
   * ultimo rebalanceo 6h atras: se reportaba #35 al 8.4% (real 14.9%) y #37 al
   * 13.7% (**real 8.4%**, pegado al umbral de alarma) — y #37 concentra el 78%
   * del capital. La metrica de riesgo se quedaba obsoleta justo cuando no hay
   * actividad, que es cuando una deriva lenta puede acercarte a liquidacion sin
   * que nadie lo vea.
   *
   * Es puro a proposito: recibe las posiciones ya normalizadas y el precio, sin
   * IO, para poder fijarlo con tests.
   *
   * @param {Array|null} positions - `snap.positions` de balanceCacheService.
   * @param {string|null} asset    - activo del orquestador (p.ej. 'ETH').
   * @param {number|null} price    - precio actual del activo.
   * @returns {number|null} % de distancia, o null si no se puede derivar.
   */
  static computeLiveDistanceToLiqPct(positions, asset, price) {
    const px = Number(price);
    if (!Array.isArray(positions) || !asset || !Number.isFinite(px) || px <= 0) {
      return null;
    }
    const pos = positions.find(
      (p) => String(p?.asset || '').toUpperCase() === String(asset).toUpperCase()
    );
    if (!pos) return null;
    const liq = Number(pos.liquidationPrice);
    // Hyperliquid devuelve `liquidationPx` null en posiciones sin riesgo de
    // liquidacion (p.ej. cross-margin muy sobrecolateralizado). No es un error.
    if (!Number.isFinite(liq) || liq <= 0) return null;
    const size = Number(pos.size);
    if (!Number.isFinite(size) || size === 0) return null;
    // Un short se liquida si el precio SUBE hasta liq; un long si BAJA.
    const pct = size < 0 ? ((liq - px) / px) * 100 : ((px - liq) / px) * 100;
    return Number.isFinite(pct) ? pct : null;
  }

  async _computeHedgeTracking(orchestrator, poolSnapshot, lastEval, hlPositions = null) {
    const timeInRangePct = Number.isFinite(Number(lastEval?.timeInRangePct))
      ? Number(lastEval.timeInRangePct)
      : null;
    const price = Number(poolSnapshot?.priceCurrent) || null;

    if (!orchestrator.activeProtectedPoolId) {
      return { hasHedge: false, timeInRangePct, price };
    }

    try {
      const protection = await protectedPoolRepository.getById(
        orchestrator.userId,
        orchestrator.activeProtectedPoolId
      );
      const state = protection?.strategyState || protection?.strategy_state_json || null;
      const parsed = typeof state === 'string' ? JSON.parse(state) : state;
      if (!parsed || typeof parsed !== 'object') {
        return { hasHedge: false, timeInRangePct, price };
      }
      const deltaQty = Number(parsed.lastDeltaQty);
      const targetQty = Number(parsed.lastTargetQty);
      const actualQty = Number(parsed.lastActualQty);
      const shadowTargetQty = Number(parsed.lastShadowTargetQty);
      const px = price || Number(parsed.lastModelPrice) || null;

      const finite = (v) => (Number.isFinite(v) ? v : null);
      const hedgeActualUsd = (Number.isFinite(actualQty) && px) ? actualQty * px : null;

      // Funding (#6): un hedge corto cobra funding cuando el rate es positivo y
      // lo paga cuando es negativo. Proyectamos el costo/ingreso diario sobre el
      // notional real del hedge (rate horario × 24). headwind = está pagando.
      const asset = orchestrator.inferredAsset || protection?.inferredAsset || null;
      const fundingRateHourly = asset ? await this._getFundingRate(asset) : null;
      const projectedDailyFundingUsd = (Number.isFinite(fundingRateHourly) && Number.isFinite(hedgeActualUsd))
        ? fundingRateHourly * hedgeActualUsd * 24
        : null;

      return {
        hasHedge: true,
        timeInRangePct,
        price: px,
        deltaQty: finite(deltaQty),
        targetQty: finite(targetQty),
        actualQty: finite(actualQty),
        shadowTargetQty: finite(shadowTargetQty),
        hedgeTargetUsd: (Number.isFinite(targetQty) && px) ? targetQty * px : null,
        hedgeActualUsd,
        trackingErrorUsd: (Number.isFinite(deltaQty) && Number.isFinite(actualQty) && px)
          ? Math.abs(deltaQty - actualQty) * px : null,
        residualUsd: (Number.isFinite(deltaQty) && Number.isFinite(targetQty) && px)
          ? (deltaQty - targetQty) * px : null,
        zoneState: parsed.zoneState || null,
        modelConfidence: parsed.modelConfidence || null,
        // Riesgo de liquidacion EN VIVO (ver computeLiveDistanceToLiqPct). Se
        // persiste en cada snapshot para que el dashboard y el reporte dejen de
        // depender del ultimo rebalanceo registrado, que puede tener horas.
        distanceToLiqPct: OrchestratorMetricsService.computeLiveDistanceToLiqPct(
          hlPositions, asset, px
        ),
        fundingRateHourly: finite(fundingRateHourly),
        projectedDailyFundingUsd: finite(projectedDailyFundingUsd),
        fundingHeadwind: Number.isFinite(projectedDailyFundingUsd) ? projectedDailyFundingUsd < 0 : null,
        livePolicy: resolveLivePolicy(protection),
      };
    } catch (err) {
      logger.warn('orchestrator_metrics_hedge_tracking_failed', {
        orchestratorId: orchestrator.id,
        error: err.message,
      });
      return { hasHedge: false, timeInRangePct, price };
    }
  }
}

module.exports = new OrchestratorMetricsService();
module.exports.OrchestratorMetricsService = OrchestratorMetricsService;
module.exports.buildPoliciesBreakdown = buildPoliciesBreakdown;
