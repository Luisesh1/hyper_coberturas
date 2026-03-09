/**
 * hedge.service.js
 *
 * Gestiona coberturas automáticas con persistencia en PostgreSQL.
 * Ahora es una clase instanciada por usuario (via hedge.registry.js).
 *
 * Flujo (ciclo continuo):
 *   1. createHedge  → LIMIT SHORT GTC @ entryPrice (entryOid)
 *   2. Fill entryOid (WS userEvents) → posicion abierta → SL nativo @ exitPrice (slOid)
 *   3. Fill slOid → ciclo registrado en BD → nueva LIMIT SHORT GTC
 *   4. Monitor cada 15s: verifica posicion, actualiza PnL, re-coloca SL si falto
 */

const EventEmitter = require('events');
const db = require('../db');

const MONITOR_INTERVAL_MS = 15_000;

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

function rowToHedge(row, cycles = []) {
  return {
    id:            row.id,
    userId:        row.user_id,
    asset:         row.asset,
    entryPrice:    parseFloat(row.entry_price),
    exitPrice:     parseFloat(row.exit_price),
    size:          parseFloat(row.size),
    leverage:      row.leverage,
    label:         row.label,
    marginMode:    row.margin_mode,
    status:        row.status,
    entryOid:      row.entry_oid ? Number(row.entry_oid) : null,
    slOid:         row.sl_oid   ? Number(row.sl_oid)    : null,
    assetIndex:    row.asset_index,
    szDecimals:    row.sz_decimals,
    openPrice:     row.open_price     ? parseFloat(row.open_price)     : null,
    closePrice:    row.close_price    ? parseFloat(row.close_price)    : null,
    unrealizedPnl: row.unrealized_pnl ? parseFloat(row.unrealized_pnl) : null,
    error:         row.error || null,
    cycleCount:    row.cycle_count,
    createdAt:     Number(row.created_at),
    openedAt:      row.opened_at ? Number(row.opened_at) : null,
    closedAt:      row.closed_at ? Number(row.closed_at) : null,
    cycles:        cycles.map((c) => ({
      cycleId:    c.cycle_id,
      openedAt:   c.opened_at  ? Number(c.opened_at)  : null,
      openPrice:  c.open_price  ? parseFloat(c.open_price)  : null,
      closedAt:   c.closed_at  ? Number(c.closed_at)  : null,
      closePrice: c.close_price ? parseFloat(c.close_price) : null,
    })),
  };
}

class HedgeService extends EventEmitter {
  /**
   * @param {number} userId
   * @param {import('./hyperliquid.service')} hlService
   * @param {import('./telegram.service')} tgService
   */
  constructor(userId, hlService, tgService) {
    super();
    this.userId  = userId;
    this.hl      = hlService;
    this.tg      = tgService;
    this.hedges  = new Map(); // id -> hedge
    this._monitorInterval = null;
  }

  // ------------------------------------------------------------------
  // Inicializacion: cargar estado desde DB (filtrado por user_id)
  // ------------------------------------------------------------------

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

  // ------------------------------------------------------------------
  // Persistencia
  // ------------------------------------------------------------------

  async _save(hedge) {
    await db.query(
      `UPDATE hedges SET
         status         = $2,
         entry_oid      = $3,
         sl_oid         = $4,
         asset_index    = $5,
         sz_decimals    = $6,
         open_price     = $7,
         close_price    = $8,
         unrealized_pnl = $9,
         error          = $10,
         cycle_count    = $11,
         opened_at      = $12,
         closed_at      = $13
       WHERE id = $1`,
      [
        hedge.id, hedge.status,
        hedge.entryOid, hedge.slOid,
        hedge.assetIndex, hedge.szDecimals,
        hedge.openPrice, hedge.closePrice,
        hedge.unrealizedPnl, hedge.error,
        hedge.cycleCount, hedge.openedAt, hedge.closedAt,
      ]
    );
  }

