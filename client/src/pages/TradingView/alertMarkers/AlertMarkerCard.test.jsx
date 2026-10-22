import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AlertMarkerCard from './AlertMarkerCard';

const alertsById = { 1: { id: 1, name: 'Cruce RSI', direction: 'bullish', rules: [{ conditions: [{ indicatorType: 'RSI', timeframe: '15m' }] }] } };
const colorsById = { 1: '#facc15' };
const ev = (extra = {}) => ({
  evalTime: new Date(2026, 9, 21, 14, 30).getTime(), time: 0, score: 83.4, threshold: 70, suppressed: false,
  rules: [
    { indicatorType: 'RSI', timeframe: '15m', conditions: [{ indicatorType: 'RSI', timeframe: '15m' }, { indicatorType: 'EMA', timeframe: '4h' }], weight: 2, matched: true, reason: 'RSI 28 < 30' },
    { indicatorType: 'MACD', timeframe: '1h', conditions: [{ indicatorType: 'MACD', timeframe: '1h' }], weight: 1, matched: false, reason: 'sin cruce' },
  ],
  ...extra,
});

function setup(props = {}) {
  const h = { onPrev: vi.fn(), onNext: vi.fn(), onClose: vi.fn() };
  render(
    <AlertMarkerCard
      mobile={false}
      entries={[{ alertId: 1, event: ev() }, { alertId: 1, event: ev({ suppressed: true }) }]}
      alertsById={alertsById}
      colorsById={colorsById}
      index={0}
      {...h}
      {...props}
    />,
  );
  return h;
}

describe('AlertMarkerCard', () => {
  it('muestra nombre, puntuación, y ✅/❌ por regla con condiciones y razón', () => {
    setup();
    expect(screen.getByText('Cruce RSI')).toBeTruthy();
    expect(screen.getByText('Puntuación 83% (umbral 70%)')).toBeTruthy();
    expect(screen.getAllByText('✅')).toHaveLength(1);
    expect(screen.getAllByText('❌')).toHaveLength(1);
    expect(screen.getByText('RSI 15m · EMA 4h')).toBeTruthy();
    expect(screen.getByText('RSI 28 < 30')).toBeTruthy();
    expect(screen.getByText(/peso 2/)).toBeTruthy();
    expect(screen.getByText(/21\/10\/2026|2026/)).toBeTruthy();
  });

  it('suprimido muestra la etiqueta de cooldown', () => {
    setup({ entries: [{ alertId: 1, event: ev({ suppressed: true }) }] });
    expect(screen.getByText('suprimido por cooldown')).toBeTruthy();
  });

  it('varios eventos en la misma vela se listan todos', () => {
    setup({ entries: [{ alertId: 1, event: ev() }, { alertId: 1, event: ev({ score: 90 }) }], index: undefined });
    expect(screen.getByText('Puntuación 83% (umbral 70%)')).toBeTruthy();
    expect(screen.getByText('Puntuación 90% (umbral 70%)')).toBeTruthy();
  });

  it('móvil: «siguiente» llama a onNext y «anterior» a onPrev', () => {
    const h = setup({ mobile: true });
    expect(screen.getByRole('button', { name: /anterior/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /siguiente/ }));
    expect(h.onNext).toHaveBeenCalled();
  });

  it('móvil: en el segundo evento «anterior» llama a onPrev', () => {
    const h = setup({ mobile: true, index: 1 });
    fireEvent.click(screen.getByRole('button', { name: /anterior/ }));
    expect(h.onPrev).toHaveBeenCalled();
  });

  it('escritorio: «siguiente» llama a onNext y cerrar a onClose', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: /siguiente/ }));
    expect(h.onNext).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(h.onClose).toHaveBeenCalled();
  });
});
