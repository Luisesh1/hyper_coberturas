import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BotSidebar } from './BotSidebar';
import { buildBot } from '../test/fixtures';

describe('BotSidebar', () => {
  it('muestra badges de runtime y permite filtrar bots en recovery', async () => {
    const onSelectBot = vi.fn();

    render(<BotSidebar
      bots={[
        buildBot({
          id: 21,
          asset: 'BTC',
          strategyName: 'Trend Rider',
          status: 'active',
          runtime: { state: 'healthy' },
        }),
        buildBot({
          id: 22,
          asset: 'ETH',
          strategyName: 'Mean Revert',
          status: 'active',
          runtime: {
            state: 'retrying',
            nextRetryAt: 1710000600000,
          },
        }),
      ]}
      selectedBotId={22}
      onSelectBot={onSelectBot}
      onNewBot={() => {}}
    />);

    expect(screen.getByText('retrying')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Errores/i }));

    expect(screen.queryByText(/#21 · BTC/i)).toBeFalsy();
    expect(screen.getByText(/#22 · ETH/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /#22 · ETH/i }));
    expect(onSelectBot).toHaveBeenCalled();
  });
});
