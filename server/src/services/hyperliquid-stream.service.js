const HyperliquidService = require('./hyperliquid.service');
const hlWsClient = require('../websocket/hyperliquidWs');
const config = require('../config');
const logger = require('./logger.service');

function asUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeUser(value) {
  return String(value || '').trim().toLowerCase();
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// HL no expone una suscripción real `clearinghouseState` a día de hoy: si el
// handler WS jamás recibe eventos, el caché se llena una sola vez desde el
// fallback HTTP y queda congelado. Un TTL corto garantiza que nuevas lecturas
// vuelvan a HTTP cuando el slot isolated se haya fondeado/redimensionado.
const CLEARINGHOUSE_STATE_FRESHNESS_MS = 5_000;

function extractBbo(raw = {}) {
  const bid = toFiniteNumber(raw.bid ?? raw.bestBid ?? raw.bb ?? raw.b);
  const ask = toFiniteNumber(raw.ask ?? raw.bestAsk ?? raw.ba ?? raw.a);
  const mid = bid != null && ask != null
    ? (bid + ask) / 2
    : toFiniteNumber(raw.mid ?? raw.midPx);
  const spreadBps = bid != null && ask != null && mid > 0
    ? ((ask - bid) / mid) * 10_000
    : null;
  return {
    bid,
    ask,
    mid,
    spreadBps,
    time: Number(raw.time || Date.now()),
    raw,
  };
}

class HyperliquidStreamService {
  constructor(deps = {}) {
    this.wsClient = deps.wsClient || hlWsClient;
    this.httpClient = deps.httpClient || new HyperliquidService({});
    this.logger = deps.logger || logger;
    this.enabled = deps.enabled ?? config.deltaNeutral.hlWsEnabled;
    this.started = false;
    this.unsubscribe = null;
    this.subscribedAssets = new Set();
    this.subscribedUsers = new Set();
    this.mids = new Map();
    this.assetCtx = new Map();
    this.bbo = new Map();
    this.clearinghouseState = new Map();
    this.lastMessageAt = null;
  }

  start() {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.wsClient.subscribe({ type: 'allMids' });
    this.unsubscribe = this.wsClient.addSubscriber((message) => this._handleMessage(message));
  }

  stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.started = false;
  }

  trackProtection(protection) {
    if (!this.enabled || !protection) return;
    this.start();
    const asset = asUpper(protection.inferredAsset);
    const user = protection.account?.address || protection.walletAddress;

    if (asset && !this.subscribedAssets.has(asset)) {
      this.subscribedAssets.add(asset);
      this.wsClient.subscribe({ type: 'bbo', coin: asset });
      this.wsClient.subscribe({ type: 'activeAssetCtx', coin: asset });
    }

    const normalizedUser = normalizeUser(user);
    if (normalizedUser && !this.subscribedUsers.has(normalizedUser)) {
      this.subscribedUsers.add(normalizedUser);
      // HL no expone un canal WS `clearinghouseState` — la fuente de verdad
      // sigue siendo HTTP con TTL en `getClearinghouseState` más abajo.
      // Mantener la suscripción activa desperdiciaría un slot del WS sin
      // disparar eventos, además de generar ruido en el diagnóstico.
      this.wsClient.subscribe({ type: 'orderUpdates', user });
      this.wsClient.subscribe({ type: 'userEvents', user });
    }
  }

  async getMidPrice(asset) {
    const normalized = asUpper(asset);
    const cached = this.mids.get(normalized);
    if (cached?.price != null) return { ...cached, source: 'ws' };

    const mids = await this.httpClient.getAllMids().catch(() => null);
    const price = toFiniteNumber(mids?.[normalized]);
    if (price == null) return null;
    const value = { asset: normalized, price, timestamp: Date.now(), source: 'http' };
    this.mids.set(normalized, value);
    return value;
  }

  async getBbo(asset) {
    const normalized = asUpper(asset);
    const cached = this.bbo.get(normalized);
    return cached ? { ...cached, source: 'ws' } : null;
  }

  async getActiveAssetCtx(asset) {
    const normalized = asUpper(asset);
    const cached = this.assetCtx.get(normalized);
    if (cached) return { ...cached, source: 'ws' };

    const rows = await this.httpClient.getMetaAndAssetCtxs().catch(() => null);
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const [meta, ctxs] = rows;
    const universe = meta?.universe || [];
    const index = universe.findIndex((item) => asUpper(item?.name) === normalized);
    if (index < 0) return null;
    const ctx = ctxs[index] || {};
    const parsed = {
      asset: normalized,
      midPx: toFiniteNumber(ctx.midPx),
      markPx: toFiniteNumber(ctx.markPx),
      fundingRate: toFiniteNumber(ctx.funding),
      openInterest: toFiniteNumber(ctx.openInterest),
      volume24h: toFiniteNumber(ctx.dayNtlVlm),
      timestamp: Date.now(),
    };
    this.assetCtx.set(normalized, parsed);
    return { ...parsed, source: 'http' };
  }

  async getClearinghouseState(user) {
    const normalized = normalizeUser(user);
    const cached = this.clearinghouseState.get(normalized);
    const age = cached ? Date.now() - Number(cached.timestamp || 0) : Infinity;
    if (cached && age < CLEARINGHOUSE_STATE_FRESHNESS_MS) {
      return { ...cached, source: cached.source || 'ws' };
    }

    const state = await this.httpClient.getClearinghouseState(user).catch(() => null);
    if (!state) {
      // Si HTTP falla pero tenemos caché viejo, devolvemos eso para no romper
      // el resto del flujo (mejor stale que null).
      return cached ? { ...cached, source: 'stale' } : null;
    }
    const parsed = { user: normalized, state, timestamp: Date.now(), source: 'http' };
    this.clearinghouseState.set(normalized, parsed);
    return { ...parsed };
  }

  getDiagnostics() {
    return {
      enabled: this.enabled,
      started: this.started,
      lastMessageAt: this.lastMessageAt,
      trackedAssets: Array.from(this.subscribedAssets),
      trackedUsers: Array.from(this.subscribedUsers),
      cache: {
        mids: this.mids.size,
        assetCtx: this.assetCtx.size,
        bbo: this.bbo.size,
        clearinghouseState: this.clearinghouseState.size,
      },
    };
  }

  _handleMessage(message = {}) {
    this.lastMessageAt = Date.now();
    const channel = String(message.channel || '').trim();
    const data = message.data || {};

    if (channel === 'allMids') {
      const mids = data.mids || data;
      if (mids && typeof mids === 'object') {
        Object.entries(mids).forEach(([asset, price]) => {
          const normalized = asUpper(asset);
          const parsedPrice = toFiniteNumber(price);
          if (parsedPrice == null) return;
          this.mids.set(normalized, {
            asset: normalized,
            price: parsedPrice,
            timestamp: Date.now(),
          });
        });
      }
      return;
    }

    if (channel === 'bbo') {
      const asset = asUpper(data.coin);
      if (!asset) return;
      this.bbo.set(asset, {
        asset,
        ...extractBbo(data),
      });
      return;
    }

    if (channel === 'activeAssetCtx') {
      const asset = asUpper(data.coin);
      if (!asset) return;
      this.assetCtx.set(asset, {
        asset,
        midPx: toFiniteNumber(data.midPx),
        markPx: toFiniteNumber(data.markPx),
        fundingRate: toFiniteNumber(data.funding),
        openInterest: toFiniteNumber(data.openInterest),
        volume24h: toFiniteNumber(data.dayNtlVlm),
        timestamp: Number(data.time || Date.now()),
        raw: data,
      });
      return;
    }

    // `clearinghouseState` no se recibe por WS (HL no expone ese canal).
    // El map `this.clearinghouseState` se llena sólo via HTTP + TTL en
    // `getClearinghouseState`.
  }
}

module.exports = new HyperliquidStreamService();
module.exports.HyperliquidStreamService = HyperliquidStreamService;
