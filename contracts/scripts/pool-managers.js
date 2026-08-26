/**
 * Direccion del PoolManager de Uniswap v4 por red.
 *
 * Se declara aqui porque `contracts/` no puede importar el modulo del
 * servidor. `scripts/check-hook-catalog.mjs` comprueba que ambos mapas
 * coincidan, de modo que no puedan divergir en silencio.
 */
const POOL_MANAGERS = Object.freeze({
  ethereum: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  arbitrum: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  base: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  'base-sepolia': '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
  optimism: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
  polygon: '0x67366782805870060151383f4bbff9dab53e5cd6',
});

module.exports = { POOL_MANAGERS };
