import { describe, expect, it } from 'vitest';
import { inAssetCategory } from './assetCategory';

describe('inAssetCategory', () => {
  it('acepta la categoría principal y las cestas temáticas extra', () => {
    const nvda = { symbol: 'NVDA', category: 'stock_us_top', extraCategories: ['stock_ai'] };
    expect(inAssetCategory(nvda, 'stock_us_top')).toBe(true);
    expect(inAssetCategory(nvda, 'stock_ai')).toBe(true);
    expect(inAssetCategory(nvda, 'stock_quantum')).toBe(false);
  });

  it('"all" incluye todo y un activo sin extras solo está en su categoría', () => {
    const btc = { symbol: 'BTC', category: 'crypto_perp' };
    expect(inAssetCategory(btc, 'all')).toBe(true);
    expect(inAssetCategory(btc, 'crypto_perp')).toBe(true);
    expect(inAssetCategory(btc, 'stock_ai')).toBe(false);
  });
});
