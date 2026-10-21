import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import OverlayLegend, { optionLegendColor } from './OverlayLegend';
import OverlayTooltip from './OverlayTooltip';

const asset = { id: 'asset:binance:BTCUSDT', kind: 'asset', color: '#22d3ee' };
const optA = { id: 'option:ETH-31OCT26-4000-C', kind: 'option', color: '#f59e0b' };
const optB = { id: 'option:ETH-31OCT26-3000-P', kind: 'option', color: '#a78bfa' };

describe('optionLegendColor', () => {
  it('null sin opciones dibujadas (sólo activos, ocultas o desactivadas)', () => {
    expect(optionLegendColor([], {})).toBeNull();
    expect(optionLegendColor([asset], { [asset.id]: 'ready' })).toBeNull();
    expect(optionLegendColor([asset, optA], { [asset.id]: 'ready', [optA.id]: 'hidden' })).toBeNull();
  });
  it('color de la opción enfocada; si no, de la primera dibujada (aunque cargue o falle)', () => {
    const items = [asset, optA, optB];
    const status = { [asset.id]: 'ready', [optA.id]: 'loading', [optB.id]: 'error' };
    expect(optionLegendColor(items, status, optB.id)).toBe('#a78bfa');
    expect(optionLegendColor(items, status, asset.id)).toBe('#f59e0b');
  });
});

describe('OverlayLegend', () => {
  it('no se pinta sin color', () => {
    const { container } = render(<OverlayLegend color={null} />);
    expect(container.firstChild).toBeNull();
  });
  it('escritorio: prima negociada y sin operaciones (último precio arrastrado)', () => {
    render(<OverlayLegend color="#f59e0b" />);
    const legend = screen.getByLabelText('Leyenda de la prima');
    expect(legend.textContent).toContain('Prima negociada');
    expect(legend.textContent).toContain('Sin operaciones (último precio arrastrado)');
  });
  it('móvil: línea compacta dentro de la lectura, oculta al plegar', () => {
    const footer = <OverlayLegend color="#f59e0b" compact />;
    const { rerender } = render(
      <OverlayTooltip variant="mobile" time={0} timeframe="1h" rows={[]} footer={footer} />,
    );
    expect(screen.getByLabelText('Leyenda de la prima').textContent).toContain('Prima negociada');
    rerender(<OverlayTooltip variant="mobile" time={0} timeframe="1h" rows={[]} footer={footer} collapsed />);
    expect(screen.queryByLabelText('Leyenda de la prima')).toBeNull();
  });
});
