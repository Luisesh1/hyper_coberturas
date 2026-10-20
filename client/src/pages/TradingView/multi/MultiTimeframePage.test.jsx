import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
      data-sync-price={String(props.syncPrice ?? true)}
    >
      {props.onAssetClick && (
        <button type="button" data-testid={`asset-btn-${props.index}`} onClick={() => props.onAssetClick(props.index)}>
          {props.asset.symbol}
        </button>
      )}
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

const api = vi.hoisted(() => ({ getChartIndicators: null, pick: null }));
vi.mock('../../../services/api', () => ({
  settingsApi: { getChartIndicators: (...a) => api.getChartIndicators(...a) },
}));

vi.mock('../../../context/TradingContext', () => ({
  useTradingContext: () => ({ selectedAsset: 'SOL' }),
}));

vi.mock('../components/AssetPickerModal', () => ({
  default: ({ open, onSelect, currentAsset }) => (open
    ? (
      <button
        type="button"
        data-testid="picker-pick"
        data-current={currentAsset?.symbol}
        onClick={() => onSelect(api.pick || { symbol: 'ETH', datasource: 'binance', name: 'Ether' })}
      />
    )
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
    api.pick = null;
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

  describe('modo Multi‑activo', () => {
    const symbols = () => screen.getAllByTestId(/^synced-chart-\d+$/).map((el) => el.dataset.symbol);
    const modeBtn = (name) => screen.getByRole('button', { name: new RegExp(`^${name}$`) });
    const splitPrefs = () => JSON.parse(localStorage.getItem('tv_split_prefs_v1'));

    it('selector de modo con Multi‑TF / Multi‑activo (aria-pressed); por defecto Multi‑TF', () => {
      renderPage();
      expect(modeBtn('Multi‑TF').getAttribute('aria-pressed')).toBe('true');
      expect(modeBtn('Multi‑activo').getAttribute('aria-pressed')).toBe('false');
      expect(tfs()).toEqual(['5m', '15m', '1h', '4h']);
    });

    it('?mode=assets abre Multi‑activo', () => {
      renderPage('/trading-view/multi?mode=assets');
      expect(modeBtn('Multi‑activo').getAttribute('aria-pressed')).toBe('true');
      expect(symbols()).toEqual(['BTC', 'ETH', 'SOL', 'HYPE']);
    });

    it('?mode=tf manda sobre el modo guardado', () => {
      localStorage.setItem('tv_multi_mode_v1', 'assets');
      renderPage('/trading-view/multi?mode=tf');
      expect(modeBtn('Multi‑TF').getAttribute('aria-pressed')).toBe('true');
    });

    it('sin parámetro usa el modo guardado', () => {
      localStorage.setItem('tv_multi_mode_v1', 'assets');
      renderPage();
      expect(modeBtn('Multi‑activo').getAttribute('aria-pressed')).toBe('true');
    });

    it('escritorio sin prefs: 4 paneles BTC,ETH,SOL,HYPE 15m sin sincronizar y sin precio', () => {
      renderPage('/trading-view/multi?mode=assets');
      const els = screen.getAllByTestId(/^synced-chart-\d+$/);
      expect(symbols()).toEqual(['BTC', 'ETH', 'SOL', 'HYPE']);
      for (const el of els) {
        expect(el.dataset.tf).toBe('15m');
        expect(el.dataset.datasource).toBe('hyperliquid');
        expect(el.dataset.syncEnabled).toBe('false');
        expect(el.dataset.syncPrice).toBe('false');
        expect(el.dataset.compact).toBe('false');
      }
      for (let i = 0; i < 4; i += 1) expect(screen.getByTestId(`asset-btn-${i}`)).toBeTruthy();
      expect(screen.getByRole('button', { name: '2×2' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.queryByRole('button', { name: /Cambiar par/i })).toBeNull();
      expect(screen.getByRole('switch', { name: /Puntero sincronizado/i }).getAttribute('aria-checked')).toBe('false');
      fireEvent.click(screen.getByTestId('price-0'));
      expect(screen.queryByTestId('multi-price')).toBeNull();
    });

    it('Multi‑TF no pasa onAssetClick ni desactiva syncPrice', () => {
      renderPage();
      expect(screen.queryByTestId('asset-btn-0')).toBeNull();
      expect(screen.getByTestId('synced-chart-0').dataset.syncPrice).toBe('true');
    });

    it('onAssetClick(2) abre el selector y elegir DOGE solo cambia el panel 2', () => {
      api.pick = { symbol: 'DOGE', datasource: 'binance', name: 'Dogecoin' };
      renderPage('/trading-view/multi?mode=assets');
      expect(screen.queryByTestId('picker-pick')).toBeNull();
      fireEvent.click(screen.getByTestId('asset-btn-2'));
      expect(screen.getByTestId('picker-pick').dataset.current).toBe('SOL');
      fireEvent.click(screen.getByTestId('picker-pick'));
      expect(screen.queryByTestId('picker-pick')).toBeNull();
      expect(symbols()).toEqual(['BTC', 'ETH', 'DOGE', 'HYPE']);
      expect(screen.getByTestId('synced-chart-2').dataset.datasource).toBe('binance');
      expect(screen.getByTestId('synced-chart-2').dataset.tf).toBe('15m');
      expect(splitPrefs().panels[2]).toEqual({ symbol: 'DOGE', datasource: 'binance', timeframe: '15m' });
      // No toca el par de Multi‑TF.
      expect(localStorage.getItem('tv_selected_asset_v1')).toBeNull();
    });

    it('la temporalidad es por panel y se guarda', () => {
      renderPage('/trading-view/multi?mode=assets');
      fireEvent.click(screen.getByTestId('tf-3'));
      expect(tfs()).toEqual(['15m', '15m', '15m', '1m']);
      expect(splitPrefs().panels[3].timeframe).toBe('1m');
    });

    it('interruptor: activa la sincronización (solo en las prefs de Multi‑activo)', () => {
      renderPage('/trading-view/multi?mode=assets');
      fireEvent.click(screen.getByRole('switch', { name: /Puntero sincronizado/i }));
      expect(screen.getByTestId('synced-chart-0').dataset.syncEnabled).toBe('true');
      expect(splitPrefs().sync).toBe(true);
      expect(localStorage.getItem('tv_multi_prefs_v1')).toBeNull();
    });

    it('con sync apagado onPointer no hace nada', () => {
      renderPage('/trading-view/multi?mode=assets');
      requestAnimationFrame.mockClear();
      fireEvent.click(screen.getByTestId('pointer-0'));
      expect(requestAnimationFrame).not.toHaveBeenCalled();
      expect(screen.getByText('Puntero: —')).toBeTruthy();
    });

    it('barra "Puntero: … · BTC 15m" con sync', () => {
      renderPage('/trading-view/multi?mode=assets');
      fireEvent.click(screen.getByRole('switch', { name: /Puntero sincronizado/i }));
      fireEvent.click(screen.getByTestId('pointer-0'));
      expect(screen.getByText('Puntero: 19 oct 20:45 · BTC 15m')).toBeTruthy();
      for (let i = 0; i < 4; i += 1) {
        expect(JSON.parse(screen.getByTestId(`synced-chart-${i}`).dataset.sync).sourceIndex).toBe(0);
      }
    });

    it('cambiar el activo del panel origen limpia el puntero; otro panel no', () => {
      api.pick = { symbol: 'DOGE', datasource: 'binance', name: 'Dogecoin' };
      renderPage('/trading-view/multi?mode=assets');
      fireEvent.click(screen.getByRole('switch', { name: /Puntero sincronizado/i }));
      fireEvent.click(screen.getByTestId('pointer-2'));
      fireEvent.click(screen.getByTestId('asset-btn-1'));
      fireEvent.click(screen.getByTestId('picker-pick'));
      expect(JSON.parse(screen.getByTestId('synced-chart-0').dataset.sync).sourceIndex).toBe(2);
      fireEvent.click(screen.getByTestId('asset-btn-2'));
      fireEvent.click(screen.getByTestId('picker-pick'));
      expect(screen.getByTestId('synced-chart-0').dataset.sync).toBe('null');
    });

    it('si el origen desaparece al cambiar de distribución, sync pasa a null', () => {
      renderPage('/trading-view/multi?mode=assets');
      fireEvent.click(screen.getByRole('switch', { name: /Puntero sincronizado/i }));
      fireEvent.click(screen.getByTestId('pointer-3'));
      fireEvent.click(screen.getByRole('button', { name: '1×3' }));
      expect(symbols()).toEqual(['BTC', 'ETH', 'SOL']);
      expect(screen.getByTestId('synced-chart-0').dataset.sync).toBe('null');
      expect(splitPrefs().layout).toBe('1x3');
    });

    it('cada modo conserva su distribución y paneles; el modo se guarda', () => {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: '1×3' }));
      fireEvent.click(modeBtn('Multi‑activo'));
      expect(localStorage.getItem('tv_multi_mode_v1')).toBe('assets');
      expect(symbols()).toEqual(['BTC', 'ETH', 'SOL', 'HYPE']);
      fireEvent.click(screen.getByRole('button', { name: '1×2' }));
      expect(symbols()).toEqual(['BTC', 'ETH']);
      fireEvent.click(modeBtn('Multi‑TF'));
      expect(localStorage.getItem('tv_multi_mode_v1')).toBe('tf');
      expect(tfs()).toEqual(['5m', '15m', '1h']);
      expect(screen.getByRole('button', { name: '1×3' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(modeBtn('Multi‑activo'));
      expect(symbols()).toEqual(['BTC', 'ETH']);
      expect(screen.getByRole('button', { name: '1×2' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('volver a Multi‑TF desde ?mode=assets no se queda bloqueado por la URL', () => {
      renderPage('/trading-view/multi?mode=assets&symbol=XRP&datasource=binance');
      fireEvent.click(modeBtn('Multi‑TF'));
      expect(modeBtn('Multi‑TF').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('synced-chart-0').dataset.symbol).toBe('XRP');
    });

    it('móvil: 2 paneles compactos BTC, ETH sin precio global y selector de modo ≥44 px', () => {
      setMobile(true);
      renderPage('/trading-view/multi?mode=assets');
      expect(symbols()).toEqual(['BTC', 'ETH']);
      for (const el of screen.getAllByTestId(/^synced-chart-\d+$/)) {
        expect(el.dataset.compact).toBe('true');
        expect(el.dataset.syncPrice).toBe('false');
      }
      fireEvent.click(screen.getByTestId('price-0'));
      expect(screen.queryByTestId('multi-price')).toBeNull();
      expect(screen.queryByRole('button', { name: /Cambiar par/i })).toBeNull();
      for (const name of ['Multi‑TF', 'Multi‑activo']) {
        expect(parseFloat(getComputedStyle(modeBtn(name)).minHeight)).toBeGreaterThanOrEqual(44);
      }
      expect(screen.getByRole('link', { name: /gráfico único/i }).getAttribute('href')).toBe('/trading-view');
      expect(screen.getByText('Mantén pulsado y arrastra sobre un gráfico')).toBeTruthy();
    });

    it('móvil: cambiar un activo solo toca la lista móvil', () => {
      setMobile(true);
      api.pick = { symbol: 'DOGE', datasource: 'binance', name: 'Dogecoin' };
      renderPage('/trading-view/multi?mode=assets');
      fireEvent.click(screen.getByTestId('asset-btn-1'));
      fireEvent.click(screen.getByTestId('picker-pick'));
      expect(symbols()).toEqual(['BTC', 'DOGE']);
      expect(splitPrefs().mobilePanels[1].symbol).toBe('DOGE');
      expect(splitPrefs().panels[1].symbol).toBe('ETH');
    });

    it('cruzar a móvil con el selector abierto en el panel 3 lo cierra y no rompe', () => {
      const listeners = new Set();
      const mql = {
        matches: false,
        media: '',
        addEventListener: (_e, fn) => listeners.add(fn),
        removeEventListener: (_e, fn) => listeners.delete(fn),
      };
      window.matchMedia = vi.fn().mockImplementation(() => mql);
      renderPage('/trading-view/multi?mode=assets');
      fireEvent.click(screen.getByTestId('asset-btn-3'));
      expect(screen.getByTestId('picker-pick')).toBeTruthy();

      mql.matches = true;
      act(() => { listeners.forEach((fn) => fn()); });

      expect(screen.queryByTestId('picker-pick')).toBeNull();
      expect(symbols()).toEqual(['BTC', 'ETH']);
      expect(splitPrefs()?.mobilePanels?.length ?? 2).toBe(2);
    });

    it('móvil Multi‑TF también muestra el selector de modo', () => {
      setMobile(true);
      renderPage();
      expect(modeBtn('Multi‑TF').getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(modeBtn('Multi‑activo'));
      expect(symbols()).toEqual(['BTC', 'ETH']);
    });
  });
});
