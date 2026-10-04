import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdoptLpWizard from './AdoptLpWizard';
import { buildAdoptPayload, buildInitialProtection } from './useAdoptLpFlow';

const { lpOrchestratorApi } = vi.hoisted(() => ({
  lpOrchestratorApi: {
    listAdoptionCandidates: vi.fn(),
    adoptExistingLp: vi.fn(),
    preflightProtection: vi.fn(),
  },
}));

vi.mock('../../services/api', () => ({ lpOrchestratorApi }));

const WALLET = '0x9f3C000000000000000000000000000000041aB0';

function candidate(overrides = {}) {
  return {
    position: {
      identifier: '3571232',
      network: 'robinhood',
      version: 'v4',
      walletAddress: WALLET,
      token0: { symbol: 'ETH' },
      token1: { symbol: 'USDG' },
      fee: 0x800000,
      tickSpacing: 60,
      hooks: '0x00000000000000000000000000000000000000c4',
      poolId: '0x5d02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae19b',
      rangeLowerPrice: 3952,
      rangeUpperPrice: 4027,
      priceCurrent: 3988,
      inRange: true,
      currentValueUsd: 501.84,
      unclaimedFeesUsd: 0.62,
    },
    eligible: true,
    blockedCode: null,
    blockedReason: null,
    hook: { address: '0x00000000000000000000000000000000000000c4', swapReturnsDelta: true, verifiedVersionId: null },
    prefill: {
      name: 'ETH/USDG dinámica #3571232',
      network: 'robinhood',
      version: 'v4',
      walletAddress: WALLET,
      token0Symbol: 'ETH',
      token1Symbol: 'USDG',
      inferredAsset: 'ETH',
      feeTier: 0x800000,
      initialTotalUsd: 501.84,
      strategyConfig: {
        rangeWidthPct: 0.94, edgeMarginPct: 40, minRangeWidthPct: 0.94, maxRangeWidthPct: 30, v4TickSpacing: 60,
      },
    },
    provenance: { initialTotalUsd: 'derived', rangeWidthPct: 'derived', minRangeWidthPct: 'derived', maxRangeWidthPct: 'default' },
    protection: {
      modes: ['new', 'none'],
      defaultMode: 'new',
      allowedPolicies: ['terminal_range_v1', 'range_exit_v1'],
      existing: null,
      candidate: { inferredAsset: 'ETH', defaultLeverage: 3 },
      warning: null,
    },
    ...overrides,
  };
}

const META = { networks: [{ id: 'robinhood', label: 'Robinhood', versions: ['v4'] }, { id: 'ethereum', label: 'Ethereum', versions: ['v1', 'v2'] }] };
const ACCOUNTS = [{ id: 4, alias: 'v4', address: WALLET }];

describe('buildInitialProtection', () => {
  it('elige una política admitida por el hook y el apalancamiento del activo', () => {
    const protection = buildInitialProtection(candidate());
    expect(protection.enabled).toBe(true);
    expect(protection.policyVersion).toBe('range_exit_v1');
    expect(protection.leverage).toBe('3');
  });
});

describe('buildAdoptPayload', () => {
  it('manda solo lo editable y lo que cambió respecto a la precarga', () => {
    const c = candidate();
    const payload = buildAdoptPayload({
      candidate: c,
      form: { name: ' Mi LP ', initialTotalUsd: '500', rangeWidthPct: '0.94', edgeMarginPct: '25', maxSlippageBps: '100' },
      protectionMode: 'none',
      protection: null,
    });
    expect(payload).toEqual({
      network: 'robinhood',
      version: 'v4',
      walletAddress: WALLET,
      positionIdentifier: '3571232',
      name: 'Mi LP',
      initialTotalUsd: 500,
      strategyConfig: { edgeMarginPct: 25, maxSlippageBps: 100 },
      protection: { mode: 'none' },
    });
    expect(payload.feeTier).toBeUndefined();
  });
});

