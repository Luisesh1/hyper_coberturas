/**
 * hedge.service.js
 *
 * Gestiona coberturas automáticas con PostgreSQL como fuente de verdad interna
 * y Hyperliquid como origen de verdad de ejecución.
 *
 * Flujo principal:
 *   1. createHedge        -> LIMIT GTC de entrada (entry_pending)
 *   2. Fill de entrada    -> guardar fill real y pasar a entry_filled_pending_sl
 *   3. Confirmar SL       -> open_protected
 *   4. Fill de salida     -> registrar ciclo con fill real y re-colocar entrada
 *
 * El monitor reconcilia estados si se pierde un userEvent o tras un reinicio.
 */

const EventEmitter = require('events');
const hedgeRepository = require('../repositories/hedge.repository');
const HedgeNotifier = require('./hedge.notifier');
const { placePositionProtection } = require('./protection.service');
const { getTrackedPositionSize } = require('./hedge.state');
const { formatPrice, formatSize, numericEqual } = require('../utils/format');
const { ValidationError } = require('../errors/app-error');
const config = require('../config');
const logger = require('./logger.service');
const KeyedMutex = require('../utils/keyed-mutex');
const leverageMutex = require('./leverage.mutex');

const ENTRY_RESCUE_GRACE_MS = 15_000;
const MARKET_ORDER_SLIPPAGE = config.trading.marketOrderSlippage || 0.002;

function getOrderCoin(order) {
  return String(order?.coin ?? order?.asset ?? '').toUpperCase();
}

function getOrderSize(order) {
  return parseFloat(order?.sz ?? order?.origSz ?? order?.size ?? 0);
}

function getOrderIsBuy(order) {
  if (typeof order?.isBuy === 'boolean') return order.isBuy;
  const side = String(order?.side ?? '').toUpperCase();
  if (side === 'B' || side === 'BUY') return true;
  if (side === 'A' || side === 'S' || side === 'SELL') return false;
  return null;
}

function isReduceOnlyOrder(order) {
  if (typeof order?.reduceOnly === 'boolean') return order.reduceOnly;
  if (typeof order?.reduce_only === 'boolean') return order.reduce_only;
  if (typeof order?.r === 'boolean') return order.r;
  return false;
}

class HedgeService extends EventEmitter {
  constructor(userId, account, hlService, tgService, deps = {}) {
    super();
    this.userId = userId;
    this.account = account || null;
    this.accountId = account?.id || null;
    this.hl = hlService;
    this.tg = tgService;
    this.repo = deps.repo || hedgeRepository;
    this.notifier = deps.notifier || new HedgeNotifier(this, tgService);
    this.hedges = new Map();
    this._hedgeMutex = new KeyedMutex();
    this._monitorInterval = null;
  }

  async init() {
    const hedges = await this.repo.loadAllByUser(this.userId, this.accountId);

    for (const hedge of hedges) {
      this.hedges.set(hedge.id, hedge);
    }

    logger.info('hedge_init', { userId: this.userId, accountId: this.accountId, count: this.hedges.size });
    this._startMonitor();
  }

  async _save(hedge) {
    await this.repo.save(hedge);
  }

  async _saveCycle(hedgeId, cycle) {
    await this.repo.saveCycle(hedgeId, cycle);
  }

  async _ensureEntryConfig(hedge) {
    if (!hedge.assetIndex || hedge.szDecimals == null) {
      const meta = await this.hl.getAssetMeta(hedge.asset);
      hedge.assetIndex = meta.index;
      hedge.szDecimals = meta.szDecimals;
    }

    const lev = parseInt(hedge.leverage, 10);
    if (!Number.isFinite(lev) || lev < 1 || lev > 100) {
      throw new ValidationError(`leverage inválido para hedge #${hedge.id}: ${hedge.leverage}`);
    }
    const isCross = hedge.marginMode === 'cross';
    // Mutex compartido con trading.service: serializa cambios de leverage por
    // (cuenta, asset) para evitar que una apertura manual pise el modo pedido
    // por una cobertura automática.
    const mutexKey = leverageMutex.leverageKey({ accountId: this.accountId, assetIndex: hedge.assetIndex });
    await leverageMutex.runExclusive(mutexKey, async () => {
      await this.hl.updateLeverage(hedge.assetIndex, isCross, lev);
    });
  }

  _nextPositionKey(hedge) {
    const nextCycle = hedge.cycleCount + 1;
    return `${this.userId}:${this.accountId}:${hedge.id}:${nextCycle}:${Date.now()}`;
  }

  async _emitUpdated(hedge) {
    hedge.lastReconciledAt = Date.now();
    await this._save(hedge).catch((err) => logger.error('hedge_save_failed', { hedgeId: hedge.id, error: err.message }));
    this.notifier.updated(hedge);
  }

  async _setError(hedge, err, { persist = true, emit = true } = {}) {
    hedge.status = 'error';
    hedge.error = err.message;
    hedge.lastReconciledAt = Date.now();
    if (persist) {
      await this._save(hedge).catch((err) => logger.error('hedge_save_failed', { hedgeId: hedge.id, error: err.message }));
    }
    if (emit) {
      this.notifier.error(hedge, err);
    }
  }

  _sizeEpsilon(hedge) {
    return Math.pow(10, -(hedge.szDecimals ?? 4));
  }

  _getExpectedSize(hedge) {
    const expectedSize = Math.abs(parseFloat(hedge?.size || 0));
    return Number.isFinite(expectedSize) ? expectedSize : 0;
  }

  _normalizePositionSize(positionSize) {
    const actualSize = Math.abs(parseFloat(positionSize || 0));
    return Number.isFinite(actualSize) ? actualSize : 0;
  }

  _isEntryTransitionInProgress(hedge) {
    return !!(hedge?._entryPlacementInProgress || hedge?._entryRescueInProgress);
  }

  _isPartialPositionSize(hedge, positionSize) {
    const expectedSize = this._getExpectedSize(hedge);
    const actualSize = this._normalizePositionSize(positionSize);
    if (expectedSize <= 0 || actualSize <= 0) return false;
    return (actualSize + this._sizeEpsilon(hedge)) < expectedSize;
  }

  _buildPartialCoveragePayload(hedge, positionSize, source = 'partial_fill') {
    const expectedSize = this._getExpectedSize(hedge);
    const actualSize = this._normalizePositionSize(positionSize);
    const missingSize = Math.max(expectedSize - actualSize, 0);

    return {
      source,
      asset: hedge.asset,
      expectedSize,
      actualSize,
      missingSize,
      message:
        `Cobertura parcial detectada (${source}): abierta ${actualSize} ${hedge.asset} ` +
        `de ${expectedSize}. Falta ${missingSize} ${hedge.asset}.`,
    };
  }

  _clearPartialCoverageInfo(hedge) {
    hedge.partialCoverageInfo = null;
  }

