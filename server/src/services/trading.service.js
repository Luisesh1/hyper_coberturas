/**
 * trading.service.js
 *
 * Logica de negocio para operaciones de trading:
 * abrir posiciones apalancadas, cerrar posiciones, consultar estado.
 *
 * Ahora es una clase que recibe instancias de HyperliquidService y TelegramService
 * para soportar múltiples usuarios con configuraciones independientes.
 */

const config = require('../config');
const { placePositionProtection } = require('./protection.service');
const balanceCacheService = require('./balance-cache.service');
const { formatPrice, formatSize } = require('../utils/format');
const logger = require('./logger.service');
const leverageMutex = require('./leverage.mutex');

// Slippage para ordenes de mercado: margen minimo para garantizar ejecucion inmediata
const MARKET_ORDER_SLIPPAGE = config.trading.marketOrderSlippage;

class TradingService {
  /**
   * @param {number} userId
   * @param {{ id: number, alias: string, address: string, label: string, shortAddress: string }} account
   * @param {import('./hyperliquid.service')} hlService
   * @param {import('./telegram.service')} tgService
   */
  constructor(userId, account, hlService, tgService) {
    this.userId = userId;
    this.account = account;
    this.hl = hlService;
    this.tg = tgService;
  }

  _estimateClosedPnl({ entryPrice, closePrice, size, isLong }) {
    const entry = parseFloat(entryPrice);
    const close = parseFloat(closePrice);
    const normalizedSize = parseFloat(size);
    if (!Number.isFinite(entry) || !Number.isFinite(close) || !Number.isFinite(normalizedSize)) {
      return null;
    }
    const diff = (close - entry) * normalizedSize;
    return isLong ? diff : -diff;
  }

