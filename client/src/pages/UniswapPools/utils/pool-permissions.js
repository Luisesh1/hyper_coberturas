/**
 * Lógica de permisos de pool compartida entre PoolCard y ProtectedPoolCard.
 *
 * Centraliza las reglas de quién puede gestionar/reclamar fees de una posición
 * basándose en el estado de la wallet y los datos del pool.
 */

const ZERO_HOOKS = '0x0000000000000000000000000000000000000000';

/**
 * @param {Object} params
 * @param {Object} params.walletState - { address, chainId, isConnected }
 * @param {string} params.ownerAddress - dirección del dueño de la posición
 * @param {number} params.chainId - chainId del pool
 * @param {string} params.version - 'v3' | 'v4'
 * @param {string} [params.hooks] - dirección de hooks (V4)
 * @param {number} [params.unclaimedFees] - fees no reclamadas en USD
 * @returns {{ canManage: boolean, canClaim: boolean, manageTitle: string }}
 */
export function computePoolPermissions({ walletState, ownerAddress, chainId, version, hooks, unclaimedFees = 0 }) {
  const isVersionSupported = ['v3', 'v4'].includes(version);
  const hasUnsupportedV4Hooks = version === 'v4' && hooks && hooks !== ZERO_HOOKS;
  const isOwner = ownerAddress?.toLowerCase() === walletState?.address?.toLowerCase();
  const isCorrectChain = walletState?.chainId === chainId;

  const canManage = isVersionSupported
    && walletState?.isConnected
    && isCorrectChain
    && isOwner
    && !hasUnsupportedV4Hooks;

  const canClaim = canManage && unclaimedFees > 0;

  let manageTitle = '';
  if (!walletState?.isConnected) {
    manageTitle = 'Conecta tu wallet para gestionar esta posición';
  } else if (!isCorrectChain) {
    manageTitle = 'Cambia a la red correcta en tu wallet';
  } else if (!isOwner) {
    manageTitle = 'Esta wallet no es dueña de la posición';
  } else if (hasUnsupportedV4Hooks) {
    manageTitle = 'Hooks no soportados en gestión V4';
  }

  return { canManage, canClaim, manageTitle, hasUnsupportedV4Hooks };
}