  async _saveCycle(hedgeId, cycle) {
    await db.query(
      `INSERT INTO cycles (hedge_id, cycle_id, open_price, close_price, opened_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [hedgeId, cycle.cycleId, cycle.openPrice, cycle.closePrice, cycle.openedAt, cycle.closedAt]
    );
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  async createHedge({ asset, entryPrice, exitPrice, size, leverage, label }) {
    const entry = parseFloat(entryPrice);
    const exit  = parseFloat(exitPrice);
    const lev   = parseInt(leverage, 10);
    const sz    = parseFloat(size);

    if (isNaN(entry) || entry <= 0) throw new Error('entryPrice invalido');
    if (isNaN(exit)  || exit  <= 0) throw new Error('exitPrice invalido');
    if (isNaN(sz)    || sz    <= 0) throw new Error('size invalido');
    if (isNaN(lev)   || lev < 1 || lev > 100) throw new Error('leverage debe estar entre 1 y 100');

    const assetUp    = asset.toUpperCase();
    const hedgeLabel = label || `${assetUp} Cobertura`;

    const { rows } = await db.query(
      `INSERT INTO hedges (user_id, asset, entry_price, exit_price, size, leverage, label, margin_mode, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'isolated', 'entry_pending', $8)
       RETURNING id`,
      [this.userId, assetUp, entry, exit, sz, lev, hedgeLabel, Date.now()]
    );

    const hedge = {
      id:            rows[0].id,
      userId:        this.userId,
      asset:         assetUp,
      entryPrice:    entry,
      exitPrice:     exit,
      size:          sz,
      leverage:      lev,
      label:         hedgeLabel,
      marginMode:    'isolated',
      status:        'entry_pending',
      createdAt:     Date.now(),
      openedAt:      null,
      openPrice:     null,
      closePrice:    null,
      unrealizedPnl: null,
      entryOid:      null,
      slOid:         null,
      assetIndex:    null,
      szDecimals:    null,
      error:         null,
      cycles:        [],
      cycleCount:    0,
    };

    this.hedges.set(hedge.id, hedge);
    this.emit('created', hedge);
    this.tg.notifyHedgeCreated(hedge);

    this._placeEntryOrder(hedge).catch(async (err) => {
      hedge.status = 'error';
      hedge.error  = err.message;
      await this._save(hedge).catch(() => {});
      console.error(`[Hedge] #${hedge.id} error al colocar entry order:`, err.message);
      this.emit('error', hedge, err);
    });

