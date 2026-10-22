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
const { closeLegs } = require('./templates/helpers');
const { projectTakeProfit } = require('./options-take-profit');
const { fullSizeFokLimit } = require('./options-fok-depth');
const { isPilotSyntheticTpEligible, fixedTargetPrice } =
  require('./options-synthetic-tp-experiment');
const { ensureAtrBandTarget } = require('./options-atr-band-target');
const { estimateMargin, committedUsdt } = require('./options-committed-capital');
const { botUnderlyings } = require('./bot-underlyings');

// Cierres por toma de ganancia: con un TP LIMIT residente no se cancela ni
// se compite con él; deben alcanzar su objetivo con la cotización fresca.
const TAKE_PROFIT_REASONS = ['take_profit', 'take_profit_volatility', 'take_profit_atr_band'];
const TARGET_TP_REASONS = ['take_profit_volatility', 'take_profit_atr_band'];

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 60_000;

function lazyMarket() {
  // eslint-disable-next-line global-require
  const load = () => require('./options-market.service');
  return {
    getChain: (...args) => load().getChain(...args),
    getQuote: (...args) => load().getQuote(...args),
    getVolatilityInputs: (...args) => load().getVolatilityInputs(...args),
    getAtrBand: (...args) => load().getAtrBand(...args),
  };
}

