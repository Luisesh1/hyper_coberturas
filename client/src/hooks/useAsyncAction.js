import { useCallback, useState } from 'react';
import { useNotifications } from '../context/NotificationsContext';

/**
 * Hook que encapsula el patrón repetido de:
 *   loading state + try/catch + addNotification('error', ...)
 *
 * Uso:
 *   const { run, loading } = useAsyncAction();
 *
 *   const fetchData = useCallback(() =>
 *     run(() => api.getData(), 'Error al cargar datos'), [run]);
 *
 * El errorPrefix por defecto es 'Error'. Retorna el resultado de fn()
 * o lanza el error (después de notificar).
 */
export function useAsyncAction() {
  const { addNotification } = useNotifications();
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (fn, errorPrefix = 'Error') => {
    setLoading(true);
    try {
      return await fn();
    } catch (err) {
      addNotification('error', `${errorPrefix}: ${err.message}`);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [addNotification]);

  return { run, loading };
}
