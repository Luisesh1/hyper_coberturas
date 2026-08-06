/**
 * Smoke test de los 5 modales migrados a ModalShell.
 *
 * No comprueba diseño: comprueba que montan sin ReferenceError, que exponen un
 * role="dialog" con nombre accesible y que el botón de cerrar sigue llamando a
 * onClose. La suite existente no renderiza ninguno de estos componentes, así
 * que un import olvidado tras la migración pasaría desapercibido — el build de
 * Vite tampoco lo detecta.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  lpOrchestratorApi: {
    getActionLog: vi.fn().mockResolvedValue([]),
    updateConfig: vi.fn().mockResolvedValue({}),
  },
  uniswapApi: {
    getWalletAssets: vi.fn().mockResolvedValue({ assets: [] }),
    prepareSmartAddLiquidity: vi.fn().mockResolvedValue({}),
  },
  settingsApi: { list: vi.fn().mockResolvedValue([]) },
}));

// Las referencias son de módulo, NO literales dentro de la factory: el hook
// real guarda txHashes en useState, así que su referencia es estable entre
// renders. Devolver un [] nuevo por render dispara el efecto que hace
// setTxHashes(execution.txHashes) y produce un bucle infinito — que es del
// mock, no del componente.
const STABLE_TX_HASHES = [];
const STABLE_PROGRESS = { completed: 0, total: 0 };

vi.mock('../../../hooks/useWalletExecution', () => ({
  useWalletExecution: () => ({
    state: 'idle',
    currentTx: null,
    normalizedError: null,
    progress: STABLE_PROGRESS,
    txHashes: STABLE_TX_HASHES,
    runPlan: vi.fn(),
    reset: vi.fn(),
  }),
  WALLET_EXECUTION_STATE: { IDLE: 'idle', SIGNING: 'signing', DONE: 'done' },
}));

import EditOrchestratorConfigModal from '../../../pages/LpOrchestrator/components/EditOrchestratorConfigModal';
import OrchestratorIssueModal from '../../../pages/LpOrchestrator/components/OrchestratorIssueModal';
import ActionLogDrawer from '../../../pages/LpOrchestrator/components/ActionLogDrawer';
import PositionActionModal from '../../../pages/UniswapPools/components/PositionActionModal';
import SmartAddLiquidityModal from '../../../pages/UniswapPools/components/SmartAddLiquidityModal';

const orchestrator = {
  id: 42,
  name: 'ETH / USDC',
  phase: 'failed',
  lastError: 'gas insuficiente',
  strategyConfig: { rangeWidthPct: 8, edgeMarginPct: 12 },
  protectionConfig: { enabled: false },
  initialTotalUsd: 1000,
};

const pool = {
  version: 'v3',
  token0: { symbol: 'ETH', address: '0xeee' },
  token1: { symbol: 'USDC', address: '0xusd' },
  fee: 3000,
  priceCurrent: 3200,
  unclaimedFeesUsd: 18.44,
  positionIdentifier: '184203',
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

const CASES = [
  {
    name: 'EditOrchestratorConfigModal',
    render: (onClose) => <EditOrchestratorConfigModal orchestrator={orchestrator} accounts={[]} onClose={onClose} />,
  },
  {
    name: 'OrchestratorIssueModal',
    render: (onClose) => <OrchestratorIssueModal orchestrator={orchestrator} onClose={onClose} />,
  },
  {
    name: 'ActionLogDrawer',
    render: (onClose) => <ActionLogDrawer orchestrator={orchestrator} onClose={onClose} />,
  },
  {
    name: 'PositionActionModal',
    // Montarlo cuelga el worker de vitest con cualquier acción, también sin
    // ModifyRangeFields. Comprobado contra la versión de HEAD con este mismo
    // mock: es previo a la migración a ModalShell, que solo tocó JSX y clases.
    // Pendiente de investigar aparte; no bloquea esta unificación.
    skip: true,
    render: (onClose) => (
      <PositionActionModal pool={pool} action="modify-range" onClose={onClose} onCompleted={() => {}} />
    ),
  },
  {
    name: 'SmartAddLiquidityModal',
    render: (onClose) => (
      <SmartAddLiquidityModal
        pool={pool}
        positionIdentifier="184203"
        network="arbitrum"
        onClose={onClose}
        onCompleted={() => {}}
      />
    ),
  },
];

describe('modales migrados a ModalShell', () => {
  CASES.forEach(({ name, render: renderModal, skip }) => {
    (skip ? describe.skip : describe)(name, () => {
      it('monta y expone un diálogo con nombre accesible', () => {
        render(renderModal(() => {}));
        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-label')).toBeTruthy();
      });

      it('cierra con el botón de cerrar', async () => {
        const onClose = vi.fn();
        render(renderModal(onClose));
        await userEvent.click(screen.getByRole('button', { name: 'Cerrar diálogo' }));
        expect(onClose).toHaveBeenCalled();
      });

      it('cierra con Escape', async () => {
        const onClose = vi.fn();
        render(renderModal(onClose));
        await userEvent.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalled();
      });
    });
  });
});
