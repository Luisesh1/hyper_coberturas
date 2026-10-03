export function formatPoolFee(fee) {
  if (fee == null) return '—';
  if (Number(fee) === 0x800000) return 'Comisión dinámica';
  return `${(Number(fee) / 10000).toFixed(2)}%`;
}
