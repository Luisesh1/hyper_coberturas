/**
 * hedge.service.js
 *
 * Gestiona operaciones de cobertura automatica.
 *
 * Flujo (ciclo continuo):
 *   1. createHedge -> coloca LIMIT SHORT GTC @ entryPrice en Hyperliquid (entryOid)
 *   2. Fill del entryOid (via userEvents WS) -> posicion abierta -> coloca SL nativo @ exitPrice (slOid)
 *   3. Fill del slOid -> ciclo completado -> nueva LIMIT SHORT GTC (ciclo automatico)
 *   4. Monitoreo continuo cada 15s: verifica posicion, actualiza PnL, re-coloca ordenes si faltan
 *
 * Estados del hedge:
 *   entry_pending -> LIMIT GTC colocada, esperando fill
 *   open          -> posicion abierta, SL activo
 *   closing       -> SL en proceso de ejecucion (detectado via fill)
 *   cancelled     -> cancelado por el usuario
 *   error         -> fallo inesperado, requiere intervencion
 */

const EventEmitter = require('events');
const hlService = require('./hyperliquid.service');
const config = require('../config');

const MONITOR_INTERVAL_MS = 15_000;

/**
 * Formatea el tamano de una orden usando floor (no redondeo) para evitar
 * enviar cantidad ligeramente superior a la disponible.
 */
function formatSize(size, szDecimals) {
  const factor = Math.pow(10, szDecimals);
  return (Math.floor(parseFloat(size) * factor) / factor).toFixed(szDecimals);
}

/**
 * Formatea un precio a max 5 cifras significativas (requerido por Hyperliquid).
 */
function formatPrice(price) {
  if (!price || price <= 0) return '0';
  const d = Math.ceil(Math.log10(Math.abs(price)));
  const power = 5 - d;
  const magnitude = Math.pow(10, power);
  const rounded = Math.round(price * magnitude) / magnitude;
  return power > 0 ? rounded.toFixed(power) : rounded.toString();
}

class HedgeService extends EventEmitter {
  constructor() {
    super();
    this.hedges = new Map(); // id -> hedge
    this.nextId = 1;
    this._monitorInterval = null;
    this._startMonitor();
  }

  // ------------------------------------------------------------------
  // CRUD de coberturas
  // ------------------------------------------------------------------

  /**
   * Crea una nueva cobertura y coloca inmediatamente la orden LIMIT SHORT GTC.
   *
   * @param {object} params
   * @param {string} params.asset       - Par de futuros (ej: "BTC")
   * @param {number} params.entryPrice  - Precio de entrada (LIMIT SHORT @ entryPrice)
   * @param {number} params.exitPrice   - Precio de salida (SL trigger @ exitPrice)
   * @param {number} params.size        - Tamano de la posicion (en unidades del activo)
   * @param {number} params.leverage    - Apalancamiento (siempre isolated)
   * @param {string} [params.label]     - Etiqueta descriptiva opcional
   */
  async createHedge({ asset, entryPrice, exitPrice, size, leverage, label }) {
    const entry = parseFloat(entryPrice);
    const exit = parseFloat(exitPrice);
    const lev = parseInt(leverage, 10);
    const sz = parseFloat(size);

    if (isNaN(entry) || entry <= 0) throw new Error('entryPrice invalido');
    if (isNaN(exit) || exit <= 0) throw new Error('exitPrice invalido');
    if (isNaN(sz) || sz <= 0) throw new Error('size invalido');
    if (isNaN(lev) || lev < 1 || lev > 100) throw new Error('leverage debe estar entre 1 y 100');

    const id = this.nextId++;
    const hedge = {
      id,
      asset: asset.toUpperCase(),
      entryPrice: entry,
      exitPrice: exit,
      size: sz,
      leverage: lev,
      label: label || `${asset.toUpperCase()} Cobertura #${id}`,
      marginMode: 'isolated',
      status: 'entry_pending',
      createdAt: Date.now(),
      openedAt: null,
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
    };

    this.hedges.set(id, hedge);
    this.emit('created', hedge);

    // Colocar la orden de entrada en background (no bloquear la respuesta REST)
    this._placeEntryOrder(hedge).catch((err) => {
      hedge.status = 'error';
      hedge.error = err.message;
      console.error(`[Hedge] #${id} error al colocar entry order:`, err.message);
      this.emit('error', hedge, err);
    });

    return hedge;
  }

