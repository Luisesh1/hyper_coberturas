import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BotRunLogs } from './BotRunLogs';
import { buildRun } from '../test/fixtures';

describe('BotRunLogs', () => {
  it('renderiza historial con mensaje y accion tomada', () => {
    render(<BotRunLogs runs={[
      buildRun(),
      buildRun({
        id: 2,
        action: 'market_data_failed',
        status: 'error',
        signal: null,
        details: {
          message: 'Sin velas',
          actionTaken: 'Reintento programado',
        },
      }),
    ]} />);

    expect(screen.getByText('market_data_failed')).toBeTruthy();
    expect(screen.getByText('Sin velas')).toBeTruthy();
    expect(screen.getByText('Reintento programado')).toBeTruthy();
  });

  it('permite ver solo errores y usar el filtro de texto', async () => {
    render(<BotRunLogs runs={[
      buildRun(),
      buildRun({
        id: 2,
        action: 'market_data_failed',
        status: 'error',
        signal: null,
        details: { message: 'Sin velas' },
      }),
      buildRun({
        id: 3,
        action: 'system_paused',
        status: 'paused',
        signal: null,
        details: { message: 'Pausa automatica' },
      }),
    ]} />);

    await userEvent.click(screen.getByRole('button', { name: 'Solo errores' }));

    expect(screen.queryByText(/^hold$/)).toBeFalsy();
    expect(screen.getByText('market_data_failed')).toBeTruthy();
    expect(screen.getByText('system_paused')).toBeTruthy();

    await userEvent.type(screen.getByPlaceholderText(/Filtrar por accion/i), 'paused');

    expect(screen.queryByText('market_data_failed')).toBeFalsy();
    expect(screen.getByText('system_paused')).toBeTruthy();
  });
});