  async openPosition({ asset, side, size, leverage, marginMode, limitPrice }) {
    const assetName = asset.toUpperCase();
    const isBuy = side === 'long';
    const lev = leverage || config.trading.defaultLeverage;
    if (!Number.isFinite(Number(lev)) || Number(lev) < 1 || Number(lev) > 100) {
      throw new Error(`leverage inválido: ${lev}`);
    }
    const isCross = (marginMode || config.trading.marginMode) === 'cross';

    const [assetMeta, mids, accountState] = await Promise.all([
      this.hl.getAssetMeta(assetName),
      this.hl.getAllMids(),
      this.hl.getClearinghouseState(),
    ]);
    const { index: assetIndex, szDecimals } = assetMeta;

    const midPrice = parseFloat(mids[assetName]);
    if (!midPrice) throw new Error(`Precio no disponible para ${assetName}`);

    const notionalValue = parseFloat(size) * midPrice;
    const requiredMarginValue = notionalValue / lev;
    const withdrawable = parseFloat(accountState.withdrawable || 0);
    const accountValue = parseFloat(accountState.marginSummary?.accountValue || accountState.crossMarginSummary?.accountValue || 0);

    // En isolated margin, el margen ya bloqueado en la posición existente
    // puede absorber un incremento del mismo lado sin necesitar margen
    // fresco (posiciones sobre-colateralizadas). Solo exigimos `extraNeeded`
    // del withdrawable cuando el nuevo notional total supera lo que el
    // marginUsed actual ya cubre.
    const positionEntry = (accountState.assetPositions || []).find(
      (p) => String(p.position?.coin || '').toUpperCase() === assetName
    );
    const existingMarginUsd = Number(positionEntry?.position?.marginUsed || 0);
    const existingSzi = parseFloat(positionEntry?.position?.szi || 0);
    const slotRawUsd = Number(positionEntry?.position?.leverage?.rawUsd || 0);
    const hasExistingPosition = Number.isFinite(existingSzi) && existingSzi !== 0;
    const existingIsLong = existingSzi > 0;
    const sameSide = isBuy ? existingSzi > 0 : existingSzi < 0;
    let marginShortfall;
    if (!isCross && sameSide && existingMarginUsd > 0) {
      // HL exige que el margen del INCREMENTO (no del total) provenga de
      // `withdrawable` al añadir size a una posición isolated existente.
      // El excedente del slot isolated no se auto-usa para nueva size,
      // aunque el total ya esté sobre-colateralizado. Lo que sí se puede
      // hacer antes del `placeOrder` es extraer el excedente del slot de
      // vuelta a cross (updateIsolatedMargin con ntli negativo). Por eso
      // aquí sumamos `availableForIncrement = withdrawable + slotSurplus`.
      const SAFETY_BUFFER_FACTOR = 1.2;
      const slotSurplusExtractable = Math.max(0, slotRawUsd - existingMarginUsd * SAFETY_BUFFER_FACTOR);
      const availableForIncrement = withdrawable + slotSurplusExtractable;
      const incrementMargin = requiredMarginValue; // = size*price/lev para el increment
      marginShortfall = incrementMargin > availableForIncrement ? incrementMargin : 0;
    } else {
      marginShortfall = requiredMarginValue > withdrawable ? requiredMarginValue : 0;
    }
    if (marginShortfall > 0) {
      throw new Error(
        `Margen insuficiente: necesitas $${marginShortfall.toFixed(2)}, disponible $${withdrawable.toFixed(2)}`
      );
    }
    // Segundo guardrail: contra el accountValue total (no solo withdrawable)
    // para detectar casos degenerados donde el cálculo previo produzca 0
    // pero la cuenta está realmente bajo agua.
    if (accountValue > 0 && requiredMarginValue > accountValue * 1.01) {
      throw new Error(
        `Margen requerido ($${requiredMarginValue.toFixed(2)}) excede el valor de la cuenta ($${accountValue.toFixed(2)})`
      );
    }

    // Si hay posición abierta del LADO OPUESTO y se intenta cambiar margin mode
    // (isolated ↔ cross), HL acepta el cambio pero puede liquidar al instante por
    // falta de colateral en el nuevo modo. Bloqueamos explícitamente.
    if (hasExistingPosition && !sameSide) {
      const currentIsCross = Boolean(positionEntry?.position?.leverage?.type === 'cross');
      if (currentIsCross !== isCross) {
        throw new Error(
          `Hay una posición ${existingIsLong ? 'LONG' : 'SHORT'} abierta en ${assetName} en modo ` +
          `${currentIsCross ? 'cross' : 'isolated'}. Cámbialo solo tras cerrar la posición.`
        );
      }
    }

    const mutexKey = leverageMutex.leverageKey({ accountId: this.account?.id, assetIndex });
    return leverageMutex.runExclusive(mutexKey, async () => {
      await this.hl.updateLeverage(assetIndex, isCross, lev);

      let orderPrice;
      if (limitPrice) {
        orderPrice = formatPrice(limitPrice);
      } else {
        orderPrice = isBuy
          ? formatPrice(midPrice * (1 + MARKET_ORDER_SLIPPAGE))
          : formatPrice(midPrice * (1 - MARKET_ORDER_SLIPPAGE));
      }

      const result = await this.hl.placeOrder({
        assetIndex,
        isBuy,
        size: formatSize(size, szDecimals),
        price: orderPrice,
        reduceOnly: false,
        tif: limitPrice ? 'Gtc' : 'Ioc',
      });

      const fillPrice = result.avgPx || parseFloat(orderPrice);
      const filledQty = result.filledSz;

      const openResult = {
        success: true,
        action: 'open',
        account: this.account,
        asset: assetName,
        side,
        size,
        leverage: lev,
        marginMode: isCross ? 'cross' : 'isolated',
        orderPrice,
        fillPrice,
        filledQty,
        result,
      };
      this.tg.notifyTradeOpen(openResult);
      await balanceCacheService.refreshSnapshot(this.userId, this.account.id).catch((err) => logger.warn('balance cache refresh failed', { userId: this.userId, accountId: this.account.id, error: err.message }));
      return openResult;
    });
  }

