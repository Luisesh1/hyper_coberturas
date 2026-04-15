/**
 * hyperliquid.service.js
 *
 * Capa base de comunicacion con la API oficial de Hyperliquid.
 * Documentacion: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 *
 * La API de Hyperliquid tiene dos endpoints principales:
 *   - /info  -> consultas de datos (precios, posiciones, ordenes)
 *   - /exchange -> acciones de trading (abrir/cerrar ordenes)
 *
 * Las acciones de trading requieren firma EIP-712 con la clave privada de la wallet.
 */

const httpClient = require('../shared/platform/http/http-client');
const { ethers } = require('ethers');
const { encode: msgpackEncode } = require('@msgpack/msgpack');
const config = require('../config');
const { numericEqual } = require('../utils/format');
const logger = require('./logger.service');
const hlWeightBudget = require('./hl-weight-budget.service');
const {
  computeBackoffMs,
  isHyperliquidRetryableError,
} = require('./external-service-helpers');

const INFO_URL = `${config.hyperliquid.apiUrl}/info`;
const EXCHANGE_URL = `${config.hyperliquid.apiUrl}/exchange`;

// Dominio EIP-712 que usa Hyperliquid para firmar acciones
const EIP712_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

// Tipos EIP-712 para el agente phantom que envuelve cada accion
const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

/**
 * Convierte un número a la representación de cadena que usa Hyperliquid para
 * el cálculo del hash de acción (equivalente a float_to_wire del SDK Python).
 * Elimina ceros finales y el punto decimal innecesario.
 *   68968.201080 → "68968.20108"
 *   68136.000000 → "68136"
 *   0.00215      → "0.00215"
 */
