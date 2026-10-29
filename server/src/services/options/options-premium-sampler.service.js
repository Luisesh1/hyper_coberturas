/**
 * Muestreador de prima: cada minuto anota, para cada posición abierta (sombra
 * y real), el precio al que se podría cerrar —bid si se compró, ask si se
 * vendió— en su rango máximo/mínimo. Binance borra los contratos vencidos,
 * así que este registro es la única fuente fiable del recorrido de la prima.
 *
 * Una sola petición por pasada: el ticker de todos los contratos (cacheado en
 * el servicio de mercado). Sin lado ejecutable (libro vacío) no hay muestra.
 */

const logger = require('../logger.service');
const defaultRepo = require('../../repositories/options-strategies.repository');
const { num } = require('./options-utils');

const SAMPLE_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 15_000;

function lazyGetTickers() {
  // eslint-disable-next-line global-require
  return (...args) => require('./options-market.service').getTickers(...args);
}

function closePrice(position, ticker) {
  const price = num(position.side === 'SELL' ? ticker?.askPrice : ticker?.bidPrice);
  return price > 0 ? price : null;
}

class OptionsPremiumSampler {
  constructor(deps = {}) {
    this.repo = deps.repo || defaultRepo;
    this.getTickers = deps.getTickers || lazyGetTickers();
    this.logger = deps.logger || logger;
    this.now = deps.now || Date.now;
    this.intervalMs = deps.intervalMs || SAMPLE_INTERVAL_MS;
    this.interval = null;
    this.firstRun = null;
    this.running = false;
  }

  start() {
    if (this.interval) return;
    const run = () => this.sample().catch((err) => this.logger.warn('options_premium_sample_failed', { error: err.message }));
    this.firstRun = setTimeout(run, FIRST_RUN_DELAY_MS);
    this.firstRun.unref?.();
    this.interval = setInterval(run, this.intervalMs);
    this.interval.unref?.();
  }

  stop() {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.interval) clearInterval(this.interval);
    this.firstRun = null;
    this.interval = null;
  }

  async sample() {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      const positions = await this.repo.listAllOpenPositions();
      if (!positions.length) return { sampled: 0 };
      const tickers = await this.getTickers();
      const bySymbol = new Map((Array.isArray(tickers) ? tickers : []).map((t) => [t.symbol, t]));
      const at = this.now();
      let sampled = 0;
      for (const position of positions) {
        const price = closePrice(position, bySymbol.get(position.symbol));
        if (price === null) continue;
        try {
          if (await this.repo.recordPremiumSample(position.id, price, at)) sampled += 1;
        } catch (err) {
          this.logger.warn('options_premium_sample_write_failed', { positionId: position.id, error: err.message });
        }
      }
      return { sampled };
    } finally {
      this.running = false;
    }
  }
}

const sampler = new OptionsPremiumSampler();

module.exports = sampler;
module.exports.OptionsPremiumSampler = OptionsPremiumSampler;
module.exports.closePrice = closePrice;
