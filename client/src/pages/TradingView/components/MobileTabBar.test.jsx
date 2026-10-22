import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MobileTabBar from './MobileTabBar';

function renderBar(props = {}) {
  const handlers = {
    onIndicators: vi.fn(), onDraw: vi.fn(), onOverlays: vi.fn(), onAlerts: vi.fn(), onReplay: vi.fn(), onSettings: vi.fn(),
  };
  render(<MobileTabBar indicatorsCount={0} overlaysCount={0} {...handlers} {...props} />);
  return handlers;
}

describe('MobileTabBar', () => {
  it('seis pestañas: "Alertas" va entre Superponer y Replay', () => {
    renderBar();
    const nav = screen.getByRole('navigation', { name: 'Herramientas del gráfico' });
    const labels = within(nav).getAllByRole('button').map((b) => b.textContent.replace(/\d+$/, '').trim());
    expect(labels).toEqual(['Indicadores', 'Dibujar', 'Superponer', 'Alertas', 'Replay', 'Ajustes']);
  });

  it('la pestaña "Superponer" muestra la insignia con el número y abre el selector', () => {
    const h = renderBar({ overlaysCount: 3 });
    const tab = screen.getByRole('button', { name: 'Superponer, 3 superposiciones' });
    expect(within(tab).getByText('3').getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(tab);
    expect(h.onOverlays).toHaveBeenCalled();
  });

  it('sin superposiciones no hay insignia', () => {
    renderBar({ overlaysCount: 0 });
    const tab = screen.getByRole('button', { name: 'Superponer' });
    expect(tab.textContent.trim()).toBe('Superponer');
  });

  it('la pestaña "Alertas" muestra el contador y abre el selector', () => {
    const h = renderBar({ alertsCount: 2 });
    const tab = screen.getByRole('button', { name: 'Alertas, 2 en el gráfico' });
    expect(within(tab).getByText('2').getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(tab);
    expect(h.onAlerts).toHaveBeenCalled();
  });

  it('sin alertas elegidas no hay contador', () => {
    renderBar({ alertsCount: 0 });
    expect(screen.getByRole('button', { name: 'Alertas' }).textContent.trim()).toBe('Alertas');
  });
});