function floatToWire(x) {
  const n = parseFloat(x);
  const rounded = Math.round(n * 1e8) / 1e8;
  if (rounded === Math.floor(rounded)) return String(Math.floor(rounded));
  return rounded.toFixed(8).replace(/0+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HyperliquidService {
  /**
   * @param {{ privateKey: string, address: string }} walletConfig
   */
  constructor({ privateKey, address } = {}) {
    this.wallet = null;
    this.signerAddress = null;
    this._lastNonce = 0;
    this.accountAddress = address ? ethers.getAddress(address) : null;
    this.address = this.accountAddress;
    if (privateKey) {
      try {
        this.wallet = new ethers.Wallet(privateKey);
        this.signerAddress = this.wallet.address;
        // `address` es la cuenta a consultar en HL. La firma siempre sale de la
        // private key guardada en DB; si no hay cuenta explícita, usar la misma.
        if (!this.address) this.address = this.signerAddress;
      } catch (err) {
        logger.error('hl_wallet_init_failed', { error: err.message });
      }
    }
  }

  // ------------------------------------------------------------------
  // Helpers internos
  // ------------------------------------------------------------------

  /**
   * POST a HL con:
   *  - Registro de weight global (observabilidad, ver hl-weight-budget)
   *  - Manejo de 429 + Retry-After con exponential backoff (max 3 intentos)
   * Los errores de aplicacion (status "err") NO se reintentan.
   */
  async _post(url, body, { endpoint = null, maxRetries } = {}) {
    // Registra weight antes del envio; si 429, cuenta igual (es el costo real).
    if (endpoint) hlWeightBudget.record(endpoint);

    const isInfoRequest = url === INFO_URL;
    const safeMaxRetries = Number.isFinite(maxRetries)
      ? maxRetries
      : (isInfoRequest ? Math.max(1, Number(config.hyperliquid?.infoRetryMaxAttempts) || 3) : 0);

    let attempt = 0;
    let lastErr = null;

    while (attempt <= safeMaxRetries) {
      try {
        const response = await httpClient.post(url, body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        });
        const data = response.data;

        // Hyperliquid devuelve errores de aplicacion con HTTP 200 y status "err"
        if (data?.status === 'err') {
          throw new Error(data.response || 'Error en Hyperliquid API');
        }
        return data;
      } catch (err) {
        lastErr = err;
        const retryable = isInfoRequest && isHyperliquidRetryableError(err);

        if (retryable && attempt < safeMaxRetries) {
          const retryAfterHeader = err.response?.headers?.['retry-after'];
          const retryAfterMs = Number(retryAfterHeader) > 0
            ? Number(retryAfterHeader) * 1000
            : computeBackoffMs(attempt, {
              baseMs: Number(config.hyperliquid?.infoRetryBaseMs) || 350,
              capMs: 10_000,
              jitterMs: 250,
            });
          logger.warn('hl_retry_scheduled', {
            endpoint,
            requestType: body?.type || null,
            attempt: attempt + 1,
            retryAfterMs,
            budget: hlWeightBudget.getSnapshot(),
            error: err.message,
          });
          await sleep(retryAfterMs);
          attempt += 1;
          continue;
        }

        // Errores propios (no-response) o error aplicativo: NO reintentar.
        if (err.message && !err.response) throw err;

        // Otros errores HTTP: devolver mensaje enriquecido del servidor.
        const message = err.response?.data?.error || err.response?.data || err.message;
        throw new Error(`[HL API] ${message}`);
      }
    }

    // Se agotaron los reintentos.
    const message = lastErr?.response?.data?.error
      || lastErr?.response?.data
      || lastErr?.message
      || 'rate_limited';
    const finalErr = new Error(`[HL API] ${message}`);
    finalErr.rateLimited = true;
    throw finalErr;
  }

  /**
   * Firma una accion de trading usando EIP-712.
   * Hyperliquid requiere:
   *   1. Hash de la accion usando msgpack + nonce (8 bytes big-endian) + vault flag
   *   2. Firma del "phantom agent" con ese connectionId via EIP-712
   *
   * Referencia: Hyperliquid TypeScript/Python SDK oficial
   */
  async _signAction(action, nonce, vaultAddress = null) {
    if (!this.wallet) {
      throw new Error(
        'Wallet no configurada. Verifica PRIVATE_KEY en el archivo .env'
      );
    }

    // 1. Codificar la accion con msgpack (protocolo requerido por Hyperliquid)
    const msgPackBytes = msgpackEncode(action);

    // 2. Construir el buffer: msgpack(action) + nonce(8 bytes BE) + vault_flag
    const vaultBytes = vaultAddress
      ? (() => {
          const b = new Uint8Array(21);
          b[0] = 1;
          const addrBytes = ethers.getBytes(vaultAddress);
          b.set(addrBytes, 1);
          return b;
        })()
      : new Uint8Array([0]);

    const data = new Uint8Array(msgPackBytes.length + 8 + vaultBytes.length);
    data.set(msgPackBytes);
    const view = new DataView(data.buffer);
    view.setBigUint64(msgPackBytes.length, BigInt(nonce), false); // big-endian
    data.set(vaultBytes, msgPackBytes.length + 8);

    const actionHash = ethers.keccak256(data);

    const phantomAgent = {
      source: 'a', // 'a' = arbitrum mainnet
      connectionId: actionHash,
    };

    const signature = await this.wallet.signTypedData(
      EIP712_DOMAIN,
      AGENT_TYPES,
      phantomAgent
    );

    const sig = ethers.Signature.from(signature);

    return {
      r: sig.r,
      s: sig.s,
      v: sig.v,
    };
  }

  // ------------------------------------------------------------------
  // Info (lectura de datos)
  // ------------------------------------------------------------------

  /** Obtiene todos los precios mid de todos los activos */
  async getAllMids() {
    return this._post(INFO_URL, { type: 'allMids' }, { endpoint: 'allMids' });
  }

  /** Obtiene metadatos del exchange: lista de activos, sus indices, etc. */
  async getMeta() {
    return this._post(INFO_URL, { type: 'meta' }, { endpoint: 'meta' });
  }

  /** Obtiene el estado completo de la cuenta (balances, posiciones) */
  async getClearinghouseState(address) {
    const userAddress = address || this.address;
    if (!userAddress) throw new Error('Direccion de wallet no configurada');
    return this._post(INFO_URL, { type: 'clearinghouseState', user: userAddress }, { endpoint: 'clearinghouseState' });
  }

  /** Obtiene las ordenes abiertas del usuario */
  async getOpenOrders(address) {
    const userAddress = address || this.address;
    if (!userAddress) throw new Error('Direccion de wallet no configurada');
    return this._post(INFO_URL, { type: 'openOrders', user: userAddress }, { endpoint: 'openOrders' });
  }

  /** Obtiene el precio mark y el funding rate de un activo */
  async getMetaAndAssetCtxs() {
    return this._post(INFO_URL, { type: 'metaAndAssetCtxs' }, { endpoint: 'metaAndAssetCtxs' });
  }

  /** Obtiene velas OHLCV de Hyperliquid */
  async getCandleSnapshot({ asset, interval, startTime, endTime }) {
    return this._post(INFO_URL, {
      type: 'candleSnapshot',
      req: {
        coin: asset,
        interval,
        startTime,
        endTime,
      },
    }, { endpoint: 'candleSnapshot' });
  }

  /** Historial de trades de un usuario */
  async getUserFills(address) {
    const userAddress = address || this.address;
    if (!userAddress) throw new Error('Direccion de wallet no configurada');
    return this._post(INFO_URL, { type: 'userFills', user: userAddress }, { endpoint: 'userFills' });
  }

  // ------------------------------------------------------------------
  // Exchange (acciones de trading)
  // ------------------------------------------------------------------

  /**
   * Envia una accion firmada al endpoint de exchange.
   * @param {object} action - La accion a ejecutar
   * @param {string|null} vaultAddress - Opcional, para operar con vault
   */
  async _sendAction(action, vaultAddress = null) {
    if (!this.wallet) {
      throw new Error('Wallet no configurada. Configura la clave privada en Settings.');
    }
    const now = Date.now();
    const nonce = Math.max(now, this._lastNonce + 1);
    this._lastNonce = nonce;
    const signature = await this._signAction(action, nonce, vaultAddress);

    const payload = {
      action,
      nonce,
      signature,
      ...(vaultAddress && { vaultAddress }),
    };

    return this._post(EXCHANGE_URL, payload);
  }

  _buildLimitOrder({ assetIndex, isBuy, price, size, reduceOnly = false, tif = 'Gtc' }) {
    // Orden de campos del Python SDK: a, b, p, s, r, t (s antes de r)
    return {
      a: assetIndex,
      b: isBuy,
      p: floatToWire(price),
      s: floatToWire(size),
      r: reduceOnly,
      t: { limit: { tif } },
    };
  }

  _buildTriggerOrder({
    assetIndex,
    isBuy,
    price,
    size,
    reduceOnly = true,
    isMarket = true,
    triggerPx,
    tpsl,
  }) {
    // Orden de campos EXACTO del Python SDK oficial de HL: a,b,p,s,r,t
    // (s antes que r — distinto al buildLimitOrder que usa r,s)
    return {
      a: assetIndex,
      b: isBuy,
      p: floatToWire(price),
      s: floatToWire(size),
      r: reduceOnly,
      t: {
        trigger: {
          isMarket,
          triggerPx: floatToWire(triggerPx),
          tpsl,
        },
      },
    };
  }

  /**
   * Coloca una orden en el mercado de futuros.
   *
   * @param {object} params
   * @param {number} params.assetIndex - Indice del activo (obtenido de getMeta)
   * @param {boolean} params.isBuy - true = long, false = short
   * @param {string} params.size - Tamano de la posicion (en unidades del activo)
   * @param {string} params.price - Precio limite (para market usar precio muy alto/bajo)
   * @param {boolean} params.reduceOnly - Solo reduce la posicion existente
   * @param {'Gtc'|'Ioc'|'Alo'} params.tif - Time in force
   * @returns {{ oid: number|null, result: object }} oid del resting order (null si se ejecuto inmediatamente)
   */
  async placeOrder({ assetIndex, isBuy, size, price, reduceOnly = false, tif = 'Gtc' }) {
    const action = {
      type: 'order',
      orders: [
        this._buildLimitOrder({ assetIndex, isBuy, price, size, reduceOnly, tif }),
      ],
      grouping: 'na',
    };

    const result = await this._sendAction(action);

    // Verificar que la orden realmente se ejecuto (no solo fue aceptada)
    const statuses = result?.response?.data?.statuses || [];
    for (const s of statuses) {
      if (s.error) {
        throw new Error(`Orden rechazada: ${s.error}`);
      }
      if (s.canceled !== undefined) {
        throw new Error('La orden no pudo ejecutarse (cancelada por IOC sin contrapartida)');
      }
    }

    // Extraer oid y datos de fill del resting order (GTC/ALO) o del fill inmediato
    const status = statuses[0] || {};
    const oid = status.resting?.oid ?? status.filled?.oid ?? null;
    const filledSz = status.filled?.totalSz != null ? parseFloat(status.filled.totalSz) : null;
    const avgPx = status.filled?.avgPx != null ? parseFloat(status.filled.avgPx) : null;

    return { oid, filledSz, avgPx, result };
  }

  /**
   * Coloca una orden límite GTC para abrir/cerrar posicion.
   * Devuelve directamente el oid para tracking.
   */
  async placeLimit({ assetIndex, isBuy, size, price, reduceOnly = false, tif = 'Gtc' }) {
    const { oid } = await this.placeOrder({ assetIndex, isBuy, size, price, reduceOnly, tif });
    if (!oid) throw new Error('GTC/ALO order no generó oid (puede haberse ejecutado como fill inmediato)');
    return oid;
  }

  /**
   * Coloca una orden trigger (STOP) para ABRIR una posición nueva (no reduce-only).
   * Para LONG entry: isBuy=true, activa cuando precio SUBE a triggerPx.
   * Para SHORT entry alternativo: isBuy=false, activa cuando precio BAJA a triggerPx.
   *
   * @param {number}  assetIndex
   * @param {boolean} isBuy      - true = BUY STOP (LONG), false = SELL STOP
   * @param {string}  size       - tamaño a abrir
   * @param {string}  triggerPx  - precio al que se dispara
   * @returns {number} oid de la orden resting
   */
  async placeTriggerEntry({ assetIndex, isBuy, size, triggerPx }) {
    // p = triggerPx: con isMarket:true HL ejecuta a mercado al dispararse.
    // Calcular un execPrice con slippage genera decimales que violan el tick size
    // del activo → "Order has invalid price". Usar triggerPx directamente evita esto.
    const action = {
      type: 'order',
      orders: [
        this._buildTriggerOrder({
          assetIndex,
          isBuy,
          price: triggerPx,
          size,
          reduceOnly: false,
          isMarket: true,
          triggerPx,
          tpsl: 'sl',
        }),
      ],
      grouping: 'na',
    };

    const result = await this._sendAction(action);
    const statuses = result?.response?.data?.statuses || [];
    const status = statuses[0] || {};
    if (status.error) throw new Error(`Trigger entry rechazada: ${status.error}`);
    const oid = status.resting?.oid ?? null;
    if (!oid) throw new Error('Trigger entry no generó oid resting');
    return oid;
  }

  /**
   * Coloca un Stop Loss nativo sobre una posicion abierta.
   * Para una posicion SHORT que quiere cerrar cuando precio SUBE a triggerPx:
   *   isBuy = true, tpsl = 'sl'
   *
   * @param {number}  assetIndex
   * @param {boolean} isBuy       - true para cerrar SHORT (comprar de vuelta)
   * @param {string}  size        - tamano a cerrar
   * @param {string}  triggerPx   - precio al que se dispara
   * @param {boolean} isMarket    - true = ejecutar como market al disparar
   * @returns {number} oid del SL
   */
  async placeSL({ assetIndex, isBuy, size, triggerPx, isMarket = true }) {
    const action = {
      type: 'order',
      orders: [
        this._buildTriggerOrder({
          assetIndex,
          isBuy,
          price: triggerPx,
          size,
          reduceOnly: true,
          isMarket,
          triggerPx,
          tpsl: 'sl',
        }),
      ],
      grouping: 'na',
    };

    const result = await this._sendAction(action);

    const statuses = result?.response?.data?.statuses || [];
    const status = statuses[0] || {};
    if (status.error) throw new Error(`SL rechazado: ${status.error}`);

    const oid =
      status.resting?.oid ??
      status.filled?.oid ??
      status.triggered?.oid ??
      await this._findOpenTriggerOidWithRetry({ assetIndex, isBuy, size, triggerPx });
    if (!oid) throw new Error('SL no generó oid');
    return oid;
  }

  async placeTP({ assetIndex, isBuy, size, triggerPx }) {
    const action = {
      type: 'order',
      orders: [
        this._buildTriggerOrder({
          assetIndex,
          isBuy,
          price: triggerPx,
          size,
          reduceOnly: true,
          isMarket: true,
          triggerPx,
          tpsl: 'tp',
        }),
      ],
      grouping: 'na',
    };

    const result = await this._sendAction(action);
    const statuses = result?.response?.data?.statuses || [];
    const status = statuses[0] || {};
    if (status.error) throw new Error(`TP rechazado: ${status.error}`);
    const oid =
      status.resting?.oid ??
      status.filled?.oid ??
      status.triggered?.oid ??
      await this._findOpenTriggerOidWithRetry({ assetIndex, isBuy, size, triggerPx });
    if (!oid) throw new Error('TP no generó oid');
    return oid;
  }

  /**
   * Coloca entrada STOP-MARKET + SL encadenado en una sola llamada API.
   * Usa grouping 'normalTpsl': el SL se vincula a la entrada y se activa
   * automáticamente cuando la entrada se llena. Si la entrada se cancela, el SL
   * también se cancela automáticamente.
   *
   * Funciona para ambas direcciones:
   *   SHORT (isBuy=false): SELL STOP dispara cuando precio BAJA a entryTriggerPx
   *                        SL BUY STOP dispara cuando precio SUBE a exitTriggerPx
   *   LONG  (isBuy=true):  BUY STOP dispara cuando precio SUBE a entryTriggerPx
   *                        SL SELL STOP dispara cuando precio BAJA a exitTriggerPx
   *
   * Las órdenes se ejecutan siempre en margen AISLADO (isCross=false en updateLeverage).
   *
   * @param {number}  assetIndex
   * @param {boolean} isBuy          - false = SHORT, true = LONG
   * @param {string}  size           - tamaño formateado
   * @param {string}  entryTriggerPx - precio de disparo de la entrada
   * @param {string}  exitTriggerPx  - precio de disparo del stop-loss
   * @returns {{ entryOid: number, slOid: number }}
   */
  async placeStopEntryWithSL({ assetIndex, isBuy, size, entryTriggerPx, exitTriggerPx }) {
    const slip = 0.002;
    // Precio de ejecución con slippage para garantizar fill en stop-market
    const entryExecPx = isBuy
      ? parseFloat(entryTriggerPx) * (1 + slip)  // BUY STOP: ejecutar levemente por encima
      : parseFloat(entryTriggerPx) * (1 - slip); // SELL STOP: ejecutar levemente por debajo
    const slExecPx = isBuy
      ? parseFloat(exitTriggerPx) * (1 - slip)   // LONG cierra SELL: por debajo
      : parseFloat(exitTriggerPx) * (1 + slip);  // SHORT cierra BUY: por encima

    const action = {
      grouping: 'normalTpsl',
      orders: [
        // 1) Entrada: stop-market para abrir posición (no reduce-only)
        this._buildTriggerOrder({
          assetIndex,
          isBuy,
          price: entryExecPx,
          size,
          reduceOnly: false,
          isMarket: true,
          triggerPx: entryTriggerPx,
          tpsl: 'sl',
        }),
        // 2) SL encadenado: se activa automáticamente cuando la entrada se llena
        this._buildTriggerOrder({
          assetIndex,
          isBuy: !isBuy,
          price: slExecPx,
          size,
          reduceOnly: true,
          isMarket: true,
          triggerPx: exitTriggerPx,
          tpsl: 'sl',
        }),
      ],
      type: 'order',
    };

    const result = await this._sendAction(action);
    const statuses = result?.response?.data?.statuses || [];

    // statuses[0] = entrada, statuses[1] = SL
    const entrySt = statuses[0] || {};
    const slSt    = statuses[1] || {};

    if (entrySt.error) throw new Error(`Stop entry rechazada: ${entrySt.error}`);
    if (slSt.error)   throw new Error(`Stop SL rechazado: ${slSt.error}`);

    const entryOid = entrySt.resting?.oid ?? entrySt.filled?.oid ?? null;
    const slOid    = slSt.resting?.oid    ?? slSt.filled?.oid    ?? null;

    if (!entryOid) throw new Error('Stop bracket: entry no generó oid');
    if (!slOid)    throw new Error('Stop bracket: SL no generó oid');

    return { entryOid, slOid };
  }

  /**
   * Cancela una orden abierta por su ID.
   * @param {number} assetIndex - Indice del activo
   * @param {number} orderId - ID de la orden (oid)
   */
  async cancelOrder(assetIndex, orderId) {
    const action = {
      type: 'cancel',
      cancels: [{ a: assetIndex, o: orderId }],
    };

    return this._sendAction(action);
  }

  /**
   * Obtiene la posicion abierta de un activo para el usuario configurado.
   * @param {string} assetName - Simbolo (ej: "BTC")
   * @returns {object|null} posicion o null si no hay posicion abierta
   */
  async getPosition(assetName) {
    const state = await this.getClearinghouseState(this.address);
    const positions = state?.assetPositions || [];
    const entry = positions.find(
      (p) => p.position?.coin?.toUpperCase() === assetName.toUpperCase()
    );
    if (!entry) return null;
    const pos = entry.position;
    if (!pos || parseFloat(pos.szi) === 0) return null;
    return pos;
  }

  /**
   * Modifica el apalancamiento para un activo.
   * @param {number} assetIndex
   * @param {boolean} isCross - true = cross margin, false = isolated
   * @param {number} leverage - Valor de apalancamiento (1-100)
   */
  async updateLeverage(assetIndex, isCross, leverage) {
    const action = {
      type: 'updateLeverage',
      asset: assetIndex,
      isCross,
      leverage,
    };

    return this._sendAction(action);
  }

  /**
   * Transfiere USDC al slot de margen isolated de un activo.
   *
   * En isolated margin, cada activo tiene su propio pool de garantías separado.
   * Cuando se cambia a isolated mode (updateLeverage isCross=false), el pool comienza
   * vacío. Hay que fondear el slot ANTES de colocar órdenes, de lo contrario HL
   * responde "Insufficient margin to place order".
   *
   * @param {number}  assetIndex - Índice del activo (ej: 0 = BTC)
   * @param {boolean} isBuy      - true = slot LONG, false = slot SHORT
   * @param {number}  usdAmount  - Monto en USD a depositar (entero, redondeado arriba)
   */
  async updateIsolatedMargin(assetIndex, isBuy, usdAmount) {
    const action = {
      type: 'updateIsolatedMargin',
      asset: assetIndex,
      isBuy,
      ntli: Math.round(usdAmount * 1_000_000),  // HL espera micro-USD (6 decimales)
    };

    const result = await this._sendAction(action);
    const status = result?.response?.data?.status;
    // HL devuelve { status: 'ok' } si fue exitoso
    if (status && status !== 'ok') {
      throw new Error(`updateIsolatedMargin rechazado: ${JSON.stringify(status)}`);
    }
    return result;
  }

  /**
   * Retorna los metadatos completos de un activo: indice, szDecimals, maxLeverage.
   * Unico punto de consulta de metadata — reutilizable en toda la app.
   * @param {string} assetName - Simbolo del activo (ej: "BTC")
   * @returns {{ index: number, szDecimals: number, maxLeverage: number, name: string }}
   */
  async getAssetMeta(assetName) {
    const meta = await this.getMeta();
    const universe = meta.universe || [];
    const idx = universe.findIndex(
      (a) => a.name.toUpperCase() === assetName.toUpperCase()
    );
    if (idx === -1) throw new Error(`Activo no encontrado: ${assetName}`);
    const asset = universe[idx];
    return {
      index: idx,
      szDecimals: asset.szDecimals ?? 4,
      maxLeverage: asset.maxLeverage,
      name: asset.name,
    };
  }

  /**
   * Conveniencia: retorna solo el indice del activo.
   * @param {string} assetName
   */
  async getAssetIndex(assetName) {
    const { index } = await this.getAssetMeta(assetName);
    return index;
  }

  async _findOpenTriggerOid({ assetIndex, isBuy, size, triggerPx }) {
    try {
      const [meta, orders] = await Promise.all([
        this.getMeta(),
        this.getOpenOrders(),
      ]);

      const assetName = meta?.universe?.[assetIndex]?.name;
      if (!assetName || !Array.isArray(orders)) return null;

      const wireSize = floatToWire(size);
      const wirePx = floatToWire(triggerPx);
      const expectedSide = isBuy ? 'B' : 'A';

      const candidates = orders.filter((order) => {
        if (String(order.coin || '').toUpperCase() !== String(assetName).toUpperCase()) return false;
        if (order.side && order.side !== expectedSide) return false;
        if (order.sz && !numericEqual(order.sz, wireSize, 1e-6)) return false;
        if (order.limitPx && !numericEqual(order.limitPx, wirePx, 1e-6)) return false;
        return true;
      });

      candidates.sort((a, b) => Number(b.oid || 0) - Number(a.oid || 0));
      return candidates[0]?.oid ? Number(candidates[0].oid) : null;
    } catch (err) {
      logger.warn('hl_resolve_trigger_oid_failed', { error: err.message });
      return null;
    }
  }

  async _findOpenTriggerOidWithRetry(params) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const oid = await this._findOpenTriggerOid(params);
      if (oid) return oid;
      if (attempt < 5) {
        await sleep(250);
      }
    }
    return null;
  }
}

module.exports = HyperliquidService;
