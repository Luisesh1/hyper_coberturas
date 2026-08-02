/**
 * Pools favoritos del selector del wizard.
 *
 * Viven en localStorage y no en el servidor a proposito: es una preferencia de
 * navegador, sin valor si se pierde, y guardarla local evita una migracion y
 * un round-trip en cada apertura del wizard.
 *
 * La clave incluye red y version porque el mismo par con la misma fee es un
 * pool distinto en cada una — marcar WETH/USDC 0.05% en Arbitrum v3 no deberia
 * marcarlo en Base v4.
 */

const STORAGE_KEY = 'lpOrchestrator.favoritePools.v1';

export function favoriteKeyOf({ network, version, poolKey }) {
  if (!network || !version || !poolKey) return null;
  return `${network}:${version}:${poolKey}`;
}

/**
 * Nunca tira: un localStorage inaccesible (modo incognito estricto, permisos)
 * o un JSON corrupto no puede romper el selector de pools.
 */
export function loadFavorites() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function saveFavorites(favorites) {
  try {
    const unicos = Array.from(new Set((favorites || []).filter(Boolean)));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(unicos));
    return unicos;
  } catch {
    return favorites || [];
  }
}

export function toggleFavorite(favorites, key) {
  if (!key) return favorites || [];
  const actuales = favorites || [];
  const siguiente = actuales.includes(key)
    ? actuales.filter((item) => item !== key)
    : [...actuales, key];
  return saveFavorites(siguiente);
}

/**
 * Los favoritos van primero, y dentro de cada grupo se respeta el orden que
 * venia del servidor (ya viene por liquidez). `sort` de JS es estable, asi
 * que alcanza con comparar la condicion de favorito.
 */
export function sortFavoritesFirst(pools, { favorites, network, version, poolKeyOf }) {
  const set = new Set(favorites || []);
  const esFavorito = (pool) => set.has(favoriteKeyOf({ network, version, poolKey: poolKeyOf(pool) }));
  return [...(pools || [])].sort((a, b) => Number(esFavorito(b)) - Number(esFavorito(a)));
}