  async _notifyPartialCoverage(hedge, positionSize, source = 'partial_fill') {
    if (!this._isPartialPositionSize(hedge, positionSize)) {
      this._clearPartialCoverageInfo(hedge);
      return null;
    }

    const payload = this._buildPartialCoveragePayload(hedge, positionSize, source);
    const previous = hedge.partialCoverageInfo;
    if (
      previous
      && previous.source === payload.source
      && numericEqual(previous.actualSize, payload.actualSize, this._sizeEpsilon(hedge))
    ) {
      return previous;
    }

    hedge.partialCoverageInfo = payload;
    this.notifier.partialCoverage(hedge, payload);
    return payload;
  }

  _hasOpenOrder(openOrders = [], oid) {
    return !!oid && Array.isArray(openOrders) && openOrders.some((order) => Number(order.oid) === Number(oid));
  }

  _isEntryConditionMet(hedge, price) {
    if (!Number.isFinite(price) || price <= 0) return false;
    return hedge.direction === 'short'
      ? price <= parseFloat(hedge.entryPrice)
      : price >= parseFloat(hedge.entryPrice);
  }

  _isExitBreached(hedge, price) {
    if (!Number.isFinite(price) || price <= 0) return false;
    return hedge.direction === 'short'
      ? price >= parseFloat(hedge.exitPrice)
      : price <= parseFloat(hedge.exitPrice);
  }

  _getDynamicAnchorPrice(hedge) {
    const anchor = parseFloat(hedge.dynamicAnchorPrice);
    if (Number.isFinite(anchor) && anchor > 0) return anchor;
    return parseFloat(hedge.entryPrice);
  }

  async _handleUnexpectedPositionSize(hedge, positionSize, context = 'position_check') {
    const expectedSize = this._getExpectedSize(hedge);
    const actualSize = this._normalizePositionSize(positionSize);

    if (!Number.isFinite(expectedSize) || expectedSize <= 0) return false;
    if (!Number.isFinite(actualSize) || actualSize <= 0) return false;

    hedge.positionSize = actualSize;
    if (actualSize < expectedSize || numericEqual(actualSize, expectedSize, this._sizeEpsilon(hedge))) {
      this._clearPartialCoverageInfo(hedge);
      return false;
    }

    await this._cancelRelatedEntryOrders(hedge, { keepOid: null });
    await this._setError(
      hedge,
      new Error(
        `Posicion sobredimensionada detectada (${context}): ${actualSize} ${hedge.asset} > ${expectedSize}. ` +
        'Se detiene la cobertura para evitar entradas duplicadas.'
      )
    );
    return true;
  }

  validatePendingHedgeConfig({
    asset,
    entryPrice,
    exitPrice,
    size,
    leverage,
    direction = 'short',
    excludeHedgeId = null,
  }) {
    const entry = parseFloat(entryPrice);
    const exit = parseFloat(exitPrice);
    const lev = parseInt(leverage, 10);
    const sz = parseFloat(size);
    const dir = direction === 'long' ? 'long' : 'short';

    if (isNaN(entry) || entry <= 0) throw new ValidationError('entryPrice invalido');
    if (isNaN(exit) || exit <= 0) throw new ValidationError('exitPrice invalido');
    if (isNaN(sz) || sz <= 0) throw new ValidationError('size invalido');
    if (isNaN(lev) || lev < 1 || lev > 100) throw new ValidationError('leverage debe estar entre 1 y 100');
    if (dir === 'short' && exit <= entry) throw new ValidationError('Para SHORT exitPrice debe ser mayor a entryPrice');
    if (dir === 'long' && exit >= entry) throw new ValidationError('Para LONG exitPrice debe ser menor a entryPrice');

    const assetUp = asset.toUpperCase();

    // Regla: solo una cobertura activa por activo y direccion
    const TERMINAL = ['cancelled', 'error'];
    const duplicate = [...this.hedges.values()].find(
      (h) => Number(h.id) !== Number(excludeHedgeId)
        && h.asset === assetUp
        && h.direction === dir
        && !TERMINAL.includes(h.status)
    );
    if (duplicate) {
      throw new ValidationError(
        `Ya existe una cobertura ${dir.toUpperCase()} activa para ${assetUp} ` +
        `(#${duplicate.id} — ${duplicate.status}). Cancélala antes de crear una nueva.`
      );
    }

    return {
      asset: assetUp,
      direction: dir,
      entryPrice: entry,
      exitPrice: exit,
      leverage: lev,
      size: sz,
    };
  }

  validateCreateRequest(payload) {
    return this.validatePendingHedgeConfig(payload);
  }

  validateDynamicExitRequest({
    asset,
    direction = 'short',
    dynamicAnchorPrice,
    exitPrice,
    size,
    leverage,
  }) {
    const anchor = parseFloat(dynamicAnchorPrice);
    const exit = parseFloat(exitPrice);
    const lev = parseInt(leverage, 10);
    const sz = parseFloat(size);
    const dir = direction === 'long' ? 'long' : 'short';

    if (isNaN(anchor) || anchor <= 0) throw new ValidationError('dynamicAnchorPrice invalido');
    if (isNaN(exit) || exit <= 0) throw new ValidationError('exitPrice invalido');
    if (isNaN(sz) || sz <= 0) throw new ValidationError('size invalido');
    if (isNaN(lev) || lev < 1 || lev > 100) throw new ValidationError('leverage debe estar entre 1 y 100');
    if (dir === 'short' && exit <= anchor) {
      throw new ValidationError('Para SHORT exitPrice debe ser mayor a dynamicAnchorPrice');
    }
    if (dir === 'long' && exit >= anchor) {
      throw new ValidationError('Para LONG exitPrice debe ser menor a dynamicAnchorPrice');
    }

    return {
      asset: String(asset || '').toUpperCase(),
      direction: dir,
      dynamicAnchorPrice: anchor,
      exitPrice: exit,
      leverage: lev,
      size: sz,
    };
  }

