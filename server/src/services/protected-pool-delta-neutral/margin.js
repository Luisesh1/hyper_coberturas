/**
 * Margen aislado y recargas automáticas del hedge.
 *
 * Se compone sobre el prototipo de `ProtectedPoolDeltaNeutralService` en vez
 * de recibir el servicio como argumento: así el cuerpo de los métodos se mueve
 * literal, sin reescribir un solo `this`, que es lo que hace revisable un
 * corte sobre un archivo de este tamaño.
 */
// `logger` de módulo, no `this.logger`: estos métodos ya usaban el singleton
// directamente y cambiarlo aquí alteraría lo que ven los tests que inyectan
// un logger falso en el servicio.
const logger = require('../logger.service');
const {
  DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
  DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD,
  clampNonNegative,
} = require('../protected-pool-delta-neutral.helpers');

const marginMethods = {
  async _ensureIsolatedMarginBuffer(protection, hl, currentPrice, qtyToAdd, actualQty = 0) {
    const assetMeta = await hl.getAssetMeta(protection.inferredAsset);
    await hl.updateLeverage(assetMeta.index, false, protection.leverage);
    const leverage = Math.max(Number(protection.leverage || 1), 1);
    const addQty = Math.abs(Number(qtyToAdd || 0));
    const newTotalSize = Math.abs(Number(actualQty || 0)) + addQty;
    const newTotalRequiredMarginUsd = (newTotalSize * currentPrice) / leverage;
    // Margen específico del incremento — es lo que HL exige que venga de
    // `withdrawable` (NO del excedente del slot isolated) cuando añadimos
    // size a una posición isolated existente. Sin eso, HL responde
    // "Insufficient margin to place order" aunque el slot tenga buffer.
    const incrementMarginUsd = (addQty * currentPrice) / leverage;

    let state = null;
    try {
      state = await hl.getClearinghouseState();
    } catch (err) {
      logger.warn('ensureIsolatedMarginBuffer_state_failed', { poolId: protection.id, asset: protection.inferredAsset, error: err.message });
    }
    const positionEntry = (state?.assetPositions || []).find(
      (p) => String(p.position?.coin || '').toUpperCase() === String(protection.inferredAsset || '').toUpperCase()
    );
    const existingMarginUsd = Number(positionEntry?.position?.marginUsed || 0);
    const slotRawUsd = Number(positionEntry?.position?.leverage?.rawUsd || 0);
    const withdrawable = Number(state?.withdrawable || 0);

    // --------------------------------------------------------------------
    // Paso 1 · Si el slot isolated está sobre-colateralizado Y `withdrawable`
    //         no cubre el margen incremental → extraer el exceso de vuelta
    //         a cross. HL admite `ntli` negativo para esto.
    // --------------------------------------------------------------------
    const SAFETY_BUFFER_FACTOR = 1.2; // deja 20% sobre marginUsed en el slot
    const slotSurplusUsd = Math.max(0, slotRawUsd - existingMarginUsd * SAFETY_BUFFER_FACTOR);
    const withdrawableGapUsd = Math.max(0, incrementMarginUsd * 1.1 - withdrawable);
    if (withdrawableGapUsd > 0 && slotSurplusUsd > 0) {
      const toExtractUsd = Math.min(slotSurplusUsd, withdrawableGapUsd);
      const ntli = -Math.ceil(toExtractUsd);
      try {
        await hl.updateIsolatedMargin(assetMeta.index, false, ntli);
        logger.info?.('ensureIsolatedMarginBuffer_extracted', {
          poolId: protection.id,
          asset: protection.inferredAsset,
          extractedUsd: -ntli,
          slotRawUsd,
          existingMarginUsd,
          withdrawableBefore: withdrawable,
          incrementMarginUsd,
        });
      } catch (err) {
        logger.warn('updateIsolatedMargin_extract_failed', { poolId: protection.id, asset: protection.inferredAsset, ntli, error: err.message });
      }
    }

    // --------------------------------------------------------------------
    // Paso 2 · Si al total le falta margen (no es sobre-colateralizado),
    //         fondear el slot con el shortfall (+20% buffer). Este era el
    //         comportamiento original. Lo conservamos como fallback por si
    //         la posición está efectivamente sub-fondada.
    // --------------------------------------------------------------------
    const totalShortfallUsd = Math.max(0, newTotalRequiredMarginUsd - existingMarginUsd);
    if (totalShortfallUsd <= 0) return;
    const marginUsd = Math.ceil(totalShortfallUsd * 1.2);
    if (marginUsd > 0) {
      await hl.updateIsolatedMargin(assetMeta.index, false, marginUsd).catch((err) => logger.warn('updateIsolatedMargin failed', { poolId: protection.id, asset: protection.inferredAsset, marginUsd, error: err.message }));
    }
  },

  _refreshTopUpWindow(strategyState) {
    const startedAt = Number(strategyState.topUpWindowStartedAt || 0);
    const now = Date.now();
    if (!startedAt || (now - startedAt) >= 86_400_000) {
      return {
        topUpCount24h: 0,
        topUpUsd24h: 0,
        topUpWindowStartedAt: now,
      };
    }
    return {
      topUpCount24h: clampNonNegative(strategyState.topUpCount24h),
      topUpUsd24h: clampNonNegative(strategyState.topUpUsd24h),
      topUpWindowStartedAt: startedAt,
    };
  },

  async _maybeTopUpMargin({ protection, hl, currentPrice, actualQty, strategyState, riskControls = null }) {
    const refreshed = this._refreshTopUpWindow(strategyState);
    const topUpCount24h = refreshed.topUpCount24h;
    const topUpUsd24h = refreshed.topUpUsd24h;
    const currentHedgeNotionalUsd = actualQty * currentPrice;
    const minFloorUsd = Number(riskControls?.minAutoTopUpFloorUsd) >= 0 ? Number(riskControls.minAutoTopUpFloorUsd) : DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD;
    const topUpUsd = Math.max(minFloorUsd, 0.1 * currentHedgeNotionalUsd);
    const maxAutoTopUpsPer24h = Number(riskControls?.maxAutoTopUpsPer24h) || DEFAULT_MAX_AUTO_TOPUPS_PER_24H;
    const maxAutoTopUpUsdPer24h = this._computeAutoTopUpCapUsd(protection, riskControls);

    if (topUpCount24h >= maxAutoTopUpsPer24h) {
      return {
        allowed: false,
        success: false,
        reason: 'Se alcanzo el maximo de auto top-ups en 24h.',
        strategyState: {
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
        },
      };
    }
    if ((topUpUsd24h + topUpUsd) > maxAutoTopUpUsdPer24h) {
      return {
        allowed: false,
        success: false,
        reason: 'Se alcanzo el cap diario de auto top-up.',
        strategyState: {
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
        },
      };
    }
    if (strategyState.lastTopUpAt && (Date.now() - Number(strategyState.lastTopUpAt)) < 15 * 60_000) {
      return {
        allowed: true,
        success: false,
        reason: 'Cooldown de auto top-up activo.',
        strategyState: {
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
        },
      };
    }

    try {
      const assetMeta = await hl.getAssetMeta(protection.inferredAsset);
      await hl.updateIsolatedMargin(assetMeta.index, false, topUpUsd);
      return {
        allowed: true,
        success: true,
        strategyState: {
          ...strategyState,
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
          topUpCount24h: topUpCount24h + 1,
          topUpUsd24h: topUpUsd24h + topUpUsd,
          lastTopUpAt: Date.now(),
        },
      };
    } catch (err) {
      return {
        allowed: true,
        success: false,
        reason: err.message,
        strategyState: {
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
        },
      };
    }
  }

};

module.exports = { marginMethods };
