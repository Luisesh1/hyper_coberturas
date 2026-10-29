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
const defaultSamplesRepo = require('../../repositories/options-premium-samples.repository');
const { num, parseSymbol } = require('./options-utils');

const SAMPLE_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 15_000;
const DAY_MS = 24 * 3600 * 1000;
const RETENTION_DAYS = 120;

function lazyGetTickers() {
  // eslint-disable-next-line global-require
  return (...args) => require('./options-market.service').getTickers(...args);
}

function lazyGetSpot() {
  // eslint-disable-next-line global-require
  return (...args) => require('./options-market.service').getSpot(...args);
}

const positiveOrNull = (value) => {
  const n = num(value);
  return n > 0 ? n : null;
};

function closePrice(position, ticker) {
  const price = num(position.side === 'SELL' ? ticker?.askPrice : ticker?.bidPrice);
  return price > 0 ? price : null;
}

class OptionsPremiumSampler {
  constructor(deps = {}) {
    this.repo = deps.repo || defaultRepo;
    this.samplesRepo = deps.samplesRepo || defaultSamplesRepo;
    this.getTickers = deps.getTickers || lazyGetTickers();
    this.getSpot = deps.getSpot || lazyGetSpot();
    this.retentionDays = deps.retentionDays || RETENTION_DAYS;
    this.lastPurgeAt = 0;
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

  /** Spot del subyacente: una petición por subyacente y pasada, o null. */
  async spotOf(symbol, spots) {
    const underlying = parseSymbol(symbol)?.underlying;
    if (!underlying) return null;
    if (!spots.has(underlying)) {
      spots.set(underlying, Promise.resolve().then(() => this.getSpot(underlying)).then(positiveOrNull).catch(() => null));
    }
    return spots.get(underlying);
  }

  /** Una fila bid/ask/spot por posición y pasada; sin bid ni ask no hay fila. */
  async recordPath(position, ticker, at, spots) {
    const bid = positiveOrNull(ticker?.bidPrice);
    const ask = positiveOrNull(ticker?.askPrice);
    if (bid === null && ask === null) return;
    try {
      // El ticker de opciones de Binance trae el índice del subyacente en `exercisePrice`.
      const spot = positiveOrNull(ticker?.exercisePrice) ?? await this.spotOf(position.symbol, spots);
      await this.samplesRepo.insertSample(position.id, at, { bid, ask, spot });
    } catch (err) {
      this.logger.warn('options_premium_path_write_failed', { positionId: position.id, error: err.message });
    }
  }

  /** Purga diaria de las muestras más antiguas que la retención. */
  async purge(at) {
    if (at - this.lastPurgeAt < DAY_MS) return;
    this.lastPurgeAt = at;
    try {
      await this.samplesRepo.deleteOlderThan(at - this.retentionDays * DAY_MS);
    } catch (err) {
      this.logger.warn('options_premium_purge_failed', { error: err.message });
    }
  }

  async sample() {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      const positions = await this.repo.listAllOpenPositions();
      if (!positions.length) {
        await this.purge(this.now());
        return { sampled: 0 };
      }
      const tickers = await this.getTickers();
      const bySymbol = new Map((Array.isArray(tickers) ? tickers : []).map((t) => [t.symbol, t]));
      const at = this.now();
      const spots = new Map();
      let sampled = 0;
      for (const position of positions) {
        await this.recordPath(position, bySymbol.get(position.symbol), at, spots);
        const price = closePrice(position, bySymbol.get(position.symbol));
        if (price === null) continue;
        try {
          if (await this.repo.recordPremiumSample(position.id, price, at)) sampled += 1;
        } catch (err) {
          this.logger.warn('options_premium_sample_write_failed', { positionId: position.id, error: err.message });
        }
      }
      await this.purge(at);
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