  async createHedge({
    asset,
    entryPrice,
    exitPrice,
    size,
    leverage,
    label,
    direction = 'short',
    marginMode = 'isolated',
    protectedPoolId = null,
    protectedRole = null,
  }) {
    const normalized = this.validatePendingHedgeConfig({
      asset,
      entryPrice,
      exitPrice,
      size,
      leverage,
      direction,
    });

    const { asset: assetUp, direction: dir, entryPrice: entry, exitPrice: exit, leverage: lev, size: sz } = normalized;

    const hedgeLabel = label || `${assetUp} Cobertura`;
    const createdAt = Date.now();

    const hedge = {
      id: null,
      userId: this.userId,
      accountId: this.accountId,
      account: this.account,
      asset: assetUp,
      direction: dir,
      entryPrice: entry,
      exitPrice: exit,
      dynamicAnchorPrice: entry,
      size: sz,
      leverage: lev,
      label: hedgeLabel,
      marginMode,
      status: 'entry_pending',
      createdAt,
      openedAt: null,
      closedAt: null,
      openPrice: null,
      closePrice: null,
      unrealizedPnl: null,
      entryOid: null,
      slOid: null,
      assetIndex: null,
      szDecimals: null,
      positionSize: null,
      error: null,
      cycles: [],
      cycleCount: 0,
      positionKey: null,
      closingStartedAt: null,
      slPlacedAt: null,
      lastFillAt: null,
      lastReconciledAt: createdAt,
      entryFillOid: null,
      entryFillTime: null,
      entryFeePaid: 0,
      fundingAccum: 0,
      protectedPoolId,
      protectedRole,
      partialCoverageInfo: null,
    };

    hedge.positionKey = this._nextPositionKey(hedge);
    hedge.id = await this.repo.create(hedge);
    this.hedges.set(hedge.id, hedge);
    this.notifier.created(hedge);

    // Awaiting para que el HTTP devuelva el estado real tras colocar el stop
    // de entrada. Sin el await, el caller ve success aun cuando la orden no
    // se pudo colocar, y el hedge queda flotando en "entry_pending" sin oid.
    try {
      await this._placeEntryOrder(hedge);
    } catch (err) {
      await this._setError(hedge, err);
    }
    return hedge;
  }

  async cancelHedge(id) {
    const hedge = this.hedges.get(id);
    if (!hedge) throw new Error(`Cobertura #${id} no encontrada`);
    if (hedge.status === 'cancelled') throw new Error(`La cobertura #${id} ya esta cancelada`);

    return this._hedgeMutex.runExclusive(id, async () => {
      hedge.status = 'cancel_pending';
      hedge.cancelStartedAt = Date.now();
      hedge.error = null;
      await this._emitUpdated(hedge);

      await this._reconcileCancelPending(hedge);
      return hedge;
    });
  }

  async retargetPendingHedge(id, {
    entryPrice,
    exitPrice,
    label,
  }) {
    const hedge = this.getById(id);
    if (['open', 'open_protected', 'entry_filled_pending_sl', 'closing'].includes(hedge.status)) {
      throw new Error(`La cobertura #${id} ya esta abierta y no se puede mover como pendiente`);
    }
    if (hedge.status === 'cancel_pending' || hedge.status === 'cancelled') {
      throw new Error(`La cobertura #${id} no esta disponible para retarget`);
    }

    return this._hedgeMutex.runExclusive(id, async () => {
      const nextEntryPrice = parseFloat(entryPrice);
      const nextExitPrice = parseFloat(exitPrice);
      const nextLabel = label || hedge.label;
      this.validatePendingHedgeConfig({
        asset: hedge.asset,
        direction: hedge.direction,
        entryPrice: nextEntryPrice,
        exitPrice: nextExitPrice,
        size: hedge.size,
        leverage: hedge.leverage,
        excludeHedgeId: hedge.id,
      });

      await this._ensureEntryConfig(hedge);
      if (hedge.entryOid) {
        await this.hl.cancelOrder(hedge.assetIndex, hedge.entryOid).catch((err) => {
          throw new Error(`No se pudo cancelar la orden de entrada actual: ${err.message}`);
        });
      }

      hedge.entryOid = null;
      hedge.entryPrice = nextEntryPrice;
      hedge.dynamicAnchorPrice = nextEntryPrice;
      hedge.exitPrice = nextExitPrice;
      hedge.label = nextLabel;
      hedge.status = 'waiting';
      hedge.error = null;
      hedge.lastReconciledAt = Date.now();
      await this._emitUpdated(hedge);
      await this._placeEntryOrder(hedge);
      return hedge;
    });
  }

  async updateOpenHedgeExit(id, exitPrice) {
    const hedge = this.getById(id);
    const nextExitPrice = parseFloat(exitPrice);

    this.validateDynamicExitRequest({
      asset: hedge.asset,
      direction: hedge.direction,
      dynamicAnchorPrice: this._getDynamicAnchorPrice(hedge),
      exitPrice: nextExitPrice,
      size: hedge.size,
      leverage: hedge.leverage,
    });

    return this._hedgeMutex.runExclusive(id, async () => {
      hedge.exitPrice = nextExitPrice;
      hedge.lastReconciledAt = Date.now();
      hedge.error = null;

      if (!['open', 'open_protected', 'entry_filled_pending_sl'].includes(hedge.status)) {
        await this._emitUpdated(hedge);
        return hedge;
      }

      await this._ensureEntryConfig(hedge);
      if (hedge.slOid) {
        await this.hl.cancelOrder(hedge.assetIndex, hedge.slOid).catch((err) => {
          throw new Error(`No se pudo cancelar el stop actual: ${err.message}`);
        });
        hedge.slOid = null;
        hedge.slPlacedAt = null;
      }

      hedge.status = 'entry_filled_pending_sl';
      await this._emitUpdated(hedge);
      await this._ensureStopLoss(hedge);
      return hedge;
    });
  }

  async updateOpenHedgeDynamicAnchor(id, {
    dynamicAnchorPrice,
    exitPrice,
    label,
  }) {
    const hedge = this.getById(id);
    const nextAnchor = parseFloat(dynamicAnchorPrice);
    const nextExit = parseFloat(exitPrice);

    this.validateDynamicExitRequest({
      asset: hedge.asset,
      direction: hedge.direction,
      dynamicAnchorPrice: nextAnchor,
      exitPrice: nextExit,
      size: hedge.size,
      leverage: hedge.leverage,
    });

    return this._hedgeMutex.runExclusive(id, async () => {
      hedge.dynamicAnchorPrice = nextAnchor;
      hedge.exitPrice = nextExit;
      if (label) hedge.label = label;
      hedge.lastReconciledAt = Date.now();
      hedge.error = null;

      if (!['open', 'open_protected', 'entry_filled_pending_sl'].includes(hedge.status)) {
        await this._emitUpdated(hedge);
        return hedge;
      }

      await this._ensureEntryConfig(hedge);
      if (hedge.slOid) {
        await this.hl.cancelOrder(hedge.assetIndex, hedge.slOid).catch((err) => {
          throw new Error(`No se pudo cancelar el stop actual: ${err.message}`);
        });
        hedge.slOid = null;
        hedge.slPlacedAt = null;
      }

      hedge.status = 'entry_filled_pending_sl';
      await this._emitUpdated(hedge);
      await this._ensureStopLoss(hedge);
      return hedge;
    });
  }

  getAll() {
    return [...this.hedges.values()].sort((a, b) => b.id - a.id);
  }

  getById(id) {
    const hedge = this.hedges.get(id);
    if (!hedge) throw new Error(`Cobertura #${id} no encontrada`);
    return hedge;
  }

  _findMatchingEntryOrders(hedge, openOrders = []) {
    return this._findEntryOrders(hedge, openOrders);
  }

