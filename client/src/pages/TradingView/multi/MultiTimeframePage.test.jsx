import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./SyncedChart', () => ({
  default: (props) => (
    <div
      data-testid={`synced-chart-${props.index}`}
      data-tf={props.timeframe}
      data-sync={JSON.stringify(props.sync)}
      data-sync-enabled={String(props.syncEnabled)}
      data-compact={String(!!props.compact)}
      data-symbol={props.asset.symbol}
      data-datasource={props.asset.datasource}
      data-indicators={JSON.stringify(props.indicators ?? null)}
    >
      <button
        type="button"
        data-testid={`pointer-${props.index}`}
        onClick={() => props.onPointer(props.index, { timeSec: Date.UTC(2025, 9, 19, 20, 45) / 1000, price: 100 })}
      />
      <button type="button" data-testid={`pointer-clear-${props.index}`} onClick={() => props.onPointer(props.index, null)} />
      <button type="button" data-testid={`price-${props.index}`} onClick={() => props.onLastPrice?.(props.index, 2345.5 + props.index)} />
      <button type="button" data-testid={`tf-${props.index}`} onClick={() => props.onTimeframeChange('1m')} />
    </div>
  ),
}));

const api = vi.hoisted(() => ({ getChartIndicators: null }));
vi.mock('../../../services/api', () => ({
  settingsApi: { getChartIndicators: (...a) => api.getChartIndicators(...a) },
}));

vi.mock('../../../context/TradingContext', () => ({
  useTradingContext: () => ({ selectedAsset: 'SOL' }),
}));

vi.mock('../components/AssetPickerModal', () => ({
  default: ({ open, onSelect }) => (open
    ? <button type="button" data-testid="picker-pick" onClick={() => onSelect({ symbol: 'ETH', datasource: 'binance', name: 'Ether' })} />
    : null),
}));

import { waitFor } from '@testing-library/react';
import MultiTimeframePage from './MultiTimeframePage';
import { getDefaultChartIndicators } from '../indicators/defaults';

function setMobile(isMobile) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: isMobile,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function renderPage(url = '/trading-view/multi') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <MultiTimeframePage />
    </MemoryRouter>,
  );
}

const tfs = () => screen.getAllByTestId(/^synced-chart-\d+$/).map((el) => el.dataset.tf);

