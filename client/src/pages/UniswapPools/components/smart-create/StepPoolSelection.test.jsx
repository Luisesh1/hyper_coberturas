import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import StepPoolSelection from './StepPoolSelection';

it('bloquea tarifas fijas mientras hay un hook de tarifa dinámica', () => {
  const setFee = vi.fn();
  render(<StepPoolSelection
    wallet={{ address: '0x1111111111111111111111111111111111111111' }}
    network="robinhood"
    version="v4"
    fee={0x800000}
    setFee={setFee}
    dynamicFeeHookActive
    existingPoolSelected
    totalUsdTarget="100"
    setTotalUsdTarget={() => {}}
    token0Address=""
    setToken0Address={() => {}}
    token1Address=""
    setToken1Address={() => {}}
    customToken0=""
    setCustomToken0={() => {}}
    customToken1=""
    setCustomToken1={() => {}}
    tokenOptions={[]}
    handleAnalyzePool={() => {}}
  />);

  expect(screen.getByRole('button', { name: '0.05%' }).disabled).toBe(true);
  expect(screen.getByRole('combobox', { name: 'Token 0' }).disabled).toBe(true);
  expect(screen.getByRole('combobox', { name: 'Token 1' }).disabled).toBe(true);
  expect(setFee).not.toHaveBeenCalled();
});
