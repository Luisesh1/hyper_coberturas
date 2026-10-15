import { useCallback } from 'react';
import { optionsApi } from '../../../../services/api';
import { usePolling } from './usePolling';

export const CHAIN_POLL_MS = 5000;

// Cadena de un subyacente y vencimiento (sin `expiry`, el backend elige el
// más cercano y lo devuelve en `chain.expiry`).
export function useOptionChain(underlying, expiry) {
  const fetcher = useCallback(
    () => optionsApi.getChain({ underlying, expiry: expiry || undefined }),
    [underlying, expiry],
  );
  const { data, error, loading, refresh } = usePolling(fetcher, {
    intervalMs: CHAIN_POLL_MS,
    enabled: !!underlying,
    key: `${underlying}|${expiry || ''}`,
  });
  return { chain: data, error, loading, refresh };
}
