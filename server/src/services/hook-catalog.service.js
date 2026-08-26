/**
 * Reglas puras sobre el catalogo de hooks desplegables.
 *
 * Dos cosas que solo se pueden hacer con el catalogo delante:
 *
 * 1. Reconstruir el bytecode runtime ESPERADO. `poolManager` es `immutable`
 *    en `BaseHook`, y Solidity graba los immutables dentro del runtime al
 *    desplegar, asi que el runtime que emite solc (con ceros en esos huecos)
 *    nunca coincide con el que devuelve el RPC. Sin este relleno, comparar
 *    hashes no demuestra nada.
 * 2. Armar la calldata del proxy CREATE2: `salt + initcode`.
 */
const { ethers } = require('ethers');
const { getCatalogEntry, listCatalog } = require('../contracts/catalog');

const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

function networkEntry(entry, network) {
  const found = entry?.networks?.[network];
  if (!found) throw new Error(`El catalogo no cubre la red ${network} para ${entry?.contractName}`);
  return found;
}

function expectedRuntimeBytecode(entry, network) {
  const { poolManager } = networkEntry(entry, network);
  const bytes = Buffer.from(entry.runtimeBytecode.slice(2), 'hex');
  const word = Buffer.from(ethers.zeroPadValue(poolManager, 32).slice(2), 'hex');
  const groups = Object.values(entry.immutableReferences || {});
  if (groups.length !== 1) {
    throw new Error(`Se esperaba exactamente un immutable (poolManager) y hay ${groups.length}`);
  }
  for (const { start, length } of groups[0]) {
    if (length !== 32) throw new Error(`Los immutables deben ocupar 32 bytes y este ocupa ${length}`);
    word.copy(bytes, start);
  }
  return `0x${bytes.toString('hex')}`;
}

function expectedRuntimeHash(entry, network) {
  return ethers.keccak256(expectedRuntimeBytecode(entry, network));
}

function buildDeploymentCalldata(entry, network) {
  const { poolManager, salt } = networkEntry(entry, network);
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [poolManager]);
  return `${salt}${entry.creationBytecode.slice(2)}${constructorArgs.slice(2)}`;
}

function classifyOnchainCode(entry, network, code) {
  if (!code || code === '0x') return 'deployable';
  return ethers.keccak256(code) === expectedRuntimeHash(entry, network) ? 'deployed' : 'address_taken';
}

module.exports = {
  CREATE2_PROXY,
  getCatalogEntry,
  listCatalog,
  networkEntry,
  expectedRuntimeBytecode,
  expectedRuntimeHash,
  buildDeploymentCalldata,
  classifyOnchainCode,
};
