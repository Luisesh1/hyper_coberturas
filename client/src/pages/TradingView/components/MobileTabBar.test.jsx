import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MobileTabBar from './MobileTabBar';

function renderBar(props = {}) {
  const handlers = {
    onIndicators: vi.fn(), onDraw: vi.fn(), onOverlays: vi.fn(), onReplay: vi.fn(), onSettings: vi.fn(),
  };
  render(<MobileTabBar indicatorsCount={0} overlaysCount={0} {...handlers} {...props} />);
  return handlers;
}

describe('MobileTabBar', () => {
  it('cinco pestañas: "Superponer" va entre Dibujar y Replay', () => {
    renderBar();
    const nav = screen.getByRole('navigation', { name: 'Herramientas del gráfico' });
    const labels = within(nav).getAllByRole('button').map((b) => b.textContent.trim());
    expect(labels).toEqual(['Indicadores', 'Dibujar', 'Superponer', 'Replay', 'Ajustes']);
  });

  it('la pestaña "Superponer" muestra la insignia con el número y abre el selector', () => {
    const h = renderBar({ overlaysCount: 3 });
    const tab = screen.getByRole('button', { name: /Superponer/ });
    expect(within(tab).getByText('3')).toBeTruthy();
    fireEvent.click(tab);
    expect(h.onOverlays).toHaveBeenCalled();
  });

  it('sin superposiciones no hay insignia', () => {
    renderBar({ overlaysCount: 0 });
    const tab = screen.getByRole('button', { name: /Superponer/ });
    expect(tab.textContent.trim()).toBe('Superponer');
  });
});
