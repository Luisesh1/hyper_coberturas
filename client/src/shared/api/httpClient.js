export function createHttpClient({
  baseUrl,
  getToken,
  onUnauthorized,
  onHttpError, // (err, ctx) — opcional, se invoca para 4xx/5xx en dev
  timeoutMs = 30000,
}) {
  return async function request(method, path, body, options = {}) {
    const effectiveTimeoutMs = options.timeoutMs ?? timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      // Pasamos un Error explícito como razón para que el AbortError
      // resultante tenga un mensaje útil ("request timeout") en vez de
      // "signal is aborted without reason".
      try {
        controller.abort(new Error(`request timeout after ${effectiveTimeoutMs}ms`));
      } catch {
        controller.abort();
      }
    }, effectiveTimeoutMs);

    const token = getToken?.();
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    };

    try {
      // GET/HEAD no admiten body. Además, `body: null` también es inválido
      // en algunos browsers (TypeError: Request with GET/HEAD method cannot
      // have body). Sólo adjuntamos body cuando realmente hay contenido y el
      // método lo permite.
      const methodUpper = String(method || 'GET').toUpperCase();
      const canHaveBody = methodUpper !== 'GET' && methodUpper !== 'HEAD';
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers,
        ...(canHaveBody && body != null ? { body: JSON.stringify(body) } : {}),
      });

      const text = await response.text();
      let payload = null;

      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.code = 'HTTP_ERROR';
          error.status = response.status;
          throw error;
        }
        throw new Error('Respuesta invalida del servidor');
      }

      if (response.status === 401) {
        onUnauthorized?.();
        throw new Error('Sesión expirada');
      }

      if (!response.ok || !payload?.success) {
        const errorInfo = payload?.errorInfo || null;
        const error = new Error(errorInfo?.message || payload?.error || `HTTP ${response.status}`);
        error.code = errorInfo?.code || payload?.code || 'HTTP_ERROR';
        error.details = errorInfo?.details || payload?.details || null;
        error.requestId = errorInfo?.requestId || payload?.requestId || null;
        error.status = response.status;
        if (typeof onHttpError === 'function') {
          try {
            onHttpError(error, { method, path, status: response.status });
          } catch { /* noop: el sink del logger nunca debe romper la request */ }
        }
        throw error;
      }

      return payload.data;
    } catch (err) {
      // Algunos browsers rechazan fetch con AbortError y otros propagan
      // directamente la `reason` pasada a abort(). Si sabemos que el timer
      // disparó, normalizamos SIEMPRE el mensaje a uno amigable.
      if (timedOut) {
        const timeoutError = new Error(
          `La petición se canceló por timeout (${effectiveTimeoutMs}ms). El servidor puede seguir procesándola — intenta refrescar en unos segundos.`
        );
        timeoutError.code = 'REQUEST_TIMEOUT';
        timeoutError.cause = err;
        if (typeof onHttpError === 'function') {
          try {
            onHttpError(timeoutError, { method, path, status: 0 });
          } catch { /* noop */ }
        }
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  };
}
