/**
 * trading.service.js
 *
 * Logica de negocio para operaciones de trading:
 * abrir posiciones apalancadas, cerrar posiciones, consultar estado.
 *
 * Abstrae la complejidad de los indices de activos y el calculo de
 * precios para ordenes de mercado.
 */

const hlService = require('./hyperliquid.service');
const telegram = require('./telegram.service');
const config = require('../config');

// Slippage para ordenes de mercado: margen minimo para garantizar ejecucion inmediata
const MARKET_ORDER_SLIPPAGE = 0.002; // 0.2%

/**
 * Formatea un precio a max 5 cifras significativas (requerido por Hyperliquid).
 * Ejemplo: 63736.93 -> "63737", 1847.42 -> "1847.4", 0.35740 -> "0.36100"
 */
function formatPrice(price) {
  if (!price || price <= 0) return '0';
  const d = Math.ceil(Math.log10(Math.abs(price)));
  const power = 5 - d;
  const magnitude = Math.pow(10, power);
  const rounded = Math.round(price * magnitude) / magnitude;
  return power > 0 ? rounded.toFixed(power) : rounded.toString();
}

/**
 * Formatea el tamano de una orden al numero de decimales del activo (szDecimals).
 * Ejemplo: BTC szDecimals=5 -> 0.0014912... -> "0.00149"
 * @param {number} size
 * @param {number} szDecimals - Obtenido de hlService.getAssetMeta()
 */
function formatSize(size, szDecimals) {
  const factor = Math.pow(10, szDecimals);
  return (Math.floor(parseFloat(size) * factor) / factor).toFixed(szDecimals);
}

class TradingService {
  /**
   * Abre una posicion apalancada (long o short).
   *
   * @param {object} params
   * @param {string} params.asset        - Simbolo del activo (ej: "BTC")
   * @param {'long'|'short'} params.side - Direccion de la posicion
   * @param {number} params.size         - Tamano en unidades del activo
   * @param {number} [params.leverage]   - Apalancamiento (default: config)
   * @param {'cross'|'isolated'} [params.marginMode] - Tipo de margen
   * @param {number} [params.limitPrice] - Si se especifica, usa orden limite
   */
  async openPosition({ asset, side, size, leverage, marginMode, limitPrice }) {
    const assetName = asset.toUpperCase();
    const isBuy = side === 'long';
    const lev = leverage || config.trading.defaultLeverage;
    const isCross = (marginMode || config.trading.marginMode) === 'cross';

    // 1. Obtener metadata del activo, precio actual y estado de cuenta en paralelo
    const [assetMeta, mids, accountState] = await Promise.all([
      hlService.getAssetMeta(assetName),
      hlService.getAllMids(),
      hlService.getClearinghouseState(),
    ]);
    const { index: assetIndex, szDecimals } = assetMeta;

    // 2. Validar margen disponible antes de operar
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

    // 3. Actualizar apalancamiento antes de operar
    await hlService.updateLeverage(assetIndex, isCross, lev);
    console.log(
      `[Trading] Apalancamiento actualizado: ${assetName} x${lev} (${isCross ? 'cross' : 'isolated'})`
    );

    // 4. Calcular precio para la orden (max 5 cifras significativas requerido por Hyperliquid)
    let orderPrice;
    if (limitPrice) {
      orderPrice = formatPrice(limitPrice);
    } else {
      // Orden de mercado simulada: precio muy favorable con slippage
      orderPrice = isBuy
        ? formatPrice(midPrice * (1 + MARKET_ORDER_SLIPPAGE))  // compra: precio alto
        : formatPrice(midPrice * (1 - MARKET_ORDER_SLIPPAGE)); // venta: precio bajo
    }

    // 5. Colocar la orden (size formateado a szDecimals decimales del activo)
    const result = await hlService.placeOrder({
      assetIndex,
      isBuy,
      size: formatSize(size, szDecimals),
      price: orderPrice,
      reduceOnly: false,
      tif: limitPrice ? 'Gtc' : 'Ioc', // market = Ioc (immediate or cancel)
    });

    console.log(`[Trading] Posicion ${side} abierta en ${assetName}:`, result);
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
    telegram.notifyTradeOpen(openResult);
    return openResult;
  }

  /**
   * Cierra una posicion existente (total o parcialmente).
   *
   * @param {object} params
   * @param {string} params.asset  - Simbolo del activo (ej: "BTC")
   * @param {number} [params.size] - Tamano a cerrar (si no se especifica, cierra todo)
   */
  async closePosition({ asset, size }) {
    const assetName = asset.toUpperCase();

    // 1. Obtener estado de la cuenta
    const state = await hlService.getClearinghouseState();
    const positions = state.assetPositions || [];

    // 2. Encontrar la posicion del activo
    const positionEntry = positions.find(
      (p) => p.position?.coin?.toUpperCase() === assetName
    );

    if (!positionEntry || !positionEntry.position) {
      throw new Error(`No existe posicion abierta en ${assetName}`);
    }

    const position = positionEntry.position;
    const szi = parseFloat(position.szi); // szi > 0 = long, szi < 0 = short
    const isLong = szi > 0;

    if (szi === 0) throw new Error(`La posicion en ${assetName} es cero`);

    // 3. Determinar tamano a cerrar
    const closeSize = size ? Math.min(Math.abs(size), Math.abs(szi)) : Math.abs(szi);

    // 4. Obtener metadata del activo y precio en paralelo
    const [{ index: assetIndex, szDecimals }, mids] = await Promise.all([
      hlService.getAssetMeta(assetName),
      hlService.getAllMids(),
    ]);

    const midPrice = parseFloat(mids[assetName]);
    if (!midPrice) throw new Error(`Precio no disponible para ${assetName}`);

    // 5. Calcular precio para cierre (opuesto a la posicion, max 5 sig figs)
    const closePrice = isLong
      ? formatPrice(midPrice * (1 - MARKET_ORDER_SLIPPAGE))
      : formatPrice(midPrice * (1 + MARKET_ORDER_SLIPPAGE));

    // 6. Colocar orden de cierre con reduceOnly = true
    const result = await hlService.placeOrder({
      assetIndex,
      isBuy: !isLong,
      size: formatSize(closeSize, szDecimals),
      price: closePrice,
      reduceOnly: true,
      tif: 'Ioc',
    });

    console.log(`[Trading] Posicion cerrada en ${assetName}:`, result);
    const closeResult = {
      success: true,
      action: 'close',
      asset: assetName,
      closedSide: isLong ? 'long' : 'short',
      closedSize: closeSize,
      closePrice,
      result,
    };
    telegram.notifyTradeClose(closeResult);
    return closeResult;
  }

  /**
   * Retorna el estado completo de la cuenta:
   * balance, margen disponible, posiciones abiertas con PnL.
   */
  async getAccountState() {
    const state = await hlService.getClearinghouseState();
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

  /**
   * Retorna las ordenes abiertas del usuario.
   */
  async getOpenOrders() {
    return hlService.getOpenOrders();
  }

  /**
   * Cancela una orden abierta.
   * @param {string} asset   - Simbolo del activo
   * @param {number} orderId - ID de la orden (oid)
   */
  async cancelOrder(asset, orderId) {
    const assetIndex = await hlService.getAssetIndex(asset);
    const result = await hlService.cancelOrder(assetIndex, orderId);
    return { success: true, result };
  }
}

module.exports = new TradingService();
