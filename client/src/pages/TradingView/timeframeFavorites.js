// Temporalidades favoritas de la fila móvil. Lógica pura (el storage se
// inyecta) para poder testearla sin DOM.
export const TF_FAVORITES_STORAGE_KEY = 'tv_tf_favorites_v1';
export const DEFAULT_TF_FAVORITES = ['5m', '15m', '1h', '4h', '1d'];

// Filtra valores desconocidos, deduplica y ordena como `allValues`.
function normalize(list, allValues) {
  const set = new Set(list);
  return allValues.filter((v) => set.has(v));
}

export function loadFavorites(allValues, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(TF_FAVORITES_STORAGE_KEY);
    if (!raw) return DEFAULT_TF_FAVORITES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_TF_FAVORITES;
    const favs = normalize(parsed, allValues);
    return favs.length > 0 ? favs : DEFAULT_TF_FAVORITES;
  } catch {
    return DEFAULT_TF_FAVORITES;
  }
}

export function saveFavorites(favorites, storage = globalThis.localStorage) {
  try { storage?.setItem(TF_FAVORITES_STORAGE_KEY, JSON.stringify(favorites)); } catch { /* noop */ }
}

// Añade o quita `value`. Nunca deja la fila vacía: el último favorito no se
// puede quitar (devuelve la misma referencia para no re-renderizar).
export function toggleFavorite(favorites, value, allValues) {
  if (!allValues.includes(value)) return favorites;
  if (favorites.includes(value)) {
    if (favorites.length <= 1) return favorites;
    return favorites.filter((v) => v !== value);
  }
  return normalize([...favorites, value], allValues);
}

// Botones de la fila: favoritos + la activa (siempre visible aunque no sea
// favorita), en el orden canónico de TIMEFRAMES.
export function rowItems(timeframes, favorites, active) {
  return timeframes.filter((t) => t.value === active || favorites.includes(t.value));
}
