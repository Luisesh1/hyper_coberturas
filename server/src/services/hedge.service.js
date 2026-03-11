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
const db = require('../db');

const MONITOR_INTERVAL_MS = 10_000;
const CLOSING_TIMEOUT_MS = 90_000;

function formatSize(size, szDecimals) {
  const factor = Math.pow(10, szDecimals);
  return (Math.floor(parseFloat(size) * factor) / factor).toFixed(szDecimals);
}

function formatPrice(price) {
  if (!price || price <= 0) return '0';
  const d = Math.ceil(Math.log10(Math.abs(price)));
  const power = 5 - d;
  const magnitude = Math.pow(10, power);
  const rounded = Math.round(price * magnitude) / magnitude;
  return power > 0 ? rounded.toFixed(power) : rounded.toString();
}

function normalizeStatus(row) {
  if (row.status === 'open') {
    return row.sl_oid ? 'open_protected' : 'entry_filled_pending_sl';
  }
  return row.status;
}

function rowToHedge(row, cycles = []) {
  return {
    id: row.id,
    userId: row.user_id,
    asset: row.asset,
    direction: row.direction || 'short',
    entryPrice: parseFloat(row.entry_price),
    exitPrice: parseFloat(row.exit_price),
    size: parseFloat(row.size),
    leverage: row.leverage,
    label: row.label,
    marginMode: row.margin_mode,
    status: normalizeStatus(row),
    entryOid: row.entry_oid ? Number(row.entry_oid) : null,
    slOid: row.sl_oid ? Number(row.sl_oid) : null,
    assetIndex: row.asset_index,
    szDecimals: row.sz_decimals,
    openPrice: row.open_price != null ? parseFloat(row.open_price) : null,
    closePrice: row.close_price != null ? parseFloat(row.close_price) : null,
    unrealizedPnl: row.unrealized_pnl != null ? parseFloat(row.unrealized_pnl) : null,
    error: row.error || null,
    cycleCount: row.cycle_count,
    createdAt: Number(row.created_at),
    openedAt: row.opened_at ? Number(row.opened_at) : null,
    closedAt: row.closed_at ? Number(row.closed_at) : null,
    positionKey: row.position_key || null,
    closingStartedAt: row.closing_started_at ? Number(row.closing_started_at) : null,
    slPlacedAt: row.sl_placed_at ? Number(row.sl_placed_at) : null,
    lastFillAt: row.last_fill_at ? Number(row.last_fill_at) : null,
    lastReconciledAt: row.last_reconciled_at ? Number(row.last_reconciled_at) : null,
    entryFillOid: row.entry_fill_oid ? Number(row.entry_fill_oid) : null,
    entryFillTime: row.entry_fill_time ? Number(row.entry_fill_time) : null,
    entryFeePaid: parseFloat(row.entry_fee_paid || 0),
    fundingAccum: parseFloat(row.funding_accum || 0),
    cycles: cycles.map((c) => ({
      cycleId: c.cycle_id,
      openedAt: c.opened_at ? Number(c.opened_at) : null,
      openPrice: c.open_price != null ? parseFloat(c.open_price) : null,
      closedAt: c.closed_at ? Number(c.closed_at) : null,
      closePrice: c.close_price != null ? parseFloat(c.close_price) : null,
      entryFee: parseFloat(c.entry_fee || 0),
      exitFee: parseFloat(c.exit_fee || 0),
      closedPnl: c.closed_pnl != null ? parseFloat(c.closed_pnl) : null,
      fundingPaid: parseFloat(c.funding_paid || 0),
      entryFillOid: c.entry_fill_oid ? Number(c.entry_fill_oid) : null,
      exitFillOid: c.exit_fill_oid ? Number(c.exit_fill_oid) : null,
      entryFillTime: c.entry_fill_time ? Number(c.entry_fill_time) : null,
      exitFillTime: c.exit_fill_time ? Number(c.exit_fill_time) : null,
      entrySlippage: parseFloat(c.entry_slippage || 0),
      exitSlippage:  parseFloat(c.exit_slippage  || 0),
      totalSlippage: parseFloat(c.total_slippage || 0),
      netPnl:        c.net_pnl != null ? parseFloat(c.net_pnl) : null,
    })),
  };
}

class HedgeService extends EventEmitter {
  constructor(userId, hlService, tgService) {
    super();
    this.userId = userId;
    this.hl = hlService;
    this.tg = tgService;
    this.hedges = new Map();
    this._monitorInterval = null;
  }

  async init() {
    const { rows } = await db.query(
      `SELECT h.*,
              COALESCE(json_agg(c ORDER BY c.cycle_id) FILTER (WHERE c.id IS NOT NULL), '[]') AS cycles_json
       FROM hedges h
       LEFT JOIN cycles c ON c.hedge_id = h.id
       WHERE h.user_id = $1
       GROUP BY h.id
       ORDER BY h.id`,
      [this.userId]
    );

    for (const row of rows) {
      const cycles = Array.isArray(row.cycles_json)
        ? row.cycles_json
        : JSON.parse(row.cycles_json || '[]');
      const hedge = rowToHedge(row, cycles);
      this.hedges.set(hedge.id, hedge);
    }

    console.log(`[Hedge] User ${this.userId}: ${this.hedges.size} coberturas restauradas`);
    this._startMonitor();
  }

