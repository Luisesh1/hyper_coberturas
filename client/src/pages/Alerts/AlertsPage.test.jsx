import { describe, expect, it, vi } from 'vitest';
import { normalizeLoadedRule } from './AlertsPage';

describe('normalizeLoadedRule', () => {
  it('conserva un peso explícito de cero al abrir una alerta', () => {
    const rule = normalizeLoadedRule({
      label: 'Solo informativa',
      weight: 0,
      conditions: [{
        indicatorType: 'rsi',
        timeframe: '15m',
        operator: '<',
        operand: { kind: 'constant', value: 30 },
      }],
      joiners: [],
    });

    expect(rule.weight).toBe(0);
  });
});

describe('AlertsPage · escritorio', () => {
  it('sin isMobile no monta ningún componente de mobile/', async () => {
    vi.resetModules();
    const listSpy = vi.fn(() => null);
    const editorSpy = vi.fn(() => null);
    vi.doMock('./mobile/MobileAlertList', () => ({ default: listSpy }));
    vi.doMock('./mobile/MobileAlertEditor', () => ({ default: editorSpy }));
    vi.doMock('../../services/api', () => ({
      alertsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn() },
      request: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../context/TradingContext', () => ({ useTradingContext: () => ({ addNotification: vi.fn() }) }));
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const { fireEvent, render, screen } = await import('@testing-library/react');
      const { MemoryRouter } = await import('react-router-dom');
      const { default: Page } = await import('./AlertsPage');
      render(<MemoryRouter><Page /></MemoryRouter>);
      await screen.findByText('Aún no tienes alertas. Crea la primera.');
      fireEvent.click(screen.getByRole('button', { name: '+ Nueva alerta' }));
      await screen.findByText('Alertas con reglas y peso');
      expect(listSpy).not.toHaveBeenCalled();
      expect(editorSpy).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = originalMatchMedia;
      vi.doUnmock('./mobile/MobileAlertList');
      vi.doUnmock('./mobile/MobileAlertEditor');
      vi.doUnmock('../../services/api');
      vi.doUnmock('../../context/TradingContext');
    }
  });
});