  _findEntryOrders(hedge, openOrders = [], { relaxedSize = false } = {}) {
    const isBuy = hedge.direction === 'long';
    const sizeEpsilon = Math.pow(10, -(hedge.szDecimals ?? 4));

    return openOrders.filter((order) => {
      if (getOrderCoin(order) !== hedge.asset) return false;
      if (isReduceOnlyOrder(order)) return false;

      const orderIsBuy = getOrderIsBuy(order);
      if (orderIsBuy !== null && orderIsBuy !== isBuy) return false;

      const orderSize = getOrderSize(order);
      if (!relaxedSize && Number.isFinite(orderSize) && !numericEqual(orderSize, hedge.size, sizeEpsilon)) {
        return false;
      }

      return true;
    });
  }

  _findMatchingEntryOrder(hedge, openOrders = []) {
    return this._findMatchingEntryOrders(hedge, openOrders)[0] || null;
  }

  _findMatchingStopLossOrder(hedge, openOrders = []) {
    const isBuy = hedge.direction !== 'long';
    const sizeEpsilon = Math.pow(10, -(hedge.szDecimals ?? 4));
    const trackedSize = getTrackedPositionSize(hedge);

    return openOrders.find((order) => {
      if (getOrderCoin(order) !== hedge.asset) return false;
      if (!isReduceOnlyOrder(order)) return false;

      const orderIsBuy = getOrderIsBuy(order);
      if (orderIsBuy !== null && orderIsBuy !== isBuy) return false;

      const orderSize = getOrderSize(order);
      if (Number.isFinite(orderSize) && !numericEqual(orderSize, trackedSize, sizeEpsilon)) {
        return false;
      }

      return true;
    }) || null;
  }

  async _cancelDuplicateEntryOrders(hedge, openOrders = [], keepOid = null) {
    return this._cancelEntryOrders(hedge, {
      openOrders,
      keepOid,
      relaxedSize: false,
      keepFirstWhenNoKeepOid: true,
    });
  }

  async _cancelRelatedEntryOrders(hedge, { openOrders = null, keepOid = null } = {}) {
    return this._cancelEntryOrders(hedge, {
      openOrders,
      keepOid,
      relaxedSize: true,
      keepFirstWhenNoKeepOid: false,
    });
  }

  async _cancelEntryOrders(hedge, {
    openOrders = null,
    keepOid = null,
    relaxedSize = false,
    keepFirstWhenNoKeepOid = false,
  } = {}) {
    let latestOpenOrders = Array.isArray(openOrders) ? openOrders : null;
    if (!latestOpenOrders) {
      try {
        latestOpenOrders = await this.hl.getOpenOrders();
      } catch (err) {
        logger.warn('hedge_query_orders_failed', { hedgeId: hedge.id, error: err.message });
        return null;
      }
    }

    const matchingEntries = this._findEntryOrders(hedge, latestOpenOrders, { relaxedSize });
    if (matchingEntries.length === 0) return null;

    const keepOrder = keepOid != null
      ? (matchingEntries.find((order) => Number(order.oid) === Number(keepOid)) || null)
      : (keepFirstWhenNoKeepOid ? matchingEntries[0] : null);

    for (const order of matchingEntries) {
      const oid = Number(order.oid);
      if (!oid || oid === Number(keepOrder?.oid)) continue;
      await this.hl.cancelOrder(hedge.assetIndex, oid).catch((err) => {
        logger.warn('hedge_cancel_dup_failed', { hedgeId: hedge.id, oid, error: err.message });
      });
    }

    return keepOrder || null;
  }

