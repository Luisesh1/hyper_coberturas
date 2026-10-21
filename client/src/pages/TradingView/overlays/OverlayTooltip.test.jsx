import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OverlayTooltip from './OverlayTooltip';

const T = Date.UTC(2026, 9, 16, 3) / 1000;

describe('OverlayTooltip', () => {
  it('una fila por serie; opción sin operaciones muestra la última operación', () => {
    render(
      <OverlayTooltip
        variant="desktop"
        time={T}
        timeframe="1h"
        main={{ label: 'ETH/USDT', value: 2426.4, changePct: 0.6 }}
        rows={[
          { id: 'option:ETH-31OCT26-2500-C', label: 'ETH 31 oct · C 2500', color: '#f59e0b', value: 17.42, changePct: 9.2, traded: false, lastTradeAgoH: 3 },
          { id: 'asset:binance:BTCUSDT', label: 'BTC/USDT', color: '#22d3ee', value: 110954, changePct: 0.2, traded: true, lastTradeAgoH: null },
          { id: 'asset:binance:SOLUSDT', label: 'SOL/USDT', color: '#a78bfa', value: 207.09, changePct: -1, traded: true, hidden: true },
        ]}
      />,
    );
    expect(screen.getByText('16 oct 03:00 · vela 1h')).toBeTruthy();
    expect(screen.getByText('ETH/USDT')).toBeTruthy();
    expect(screen.getByText('ETH 31 oct · C 2500')).toBeTruthy();
    expect(screen.getByText('BTC/USDT')).toBeTruthy();
    expect(screen.getByText('Última operación hace 3 h')).toBeTruthy();
    expect(screen.getByText('$17.42')).toBeTruthy();
    expect(screen.queryByText('SOL/USDT')).toBeNull();
    expect(screen.getAllByText('Última operación hace 3 h')).toHaveLength(1);
  });

  it('valor ausente se muestra como guion', () => {
    render(
      <OverlayTooltip
        variant="desktop"
        time={T}
        main={{ label: 'ETH/USDT', value: 2426.4, changePct: null }}
        rows={[{ id: 'asset:yahoo:SPX', label: 'SPX', color: '#f472b6', value: null, changePct: null, traded: null, lastTradeAgoH: null }]}
      />,
    );
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('OverlayTooltip (móvil)', () => {
  it('una línea por serie y acción en la cabecera', () => {
    render(
      <OverlayTooltip
        variant="mobile"
        time={T}
        timeframe="1h"
        action={<button type="button">Contraer</button>}
        main={{ label: 'ETH/USDT', value: 2426.4, changePct: 0.6 }}
        rows={[
          { id: 'option:ETH-31OCT26-2500-C', label: 'ETH 31 oct · C 2500', color: '#f59e0b', value: 17.42, changePct: 9.2, traded: false, lastTradeAgoH: 5 },
          { id: 'asset:binance:BTCUSDT', label: 'BTC/USDT', color: '#22d3ee', value: 110954, changePct: 0.2, traded: true },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Contraer' })).toBeTruthy();
    expect(screen.getByText('ETH/USDT')).toBeTruthy();
    expect(screen.getByText('BTC/USDT')).toBeTruthy();
    expect(screen.getByText('Última operación hace 5 h')).toBeTruthy();
  });

  it('plegado solo deja la cabecera', () => {
    render(
      <OverlayTooltip
        variant="mobile"
        collapsed
        time={T}
        main={{ label: 'ETH/USDT', value: 2426.4, changePct: 0.6 }}
        rows={[{ id: 'asset:binance:BTCUSDT', label: 'BTC/USDT', color: '#22d3ee', value: 110954, changePct: 0.2, traded: true }]}
      />,
    );
    expect(screen.queryByText('BTC/USDT')).toBeNull();
    expect(screen.queryByText('ETH/USDT')).toBeNull();
  });
});
