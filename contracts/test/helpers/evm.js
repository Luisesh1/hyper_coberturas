'use strict';

// Harness de EVM en proceso para ejecutar el bytecode real de VolatilityShieldV1.
//
// No usamos Foundry/Hardhat/ganache: montamos una @ethereumjs/evm mínima y
// escribimos el runtime bytecode del hook directamente en una dirección
// elegida a mano cuyos bits bajos llevan el flag BEFORE_SWAP (0x80) que
// BaseHook.validateHookAddress exige. Así evitamos el problema de "minar"
// una dirección con CREATE2: en un despliegue real hace falta buscar un
// salt que produzca esos bits; aquí basta con inyectar el código en la
// dirección que ya cumple la condición.
//
// El truco tiene una trampa: `poolManager` es `immutable` en ImmutableState
// (heredado por BaseHook). El compilador solo "hornea" ese valor dentro del
// runtime bytecode cuando el contrato pasa por su constructor real; el
// `evm.deployedBytecode.object` que emite solc trae esos huecos rellenos de
// ceros (ver `immutableReferences`). Como aquí saltamos el constructor,
// parcheamos esos huecos a mano con la dirección de nuestro PoolManager
// simulado antes de inyectar el bytecode. Alternativa descartada: desplegar
// de verdad con CREATE2 minando el salt — funciona, pero es complejidad de
// más cuando parchear los huecos declarados por el propio compilador es
// determinista y no depende de fuerza bruta.
//
// Esta compilación es independiente de `scripts/compile.js`: ese script
// genera el artefacto reproducible que consume el registro de contratos del
// servidor y no debe tocarse para las necesidades de este arnés de pruebas.

const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { Interface } = require('ethers');
const { createEVM } = require('@ethereumjs/evm');
const { SimpleStateManager } = require('@ethereumjs/statemanager');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const { Address, hexToBytes, setLengthLeft, bigIntToBytes, createZeroAddress } = require('@ethereumjs/util');

const root = path.resolve(__dirname, '..', '..');
const sourcePath = path.join(root, 'src', 'VolatilityShieldV1.sol');

// Bits bajos = 0x0080 = BEFORE_SWAP_FLAG (1 << 7) y ningún otro flag de Hooks.sol.
const HOOK_ADDRESS = new Address(hexToBytes('0x0000000000000000000000000000000000000080'));
// Dirección arbitraria sin flags de hook: aquí vive el PoolManager simulado.
const POOL_MANAGER_ADDRESS = new Address(hexToBytes(`0x${'0'.repeat(36)}9999`));
const SWAP_ROUTER_ADDRESS = new Address(hexToBytes(`0x${'0'.repeat(36)}aaaa`));

const LP_FEE_OVERRIDE_FLAG = 0x400000n; // LPFeeLibrary.OVERRIDE_FEE_FLAG
const DEFAULT_SQRT_PRICE_X96 = 1n << 96n; // precio 1:1

// PoolManager simulado: ignora selector y argumentos, y devuelve la palabra
// almacenada en su slot 0 de storage ante cualquier llamada. Es justo lo que
// necesita `StateLibrary.getSlot0`, que resuelve todo con un único
// `extsload(bytes32)` de bajo nivel (ver @uniswap/v4-core StateLibrary.sol).
// Bytecode: PUSH1 0x00; SLOAD; PUSH1 0x00; MSTORE; PUSH1 0x20; PUSH1 0x00; RETURN
const POOL_MANAGER_MOCK_CODE = hexToBytes('0x60005460005260206000f3');

let compiledHookCache;

function findImports(importPath) {
  try {
    return { contents: fs.readFileSync(path.join(root, 'node_modules', importPath), 'utf8') };
  } catch (error) {
    return { error: `No se pudo resolver ${importPath}: ${error.message}` };
  }
}

