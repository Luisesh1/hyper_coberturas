import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BotLiveStatus } from './BotLiveStatus';
import { buildBot } from '../test/fixtures';

describe('BotLiveStatus', () => {
  it('muestra estado vacio si no hay bot seleccionado', () => {
    render(<BotLiveStatus bot={null} />);

    expect(screen.getByText(/Selecciona un bot/i)).toBeTruthy();
  });

  it('muestra runtime, reintento y motivo de pausa cuando existen', () => {
    render(<BotLiveStatus bot={buildBot({
      lastError: 'Market down',
      runtime: {
        state: 'paused_by_system',
        consecutiveFailures: 5,
        nextRetryAt: 1710000600000,
        lastRecoveryAction: 'system_paused',
        systemPauseReason: 'Market down',
      },
    })} />);

    expect(screen.getByText('paused_by_system')).toBeTruthy();
    expect(screen.getAllByText('Market down').length).toBeGreaterThan(0);
    expect(screen.getByText('system_paused')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('Motivo pausa')).toBeTruthy();
  });
});