  async _save(hedge) {
    await db.query(
      `UPDATE hedges SET
         status = $2,
         entry_oid = $3,
         sl_oid = $4,
         asset_index = $5,
         sz_decimals = $6,
         open_price = $7,
         close_price = $8,
         unrealized_pnl = $9,
         error = $10,
         cycle_count = $11,
         opened_at = $12,
         closed_at = $13,
         position_key = $14,
         closing_started_at = $15,
         sl_placed_at = $16,
         last_fill_at = $17,
         last_reconciled_at = $18,
         entry_fill_oid = $19,
         entry_fill_time = $20,
         entry_fee_paid = $21,
         funding_accum = $22
       WHERE id = $1`,
      [
        hedge.id,
        hedge.status,
        hedge.entryOid,
        hedge.slOid,
        hedge.assetIndex,
        hedge.szDecimals,
        hedge.openPrice,
        hedge.closePrice,
        hedge.unrealizedPnl,
        hedge.error,
        hedge.cycleCount,
        hedge.openedAt,
        hedge.closedAt,
        hedge.positionKey,
        hedge.closingStartedAt,
        hedge.slPlacedAt,
        hedge.lastFillAt,
        hedge.lastReconciledAt,
        hedge.entryFillOid,
        hedge.entryFillTime,
        hedge.entryFeePaid ?? 0,
        hedge.fundingAccum ?? 0,
      ]
    );
  }

