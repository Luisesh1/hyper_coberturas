/**
 * market.service.js
 *
 * Logica de negocio para datos de mercado:
 * precios, contexto de activos (funding, OI, mark price), etc.
 */

const HyperliquidService = require('./hyperliquid.service');
const hlService = new HyperliquidService({});

class MarketService {
  /**
   * Retorna los precios mid de todos los pares de futuros.
   * Resultado: { BTC: "65000.5", ETH: "3200.1", ... }
   */
  async getAllPrices() {
    const mids = await hlService.getAllMids();
    return mids;
  }

  /**
   * Retorna el precio mid de un activo especifico.
   * @param {string} asset - Ej: "BTC", "ETH"
   */
  async getPrice(asset) {
    const mids = await hlService.getAllMids();
    const price = mids[asset.toUpperCase()];
    if (!price) throw new Error(`Precio no disponible para: ${asset}`);
    return { asset: asset.toUpperCase(), price, timestamp: Date.now() };
  }

  /**
   * Retorna todos los activos disponibles con sus metadatos
   * (tamano de tick, tamano minimo de orden, etc.)
   */
  async getAvailableAssets() {
    const meta = await hlService.getMeta();
    return meta.universe || [];
  }

  /**
   * Retorna datos de contexto enriquecidos para todos los activos:
   * mark price, funding rate, open interest, volumen 24h.
   */
  async getAssetContexts() {
    const [meta, ctxs] = await hlService.getMetaAndAssetCtxs();
    const universe = meta.universe || [];

    return universe.map((asset, idx) => {
      const ctx = ctxs[idx] || {};
      return {
        name: asset.name,
        index: idx,
        markPrice: ctx.markPx,
        midPrice: ctx.midPx,
        fundingRate: ctx.funding,
        openInterest: ctx.openInterest,
        volume24h: ctx.dayNtlVlm,
        prevDayPrice: ctx.prevDayPx,
        priceChange24h:
          ctx.markPx && ctx.prevDayPx
            ? (
                ((parseFloat(ctx.markPx) - parseFloat(ctx.prevDayPx)) /
                  parseFloat(ctx.prevDayPx)) *
                100
              ).toFixed(2)
            : null,
      };
    });
  }
}

module.exports = new MarketService();