  async closePosition({ asset, size }) {
    const assetName = asset.toUpperCase();

    const state = await this.hl.getClearinghouseState();
    const positions = state.assetPositions || [];

    const positionEntry = positions.find(
      (p) => p.position?.coin?.toUpperCase() === assetName
    );

    if (!positionEntry || !positionEntry.position) {
      throw new Error(`No existe posicion abierta en ${assetName}`);
    }

    const position = positionEntry.position;
    const szi = parseFloat(position.szi);
    const isLong = szi > 0;
    const entryPrice = parseFloat(position.entryPx);

    if (szi === 0) throw new Error(`La posicion en ${assetName} es cero`);

    const closeSize = size ? Math.min(Math.abs(size), Math.abs(szi)) : Math.abs(szi);

    const [{ index: assetIndex, szDecimals }, mids] = await Promise.all([
      this.hl.getAssetMeta(assetName),
      this.hl.getAllMids(),
    ]);

    const midPrice = parseFloat(mids[assetName]);
    if (!midPrice) throw new Error(`Precio no disponible para ${assetName}`);

    const closePrice = isLong
      ? formatPrice(midPrice * (1 - MARKET_ORDER_SLIPPAGE))
      : formatPrice(midPrice * (1 + MARKET_ORDER_SLIPPAGE));

    let result = await this.hl.placeOrder({
      assetIndex,
      isBuy: !isLong,
      size: formatSize(closeSize, szDecimals),
      price: closePrice,
      reduceOnly: true,
      tif: 'Ioc',
    });

    // Si el IOC no rellenó (book delgado), reintentamos con slippage ampliado
    // antes de rendirnos. Sin este fallback, un mercado momentáneamente ilíquido
    // deja la posición abierta y expuesta hasta que el usuario repita el cierre.
    if (result.filledSz != null && result.filledSz === 0) {
      const WIDER_SLIPPAGE = Math.max(MARKET_ORDER_SLIPPAGE * 5, 0.01);
      const aggressivePrice = isLong
        ? formatPrice(midPrice * (1 - WIDER_SLIPPAGE))
        : formatPrice(midPrice * (1 + WIDER_SLIPPAGE));
      logger.warn('close_ioc_retry_wider_slippage', { asset: assetName, initialPrice: closePrice, retryPrice: aggressivePrice });
      result = await this.hl.placeOrder({
        assetIndex,
        isBuy: !isLong,
        size: formatSize(closeSize, szDecimals),
        price: aggressivePrice,
        reduceOnly: true,
        tif: 'Ioc',
      });
    }

    if (result.filledSz != null && result.filledSz === 0) {
      throw new Error(`IOC close para ${assetName} no produjo fill (book demasiado delgado; reintentar manualmente con orden límite)`);
    }

    const actualClosedSize = result.filledSz != null ? result.filledSz : closeSize;
    const actualClosePrice = result.avgPx || parseFloat(closePrice);
    // Detectar fill parcial: tolerancia 1% para absorber truncados de szDecimals.
    const partial = result.filledSz != null
      && (actualClosedSize + 1e-9) < closeSize * 0.99;

    const closeResult = {
      success: true,
      action: 'close',
      account: this.account,
      asset: assetName,
      closedSide: isLong ? 'long' : 'short',
      closedSize: actualClosedSize,
      requestedSize: closeSize,
      partial,
      openPrice: Number.isFinite(entryPrice) ? entryPrice : null,
      closePrice: actualClosePrice,
      filledQty: actualClosedSize,
      pnl: this._estimateClosedPnl({
        entryPrice,
        closePrice: actualClosePrice,
        size: actualClosedSize,
        isLong,
      }),
      result,
    };
    this.tg.notifyTradeClose(closeResult);
    await balanceCacheService.refreshSnapshot(this.userId, this.account.id).catch((err) => logger.warn('balance cache refresh failed', { userId: this.userId, accountId: this.account.id, error: err.message }));
    return closeResult;
  }

  async getAccountState({ force = false } = {}) {
    const state = await balanceCacheService.getSnapshot(this.userId, this.account.id, { force });
    return {
      account: this.account,
      accountValue: state.accountValue,
      totalMarginUsed: state.totalMarginUsed,
      totalNtlPos: state.totalNtlPos,
      withdrawable: state.withdrawable,
      positions: state.positions,
      lastUpdatedAt: state.lastUpdatedAt,
    };
  }

  async getOpenOrders({ force = false } = {}) {
    const state = await balanceCacheService.getSnapshot(this.userId, this.account.id, { force });
    return {
      account: this.account,
      orders: state.openOrders,
      lastUpdatedAt: state.lastUpdatedAt,
    };
  }

  async setSLTP({ asset, side, size, slPrice, tpPrice }) {
    const result = await placePositionProtection({
      hl: this.hl,
      asset,
      side,
      size,
      slPrice,
      tpPrice,
    });
    await balanceCacheService.refreshSnapshot(this.userId, this.account.id).catch((err) => logger.warn('balance cache refresh failed', { userId: this.userId, accountId: this.account.id, error: err.message }));
    return {
      account: this.account,
      result,
    };
  }

  async cancelOrder(asset, orderId) {
    const assetIndex = await this.hl.getAssetIndex(asset);
    const result = await this.hl.cancelOrder(assetIndex, orderId);
    await balanceCacheService.refreshSnapshot(this.userId, this.account.id).catch((err) => logger.warn('balance cache refresh failed', { userId: this.userId, accountId: this.account.id, error: err.message }));
    return { success: true, account: this.account, result };
  }
}

module.exports = TradingService;
