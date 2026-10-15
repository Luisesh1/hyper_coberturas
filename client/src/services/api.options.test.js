import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { optionsApi, request, settingsApi } from './api';

function lastCall() {
  const [url, init] = global.fetch.mock.calls.at(-1);
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
}

describe('API de Opciones', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: { ok: 1 } })),
    });
  });
  afterEach(() => { global.fetch = originalFetch; });

  it('exporta el helper request', () => {
    expect(typeof request).toBe('function');
  });

  it.each([
    ['getUnderlyings', () => optionsApi.getUnderlyings(), 'GET', '/api/options/underlyings'],
    ['getChain', () => optionsApi.getChain({ underlying: 'BTC', expiry: '261031' }), 'GET', '/api/options/chain?underlying=BTC&expiry=261031'],
    ['getChain sin vencimiento', () => optionsApi.getChain({ underlying: 'ETH' }), 'GET', '/api/options/chain?underlying=ETH'],
    ['getAccount', () => optionsApi.getAccount(), 'GET', '/api/options/account'],
    ['getPositions', () => optionsApi.getPositions(), 'GET', '/api/options/positions'],
    ['getOpenOrders', () => optionsApi.getOpenOrders(), 'GET', '/api/options/orders/open'],
    ['cancelOrder', () => optionsApi.cancelOrder('BTC-261031-72000-C', 123), 'DELETE', '/api/options/orders/BTC-261031-72000-C/123'],
    ['getTrades', () => optionsApi.getTrades(), 'GET', '/api/options/trades?days=30'],
    ['getBinanceOptions', () => settingsApi.getBinanceOptions(), 'GET', '/api/settings/binance-options'],
    ['deleteBinanceOptions', () => settingsApi.deleteBinanceOptions(), 'DELETE', '/api/settings/binance-options'],
    ['testBinanceOptions', () => settingsApi.testBinanceOptions(), 'POST', '/api/settings/binance-options/test'],
    ['getOptionsLimits', () => settingsApi.getOptionsLimits(), 'GET', '/api/settings/options-limits'],
  ])('%s → %s %s', async (_name, call, method, url) => {
    const data = await call();
    expect(data).toEqual({ ok: 1 });
    expect(lastCall()).toMatchObject({ method, url });
  });

  it('placeOrder envía el contrato del spec', async () => {
    await optionsApi.placeOrder({
      symbol: 'BTC-261031-72000-C', side: 'SELL', quantity: 0.5, price: 905, postOnly: true, reduceOnly: false,
    });
    expect(lastCall()).toEqual({
      url: '/api/options/orders',
      method: 'POST',
      body: { symbol: 'BTC-261031-72000-C', side: 'SELL', quantity: 0.5, price: 905, postOnly: true, reduceOnly: false },
    });
  });

  it('saveBinanceOptions y saveOptionsLimits usan PUT con su cuerpo', async () => {
    await settingsApi.saveBinanceOptions({ alias: 'Principal', apiKey: 'k', apiSecret: 's' });
    expect(lastCall()).toEqual({
      url: '/api/settings/binance-options', method: 'PUT', body: { alias: 'Principal', apiKey: 'k', apiSecret: 's' },
    });
    await settingsApi.saveOptionsLimits({ maxMarginUsdt: 5000, maxDailyLossUsdt: 500, maxLiveStrategies: 3, notifyTelegram: true });
    expect(lastCall()).toEqual({
      url: '/api/settings/options-limits',
      method: 'PUT',
      body: { maxMarginUsdt: 5000, maxDailyLossUsdt: 500, maxLiveStrategies: 3, notifyTelegram: true },
    });
  });
});
