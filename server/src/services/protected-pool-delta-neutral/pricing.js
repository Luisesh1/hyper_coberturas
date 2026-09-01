/**
 * Contexto de precio del hedge: mercado hibrido de Hyperliquid, gemelo digital
 * del LP y politica de refresco de la verdad on-chain.
 *
 * Se compone sobre el prototipo del servicio (ver margin.js): el cuerpo de los
 * metodos viaja literal y `this` sigue siendo la instancia.
 */
const { buildSyntheticLpState } = require('../delta-neutral-math.service');
const {
  DEFAULT_TARGET_HEDGE_RATIO,
  safeJsonClone,
} = require('../protected-pool-delta-neutral.helpers');
const { policyOwnsFullDelta } = require('../protected-pool-delta-neutral.helpers');

// Un snapshot del pool más viejo que esto deja de valer como fallback cuando
// la verdad on-chain falla. Espeja la constante del servicio.
const MAX_SNAPSHOT_FALLBACK_AGE_MS = 2 * 60_000;

const pricingMethods = {
  _hasRealtimeMarketPrice(marketContext = null) {
    const source = String(marketContext?.source || '').trim().toLowerCase();
    const price = Number(marketContext?.hlPrice);
    return Number.isFinite(price) && price > 0 && source.startsWith('hl_ws_');
  },

  _computeBasisSpreadBps(currentPrice, truthPrice) {
    const current = Number(currentPrice);
    const truth = Number(truthPrice);
    if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(truth) || truth <= 0) return null;
    return Math.abs((current - truth) / truth) * 10_000;
  },

  _resolveModelConfidence({ truthAgeMs, basisSpreadBps, zoneState, truthPending = false }) {
    if (truthPending) return 'low';
    if (Number.isFinite(basisSpreadBps) && basisSpreadBps >= this.lowConfidenceBasisBps) return 'low';
    if (Number.isFinite(truthAgeMs) && truthAgeMs > Math.max(this.truthRefreshNormalMs * 2, this.truthRefreshEdgeMs * 3)) {
      return 'low';
    }
    if (zoneState === 'edge' || zoneState === 'outside') {
      if (Number.isFinite(truthAgeMs) && truthAgeMs <= this.truthRefreshEdgeMs && (!Number.isFinite(basisSpreadBps) || basisSpreadBps <= this.basisGuardBps)) {
        return 'high';
      }
      return 'medium';
    }
    if (Number.isFinite(truthAgeMs) && truthAgeMs <= this.truthRefreshNormalMs && (!Number.isFinite(basisSpreadBps) || basisSpreadBps <= this.basisGuardBps)) {
      return 'high';
    }
    return 'medium';
  },

  async _getHybridMarketContext(protection) {
    this._trackProtection(protection);
    const user = protection?.account?.address || protection?.walletAddress;
    const [mid, bbo, assetContext, clearinghouseState] = await Promise.all([
      this.hyperliquidStreamService.getMidPrice(protection.inferredAsset).catch(() => null),
      this.hyperliquidStreamService.getBbo(protection.inferredAsset).catch(() => null),
      this.hyperliquidStreamService.getActiveAssetCtx(protection.inferredAsset).catch(() => null),
      this.hyperliquidStreamService.getClearinghouseState(user).catch((err) => {
        this.logger.warn('hl_clearinghouse_market_ctx_failed', {
          protectionId: protection.id,
          user,
          error: err.message,
        });
        return null;
      }),
    ]);
    const hlPrice = Number(bbo?.mid ?? mid?.price ?? assetContext?.midPx ?? assetContext?.markPx);
    let source = 'unavailable';
    if (bbo?.mid != null) source = bbo.source === 'http' ? 'hl_http_bbo' : 'hl_ws_bbo';
    else if (mid?.price != null) source = mid.source === 'http' ? 'hl_http_mid' : 'hl_ws_mid';
    else if (assetContext?.midPx != null || assetContext?.markPx != null) source = assetContext.source === 'http' ? 'hl_http_asset_ctx' : 'hl_ws_asset_ctx';

    return {
      hlPrice: Number.isFinite(hlPrice) && hlPrice > 0 ? hlPrice : null,
      source,
      mid,
      bbo,
      assetContext,
      clearinghouseState: clearinghouseState?.state || clearinghouseState || null,
    };
  },

  _buildDigitalTwin(protection, marketContext) {
    const snapshot = safeJsonClone(protection?.poolSnapshot || {});
    const baseTwin = buildSyntheticLpState(snapshot, {
      volatilePriceUsd: marketContext?.hlPrice,
      targetHedgeRatio: protection.targetHedgeRatio ?? DEFAULT_TARGET_HEDGE_RATIO,
    });
    if (!baseTwin?.eligible) {
      return {
        ...baseTwin,
        zoneState: 'center',
        targetHedgeRatioApplied: protection.targetHedgeRatio ?? DEFAULT_TARGET_HEDGE_RATIO,
      };
    }

    const zoneState = this._deriveZoneState(protection, baseTwin.syntheticPriceCurrent);
    const policyVersion = protection.policyVersion || protection.strategyState?.policyVersion;
    const liveFullDelta = policyOwnsFullDelta(policyVersion, protection.strategyState?.executionIntent);
    const baseRatio = liveFullDelta ? 1 : Number(protection.targetHedgeRatio ?? DEFAULT_TARGET_HEDGE_RATIO);
    // Las políticas net profit y range_exit viven sobre el 100% del delta y no
    // heredan los escalones de zona legacy. Es crucial también en live: de otro
    // modo el selector "Operación real" conservaría una subcobertura de hasta
    // 40% en centro. La lista vive en `policyOwnsFullDelta` para que dar de
    // alta una política nueva sea un solo cambio y no tres.
    const targetHedgeRatioApplied = liveFullDelta
      ? 1
      : baseRatio * this._zoneMultiplier(zoneState);
    const tunedTwin = buildSyntheticLpState(snapshot, {
      volatilePriceUsd: marketContext?.hlPrice,
      targetHedgeRatio: targetHedgeRatioApplied,
    });

    // Ya no se construye un gemelo de sombra. Cada politica no viva deriva su
    // propio target en `shadow-policies.js` a partir de `deltaQty`, que es
    // independiente del ratio (`targetQty = deltaQty * ratio` dentro de
    // `buildSyntheticLpState`): el segundo gemelo por tick solo reproducia esa
    // multiplicacion.
    return {
      ...tunedTwin,
      zoneState,
      targetHedgeRatioApplied,
    };
  },

  async _resolvePricingContext(protection, snapshotMeta, liveMarket) {
    const marketTwin = this._buildDigitalTwin(protection, liveMarket);
    const marketPrice = Number(marketTwin?.syntheticPriceCurrent);
    const liveSource = liveMarket?.source || 'unavailable';

    if (this._hasRealtimeMarketPrice(liveMarket) && marketTwin?.eligible && Number.isFinite(marketPrice) && marketPrice > 0) {
      return {
        currentPrice: marketPrice,
        twin: marketTwin,
        spotSource: liveSource,
        spotFailureReason: null,
      };
    }

    const snapshotPrice = Number(protection?.poolSnapshot?.priceCurrent ?? protection?.priceCurrent);
    const snapshotAgeMs = Math.max(Date.now() - Number(snapshotMeta?.snapshotFreshAt || protection?.snapshotFreshAt || 0), 0);
    if (Number.isFinite(snapshotPrice) && snapshotPrice > 0 && snapshotAgeMs <= MAX_SNAPSHOT_FALLBACK_AGE_MS) {
      return {
        currentPrice: snapshotPrice,
        twin: this._buildDigitalTwin(protection, { hlPrice: snapshotPrice }),
        spotSource: 'snapshot',
        spotFailureReason: null,
      };
    }

    const spot = await this._fetchSpot(protection).catch(() => null);
    const spotPrice = Number(spot?.priceCurrent);
    if (Number.isFinite(spotPrice) && spotPrice > 0) {
      return {
        currentPrice: spotPrice,
        twin: this._buildDigitalTwin(protection, { hlPrice: spotPrice }),
        spotSource: 'pool_spot',
        spotFailureReason: null,
      };
    }

    return {
      currentPrice: null,
      twin: marketTwin,
      spotSource: liveSource,
      spotFailureReason: 'No se pudo obtener el precio actual del pool.',
    };
  },

  _shouldRefreshTruth({
    protection,
    strategyState,
    forceReason,
    zoneState,
    truthAgeMs,
    basisSpreadBps,
    modelConfidence,
  }) {
    if (!protection?.poolSnapshot) {
      return { refresh: true, reason: 'missing_snapshot', urgent: true, useFullScan: true };
    }
    if (forceReason === 'restart_reconcile') {
      return { refresh: true, reason: 'restart_reconcile', urgent: true, useFullScan: false };
    }
    if (forceReason === 'boundary_cross') {
      return { refresh: true, reason: 'boundary_cross', urgent: true, useFullScan: false };
    }
    if (strategyState.truthPending) {
      return { refresh: true, reason: 'truth_pending', urgent: true, useFullScan: false };
    }
    if (Number.isFinite(basisSpreadBps) && basisSpreadBps >= this.lowConfidenceBasisBps) {
      return { refresh: true, reason: 'basis_high', urgent: true, useFullScan: false };
    }
    if (modelConfidence === 'low') {
      return { refresh: true, reason: 'low_confidence', urgent: true, useFullScan: false };
    }
    const lastFullScanAt = Number(strategyState.lastFullScanAt || 0);
    if (lastFullScanAt > 0 && Date.now() - lastFullScanAt >= this.fullScanTtlMs) {
      return { refresh: true, reason: 'maintenance_full_scan', urgent: false, useFullScan: true };
    }
    if ((zoneState === 'edge' || zoneState === 'outside') && truthAgeMs >= this.truthRefreshEdgeMs) {
      return { refresh: true, reason: 'near_edge_truth_refresh', urgent: true, useFullScan: false };
    }
    if (truthAgeMs >= this.truthRefreshNormalMs) {
      return { refresh: true, reason: 'normal_truth_refresh', urgent: false, useFullScan: false };
    }
    return { refresh: false, reason: null, urgent: false, useFullScan: false };
  },
};

module.exports = { pricingMethods };
