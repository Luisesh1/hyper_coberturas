/**
 * Runner de estrategias de opciones.
 *
 * Cada 5 min evalúa las estrategias en modo `shadow` o `live` con su template
 * puro. La sombra corre SIEMPRE (también para las estrategias reales, como
 * libro paralelo de comparación): llena contra el libro real (compra al ask,
 * vende al bid) con la comisión de Binance. El ejecutor real envía órdenes
 * límite al mismo precio tras aplicar los límites globales y los de la
 * estrategia. Las posiciones vencidas se liquidan (europeas) contra el índice.
 *
 * Las dependencias de Backend A (`getChain`, `getQuote`, `getClientForUser`,
 * `getLimits`) se inyectan o se cargan con `require` perezoso, para que este
 * módulo cargue y se pruebe sin ellas.
 */

const logger = require('../logger.service');
const defaultRepo = require('../../repositories/options-strategies.repository');
const templates = require('./templates');
const {
  parseSymbol,
  fillPrice,
  tradeFee,
  exerciseFee,
  signedPremium,
  grossPnl,
  num,
} = require('./options-utils');
const { intrinsic } = require('./options-pricing');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function lazyMarket() {
  // eslint-disable-next-line global-require
  const load = () => require('./options-market.service');
  return {
    getChain: (...args) => load().getChain(...args),
    getQuote: (...args) => load().getQuote(...args),
  };
}

function lazyCredentials() {
  // eslint-disable-next-line global-require
  const load = () => require('./options-credentials.service');
  return {
    getClientForUser: (...args) => load().getClientForUser(...args),
    getLimits: (...args) => load().getLimits(...args),
  };
}