    return hedge;
  }

  async cancelHedge(id) {
    const hedge = this.hedges.get(id);
    if (!hedge) throw new Error(`Cobertura #${id} no encontrada`);
    if (hedge.status === 'cancelled') throw new Error(`La cobertura #${id} ya esta cancelada`);

    const prevStatus = hedge.status;
    hedge.status = 'cancelled';

    try {
      if (hedge.entryOid && prevStatus === 'entry_pending') {
        await this.hl.cancelOrder(hedge.assetIndex, hedge.entryOid).catch((err) => {
          console.warn(`[Hedge] #${id} no se pudo cancelar entryOid:`, err.message);
        });
      }

      if (prevStatus === 'open' || prevStatus === 'closing') {
        if (hedge.slOid) {
          await this.hl.cancelOrder(hedge.assetIndex, hedge.slOid).catch((err) => {
            console.warn(`[Hedge] #${id} no se pudo cancelar slOid:`, err.message);
          });
        }

        const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
        if (pos && parseFloat(pos.szi) !== 0) {
          const szi   = parseFloat(pos.szi);
          const mids  = await this.hl.getAllMids();
          const mid   = parseFloat(mids[hedge.asset]);
          const slip  = 0.002;
          const isBuy = szi < 0;
          const px    = isBuy ? formatPrice(mid * (1 + slip)) : formatPrice(mid * (1 - slip));

          await this.hl.placeOrder({
            assetIndex: hedge.assetIndex,
            isBuy,
            size: formatSize(Math.abs(szi), hedge.szDecimals || 4),
            price: px,
            reduceOnly: true,
            tif: 'Ioc',
          }).catch((err) => {
            console.warn(`[Hedge] #${id} no se pudo cerrar posicion:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error(`[Hedge] #${id} error durante cancelacion:`, err.message);
    }

    await this._save(hedge).catch(() => {});
    this.tg.notifyHedgeCancelled(hedge);
    this.emit('cancelled', hedge);
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

  // ------------------------------------------------------------------
  // Fill handler (llamado desde wsServer)
  // ------------------------------------------------------------------

  onFill(fill) {
    const oid = fill?.oid;
    if (!oid) return;

    for (const hedge of this.hedges.values()) {
      if (hedge.entryOid === oid && hedge.status === 'entry_pending') {
        this._onEntryFill(hedge, fill).catch(async (err) => {
          hedge.status = 'error';
          hedge.error  = err.message;
          await this._save(hedge).catch(() => {});
          this.emit('error', hedge, err);
        });
        return;
      }
      if (hedge.slOid === oid && (hedge.status === 'open' || hedge.status === 'closing')) {
        this._onSlFill(hedge, fill).catch(async (err) => {
          hedge.status = 'error';
          hedge.error  = err.message;
          await this._save(hedge).catch(() => {});
          this.emit('error', hedge, err);
        });
        return;
      }
    }
  }

  // ------------------------------------------------------------------
  // Ciclo de vida
  // ------------------------------------------------------------------

  async _placeEntryOrder(hedge) {
    if (!hedge.assetIndex) {
      const meta       = await this.hl.getAssetMeta(hedge.asset);
      hedge.assetIndex = meta.index;
      hedge.szDecimals = meta.szDecimals;
    }

    await this.hl.updateLeverage(hedge.assetIndex, false, hedge.leverage);

    const oid = await this.hl.placeLimit({
      assetIndex: hedge.assetIndex,
      isBuy:      false,
      size:       formatSize(hedge.size, hedge.szDecimals),
      price:      formatPrice(hedge.entryPrice),
      reduceOnly: false,
    });

    hedge.entryOid = oid;
    hedge.status   = 'entry_pending';
    hedge.error    = null;

    await this._save(hedge).catch(() => {});
    console.log(`[Hedge] #${hedge.id} LIMIT SHORT GTC colocada (oid=${oid}) @ ${hedge.entryPrice}`);
    this.emit('updated', hedge);
  }

  async _onEntryFill(hedge, fill) {
    const fillPrice = parseFloat(fill.px);
    hedge.status    = 'open';
    hedge.openedAt  = fill.time || Date.now();
    hedge.openPrice = fillPrice;
    hedge.entryOid  = null;
    this.emit('opened', hedge);
    this.tg.notifyHedgeOpened(hedge);

    const slOid = await this.hl.placeSL({
      assetIndex: hedge.assetIndex,
      isBuy:      true,
      size:       formatSize(hedge.size, hedge.szDecimals),
      triggerPx:  String(hedge.exitPrice),
      isMarket:   true,
    });

    hedge.slOid = slOid;
    await this._save(hedge).catch(() => {});
    this.emit('updated', hedge);
  }

  async _onSlFill(hedge, fill) {
    const closePrice = parseFloat(fill.px);
    hedge.status     = 'closing';

    const cycle = {
      cycleId:    hedge.cycles.length + 1,
      openedAt:   hedge.openedAt,
      openPrice:  hedge.openPrice,
      closedAt:   fill.time || Date.now(),
      closePrice,
    };
    hedge.cycles.push(cycle);
    hedge.cycleCount    = hedge.cycles.length;
    hedge.closePrice    = closePrice;
    hedge.openedAt      = null;
    hedge.openPrice     = null;
    hedge.unrealizedPnl = null;
    hedge.slOid         = null;
    hedge.error         = null;

    await this._saveCycle(hedge.id, cycle).catch(() => {});
    await this._save(hedge).catch(() => {});
    this.tg.notifyHedgeClosed({ ...hedge, closePrice });
    this.emit('cycleComplete', hedge, cycle);

    await this._placeEntryOrder(hedge);
  }

  // ------------------------------------------------------------------
  // Monitor continuo (cada 15s)
  // ------------------------------------------------------------------

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
    const openHedges = [...this.hedges.values()].filter((h) => h.status === 'open');
    if (openHedges.length === 0) return;

    for (const hedge of openHedges) {
      try {
        const pos = await this.hl.getPosition(hedge.asset);

        if (!pos || parseFloat(pos.szi) === 0) {
          console.warn(`[Hedge] #${hedge.id} posicion no encontrada (liquidacion o SL sin WS)`);
          const cycle = {
            cycleId:    hedge.cycles.length + 1,
            openedAt:   hedge.openedAt,
            openPrice:  hedge.openPrice,
            closedAt:   Date.now(),
            closePrice: hedge.exitPrice,
          };
          hedge.cycles.push(cycle);
          hedge.cycleCount    = hedge.cycles.length;
          hedge.openedAt      = null;
          hedge.openPrice     = null;
          hedge.unrealizedPnl = null;
          hedge.slOid         = null;
          hedge.error         = null;

          await this._saveCycle(hedge.id, cycle).catch(() => {});
          this.emit('cycleComplete', hedge, cycle);

          await this._placeEntryOrder(hedge).catch(async (err) => {
            hedge.status = 'error';
            hedge.error  = err.message;
            await this._save(hedge).catch(() => {});
            this.emit('error', hedge, err);
          });
          continue;
        }

        const prevPnl       = hedge.unrealizedPnl;
        hedge.unrealizedPnl = parseFloat(pos.unrealizedPnl || 0);

        if (prevPnl !== hedge.unrealizedPnl) {
          await this._save(hedge).catch(() => {});
          this.emit('updated', hedge);
        }

        if (hedge.slOid) {
          const openOrders    = await this.hl.getOpenOrders();
          const slStillActive = openOrders.some((o) => o.oid === hedge.slOid);
          if (!slStillActive) {
            console.warn(`[Hedge] #${hedge.id} SL desaparecio. Re-colocando...`);
            hedge.slOid   = null;
            const newSlOid = await this.hl.placeSL({
              assetIndex: hedge.assetIndex,
              isBuy:      true,
              size:       formatSize(hedge.size, hedge.szDecimals),
              triggerPx:  String(hedge.exitPrice),
              isMarket:   true,
            });
            hedge.slOid = newSlOid;
            await this._save(hedge).catch(() => {});
            this.emit('updated', hedge);
          }
        }
      } catch (err) {
        console.error(`[Hedge] #${hedge.id} error en monitor:`, err.message);
      }
    }
  }
}

module.exports = HedgeService;
