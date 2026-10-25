import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useWalletConnection', () => ({
  WalletProvider: ({ children }) => <div data-testid="wallet-provider">{children}</div>,
}));

import WalletLayout from './WalletLayout';

describe('WalletLayout', () => {
  it('envuelve la ruta hija con WalletProvider', () => {
    render(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route element={<WalletLayout />}>
            <Route path="/x" element={<p>hija</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(within(screen.getByTestId('wallet-provider')).getByText('hija')).toBeTruthy();
  });
});
