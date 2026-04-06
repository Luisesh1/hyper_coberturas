/**
 * Constantes del wizard de SmartCreatePoolModal.
 */

export const STEP = {
  POOL: 'pool',
  RANGE: 'range',
  FUNDING: 'funding',
  REVIEW: 'review',
  SIGNING: 'signing',
  DONE: 'done',
  ERROR: 'error',
};

export const FEE_TIERS = [
  { value: 100, label: '0.01%' },
  { value: 500, label: '0.05%' },
  { value: 3000, label: '0.3%' },
  { value: 10000, label: '1%' },
];

export const PRESET_HINTS = {
  conservative: 'Rango amplio siguiendo ATR, con más tolerancia a volatilidad.',
  balanced: 'Balance recomendado entre amplitud del rango y concentración.',
  aggressive: 'Rango más estrecho y concentrado, con mayor sensibilidad al precio.',
};
