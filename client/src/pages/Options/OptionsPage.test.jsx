import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OptionsPage from './OptionsPage';

const { optionsApi, settingsApi } = vi.hoisted(() => ({
  optionsApi: {
    getUnderlyings: vi.fn(),
    getChain: vi.fn(),
    getAccount: vi.fn(),
    getPositions: vi.fn(),
    getOpenOrders: vi.fn(),
    getTrades: vi.fn(),
  },
  settingsApi: { getBinanceOptions: vi.fn(), getOptionsLimits: vi.fn() },
}));

vi.mock('../../services/api', () => ({ optionsApi, settingsApi }));
vi.mock('../../context/TradingContext', () => ({
  useTradingContext: () => ({ addNotification: vi.fn() }),
}));

function setMobile(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="search">{loc.search}</span>;
}

function renderPage(url = '/opciones') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/opciones" element={<><OptionsPage /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setMobile(false);
  optionsApi.getUnderlyings.mockResolvedValue([
    { underlying: 'BTC', spot: 68000, change24hPct: 1.84 },
    { underlying: 'ETH', spot: 2450, change24hPct: -0.5 },
  ]);
  optionsApi.getChain.mockResolvedValue({ underlying: 'BTC', spot: 68000, expiries: [], expiry: null, rows: [] });
  settingsApi.getBinanceOptions.mockResolvedValue({ configured: false });
  settingsApi.getOptionsLimits.mockResolvedValue({});
});

describe('OptionsPage', () => {
  it('muestra la cabecera con spot, variación y enlace para conectar Binance', async () => {
    renderPage();
    expect(await screen.findByText('68.000,00 USDT')).toBeTruthy();
    expect(screen.getByText('+1,84 % 24h')).toBeTruthy();
    const link = await screen.findByRole('link', { name: /Conectar Binance Opciones/ });
    expect(link.getAttribute('href')).toBe('/config?section=binanceOptions');
  });

  it('sincroniza la pestaña con ?tab=', async () => {
    const user = userEvent.setup();
    renderPage('/opciones?tab=backtesting');
    expect(screen.getByText('Backtesting: próximamente.')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Secciones de opciones' });
    expect(within(nav).getByRole('link', { name: /Backtesting/ }).getAttribute('aria-current')).toBe('page');

    await user.click(within(nav).getByRole('link', { name: /Estrategias/ }));
    expect(screen.getByTestId('search').textContent).toBe('?tab=strategies');
    expect(screen.getByText('Estrategias: próximamente.')).toBeTruthy();

    await user.click(within(nav).getByRole('link', { name: /Trading manual/ }));
    expect(screen.getByTestId('search').textContent).toBe('');
    expect(screen.getByRole('region', { name: 'Cadena de opciones' })).toBeTruthy();
  });

  it('una pestaña desconocida cae en Trading manual', () => {
    renderPage('/opciones?tab=nope');
    expect(screen.getByRole('region', { name: 'Cadena de opciones' })).toBeTruthy();
  });

  it('cambiar de subyacente pide su cadena', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'ETH' }));
    await waitFor(() => expect(optionsApi.getChain).toHaveBeenLastCalledWith({ underlying: 'ETH', expiry: undefined }));
  });

  it('en móvil usa el control segmentado y la hoja de subyacentes', async () => {
    setMobile(true);
    const user = userEvent.setup();
    renderPage();
    const nav = screen.getByRole('navigation', { name: 'Secciones de opciones' });
    expect(within(nav).getByRole('link', { name: 'Backtest' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Subyacente: BTC/ }));
    const sheet = screen.getByRole('dialog', { name: 'Subyacente' });
    await user.click(await within(sheet).findByRole('option', { name: /ETH/ }));
    expect(screen.queryByRole('dialog', { name: 'Subyacente' })).toBeNull();
    expect(screen.getByRole('button', { name: /Subyacente: ETH/ })).toBeTruthy();
    // Barra inferior del trading manual móvil
    expect(screen.getByRole('button', { name: /Posiciones/ })).toBeTruthy();
  });
});
