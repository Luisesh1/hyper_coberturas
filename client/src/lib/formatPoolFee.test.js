import { describe, expect, it } from 'vitest';
import { formatPoolFee } from './formatPoolFee';

describe('formatPoolFee', () => {
  it('muestra la bandera v4 como comisión dinámica', () => {
    expect(formatPoolFee(0x800000)).toBe('Comisión dinámica');
  });

  it('muestra una comisión fija y un valor ausente', () => {
    expect(formatPoolFee(500)).toBe('0.05%');
    expect(formatPoolFee(null)).toBe('—');
  });
});
