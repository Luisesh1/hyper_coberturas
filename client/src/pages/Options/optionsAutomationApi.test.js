import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { optionsBacktestsApi, optionsStrategiesApi } from './optionsAutomationApi';

function okResponse(data) {
  return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, data }) };
}

describe('optionsAutomationApi', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls.at(-1);
    return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
  };

  it('estrategias: rutas y métodos del contrato', async () => {
    await optionsStrategiesApi.listTemplates();
    expect(lastCall()).toMatchObject({ url: '/api/options/strategies/templates', method: 'GET' });

    await optionsStrategiesApi.list();
    expect(lastCall()).toMatchObject({ url: '/api/options/strategies', method: 'GET' });

    await optionsStrategiesApi.create({ name: 'X', template: 'short_strangle' });
    expect(lastCall()).toEqual({ url: '/api/options/strategies', method: 'POST', body: { name: 'X', template: 'short_strangle' } });

    await optionsStrategiesApi.get(7);
    expect(lastCall()).toMatchObject({ url: '/api/options/strategies/7', method: 'GET' });

    await optionsStrategiesApi.update(7, { name: 'Y' });
    expect(lastCall()).toEqual({ url: '/api/options/strategies/7', method: 'PUT', body: { name: 'Y' } });

    await optionsStrategiesApi.remove(7);
    expect(lastCall()).toMatchObject({ url: '/api/options/strategies/7', method: 'DELETE' });
  });

  it('modo: live sólo lleva confirm:true si se pide explícitamente', async () => {
    await optionsStrategiesApi.setMode(3, 'shadow');
    expect(lastCall()).toEqual({ url: '/api/options/strategies/3/mode', method: 'PUT', body: { mode: 'shadow' } });

    await optionsStrategiesApi.setMode(3, 'live');
    expect(lastCall().body).toEqual({ mode: 'live', confirm: false });

    await optionsStrategiesApi.setMode(3, 'live', { confirm: true });
    expect(lastCall().body).toEqual({ mode: 'live', confirm: true });
  });

  it('backtests: crear, listar y consultar', async () => {
    const config = { strategyId: 1, underlying: 'BTC', source: 'dvol' };
    await optionsBacktestsApi.create(config);
    expect(lastCall()).toEqual({ url: '/api/options/backtests', method: 'POST', body: config });

    await optionsBacktestsApi.list();
    expect(lastCall()).toMatchObject({ url: '/api/options/backtests', method: 'GET' });

    await optionsBacktestsApi.get('ab/c');
    expect(lastCall()).toMatchObject({ url: '/api/options/backtests/ab%2Fc', method: 'GET' });
  });

  it('propaga el mensaje de error del servidor', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ success: false, error: 'Faltan credenciales de Binance Opciones' }),
    });
    await expect(optionsStrategiesApi.setMode(1, 'live', { confirm: true }))
      .rejects.toThrow('Faltan credenciales de Binance Opciones');
  });
});
