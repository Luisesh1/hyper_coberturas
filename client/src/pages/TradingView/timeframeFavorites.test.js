import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TF_FAVORITES,
  TF_FAVORITES_STORAGE_KEY,
  loadFavorites,
  saveFavorites,
  toggleFavorite,
  rowItems,
} from './timeframeFavorites';

const ALL = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const TIMEFRAMES = ALL.map((value) => ({ value, label: value }));

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

const throwingStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
};

describe('loadFavorites', () => {
  it('usa los favoritos por defecto si no hay nada guardado', () => {
    expect(TF_FAVORITES_STORAGE_KEY).toBe('tv_tf_favorites_v1');
    expect(DEFAULT_TF_FAVORITES).toEqual(['5m', '15m', '1h', '4h', '1d']);
    expect(loadFavorites(ALL, memoryStorage())).toEqual(DEFAULT_TF_FAVORITES);
  });

  it('lee, filtra valores desconocidos, deduplica y ordena', () => {
    const storage = memoryStorage({ [TF_FAVORITES_STORAGE_KEY]: JSON.stringify(['1d', 'x', '1m', '1d']) });
    expect(loadFavorites(ALL, storage)).toEqual(['1m', '1d']);
  });

  it('vuelve a los favoritos por defecto si el valor es inválido o queda vacío', () => {
    expect(loadFavorites(ALL, memoryStorage({ [TF_FAVORITES_STORAGE_KEY]: '{oops' }))).toEqual(DEFAULT_TF_FAVORITES);
    expect(loadFavorites(ALL, memoryStorage({ [TF_FAVORITES_STORAGE_KEY]: '"1h"' }))).toEqual(DEFAULT_TF_FAVORITES);
    expect(loadFavorites(ALL, memoryStorage({ [TF_FAVORITES_STORAGE_KEY]: '["zz"]' }))).toEqual(DEFAULT_TF_FAVORITES);
  });

  it('no rompe si localStorage lanza', () => {
    expect(loadFavorites(ALL, throwingStorage)).toEqual(DEFAULT_TF_FAVORITES);
  });
});

describe('saveFavorites', () => {
  it('guarda como JSON y no rompe si localStorage lanza', () => {
    const storage = memoryStorage();
    saveFavorites(['1h', '1d'], storage);
    expect(storage.data[TF_FAVORITES_STORAGE_KEY]).toBe('["1h","1d"]');
    expect(() => saveFavorites(['1h'], throwingStorage)).not.toThrow();
  });
});

describe('toggleFavorite', () => {
  it('añade manteniendo el orden de las temporalidades', () => {
    expect(toggleFavorite(['5m', '1d'], '1h', ALL)).toEqual(['5m', '1h', '1d']);
  });

  it('quita un favorito existente', () => {
    expect(toggleFavorite(['5m', '1h', '1d'], '1h', ALL)).toEqual(['5m', '1d']);
  });

  it('nunca quita el último favorito', () => {
    const favs = ['1h'];
    expect(toggleFavorite(favs, '1h', ALL)).toBe(favs);
  });

  it('ignora temporalidades desconocidas', () => {
    const favs = ['1h'];
    expect(toggleFavorite(favs, 'zz', ALL)).toBe(favs);
  });
});

describe('rowItems', () => {
  it('muestra solo favoritos en el orden de TIMEFRAMES', () => {
    expect(rowItems(TIMEFRAMES, ['1d', '5m'], '5m').map((t) => t.value)).toEqual(['5m', '1d']);
  });

  it('incluye la temporalidad activa aunque no sea favorita', () => {
    expect(rowItems(TIMEFRAMES, ['5m', '1d'], '1w').map((t) => t.value)).toEqual(['5m', '1d', '1w']);
    expect(rowItems(TIMEFRAMES, ['5m', '1d'], '1m').map((t) => t.value)).toEqual(['1m', '5m', '1d']);
  });
});
