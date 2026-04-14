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
const { resolveOrchestratorAccountId } = require('./orchestrator-account-resolver');

const HOUR_MS = 60 * 60_000;

class OrchestratorMetricsService {
  constructor() {
    this.timer = null;
    this.running = false;
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
    let failed = 0;

    try {
      const orchestrators = await lpOrchestratorRepository.listActiveForLoop();
      for (const orch of orchestrators) {
        if (orch.status !== 'active') continue;
        try {
          await this.captureOne(orch);
          captured += 1;
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
      failed,
      durationMs: Date.now() - startedAt,
    });
  }

  async captureOne(orchestrator) {
    const breakdown = await this.computeBreakdown(orchestrator);
    const totalUsd = (breakdown.walletUsd || 0) + (breakdown.lpUsd || 0) + (breakdown.hlAccountUsd || 0);

    // --- Deteccion de anomalias: HL balance cae a 0 sospechosamente ---
    // Si la captura anterior tenia HL balance significativo (>$1) y la
    // actual es exactamente 0, es un probable fallo silencioso (API down,
    // accountId mal resuelto, etc.). Log explicito para investigar.
    if (breakdown.hlStatus !== 'not_linked' && breakdown.hlAccountUsd === 0) {
      try {
        const previous = await orchestratorMetricsRepo.getLatest(orchestrator.id);
        if (previous && Number(previous.hlAccountUsd) > 1) {
          logger.warn('orchestrator_metrics_hl_balance_zero_anomaly', {
            orchestratorId: orchestrator.id,
            previousHlAccountUsd: Number(previous.hlAccountUsd),
            currentHlAccountUsd: 0,
            hlStatus: breakdown.hlStatus,
            hlError: breakdown.hlError,
            capturedAt: Date.now(),
          });
        }
      } catch (err) {
        logger.warn('orchestrator_metrics_anomaly_check_failed', {
          orchestratorId: orchestrator.id,
          error: err.message,
        });
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
    if (resolvedAccountId != null) {
      try {
        const snap = await balanceCacheService.getSnapshot(
          orchestrator.userId,
          resolvedAccountId
        );
        hlAccountUsd = Number(snap.accountValue || 0);
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

    return {
      walletUsd,
      lpUsd,
      hlAccountUsd,
      wallet: walletDetail,
      lpSource: poolSnapshot ? {
        currentValueUsd: Number(poolSnapshot.currentValueUsd) || 0,
        unclaimedFeesUsd: Number(poolSnapshot.unclaimedFeesUsd) || 0,
        snapshotFreshAt: poolSnapshot.snapshotFreshAt || null,
      } : null,
      hlAccount: hlAccountSource,
      hlStatus,
      hlError,
    };
  }
}

module.exports = new OrchestratorMetricsService();