describe('MultiTimeframePage', () => {
  beforeEach(() => {
    localStorage.clear();
    api.getChartIndicators = vi.fn().mockResolvedValue({ indicators: [] });
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb) => { cb(0); return 1; }));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    setMobile(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.classList.remove('tv-mobile-chrome');
  });

  it('escritorio sin prefs: 4 paneles 5m,15m,1h,4h y 2×2 activo', () => {
    renderPage();
    expect(tfs()).toEqual(['5m', '15m', '1h', '4h']);
    expect(screen.getByRole('button', { name: '2×2' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '1×3' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('pulsar 1×3 muestra 3 paneles y guarda prefs', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '1×3' }));
    expect(tfs()).toEqual(['5m', '15m', '1h']);
    expect(JSON.parse(localStorage.getItem('tv_multi_prefs_v1')).layout).toBe('1x3');
  });

  it('onPointer propaga sourceIndex a todos y muestra la lectura del puntero', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pointer-1'));
    for (let i = 0; i < 4; i += 1) {
      expect(JSON.parse(screen.getByTestId(`synced-chart-${i}`).dataset.sync).sourceIndex).toBe(1);
    }
    expect(screen.getByText('Puntero: 19 oct 20:45 · 15m')).toBeTruthy();
  });

  it('onPointer(null) limpia el puntero', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pointer-1'));
    fireEvent.click(screen.getByTestId('pointer-clear-1'));
    expect(screen.getByTestId('synced-chart-0').dataset.sync).toBe('null');
  });

  it('si el origen desaparece al cambiar de distribución, sync pasa a null', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pointer-3'));
    expect(JSON.parse(screen.getByTestId('synced-chart-0').dataset.sync).sourceIndex).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: '1×2' }));
    expect(tfs()).toEqual(['5m', '15m']);
    expect(screen.getByTestId('synced-chart-0').dataset.sync).toBe('null');
  });

  it('el conmutador "Puntero sincronizado" desactiva syncEnabled', () => {
    renderPage();
    fireEvent.click(screen.getByRole('switch', { name: /Puntero sincronizado/i }));
    for (const el of screen.getAllByTestId(/^synced-chart-\d+$/)) {
      expect(el.dataset.syncEnabled).toBe('false');
    }
  });

  it('móvil: 3 paneles compactos 5m,1h,4h, volver y pista táctil', () => {
    setMobile(true);
    renderPage();
    expect(tfs()).toEqual(['5m', '1h', '4h']);
    for (const el of screen.getAllByTestId(/^synced-chart-\d+$/)) {
      expect(el.dataset.compact).toBe('true');
    }
    expect(screen.getByRole('link', { name: /gráfico único/i }).getAttribute('href')).toBe('/trading-view');
    expect(screen.getByText('Mantén pulsado y arrastra sobre un gráfico')).toBeTruthy();
    expect(document.body.classList.contains('tv-mobile-chrome')).toBe(true);
  });

  it('móvil: limpia la clase del body al desmontar', () => {
    setMobile(true);
    const { unmount } = renderPage();
    unmount();
    expect(document.body.classList.contains('tv-mobile-chrome')).toBe(false);
  });

  it('usa symbol y datasource de la URL', () => {
    renderPage('/trading-view/multi?symbol=BTC&datasource=binance');
    const el = screen.getByTestId('synced-chart-0');
    expect(el.dataset.symbol).toBe('BTC');
    expect(el.dataset.datasource).toBe('binance');
  });

  it('sin URL usa el activo guardado y, si no, el del contexto', () => {
    localStorage.setItem('tv_selected_asset_v1', JSON.stringify({ symbol: 'XRP', datasource: 'binance', name: 'XRP' }));
    const { unmount } = renderPage();
    expect(screen.getByTestId('synced-chart-0').dataset.symbol).toBe('XRP');
    unmount();
    localStorage.clear();
    renderPage();
    expect(screen.getByTestId('synced-chart-0').dataset.symbol).toBe('SOL');
    expect(screen.getByTestId('synced-chart-0').dataset.datasource).toBe('hyperliquid');
  });

  it('elegir un par en el selector actualiza paneles y lo guarda', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Cambiar par/i }));
    fireEvent.click(screen.getByTestId('picker-pick'));
    expect(screen.getByTestId('synced-chart-2').dataset.symbol).toBe('ETH');
    expect(JSON.parse(localStorage.getItem('tv_selected_asset_v1')).symbol).toBe('ETH');
  });

  it('móvil: el botón Sync alterna la sincronización', () => {
    setMobile(true);
    renderPage();
    const sw = screen.getByRole('switch', { name: /Puntero sincronizado/i });
    expect(sw.textContent).toBe('Sync');
    fireEvent.click(sw);
    expect(screen.getByTestId('synced-chart-0').dataset.syncEnabled).toBe('false');
  });

  it('con la sincronización apagada onPointer no programa actualizaciones', () => {
    renderPage();
    fireEvent.click(screen.getByRole('switch', { name: /Puntero sincronizado/i }));
    requestAnimationFrame.mockClear();
    fireEvent.click(screen.getByTestId('pointer-1'));
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(screen.getByTestId('synced-chart-0').dataset.sync).toBe('null');
  });

  it('precio de la barra superior: solo el del panel 0, con formatPrice', () => {
    renderPage();
    expect(screen.queryByTestId('multi-price')).toBeNull();
    fireEvent.click(screen.getByTestId('price-1'));
    expect(screen.queryByTestId('multi-price')).toBeNull();
    fireEvent.click(screen.getByTestId('price-0'));
    expect(screen.getByTestId('multi-price').textContent).toBe('2,345.50');
  });

  it('el precio se reinicia al cambiar de par o la temporalidad del panel 0', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('price-0'));
    expect(screen.getByTestId('multi-price')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tf-1'));
    expect(screen.getByTestId('multi-price')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tf-0'));
    expect(screen.queryByTestId('multi-price')).toBeNull();

    fireEvent.click(screen.getByTestId('price-0'));
    expect(screen.getByTestId('multi-price')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cambiar par/i }));
    fireEvent.click(screen.getByTestId('picker-pick'));
    expect(screen.queryByTestId('multi-price')).toBeNull();
  });

  it('móvil: el precio aparece en la cabecera', () => {
    setMobile(true);
    renderPage();
    fireEvent.click(screen.getByTestId('price-0'));
    expect(screen.getByTestId('multi-price').textContent).toBe('2,345.50');
  });

  const indicatorsOf = (i) => JSON.parse(screen.getByTestId(`synced-chart-${i}`).dataset.indicators);

  it('indicadores: carga la lista guardada una vez y la pasa a cada gráfico', async () => {
    const saved = [{ uid: 'r1', type: 'rsi', params: { length: 14 }, style: {}, visible: true }];
    api.getChartIndicators.mockResolvedValue({ indicators: saved });
    renderPage();
    await waitFor(() => expect(indicatorsOf(0)).toEqual(saved));
    for (let i = 1; i < 4; i += 1) expect(indicatorsOf(i)).toEqual(saved);
    fireEvent.click(screen.getByRole('button', { name: '1×3' }));
    expect(api.getChartIndicators).toHaveBeenCalledTimes(1);
  });

  it('indicadores: lista vacía → defaults', async () => {
    renderPage();
    await waitFor(() => expect(indicatorsOf(0)).toEqual(getDefaultChartIndicators().indicators));
  });

  it('indicadores: error al cargar → defaults sin romper', async () => {
    api.getChartIndicators.mockRejectedValue(new Error('500'));
    renderPage();
    await waitFor(() => expect(indicatorsOf(2)).toEqual(getDefaultChartIndicators().indicators));
    expect(tfs()).toEqual(['5m', '15m', '1h', '4h']);
  });
});