async function notifyTelegram(userId, text) {
  // eslint-disable-next-line global-require
  const telegramRegistry = require('../telegram.registry');
  const tg = await telegramRegistry.getOrCreate(userId);
  if (tg && typeof tg.send === 'function') await tg.send(text);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Margen estimado de una pata (USDT). Vendida: prima + máx(15 % del spot −
 * lo que esté OTM, 10 % del spot), por unidad. Comprada: la prima pagada.
 */
function estimateMargin({ side, type, strike, price, quantity, spot }) {
  const qty = Number(quantity);
  if (side === 'BUY') return Number(price) * qty;
  const otm = type === 'C' ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  return qty * (Number(price) + Math.max(0.15 * spot - otm, 0.1 * spot));
}

/** Delta neta en unidades del subyacente (vender una call resta delta). */
function legDeltaExposure({ side, delta, quantity }) {
  const d = num(delta) ?? 0;
  return (side === 'SELL' ? -d : d) * Number(quantity);
}

class OptionsStrategyRunner {
  constructor(deps = {}) {
    this.repo = deps.repo || defaultRepo;
    this.market = deps.market || lazyMarket();
    this.credentials = deps.credentials || lazyCredentials();
    this.notify = deps.notify || notifyTelegram;
    this.logger = deps.logger || logger;
    this.now = deps.now || Date.now;
    this.intervalMs = deps.intervalMs || DEFAULT_INTERVAL_MS;
    this.interval = null;
    this.running = false;
    // Cola por estrategia: el tick y una señal no evalúan la misma a la vez.
    this.locks = new Map();
  }

  async withLock(strategyId, fn) {
    const previous = this.locks.get(strategyId) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(strategyId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(strategyId) === tail) this.locks.delete(strategyId);
    }
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.tick().catch((err) => this.logger.error('options_runner_tick_failed', { error: err.message }));
    }, this.intervalMs);
    this.interval.unref?.();
    this.logger.info('options_runner_started', { intervalMs: this.intervalMs });
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** Una pasada completa. Sin solapes: si la anterior sigue, se omite. */
  async tick() {
    if (this.running) return { skipped: true };
    this.running = true;
    const tickCtx = { now: this.now(), chains: new Map() };
    try {
      await this.settleExpired(tickCtx);
      const strategies = await this.repo.listActiveStrategies();
      for (const strategy of strategies) {
        try {
          await this.withLock(strategy.id, () => this.runStrategy(strategy, tickCtx));
        } catch (err) {
          this.logger.warn('options_strategy_eval_failed', { strategyId: strategy.id, error: err.message });
          await this.recordOutcome(strategy, 'shadow', { type: 'error', reason: 'eval_error', detail: `Error al evaluar: ${err.message}` }, tickCtx);
        }
      }
      return { strategies: strategies.length };
    } finally {
      this.running = false;
    }
  }

  /**
   * Evalúa una estrategia con una señal (bots por alertas) al momento, con el
   * mismo contexto que el tick. Devuelve las acciones del template por modo y
   * lo que produjeron: llenados (`booked`) y motivos de skip/hold/error.
   */
  async runForSignal(strategy, signal) {
    const tickCtx = { now: this.now(), chains: new Map(), signal, produced: [] };
    const actions = await this.withLock(strategy.id, () => this.runStrategy(strategy, tickCtx));
    return { actions, produced: tickCtx.produced };
  }

  // ---------- datos de mercado (caché por pasada) ----------

  async chainFor(underlying, expiry, tickCtx) {
    const key = `${underlying}:${expiry || ''}`;
    if (!tickCtx.chains.has(key)) {
      tickCtx.chains.set(key, this.market.getChain(underlying, expiry || undefined));
    }
    return tickCtx.chains.get(key);
  }

  async spotFor(underlying, tickCtx) {
    const chain = await this.chainFor(underlying, null, tickCtx);
    return num(chain?.spot);
  }

  async targetChain(strategy, params, tickCtx) {
    const base = await this.chainFor(strategy.underlying, null, tickCtx);
    // El rango pertenece a la alerta disparada: no se amplía para forzar entradas.
    // Solo se aplica a bots por señales; sin rango la selección sigue igual.
    const minDays = tickCtx.signal?.optionExpiryMinDays;
    const maxDays = tickCtx.signal?.optionExpiryMaxDays;
    const expiries = minDays != null && maxDays != null && strategy.template === 'alert_signal'
      ? (base?.expiries || []).filter((expiry) => Number(expiry.dte) >= minDays && Number(expiry.dte) <= maxDays)
      : base?.expiries;
    const pick = templates.pickExpiry(expiries, params.expiryDays);
    if (!pick) return { base, chain: null };
    const chain = pick.code === base.expiry ? base : await this.chainFor(strategy.underlying, pick.code, tickCtx);
    return { base, chain };
  }

  async quoteFor(symbol) {
    try {
      return await this.market.getQuote(symbol);
    } catch (err) {
      this.logger.warn('options_quote_failed', { symbol, error: err.message });
      return null;
    }
  }

  async enrichPositions(positions, chain) {
    const out = [];
    for (const position of positions) {
      const meta = parseSymbol(position.symbol) || {};
      let quote = null;
      if (chain && meta.expiry === chain.expiry) {
        const row = chain.rows?.find((r) => Number(r.strike) === meta.strike);
        quote = row ? (meta.type === 'C' ? row.call : row.put) : null;
      }
      if (!quote) quote = await this.quoteFor(position.symbol);
      out.push({ ...position, ...meta, quote });
    }
    return out;
  }

  // ---------- evaluación ----------

  async runStrategy(strategy, tickCtx) {
    const template = templates.getTemplate(strategy.template);
    const params = templates.validateParams(strategy.template, strategy.params);
    const { base, chain } = await this.targetChain(strategy, params, tickCtx);
    const spot = num(chain?.spot) ?? num(base?.spot);
    const modes = strategy.mode === 'live' ? ['shadow', 'live'] : ['shadow'];
    const byMode = {};

    for (const mode of modes) {
      const open = await this.repo.listOpenPositions(strategy.id, mode);
      const positions = await this.enrichPositions(open, chain);
      const lastOpenedAt = await this.repo.lastOpenedAt(strategy.id, mode);
      // Solo los bots por alertas limitan operaciones por día.
      const tradesToday = template.signalDriven
        ? await this.repo.countEventsSince(strategy.id, mode, 'open', utcDayStart(tickCtx.now))
        : undefined;
      const actions = template.evaluate({
        now: tickCtx.now,
        underlying: strategy.underlying,
        spot,
        chain,
        positions,
        params,
        lastOpenedAt,
        mode,
        signal: tickCtx.signal || null,
        tradesToday,
      });
      byMode[mode] = actions;
      const ctx = { ...tickCtx, spot, positions, params, mode };
      for (const action of actions) {
        try {
          if (action.type === 'open' || action.type === 'close') {
            if (mode === 'live') await this.executeLive(strategy, action, ctx);
            else await this.executeShadow(strategy, action, ctx);
          } else {
            await this.recordOutcome(strategy, mode, action, tickCtx);
          }
        } catch (err) {
          this.logger.warn('options_action_failed', { strategyId: strategy.id, mode, error: err.message });
          await this.recordOutcome(strategy, mode, { type: 'error', reason: 'exec_error', detail: err.message }, tickCtx);
          if (mode === 'live') await this.maybeNotify(strategy, `Error en modo real: ${err.message}`);
        }
      }
    }
    return byMode;
  }

  /**
   * Registra hold/skip/error solo cuando cambia el motivo, para no llenar la
   * tabla de eventos con una fila cada 5 minutos.
   */
  async recordOutcome(strategy, mode, action, tickCtx) {
    tickCtx.produced?.push({ mode, type: action.type, reason: action.reason, detail: action.detail || action.reason });
    const state = strategy.state || {};
    const lastReasons = { ...(state.lastReasons || {}) };
    const key = `${action.type}:${action.reason}:${action.type === 'error' ? action.detail : ''}`;
    if (lastReasons[mode] === key) return;
    lastReasons[mode] = key;
    strategy.state = { ...state, lastReasons };
    await this.repo.setState(strategy.id, strategy.state);
    await this.repo.insertEvent({
      strategyId: strategy.id,
      userId: strategy.userId,
      mode,
      action: action.type,
      detail: action.detail || action.reason,
      createdAt: tickCtx.now,
    });
  }

  async resetOutcome(strategy, mode) {
    const lastReasons = { ...(strategy.state?.lastReasons || {}) };
    if (!(mode in lastReasons)) return;
    delete lastReasons[mode];
    strategy.state = { ...(strategy.state || {}), lastReasons };
    await this.repo.setState(strategy.id, strategy.state);
  }

  // ---------- ejecutor sombra ----------

  async quoteLegs(legs) {
    const quotes = [];
    for (const leg of legs) {
      const quote = await this.quoteFor(leg.symbol);
      const price = fillPrice(quote, leg.side);
      if (price == null) return { missing: leg.symbol };
      quotes.push({ quote, price });
    }
    return { quotes };
  }

  async executeShadow(strategy, action, ctx) {
    const { quotes, missing } = await this.quoteLegs(action.legs);
    if (missing) {
      await this.recordOutcome(strategy, 'shadow', { type: 'error', reason: 'no_liquidity', detail: `Sin precio en el libro para ${missing}` }, ctx);
      return null;
    }
    const filled = action.legs.map((leg, i) => {
      const { quote, price } = quotes[i];
      const spot = num(quote.spot) ?? ctx.spot;
      return { ...leg, price, fee: tradeFee({ spot, quantity: leg.quantity, price }) };
    });
    return this.book(strategy, 'shadow', action, filled, ctx);
  }

  /** Persiste un llenado (sombra o real): posiciones y evento. */
  async book(strategy, mode, action, filled, ctx) {
    const openById = new Map((ctx.positions || []).map((p) => [p.id, p]));
    let premium = 0;
    for (const leg of filled) {
      premium += signedPremium(leg.side, leg.price, leg.quantity);
      if (action.type === 'open') {
        await this.repo.insertPosition({
          strategyId: strategy.id,
          userId: strategy.userId,
          mode,
          symbol: leg.symbol,
          side: leg.side,
          quantity: leg.quantity,
          entryPrice: leg.price,
          openedAt: ctx.now,
          feesUsdt: leg.fee,
        });
      } else {
        const position = openById.get(leg.positionId);
        if (!position) continue;
        const fees = position.feesUsdt + leg.fee;
        const pnl = grossPnl({ side: position.side, entryPrice: position.entryPrice, exitPrice: leg.price, quantity: position.quantity }) - fees;
        await this.repo.closePosition(position.id, { exitPrice: leg.price, closedAt: ctx.now, pnlUsdt: pnl, feesUsdt: fees });
      }
    }
    const event = await this.repo.insertEvent({
      strategyId: strategy.id,
      userId: strategy.userId,
      mode,
      action: action.type,
      detail: action.detail || action.reason,
      legs: filled.map((l) => ({
        symbol: l.symbol,
        side: l.side,
        quantity: l.quantity,
        price: l.price,
        fee: l.fee,
        ...('orderId' in l ? { orderId: l.orderId } : {}),
      })),
      premiumUsdt: premium,
      createdAt: ctx.now,
    });
    await this.resetOutcome(strategy, mode);
    ctx.produced?.push({ mode, type: action.type, reason: action.reason, detail: action.detail || action.reason, booked: true, event });
    return event;
  }

  // ---------- ejecutor real ----------

  /** Comprueba los límites globales y de la estrategia antes de abrir. */
  async checkLiveLimits(strategy, legs, ctx) {
    let globalLimits;
    try {
      globalLimits = (await this.credentials.getLimits(strategy.userId)) || {};
    } catch (err) {
      return { ok: false, reason: `No se pudieron leer los límites globales: ${err.message}` };
    }
    const limits = strategy.limits || {};
    const dayStart = utcDayStart(ctx.now);
    const has = (v) => v != null && Number.isFinite(Number(v));

    const strategyLoss = -(await this.repo.realizedPnlSince({ userId: strategy.userId, strategyId: strategy.id, mode: 'live', since: dayStart }));
    if (has(limits.maxDailyLossUsdt) && strategyLoss >= Number(limits.maxDailyLossUsdt)) {
      return { ok: false, reason: `Pérdida diaria de la estrategia (${strategyLoss.toFixed(2)} USDT) en el límite de ${limits.maxDailyLossUsdt} USDT` };
    }
    const userLoss = -(await this.repo.realizedPnlSince({ userId: strategy.userId, mode: 'live', since: dayStart }));
    if (has(globalLimits.maxDailyLossUsdt) && userLoss >= Number(globalLimits.maxDailyLossUsdt)) {
      return { ok: false, reason: `Pérdida diaria global (${userLoss.toFixed(2)} USDT) en el límite de ${globalLimits.maxDailyLossUsdt} USDT` };
    }

    if (has(limits.maxOrdersPerDay)) {
      const orders = await this.repo.countOrdersSince(strategy.id, 'live', dayStart);
      if (orders + legs.length > Number(limits.maxOrdersPerDay)) {
        return { ok: false, reason: `Máximo de ${limits.maxOrdersPerDay} órdenes por día alcanzado (${orders} enviadas)` };
      }
    }

    const newMargin = legs.reduce((acc, leg) => acc + estimateMargin({ ...leg, type: leg.optionType, spot: ctx.spot }), 0);
    const userOpen = await this.repo.listOpenPositionsByUser(strategy.userId, 'live');
    let userMargin = 0;
    let strategyMargin = 0;
    for (const p of userOpen) {
      const meta = parseSymbol(p.symbol);
      if (!meta) continue;
      const spot = meta.underlying === String(strategy.underlying).toUpperCase() ? ctx.spot : await this.spotFor(meta.underlying, ctx);
      // Lo comprado ya está pagado: solo las ventas consumen margen.
      const margin = p.side === 'SELL' ? estimateMargin({ ...p, type: meta.type, strike: meta.strike, price: p.entryPrice, spot }) : 0;
      userMargin += margin;
      if (p.strategyId === strategy.id) strategyMargin += margin;
    }
    if (has(limits.maxMarginUsdt) && strategyMargin + newMargin > Number(limits.maxMarginUsdt)) {
      return { ok: false, reason: `Margen estimado ${(strategyMargin + newMargin).toFixed(2)} USDT supera el límite de la estrategia (${limits.maxMarginUsdt} USDT)` };
    }
    if (has(globalLimits.maxMarginUsdt) && userMargin + newMargin > Number(globalLimits.maxMarginUsdt)) {
      return { ok: false, reason: `Margen estimado ${(userMargin + newMargin).toFixed(2)} USDT supera el límite global (${globalLimits.maxMarginUsdt} USDT)` };
    }

    if (has(limits.maxNetDelta)) {
      const current = (ctx.positions || []).reduce((acc, p) => acc + legDeltaExposure({ side: p.side, delta: p.quote?.delta, quantity: p.quantity }), 0);
      const net = legs.reduce((acc, leg) => acc + legDeltaExposure(leg), current);
      if (Math.abs(net) > Number(limits.maxNetDelta)) {
        return { ok: false, reason: `|Δ| neta ${Math.abs(net).toFixed(3)} supera el máximo de ${limits.maxNetDelta}` };
      }
    }
    return { ok: true, globalLimits };
  }

  async executeLive(strategy, action, ctx) {
    // Fail closed: ninguna llamada al exchange ni anotación de posiciones
    // hasta que haya ledger persistente de órdenes y conciliación de fills.
    // También bloquea cierres, para evitar órdenes huérfanas.
    await this.recordOutcome(strategy, 'live', {
      type: 'skip',
      reason: 'live_execution_pending_reconciliation',
      detail: 'Trading real suspendido: faltan ledger de órdenes, fills confirmados e idempotencia',
    }, ctx);
    return null;
  }

  async maybeNotify(strategy, message) {
    try {
      const limits = await this.credentials.getLimits(strategy.userId);
      if (!limits?.notifyTelegram) return;
      await this.notify(
        strategy.userId,
        `<b>Opciones · ${escapeHtml(strategy.name)}</b> (real)\n${escapeHtml(message)}`
      );
    } catch (err) {
      this.logger.warn('options_notify_failed', { strategyId: strategy.id, error: err.message });
    }
  }

  // ---------- liquidación al vencimiento ----------

  /**
   * Liquida las posiciones vencidas (europeas, sin ejercicio anticipado)
   * contra el precio índice. En modo real Binance liquida solo; aquí se
   * cierra el registro con el mismo cálculo.
   */
  async settleExpired(tickCtx) {
    const open = await this.repo.listAllOpenPositions();
    const expired = open
      .map((p) => ({ ...p, meta: parseSymbol(p.symbol) }))
      .filter((p) => p.meta && p.meta.expiryMs <= tickCtx.now);
    if (!expired.length) return 0;

    const groups = new Map();
    for (const p of expired) {
      const key = `${p.strategyId}:${p.mode}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    let settled = 0;
    for (const positions of groups.values()) {
      const { strategyId, userId, mode, meta } = positions[0];
      let indexPrice;
      try {
        indexPrice = await this.spotFor(meta.underlying, tickCtx);
      } catch (err) {
        this.logger.warn('options_settle_index_failed', { underlying: meta.underlying, error: err.message });
        continue;
      }
      if (!(indexPrice > 0)) continue;

      let premium = 0;
      const legs = [];
      // Nunca liquidar posiciones reales usando un índice estimado:
      // Binance debe confirmar la liquidación y sus comisiones.
      if (mode === 'live') {
        this.logger.warn('options_live_settlement_requires_reconciliation', { strategyId, count: positions.length });
        continue;
      }
      for (const p of positions) {
        const value = intrinsic({ S: indexPrice, K: p.meta.strike, type: p.meta.type });
        const fee = exerciseFee({ spot: indexPrice, quantity: p.quantity, intrinsicValue: value });
        const fees = p.feesUsdt + fee;
        const pnl = grossPnl({ side: p.side, entryPrice: p.entryPrice, exitPrice: value, quantity: p.quantity }) - fees;
        await this.repo.closePosition(p.id, { exitPrice: value, closedAt: tickCtx.now, pnlUsdt: pnl, feesUsdt: fees });
        premium += signedPremium(p.side === 'SELL' ? 'BUY' : 'SELL', value, p.quantity);
        legs.push({ symbol: p.symbol, side: p.side === 'SELL' ? 'BUY' : 'SELL', quantity: p.quantity, price: value, fee });
        settled += 1;
      }
      await this.repo.insertEvent({
        strategyId,
        userId,
        mode,
        action: 'close',
        detail: `Vencimiento: liquidado contra índice ${indexPrice}`,
        // Sin orderId: la liquidación no cuenta como orden enviada.
        legs,
        premiumUsdt: premium,
        createdAt: tickCtx.now,
      });
      this.logger.info('options_positions_settled', { strategyId, mode, count: legs.length, indexPrice });
    }
    return settled;
  }
}

const runner = new OptionsStrategyRunner();

module.exports = runner;
module.exports.OptionsStrategyRunner = OptionsStrategyRunner;
module.exports.estimateMargin = estimateMargin;
module.exports.legDeltaExposure = legDeltaExposure;
module.exports.utcDayStart = utcDayStart;
module.exports.lazyMarket = lazyMarket;
