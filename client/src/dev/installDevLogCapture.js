/**
 * installDevLogCapture.js
 *
 * Instala hooks globales para capturar errores del cliente y mandarlos
 * al sink del server vía `devLogBuffer`. Solo se ejecuta cuando
 * `import.meta.env.DEV` es true.
 *
 * Hooks instalados:
 *   1. window.addEventListener('error')           — errores síncronos
 *   2. window.addEventListener('unhandledrejection') — promesas rechazadas
 *   3. console.error pasthrough                   — errores de React/3rd party
 */

import { devLogBuffer } from './devLogBuffer';

const ENDPOINT = '/api/dev/client-logs';

let installed = false;

function safeStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    try { return String(value); } catch { return '[unserializable]'; }
  }
}

export function installDevLogCapture() {
  if (installed) return;
  installed = true;

  devLogBuffer.start({ endpoint: ENDPOINT });

  window.addEventListener('error', (event) => {
    devLogBuffer.enqueue({
      level: 'error',
      source: 'client_window',
      message: event.message || 'window error',
      filename: event.filename || null,
      lineno: event.lineno || null,
      colno: event.colno || null,
      stack: event.error?.stack || null,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = (reason && (reason.message || String(reason))) || 'unhandled rejection';
    devLogBuffer.enqueue({
      level: 'error',
      source: 'client_promise',
      message,
      stack: reason?.stack || null,
    });
  });

  // Patch console.error para capturar warnings/errores de React.
  // Mantenemos el comportamiento original (la consola sigue funcionando).
  const origConsoleError = console.error.bind(console);
  console.error = (...args) => {
    try {
      devLogBuffer.enqueue({
        level: 'error',
        source: 'client_console',
        message: args.map(safeStringify).join(' '),
      });
    } catch {
      // noop: nunca debemos romper el console.error original
    }
    origConsoleError(...args);
  };
}
