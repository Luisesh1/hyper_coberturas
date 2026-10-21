/**
 * Cliente HTTP de la API pública de Deribit, con límite de concurrencia
 * y reintento con backoff ante 429.
 */
const defaultHttp = require('../../shared/platform/http/http-client');

const BASE_URL = 'https://www.deribit.com/api/v2/public';
const TIMEOUT_MS = 15000;
const BACKOFF_BASE_MS = 250;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDeribitClient({ http = defaultHttp, concurrency = 6, maxRetries = 3, sleep = defaultSleep } = {}) {
  let active = 0;
  const waiting = []; // FIFO de resolvers

  async function acquire() {
    if (active < concurrency) {
      active += 1;
      return;
    }
    // El cupo se traspasa directamente al siguiente en la cola (active no cambia).
    await new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  async function call(method, params) {
    await acquire();
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await http.get(`${BASE_URL}/${method}`, { params, timeout: TIMEOUT_MS });
          return res.data?.result;
        } catch (err) {
          if (err?.response?.status === 429 && attempt < maxRetries) {
            await sleep(BACKOFF_BASE_MS * 2 ** attempt);
            continue;
          }
          throw err;
        }
      }
    } finally {
      release();
    }
  }

  async function getInstrument(name) {
    try {
      return (await call('get_instrument', { instrument_name: name })) ?? null;
    } catch (err) {
      if (err?.response?.data?.error?.data?.reason === 'instrument not found') return null;
      throw err;
    }
  }

  async function getInstruments({ currency, expired = false }) {
    return (await call('get_instruments', { currency, kind: 'option', expired })) || [];
  }

  async function getChartData({ instrument, resolution, startMs, endMs }) {
    return call('get_tradingview_chart_data', {
      instrument_name: instrument,
      start_timestamp: startMs,
      end_timestamp: endMs,
      resolution,
    });
  }

  return { getInstrument, getInstruments, getChartData };
}

const deribitClient = createDeribitClient();

module.exports = { createDeribitClient, deribitClient };