  /**
   * Cancela una cobertura: cancela ordenes pendientes y cierra posicion si existe.
   */
  async cancelHedge(id) {
    const hedge = this.hedges.get(id);
    if (!hedge) throw new Error(`Cobertura #${id} no encontrada`);
    if (hedge.status === 'cancelled') throw new Error(`La cobertura #${id} ya esta cancelada`);

    const prevStatus = hedge.status;
    hedge.status = 'cancelled';

    try {
      // Cancelar orden de entrada si esta pendiente
      if (hedge.entryOid && prevStatus === 'entry_pending') {
        await hlService.cancelOrder(hedge.assetIndex, hedge.entryOid).catch((err) => {
          console.warn(`[Hedge] #${id} no se pudo cancelar entryOid ${hedge.entryOid}:`, err.message);
        });
      }

      // Cancelar SL si la posicion esta abierta y cerrar posicion
      if (prevStatus === 'open' || prevStatus === 'closing') {
        if (hedge.slOid) {
          await hlService.cancelOrder(hedge.assetIndex, hedge.slOid).catch((err) => {
            console.warn(`[Hedge] #${id} no se pudo cancelar slOid ${hedge.slOid}:`, err.message);
          });
        }

        // Cerrar la posicion con market order si sigue abierta
        const pos = await hlService.getPosition(hedge.asset).catch(() => null);
        if (pos && parseFloat(pos.szi) !== 0) {
          const szi = parseFloat(pos.szi);
          const mids = await hlService.getAllMids();
          const midPrice = parseFloat(mids[hedge.asset]);
          const slippage = 0.002;
          // Para cerrar un SHORT (szi < 0) hay que comprar (isBuy = true)
          const isBuyClose = szi < 0;
          const closePrice = isBuyClose
            ? formatPrice(midPrice * (1 + slippage))
            : formatPrice(midPrice * (1 - slippage));
          const closeSize = formatSize(Math.abs(szi), hedge.szDecimals || 4);

          await hlService.placeOrder({
            assetIndex: hedge.assetIndex,
            isBuy: isBuyClose,
            size: closeSize,
            price: closePrice,
            reduceOnly: true,
            tif: 'Ioc',
          }).catch((err) => {
            console.warn(`[Hedge] #${id} no se pudo cerrar posicion al cancelar:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error(`[Hedge] #${id} error durante cancelacion:`, err.message);
    }

    this.emit('cancelled', hedge);
    console.log(`[Hedge] Cobertura #${id} cancelada`);
    return hedge;
  }

  /** Retorna todas las coberturas como array, ordenadas por id desc. */
  getAll() {
    return [...this.hedges.values()].sort((a, b) => b.id - a.id);
  }

  getById(id) {
    const hedge = this.hedges.get(id);
    if (!hedge) throw new Error(`Cobertura #${id} no encontrada`);
    return hedge;
  }

  // ------------------------------------------------------------------
  // Fill handler (llamado por wsServer cuando llega userEvents)
  // ------------------------------------------------------------------

  /**
   * Procesa un fill event de Hyperliquid.
   * La estructura del fill: { coin, oid, px, sz, side, time, ... }
   */
  onFill(fill) {
    const oid = fill?.oid;
    if (!oid) return;

    for (const hedge of this.hedges.values()) {
      if (hedge.entryOid === oid && hedge.status === 'entry_pending') {
        this._onEntryFill(hedge, fill).catch((err) => {
          hedge.status = 'error';
          hedge.error = err.message;
          console.error(`[Hedge] #${hedge.id} error en _onEntryFill:`, err.message);
          this.emit('error', hedge, err);
        });
        return;
      }

      if (hedge.slOid === oid && (hedge.status === 'open' || hedge.status === 'closing')) {
        this._onSlFill(hedge, fill).catch((err) => {
          hedge.status = 'error';
          hedge.error = err.message;
          console.error(`[Hedge] #${hedge.id} error en _onSlFill:`, err.message);
          this.emit('error', hedge, err);
        });
        return;
      }
    }
  }

  // ------------------------------------------------------------------
  // Internals: ciclo de vida del hedge
  // ------------------------------------------------------------------

  /**
   * Coloca la orden LIMIT SHORT GTC @ entryPrice.
   * Configura apalancamiento isolated antes de colocar.
   */
  async _placeEntryOrder(hedge) {
    console.log(`[Hedge] #${hedge.id} colocando LIMIT SHORT GTC @ ${hedge.entryPrice}...`);

    // Obtener metadata del activo (solo una vez; reusar si ya la tenemos)
    if (!hedge.assetIndex) {
      const meta = await hlService.getAssetMeta(hedge.asset);
      hedge.assetIndex = meta.index;
      hedge.szDecimals = meta.szDecimals;
    }

    // Configurar apalancamiento isolated
    await hlService.updateLeverage(hedge.assetIndex, false, hedge.leverage);

    const sizeFormatted = formatSize(hedge.size, hedge.szDecimals);
    const priceFormatted = formatPrice(hedge.entryPrice);

    const oid = await hlService.placeLimit({
      assetIndex: hedge.assetIndex,
      isBuy: false, // SHORT
      size: sizeFormatted,
      price: priceFormatted,
      reduceOnly: false,
    });

    hedge.entryOid = oid;
    hedge.status = 'entry_pending';
    hedge.error = null;

    console.log(`[Hedge] #${hedge.id} LIMIT SHORT GTC colocada (oid=${oid}) @ ${priceFormatted}`);
    this.emit('updated', hedge);
  }

  /**
   * Llamado cuando el fill del entryOid es detectado.
   * Abre la posicion y coloca el SL nativo.
   */
  async _onEntryFill(hedge, fill) {
    const fillPrice = parseFloat(fill.px);
    console.log(`[Hedge] #${hedge.id} entry fill detectado a $${fillPrice}. Colocando SL @ ${hedge.exitPrice}...`);

    hedge.status = 'open';
    hedge.openedAt = fill.time || Date.now();
    hedge.openPrice = fillPrice;
    hedge.entryOid = null;
    this.emit('opened', hedge);

    // Colocar SL nativo: para cerrar SHORT (isBuy=true) cuando precio sube a exitPrice
    const sizeFormatted = formatSize(hedge.size, hedge.szDecimals);
    const slOid = await hlService.placeSL({
      assetIndex: hedge.assetIndex,
      isBuy: true,  // comprar para cerrar SHORT
      size: sizeFormatted,
      triggerPx: String(hedge.exitPrice),
      isMarket: true,
    });

    hedge.slOid = slOid;
    console.log(`[Hedge] #${hedge.id} SL nativo colocado (oid=${slOid}) @ ${hedge.exitPrice}`);
    this.emit('updated', hedge);
  }

  /**
   * Llamado cuando el fill del slOid es detectado.
   * Registra el ciclo, resetea el hedge, y coloca nueva entry order.
   */
  async _onSlFill(hedge, fill) {
    const closePrice = parseFloat(fill.px);
    console.log(`[Hedge] #${hedge.id} SL ejecutado a $${closePrice}. Registrando ciclo...`);

    hedge.status = 'closing';

    // Registrar ciclo completado
    const cycle = {
      cycleId:    hedge.cycles.length + 1,
      openedAt:   hedge.openedAt,
      openPrice:  hedge.openPrice,
      closedAt:   fill.time || Date.now(),
      closePrice,
    };
    hedge.cycles.push(cycle);
    hedge.cycleCount = hedge.cycles.length;

    // Resetear campos de posicion
    hedge.openedAt      = null;
    hedge.openPrice     = null;
    hedge.closePrice    = null;
    hedge.unrealizedPnl = null;
    hedge.slOid         = null;
    hedge.error         = null;

    this.emit('cycleComplete', hedge, cycle);

    // Ciclo automatico: volver a colocar entry order
    await this._placeEntryOrder(hedge);
  }

  // ------------------------------------------------------------------
  // Monitor continuo (cada 15s)
  // ------------------------------------------------------------------

  _startMonitor() {
    this._monitorInterval = setInterval(() => {
      this._monitorPositions().catch((err) => {
        console.error('[Hedge] Error en monitor de posiciones:', err.message);
      });
    }, MONITOR_INTERVAL_MS);
  }

  async _monitorPositions() {
    const openHedges = [...this.hedges.values()].filter(
      (h) => h.status === 'open'
    );
    if (openHedges.length === 0) return;

    for (const hedge of openHedges) {
      try {
        const pos = await hlService.getPosition(hedge.asset);

        if (!pos || parseFloat(pos.szi) === 0) {
          // La posicion desaparecio sin fill WS detectado (liquidacion o SL ejecutado)
          console.warn(`[Hedge] #${hedge.id} posicion no encontrada en exchange (posible liquidacion o SL ejecutado sin WS)`);

          // Registrar ciclo de emergencia
          const cycle = {
            cycleId:    hedge.cycles.length + 1,
            openedAt:   hedge.openedAt,
            openPrice:  hedge.openPrice,
            closedAt:   Date.now(),
            closePrice: hedge.exitPrice, // aproximado
          };
          hedge.cycles.push(cycle);
          hedge.cycleCount = hedge.cycles.length;
          hedge.openedAt      = null;
          hedge.openPrice     = null;
          hedge.unrealizedPnl = null;
          hedge.slOid         = null;
          hedge.error         = null;

          this.emit('cycleComplete', hedge, cycle);

          // Reiniciar ciclo
          await this._placeEntryOrder(hedge).catch((err) => {
            hedge.status = 'error';
            hedge.error = err.message;
            this.emit('error', hedge, err);
          });
          continue;
        }

        // Actualizar PnL no realizado
        const prevPnl = hedge.unrealizedPnl;
        hedge.unrealizedPnl = parseFloat(pos.unrealizedPnl || 0);

        if (prevPnl !== hedge.unrealizedPnl) {
          this.emit('updated', hedge);
        }

        // Verificar que el SL sigue activo; si no, re-colocarlo
        if (hedge.slOid) {
          const openOrders = await hlService.getOpenOrders(config.wallet.address);
          const slStillActive = openOrders.some((o) => o.oid === hedge.slOid);
          if (!slStillActive) {
            console.warn(`[Hedge] #${hedge.id} SL (oid=${hedge.slOid}) no encontrado en ordenes activas. Re-colocando...`);
            hedge.slOid = null;
            const sizeFormatted = formatSize(hedge.size, hedge.szDecimals);
            const newSlOid = await hlService.placeSL({
              assetIndex: hedge.assetIndex,
              isBuy: true,
              size: sizeFormatted,
              triggerPx: String(hedge.exitPrice),
              isMarket: true,
            });
            hedge.slOid = newSlOid;
            console.log(`[Hedge] #${hedge.id} SL re-colocado (oid=${newSlOid})`);
            this.emit('updated', hedge);
          }
        }
      } catch (err) {
        console.error(`[Hedge] #${hedge.id} error en monitor:`, err.message);
      }
    }
  }
}

module.exports = new HedgeService();
