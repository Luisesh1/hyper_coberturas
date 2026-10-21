/**
 * wallet-metrics.service.js
 *
 * Captura cada hora el valor total en USD de cada wallet seguida (tokens en
 * todas las redes + LPs + Hyperliquid de la misma direccion). Sustituye a la
 * captura por orquestador: cerrar un orquestador ya no corta la serie; solo
 * archivar la wallet la detiene.
 *
 *  - Antes de cada captura se dan de alta las wallets de orquestadores nuevos
 *    (y se reactivan las archivadas que recibieron uno).
 *  - Una direccion compartida por varios usuarios se lee una sola vez.
 *  - Direcciones en serie para no hacer rafagas contra Alchemy/Hyperliquid.
 */

const logger = require('./logger.service');
const walletMetricsRepo = require('../repositories/wallet-metrics.repository');
const collector = require('./wallet-metrics/collector');
const { mergeSources } = require('./wallet-metrics/valuation');

const HOUR_MS = 60 * 60_000;
// Una wallet "debe" captura si su ultimo punto tiene mas de esto. Evita
// duplicar el punto de la hora al reiniciar el proceso.
const DUE_AFTER_MS = 50 * 60_000;
// Minimo entre capturas oportunistas disparadas desde la API.
const DUE_CHECK_MIN_INTERVAL_MS = 5 * 60_000;

function buildDetail(merged, capturedAt) {
  return {
    capturedAt,
    totals: merged.totals,
    isPartial: merged.isPartial,
    staleSources: merged.staleSources,
    sources: merged.sources,
  };
}

class WalletMetricsService {
  constructor({ repo = walletMetricsRepo, collect = collector.collectWallet, now = () => Date.now() } = {}) {
    this.repo = repo;
    this.collect = collect;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.lastDueCheckAt = 0;
  }

  start() {
    if (this.timer) return;

    setTimeout(() => {
      this.captureAll({ onlyDue: true }).catch((err) =>
        logger.warn('wallet_metrics_initial_capture_failed', { error: err.message })
      );
    }, 15_000).unref?.();

    const msToNextHour = HOUR_MS - (Date.now() % HOUR_MS);
    const hourly = () => this.captureAll().catch((err) =>
      logger.warn('wallet_metrics_hourly_capture_failed', { error: err.message })
    );
    this._alignTimer = setTimeout(() => {
      hourly();
      this.timer = setInterval(hourly, HOUR_MS);
      this.timer.unref?.();
    }, msToNextHour);
    this._alignTimer.unref?.();

    logger.info('wallet_metrics_service_started', { msToNextCapture: msToNextHour });
  }

  stop() {
    clearTimeout(this._alignTimer);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Captura oportunista (wallet nueva o reactivada sin punto reciente). La
   * API la dispara sin esperarla; se limita a una comprobacion cada 5 min.
   */
  triggerDueCapture() {
    const now = this.now();
    if (this.running || now - this.lastDueCheckAt < DUE_CHECK_MIN_INTERVAL_MS) return;
    this.lastDueCheckAt = now;
    this.captureAll({ onlyDue: true }).catch((err) =>
      logger.warn('wallet_metrics_due_capture_failed', { error: err.message })
    );
  }

  async captureAll({ onlyDue = false } = {}) {
    if (this.running) {
      logger.info('wallet_metrics_capture_skipped_busy');
      return { captured: 0, failed: 0 };
    }
    this.running = true;
    const startedAt = this.now();
    let captured = 0;
    let failed = 0;
    try {
      await this.repo.syncFromOrchestrators();
      let wallets = await this.repo.listActiveForCapture();
      if (onlyDue) {
        const lastAt = await this.repo.getLatestCapturedAt(wallets.map((w) => w.id));
        wallets = wallets.filter((w) => !lastAt.has(w.id) || startedAt - lastAt.get(w.id) >= DUE_AFTER_MS);
      }

      const byAddress = new Map();
      for (const w of wallets) {
        if (!byAddress.has(w.address)) byAddress.set(w.address, []);
        byAddress.get(w.address).push(w);
      }

      for (const [address, group] of byAddress) {
        let fresh;
        try {
          fresh = await this.collect({ userId: group[0].userId, address });
        } catch (err) {
          failed += group.length;
          logger.warn('wallet_metrics_collect_failed', { address, error: err.message });
          continue;
        }
        for (const wallet of group) {
          try {
            await this.persist(wallet, fresh);
            captured += 1;
          } catch (err) {
            failed += 1;
            logger.warn('wallet_metrics_persist_failed', { walletId: wallet.id, error: err.message });
          }
        }
      }
    } finally {
      this.running = false;
    }
    logger.info('wallet_metrics_capture_completed', {
      onlyDue, captured, failed, durationMs: this.now() - startedAt,
    });
    return { captured, failed };
  }

  async persist(wallet, fresh) {
    const capturedAt = this.now();
    const merged = mergeSources(fresh, wallet.lastDetail, capturedAt);
    const detail = buildDetail(merged, capturedAt);
    const snapshot = await this.repo.saveCapture(wallet.id, {
      capturedAt,
      ...merged.totals,
      isPartial: merged.isPartial,
      staleSources: merged.staleSources,
    }, detail);
    logger.info('wallet_metrics_snapshot_captured', {
      walletId: wallet.id,
      totalUsd: merged.totals.totalUsd,
      isPartial: merged.isPartial,
      staleSources: merged.staleSources.map((s) => s.key),
    });
    return snapshot;
  }

  /** Valor al momento, sin persistir (boton "Refrescar"). */
  async computeLive(wallet) {
    const fresh = await this.collect({ userId: wallet.userId, address: wallet.address });
    const capturedAt = this.now();
    return buildDetail(mergeSources(fresh, wallet.lastDetail, capturedAt), capturedAt);
  }
}

module.exports = new WalletMetricsService();
module.exports.WalletMetricsService = WalletMetricsService;
