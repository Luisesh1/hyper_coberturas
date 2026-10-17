import { describe, expect, it } from 'vitest';
import { optionPremiumLeverage, quoteMid } from './mobileChainMetrics';

describe('mobile options: market prices and funded notional leverage', () => {
  it('uses bid/ask midpoint, not mark price', () => {
    expect(quoteMid(5360,5665)).toBe(5512.5);
    expect(quoteMid('4360','4670')).toBe(4515);
  });
  it('does not make up midpoint for missing, crossed or zero quotes', () => {
    for(const [bid,ask] of [[null,80],[0,50],[20,0],[50,40],['',60],[30,NaN]]) {
      expect(quoteMid(bid,ask)).toBeNull();
    }
  });
  it('uses executable ask to estimate long-option premium leverage', () => {
    expect(optionPremiumLeverage(81493.39,5665)).toBeCloseTo(14.3854,3);
    expect(optionPremiumLeverage(81493.39,1700)).toBeCloseTo(47.9373,3);
    // Numerator and premium multiply by the same underlying unit and quantity.
    expect(optionPremiumLeverage(2400,24.8)).toBeCloseTo(96.77419,4);
  });
  it('never renders infinity or misleading zero-priced premium leverage', () => {
    for (const [spot,ask] of [[null,1],[0,1],[1200,0],[Infinity,5],[10,NaN],[-1,1]]) {
      expect(optionPremiumLeverage(spot,ask)).toBeNull();
    }
  });
});
