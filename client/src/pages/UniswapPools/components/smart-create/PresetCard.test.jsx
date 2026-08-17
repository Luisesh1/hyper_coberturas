import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import PresetCard from './PresetCard';
import { deriveRangeWidthPct } from '../../../../features/lp-wizard/useUnifiedLpFlow';

/**
 * El backend publica `widthPct` como ancho TOTAL del rango
 * (`(upper - lower) / currentPrice`), mientras que el resto del wizard —y el
 * `rangeWidthPct` que se persiste— usan el SEMIANCHO, que es lo que significa
 * el signo ±. Pintar el total con ± duplicaba el ancho percibido y hacía que
 * esta tarjeta y el resumen del plan se contradijeran por un factor 2.
 */
describe('PresetCard', () => {
  const preset = {
    preset: 'balanced',
    label: 'Balanceado',
    rangeLowerPrice: 2910,
    rangeUpperPrice: 3090,
    widthPct: 6,
    targetWeightToken0Pct: 50,
  };

  it('muestra el semiancho junto al ±, no el ancho total', () => {
    render(<PresetCard preset={preset} selected={false} onClick={() => {}} />);
    expect(screen.getByText('±3%')).toBeTruthy();
    expect(screen.queryByText('±6%')).toBeNull();
  });

  it('coincide con el ancho que deriva el flujo del rango elegido', () => {
    const derived = deriveRangeWidthPct({
      rangeLowerPrice: preset.rangeLowerPrice,
      rangeUpperPrice: preset.rangeUpperPrice,
      priceCurrent: 3000,
    });
    render(<PresetCard preset={preset} selected={false} onClick={() => {}} />);
    expect(screen.getByText(`±${derived}%`)).toBeTruthy();
  });

  it('conserva los decimales del semiancho en anchos impares', () => {
    render(
      <PresetCard preset={{ ...preset, widthPct: 8.3 }} selected={false} onClick={() => {}} />
    );
    expect(screen.getByText('±4.15%')).toBeTruthy();
  });
});
