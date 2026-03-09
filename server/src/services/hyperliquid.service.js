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

const axios = require('axios');
const { ethers } = require('ethers');
const { encode: msgpackEncode } = require('@msgpack/msgpack');
const config = require('../config');

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

class HyperliquidService {
  /**
   * @param {{ privateKey: string, address: string }} walletConfig
   */
  constructor({ privateKey, address } = {}) {
    this.wallet  = null;
    this.address = address || null;
    if (privateKey) {
      try {
        this.wallet  = new ethers.Wallet(privateKey);
        this.address = this.wallet.address;
      } catch (err) {
        console.error('[HL] Error al inicializar wallet:', err.message);
      }
    }
  }

  // ------------------------------------------------------------------
  // Helpers internos
  // ------------------------------------------------------------------

  async _post(url, body) {
    try {
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      const data = response.data;

      // Hyperliquid devuelve errores de aplicacion con HTTP 200 y status "err"
      if (data?.status === 'err') {
        throw new Error(data.response || 'Error en Hyperliquid API');
      }

      return data;
    } catch (err) {
      if (err.message && !err.response) throw err; // re-lanzar errores propios
      const message =
        err.response?.data?.error || err.response?.data || err.message;
      throw new Error(`[HL API] ${message}`);
    }
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
    return this._post(INFO_URL, { type: 'allMids' });
  }

  /** Obtiene metadatos del exchange: lista de activos, sus indices, etc. */
  async getMeta() {
    return this._post(INFO_URL, { type: 'meta' });
  }

  /** Obtiene el estado completo de la cuenta (balances, posiciones) */
  async getClearinghouseState(address) {
    const userAddress = address || this.address;
    if (!userAddress) throw new Error('Direccion de wallet no configurada');
    return this._post(INFO_URL, { type: 'clearinghouseState', user: userAddress });
  }

  /** Obtiene las ordenes abiertas del usuario */
  async getOpenOrders(address) {
    const userAddress = address || this.address;
    if (!userAddress) throw new Error('Direccion de wallet no configurada');
    return this._post(INFO_URL, { type: 'openOrders', user: userAddress });
  }

  /** Obtiene el precio mark y el funding rate de un activo */
  async getMetaAndAssetCtxs() {
    return this._post(INFO_URL, { type: 'metaAndAssetCtxs' });
  }

  /** Historial de trades de un usuario */
  async getUserFills(address) {
    const userAddress = address || this.address;
    if (!userAddress) throw new Error('Direccion de wallet no configurada');
    return this._post(INFO_URL, { type: 'userFills', user: userAddress });
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
    const nonce = Date.now();
    const signature = await this._signAction(action, nonce, vaultAddress);

    const payload = {
      action,
      nonce,
      signature,
      ...(vaultAddress && { vaultAddress }),
    };

    return this._post(EXCHANGE_URL, payload);
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
        {
          a: assetIndex,
          b: isBuy,
          p: price,
          s: size,
          r: reduceOnly,
          t: { limit: { tif } },
        },
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

    // Extraer oid del resting order (GTC/ALO) o del fill inmediato
    const status = statuses[0] || {};
    const oid = status.resting?.oid ?? status.filled?.oid ?? null;

    return { oid, result };
  }

  /**
   * Coloca una orden límite GTC para abrir/cerrar posicion.
   * Devuelve directamente el oid para tracking.
   */
  async placeLimit({ assetIndex, isBuy, size, price, reduceOnly = false }) {
    const { oid } = await this.placeOrder({ assetIndex, isBuy, size, price, reduceOnly, tif: 'Gtc' });
    if (!oid) throw new Error('GTC order no generó oid (puede haberse ejecutado como fill inmediato)');
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
    // Precio de slippage para la ejecucion market al disparar (0.2% de margen)
    const slippage = 0.002;
    const execPrice = isBuy
      ? (parseFloat(triggerPx) * (1 + slippage)).toFixed(6)
      : (parseFloat(triggerPx) * (1 - slippage)).toFixed(6);

    const action = {
      type: 'order',
      orders: [
        {
          a: assetIndex,
          b: isBuy,
          p: execPrice,
          s: size,
          r: true,  // reduceOnly siempre para SL
          t: {
            trigger: {
              triggerPx: String(triggerPx),
              isMarket,
              tpsl: 'sl',
            },
          },
        },
      ],
      grouping: 'na',
    };

    const result = await this._sendAction(action);

    const statuses = result?.response?.data?.statuses || [];
    const status = statuses[0] || {};
    if (status.error) throw new Error(`SL rechazado: ${status.error}`);

    const oid = status.resting?.oid ?? status.filled?.oid ?? null;
    if (!oid) throw new Error('SL no generó oid');
    return oid;
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
}

module.exports = HyperliquidService;
