import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RangeTrack from './RangeTrack';

describe('RangeTrack', () => {
  it('muestra el ancho porcentual del rango usando min y max', () => {
    render(
      <RangeTrack
        pool={{
          rangeLowerPrice: 2107,
          rangeUpperPrice: 2195.18,
          priceCurrent: 2150,
          inRange: true,
          priceQuoteSymbol: 'USD₮0',
          priceBaseSymbol: 'WETH',
        }}
        compact
      />
    );

    expect(screen.getByText(/USD₮0\/WETH · 4\.19%/i)).toBeTruthy();
  });

  it('muestra el precio de entrada en modo compacto', () => {
    render(
      <RangeTrack
        pool={{
          rangeLowerPrice: 2107,
          rangeUpperPrice: 2195.18,
          priceAtOpen: 2142.45,
          priceCurrent: 2150,
          inRange: true,
          priceQuoteSymbol: 'USD0',
          priceBaseSymbol: 'WETH',
        }}
        compact
      />
    );

    expect(screen.getByText('Entrada')).toBeTruthy();
    expect(screen.getByText('2,142.45')).toBeTruthy();
  });
});
