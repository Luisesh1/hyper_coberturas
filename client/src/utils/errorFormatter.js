/**
 * errorFormatter.js
 *
 * Normaliza errores del backend / axios / network en un mensaje accionable
 * para el usuario, evitando que los catch arrojen strings crípticos como
 * "Network error" o "500 Internal Error" sin contexto.
 *
 * Retorna `{ message, hint?, code? }`:
 *   - message: texto principal a mostrar (toast, inline error, ...)
 *   - hint:    pista opcional sobre cómo resolverlo
 *   - code:    código HTTP o 'NETWORK' | 'TIMEOUT' para lógica downstream
 */

function extractServerMessage(err) {
  const data = err?.response?.data;
  if (!data) return null;
  if (typeof data === 'string') return data;
  return (
    data.error
    || data.message
    || data.detail
    || (Array.isArray(data.errors) && data.errors[0]?.message)
    || null
  );
}

export function categorizeApiError(err, fallback = 'Error inesperado') {
  if (!err) return { message: fallback };

  // Axios / fetch without response => network level
  const rawMessage = String(err?.message || '');
  const isNetwork = !err.response && /network|ecconnreset|socket hang up|fetch failed|failed to fetch/i.test(rawMessage);
  const isTimeout = /timeout|etimedout/i.test(rawMessage);

  if (isTimeout) {
    return {
      message: 'El servidor tardó demasiado en responder.',
      hint: 'Reintenta en unos segundos; si persiste revisa la conexión o la salud del backend.',
      code: 'TIMEOUT',
    };
  }
  if (isNetwork) {
    return {
      message: 'No se pudo contactar al servidor.',
      hint: 'Verifica tu conexión a internet y que el backend esté activo.',
      code: 'NETWORK',
    };
  }

  const status = Number(err?.response?.status || 0);
  const serverMsg = extractServerMessage(err);

  if (status === 401) {
    return {
      message: 'Sesión expirada o inválida.',
      hint: 'Vuelve a iniciar sesión para continuar.',
      code: 401,
    };
  }
  if (status === 403) {
    return {
      message: serverMsg || 'No tienes permiso para esta acción.',
      code: 403,
    };
  }
  if (status === 404) {
    return {
      message: serverMsg || 'Recurso no encontrado.',
      hint: 'Puede haber sido eliminado o la URL es incorrecta.',
      code: 404,
    };
  }
  if (status === 409) {
    return {
      message: serverMsg || 'Conflicto de estado.',
      hint: 'Refresca la vista — el recurso cambió desde que cargaste la página.',
      code: 409,
    };
  }
  if (status === 422 || status === 400) {
    return {
      message: serverMsg || 'Datos inválidos.',
      hint: 'Revisa los campos y vuelve a intentarlo.',
      code: status,
    };
  }
  if (status === 429) {
    return {
      message: serverMsg || 'Demasiadas peticiones.',
      hint: 'Espera unos segundos antes de reintentar.',
      code: 429,
    };
  }
  if (status >= 500 && status < 600) {
    return {
      message: serverMsg || 'Error interno del servidor.',
      hint: 'Reintenta; si persiste avisa al operador del bot.',
      code: status,
    };
  }

  // Error sin response (arrojado directamente en frontend) → mostrar su mensaje tal cual
  return {
    message: serverMsg || rawMessage || fallback,
    code: status || undefined,
  };
}

/**
 * Shortcut: devuelve un string listo para mostrar en toast/UI, combinando
 * mensaje + hint cuando existe.
 */
export function formatApiError(err, fallback) {
  const { message, hint } = categorizeApiError(err, fallback);
  return hint ? `${message} ${hint}` : message;
}