  async _saveCycle(hedgeId, cycle) {
    await db.query(
      `INSERT INTO cycles (
         hedge_id, cycle_id, open_price, close_price, opened_at, closed_at,
         entry_fee, exit_fee, closed_pnl, funding_paid,
         entry_fill_oid, exit_fill_oid, entry_fill_time, exit_fill_time,
         entry_slippage, exit_slippage, total_slippage, net_pnl
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        hedgeId,
        cycle.cycleId,
        cycle.openPrice,
        cycle.closePrice,
        cycle.openedAt,
        cycle.closedAt,
        cycle.entryFee ?? 0,
        cycle.exitFee ?? 0,
        cycle.closedPnl ?? null,
        cycle.fundingPaid ?? 0,
        cycle.entryFillOid ?? null,
        cycle.exitFillOid ?? null,
        cycle.entryFillTime ?? null,
        cycle.exitFillTime ?? null,
        cycle.entrySlippage ?? 0,
        cycle.exitSlippage ?? 0,
        cycle.totalSlippage ?? 0,
        cycle.netPnl ?? null,
      ]
    );
  }

  _nextPositionKey(hedge) {
    const nextCycle = hedge.cycleCount + 1;
    return `${this.userId}:${hedge.id}:${nextCycle}:${Date.now()}`;
  }

  async _emitUpdated(hedge) {
    hedge.lastReconciledAt = Date.now();
    await this._save(hedge).catch(() => {});
    this.emit('updated', hedge);
  }

  async _setError(hedge, err, { persist = true, emit = true } = {}) {
    hedge.status = 'error';
    hedge.error = err.message;
    hedge.lastReconciledAt = Date.now();
    if (persist) {
      await this._save(hedge).catch(() => {});
    }
    if (emit) {
      this.tg.notifyHedgeError(hedge, err);
      this.emit('error', hedge, err);
    }
  }

  async createHedge({ asset, entryPrice, exitPrice, size, leverage, label, direction = 'short' }) {
    const entry = parseFloat(entryPrice);
    const exit = parseFloat(exitPrice);
    const lev = parseInt(leverage, 10);
    const sz = parseFloat(size);
    const dir = direction === 'long' ? 'long' : 'short';

    if (isNaN(entry) || entry <= 0) throw new Error('entryPrice invalido');
    if (isNaN(exit) || exit <= 0) throw new Error('exitPrice invalido');
    if (isNaN(sz) || sz <= 0) throw new Error('size invalido');
    if (isNaN(lev) || lev < 1 || lev > 100) throw new Error('leverage debe estar entre 1 y 100');
    if (dir === 'short' && exit <= entry) throw new Error('Para SHORT exitPrice debe ser mayor a entryPrice');
    if (dir === 'long' && exit >= entry) throw new Error('Para LONG exitPrice debe ser menor a entryPrice');

    const assetUp = asset.toUpperCase();

    // Regla: solo una cobertura activa por activo
    const TERMINAL = ['cancelled', 'error'];
    const duplicate = [...this.hedges.values()].find(
      (h) => h.asset === assetUp && !TERMINAL.includes(h.status)
    );
    if (duplicate) {
      throw new Error(`Ya existe una cobertura activa para ${assetUp} (#${duplicate.id} — ${duplicate.status}). Cancélala antes de crear una nueva.`);
    }
    const hedgeLabel = label || `${assetUp} Cobertura`;
    const createdAt = Date.now();

    const { rows } = await db.query(
      `INSERT INTO hedges (
         user_id, asset, direction, entry_price, exit_price, size, leverage, label,
         margin_mode, status, created_at, position_key, last_reconciled_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'isolated', 'entry_pending', $9, $10, $9)
       RETURNING id`,
      [this.userId, assetUp, dir, entry, exit, sz, lev, hedgeLabel, createdAt, `${this.userId}:new:${createdAt}`]
    );

    const hedge = {
      id: rows[0].id,
      userId: this.userId,
      asset: assetUp,
      direction: dir,
      entryPrice: entry,
      exitPrice: exit,
      size: sz,
      leverage: lev,
      label: hedgeLabel,
      marginMode: 'isolated',
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
    };

    hedge.positionKey = this._nextPositionKey(hedge);
    this.hedges.set(hedge.id, hedge);
    this.emit('created', hedge);
    this.tg.notifyHedgeCreated(hedge);

    this._placeEntryOrder(hedge).catch((err) => this._setError(hedge, err));
    return hedge;
  }

  async cancelHedge(id) {
    const hedge = this.hedges.get(id);
    if (!hedge) throw new Error(`Cobertura #${id} no encontrada`);
    if (hedge.status === 'cancelled') throw new Error(`La cobertura #${id} ya esta cancelada`);

    hedge.status = 'cancel_pending';
    hedge.cancelStartedAt = Date.now();
    hedge.error = null;
    await this._emitUpdated(hedge);

    await this._reconcileCancelPending(hedge);
    return hedge;
  }

  getAll() {
    return [...this.hedges.values()].sort((a, b) => b.id - a.id);
  }

  getById(id) {
    const hedge = this.hedges.get(id);
    if (!hedge) throw new Error(`Cobertura #${id} no encontrada`);
    return hedge;
  }

  onFill(fill) {
    const oid = Number(fill?.oid);
    if (!oid) return;

    for (const hedge of this.hedges.values()) {
      if (hedge.entryOid === oid && hedge.status === 'entry_pending') {
        this._onEntryFill(hedge, fill).catch((err) => this._setError(hedge, err));
        return;
      }
      if (hedge.slOid === oid && ['open_protected', 'closing', 'entry_filled_pending_sl'].includes(hedge.status)) {
        this._onSlFill(hedge, fill).catch((err) => this._setError(hedge, err));
        return;
      }
    }
  }

  async _placeEntryOrder(hedge) {
    if (['cancel_pending', 'cancelled'].includes(hedge.status)) return;

    if (!hedge.assetIndex || hedge.szDecimals == null) {
      const meta = await this.hl.getAssetMeta(hedge.asset);
      hedge.assetIndex = meta.index;
      hedge.szDecimals = meta.szDecimals;
    }

    hedge.positionKey = this._nextPositionKey(hedge);
    hedge.entryOid = null;
    hedge.slOid = null;
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

    // ── Stop-market de entrada (sin SL encadenado) ──────────────────────────
    // El SL se coloca DESPUÉS de que la entrada se llene, sobre la posición abierta.
    // Flujo: stop disparado → fill detectado → SL asignado a posición → ciclo.
    //
    // SHORT (isBuy=false): SELL STOP dispara cuando precio BAJA a entryPrice
    // LONG  (isBuy=true):  BUY STOP dispara cuando precio SUBE a entryPrice
    const entryOid = await this.hl.placeTriggerEntry({
      assetIndex: hedge.assetIndex,
      isBuy: hedge.direction === 'long',
      size: formatSize(hedge.size, hedge.szDecimals),
      triggerPx: formatPrice(hedge.entryPrice),
    });

    hedge.entryOid      = entryOid;
    hedge.slOid         = null;   // SL se asignará en _onEntryFill
    hedge.slPlacedAt    = null;
    hedge.entryPlacedAt = Date.now();
    console.log(
      `[Hedge] #${hedge.id} ${hedge.direction.toUpperCase()} STOP ENTRY ` +
      `(oid=${entryOid}) @ ${hedge.entryPrice} [isolated]`
    );

    hedge.status = 'entry_pending';
    hedge.error  = null;
    await this._emitUpdated(hedge);
  }

  async _ensureStopLoss(hedge) {
    if (hedge.status === 'cancel_pending' || hedge.status === 'cancelled') {
      return { placed: false, transitioned: false };
    }
    if (!hedge.assetIndex || hedge.szDecimals == null) {
      const meta = await this.hl.getAssetMeta(hedge.asset);
      hedge.assetIndex = meta.index;
      hedge.szDecimals = meta.szDecimals;
    }

    // Verificar que la posición esté realmente abierta antes de asignar SL.
    // placeSL con positionTpsl falla si no hay posición ("Cannot update margin for empty position").
    const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
    if (!pos || parseFloat(pos.szi) === 0) {
      throw new Error(`Posición vacía en HL — no se puede asignar SL todavía`);
    }

    const prevStatus = hedge.status;
    const slOid = await this.hl.placeSL({
      assetIndex: hedge.assetIndex,
      isBuy: hedge.direction !== 'long',
      size: formatSize(hedge.size, hedge.szDecimals),
      triggerPx: String(hedge.exitPrice),
      isMarket: true,
    });

    hedge.slOid = slOid;
    hedge.slPlacedAt = Date.now();
    hedge.status = 'open_protected';
    hedge.error = null;
    await this._emitUpdated(hedge);
    return { placed: true, transitioned: prevStatus !== 'open_protected' };
  }

  async _onEntryFill(hedge, fill) {
    const fillPrice = parseFloat(fill.px);
    hedge.openedAt      = fill.time || Date.now();
    hedge.openPrice     = fillPrice;
    hedge.entryOid      = null;
    hedge.lastFillAt    = hedge.openedAt;
    hedge.entryFillOid  = Number(fill.oid) || hedge.entryFillOid;
    hedge.entryFillTime = hedge.openedAt;
    hedge.entryFeePaid  = parseFloat(fill.fee || 0);
    hedge.fundingAccum  = 0;
    hedge.error         = null;
    hedge.slRetryCount  = 0;

    console.log(`[Hedge] #${hedge.id} entrada llena @ ${fillPrice}. Verificando precio antes de asignar SL...`);

    // ── Verificar si el precio ya cruzó el nivel de salida ──────────────────
    // El movimiento fue tan rápido que la posición se abrió pero ya es tarde para SL.
    // En ese caso cerrar a mercado inmediatamente y reiniciar el ciclo.
    const mids = await this.hl.getAllMids().catch(() => null);
    if (mids) {
      const currentMid = parseFloat(mids[hedge.asset]);
      const exitBreached = hedge.direction === 'short'
        ? currentMid >= parseFloat(hedge.exitPrice)
        : currentMid <= parseFloat(hedge.exitPrice);

      if (exitBreached) {
        console.warn(
          `[Hedge] #${hedge.id} Precio actual (${currentMid}) ya cruzó exit (${hedge.exitPrice}) ` +
          `tras el fill. Cerrando posición a mercado y reiniciando ciclo.`
        );
        // Notificar apertura antes de cerrar de emergencia
        this.tg.notifyHedgeOpened(hedge);
        this.emit('opened', hedge);
        hedge.status = 'closing';
        hedge.closingStartedAt = Date.now();
        await this._emitUpdated(hedge);

        const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
        if (pos && parseFloat(pos.szi) !== 0) {
          await this._closePositionReduceOnly(hedge, pos).catch((e) =>
            console.error(`[Hedge] #${hedge.id} Error cierre emergencia post-fill: ${e.message}`)
          );
        } else {
          // Posición ya cerrada (muy raro), reiniciar directamente
          await this._placeEntryOrder(hedge).catch((e) =>
            console.error(`[Hedge] #${hedge.id} Error reentrada post-fill: ${e.message}`)
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
        this.emit('opened', hedge);
        this.tg.notifyHedgeOpened(hedge);
      }
    } catch (err) {
      hedge.error = `SL pendiente: ${err.message}`;
      await this._emitUpdated(hedge);
      this.emit('protection_missing', hedge);
      console.warn(`[Hedge] #${hedge.id} SL no colocado tras fill: ${err.message}`);
    }
  }

  async _resetAfterCycle(hedge, closePrice, closeTime) {
    hedge.cycleCount = hedge.cycles.length;
    hedge.closePrice = closePrice;
    hedge.closedAt = closeTime;
    hedge.openedAt = null;
    hedge.openPrice = null;
    hedge.unrealizedPnl = null;
    hedge.slOid = null;
    hedge.entryOid = null;
    hedge.error = null;
    hedge.slPlacedAt = null;
    hedge.closingStartedAt = null;
    hedge.entryFillOid = null;
    hedge.entryFillTime = null;
    hedge.entryFeePaid = 0;
    hedge.fundingAccum = 0;
    hedge.slRetryCount = 0;
    hedge.cancelStartedAt = null;
    hedge.entryPlacedAt = null;
    hedge._priceActionInProgress = false;
  }

  async _finalizeCycle(hedge, cycle) {
    hedge.cycles.push(cycle);
    await this._saveCycle(hedge.id, cycle).catch(() => {});
    await this._resetAfterCycle(hedge, cycle.closePrice ?? null, cycle.closedAt);
    await this._emitUpdated(hedge);
    this.tg.notifyHedgeClosed({
      ...hedge,
      direction: hedge.direction,
      openPrice: cycle.openPrice,
      closePrice: cycle.closePrice,
      size: hedge.size,
    });
    this.emit('cycleComplete', hedge, cycle);
    await this._placeEntryOrder(hedge);
  }

  async _onSlFill(hedge, fill) {
    const closeTime = fill.time || Date.now();
    hedge.status = 'closing';
    hedge.closingStartedAt = Date.now();
    hedge.lastFillAt = closeTime;
    await this._emitUpdated(hedge);

    const closedPnl = fill.closedPnl != null ? parseFloat(fill.closedPnl) : null;
    const entryFee  = hedge.entryFeePaid ?? 0;
    const exitFee   = parseFloat(fill.fee ?? 0);
    const funding   = hedge.fundingAccum ?? 0;

    // Slippage: diferencia entre precio esperado (configurado) y precio real del fill
    const entrySlippage = hedge.openPrice != null
      ? Math.abs(hedge.openPrice - hedge.entryPrice)
      : 0;
    const exitSlippage  = Math.abs(parseFloat(fill.px) - hedge.exitPrice);
    const totalSlippage = (entrySlippage + exitSlippage) * hedge.size;

    // netPnl = PnL realizado del exchange - fees + funding recibido
    const netPnl = closedPnl != null
      ? closedPnl - entryFee - exitFee + funding
      : null;

    const cycle = {
      cycleId: hedge.cycles.length + 1,
      openedAt: hedge.openedAt,
      openPrice: hedge.openPrice,
      closedAt: closeTime,
      closePrice: parseFloat(fill.px),
      entryFee,
      exitFee,
      closedPnl,
      fundingPaid: funding,
      entryFillOid: hedge.entryFillOid ?? null,
      exitFillOid: Number(fill.oid) || hedge.slOid || null,
      entryFillTime: hedge.entryFillTime ?? hedge.openedAt ?? null,
      exitFillTime: closeTime,
      entrySlippage,
      exitSlippage,
      totalSlippage,
      netPnl,
    };

    await this._finalizeCycle(hedge, cycle);
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
    const [pos, fills] = await Promise.all([
      this.hl.getPosition(hedge.asset).catch(() => null),
      this._getRecentFills().catch(() => []),
    ]);

    const fill = fills.find((item) => Number(item.oid) === Number(hedge.entryOid));
    if (fill) {
      await this._onEntryFill(hedge, fill);
      this.emit('reconciled', hedge);
      return true;
    }

    if (pos && parseFloat(pos.szi) !== 0) {
      await this._onEntryFill(hedge, {
        oid: hedge.entryOid,
        px: pos.entryPx || hedge.entryPrice,
        time: Date.now(),
        fee: 0,
      });
      this.emit('reconciled', hedge);
      return true;
    }

    return false;
  }

  async _recoverExitFromExchange(hedge) {
    const fills = await this._getRecentFills().catch(() => []);
    const fill = fills.find((item) => Number(item.oid) === Number(hedge.slOid));
    if (fill) {
      await this._onSlFill(hedge, fill);
      this.emit('reconciled', hedge);
      return true;
    }
    return false;
  }

  async _completeCycleWithoutExitFill(hedge) {
    // Intentar obtener precio de cierre aproximado desde el mercado actual
    const mids = await this.hl.getAllMids().catch(() => null);
    const approxClosePrice = mids ? parseFloat(mids[hedge.asset]) : null;

    // Calcular PnL aproximado si tenemos precios
    let approxPnl = null;
    if (approxClosePrice && hedge.openPrice) {
      approxPnl = hedge.direction === 'short'
        ? (hedge.openPrice - approxClosePrice) * hedge.size
        : (approxClosePrice - hedge.openPrice) * hedge.size;
    }

    const cycle = {
      cycleId: hedge.cycles.length + 1,
      openedAt: hedge.openedAt,
      openPrice: hedge.openPrice,
      closedAt: Date.now(),
      closePrice: approxClosePrice,          // precio aproximado (sin fill real)
      entryFee: hedge.entryFeePaid ?? 0,
      exitFee: 0,
      closedPnl: approxPnl,                 // PnL aproximado
      fundingPaid: hedge.fundingAccum ?? 0,
      entryFillOid: hedge.entryFillOid ?? null,
      exitFillOid: hedge.slOid ?? null,
      entryFillTime: hedge.entryFillTime ?? hedge.openedAt ?? null,
      exitFillTime: null,
      entrySlippage: 0,
      exitSlippage: 0,
      totalSlippage: 0,
      netPnl: approxPnl != null
        ? approxPnl - (hedge.entryFeePaid ?? 0) + (hedge.fundingAccum ?? 0)
        : null,
    };
    console.warn(`[Hedge] #${hedge.id} ciclo completado sin fill de salida. Precio aprox: ${approxClosePrice}`);
    await this._finalizeCycle(hedge, cycle);
  }

  async _reconcileCancelPending(hedge) {
    // Timeout de cancelación: si lleva más de 5 minutos sin poder cancelar, forzar error
    const CANCEL_TIMEOUT_MS = 5 * 60_000;
    if (hedge.cancelStartedAt && Date.now() - hedge.cancelStartedAt > CANCEL_TIMEOUT_MS) {
      hedge.status = 'error';
      hedge.error = 'Cancelación bloqueada por más de 5 min. Intervención manual requerida.';
      await this._emitUpdated(hedge);
      console.error(`[Hedge] #${hedge.id} cancel_pending timeout. Cambiando a error.`);
      return;
    }

    try {
      const [openOrders, pos] = await Promise.all([
        this.hl.getOpenOrders().catch(() => []),
        this.hl.getPosition(hedge.asset).catch(() => null),
      ]);
      const openOidSet = new Set((openOrders || []).map((order) => Number(order.oid)));

      if (hedge.entryOid && openOidSet.has(Number(hedge.entryOid))) {
        await this.hl.cancelOrder(hedge.assetIndex, hedge.entryOid).catch((err) => {
          console.warn(`[Hedge] #${hedge.id} no se pudo cancelar entryOid:`, err.message);
        });
      }

      if (hedge.slOid && openOidSet.has(Number(hedge.slOid))) {
        await this.hl.cancelOrder(hedge.assetIndex, hedge.slOid).catch((err) => {
          console.warn(`[Hedge] #${hedge.id} no se pudo cancelar slOid:`, err.message);
        });
      }

      if (pos && parseFloat(pos.szi) !== 0) {
        await this._closePositionReduceOnly(hedge, pos).catch((err) => {
          console.warn(`[Hedge] #${hedge.id} no se pudo cerrar posicion en cancel_pending:`, err.message);
        });
        hedge.closingStartedAt = hedge.closingStartedAt || Date.now();
      }

      const [openOrdersAfter, posAfter] = await Promise.all([
        this.hl.getOpenOrders().catch(() => []),
        this.hl.getPosition(hedge.asset).catch(() => null),
      ]);
      const openAfterSet = new Set((openOrdersAfter || []).map((order) => Number(order.oid)));
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
        this.tg.notifyHedgeCancelled(hedge);
        this.emit('cancelled', hedge);
        return;
      }

      await this._emitUpdated(hedge);
    } catch (err) {
      await this._setError(hedge, err);
    }
  }

  _startMonitor() {
    this._monitorInterval = setInterval(() => {
      this._monitorPositions().catch((err) => {
        console.error(`[Hedge] User ${this.userId} monitor error:`, err.message);
      });
    }, MONITOR_INTERVAL_MS);
  }

  stopMonitor() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
  }

  async _monitorPositions() {
    const activeHedges = [...this.hedges.values()].filter((hedge) =>
      [
        'entry_pending',
        'entry_filled_pending_sl',
        'open_protected',
        'open',
        'closing',
        'cancel_pending',
      ].includes(hedge.status)
    );
    if (activeHedges.length === 0) return;

    let openOidSet = new Set();
    let openOrdersAvailable = true;
    try {
      const openOrders = await this.hl.getOpenOrders();
      openOidSet = new Set((openOrders || []).map((order) => Number(order.oid)));
    } catch (err) {
      // No abortar el monitor; continuar en modo degradado (sin info de órdenes abiertas)
      // Las acciones que dependan de openOidSet serán conservadoras (no cancelarán ni re-colocarán)
      console.warn(`[Hedge] User ${this.userId} openOrders no disponible: ${err.message}. Monitor en modo degradado.`);
      openOrdersAvailable = false;
    }

    for (const hedge of activeHedges) {
      try {
        hedge.lastReconciledAt = Date.now();

        if (hedge.status === 'cancel_pending') {
          await this._reconcileCancelPending(hedge);
          continue;
        }

        if (hedge.status === 'entry_pending') {
          if (!hedge.entryOid) {
            await this._placeEntryOrder(hedge);
            continue;
          }

          if (!openOidSet.has(Number(hedge.entryOid))) {
            const recovered = await this._recoverEntryFromExchange(hedge);
            if (!recovered) {
              console.warn(`[Hedge] #${hedge.id} entryOid desapareció sin fill. Re-colocando GTC...`);
              hedge.entryOid = null;
              await this._placeEntryOrder(hedge);
            }
          } else {
            // GTC sigue abierta — verificar si la condición de entrada ya fue alcanzada
            const midsEntry = await this.hl.getAllMids().catch(() => null);
            const midEntry = midsEntry ? parseFloat(midsEntry[hedge.asset]) : null;
            if (midEntry) {
              const entryConditionMet = hedge.direction === 'short'
                ? midEntry <= parseFloat(hedge.entryPrice)   // SHORT: precio cayó a/bajo entry
                : midEntry >= parseFloat(hedge.entryPrice);  // LONG: precio subió a/sobre entry

              if (entryConditionMet) {
                console.warn(
                  `[Hedge] #${hedge.id} condición de entrada alcanzada ` +
                  `(precio=${midEntry}, entry=${hedge.entryPrice}) pero GTC sin ejecutar. ` +
                  `Forzando entrada a mercado...`
                );

                // Cancelar GTC pendiente
                await this.hl.cancelOrder(hedge.asset, hedge.entryOid).catch((e) =>
                  console.warn(`[Hedge] #${hedge.id} No se pudo cancelar GTC entry: ${e.message}`)
                );
                hedge.entryOid = null;

                // Si el nivel de salida ya también está breacheado, pausar
                const exitAlreadyBreached = hedge.direction === 'short'
                  ? midEntry >= parseFloat(hedge.exitPrice)
                  : midEntry <= parseFloat(hedge.exitPrice);
                if (exitAlreadyBreached) {
                  hedge.status = 'error';
                  hedge.error = `Precio (${midEntry}) ya cruzó nivel de salida (${hedge.exitPrice}). Cobertura pausada.`;
                  await this._emitUpdated(hedge);
                  continue;
                }

                // Forzar entrada IOC al precio de mercado con slippage mínimo
                const slip = 0.002;
                const isBuy = hedge.direction === 'long';
                const forcePrice = isBuy
                  ? formatPrice(midEntry * (1 + slip))
                  : formatPrice(midEntry * (1 - slip));

                try {
                  if (!hedge.assetIndex || hedge.szDecimals == null) {
                    const meta = await this.hl.getAssetMeta(hedge.asset);
                    hedge.assetIndex = meta.index;
                    hedge.szDecimals = meta.szDecimals;
                  }
                  const { oid } = await this.hl.placeOrder({
                    assetIndex: hedge.assetIndex,
                    isBuy,
                    size: formatSize(hedge.size, hedge.szDecimals),
                    price: forcePrice,
                    reduceOnly: false,
                    tif: 'Ioc',
                  });
                  // Guardar oid para que el siguiente ciclo lo recupere via fills
                  hedge.entryOid = oid;
                  await this._save(hedge).catch(() => {});
                  console.log(`[Hedge] #${hedge.id} entrada forzada IOC enviada (oid=${oid})`);
                } catch (err) {
                  console.error(`[Hedge] #${hedge.id} Error al forzar entrada: ${err.message}`);
                  hedge.error = `Error entrada forzada: ${err.message}`;
                  await this._emitUpdated(hedge);
                }
              }
            }
          }
          continue;
        }

        if (hedge.status === 'entry_filled_pending_sl') {
          const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
          if (!pos || parseFloat(pos.szi) === 0) {
            const recovered = await this._recoverExitFromExchange(hedge);
            if (!recovered) {
              await this._completeCycleWithoutExitFill(hedge);
            }
            continue;
          }

          if (hedge.slOid && openOidSet.has(Number(hedge.slOid))) {
            hedge.status = 'open_protected';
            await this._emitUpdated(hedge);
            this.emit('opened', hedge);
            this.tg.notifyHedgeOpened(hedge);
            continue;
          }

          // Si el precio ya cruzó el nivel de salida, cerrar a mercado en lugar de
          // intentar colocar un SL que el exchange rechazaría por precio inválido.
          const mids = await this.hl.getAllMids().catch(() => null);
          const currentPrice = mids ? parseFloat(mids[hedge.asset]) : null;
          const exitBreached = currentPrice && (
            hedge.direction === 'short'
              ? currentPrice >= hedge.exitPrice
              : currentPrice <= hedge.exitPrice
          );
          if (exitBreached) {
            console.warn(`[Hedge] #${hedge.id} precio (${currentPrice}) ya cruzó SL (${hedge.exitPrice}). Cerrando a mercado...`);
            hedge.status = 'closing';
            hedge.closingStartedAt = Date.now();
            await this._emitUpdated(hedge);
            await this._closePositionReduceOnly(hedge, pos).catch((err) => {
              console.warn(`[Hedge] #${hedge.id} cierre forzado falló:`, err.message);
            });
            continue;
          }

          // Límite de reintentos de SL: máximo 8 intentos (≈80s) antes de error
          const MAX_SL_RETRIES = 8;
          hedge.slRetryCount = (hedge.slRetryCount || 0) + 1;
          if (hedge.slRetryCount > MAX_SL_RETRIES) {
            hedge.status = 'error';
            hedge.error = `SL falló ${MAX_SL_RETRIES} veces seguidas. Posición desprotegida — intervención manual requerida.`;
            await this._emitUpdated(hedge);
            this.emit('protection_missing', hedge);
            console.error(`[Hedge] #${hedge.id} SL no colocado tras ${MAX_SL_RETRIES} intentos. Pausando.`);
            continue;
          }

          try {
            const { transitioned } = await this._ensureStopLoss(hedge);
            if (transitioned) {
              hedge.slRetryCount = 0;
              this.emit('opened', hedge);
              this.tg.notifyHedgeOpened(hedge);
            }
          } catch (err) {
            hedge.error = `SL pendiente (intento ${hedge.slRetryCount}/${MAX_SL_RETRIES}): ${err.message}`;
            await this._emitUpdated(hedge);
            this.emit('protection_missing', hedge);
          }
          continue;
        }

        if (hedge.status === 'closing') {
          const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
          if (!pos || parseFloat(pos.szi) === 0) {
            const recovered = await this._recoverExitFromExchange(hedge);
            if (!recovered) {
              await this._completeCycleWithoutExitFill(hedge);
            }
            continue;
          }

          if (hedge.closingStartedAt && Date.now() - hedge.closingStartedAt > CLOSING_TIMEOUT_MS) {
            await this._closePositionReduceOnly(hedge, pos).catch((err) => {
              console.warn(`[Hedge] #${hedge.id} rescate de cierre falló:`, err.message);
            });
          }
          await this._save(hedge).catch(() => {});
          continue;
        }

        if (hedge.status === 'open') {
          hedge.status = hedge.slOid ? 'open_protected' : 'entry_filled_pending_sl';
        }

        if (hedge.status === 'open_protected') {
          const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
          if (!pos || parseFloat(pos.szi) === 0) {
            const recovered = await this._recoverExitFromExchange(hedge);
            if (!recovered) {
              await this._completeCycleWithoutExitFill(hedge);
            }
            continue;
          }

          const prevPnl = hedge.unrealizedPnl;
          hedge.unrealizedPnl = parseFloat(pos.unrealizedPnl || 0);
          if (pos.cumFunding?.sinceOpen !== undefined) {
            hedge.fundingAccum = parseFloat(pos.cumFunding.sinceOpen || 0);
          }

          if (prevPnl !== hedge.unrealizedPnl) {
            await this._emitUpdated(hedge);
          } else {
            await this._save(hedge).catch(() => {});
          }

          // ── Validación en tiempo real: ¿ya cruzó el precio de salida? ────
          const midsRT = await this.hl.getAllMids().catch(() => null);
          const currentPriceRT = midsRT ? parseFloat(midsRT[hedge.asset]) : null;
          if (currentPriceRT && hedge.exitPrice) {
            const exitBreachedRT = hedge.direction === 'short'
              ? currentPriceRT >= parseFloat(hedge.exitPrice)
              : currentPriceRT <= parseFloat(hedge.exitPrice);

            if (exitBreachedRT) {
              console.warn(`[Hedge] #${hedge.id} precio actual (${currentPriceRT}) ya cruzó nivel de salida (${hedge.exitPrice}). Forzando cierre a mercado...`);

              // Cancelar SL pendiente antes de cerrar
              if (hedge.slOid && openOidSet.has(Number(hedge.slOid))) {
                console.log(`[Hedge] #${hedge.id} Cancelando SL #${hedge.slOid} antes del cierre forzado...`);
                await this.hl.cancelOrder(hedge.asset, hedge.slOid).catch((e) =>
                  console.warn(`[Hedge] #${hedge.id} No se pudo cancelar SL: ${e.message}`)
                );
                hedge.slOid = null;
              }

              hedge.status = 'closing';
              hedge.closingStartedAt = Date.now();
              await this._emitUpdated(hedge);
              await this._closePositionReduceOnly(hedge, pos).catch((e) =>
                console.error(`[Hedge] #${hedge.id} Error al cerrar a mercado: ${e.message}`)
              );
              continue;
            }
          }
          // ─────────────────────────────────────────────────────────────────

          if (!hedge.slOid || !openOidSet.has(Number(hedge.slOid))) {
            const recovered = await this._recoverExitFromExchange(hedge);
            if (!recovered) {
              console.warn(`[Hedge] #${hedge.id} SL desapareció. Re-colocando...`);
              hedge.slOid = null;
              try {
                await this._ensureStopLoss(hedge);
              } catch (err) {
                hedge.status = 'entry_filled_pending_sl';
                hedge.error = `SL pendiente: ${err.message}`;
                await this._emitUpdated(hedge);
                this.emit('protection_missing', hedge);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[Hedge] #${hedge.id} error en monitor:`, err.message);
      }
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
      if (hedge._priceActionInProgress) continue;

      if (hedge.status === 'entry_pending' && hedge.entryOid) {
        const conditionMet = hedge.direction === 'short'
          ? price <= parseFloat(hedge.entryPrice)   // precio cayó a/bajo entry
          : price >= parseFloat(hedge.entryPrice);  // precio subió a/sobre entry
        if (conditionMet) {
          hedge._priceActionInProgress = true;
          this._handleEntryTrigger(hedge, price).finally(() => {
            hedge._priceActionInProgress = false;
          });
        }
      }

      if (hedge.status === 'open_protected') {
        const exitBreached = hedge.direction === 'short'
          ? price >= parseFloat(hedge.exitPrice)   // SHORT cierra cuando precio sube a exit
          : price <= parseFloat(hedge.exitPrice);  // LONG cierra cuando precio baja a exit
        if (exitBreached) {
          hedge._priceActionInProgress = true;
          this._handleExitTrigger(hedge, price).finally(() => {
            hedge._priceActionInProgress = false;
          });
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

    // Guarda de tiempo: dar 15s al stop-market para que se dispare solo
    const STOP_GRACE_MS = 15_000;
    if (hedge.entryPlacedAt && Date.now() - hedge.entryPlacedAt < STOP_GRACE_MS) return;

    // Verificar que el nivel de salida no esté ya breacheado
    const exitBreached = hedge.direction === 'short'
      ? currentPrice >= parseFloat(hedge.exitPrice)
      : currentPrice <= parseFloat(hedge.exitPrice);
    if (exitBreached) {
      hedge.status = 'error';
      hedge.error = `Precio (${currentPrice}) cruzó nivel de salida (${hedge.exitPrice}). Pausada.`;
      await this._emitUpdated(hedge);
      return;
    }

    console.warn(
      `[Hedge] #${hedge.id} [WS] stop-market no se disparó en ${STOP_GRACE_MS / 1000}s ` +
      `(precio=${currentPrice} vs entry=${hedge.entryPrice}). Cancelando stop → apertura a mercado...`
    );

    // Cancelar el stop-market de entrada pendiente
    await this.hl.cancelOrder(hedge.assetIndex, hedge.entryOid).catch((e) =>
      console.warn(`[Hedge] #${hedge.id} No se pudo cancelar entry stop: ${e.message}`)
    );
    hedge.entryOid   = null;
    hedge.slOid      = null;
    hedge.slPlacedAt = null;

    const slip = 0.002;
    const isBuy = hedge.direction === 'long';
    try {
      if (!hedge.assetIndex || hedge.szDecimals == null) {
        const meta = await this.hl.getAssetMeta(hedge.asset);
        hedge.assetIndex = meta.index;
        hedge.szDecimals = meta.szDecimals;
      }
      const { oid } = await this.hl.placeOrder({
        assetIndex: hedge.assetIndex,
        isBuy,
        size: formatSize(hedge.size, hedge.szDecimals),
        price: formatPrice(currentPrice * (isBuy ? 1 + slip : 1 - slip)),
        reduceOnly: false,
        tif: 'Ioc',
      });
      hedge.entryOid = oid;
      hedge.entryPlacedAt = Date.now();
      await this._save(hedge).catch(() => {});
      console.log(`[Hedge] #${hedge.id} IOC forzado enviado (oid=${oid})`);
    } catch (err) {
      console.error(`[Hedge] #${hedge.id} Error al forzar entrada IOC: ${err.message}`);
      hedge.error = `Error entrada forzada: ${err.message}`;
      await this._emitUpdated(hedge);
    }
  }

  /**
   * Cancela el SL activo y cierra la posición a mercado cuando el precio
   * de salida fue alcanzado pero el SL nativo aún no se disparó.
   */
  async _handleExitTrigger(hedge, currentPrice) {
    if (hedge.status !== 'open_protected') return;

    console.warn(
      `[Hedge] #${hedge.id} [WS] nivel de salida alcanzado ` +
      `(precio=${currentPrice}, exit=${hedge.exitPrice}). Cancelando SL + cierre market...`
    );

    if (hedge.slOid) {
      await this.hl.cancelOrder(hedge.assetIndex, hedge.slOid).catch((e) =>
        console.warn(`[Hedge] #${hedge.id} No se pudo cancelar SL: ${e.message}`)
      );
      hedge.slOid = null;
    }

    hedge.status = 'closing';
    hedge.closingStartedAt = Date.now();
    await this._emitUpdated(hedge);

    const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
    if (pos && parseFloat(pos.szi) !== 0) {
      await this._closePositionReduceOnly(hedge, pos).catch((e) =>
        console.error(`[Hedge] #${hedge.id} Error en cierre WS exit trigger: ${e.message}`)
      );
    }
  }
}

module.exports = HedgeService;
