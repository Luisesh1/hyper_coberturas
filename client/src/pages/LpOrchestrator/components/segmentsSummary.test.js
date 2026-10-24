import { describe, expect, it } from 'vitest';
import { closeReasonLabel, segmentRowModel, hasReconstructionGap } from './segmentsSummary';

describe('closeReasonLabel', () => {
  it('devuelve los rótulos exactos de cada motivo', () => {
    expect(closeReasonLabel('range_exit_below')).toBe('Salió por abajo');
    expect(closeReasonLabel('range_exit_above')).toBe('Salió por arriba');
    expect(closeReasonLabel('manual_rerange')).toBe('Ajuste manual');
    expect(closeReasonLabel('capital_change')).toBe('Cambio de capital');
    expect(closeReasonLabel('lp_closed')).toBe('LP cerrado');
    expect(closeReasonLabel('policy_change')).toBe('Cambio de cobertura');
    expect(closeReasonLabel('unknown')).toBe('Sin registrar');
  });

  it('un motivo ausente o desconocido es «Sin registrar»', () => {
    expect(closeReasonLabel(null)).toBe('Sin registrar');
    expect(closeReasonLabel('algo_nuevo')).toBe('Sin registrar');
  });
});

describe('segmentRowModel', () => {
  const base = {
    id: 3, seq: 3, status: 'closed', accuracy: 'exact', openedAt: 1, closedAt: 2,
    rangeLowerPrice: 2401.9, rangeUpperPrice: 2628.1, closeReason: 'range_exit_above',
    accounting: { totalNetPnlUsd: 4.2 }, coverage: { avgPct: 97.5 },
  };

  it('arma la fila con # de tramo, motivo, P&L y % cubierto', () => {
    const row = segmentRowModel(base);
    expect(row.title).toBe('#3');
    expect(row.reason).toBe('Salió por arriba');
    expect(row.netText).toBe('+$4.2');
    expect(row.netTone).toBe('positive');
    expect(row.coverageText).toBe('98% cubierto');
    expect(row.approximate).toBe(false);
  });

  it('el tramo vivo no tiene motivo de cierre sino su estado', () => {
    expect(segmentRowModel({ ...base, status: 'open', closeReason: null, closedAt: null }).reason).toBe('En curso');
    expect(segmentRowModel({ ...base, status: 'closing', closeReason: null, closedAt: null }).reason).toBe('Ajustando');
  });

  it('sin cobertura medida no inventa un porcentaje', () => {
    expect(segmentRowModel({ ...base, coverage: null }).coverageText).toBe('—');
    expect(segmentRowModel({ ...base, coverage: { avgPct: null } }).coverageText).toBe('—');
  });

  it('marca como aproximado un tramo reconstruido', () => {
    expect(segmentRowModel({ ...base, accuracy: 'approximate' }).approximate).toBe(true);
  });
});

describe('fila de diferencia (backfill_diff)', () => {
  it('se muestra como «Diferencia de reconstrucción» solo con su importe', () => {
    const row = segmentRowModel({
      id: 9, seq: 1, status: 'closed', accuracy: 'approximate', openReason: 'backfill_diff',
      openedAt: 1, closedAt: 2, closeReason: 'unknown', accounting: { totalNetPnlUsd: -2.5 },
    });
    expect(row.difference).toBe(true);
    expect(row.title).toBe('Diferencia de reconstrucción');
    expect(row.netText).toBe('-$2.5');
    expect(row.netTone).toBe('negative');
    expect(row).not.toHaveProperty('range');
    expect(row).not.toHaveProperty('reason');
    expect(row).not.toHaveProperty('dates');
    expect(row.approximate).toBe(false);
  });
});

describe('hasReconstructionGap', () => {
  it('solo cuenta una diferencia distinta de cero a la precisión de céntimo', () => {
    expect(hasReconstructionGap(0)).toBe(false);
    expect(hasReconstructionGap(0.001)).toBe(false);
    expect(hasReconstructionGap(-2.5)).toBe(true);
    expect(hasReconstructionGap(undefined)).toBe(false);
  });
});
