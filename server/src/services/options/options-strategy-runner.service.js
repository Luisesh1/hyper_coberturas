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
const { midLimitPrice } = require('./options-mid-price');
const { submitOutcomeText, isPendingSubmitStatus } = require('./options-live-submit-outcome');
const { estimateMargin, committedUsdt, orderReservedUsdt, shadowEntriesAsOrders } = require('./options-committed-capital');
const { botUnderlyings } = require('./bot-underlyings');
const { positionDirection } = require('./templates/alert-signal');
// Misma ventana y mismos textos de desenlace que una entrada real.
const { WINDOW_MS, entrySignalResolution } = require('./options-live-execution.service');

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

function lazyShadowEntries() {
  // eslint-disable-next-line global-require
  const load = () => require('../../repositories/options-shadow-entries.repository');
  return {
    insertEntry: (...args) => load().insertEntry(...args),
    listPending: (...args) => load().listPending(...args),
    resolveEntry: (...args) => load().resolveEntry(...args),
    cancelEntries: (...args) => load().cancelEntries(...args),
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

/** Subyacente de una posición según su símbolo (o `fallback`). */
function positionUnderlying(position, fallback) {
  return parseSymbol(position.symbol)?.underlying || String(fallback || '').toUpperCase();
}

/**
 * Sentido de una entrada por su lado y el tipo de su símbolo (inversa de
 * `legFor`): compra de call o venta de put = alcista. null si no se sabe.
 */
function entryDirection(side, symbol, optionType) {
  const type = parseSymbol(symbol)?.type || optionType;
  if (!['BUY', 'SELL'].includes(side) || !['C', 'P'].includes(type)) return null;
  return positionDirection({ side, type });
}

/**
 * Real: órdenes de entrada no finales y con cantidad por ejecutar en
 * `underlying`. Una con la cancelación ya pedida tiene sentido desconocido
 * (null): la señal que pidió cancelarla espera en cola, y una señal
 * posterior debe encolar su propia reevaluación en vez de darla por ocupada.
 */
function livePendingEntries(orders, underlying) {
  return orders.filter((o) => o.action === 'open' && o.status !== 'final'
    && Number(o.quantity) - Number(o.processedQty || 0) > 0
    && positionUnderlying(o) === underlying)
    .map((o) => ({ id: Number(o.id),
      direction: o.cancelRequested ? null : entryDirection(o.side, o.symbol, o.optionType) }));
}

/**
 * Entradas pendientes de TODO el bot (cualquier subyacente): ocupan el
 * máximo de posiciones compartido igual que una posición abierta.
 */
function livePendingCount(orders) {
  return (orders || []).filter((o) => o.action === 'open' && o.status !== 'final'
    && Number(o.quantity) - Number(o.processedQty || 0) > 0).length;
}

function shadowPendingCount(entries) {
  return (entries || []).filter((e) => e.status === 'pending').length;
}

/** Sombra: entradas simuladas aún 'pending' en `underlying`. */
function shadowPendingEntries(entries, underlying) {
  return entries.filter((e) => e.status === 'pending' && positionUnderlying(e) === underlying)
    .map((e) => ({ id: Number(e.id), direction: entryDirection(e.side, e.symbol, e.optionType) }));
}

/** Desenlace de una entrada simulada para su señal: el de la real, en «Sombra». */
function shadowSignalResolution(outcome) {
  const resolution = entrySignalResolution(outcome);
  return { ...resolution, detail: resolution.detail.replace(/^Real: /, 'Sombra: '),
    feesEstimated: resolution.decision === 'opened' };
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
    // Entradas simuladas pendientes (modo sombra), con la misma regla.
    this.shadowEntries = deps.shadowEntries || (this.repo === defaultRepo
      ? lazyShadowEntries()
      : {
        insertEntry: async () => { throw new Error('Sin almacén de entradas simuladas'); },
        listPending: async () => [], resolveEntry: async () => null, cancelEntries: async () => [],
      });
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
      try {
        await this.processShadowEntries();
      } catch (err) {
        this.logger.error('options_shadow_entries_failed', { error: err.message });
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
      try {
        await this.processShadowEntries();
      } catch (err) {
        this.logger.error('options_shadow_entries_failed', { error: err.message });
      }
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
    // shadowOnly ("Probar señal"): la sombra decide la señal aunque el bot sea real.
    const tickCtx = { now: this.now(), chains: new Map(), signal, produced: [], shadowOnly };
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
      const orders = await this.liveOrders.listByStrategy(strategy.id);
      const actions = template.evaluate({
        now: tickCtx.now, underlying, signal, spot, chain, positions: [],
        openCountAll: all.length + livePendingCount(orders),
        pendingEntries: livePendingEntries(orders, underlying),
        blockedUnderlyings: strategy.state?.blockedUnderlyings || {},
        params, mode: 'live',
        lastOpenedAt: await this.repo.lastOpenedAt(strategy.id, 'live'),
        tradesToday: await this.repo.countEventsSince(strategy.id, 'live', 'open',
          utcDayStart(tickCtx.now)),
        committedUsdt: await this.committedFor(strategy, 'live', params, all, { spot, underlying, tickCtx, orders }),
      });
      const open = actions.find((a) => a.type === 'open');
      if (!open) return { status: 'no_valid_entry' };
      return await this.executeLive(strategy, open, {
        ...tickCtx, spot, underlying, params, positions: [], mode: 'live',
      }) || { status: 'not_submitted' };
    });
  }

  /**
   * Señal contraria que canceló entradas reales pendientes: cuando todas sus
   * órdenes son finales, se vuelve a evaluar SOLO en Real (la sombra ya la
   * evaluó al llegar). Lo llenado ya son posiciones y sigue `onOpposite`
   * (cierre, giro durable con queueReversal o ignorar).
   * Estados: 'evaluated' | 'reversal_queued' | 'waiting' (nuevas entradas
   * pendientes que cancelar) | 'underlying_removed' | 'disabled'.
   */
  async reevaluateSignal(strategyId, signal) {
    const strategy = await this.repo.getStrategyById(strategyId);
    if (!strategy || strategy.mode !== 'live' || strategy.template !== 'alert_signal' ||
        !this.liveExecutor.enabled) return { status: 'disabled' };
    try {
      this.signalUnderlying(strategy, templates.getTemplate(strategy.template), signal);
    } catch {
      await this.resolveSignal(signal, 'ignored',
        `Real: entrada cancelada; el bot ya no opera ${String(signal?.underlying || '').toUpperCase()}`);
      return { status: 'underlying_removed' };
    }
    const tickCtx = { now: this.now(), chains: new Map(), signal, produced: [] };
    const byMode = await this.withLock(strategyId,
      () => this.runStrategy(strategy, tickCtx, { liveOnly: true }));
    const live = byMode.live || [];
    const produced = tickCtx.produced.filter((p) => p.mode === 'live');
    if (live.some((a) => a.type === 'cancel_entries')) return { status: 'waiting', produced };
    // El giro durable conserva la señal: la resuelve la entrada de la reentrada.
    if (produced.some((p) => p.reason === 'reverse_queued')) return { status: 'reversal_queued', produced };
    // Una entrada enviada enlaza la señal a su lote: se resuelve con sus fills.
    const opened = produced.some((p) => p.type === 'open' && ['submitted', 'attention'].includes(p.reason));
    if (!opened) {
      const error = produced.find((p) => p.type === 'error');
      const skipped = produced.find((p) => p.type === 'skip');
      if (produced.some((p) => p.type === 'close')) {
        await this.resolveSignal(signal, 'closed', 'Real: entrada cancelada; posición contraria cerrada');
      } else if (error) {
        await this.resolveSignal(signal, 'error', `Real: entrada cancelada; ${error.detail}`);
      } else if (skipped?.reason === 'opposite_ignored') {
        await this.resolveSignal(signal, 'ignored', 'Real: entrada cancelada; señal ignorada por la regla');
      } else {
        await this.resolveSignal(signal, 'ignored',
          `Real: entrada cancelada; ${skipped?.detail || 'sin entrada válida'}`);
      }
    }
    return { status: 'evaluated', produced };
  }

  /** Resuelve la fila de una señal (si la trae) sin romper el flujo si falla. */
  async resolveSignal(signal, decision, detail) {
    const signalId = Number(signal?.signalId);
    if (!Number.isSafeInteger(signalId) || signalId <= 0 ||
        typeof this.repo.resolveAutoSignal !== 'function') return null;
    try {
      return await this.repo.resolveAutoSignal(signalId, { decision, detail });
    } catch (err) {
      this.logger.warn('options_signal_resolve_failed', { signalId, error: err.message });
      return null;
    }
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
    // El rango pertenece al bot por señales: no se amplía para forzar entradas.
    // Sin rango la selección sigue igual (el más cercano a expiryDays).
    const minDays = params.expiryMinDays;
    const maxDays = params.expiryMaxDays;
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
  async committedFor(strategy, mode, params, positions, { spot, underlying = strategy.underlying, tickCtx, orders: loaded } = {}) {
    if (params?.budgetUsdt == null) return undefined;
    // Real: órdenes de entrada del ledger. Sombra: las entradas simuladas
    // pendientes que pase el llamador (con forma de orden).
    const orders = loaded || (mode === 'live' ? await this.liveOrders.listByStrategy(strategy.id) : []);
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

  async runStrategy(strategy, tickCtx, { shadowOnly = false, liveOnly = false } = {}) {
    const market = await this.strategyMarket(strategy, tickCtx);
    const { template, params, chain, spot } = market;
    let modes = strategy.mode === 'live' && !shadowOnly ? ['shadow', 'live'] : ['shadow'];
    if (liveOnly) modes = modes.filter((m) => m === 'live');
    const byMode = {};
    const botSignal = tickCtx.signal && template.id === 'alert_signal';
    // Bloqueos de subyacente: los escribe el ejecutor real al conciliar, así
    // que se leen frescos del repo (la estrategia de la pasada puede ser vieja).
    let blockedUnderlyings;
    if (botSignal && modes.includes('live')) {
      const fresh = typeof this.repo.getStrategyById === 'function'
        ? await this.repo.getStrategyById(strategy.id) : null;
      blockedUnderlyings = (fresh || strategy).state?.blockedUnderlyings || {};
    }

    for (const mode of modes) {
      const ctx = await this.modeContext(strategy, mode, tickCtx, market);
      const { positions, allPositions } = ctx;
      const lastOpenedAt = await this.repo.lastOpenedAt(strategy.id, mode);
      // Solo los bots por alertas limitan operaciones por día.
      const tradesToday = template.signalDriven
        ? await this.repo.countEventsSince(strategy.id, mode, 'open', utcDayStart(tickCtx.now))
        : undefined;
      // Las entradas aún sin ejecutar también ocupan el subyacente: órdenes
      // reales no finales o entradas simuladas pendientes, según el modo.
      const orders = botSignal && mode === 'live' ? await this.liveOrders.listByStrategy(strategy.id) : null;
      const shadowPending = botSignal && mode === 'shadow'
        ? await this.shadowEntries.listPending({ strategyId: strategy.id }) : null;
      let pendingEntries;
      let pendingCountAll = 0;
      if (botSignal) {
        pendingEntries = mode === 'live'
          ? livePendingEntries(orders, market.underlying)
          : shadowPendingEntries(shadowPending, market.underlying);
        pendingCountAll = mode === 'live' ? livePendingCount(orders) : shadowPendingCount(shadowPending);
      }
      const reserved = mode === 'live' ? orders : (shadowPending ? shadowEntriesAsOrders(shadowPending) : null);
      const actions = template.evaluate({
        now: tickCtx.now,
        underlying: market.underlying,
        spot,
        chain,
        positions,
        // Límites compartidos por todos los subyacentes del bot.
        // Las entradas pendientes de cualquier subyacente cuentan como posiciones.
        ...(botSignal ? { openCountAll: allPositions.length + pendingCountAll } : {}),
        ...(botSignal ? { pendingEntries } : {}),
        // Un resto real no operable bloquea solo el libro real: la sombra sigue.
        ...(botSignal && mode === 'live' ? { blockedUnderlyings } : {}),
        params,
        lastOpenedAt,
        mode,
        signal: tickCtx.signal || null,
        tradesToday,
        committedUsdt: tickCtx.signal
          ? await this.committedFor(strategy, mode, params, allPositions, { spot, underlying: market.underlying, tickCtx, orders: reserved })
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
          } else if (action.type === 'cancel_entries') {
            if (mode === 'live') await this.cancelLiveEntries(strategy, action, ctx);
            else await this.cancelShadowEntries(strategy, action, ctx);
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
   * Señal contraria con entradas reales pendientes: pide cancelar TODAS las
   * del subyacente (cancelar solo reduce exposición, también con el envío
   * apagado) y, con el envío activo, deja la señal en cola durable hasta
   * que esas órdenes sean finales. Nunca abre nada aquí.
   */
  async cancelLiveEntries(strategy, action, ctx) {
    const ledger = this.liveExecutor.repo;
    if (typeof ledger?.requestCancelEntries !== 'function') {
      throw new Error('Sin ledger de órdenes reales para cancelar las entradas pendientes');
    }
    const orderIds = await ledger.requestCancelEntries({
      userId: strategy.userId, strategyId: strategy.id, underlying: ctx.underlying,
    });
    let queued = false;
    if (action.reevaluate && this.liveExecutor.enabled) {
      if (typeof ledger.queueSignalReevaluation !== 'function') {
        throw new Error('Sin cola durable para reevaluar la señal');
      }
      queued = await ledger.queueSignalReevaluation(strategy, ctx.signal, orderIds);
    }
    ctx.produced?.push({ mode: 'live', type: 'cancel_entries', pending: true,
      reason: queued ? 'reevaluation_queued' : 'entries_cancel_requested',
      detail: queued
        ? 'Cancelando la entrada pendiente; se reevalúa al conciliar'
        : 'Cancelando la entrada pendiente; la señal no se reevaluará' });
    this.logger.info('options_entries_cancel_requested', {
      strategyId: strategy.id, underlying: ctx.underlying, orderIds, queued,
    });
  }

  /** Sombra: las entradas simuladas se cancelan al momento (y su señal queda ignorada). */
  async cancelShadowEntries(strategy, action, ctx) {
    const canceled = await this.shadowEntries.cancelEntries(action.ids, ctx.now);
    for (const entry of canceled || []) {
      await this.resolveShadowEntrySignal(entry, shadowSignalResolution({ filled: 0, cancelRequested: true }));
    }
    ctx.produced?.push({ mode: 'shadow', type: 'cancel_entries', reason: action.reason,
      detail: 'Entrada pendiente cancelada' });
    this.logger.info('options_shadow_entries_canceled', {
      strategyId: strategy.id, ids: action.ids, canceled: canceled?.length ?? 0,
    });
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
    // Igual que en real: un bot por alertas abre con una LIMIT al medio que espera.
    if (action.type === 'open' && strategy.template === 'alert_signal') {
      return this.openShadowEntry(strategy, action, ctx);
    }
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

  /**
   * Sombra de un bot por alertas: deja una entrada simulada pendiente al
   * medio del libro fresco con el plazo de la real. La llena (o caduca)
   * `processShadowEntries`. Solo enlaza la señal si la sombra la decide.
   */
  async openShadowEntry(strategy, action, ctx) {
    const { quotes, missing } = await this.quoteLegs(action.legs, { fresh: true });
    if (missing) {
      await this.recordOutcome(strategy, 'shadow', { type: 'skip', reason: 'no_liquidity', detail: `Sin precio en el libro para ${missing}` }, ctx);
      return null;
    }
    const legs = [];
    for (let i = 0; i < action.legs.length; i++) {
      const price = await this.midEntryPrice(action.legs[i], quotes[i]);
      legs.push({ ...action.legs[i], price, spot: num(quotes[i].quote?.spot) ?? ctx.spot });
    }
    const decidesSignal = strategy.mode !== 'live' || ctx.shadowOnly === true;
    const signalId = decidesSignal && Number.isSafeInteger(Number(ctx.signal?.signalId))
      ? Number(ctx.signal.signalId) : null;
    const entries = [];
    for (const leg of legs) {
      entries.push(await this.shadowEntries.insertEntry({
        strategyId: strategy.id, userId: strategy.userId, autoSignalId: signalId,
        alertEventId: ctx.signal?.eventId ?? null, symbol: leg.symbol, side: leg.side,
        optionType: leg.optionType || parseSymbol(leg.symbol)?.type, quantity: leg.quantity,
        limitPrice: leg.price, spot: leg.spot, deadlineAt: ctx.now + WINDOW_MS, createdAt: ctx.now,
      }));
    }
    if (signalId != null) await this.markEstimatedSignalFee(legs, quotes, ctx);
    ctx.produced?.push({ mode: 'shadow', type: 'open', pending: true, reason: 'shadow_entry_pending',
      detail: 'Orden LIMIT al medio, esperando ejecución' });
    this.logger.info('options_shadow_entry_pending', {
      strategyId: strategy.id, ids: entries.map((e) => e.id), signalId,
    });
    return null;
  }

  /**
   * Llena o caduca las entradas simuladas pendientes con la cotización
   * fresca: BUY si ask ≤ límite, SELL si bid ≥ límite, completa o nada.
   * Lo llaman el tick y el conciliador: cada entrada se procesa bajo el lock
   * de su estrategia y `resolveEntry` solo pasa desde 'pending', así que
   * dos pasadas a la vez no registran dos veces.
   */
  async processShadowEntries() {
    const result = { filled: 0, expired: 0 };
    const entries = await this.shadowEntries.listPending();
    for (const entry of entries) {
      try {
        const outcome = await this.withLock(entry.strategyId, () => this.processShadowEntry(entry));
        if (outcome === 'filled') result.filled += 1;
        else if (outcome === 'expired' || outcome === 'canceled') result.expired += 1;
      } catch (err) {
        this.logger.warn('options_shadow_entry_failed', { entryId: entry.id, error: err.message });
      }
    }
    return result;
  }

  async processShadowEntry(entry) {
    const now = this.now();
    const strategy = await this.repo.getStrategyById(entry.strategyId);
    if (!strategy || !['shadow', 'live'].includes(strategy.mode)) {
      const row = await this.shadowEntries.resolveEntry(entry.id, 'canceled', now);
      if (!row) return null;
      await this.resolveShadowEntrySignal(row, {
        decision: 'ignored', detail: 'Sombra: Entrada cancelada; el bot no está activo',
      });
      return 'canceled';
    }
    if (now >= Number(entry.deadlineAt)) {
      const row = await this.shadowEntries.resolveEntry(entry.id, 'expired', now);
      if (!row) return null;
      await this.resolveShadowEntrySignal(row, shadowSignalResolution({ filled: 0 }));
      await this.recordOutcome(strategy, 'shadow', {
        type: 'skip', reason: 'entry_expired', detail: 'Entrada sin ejecutar en 10 min',
      }, { now });
      return 'expired';
    }
    const quote = await this.quoteFor(entry.symbol, { fresh: true });
    const limit = Number(entry.limitPrice);
    const ask = num(quote?.ask);
    const bid = num(quote?.bid);
    const reached = entry.side === 'BUY' ? ask > 0 && ask <= limit : bid != null && bid >= limit;
    if (!reached) return null;
    let params = null;
    try {
      params = templates.validateParams(strategy.template, strategy.params);
    } catch {
      params = strategy.params || null;
    }
    // El spread máximo se valida al elegir el contrato; aquí se vuelve a exigir
    // para no dar por llenada una entrada contra un libro roto (ask en el
    // límite con el bid desplomado). Mientras no se cumpla, sigue pendiente.
    const maxSpreadPct = num(params?.maxSpreadPct);
    if (maxSpreadPct != null) {
      const spread = bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
      if (spread == null || spread > maxSpreadPct) return null;
    }
    const row = await this.shadowEntries.resolveEntry(entry.id, 'filled', now);
    if (!row) return null;
    const spot = num(quote?.spot) ?? num(entry.spot);
    const leg = {
      symbol: entry.symbol, side: entry.side, optionType: entry.optionType, quantity: entry.quantity,
      price: limit, spot, fee: tradeFee({ spot, quantity: entry.quantity, price: limit }),
    };
    await this.book(strategy, 'shadow',
      { type: 'open', reason: 'shadow_entry_filled', detail: 'Entrada LIMIT al medio ejecutada' },
      [leg], { now, spot, params, positions: [] });
    await this.resolveShadowEntrySignal(row, shadowSignalResolution({
      filled: entry.quantity, requested: entry.quantity, side: entry.side,
      symbol: entry.symbol, avgPrice: limit, feesUsdt: leg.fee,
    }));
    return 'filled';
  }

  /** Resuelve la señal enlazada a una entrada simulada; un fallo no rompe la pasada. */
  async resolveShadowEntrySignal(entry, resolution) {
    if (entry?.autoSignalId == null || typeof this.repo.resolveAutoSignal !== 'function') return null;
    try {
      return await this.repo.resolveAutoSignal(entry.autoSignalId, resolution);
    } catch (err) {
      this.logger.warn('options_signal_resolve_failed', { signalId: entry.autoSignalId, error: err.message });
      return null;
    }
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
        // Abierta solo ha pagado la entrada: su total es la comisión de entrada.
        await this.repo.closePosition(position.id, { exitPrice: leg.price, closedAt: ctx.now, pnlUsdt: pnl, feesUsdt: fees, closeReason: action.reason || null,
          entryFeeUsdt: position.feesUsdt, exitFeeUsdt: leg.fee });
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
    // Las entradas no finales del usuario (cualquier bot) también reservan:
    // lo pendiente al LIMIT (prima si compra, margen estimado si vende).
    const ledger = this.liveExecutor.repo;
    const pendingOrders = typeof ledger?.listOpenEntriesByUser === 'function'
      ? await ledger.listOpenEntriesByUser(strategy.userId)
      : (await this.liveOrders.listByStrategy(strategy.id)).map((o) => ({ ...o, strategyId: strategy.id }));
    for (const o of pendingOrders || []) {
      const meta = parseSymbol(o.symbol);
      if (!meta) continue;
      const spot = meta.underlying === String(ctx.underlying || strategy.underlying).toUpperCase() ? ctx.spot : await this.spotFor(meta.underlying, ctx);
      const margin = orderReservedUsdt(o, spot);
      userMargin += margin;
      if (Number(o.strategyId) === Number(strategy.id)) strategyMargin += margin;
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
    // Solo los bots por alertas abren al medio; el resto de templates
    // conserva el precio ejecutable (bid al vender, ask al comprar).
    const midEntry = action.type === 'open' && strategy.template === 'alert_signal';
    const { quotes, missing } = await this.quoteLegs(action.legs, { fresh: true });
    if (missing) {
      await this.recordOutcome(strategy, 'live',
        { type: 'skip', reason: 'no_liquidity', detail: `Sin precio para ${missing}` }, ctx);
      return null;
    }
    // Aperturas de bots por alertas: LIMIT GTC al medio del libro fresco,
    // sobre la rejilla del contrato. Sin medio válido (un solo lado, sin
    // tick conocido o sin tick dentro del spread) va al precio ejecutable.
    if (midEntry) {
      for (let i = 0; i < action.legs.length; i++) {
        quotes[i].price = await this.midEntryPrice(action.legs[i], quotes[i]);
      }
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
    // El precio LIMIT es la cotización recién consultada (el medio al abrir un bot por alertas), pero el fill
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
    if (action.type === 'open' && ['submitted', 'attention'].includes(result.status)) {
      await this.markEstimatedSignalFee(quoted, quotes, ctx);
    }
    if (result.status === 'submitted' || result.status === 'attention') {
      await this.maybeNotify(strategy, `Órdenes LIMIT enviadas: ${result.sent}. A la espera de fills confirmados (10 min)`, 'trade');
    }
    // 'attention' (envío ambiguo) también queda pendiente: la conciliación
    // con Binance resuelve la señal con lo que realmente se llenó.
    ctx.produced?.push({ mode: 'live', type: action.type,
      pending: isPendingSubmitStatus(result.status), reason: result.status,
      detail: submitOutcomeText(result.status, result.error) });
    return result;
  }

  /**
   * Mientras la entrada real no se resuelve con sus fills, la señal muestra
   * la comisión estimada al precio LIMIT enviado (se marca como estimada).
   */
  async markEstimatedSignalFee(legs, quotes, ctx) {
    const signalId = ctx.signal?.signalId;
    if (signalId == null || typeof this.repo.setAutoSignalFees !== 'function') return;
    try {
      const feesUsdt = legs.reduce((sum, leg, i) => sum + tradeFee({
        spot: num(quotes[i]?.quote?.spot) ?? ctx.spot, quantity: leg.quantity, price: leg.price,
      }), 0);
      await this.repo.setAutoSignalFees(signalId, { feesUsdt, feesEstimated: true });
    } catch (err) {
      this.logger.warn('options_signal_fee_estimate_failed', { signalId, error: err.message });
    }
  }

  /**
   * Precio de entrada de una pata: el medio sobre la rejilla o, si no hay
   * medio válido, el precio ejecutable (ask al comprar, bid al vender), el
   * que se llena antes. El tick sale de la cotización si lo trae; si no, del
   * PRICE_FILTER del contrato. `quoted` es { quote, price } de quoteLegs.
   */
  async midEntryPrice(leg, { quote, price }) {
    let tickSize = Number(quote?.tickSize) > 0 ? quote.tickSize : null;
    let minPrice = tickSize != null ? quote.minPrice : null;
    if (tickSize == null && typeof this.market.getPriceFilter === 'function') {
      try {
        const filter = await this.market.getPriceFilter(leg.symbol);
        if (Number(filter?.tickSize) > 0) ({ tickSize, minPrice } = filter);
      } catch (err) {
        this.logger.warn('options_price_filter_failed', { symbol: leg.symbol, error: err.message });
      }
    }
    const mid = tickSize == null ? null
      : midLimitPrice({ bid: quote?.bid, ask: quote?.ask, side: leg.side, tickSize, minPrice });
    if (mid != null) return mid;
    this.logger.info('options_entry_mid_fallback', {
      symbol: leg.symbol, side: leg.side, bid: quote?.bid ?? null, ask: quote?.ask ?? null, price,
    });
    return price;
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
        await this.repo.closePosition(p.id, { exitPrice: value, closedAt: tickCtx.now, pnlUsdt: pnl, feesUsdt: fees, closeReason: 'expiry',
          entryFeeUsdt: p.feesUsdt, exerciseFeeUsdt: fee });
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
