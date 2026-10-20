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
    >
      <button
        type="button"
        data-testid={`pointer-${props.index}`}
        onClick={() => props.onPointer(props.index, { timeSec: Date.UTC(2025, 9, 19, 20, 45) / 1000, price: 100 })}
      />
      <button type="button" data-testid={`pointer-clear-${props.index}`} onClick={() => props.onPointer(props.index, null)} />
    </div>
  ),
}));

vi.mock('./crosshairSync', () => {
  const KEY = 'tv_multi_prefs_v1';
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const defaults = () => ({
    layout: '2x2',
    timeframes: ['5m', '15m', '1h', '4h'],
    mobileTimeframes: ['5m', '1h', '4h'],
    sync: true,
  });
  return {
    SYNC_COLORS: { exact: '#3ddc84', near: '#b8860b', out: '#8690a0' },
    MULTI_TIMEFRAMES: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'],
    LAYOUTS: [
      { id: '1x2', label: '1×2', count: 2, cols: 2, rows: 1 },
      { id: '1x3', label: '1×3', count: 3, cols: 3, rows: 1 },
      { id: '2x2', label: '2×2', count: 4, cols: 2, rows: 2 },
    ],
    formatSyncTime: (sec) => {
      const d = new Date(sec * 1000);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    },
    loadMultiPrefs: () => {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? { ...defaults(), ...JSON.parse(raw) } : defaults();
      } catch { return defaults(); }
    },
    saveMultiPrefs: (p) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* noop */ } },
  };
});

vi.mock('../../../context/TradingContext', () => ({
  useTradingContext: () => ({ selectedAsset: 'SOL' }),
}));

vi.mock('../components/AssetPickerModal', () => ({
  default: ({ open, onSelect }) => (open
    ? <button type="button" data-testid="picker-pick" onClick={() => onSelect({ symbol: 'ETH', datasource: 'binance', name: 'Ether' })} />
    : null),
}));

import MultiTimeframePage from './MultiTimeframePage';

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
    vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 1; });
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
});
