const { ethers } = require('ethers');

// Multicall3: misma address en TODA red EVM mainnet/L2 que el bot soporta
// (Arbitrum, Ethereum, Optimism, Base, Polygon). Si en algún momento se
// agrega una red exotic donde no existe, `aggregate()` lanza
// `MULTICALL3_NOT_DEPLOYED` y los call sites caen al path legacy.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  // Helper nativo: permite leer el balance ETH/native de N addresses
  // dentro del MISMO multicall, sin tener que armar una segunda RPC
  // call para `provider.getBalance`. Lo usamos en `enrichWalletAssets`.
  'function getEthBalance(address addr) view returns (uint256 balance)',
];

// Tamaño del ring buffer por (scope, method) para p50/p99. 200 es
// suficiente para detectar tendencias sin gastar memoria. ~400 KB total
// asumiendo ~50 (scope, method) combinations × 200 samples × 8 bytes.
const METRICS_RING_SIZE = 200;

class OnChainManager {
  constructor() {
    this.providerCache = new Map();
    this.contractCache = new Map();
    this.runnerContractCache = new WeakMap();
    this.interfaceCache = new Map();
    // metrics: { [scope]: { [method]: { count, totalDurationMs, errors, samples: number[] } } }
    this.metrics = new Map();
    // Set de chainIds donde ya verificamos que Multicall3 está deployed.
    // Se popula la primera vez que se llama exitosamente.
    this.multicall3VerifiedChainIds = new Set();
  }

  uniqueUrls(urls = []) {
    const seen = new Set();
    const result = [];
    for (const item of urls) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  normalizeNetworkConfig(networkConfig) {
    if (!networkConfig || typeof networkConfig !== 'object') {
      throw new Error('networkConfig es requerido para operaciones on-chain');
    }
    const id = String(networkConfig.id || '').trim();
    const chainId = Number(networkConfig.chainId);
    const rpcUrl = String(networkConfig.rpcUrl || '').trim();
    const fallbackRpcUrl = String(networkConfig.fallbackRpcUrl || '').trim();

    if (!id || !Number.isFinite(chainId) || chainId <= 0) {
      throw new Error(`networkConfig invalido para ${id || 'network_desconocida'}`);
    }
    if (!rpcUrl && !fallbackRpcUrl) {
      throw new Error(`No RPC configurado para ${id}`);
    }

    return {
      ...networkConfig,
      id,
      chainId,
      rpcUrl,
      fallbackRpcUrl,
    };
  }

  getProviderCacheKey(networkConfig, scope = 'default') {
    const normalized = this.normalizeNetworkConfig(networkConfig);
    return [
      String(scope || 'default'),
      normalized.id,
      normalized.chainId,
      normalized.rpcUrl,
      normalized.fallbackRpcUrl,
    ].join(':');
  }

  buildProvider(networkConfig) {
    const normalized = this.normalizeNetworkConfig(networkConfig);
    const urls = this.uniqueUrls([normalized.rpcUrl, normalized.fallbackRpcUrl]);

    if (urls.length === 1) {
      return new ethers.JsonRpcProvider(urls[0], normalized.chainId, { staticNetwork: true });
    }

    return new ethers.FallbackProvider(urls.map((url, index) => ({
      provider: new ethers.JsonRpcProvider(url, normalized.chainId, { staticNetwork: true }),
      priority: index + 1,
      weight: 1,
      stallTimeout: index === 0 ? 900 : 1_800,
    })), normalized.chainId, {
      quorum: 1,
      eventQuorum: 1,
    });
  }

  getProvider(networkConfig, { scope = 'default' } = {}) {
    const cacheKey = this.getProviderCacheKey(networkConfig, scope);
    if (!this.providerCache.has(cacheKey)) {
      this.providerCache.set(cacheKey, this.buildProvider(networkConfig));
    }
    return this.providerCache.get(cacheKey);
  }

  getInterface(abi) {
    const key = JSON.stringify(abi || []);
    if (!this.interfaceCache.has(key)) {
      this.interfaceCache.set(key, new ethers.Interface(abi));
    }
    return this.interfaceCache.get(key);
  }

  getContract({
    networkConfig = null,
    address,
    abi,
    scope = 'default',
    runner = null,
  }) {
    const normalizedAddress = ethers.getAddress(String(address || '').trim());
    const abiKey = JSON.stringify(abi || []);
    this.getInterface(abi);
    const resolvedRunner = runner || this.getProvider(networkConfig, { scope });

    if (runner) {
      let cache = this.runnerContractCache.get(resolvedRunner);
      if (!cache) {
        cache = new Map();
        this.runnerContractCache.set(resolvedRunner, cache);
      }
      const cacheKey = `${normalizedAddress}:${abiKey}`;
      if (!cache.has(cacheKey)) {
        cache.set(cacheKey, new ethers.Contract(normalizedAddress, abi, resolvedRunner));
      }
      return cache.get(cacheKey);
    }

    const providerKey = this.getProviderCacheKey(networkConfig, scope);
    const cacheKey = `${providerKey}:${normalizedAddress}:${abiKey}`;
    if (!this.contractCache.has(cacheKey)) {
      this.contractCache.set(cacheKey, new ethers.Contract(normalizedAddress, abi, resolvedRunner));
    }
    return this.contractCache.get(cacheKey);
  }

  // ────────────────────────────────────────────────────────────────────
  // Telemetría
  // ────────────────────────────────────────────────────────────────────

  /**
   * Wrapper de cualquier promesa de RPC que mide duración + cuenta éxitos
   * y errores por (scope, method). Es barato: un Date.now() antes/después
   * y un push a un ring buffer de 200 muestras.
   */
  async _track(scope, method, fn) {
    const startedAt = Date.now();
    let scopeMap = this.metrics.get(scope);
    if (!scopeMap) {
      scopeMap = new Map();
      this.metrics.set(scope, scopeMap);
    }
    let entry = scopeMap.get(method);
    if (!entry) {
      entry = { count: 0, totalDurationMs: 0, errors: 0, samples: [] };
      scopeMap.set(method, entry);
    }
    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      entry.count += 1;
      entry.totalDurationMs += durationMs;
      entry.samples.push(durationMs);
      if (entry.samples.length > METRICS_RING_SIZE) entry.samples.shift();
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      entry.count += 1;
      entry.errors += 1;
      entry.totalDurationMs += durationMs;
      entry.samples.push(durationMs);
      if (entry.samples.length > METRICS_RING_SIZE) entry.samples.shift();
      throw err;
    }
  }

