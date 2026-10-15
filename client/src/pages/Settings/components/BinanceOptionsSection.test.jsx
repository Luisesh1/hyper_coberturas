import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BinanceOptionsSection } from './BinanceOptionsSection';

const { settingsApi, addNotification } = vi.hoisted(() => ({
  settingsApi: {
    getBinanceOptions: vi.fn(),
    saveBinanceOptions: vi.fn(),
    deleteBinanceOptions: vi.fn(),
    testBinanceOptions: vi.fn(),
    getOptionsLimits: vi.fn(),
    saveOptionsLimits: vi.fn(),
  },
  addNotification: vi.fn(),
}));

vi.mock('../../../services/api', () => ({ settingsApi }));
vi.mock('../../../context/TradingContext', () => ({
  useTradingContext: () => ({ addNotification }),
}));

const LIMITS = { maxMarginUsdt: 5000, maxDailyLossUsdt: 500, maxLiveStrategies: 3, notifyTelegram: true };

beforeEach(() => {
  vi.clearAllMocks();
  settingsApi.getBinanceOptions.mockResolvedValue({ configured: false });
  settingsApi.getOptionsLimits.mockResolvedValue(LIMITS);
  settingsApi.saveBinanceOptions.mockResolvedValue({ configured: true });
  settingsApi.saveOptionsLimits.mockImplementation((d) => Promise.resolve(d));
  settingsApi.deleteBinanceOptions.mockResolvedValue({});
});

describe('BinanceOptionsSection', () => {
  it('alta: exige key y secret y guarda el payload', async () => {
    const onStatusChange = vi.fn();
    const user = userEvent.setup();
    render(<BinanceOptionsSection onStatusChange={onStatusChange} />);
    expect(await screen.findByText('Sin configurar')).toBeTruthy();
    // Sin credenciales no se puede probar
    expect(screen.getByRole('button', { name: 'Probar conexión' }).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('obligatorios');
    expect(settingsApi.saveBinanceOptions).not.toHaveBeenCalled();

    settingsApi.getBinanceOptions.mockResolvedValue({ configured: true, alias: 'Principal', apiKeyMasked: 'hT9x***' });
    await user.type(screen.getByLabelText('Alias'), 'Principal');
    await user.type(screen.getByLabelText('API key'), 'KEY123');
    await user.type(screen.getByLabelText('Secret'), 'SECRET456');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(settingsApi.saveBinanceOptions).toHaveBeenCalledWith({
      alias: 'Principal', apiKey: 'KEY123', apiSecret: 'SECRET456',
    }));
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith({ configured: true, alias: 'Principal' }));
    // El secret no se queda en el formulario
    expect(screen.getByLabelText('Secret').value).toBe('');
    expect(screen.getByText('Configurada · sin probar')).toBeTruthy();
  });

  it('edición: el secret vacío no se envía (conserva el guardado)', async () => {
    settingsApi.getBinanceOptions.mockResolvedValue({ configured: true, alias: 'Principal', apiKeyMasked: 'hT9x***' });
    const user = userEvent.setup();
    render(<BinanceOptionsSection />);
    const alias = await screen.findByDisplayValue('Principal');
    await user.clear(alias);
    await user.type(alias, 'Cuenta B');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(settingsApi.saveBinanceOptions).toHaveBeenCalledWith({
      alias: 'Cuenta B', apiKey: undefined, apiSecret: undefined,
    }));
  });

  it('probar conexión muestra cada comprobación con su estado', async () => {
    settingsApi.getBinanceOptions.mockResolvedValue({ configured: true, alias: 'Principal' });
    settingsApi.testBinanceOptions.mockResolvedValue({
      checks: [
        { id: 'signature', label: 'Firma válida', status: 'ok', detail: 'La API key y el secret coinciden' },
        { id: 'ip', label: 'Restricción por IP', status: 'warn', detail: 'Sin restringir' },
      ],
    });
    const user = userEvent.setup();
    render(<BinanceOptionsSection />);
    await user.click(await screen.findByRole('button', { name: 'Probar conexión' }));
    const list = await screen.findByRole('list', { name: 'Resultado de la prueba' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Firma válida');
    expect(items[0].textContent).toContain('(Correcto)');
    expect(items[1].textContent).toContain('(Aviso)');
    expect(screen.getByText('Conectada · con avisos')).toBeTruthy();
  });

  it('un fallo en la prueba marca la conexión con error', async () => {
    settingsApi.getBinanceOptions.mockResolvedValue({ configured: true });
    settingsApi.testBinanceOptions.mockResolvedValue({
      checks: [{ id: 'signature', label: 'Firma válida', status: 'fail', detail: 'Firma incorrecta' }],
    });
    const user = userEvent.setup();
    render(<BinanceOptionsSection />);
    await user.click(await screen.findByRole('button', { name: 'Probar conexión' }));
    expect(await screen.findByText('Error de conexión')).toBeTruthy();
  });

  it('eliminar pide confirmación antes de borrar', async () => {
    settingsApi.getBinanceOptions.mockResolvedValue({ configured: true, alias: 'Principal' });
    const onStatusChange = vi.fn();
    const user = userEvent.setup();
    render(<BinanceOptionsSection onStatusChange={onStatusChange} />);
    await user.click(await screen.findByRole('button', { name: 'Eliminar credenciales' }));
    const dialog = screen.getByRole('dialog', { name: 'Eliminar credenciales' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(settingsApi.deleteBinanceOptions).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Eliminar credenciales' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Eliminar credenciales' })).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(settingsApi.deleteBinanceOptions).toHaveBeenCalled());
    expect(onStatusChange).toHaveBeenCalledWith({ configured: false, alias: null });
    expect(await screen.findByText('Sin configurar')).toBeTruthy();
  });

  it('guarda los límites globales como números', async () => {
    const user = userEvent.setup();
    render(<BinanceOptionsSection />);
    const margin = await screen.findByLabelText('Margen máximo total (USDT)');
    await waitFor(() => expect(margin.value).toBe('5000'));
    await user.clear(margin);
    await user.type(margin, '7.500,5');
    await user.click(screen.getByLabelText('Avisar por Telegram cada orden enviada por una estrategia'));
    await user.click(screen.getByRole('button', { name: 'Guardar límites' }));
    await waitFor(() => expect(settingsApi.saveOptionsLimits).toHaveBeenCalledWith({
      maxMarginUsdt: 7500.5, maxDailyLossUsdt: 500, maxLiveStrategies: 3, notifyTelegram: false,
    }));
  });

  it('rechaza límites inválidos sin llamar a la API', async () => {
    const user = userEvent.setup();
    render(<BinanceOptionsSection />);
    const live = await screen.findByLabelText('Estrategias reales simultáneas');
    await waitFor(() => expect(live.value).toBe('3'));
    await user.clear(live);
    await user.type(live, '1,5');
    await user.click(screen.getByRole('button', { name: 'Guardar límites' }));
    expect((await screen.findByRole('alert')).textContent).toContain('entero');
    expect(settingsApi.saveOptionsLimits).not.toHaveBeenCalled();
  });
});
