import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BacktestTopBar from './BacktestTopBar';

vi.mock('./MetricsStrip', () => ({ default: () => null }));
vi.mock('./RunHistoryDropdown', () => ({ default: () => null }));

function renderTopBar(overrides = {}) {
  const props = {
    form: { strategyId: 11, asset: 'BTC', timeframe: '15m' },
    setForm: vi.fn(),
    strategies: [{ id: 11, name: 'Trend Rider' }],
    metrics: null,
    isRunning: false,
    isLoading: false,
    pendingJob: { jobId: 'bt-1', asset: 'BTC', timeframe: '15m' },
    onRun: vi.fn(),
    configOpen: false,
    onToggleConfig: vi.fn(),
    runs: [],
    activeRunId: null,
    onSelectRun: vi.fn(),
    onToggleCompare: vi.fn(),
    ...overrides,
  };
  render(<BacktestTopBar {...props} />);
  return props;
}

describe('BacktestTopBar', () => {
  it('bloquea botón y atajo mientras hay un trabajo pendiente', () => {
    const props = renderTopBar();

    expect(screen.getByRole('button', { name: /simular backtest/i }).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(props.onRun).not.toHaveBeenCalled();
  });
});
