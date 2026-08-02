import { describe, it, expect } from 'vitest';
import { deriveFundingIssue, formatFundingIssueTitle } from './helpers';

describe('formatFundingIssueTitle', () => {
  // Una wallet con $167 en Arbitrum recibia "El capital no alcanza para
  // fondear el LP" cuando en el wizard solo habia quedado habilitado un
  // activo de $50. El capital estaba: faltaba habilitarlo. El titulo tiene
  // que mandar al usuario a la lista de fondeo, no a buscar plata.
  it('no culpa al capital cuando el problema es la selección', () => {
    const title = formatFundingIssueTitle({ code: 'INSUFFICIENT_SELECTED_FUNDING' });
    expect(title).toMatch(/habilitar activos/i);
    expect(title).not.toMatch(/no alcanza/i);
  });

  it('sigue culpando al capital cuando de verdad no alcanza', () => {
    expect(formatFundingIssueTitle({ code: 'INSUFFICIENT_DIRECT_OR_SWAP_OUTPUT' }))
      .toMatch(/capital no alcanza/i);
    expect(formatFundingIssueTitle({ code: 'INSUFFICIENT_SAME_NETWORK_BALANCE' }))
      .toMatch(/saldo insuficiente/i);
  });

  it('cae a un titulo generico ante un codigo desconocido', () => {
    expect(formatFundingIssueTitle({ code: 'ALGO_NUEVO' })).toMatch(/no se pudo construir/i);
    expect(formatFundingIssueTitle(null)).toMatch(/no se pudo construir/i);
  });
});

describe('deriveFundingIssue', () => {
  it('preserva code, message y details para poder mostrar los montos', () => {
    const issue = deriveFundingIssue({
      code: 'INSUFFICIENT_SELECTED_FUNDING',
      message: 'Seleccionaste $50.43 de los $167.66 que tenés en Arbitrum One.',
      details: { selectedUsd: 50.43, usableFundingUsd: 167.66 },
    });
    expect(issue.code).toBe('INSUFFICIENT_SELECTED_FUNDING');
    expect(issue.details.selectedUsd).toBe(50.43);
    expect(issue.details.usableFundingUsd).toBe(167.66);
  });

  it('devuelve null sin error', () => {
    expect(deriveFundingIssue(null)).toBeNull();
  });
});
