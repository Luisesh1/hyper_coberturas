import { describe, expect, it } from 'vitest';
import { computePoolPermissions } from './pool-permissions';

const OWNER = '0x1111111111111111111111111111111111111111';
const walletState = { address: OWNER, chainId: 42161, isConnected: true };

function permissions(hooks) {
  return computePoolPermissions({
    walletState,
    ownerAddress: OWNER,
    chainId: 42161,
    version: 'v4',
    hooks,
    unclaimedFees: 12,
  });
}

describe('permisos de posiciones Uniswap v4 con hooks', () => {
  it('permite gestionar un hook seguro que solo ejecuta beforeSwap', () => {
    const safeBeforeSwapHook = '0x0000000000000000000000000000000000000080';

    expect(permissions(safeBeforeSwapHook)).toMatchObject({
      hasUnsupportedV4Hooks: false,
      canManage: true,
      canClaim: true,
    });
  });

  it('bloquea hooks que pueden devolver deltas', () => {
    const unsafeReturnsDeltaHook = '0x0000000000000000000000000000000000000008';

    expect(permissions(unsafeReturnsDeltaHook)).toMatchObject({
      hasUnsupportedV4Hooks: true,
      canManage: false,
      canClaim: false,
    });
  });
});
