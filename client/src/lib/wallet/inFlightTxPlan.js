/**
 * inFlightTxPlan.js
 *
 * Persistencia simple en localStorage del progreso de un txPlan en curso.
 * Sirve para que, cuando el usuario cierra el modal a la mitad de un plan
 * de N transacciones (o el navegador crashea, o se cae la conexión), el
 * bot pueda detectar al siguiente arranque que hay una operación inacabada
 * y ofrecer "resumir" — en lugar de pedir firmar TODO de nuevo y arriesgar
 * dejar fondos atascados como pasó con la posición #5412248.
 *
 * Solo guardamos la mínima información necesaria: clave del plan,
 * action, finalizePayload, txPlan original, hashes ya firmados, índice
 * completado, timestamps. NO guardamos el `prepareData` completo porque
 * puede ser pesado y porque el server tiene una cache de prepareResult
 * con TTL — al resumir podemos llamar a `prepare` de nuevo si hace falta.
 *
 * Las entries se descartan automáticamente si:
 *   - tienen más de 2 horas (ya no son útiles, los pools se mueven)
 *   - el plan terminó (`done` / `failed` / `archive`)
 */

const STORAGE_KEY = 'hlbot.inflight.txplans.v1';
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 horas

function safeReadAll() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function safeWriteAll(map) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota exceeded etc.
  }
}

function pruneStale(map) {
  const now = Date.now();
  const next = {};
  for (const [key, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object') continue;
    const age = now - Number(entry.updatedAt || entry.startedAt || 0);
    if (Number.isFinite(age) && age < MAX_AGE_MS) {
      next[key] = entry;
    }
  }
  return next;
}

/**
 * Construye una key única para un plan dado. Usamos los txHashes del plan
 * (no los firmados — los del plan original `tx.data + tx.to + index`) para
 * que dos planes diferentes para el mismo orquestador no se pisen.
 */
export function buildPlanKey({ scope, action, txPlan }) {
  const txDigest = (txPlan || [])
    .map((tx, i) => `${i}:${tx?.kind || ''}:${(tx?.data || '').slice(2, 18)}`)
    .join('|');
  return `${scope || 'global'}::${action}::${txDigest}`;
}

/**
 * @param {object} args
 * @param {string} args.planKey
 * @param {string} args.scope         identificador externo (ej. orchestratorId, positionIdentifier)
 * @param {string} args.action        'modify-range', 'close-keep-assets', etc
 * @param {object} args.txPlan
 * @param {object} args.finalizePayload
 * @param {string[]} args.hashes      hashes ya firmados (índice = posición en txPlan)
 * @param {number} args.completedIndex último tx confirmado (-1 si nada todavía)
 * @param {string} args.status        'in_progress' | 'finalize_pending' | 'done' | 'failed'
 */
export function saveInFlightPlan(entry) {
  if (!entry?.planKey) return;
  const all = pruneStale(safeReadAll());
  all[entry.planKey] = {
    ...entry,
    updatedAt: Date.now(),
    startedAt: all[entry.planKey]?.startedAt || Date.now(),
  };
  safeWriteAll(all);
}

export function clearInFlightPlan(planKey) {
  if (!planKey) return;
  const all = safeReadAll();
  if (all[planKey]) {
    delete all[planKey];
    safeWriteAll(all);
  }
}

export function getInFlightPlan(planKey) {
  const all = pruneStale(safeReadAll());
  return all[planKey] || null;
}

/**
 * Devuelve todos los planes en curso asociados a un `scope` (típicamente
 * `orchestrator-${id}`). El modal puede usar esto al abrir para ofrecer
 * "tenés operaciones pendientes" sin saber la planKey exacta.
 */
export function listInFlightPlansForScope(scope) {
  if (!scope) return [];
  const all = pruneStale(safeReadAll());
  return Object.values(all).filter((entry) => entry?.scope === scope);
}

export function pruneAllStale() {
  safeWriteAll(pruneStale(safeReadAll()));
}
