import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  favoriteKeyOf,
  loadFavorites,
  saveFavorites,
  sortFavoritesFirst,
  toggleFavorite,
} from './favoritePools';

const poolKeyOf = (pool) => `${pool.token0.address}-${pool.token1.address}-${pool.fee}`;

function pool(symbol, fee) {
  return { label: symbol, fee, token0: { address: `0x${symbol}0` }, token1: { address: `0x${symbol}1` } };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('favoriteKeyOf', () => {
  // El mismo par con la misma fee es un pool distinto en cada red y version:
  // marcar WETH/USDC 0.05% en Arbitrum v3 no deberia marcarlo en Base v4.
  it('distingue red y versión', () => {
    const poolKey = 'a-b-500';
    expect(favoriteKeyOf({ network: 'arbitrum', version: 'v3', poolKey }))
      .not.toBe(favoriteKeyOf({ network: 'arbitrum', version: 'v4', poolKey }));
    expect(favoriteKeyOf({ network: 'arbitrum', version: 'v3', poolKey }))
      .not.toBe(favoriteKeyOf({ network: 'base', version: 'v3', poolKey }));
  });

  it('devuelve null si falta algún dato', () => {
    expect(favoriteKeyOf({ network: 'arbitrum', version: 'v3' })).toBeNull();
    expect(favoriteKeyOf({ network: '', version: 'v3', poolKey: 'x' })).toBeNull();
  });
});

describe('toggleFavorite', () => {
  it('agrega, quita y persiste', () => {
    const key = favoriteKeyOf({ network: 'arbitrum', version: 'v4', poolKey: 'a-b-3000' });
    const conFav = toggleFavorite([], key);
    expect(conFav).toEqual([key]);
    expect(loadFavorites()).toEqual([key]);

    const sinFav = toggleFavorite(conFav, key);
    expect(sinFav).toEqual([]);
    expect(loadFavorites()).toEqual([]);
  });

  it('no duplica ni rompe con una key nula', () => {
    expect(toggleFavorite(['a'], null)).toEqual(['a']);
    expect(toggleFavorite(['a'], 'a')).toEqual([]);
    expect(saveFavorites(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('loadFavorites', () => {
  it('tolera JSON corrupto y contenido inesperado', () => {
    window.localStorage.setItem('lpOrchestrator.favoritePools.v1', '{no es json');
    expect(loadFavorites()).toEqual([]);

    window.localStorage.setItem('lpOrchestrator.favoritePools.v1', '{"a":1}');
    expect(loadFavorites()).toEqual([]);

    window.localStorage.setItem('lpOrchestrator.favoritePools.v1', '["ok", 5, null]');
    expect(loadFavorites()).toEqual(['ok']);
  });

  // Un localStorage inaccesible no puede tumbar el selector de pools.
  it('no explota si localStorage falla', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'getItem')
      .mockImplementation(() => { throw new Error('bloqueado'); });
    expect(loadFavorites()).toEqual([]);
    spy.mockRestore();
  });
});

describe('sortFavoritesFirst', () => {
  it('sube los favoritos y conserva el orden original dentro de cada grupo', () => {
    const pools = [pool('AAA', 500), pool('BBB', 500), pool('CCC', 500)];
    const favorites = [
      favoriteKeyOf({ network: 'arbitrum', version: 'v4', poolKey: poolKeyOf(pools[2]) }),
    ];
    const ordenados = sortFavoritesFirst(pools, {
      favorites, network: 'arbitrum', version: 'v4', poolKeyOf,
    });
    expect(ordenados.map((p) => p.label)).toEqual(['CCC', 'AAA', 'BBB']);
  });

  it('no altera la lista cuando no hay favoritos', () => {
    const pools = [pool('AAA', 500), pool('BBB', 500)];
    const ordenados = sortFavoritesFirst(pools, {
      favorites: [], network: 'arbitrum', version: 'v4', poolKeyOf,
    });
    expect(ordenados.map((p) => p.label)).toEqual(['AAA', 'BBB']);
  });

  it('no muta el array recibido', () => {
    const pools = [pool('AAA', 500), pool('BBB', 500)];
    const favorites = [
      favoriteKeyOf({ network: 'arbitrum', version: 'v4', poolKey: poolKeyOf(pools[1]) }),
    ];
    sortFavoritesFirst(pools, { favorites, network: 'arbitrum', version: 'v4', poolKeyOf });
    expect(pools.map((p) => p.label)).toEqual(['AAA', 'BBB']);
  });
});