  _percentile(samples, p) {
    if (!samples || samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  /**
   * Devuelve un snapshot serializable de las métricas. Shape:
   *   { [scope]: { [method]: { count, p50Ms, p99Ms, avgMs, errors } } }
   */
  getStats() {
    const result = {};
    for (const [scope, scopeMap] of this.metrics.entries()) {
      const methods = {};
      for (const [method, entry] of scopeMap.entries()) {
        methods[method] = {
          count: entry.count,
          errors: entry.errors,
          avgMs: entry.count > 0 ? Math.round(entry.totalDurationMs / entry.count) : 0,
          p50Ms: this._percentile(entry.samples, 50),
          p99Ms: this._percentile(entry.samples, 99),
        };
      }
      result[scope] = methods;
    }
    return result;
  }

  resetStats() {
    this.metrics.clear();
  }

  // ────────────────────────────────────────────────────────────────────
  // Operaciones RPC instrumentadas
  // ────────────────────────────────────────────────────────────────────

  async call({ networkConfig, tx, scope = 'default' }) {
    return this._track(scope, 'call', () => this.getProvider(networkConfig, { scope }).call(tx));
  }

  async estimateGas({ networkConfig, tx, scope = 'default' }) {
    return this._track(scope, 'estimateGas', () => this.getProvider(networkConfig, { scope }).estimateGas(tx));
  }

  async getBalance({ networkConfig, address, blockTag, scope = 'default' }) {
    return this._track(scope, 'getBalance', () => this.getProvider(networkConfig, { scope }).getBalance(address, blockTag));
  }

  async waitForReceipt({
    networkConfig,
    txHash,
    confirmations = 1,
    timeoutMs = 90_000,
    scope = 'default',
  }) {
    return this._track(scope, 'waitForReceipt', () => this.getProvider(networkConfig, { scope }).waitForTransaction(txHash, confirmations, timeoutMs));
  }

  // ────────────────────────────────────────────────────────────────────
  // Multicall3 — batching de reads
  // ────────────────────────────────────────────────────────────────────

  /**
   * Batchea N lecturas on-chain en una sola RPC call vía Multicall3.aggregate3.
   *
   * @param {object} args
   * @param {object} args.networkConfig — el mismo que usa getProvider/getContract
   * @param {string} [args.scope='default'] — para telemetría
   * @param {Array<{
   *   target: string,        // address del contrato a llamar
   *   abi: any[],            // ABI del contrato (cacheado por iface)
   *   method: string,        // nombre del método
   *   args?: any[],          // args del método (default [])
   *   allowFailure?: boolean // si true, una call fallida no aborta el batch
   * }>} args.calls
   * @returns {Promise<Array<{ success: boolean, value: any|null, error: Error|null }>>}
   *   Resultado por call en el mismo orden. Si `success=false` y
   *   `allowFailure=true`, `error` contiene el motivo. Si una call con
   *   `allowFailure=false` falla, el método entero rechaza con el error
   *   raw del nodo RPC.
   */
  async aggregate({ networkConfig, calls, scope = 'default' }) {
    if (!Array.isArray(calls) || calls.length === 0) return [];

    const provider = this.getProvider(networkConfig, { scope });
    const multicall3 = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

    // Encodea cada call con su iface (cacheado).
    const encoded = calls.map((c) => {
      const iface = this.getInterface(c.abi);
      const callData = iface.encodeFunctionData(c.method, c.args || []);
      return {
        target: ethers.getAddress(c.target),
        allowFailure: c.allowFailure === true,
        callData,
      };
    });

    let rawResults;
    try {
      rawResults = await this._track(scope, 'aggregate3', () => multicall3.aggregate3.staticCall(encoded));
    } catch (err) {
      // Si Multicall3 no existe (red exotica) marcamos el error con un
      // code identificable para que los call sites puedan caer al path
      // legacy con un fallback try/catch.
      const isCallException = err?.code === 'CALL_EXCEPTION' || err?.code === 'BAD_DATA';
      if (isCallException && !this.multicall3VerifiedChainIds.has(Number(networkConfig?.chainId))) {
        const wrapped = new Error(`Multicall3 no parece estar deployed en chainId ${networkConfig?.chainId}`);
        wrapped.code = 'MULTICALL3_NOT_DEPLOYED';
        wrapped.cause = err;
        throw wrapped;
      }
      throw err;
    }

    if (Number.isFinite(Number(networkConfig?.chainId))) {
      this.multicall3VerifiedChainIds.add(Number(networkConfig.chainId));
    }

    // Decodea cada resultado contra el iface del call original.
    return rawResults.map((rawResult, index) => {
      const call = calls[index];
      const success = Boolean(rawResult.success);
      const returnData = rawResult.returnData;
      if (!success) {
        return {
          success: false,
          value: null,
          error: new Error(`aggregate3 call ${index} (${call.method}) revertió`),
          returnData,
        };
      }
      try {
        const iface = this.getInterface(call.abi);
        const decoded = iface.decodeFunctionResult(call.method, returnData);
        // Si la función devuelve un solo valor, devolvemos ese valor
        // directamente; si devuelve múltiples, devolvemos el Result completo.
        const value = decoded.length === 1 ? decoded[0] : decoded;
        return { success: true, value, error: null, returnData };
      } catch (decodeErr) {
        return { success: false, value: null, error: decodeErr, returnData };
      }
    });
  }

  /**
   * Helper de alto nivel: recibe un objeto `{ [key]: callSpec }` y
   * devuelve `{ [key]: value }` con los valores decodeados. Si una call
   * tiene `allowFailure=true` y revierte, su valor es `undefined`.
   */
  async batchReads({ networkConfig, reads, scope = 'default' }) {
    const entries = Object.entries(reads || {});
    if (entries.length === 0) return {};
    const calls = entries.map(([, spec]) => spec);
    const results = await this.aggregate({ networkConfig, calls, scope });
    const out = {};
    entries.forEach(([key, spec], index) => {
      const r = results[index];
      if (r.success) {
        out[key] = r.value;
      } else if (spec.allowFailure) {
        out[key] = undefined;
      } else {
        // Esto no debería pasar porque aggregate() ya hubiera throwed
        // arriba si allowFailure=false; pero por defensa lo lanzamos acá.
        throw r.error;
      }
    });
    return out;
  }

  clear({ networkId = null, scope = null } = {}) {
    for (const key of [...this.providerCache.keys()]) {
      if (networkId && !key.includes(`:${networkId}:`)) continue;
      if (scope && !key.startsWith(`${scope}:`)) continue;
      this.providerCache.delete(key);
    }
    for (const key of [...this.contractCache.keys()]) {
      if (networkId && !key.includes(`:${networkId}:`)) continue;
      if (scope && !key.startsWith(`${scope}:`)) continue;
      this.contractCache.delete(key);
    }
  }
}

const onChainManager = new OnChainManager();

module.exports = onChainManager;
module.exports.OnChainManager = OnChainManager;
module.exports.MULTICALL3_ADDRESS = MULTICALL3_ADDRESS;
module.exports.MULTICALL3_ABI = MULTICALL3_ABI;
