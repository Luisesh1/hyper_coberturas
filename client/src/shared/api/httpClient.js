export function createHttpClient({
  baseUrl,
  getToken,
  onUnauthorized,
  timeoutMs = 30000,
}) {
  return async function request(method, path, body, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? timeoutMs);

    const token = getToken?.();
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    };

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
        throw error;
      }

      return payload.data;
    } finally {
      clearTimeout(timeoutId);
    }
  };
}