  async _reconcileTriggeredEntry(hedge, {
    currentPrice = null,
    openOrders = null,
    openOrdersAvailable = false,
    source = 'unknown',
  } = {}) {
    if (!hedge.entryOid || hedge.status !== 'entry_pending') {
      return { acted: false, reason: 'not_pending' };
    }
    if (hedge._entryRescueInProgress) {
      return { acted: false, reason: 'in_progress' };
    }

    hedge._entryRescueInProgress = true;
    try {
      if (hedge.entryPlacedAt && Date.now() - hedge.entryPlacedAt < ENTRY_RESCUE_GRACE_MS) {
        return { acted: false, reason: 'grace_period' };
      }

      let price = Number(currentPrice);
      if (!Number.isFinite(price) || price <= 0) {
        const mids = await this.hl.getAllMids().catch((err) => { logger.warn('getAllMids failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: err.message }); return null; });
        price = mids ? parseFloat(mids[hedge.asset]) : NaN;
      }
      if (!this._isEntryConditionMet(hedge, price)) {
        return { acted: false, reason: 'condition_not_met' };
      }

      if (this._isExitBreached(hedge, price)) {
        hedge.status = 'error';
        hedge.error = `Precio (${price}) cruzó nivel de salida (${hedge.exitPrice}). Cobertura pausada.`;
        await this._emitUpdated(hedge);
        return { acted: false, reason: 'exit_breached' };
      }

      let latestOpenOrders = Array.isArray(openOrders) ? openOrders : [];
      let latestOpenOrdersAvailable = openOrdersAvailable;
      if (!latestOpenOrdersAvailable) {
        try {
          latestOpenOrders = await this.hl.getOpenOrders();
          latestOpenOrdersAvailable = true;
        } catch (err) {
          hedge.error = `Entrada pendiente: no se pudo confirmar estado de orden (${err.message})`;
          await this._emitUpdated(hedge);
          return { acted: false, reason: 'open_orders_unavailable' };
        }
      }

      const posBefore = await this.hl.getPosition(hedge.asset).catch((err) => { logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: err.message }); return null; });
      if (posBefore && parseFloat(posBefore.szi) !== 0) {
        if (await this._handleUnexpectedPositionSize(hedge, Math.abs(parseFloat(posBefore.szi)), `${source}:position_open`)) {
          return { acted: false, reason: 'oversized_position' };
        }
        const recovered = await this._recoverEntryFromExchange(hedge);
        return { acted: false, reason: recovered ? 'recovered_position_open' : 'position_open' };
      }

      if (hedge.status !== 'entry_pending' || !hedge.entryOid) {
        return { acted: false, reason: 'state_changed' };
      }

      const entryStillOpen = this._hasOpenOrder(latestOpenOrders, hedge.entryOid);
      if (!entryStillOpen) {
        const recovered = await this._recoverEntryFromExchange(hedge);
        if (recovered || hedge.status !== 'entry_pending') {
          return { acted: false, reason: recovered ? 'recovered_missing_order' : 'state_changed' };
        }
      } else {
        try {
          await this.hl.cancelOrder(hedge.assetIndex, hedge.entryOid);
        } catch (err) {
          hedge.error = `Entrada pendiente: cancelacion no confirmada (${err.message})`;
          await this._emitUpdated(hedge);
          return { acted: false, reason: 'cancel_failed' };
        }

        try {
          latestOpenOrders = await this.hl.getOpenOrders();
          latestOpenOrdersAvailable = true;
        } catch (err) {
          hedge.error = `Entrada pendiente: cancelacion solicitada pero no se pudo confirmar (${err.message})`;
          await this._emitUpdated(hedge);
          return { acted: false, reason: 'cancel_unconfirmed' };
        }

        const posAfterCancel = await this.hl.getPosition(hedge.asset).catch((err) => { logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: err.message }); return null; });
        if (posAfterCancel && parseFloat(posAfterCancel.szi) !== 0) {
          if (await this._handleUnexpectedPositionSize(hedge, Math.abs(parseFloat(posAfterCancel.szi)), `${source}:post_cancel_position`)) {
            return { acted: false, reason: 'oversized_position' };
          }
          const recovered = await this._recoverEntryFromExchange(hedge);
          return { acted: false, reason: recovered ? 'recovered_after_cancel' : 'position_open_after_cancel' };
        }

        if (hedge.status !== 'entry_pending' || !hedge.entryOid) {
          return { acted: false, reason: 'state_changed' };
        }

        if (this._hasOpenOrder(latestOpenOrders, hedge.entryOid)) {
          hedge.error = 'Entrada pendiente: cancelacion no confirmada; IOC omitida para evitar duplicados.';
          await this._emitUpdated(hedge);
          return { acted: false, reason: 'order_still_open' };
        }

        const recovered = await this._recoverEntryFromExchange(hedge);
        if (recovered || hedge.status !== 'entry_pending') {
          return { acted: false, reason: recovered ? 'recovered_after_cancel_check' : 'state_changed' };
        }
      }

      if (!latestOpenOrdersAvailable) {
        return { acted: false, reason: 'open_orders_unconfirmed' };
      }

      const posBeforeIoc = await this.hl.getPosition(hedge.asset).catch((err) => { logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: err.message }); return null; });
      if (posBeforeIoc && parseFloat(posBeforeIoc.szi) !== 0) {
        if (await this._handleUnexpectedPositionSize(hedge, Math.abs(parseFloat(posBeforeIoc.szi)), `${source}:pre_ioc_position`)) {
          return { acted: false, reason: 'oversized_position' };
        }
        const recovered = await this._recoverEntryFromExchange(hedge);
        return { acted: false, reason: recovered ? 'recovered_pre_ioc' : 'position_open_pre_ioc' };
      }

      if (hedge.status !== 'entry_pending') {
        return { acted: false, reason: 'state_changed' };
      }

      hedge.entryOid = null;
      hedge.slOid = null;
      hedge.slPlacedAt = null;
      hedge.error = null;

      const isBuy = hedge.direction === 'long';
      const forcePrice = isBuy
        ? formatPrice(price * (1 + MARKET_ORDER_SLIPPAGE))
        : formatPrice(price * (1 - MARKET_ORDER_SLIPPAGE));

      try {
        await this._ensureEntryConfig(hedge);
        const { oid } = await this.hl.placeOrder({
          assetIndex: hedge.assetIndex,
          isBuy,
          size: formatSize(hedge.size, hedge.szDecimals),
          price: forcePrice,
          reduceOnly: false,
          tif: 'Ioc',
        });
        hedge.entryOid = oid || null;
        hedge.entryPlacedAt = Date.now();
        await this._emitUpdated(hedge);
        logger.info('hedge_ioc_sent', { hedgeId: hedge.id, oid: oid ?? null, source });
        return { acted: true, reason: 'forced_ioc' };
      } catch (err) {
        logger.error('hedge_ioc_failed', { hedgeId: hedge.id, source, error: err.message });
        hedge.error = `Error entrada forzada: ${err.message}`;
        await this._emitUpdated(hedge);
        return { acted: false, reason: 'ioc_failed' };
      }
    } finally {
      hedge._entryRescueInProgress = false;
    }
  }

  onFill(fill) {
    const oid = Number(fill?.oid);
    if (!oid) return;

    for (const hedge of this.hedges.values()) {
      if (hedge.entryOid === oid && hedge.status === 'entry_pending') {
        this._hedgeMutex.runExclusive(hedge.id, () => this._onEntryFill(hedge, fill))
          .catch((err) => this._setError(hedge, err));
        return;
      }
      if (hedge.slOid === oid && ['open_protected', 'closing', 'entry_filled_pending_sl'].includes(hedge.status)) {
        this._hedgeMutex.runExclusive(hedge.id, () => this._onSlFill(hedge, fill))
          .catch((err) => this._setError(hedge, err));
        return;
      }
    }
  }

  async _placeEntryOrder(hedge, { openOrders = null, openOrdersAvailable = true } = {}) {
    if (['cancel_pending', 'cancelled', 'closing', 'entry_filled_pending_sl', 'open_protected'].includes(hedge.status)) {
      return { placed: false, reason: 'status_blocked' };
    }
    if (this._isEntryTransitionInProgress(hedge)) {
      return { placed: false, reason: 'transition_in_progress' };
    }

    hedge._entryPlacementInProgress = true;
    try {
      await this._ensureEntryConfig(hedge);

      const pos = await this.hl.getPosition(hedge.asset).catch((err) => { logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: err.message }); return null; });
      if (pos && parseFloat(pos.szi) !== 0) {
        hedge.positionSize = Math.abs(parseFloat(pos.szi));
        hedge.dynamicAnchorPrice = this._getDynamicAnchorPrice(hedge);
        if (await this._handleUnexpectedPositionSize(hedge, hedge.positionSize, 'place_entry_order')) {
          return { placed: false, reason: 'oversized_position' };
        }
        if (openOrdersAvailable) {
          await this._cancelDuplicateEntryOrders(hedge, openOrders || [], null);
        }
        const matchingSl = openOrdersAvailable ? this._findMatchingStopLossOrder(hedge, openOrders || []) : null;
        hedge.entryOid = null;
        if (matchingSl?.oid) {
          hedge.slOid = Number(matchingSl.oid);
          hedge.status = 'open_protected';
        } else {
          hedge.status = 'entry_filled_pending_sl';
        }
        const posEntryPrice = parseFloat(pos.entryPx || 0);
        if (hedge.openPrice == null && Number.isFinite(posEntryPrice) && posEntryPrice > 0) {
          hedge.openPrice = posEntryPrice;
        }
        hedge.unrealizedPnl = parseFloat(pos.unrealizedPnl || hedge.unrealizedPnl || 0);
        hedge.error = null;
        await this._emitUpdated(hedge);
        return { placed: false, reason: 'position_open' };
      }

      if (openOrdersAvailable) {
        const matchingEntry = this._findMatchingEntryOrder(hedge, openOrders || []);
        if (matchingEntry?.oid) {
          hedge.entryOid = Number(matchingEntry.oid);
          hedge.status = 'entry_pending';
          hedge.error = null;
          hedge.entryPlacedAt = hedge.entryPlacedAt || Date.now();
          await this._emitUpdated(hedge);
          return { placed: false, reason: 'existing_order' };
        }
      }

      hedge.positionKey = this._nextPositionKey(hedge);
      hedge.entryOid = null;
      hedge.slOid = null;
      hedge.dynamicAnchorPrice = hedge.entryPrice;
      hedge.positionSize = null;
      hedge.openedAt = null;
      hedge.closedAt = null;
      hedge.openPrice = null;
      hedge.closePrice = null;
      hedge.unrealizedPnl = null;
      hedge.closingStartedAt = null;
      hedge.slPlacedAt = null;
      hedge.lastFillAt = null;
      hedge.entryFillOid = null;
      hedge.entryFillTime = null;
      hedge.entryFeePaid = 0;
      hedge.fundingAccum = 0;
      hedge.partialCoverageInfo = null;

      // ── Stop-market de entrada (sin SL encadenado) ────────────────────────
      const entryOid = await this.hl.placeTriggerEntry({
        assetIndex: hedge.assetIndex,
        isBuy: hedge.direction === 'long',
        size: formatSize(hedge.size, hedge.szDecimals),
        triggerPx: formatPrice(hedge.entryPrice),
      });

      hedge.entryOid      = entryOid;
      hedge.slOid         = null;
      hedge.slPlacedAt    = null;
      hedge.entryPlacedAt = Date.now();
      logger.info('hedge_entry_placed', { hedgeId: hedge.id, direction: hedge.direction, oid: entryOid, price: hedge.entryPrice });

      hedge.status = 'entry_pending';
      hedge.error  = null;
      await this._emitUpdated(hedge);
      return { placed: true, reason: 'new_order' };
    } finally {
      hedge._entryPlacementInProgress = false;
    }
  }

  async _ensureStopLoss(hedge) {
    if (hedge.status === 'cancel_pending' || hedge.status === 'cancelled') {
      return { placed: false, transitioned: false };
    }

    // Guard contra race condition: fill handler + monitor pueden llamar esto en paralelo.
    // Sin este flag, ambos pasan el check de slOid=null y colocan dos SL simultáneos.
    if (hedge._slPlacementInProgress) {
      logger.info('hedge_sl_skip_dup', { hedgeId: hedge.id });
      return { placed: false, transitioned: false };
    }
    hedge._slPlacementInProgress = true;

    try {
      if (!hedge.assetIndex || hedge.szDecimals == null) {
        const meta = await this.hl.getAssetMeta(hedge.asset);
        hedge.assetIndex = meta.index;
        hedge.szDecimals = meta.szDecimals;
      }

      // Verificar que la posición esté realmente abierta antes de asignar SL.
      // placeSL con positionTpsl falla si no hay posición ("Cannot update margin for empty position").
      const pos = await this.hl.getPosition(hedge.asset).catch((err) => { logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: err.message }); return null; });
      if (!pos || parseFloat(pos.szi) === 0) {
        throw new Error(`Posición vacía en HL — no se puede asignar SL todavía`);
      }

      hedge.positionSize = Math.abs(parseFloat(pos.szi));
      const openOrders = await this.hl.getOpenOrders().catch(() => []);
      const existingSl = this._findMatchingStopLossOrder(hedge, openOrders);
      if (existingSl?.oid) {
        const prevStatus = hedge.status;
        hedge.slOid = Number(existingSl.oid);
        hedge.slPlacedAt = hedge.slPlacedAt || Date.now();
        hedge.status = 'open_protected';
        hedge.error = null;
        await this._emitUpdated(hedge);
        logger.info('hedge_sl_reuse', { hedgeId: hedge.id, slOid: hedge.slOid });
        return { placed: false, transitioned: prevStatus !== 'open_protected' };
      }

      const prevStatus = hedge.status;
      const protection = await placePositionProtection({
        hl: this.hl,
        asset: hedge.asset,
        side: hedge.direction,
        size: hedge.positionSize,
        slPrice: hedge.exitPrice,
      });
      const slOid = protection.slOid;

      hedge.slOid = slOid;
      hedge.slPlacedAt = Date.now();
      hedge.status = 'open_protected';
      hedge.error = null;
      await this._emitUpdated(hedge);
      return { placed: true, transitioned: prevStatus !== 'open_protected' };
    } finally {
      hedge._slPlacementInProgress = false;
    }
  }

  async _onEntryFill(hedge, fill) {
    const fillPrice = parseFloat(fill.px);
    const fillSize = Math.abs(parseFloat(fill.sz ?? fill.origSz ?? 0));
    hedge.openedAt      = fill.time || Date.now();
    hedge.openPrice     = fillPrice;
    hedge.dynamicAnchorPrice = this._getDynamicAnchorPrice(hedge);
    hedge.positionSize  = Number.isFinite(fillSize) && fillSize > 0 ? fillSize : hedge.positionSize;
    hedge.entryOid      = null;
    hedge.lastFillAt    = hedge.openedAt;
    hedge.entryFillOid  = Number(fill.oid) || hedge.entryFillOid;
    hedge.entryFillTime = hedge.openedAt;
    hedge.entryFeePaid  = parseFloat(fill.fee || 0);
    hedge.fundingAccum  = 0;
    hedge.error         = null;
    hedge.slRetryCount  = 0;

    logger.info('hedge_entry_filled', { hedgeId: hedge.id, fillPrice });

    // ── Verificar si el precio ya cruzó el nivel de salida ──────────────────
    // El movimiento fue tan rápido que la posición se abrió pero ya es tarde para SL.
    // En ese caso cerrar a mercado inmediatamente y reiniciar el ciclo.
    // allSettled: si una falla no dejamos la otra pendiente sin observar.
    const [midsResult, posResult] = await Promise.allSettled([
      this.hl.getAllMids(),
      this.hl.getPosition(hedge.asset),
    ]);
    const mids = midsResult.status === 'fulfilled' ? midsResult.value : null;
    if (midsResult.status === 'rejected') {
      logger.warn('getAllMids failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: midsResult.reason?.message });
    }
    const posAfterFill = posResult.status === 'fulfilled' ? posResult.value : null;
    if (posResult.status === 'rejected') {
      logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: posResult.reason?.message });
    }
    if (posAfterFill && parseFloat(posAfterFill.szi) !== 0) {
      hedge.positionSize = Math.abs(parseFloat(posAfterFill.szi));
      if (!hedge.openPrice && posAfterFill.entryPx) {
        hedge.openPrice = parseFloat(posAfterFill.entryPx);
      }
    }
    if (await this._handleUnexpectedPositionSize(hedge, hedge.positionSize || fillSize, 'entry_fill')) {
      return;
    }
    const partialCoverage = await this._notifyPartialCoverage(hedge, hedge.positionSize || fillSize, 'entry_fill');
    if (partialCoverage) {
      await this._cancelRelatedEntryOrders(hedge, { keepOid: null });
      // Un solo intento automático de completar la cobertura con IOC. Si
      // falla o vuelve a ser parcial, el hedge se queda en estado partial
      // y el usuario decide. Sin este topup una ráfaga de fill parcial deja
      // la cobertura sub-dimensionada silenciosamente.
      if (!hedge._partialTopupAttempted && partialCoverage.missingSize > 0) {
        hedge._partialTopupAttempted = true;
        await this._autoTopUpPartialEntry(hedge, partialCoverage).catch((err) => {
          logger.warn('hedge_partial_topup_failed', { hedgeId: hedge.id, error: err.message });
        });
      }
    }
    if (mids) {
      const currentMid = parseFloat(mids[hedge.asset]);
      const exitBreached = hedge.direction === 'short'
        ? currentMid >= parseFloat(hedge.exitPrice)
        : currentMid <= parseFloat(hedge.exitPrice);

      if (exitBreached) {
        logger.warn('hedge_exit_breached_post_fill', { hedgeId: hedge.id, currentMid, exitPrice: hedge.exitPrice });
        // Notificar apertura antes de cerrar de emergencia
        this.notifier.opened(hedge);
        hedge.status = 'closing';
        hedge.closingStartedAt = Date.now();
        await this._emitUpdated(hedge);

        const pos = await this.hl.getPosition(hedge.asset).catch((err) => { logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: err.message }); return null; });
        if (pos && parseFloat(pos.szi) !== 0) {
          await this._closePositionReduceOnly(hedge, pos).catch((e) =>
            logger.error('hedge_emergency_close_failed', { hedgeId: hedge.id, error: e.message })
          );
        } else {
          // Posición ya cerrada (muy raro), reiniciar directamente
          await this._placeEntryOrder(hedge).catch((e) =>
            logger.error('hedge_reentry_failed', { hedgeId: hedge.id, error: e.message })
          );
        }
        return;
      }
    }

    // ── Precio OK: colocar SL sobre la posición abierta ─────────────────────
    hedge.status = 'entry_filled_pending_sl';
    await this._emitUpdated(hedge);

    try {
      const { transitioned } = await this._ensureStopLoss(hedge);
      if (transitioned) {
        this.notifier.opened(hedge);
      }
    } catch (err) {
      hedge.error = `SL pendiente: ${err.message}`;
      await this._emitUpdated(hedge);
      this.notifier.protectionMissing(hedge);
      logger.warn('hedge_sl_after_fill_failed', { hedgeId: hedge.id, error: err.message });
    }
  }

  _hasConfirmedEntry(hedge) {
    return (
      hedge.openPrice != null ||
      hedge.openedAt != null ||
      hedge.entryFillOid != null ||
      hedge.entryFillTime != null
    );
  }

  // _resetAfterCycle, _finalizeCycle, _onSlFill → hedge-cycle.mixin.js

  async _autoTopUpPartialEntry(hedge, partialCoverage) {
    const missing = Number(partialCoverage?.missingSize || 0);
    if (!Number.isFinite(missing) || missing <= 0) return false;
    if (!hedge.assetIndex || hedge.szDecimals == null) {
      await this._ensureEntryConfig(hedge);
    }

    const mids = await this.hl.getAllMids().catch(() => null);
    const price = mids ? parseFloat(mids[hedge.asset]) : NaN;
    if (!Number.isFinite(price) || price <= 0) return false;

    // No hacer topup si el precio ya cruzó el exit; sería abrir exposición a pérdida.
    if (this._isExitBreached(hedge, price)) {
      logger.warn('hedge_partial_topup_skipped_exit_breached', { hedgeId: hedge.id, price });
      return false;
    }

    const isBuy = hedge.direction === 'long';
    const forcePrice = isBuy
      ? formatPrice(price * (1 + MARKET_ORDER_SLIPPAGE))
      : formatPrice(price * (1 - MARKET_ORDER_SLIPPAGE));

    try {
      await this.hl.placeOrder({
        assetIndex: hedge.assetIndex,
        isBuy,
        size: formatSize(missing, hedge.szDecimals),
        price: forcePrice,
        reduceOnly: false,
        tif: 'Ioc',
      });
      logger.info('hedge_partial_topup_sent', { hedgeId: hedge.id, missing });
      return true;
    } catch (err) {
      logger.warn('hedge_partial_topup_ioc_failed', { hedgeId: hedge.id, error: err.message });
      return false;
    }
  }

  async _closePositionReduceOnly(hedge, pos) {
    if (!pos || parseFloat(pos.szi) === 0) return;
    const szi = parseFloat(pos.szi);
    const mids = await this.hl.getAllMids();
    const mid = parseFloat(mids[hedge.asset]);
    if (!mid) throw new Error(`Precio no disponible para ${hedge.asset}`);
    const slip = 0.002;
    const isBuy = szi < 0;
    const price = isBuy ? formatPrice(mid * (1 + slip)) : formatPrice(mid * (1 - slip));

    await this.hl.placeOrder({
      assetIndex: hedge.assetIndex,
      isBuy,
      size: formatSize(Math.abs(szi), hedge.szDecimals || 4),
      price,
      reduceOnly: true,
      tif: 'Ioc',
    });
  }

  async _getRecentFills() {
    const fills = await this.hl.getUserFills();
    return Array.isArray(fills) ? fills : [];
  }

  async _recoverEntryFromExchange(hedge) {
    const [posResult, fillsResult] = await Promise.allSettled([
      this.hl.getPosition(hedge.asset),
      this._getRecentFills(),
    ]);
    const pos = posResult.status === 'fulfilled' ? posResult.value : null;
    if (posResult.status === 'rejected') {
      logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: posResult.reason?.message });
    }
    const fills = fillsResult.status === 'fulfilled' ? (fillsResult.value || []) : [];

    const fill = fills.find((item) => Number(item.oid) === Number(hedge.entryOid));
    if (fill) {
      await this._onEntryFill(hedge, fill);
      this.notifier.reconciled(hedge);
      return true;
    }

    if (pos && parseFloat(pos.szi) !== 0) {
      if (await this._handleUnexpectedPositionSize(hedge, Math.abs(parseFloat(pos.szi)), 'recover_entry')) {
        return true;
      }
      await this._onEntryFill(hedge, {
        oid: hedge.entryOid,
        px: pos.entryPx || hedge.entryPrice,
        time: Date.now(),
        fee: 0,
      });
      this.notifier.reconciled(hedge);
      return true;
    }

    return false;
  }

  async _recoverExitFromExchange(hedge) {
    const fills = await this._getRecentFills().catch(() => []);
    const fill = fills.find((item) => Number(item.oid) === Number(hedge.slOid));
    if (fill) {
      await this._onSlFill(hedge, fill);
      this.notifier.reconciled(hedge);
      return true;
    }
    return false;
  }

  // _completeCycleWithoutExitFill → hedge-cycle.mixin.js

  async _reconcileCancelPending(hedge) {
    // Timeout de cancelación: si lleva más de 5 minutos sin poder cancelar, forzar error
    const CANCEL_TIMEOUT_MS = config.intervals.hedgeCancelTimeoutMs;
    if (hedge.cancelStartedAt && Date.now() - hedge.cancelStartedAt > CANCEL_TIMEOUT_MS) {
      hedge.status = 'error';
      hedge.error = 'Cancelación bloqueada por más de 5 min. Intervención manual requerida.';
      await this._emitUpdated(hedge);
      logger.error('hedge_cancel_timeout', { hedgeId: hedge.id });
      return;
    }

    try {
      const [openOrdersResult, posResult] = await Promise.allSettled([
        this.hl.getOpenOrders(),
        this.hl.getPosition(hedge.asset),
      ]);
      const openOrders = openOrdersResult.status === 'fulfilled' ? (openOrdersResult.value || []) : [];
      const pos = posResult.status === 'fulfilled' ? posResult.value : null;
      if (posResult.status === 'rejected') {
        logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: posResult.reason?.message });
      }
      const openOidSet = new Set(openOrders.map((order) => Number(order.oid)));

      if (hedge.entryOid && openOidSet.has(Number(hedge.entryOid))) {
        await this.hl.cancelOrder(hedge.assetIndex, hedge.entryOid).catch((err) => {
          logger.warn('hedge_cancel_entry_failed', { hedgeId: hedge.id, error: err.message });
        });
      }

      if (hedge.slOid && openOidSet.has(Number(hedge.slOid))) {
        await this.hl.cancelOrder(hedge.assetIndex, hedge.slOid).catch((err) => {
          logger.warn('hedge_cancel_sl_failed', { hedgeId: hedge.id, error: err.message });
        });
      }

      if (pos && parseFloat(pos.szi) !== 0) {
        await this._closePositionReduceOnly(hedge, pos).catch((err) => {
          logger.warn('hedge_close_in_cancel_failed', { hedgeId: hedge.id, error: err.message });
        });
        hedge.closingStartedAt = hedge.closingStartedAt || Date.now();
      }

      const [openOrdersAfterResult, posAfterResult] = await Promise.allSettled([
        this.hl.getOpenOrders(),
        this.hl.getPosition(hedge.asset),
      ]);
      const openOrdersAfter = openOrdersAfterResult.status === 'fulfilled' ? (openOrdersAfterResult.value || []) : [];
      const posAfter = posAfterResult.status === 'fulfilled' ? posAfterResult.value : null;
      if (posAfterResult.status === 'rejected') {
        logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: posAfterResult.reason?.message });
      }
      const openAfterSet = new Set(openOrdersAfter.map((order) => Number(order.oid)));
      const stillHasEntry = hedge.entryOid && openAfterSet.has(Number(hedge.entryOid));
      const stillHasSl = hedge.slOid && openAfterSet.has(Number(hedge.slOid));
      const stillHasPos = !!(posAfter && parseFloat(posAfter.szi) !== 0);

      if (!stillHasEntry && !stillHasSl && !stillHasPos) {
        hedge.status = 'cancelled';
        hedge.entryOid = null;
        hedge.slOid = null;
        hedge.error = null;
        hedge.unrealizedPnl = null;
        hedge.closingStartedAt = null;
        await this._emitUpdated(hedge);
        this.notifier.cancelled(hedge);
        return;
      }

      await this._emitUpdated(hedge);
    } catch (err) {
      await this._setError(hedge, err);
    }
  }

  // ── Reacción en tiempo real a ticks de precio ──────────────────────────────

  /**
   * Llamado desde wsServer en cada tick de allMids.
   * Verifica condiciones de entrada/salida y actúa de inmediato si se cumplen.
   * Fire-and-forget: no bloquea el event loop.
   */
  onPriceUpdate(asset, price) {
    for (const hedge of this.hedges.values()) {
      if (hedge.asset !== asset) continue;
      if (!['entry_pending', 'open_protected'].includes(hedge.status)) continue;

      if (hedge.status === 'entry_pending' && hedge.entryOid) {
        const conditionMet = hedge.direction === 'short'
          ? price <= parseFloat(hedge.entryPrice)   // precio cayó a/bajo entry
          : price >= parseFloat(hedge.entryPrice);  // precio subió a/sobre entry
        if (conditionMet) {
          this._hedgeMutex.runExclusive(hedge.id, () => this._handleEntryTrigger(hedge, price))
            .catch((err) => this._setError(hedge, err));
        }
      }

      if (hedge.status === 'open_protected') {
        const exitBreached = hedge.direction === 'short'
          ? price >= parseFloat(hedge.exitPrice)   // SHORT cierra cuando precio sube a exit
          : price <= parseFloat(hedge.exitPrice);  // LONG cierra cuando precio baja a exit
        if (exitBreached) {
          this._hedgeMutex.runExclusive(hedge.id, () => this._handleExitTrigger(hedge, price))
            .catch((err) => this._setError(hedge, err));
        }
      }
    }
  }

  /**
   * Fuerza la entrada a mercado (IOC) cuando la condición se cumplió
   * pero el stop-market no se ejecutó tras un tiempo prudencial.
   *
   * Con el nuevo esquema stop-market+SL, el stop debería dispararse automáticamente
   * en sub-segundos. Solo intervenimos si después de 15s el hedge sigue en entry_pending
   * (síntoma de que el stop falló o fue rechazado silenciosamente).
   */
  async _handleEntryTrigger(hedge, currentPrice) {
    if (!hedge.entryOid || hedge.status !== 'entry_pending') return;

    await this._reconcileTriggeredEntry(hedge, {
      currentPrice,
      source: 'ws',
    });
  }

  /**
   * Cancela el SL activo y cierra la posición a mercado cuando el precio
   * de salida fue alcanzado pero el SL nativo aún no se disparó.
   */
  async _handleExitTrigger(hedge, currentPrice) {
    if (hedge.status !== 'open_protected') return;

    logger.warn('hedge_exit_trigger_ws', { hedgeId: hedge.id, currentPrice, exitPrice: hedge.exitPrice });

    if (hedge.slOid) {
      await this.hl.cancelOrder(hedge.assetIndex, hedge.slOid).catch((e) =>
        logger.warn('hedge_cancel_sl_failed', { hedgeId: hedge.id, error: e.message })
      );
      hedge.slOid = null;
    }

    hedge.status = 'closing';
    hedge.closingStartedAt = Date.now();
    await this._emitUpdated(hedge);

    const pos = await this.hl.getPosition(hedge.asset).catch((err) => { logger.warn('getPosition failed', { hedgeId: hedge?.id, asset: hedge?.asset, error: err.message }); return null; });
    if (pos && parseFloat(pos.szi) !== 0) {
      await this._closePositionReduceOnly(hedge, pos).catch((e) =>
        logger.error('hedge_ws_exit_close_failed', { hedgeId: hedge.id, error: e.message })
      );
    }
  }
}

// Mezclar métodos extraídos en el prototipo
const { monitorMethods } = require('./hedge-monitor.mixin');
const { cycleMethods } = require('./hedge-cycle.mixin');
Object.assign(HedgeService.prototype, monitorMethods, cycleMethods);

module.exports = HedgeService;
