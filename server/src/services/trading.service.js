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
const { formatPrice, formatSize } = require('../utils/format');

// Slippage para ordenes de mercado: margen minimo para garantizar ejecucion inmediata
const MARKET_ORDER_SLIPPAGE = 0.002; // 0.2%

class TradingService {
  /**
   * @param {import('./hyperliquid.service')} hlService
   * @param {import('./telegram.service')} tgService
   */
  constructor(hlService, tgService) {
    this.hl = hlService;
    this.tg = tgService;
  }

  async openPosition({ asset, side, size, leverage, marginMode, limitPrice }) {
    const assetName = asset.toUpperCase();
    const isBuy = side === 'long';
    const lev = leverage || config.trading.defaultLeverage;
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

    if (requiredMarginValue > withdrawable) {
      throw new Error(
        `Margen insuficiente: necesitas $${requiredMarginValue.toFixed(2)}, disponible $${withdrawable.toFixed(2)}`
      );
    }

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

    const openResult = {
      success: true,
      action: 'open',
      asset: assetName,
      side,
      size,
      leverage: lev,
      marginMode: isCross ? 'cross' : 'isolated',
      orderPrice,
      result,
    };
    this.tg.notifyTradeOpen(openResult);
    return openResult;
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

    const result = await this.hl.placeOrder({
      assetIndex,
      isBuy: !isLong,
      size: formatSize(closeSize, szDecimals),
      price: closePrice,
      reduceOnly: true,
      tif: 'Ioc',
    });

    const closeResult = {
      success: true,
      action: 'close',
      asset: assetName,
      closedSide: isLong ? 'long' : 'short',
      closedSize: closeSize,
      closePrice,
      result,
    };
    this.tg.notifyTradeClose(closeResult);
    return closeResult;
  }

  async getAccountState() {
    const state = await this.hl.getClearinghouseState();
    const marginSummary = state.marginSummary || {};
    const positions = (state.assetPositions || [])
      .filter((p) => parseFloat(p.position?.szi || 0) !== 0)
      .map((p) => ({
        asset: p.position.coin,
        size: p.position.szi,
        entryPrice: p.position.entryPx,
        leverage: p.position.leverage,
        unrealizedPnl: p.position.unrealizedPnl,
        returnOnEquity: p.position.returnOnEquity,
        liquidationPrice: p.position.liquidationPx,
        marginUsed: p.position.marginUsed,
        side: parseFloat(p.position.szi) > 0 ? 'long' : 'short',
      }));

    return {
      accountValue: marginSummary.accountValue,
      totalMarginUsed: marginSummary.totalMarginUsed,
      totalNtlPos: marginSummary.totalNtlPos,
      withdrawable: state.withdrawable,
      positions,
    };
  }

  async getOpenOrders() {
    return this.hl.getOpenOrders();
  }

  async setSLTP({ asset, side, size, slPrice, tpPrice }) {
    return placePositionProtection({
      hl: this.hl,
      asset,
      side,
      size,
      slPrice,
      tpPrice,
    });
  }

  async cancelOrder(asset, orderId) {
    const assetIndex = await this.hl.getAssetIndex(asset);
    const result = await this.hl.cancelOrder(assetIndex, orderId);
    return { success: true, result };
  }
}

module.exports = TradingService;
