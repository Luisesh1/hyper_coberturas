/**
 * devLogBuffer.js
 *
 * Cola in-memory para acumular logs del cliente y mandarlos al server
 * en batch. Solo se usa cuando `import.meta.env.DEV` es true (Vite
 * tree-shake todo el módulo en build de producción).
 *
 * Estrategia:
 *   - flushIntervalMs: 2000  (vacía la cola cada 2s)
 *   - maxBufferSize: 20      (vacía inmediato si llega a 20)
 *   - maxBufferSizeHard: 200 (descarta lo más viejo si llega a 200)
 *   - 1 retry por batch fallido. No reintenta más para evitar feedback
 *     loops cuando el server está caído.
 */

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_THRESHOLD = 20;
const HARD_LIMIT = 200;

let queue = [];
let timer = null;
let inFlight = false;
let started = false;
let endpoint = null;
let lastFlushFailedAt = 0;
const RETRY_BACKOFF_MS = 10_000;

function start({ endpoint: ep }) {
  if (started) return;
  started = true;
  endpoint = ep;
  scheduleFlush();
}

function stop() {
  started = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

function enqueue(entry) {
  if (!started) return;
  if (!entry || typeof entry !== 'object') return;
  // Aseguramos shape mínimo + sane defaults.
  const normalized = {
    ts: entry.ts || new Date().toISOString(),
    level: entry.level === 'warn' ? 'warn' : 'error',
    source: entry.source || 'client_unknown',
    message: String(entry.message || ''),
    ...entry,
  };
  queue.push(normalized);
  if (queue.length > HARD_LIMIT) {
    queue = queue.slice(queue.length - HARD_LIMIT);
  }
  if (queue.length >= FLUSH_THRESHOLD) {
    void flush();
  }
}

function scheduleFlush() {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void flush();
    scheduleFlush();
  }, FLUSH_INTERVAL_MS);
}

async function flush() {
  if (!started || inFlight || queue.length === 0 || !endpoint) return;
  // Backoff tras fallo: esperar al menos RETRY_BACKOFF_MS antes de
  // intentar de nuevo (evita martillar al server cuando está caído).
  if (lastFlushFailedAt && Date.now() - lastFlushFailedAt < RETRY_BACKOFF_MS) return;

  const batch = queue.splice(0, FLUSH_THRESHOLD);
  inFlight = true;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
      // No incluimos credenciales: el endpoint /api/dev/client-logs no
      // requiere auth (capturamos errores de la pantalla de login también).
    });
    if (!res.ok) {
      lastFlushFailedAt = Date.now();
      // Re-empujamos al frente para no perder los entries — el siguiente
      // ciclo lo intentará una vez más.
      queue = [...batch, ...queue].slice(-HARD_LIMIT);
    } else {
      lastFlushFailedAt = 0;
    }
  } catch {
    lastFlushFailedAt = Date.now();
    // Mismo manejo: reinsertamos y esperamos al backoff.
    queue = [...batch, ...queue].slice(-HARD_LIMIT);
  } finally {
    inFlight = false;
  }
}

export const devLogBuffer = {
  start,
  stop,
  enqueue,
  flush,
  get size() { return queue.length; },
};
