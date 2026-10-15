/**
 * Grabador de IV: cada hora guarda un snapshot de la cadena de cada
 * subyacente (vencimientos cercanos, strikes alrededor del spot) en
 * `options_iv_snapshots`. Es la fuente `recorded` del backtest, porque
 * Binance no publica precios de opciones vencidas.
 */

const logger = require('../logger.service');
const defaultRepo = require('../../repositories/options-iv-snapshots.repository');
const { HOUR_MS, DAY_MS, ivToDecimal, num } = require('./options-utils');

const UNDERLYINGS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'];
const RETENTION_DAYS = 400;
const MAX_DTE_DAYS = 45;
const MAX_EXPIRIES = 8;
// Strikes dentro de ±35 % del spot: lo que usan las plantillas.
const STRIKE_BAND = 0.35;
const FIRST_RUN_DELAY_MS = 60_000;

function lazyGetChain() {
  // eslint-disable-next-line global-require
  return (...args) => require('./options-market.service').getChain(...args);
}

function legToSnapshot({ underlying, expiry, strike, type, leg, spot, capturedAt }) {
  if (!leg?.symbol) return null;
  return {
    underlying,
    symbol: leg.symbol,
    expiry,
    strike,
    type,
    bid: num(leg.bid),
    ask: num(leg.ask),
    mark: num(leg.mark),
    iv: ivToDecimal(leg.iv),
    delta: num(leg.delta),
    spot,
    capturedAt,
  };
}

class OptionsIvRecorder {
  constructor(deps = {}) {
    this.repo = deps.repo || defaultRepo;
    this.getChain = deps.getChain || lazyGetChain();
    this.underlyings = deps.underlyings || UNDERLYINGS;
    this.logger = deps.logger || logger;
    this.now = deps.now || Date.now;
    this.intervalMs = deps.intervalMs || HOUR_MS;
    this.retentionDays = deps.retentionDays || RETENTION_DAYS;
    this.interval = null;
    this.firstRun = null;
    this.running = false;
    this.lastCapturedAt = null;
  }

  start() {
    if (this.interval) return;
    const run = () => this.capture().catch((err) => this.logger.warn('options_iv_capture_failed', { error: err.message }));
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

  async snapshotUnderlying(underlying, capturedAt) {
    const base = await this.getChain(underlying);
    const spot = num(base?.spot);
    if (!(spot > 0)) return [];
    const expiries = (base.expiries || [])
      .filter((e) => Number(e.dte) > 0 && Number(e.dte) <= MAX_DTE_DAYS)
      .slice(0, MAX_EXPIRIES);
    const rows = [];
    for (const expiry of expiries) {
      const chain = expiry.code === base.expiry ? base : await this.getChain(underlying, expiry.code);
      for (const row of chain?.rows || []) {
        const strike = Number(row.strike);
        if (Math.abs(strike / spot - 1) > STRIKE_BAND) continue;
        const common = { underlying, expiry: expiry.code, strike, spot, capturedAt };
        for (const snap of [
          legToSnapshot({ ...common, type: 'C', leg: row.call }),
          legToSnapshot({ ...common, type: 'P', leg: row.put }),
        ]) {
          if (snap) rows.push(snap);
        }
      }
    }
    return rows;
  }

  /** Captura un snapshot (alineado a la hora) y aplica la retención. */
  async capture() {
    if (this.running) return { skipped: true };
    const capturedAt = Math.floor(this.now() / HOUR_MS) * HOUR_MS;
    if (this.lastCapturedAt === capturedAt) return { skipped: true };
    this.running = true;
    try {
      let inserted = 0;
      for (const underlying of this.underlyings) {
        try {
          const rows = await this.snapshotUnderlying(underlying, capturedAt);
          if (rows.length) inserted += await this.repo.insertMany(rows);
        } catch (err) {
          this.logger.warn('options_iv_underlying_failed', { underlying, error: err.message });
        }
      }
      const deleted = await this.repo.deleteOlderThan(capturedAt - this.retentionDays * DAY_MS);
      this.lastCapturedAt = capturedAt;
      this.logger.info('options_iv_captured', { capturedAt, inserted, deleted });
      return { capturedAt, inserted, deleted };
    } finally {
      this.running = false;
    }
  }
}

const recorder = new OptionsIvRecorder();

module.exports = recorder;
module.exports.OptionsIvRecorder = OptionsIvRecorder;
module.exports.UNDERLYINGS = UNDERLYINGS;