function compileHook() {
  const input = {
    language: 'Solidity',
    sources: { 'VolatilityShieldV1.sol': { content: fs.readFileSync(sourcePath, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': { '*': ['abi', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (output.errors || []).filter((item) => item.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
  return output.contracts['VolatilityShieldV1.sol'].VolatilityShieldV1;
}

function patchImmutables(runtimeHex, immutableReferences, poolManagerAddress) {
  const bytes = hexToBytes(`0x${runtimeHex}`);
  const addressWord = setLengthLeft(poolManagerAddress.bytes, 32);
  for (const refs of Object.values(immutableReferences || {})) {
    for (const { start, length } of refs) {
      bytes.set(addressWord.slice(addressWord.length - length), start);
    }
  }
  return bytes;
}

// Compilamos una sola vez por proceso: cada compilación con solc tarda
// segundos (importa @uniswap/v4-core y v4-periphery enteros) y el resultado
// es determinista, así que cachearlo evita repetir el costo en cada prueba
// del mismo archivo.
function getCompiledHook() {
  if (!compiledHookCache) {
    const artifact = compileHook();
    const runtimeCode = patchImmutables(
      artifact.evm.deployedBytecode.object,
      artifact.evm.deployedBytecode.immutableReferences,
      POOL_MANAGER_ADDRESS,
    );
    compiledHookCache = { abi: artifact.abi, runtimeCode };
  }
  return compiledHookCache;
}

function makeBlock(timestamp) {
  return {
    header: {
      number: 1n,
      coinbase: createZeroAddress(),
      timestamp: BigInt(timestamp),
      difficulty: 0n,
      prevRandao: new Uint8Array(32),
      gasLimit: 30_000_000n,
      baseFeePerGas: 0n,
      getBlobGasPrice: () => 0n,
    },
  };
}

function encodeSlot0({ tick, sqrtPriceX96 = DEFAULT_SQRT_PRICE_X96, protocolFee = 0, lpFee = 0 }) {
  const tick24 = BigInt.asUintN(24, BigInt(tick));
  const word =
    (BigInt(lpFee) << 208n) |
    (BigInt(protocolFee) << 184n) |
    (tick24 << 160n) |
    (BigInt(sqrtPriceX96) & ((1n << 160n) - 1n));
  return setLengthLeft(bigIntToBytes(word), 32);
}

function describeRevert(iface, returnValue) {
  if (returnValue.length === 0) return 'sin datos de retorno';
  try {
    const parsed = iface.parseError(returnValue);
    if (parsed) return `${parsed.name}(${parsed.args.join(', ')})`;
  } catch {
    // no era un error conocido de la ABI del hook; se cae al hex crudo.
  }
  return `datos crudos 0x${Buffer.from(returnValue).toString('hex')}`;
}

async function createHookHarness() {
  const { abi, runtimeCode } = getCompiledHook();
  const iface = new Interface(abi);

  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
  const stateManager = new SimpleStateManager({ common });
  const evm = await createEVM({ common, stateManager });

  await stateManager.putCode(HOOK_ADDRESS, runtimeCode);
  await stateManager.putCode(POOL_MANAGER_ADDRESS, POOL_MANAGER_MOCK_CODE);

  async function setSlot0(slot0) {
    await stateManager.putStorage(POOL_MANAGER_ADDRESS, new Uint8Array(32), encodeSlot0(slot0));
  }

  async function call(functionName, args, { caller = createZeroAddress(), timestamp = 0n } = {}) {
    const data = iface.encodeFunctionData(functionName, args);
    const result = await evm.runCall({
      to: HOOK_ADDRESS,
      caller,
      data: hexToBytes(data),
      gasLimit: 5_000_000n,
      block: makeBlock(timestamp),
    });
    const { execResult } = result;
    if (execResult.exceptionError) {
      throw new Error(
        `revert en ${functionName}: ${describeRevert(iface, execResult.returnValue)} (${execResult.exceptionError.error})`,
      );
    }
    return iface.decodeFunctionResult(functionName, execResult.returnValue);
  }

  async function beforeSwap({ key, params, hookData = '0x', sender = createZeroAddress().toString(), timestamp }) {
    const [selector, delta, fee] = await call('beforeSwap', [sender, key, params, hookData], {
      caller: POOL_MANAGER_ADDRESS,
      timestamp,
    });
    return { selector, delta, fee };
  }

  async function readConstant(name) {
    const [value] = await call(name, []);
    return value;
  }

  return {
    hookAddress: HOOK_ADDRESS.toString(),
    poolManagerAddress: POOL_MANAGER_ADDRESS.toString(),
    swapRouterAddress: SWAP_ROUTER_ADDRESS.toString(),
    iface,
    setSlot0,
    beforeSwap,
    readConstant,
  };
}

module.exports = {
  createHookHarness,
  LP_FEE_OVERRIDE_FLAG,
  DEFAULT_SQRT_PRICE_X96,
};