describe('AdoptLpWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lpOrchestratorApi.listAdoptionCandidates.mockResolvedValue({
      candidates: [
        candidate(),
        candidate({
          position: { ...candidate().position, identifier: '3570990' },
          eligible: false,
          blockedCode: 'already_orchestrated',
          blockedReason: 'Ya la gestiona el orquestador «ETH/USDG Fables».',
        }),
      ],
      warnings: [],
    });
    lpOrchestratorApi.adoptExistingLp.mockResolvedValue({ status: 'completed', orchestrator: { id: 9, name: 'ETH/USDG dinámica #3571232' } });
  });

  it('recorre posición → datos → cobertura → revisión y adopta sin cobertura', async () => {
    const user = userEvent.setup();
    const onCompleted = vi.fn();
    render(
      <AdoptLpWizard walletAddress={WALLET} meta={META} accounts={ACCOUNTS} defaultNetwork="robinhood" onClose={() => {}} onCompleted={onCompleted} />
    );

    // Ethereum no se ofrece: solo lista v1/v2.
    expect(screen.queryByRole('option', { name: 'Ethereum' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Buscar posiciones' }));
    await waitFor(() => expect(lpOrchestratorApi.listAdoptionCandidates).toHaveBeenCalledWith({ network: 'robinhood', walletAddress: WALLET }));

    expect(await screen.findByText(/ETH\/USDG Fables/)).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios[1].disabled).toBe(true);

    await user.click(radios[0]);
    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));

    expect(screen.getByLabelText('Capital inicial en USD').value).toBe('501.84');
    expect(screen.getByLabelText('Ancho de rango en porcentaje').value).toBe('0.94');
    expect(screen.getByText('Comisión dinámica · tickSpacing 60')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));

    await user.click(screen.getByRole('radio', { name: /Sin cobertura/ }));
    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));

    expect(screen.getByText(/Las fees sin cobrar/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Adoptar' }));

    await waitFor(() => expect(lpOrchestratorApi.adoptExistingLp).toHaveBeenCalled());
    expect(lpOrchestratorApi.adoptExistingLp.mock.calls[0][0].protection).toEqual({ mode: 'none' });
    expect(await screen.findByText('Orquestador creado')).toBeTruthy();
    expect(onCompleted).toHaveBeenCalled();
    expect(lpOrchestratorApi.preflightProtection).not.toHaveBeenCalled();
  });

  it('si la cobertura falla al adoptar vuelve al paso Cobertura con el motivo', async () => {
    const user = userEvent.setup();
    lpOrchestratorApi.preflightProtection.mockResolvedValue({ ok: true, checks: [] });
    const failure = Object.assign(new Error('No se pudo adoptar el LP: margen insuficiente'), {
      code: 'ADOPTION_FAILED',
      details: { compensations: [{ id: 'orchestrator', ok: true, detail: 'Orquestador #9 eliminado' }] },
    });
    lpOrchestratorApi.adoptExistingLp.mockRejectedValue(failure);

    render(
      <AdoptLpWizard walletAddress={WALLET} meta={META} accounts={ACCOUNTS} defaultNetwork="robinhood" onClose={() => {}} />
    );
    await user.click(screen.getByRole('button', { name: 'Buscar posiciones' }));
    await user.click((await screen.findAllByRole('radio'))[0]);
    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));

    // La cuenta se autoselecciona porque coincide con la wallet del LP.
    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(lpOrchestratorApi.preflightProtection).toHaveBeenCalled());
    const preflightPayload = lpOrchestratorApi.preflightProtection.mock.calls[0][0];
    expect(preflightPayload.protection.policyVersion).toBe('range_exit_v1');
    expect(preflightPayload.protection.accountId).toBe(4);

    await user.click(await screen.findByRole('button', { name: 'Adoptar y cubrir' }));
    await waitFor(() => expect(lpOrchestratorApi.adoptExistingLp).toHaveBeenCalled());
    expect(lpOrchestratorApi.adoptExistingLp.mock.calls[0][0].protection.mode).toBe('new');
    expect(await screen.findByText(/margen insuficiente/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Abrir una cobertura nueva/ })).toBeTruthy();
  });
});