function lazyLiveOrders() {
  // eslint-disable-next-line global-require
  const load = () => require('../../repositories/options-live-orders.repository');
  return { listByStrategy: (...args) => load().listByStrategy(...args) };
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

/** Subyacente de una posición según su símbolo (o `fallback`). */
function positionUnderlying(position, fallback) {
  return parseSymbol(position.symbol)?.underlying || String(fallback || '').toUpperCase();
}

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
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
    // Órdenes de entrada pendientes (reserva del presupuesto). Con un repo
    // inyectado (pruebas) no se abre el ledger PostgreSQL salvo que se pase.
    this.liveOrders = deps.liveOrders || (this.repo === defaultRepo
      ? lazyLiveOrders()
      : { listByStrategy: async () => [] });
    this.notify = deps.notify || notifyTelegram;
    this.logger = deps.logger || logger;
    this.now = deps.now || Date.now;
    this.intervalMs = deps.intervalMs || DEFAULT_INTERVAL_MS;
    this.interval = null;
    this.reconcileInterval = null;
    this.liveExecutor = deps.liveExecutor || require('./options-live-execution.service');
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
    // La conciliación continúa incluso si se deshabilitan nuevas órdenes.
    const reconcile = async () => {
      try {
        await this.liveExecutor.reconcilePending();
      } catch (err) {
        this.logger.error('options_reconcile_failed', { error: err.message });
      }
      if (typeof this.liveExecutor.reconcileExpired === 'function') {
        try {
          await this.liveExecutor.reconcileExpired();
        } catch (err) {
          this.logger.error('options_exercise_reconcile_failed', { error: err.message });
        }
      }
    };
    this.reconcileInterval = setInterval(reconcile, RECONCILE_INTERVAL_MS);
    this.reconcileInterval.unref?.();
    reconcile();
    this.logger.info('options_runner_started', { intervalMs: this.intervalMs });
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
    this.interval = null;
    this.reconcileInterval = null;
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
  async runForSignal(strategy, signal, { shadowOnly = false } = {}) {
    const tickCtx = { now: this.now(), chains: new Map(), signal, produced: [] };
    const actions = await this.withLock(strategy.id,
      () => this.runStrategy(strategy, tickCtx, { shadowOnly }));
    return { actions, produced: tickCtx.produced };
  }

  /**
   * Cierre manual (desde la UI) de las posiciones abiertas de un modo, o
   * solo de `positionIds`. Pasa por el mismo ejecutor que un cierre del
   * template: en sombra se llena contra el libro; en real aplica el camino
   * de TP residente (`requestProtectedExit`) igual que un stop.
   * Las posiciones se leen DENTRO del lock: una segunda llamada concurrente
   * ve lo que dejó la primera y no cierra dos veces.
   */
  async closeManually(strategy, { mode, positionIds } = {}) {
    if (mode !== 'shadow' && mode !== 'live') throw new Error(`Modo de cierre inválido: ${mode}`);
    const tickCtx = { now: this.now(), chains: new Map(), signal: null, produced: [] };
    return this.withLock(strategy.id, async () => {
      const wanted = Array.isArray(positionIds) ? new Set(positionIds.map(Number)) : null;
      const open = await this.repo.listOpenPositions(strategy.id, mode);
      const targets = wanted ? open.filter((p) => wanted.has(Number(p.id))) : open;
      if (!targets.length) return { status: 'nothing_to_close', produced: tickCtx.produced };
      const market = await this.strategyMarket(strategy, tickCtx);
      const ctx = await this.modeContext(strategy, mode, tickCtx, market, open);
      const ids = new Set(targets.map((p) => Number(p.id)));
      const positions = ctx.positions.filter((p) => ids.has(Number(p.id)));
      const action = { type: 'close', reason: 'manual', detail: 'Cierre manual', legs: closeLegs(positions) };
      if (mode === 'shadow') {
        const event = await this.executeShadow(strategy, action, ctx);
        return { status: event ? 'closed' : 'not_submitted', produced: tickCtx.produced };
      }
      const result = await this.executeLive(strategy, action, ctx);
      const pending = ['submitted', 'tp_cancel_requested', 'attention'].includes(result?.status);
      return { status: pending ? 'pending' : 'not_submitted', produced: tickCtx.produced };
    });
  }

  /**
   * Reentrada diferida de una alerta ya recibida. Solo evalúa y opera
   * el libro REAL, sin repetir shadow ni disparar la misma alerta.
   * Se vuelve a cotizar y a comprobar límites justo antes del POST.
   */
  async executeDeferredReentry(strategyId, signal) {
    const strategy = await this.repo.getStrategyById(strategyId);
    if (!strategy || strategy.mode !== 'live' || strategy.template !== 'alert_signal' ||
        !this.liveExecutor.enabled) return { status: 'disabled' };
    return this.withLock(strategyId, async () => {
      const tickCtx = { now: this.now(), signal, chains: new Map(), produced: [] };
      const template = templates.getTemplate(strategy.template);
      const params = templates.validateParams(strategy.template, strategy.params);
      if (params.onOpposite !== 'reverse') return { status: 'mode_changed' };
      let underlying;
      try {
        underlying = this.signalUnderlying(strategy, template, signal);
      } catch {
        return { status: 'underlying_removed' };
      }
      // Solo bloquean las posiciones del subyacente que gira; las de otros
      // subyacentes del bot cuentan para el máximo y el presupuesto.
      const all = await this.repo.listOpenPositions(strategy.id, 'live');
      if (all.some((p) => positionUnderlying(p, strategy.underlying) === underlying)) {
        return { status: 'positions_still_open' };
      }
      const { base, chain } = await this.targetChain(strategy, params, tickCtx, underlying);
      const spot = num(chain?.spot) ?? num(base?.spot);
      const actions = template.evaluate({
        now: tickCtx.now, signal, spot, chain, positions: [], openCountAll: all.length,
        params, mode: 'live',
        lastOpenedAt: await this.repo.lastOpenedAt(strategy.id, 'live'),
        tradesToday: await this.repo.countEventsSince(strategy.id, 'live', 'open',
          utcDayStart(tickCtx.now)),
        committedUsdt: await this.committedFor(strategy, 'live', params, all, { spot, underlying, tickCtx }),
      });
      const open = actions.find((a) => a.type === 'open');
      if (!open) return { status: 'no_valid_entry' };
      return await this.executeLive(strategy, open, {
        ...tickCtx, spot, underlying, params, positions: [], mode: 'live',
      }) || { status: 'not_submitted' };
    });
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

  async targetChain(strategy, params, tickCtx, underlying = strategy.underlying) {
    const base = await this.chainFor(underlying, null, tickCtx);
    // El rango pertenece a la alerta disparada: no se amplía para forzar entradas.
    // Solo se aplica a bots por señales; sin rango la selección sigue igual.
    const minDays = tickCtx.signal?.optionExpiryMinDays;
    const maxDays = tickCtx.signal?.optionExpiryMaxDays;
    const expiries = minDays != null && maxDays != null && strategy.template === 'alert_signal'
      ? (base?.expiries || []).filter((expiry) => Number(expiry.dte) >= minDays && Number(expiry.dte) <= maxDays)
      : base?.expiries;
    const pick = templates.pickExpiry(expiries, params.expiryDays);
    if (!pick) return { base, chain: null };
    const chain = pick.code === base.expiry ? base : await this.chainFor(underlying, pick.code, tickCtx);
    return { base, chain };
  }

  async quoteFor(symbol, { fresh = false } = {}) {
    try {
      return await this.market.getQuote(symbol, { fresh });
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

  // La proyección usa la prima REAL de entrada persistida en la posición.
  // Si Binance no ofrece velas, IV o tick, nunca inventar un nivel de TP.
  async attachVolatilityTargets(positions, params, spot, now) {
    if (params.takeProfitMode !== 'volatility' || !positions.length) return positions;
    return Promise.all(positions.map(async (p) => {
      if (!p.quote || !Number.isFinite(Number(p.quote.iv)) ||
          typeof this.market.getVolatilityInputs !== 'function') {
        return { ...p, takeProfitTarget: null };
      }
      try {
        const inputs = await this.market.getVolatilityInputs(p.symbol);
        const target = projectTakeProfit({
          entryPrice: Number(p.entryPrice), spot, strike: p.strike,
          iv: Number(p.quote.iv), type: p.type, side: p.side,
          expiryMs: p.expiryMs, nowMs: now,
          atrHourly: inputs.atrHourly, tickSize: inputs.tickSize,
          minPrice: inputs.minPrice,
          atrMultiplier: params.tpAtrMultiplier,
          horizonHours: params.tpHorizonHours,
        });
        return { ...p, takeProfitTarget: target };
      } catch (err) {
        this.logger.warn('options_volatility_tp_unavailable', { symbol: p.symbol, error: err.message });
        return { ...p, takeProfitTarget: null };
      }
    }));
  }

  /**
   * Banda ATR: fija el objetivo de venta UNA vez (al llenarse) y lo persiste.
   * Si faltan velas, tick o spot queda pendiente y se reintenta en el
   * siguiente ciclo; un fallo nunca impide registrar la posición.
   */
  async ensureAtrBandTarget(position, params, spot, now) {
    try {
      return await ensureAtrBandTarget(position, params, { market: this.market, repo: this.repo, spot, now });
    } catch (err) {
      this.logger.warn('options_atr_band_tp_unavailable', { positionId: position.id, symbol: position.symbol, error: err.message });
      return position;
    }
  }

  // ---------- evaluación ----------

  /**
   * Subyacente con el que se evalúa: el de la señal en un bot por alertas
   * (multi-subyacente); si no, el de la estrategia.
   */
  signalUnderlying(strategy, template, signal) {
    const fromSignal = template.signalDriven && signal?.underlying ? String(signal.underlying).toUpperCase() : null;
    if (fromSignal && !botUnderlyings(strategy).includes(fromSignal)) {
      throw new Error(`El bot no opera ${fromSignal}`);
    }
    return fromSignal || String(strategy.underlying).toUpperCase();
  }

  /** Template, parámetros, subyacente, cadena y spot de una estrategia para esta pasada. */
  async strategyMarket(strategy, tickCtx) {
    const template = templates.getTemplate(strategy.template);
    const params = templates.validateParams(strategy.template, strategy.params);
    const underlying = this.signalUnderlying(strategy, template, tickCtx.signal);
    const { base, chain } = await this.targetChain(strategy, params, tickCtx, underlying);
    const spot = num(chain?.spot) ?? num(base?.spot);
    return { template, params, chain, spot, underlying };
  }

  /**
   * Agrupa posiciones abiertas por subyacente (de su símbolo) con la cadena y
   * el spot de cada uno: `[{ underlying, chain, spot, positions }]`. El del
   * mercado de la pasada reutiliza su cadena. Solo los bots por alertas pueden
   * tener varios; el resto de estrategias forman un único grupo, como siempre.
   */
  async positionGroups(strategy, market, rows, tickCtx) {
    const { template, params, chain, spot, underlying } = market;
    if (template.id !== 'alert_signal') return [{ underlying, chain, spot, positions: rows }];
    const byUnderlying = new Map();
    for (const row of rows) {
      const key = positionUnderlying(row, underlying);
      if (!byUnderlying.has(key)) byUnderlying.set(key, []);
      byUnderlying.get(key).push(row);
    }
    const groups = [];
    for (const [key, positions] of byUnderlying) {
      if (key === underlying) {
        groups.push({ underlying: key, chain, spot, positions });
        continue;
      }
      // Sin el rango de vencimientos de la señal: es otro subyacente.
      const other = await this.targetChain(strategy, params, { chains: tickCtx.chains }, key);
      groups.push({ underlying: key, chain: other.chain, spot: num(other.chain?.spot) ?? num(other.base?.spot), positions });
    }
    return groups;
  }

  /**
   * Capital comprometido de un modo para el presupuesto total del bot:
   * posiciones abiertas y, solo en Real, órdenes de entrada no finales.
   * Cada pata se valora con el spot de su subyacente (`spot` es el de
   * `underlying`; los demás se piden a la caché de la pasada).
   * undefined si el bot no tiene presupuesto (no hace falta consultarlo).
   */
  async committedFor(strategy, mode, params, positions, { spot, underlying = strategy.underlying, tickCtx } = {}) {
    if (params?.budgetUsdt == null) return undefined;
    const orders = mode === 'live' ? await this.liveOrders.listByStrategy(strategy.id) : [];
    const spots = { [String(underlying).toUpperCase()]: spot };
    for (const item of [...positions, ...orders]) {
      const key = parseSymbol(item.symbol)?.underlying;
      if (!key || key in spots) continue;
      try {
        spots[key] = await this.spotFor(key, tickCtx || { chains: new Map() });
      } catch (err) {
        this.logger.warn('options_committed_spot_failed', { underlying: key, error: err.message });
        spots[key] = null;
      }
    }
    return committedUsdt({ positions, orders, spot, spots });
  }

  /**
   * Contexto de ejecución de un modo: posiciones abiertas enriquecidas con
   * cotización (y objetivos de volatilidad en bots por alertas), spot y
   * parámetros. Lo comparten la evaluación del template y el cierre manual.
   */
  async modeContext(strategy, mode, tickCtx, market, open = null) {
    const { template, params, spot, underlying } = market;
    const rows = open || await this.repo.listOpenPositions(strategy.id, mode);
    const enrichedByRow = new Map();
    // Cada subyacente con su cadena y su spot (objetivos ATR/volatilidad incluidos).
    for (const group of await this.positionGroups(strategy, market, rows, tickCtx)) {
      const enriched = await this.enrichPositions(group.positions, group.chain);
      let positions = template.id === 'alert_signal'
        ? await this.attachVolatilityTargets(enriched, params, group.spot, tickCtx.now)
        : enriched;
      // Sombra: reintento del objetivo ATR que no pudo fijarse al abrir. En
      // real lo fija el ejecutor al armar el TP residente en Binance.
      if (template.id === 'alert_signal' && mode === 'shadow' && params.takeProfitMode === 'atr_band') {
        positions = await Promise.all(positions.map((p) => this.ensureAtrBandTarget(p, params, group.spot, tickCtx.now)));
      }
      group.positions.forEach((row, i) => enrichedByRow.set(row, positions[i]));
    }
    const allPositions = rows.map((row) => enrichedByRow.get(row));
    // Con señal, un bot solo ve (señal contraria) las posiciones de su subyacente.
    const positions = tickCtx.signal && template.id === 'alert_signal'
      ? allPositions.filter((p) => positionUnderlying(p, underlying) === underlying)
      : allPositions;
    return { ...tickCtx, spot, underlying, positions, allPositions, params, mode };
  }

  async runStrategy(strategy, tickCtx, { shadowOnly = false } = {}) {
    const market = await this.strategyMarket(strategy, tickCtx);
    const { template, params, chain, spot } = market;
    const modes = strategy.mode === 'live' && !shadowOnly ? ['shadow', 'live'] : ['shadow'];
    const byMode = {};

    for (const mode of modes) {
      const ctx = await this.modeContext(strategy, mode, tickCtx, market);
      const { positions, allPositions } = ctx;
      const botSignal = tickCtx.signal && template.id === 'alert_signal';
      const lastOpenedAt = await this.repo.lastOpenedAt(strategy.id, mode);
      // Solo los bots por alertas limitan operaciones por día.
      const tradesToday = template.signalDriven
        ? await this.repo.countEventsSince(strategy.id, mode, 'open', utcDayStart(tickCtx.now))
        : undefined;
      const actions = template.evaluate({
        now: tickCtx.now,
        underlying: market.underlying,
        spot,
        chain,
        positions,
        // Límites compartidos por todos los subyacentes del bot.
        ...(botSignal ? { openCountAll: allPositions.length } : {}),
        params,
        lastOpenedAt,
        mode,
        signal: tickCtx.signal || null,
        tradesToday,
        committedUsdt: tickCtx.signal
          ? await this.committedFor(strategy, mode, params, allPositions, { spot, underlying: market.underlying, tickCtx })
          : undefined,
      });
      byMode[mode] = actions;
      // Una alerta opuesta con onOpposite=reverse registra CIERRE + REENTRADA
      // en una sola transacción. El reconciliador abrirá la nueva dirección
      // únicamente al confirmar todos los cierres, nunca en el mismo tick.
      if (mode === 'live' && template.id === 'alert_signal' &&
          tickCtx.signal && params.onOpposite === 'reverse' &&
          actions.some((a) => a.type === 'close') &&
          actions.some((a) => a.type === 'open') &&
          typeof this.liveExecutor.queueReversal === 'function') {
        const closeAction = actions.find((a) => a.type === 'close');
        if (await this.liveExecutor.queueReversal(strategy, tickCtx.signal, closeAction)) {
          ctx.produced?.push({ mode: 'live', type: 'close', pending: true,
            reason: 'reverse_queued',
            detail: 'Giro en espera: cancelar TP, cerrar y conciliar antes de abrir' });
          continue;
        }
      }
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
          if (mode === 'live') await this.maybeNotify(strategy, `Error en modo real: ${err.message}`, 'error');
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

  async quoteLegs(legs, { fresh = false } = {}) {
    const quotes = [];
    for (const leg of legs) {
      const quote = await this.quoteFor(leg.symbol, { fresh });
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
      return { ...leg, price, spot, fee: tradeFee({ spot, quantity: leg.quantity, price }) };
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
        const position = await this.repo.insertPosition({
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
        // Banda ATR: el objetivo se fija con el spot del fill.
        if (strategy.template === 'alert_signal' && ctx.params?.takeProfitMode === 'atr_band' && position) {
          await this.ensureAtrBandTarget(position, ctx.params, leg.spot ?? ctx.spot, ctx.now);
        }
      } else {
        const position = openById.get(leg.positionId);
        if (!position) continue;
        const fees = position.feesUsdt + leg.fee;
        const pnl = grossPnl({ side: position.side, entryPrice: position.entryPrice, exitPrice: leg.price, quantity: position.quantity }) - fees;
        await this.repo.closePosition(position.id, { exitPrice: leg.price, closedAt: ctx.now, pnlUsdt: pnl, feesUsdt: fees, closeReason: action.reason || null });
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
      // El conteo real sale del ledger de órdenes ENVIADAS, no de eventos
      // de fills: una orden aceptada sin ejecución también consume cupo.
      if (typeof this.liveExecutor.repo?.countSubmittedSince !== 'function') {
        return { ok: false, reason: 'Sin ledger de órdenes reales para comprobar el límite diario' };
      }
      const orders = await this.liveExecutor.repo.countSubmittedSince(strategy.id, dayStart);
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
      const spot = meta.underlying === String(ctx.underlying || strategy.underlying).toUpperCase() ? ctx.spot : await this.spotFor(meta.underlying, ctx);
      // Lo comprado ya está pagado: solo las ventas consumen margen.
      const margin = p.side === 'SELL' ? estimateMargin({ ...p, type: meta.type, strike: meta.strike, price: p.entryPrice, spot }) : 0;
      userMargin += margin;
      if (p.strategyId === strategy.id) strategyMargin += margin;
    }
    if (!Number.isFinite(userMargin + newMargin)) {
      return { ok: false, reason: 'Spot no disponible para estimar el margen de las ventas' };
    }
    if (has(limits.maxMarginUsdt) && strategyMargin + newMargin > Number(limits.maxMarginUsdt)) {
      return { ok: false, reason: `Margen estimado ${(strategyMargin + newMargin).toFixed(2)} USDT supera el límite de la estrategia (${limits.maxMarginUsdt} USDT)` };
    }
    if (has(globalLimits.maxMarginUsdt) && userMargin + newMargin > Number(globalLimits.maxMarginUsdt)) {
      return { ok: false, reason: `Margen estimado ${(userMargin + newMargin).toFixed(2)} USDT supera el límite global (${globalLimits.maxMarginUsdt} USDT)` };
    }

    if (has(limits.maxNetDelta)) {
      // Una delta ausente no equivale a cero: si no podemos medir el
      // riesgo direccional, no se permiten nuevas órdenes reales.
      const missingDelta = (ctx.positions || []).some((p) =>
        p.quote?.delta == null || !Number.isFinite(Number(p.quote.delta))) ||
        legs.some((leg) => leg.delta == null || !Number.isFinite(Number(leg.delta)));
      if (missingDelta) {
        return { ok: false, reason: 'Delta no disponible para verificar la exposición neta' };
      }
      const current = (ctx.positions || []).reduce((acc, p) => acc + legDeltaExposure({ side: p.side, delta: p.quote.delta, quantity: p.quantity }), 0);
      const net = legs.reduce((acc, leg) => acc + legDeltaExposure(leg), current);
      if (Math.abs(net) > Number(limits.maxNetDelta)) {
        return { ok: false, reason: `|Δ| neta ${Math.abs(net).toFixed(3)} supera el máximo de ${limits.maxNetDelta}` };
      }
    }
    return { ok: true, globalLimits };
  }

  async executeLive(strategy, action, ctx) {
    if (!this.liveExecutor.enabled) {
      await this.recordOutcome(strategy, 'live', {
        type: 'skip', reason: 'live_disabled',
        detail: 'Envio real deshabilitado: OPTIONS_LIVE_TRADING_ENABLED no está activo',
      }, ctx);
      return null;
    }
    // Un TP LIMIT residente ya está encargado al exchange. No cancelarlo
    // ni competir con él cuando el tick vuelve a detectar la misma ganancia.
    if (action.type === 'close' && TAKE_PROFIT_REASONS.includes(action.reason) &&
        typeof this.liveExecutor.repo?.hasStandingTp === 'function' &&
        await this.liveExecutor.repo.hasStandingTp(action.legs.map((l) => l.positionId))) {
      ctx.produced?.push({ mode: 'live', type: 'hold', pending: true,
        reason: 'tp_resting', detail: 'TP LIMIT residente, ejecución pendiente en Binance' });
      return null;
    }
    // Stops, señales contrarias y salidas por tiempo no dependen de que
    // haya liquidez para SOLICITAR la cancelación durable de un TP resting.
    if (action.type === 'close' &&
        !TAKE_PROFIT_REASONS.includes(action.reason) &&
        typeof this.liveExecutor.requestProtectedExit === 'function' &&
        await this.liveExecutor.requestProtectedExit(strategy, action)) {
      ctx.produced?.push({ mode: 'live', type: 'close', pending: true,
        reason: 'tp_cancel_requested',
        detail: 'TP en cancelación; salida pendiente y persistida' });
      return { status: 'tp_cancel_requested', sent: 0 };
    }
    const { quotes, missing } = await this.quoteLegs(action.legs, { fresh: true });
    if (missing) {
      await this.recordOutcome(strategy, 'live', {
        type: 'skip', reason: 'no_liquidity', detail: `Sin precio para ${missing}`,
      }, ctx);
      return null;
    }
    // ONLY the explicit one-contract ETH pilot experiment may replace the
    // resting GTC TP with a synthetic full-size FOK close.
    // Both fresh quote AND complete depth must meet the fixed TP target.
    // An FOK expiry is NOT a protected position or guaranteed stop.
    const tpLeg = action.type === 'close' && action.legs?.length === 1
      ? action.legs[0] : null;
    const tpPosition = tpLeg && (ctx.positions || [])
      .find((p) => Number(p.id) === Number(tpLeg.positionId));
    const syntheticTp = !!tpPosition && isPilotSyntheticTpEligible({
      candidate: {
        ...tpPosition, params: ctx.params,
        strategyId: strategy.id, userId: strategy.userId,
        mode: strategy.mode,
      },
      enabled: this.liveExecutor.syntheticTpExperimentalEnabled,
    }) && ['take_profit', 'take_profit_volatility', 'stop_loss', 'time_exit'].includes(action.reason);
    if (syntheticTp) {
      try {
        const client = await this.liveExecutor.credentials.getClientForUser(strategy.userId);
        const depth = await client.getDepth(tpLeg.symbol, 20);
        const fullSizeLimit = fullSizeFokLimit({
          book: depth, side: tpLeg.side, quantity: tpLeg.quantity, nowMs: this.now(),
        });
        if (['take_profit', 'take_profit_volatility'].includes(action.reason)) {
          const target = fixedTargetPrice(tpPosition, ctx.params);
          if (fullSizeLimit + 1e-9 < target) {
            await this.recordOutcome(strategy, 'live', {
              type: 'skip', reason: 'tp_full_size_price_below_target',
              detail: 'El libro FOK completo ya no alcanza el objetivo TP',
            }, ctx);
            return null;
          }
        }
        quotes[0].price = fullSizeLimit;
      } catch (err) {
        await this.recordOutcome(strategy, 'live', {
          type: 'skip', reason: 'tp_full_size_depth_unavailable',
          detail: 'FOK no enviado: faltan liquidez completa o datos frescos',
        }, ctx);
        this.logger.warn('options_synthetic_tp_fok_blocked', {
          strategyId: strategy.id, positionId: tpPosition.id,
          error: err.message,
        });
        return null;
      }
    }
    // Un TP basado en volatilidad no puede ejecutar a peor precio por
    // movimientos entre el tick y el preflight de cotización fresca.
    if (TARGET_TP_REASONS.includes(action.reason)) {
      const stale = action.legs.some((leg, i) => {
        const price = quotes[i].price;
        const target = Number(leg.targetPrice);
        return !Number.isFinite(target) || target <= 0 ||
          (leg.side === 'SELL' ? price < target : price > target);
      });
      if (stale) {
        await this.recordOutcome(strategy, 'live', {
          type: 'skip', reason: 'tp_price_moved',
          detail: 'TP por objetivo: el precio ejecutable cambió; no se envió la orden',
        }, ctx);
        return null;
      }
    }
    // El precio LIMIT es la cotización recién consultada, pero el fill
    // SOLO se registra cuando Binance lo confirma en getUserTrades.
    const quoted = action.legs.map((leg, i) => ({
      ...leg, price: quotes[i].price,
      delta: quotes[i].quote?.delta == null ? null : Number(quotes[i].quote.delta),
    }));
    if (action.type === 'open') {
      // La prima/margen de la cadena inicial pudo cambiar. Revalidar
      // capital y riesgos utilizando los precios LIMIT realmente enviados.
      const capital = quoted.reduce((sum, leg) => sum + estimateMargin({
        ...leg,
        type: leg.optionType || parseSymbol(leg.symbol)?.type,
        spot: ctx.spot,
      }), 0);
      // Con presupuesto total, el tope es la parte de la señal (capitalUsdt se ignora).
      const cap = ctx.params.budgetUsdt != null
        ? (action.signalBudgetUsdt ?? ctx.params.budgetUsdt / (ctx.params.budgetFractions || 4))
        : ctx.params.capitalUsdt;
      if (!Number.isFinite(capital) || capital <= 0 ||
          (cap != null && capital > Number(cap) + 1e-8)) {
        await this.recordOutcome(strategy, 'live', {
          type: 'skip', reason: 'capital_limit',
          detail: 'Entrada real bloqueada: capital requerido excede el presupuesto o no pudo verificarse',
        }, ctx);
        return null;
      }
      const buyPremium = quoted.reduce((sum, leg) =>
        sum + (leg.side === 'BUY' ? leg.quantity * leg.price : 0), 0);
      if (ctx.params.maxPremiumUsdt != null &&
          buyPremium > Number(ctx.params.maxPremiumUsdt) + 1e-8) {
        await this.recordOutcome(strategy, 'live', {
          type: 'skip', reason: 'premium_limit',
          detail: 'Entrada real bloqueada: prima actual supera el máximo configurado',
        }, ctx);
        return null;
      }
      const limits = await this.checkLiveLimits(strategy, quoted, ctx);
      if (!limits.ok) {
        await this.recordOutcome(strategy, 'live', {
          type: 'skip', reason: 'live_risk_limit', detail: `Bloqueada por límite: ${limits.reason}`,
        }, ctx);
        await this.maybeNotify(strategy, `Orden real bloqueada: ${limits.reason}`, 'error');
        return null;
      }
    }
    const result = await this.liveExecutor.submit(strategy, { ...action, legs: quoted }, ctx);
    if (result.status === 'submitted' || result.status === 'attention') {
      await this.maybeNotify(strategy, `Órdenes LIMIT enviadas: ${result.sent}. A la espera de fills confirmados (10 min)`, 'trade');
    }
    ctx.produced?.push({ mode: 'live', type: action.type,
      pending: ['submitted', 'tp_cancel_requested'].includes(result.status), reason: result.status,
      detail: result.status === 'submitted' ? 'Orden límite enviada; ejecución pendiente' : result.status });
    return result;
  }

  /** `kind`: 'trade' | 'error'. Respeta `params.notify` del bot (activo si falta). */
  async maybeNotify(strategy, message, kind = 'trade') {
    try {
      const flag = kind === 'error' ? 'errors' : 'trades';
      if (strategy.params?.notify?.[flag] === false) return;
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
      // Un bot puede tener posiciones de varios subyacentes: cada uno con su índice.
      const key = `${p.strategyId}:${p.mode}:${p.meta.underlying}`;
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
        await this.repo.closePosition(p.id, { exitPrice: value, closedAt: tickCtx.now, pnlUsdt: pnl, feesUsdt: fees, closeReason: 'expiry' });
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
