'use strict';

// Harness de EVM en proceso para ejecutar el bytecode real de VolatilityShieldV1.
//
// No usamos Foundry/Hardhat/ganache: montamos una @ethereumjs/evm mínima y
// escribimos el runtime bytecode del hook directamente en una dirección
// elegida a mano cuyos bits bajos llevan el flag BEFORE_SWAP (0x80) que
// BaseHook.validateHookAddress exige. Un revisor confirmó, desplegando con
// CREATE2 y comparando byte a byte, que el runtime parcheado a mano coincide
// exactamente con el de un despliegue real.
//
// Ese revisor señaló con razón que la inyección manual, por sí sola, no ata
// la dirección elegida a la máscara de `getHookPermissions()`: si el
// contrato ganara un flag nuevo (p.ej. `afterSwap: true`), este arnés
// seguiría inyectando en la misma dirección y todos los tests seguirían en
// verde, aunque un despliegue real revertiría con `HookAddressNotValid`. Por
// eso `createHookHarness()` expone `readHookPermissions()` y el archivo de
// pruebas verifica explícitamente que los bits bajos de HOOK_ADDRESS
// coinciden con lo que el contrato declara — así, si la máscara cambia sin
// re-elegir la dirección, la prueba falla. Se prefirió esto sobre desplegar
// de verdad con CREATE2 minando un salt (la otra opción válida) porque no
// exige repetir la lógica de mining ni tocar el resto del arnés, y cierra el
// mismo hueco: la prueba directamente reimplementa la comprobación de
// `Hooks.validateHookPermissions` contra el bytecode real.
//
// El truco de inyectar el runtime directamente tiene una segunda trampa:
// `poolManager` es `immutable` en ImmutableState (heredado por BaseHook). El
// compilador solo "hornea" ese valor dentro del runtime bytecode cuando el
// contrato pasa por su constructor real; el `evm.deployedBytecode.object`
// que emite solc trae esos huecos rellenos de ceros (ver
// `immutableReferences`). Como aquí saltamos el constructor, parcheamos esos
// huecos a mano con la dirección de nuestro PoolManager simulado antes de
// inyectar el bytecode.
//
// Esta compilación es independiente de `scripts/compile.js`: ese script
// genera el artefacto reproducible que consume el registro de contratos del
// servidor y no debe tocarse para las necesidades de este arnés de pruebas.
// Para que ambas compilaciones no diverjan en silencio (mismo código, mismos
// ajustes de optimizador, mismo evmVersion), `getRawRuntimeBytecode()` expone
// el `deployedBytecode.object` crudo (con los immutables aún a cero) para que
// las pruebas lo comparen contra `artifacts/VolatilityShieldV1.json`.

const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { Interface, AbiCoder, keccak256, concat, id, toBeHex, zeroPadValue } = require('ethers');
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
const ALL_HOOK_MASK = 0x3fffn; // Hooks.ALL_HOOK_MASK: 14 bits bajos

// Orden y peso de bits tal como los declara Hooks.sol. Es la misma tabla que
// usa `Hooks.validateHookPermissions` para comparar la máscara de permisos
// contra los bits bajos de la dirección del hook.
const HOOK_FLAG_BITS = {
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnDelta: 1 << 3,
  afterSwapReturnDelta: 1 << 2,
  afterAddLiquidityReturnDelta: 1 << 1,
  afterRemoveLiquidityReturnDelta: 1 << 0,
};

// bytes32 constant POOLS_SLOT = bytes32(uint256(6)); en StateLibrary.sol.
const POOLS_SLOT = zeroPadValue(toBeHex(6n), 32);

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
    const rawRuntimeBytecode = `0x${artifact.evm.deployedBytecode.object}`;
    const runtimeCode = patchImmutables(
      artifact.evm.deployedBytecode.object,
      artifact.evm.deployedBytecode.immutableReferences,
      POOL_MANAGER_ADDRESS,
    );
    compiledHookCache = { abi: artifact.abi, runtimeCode, rawRuntimeBytecode };
  }
  return compiledHookCache;
}

// Runtime bytecode tal como lo emite solc, ANTES de parchear los huecos de
// `immutable` (siguen a cero, igual que en `evm.deployedBytecode.object`).
// Sirve para anclar esta compilación de pruebas a la de producción: si
// `scripts/compile.js` cambiara `evmVersion`, `runs`, o el propio fuente
// cambiara sin que este arnés se actualizara, la comparación byte a byte
// contra `artifacts/VolatilityShieldV1.json` lo detecta.
function getRawRuntimeBytecode() {
  return getCompiledHook().rawRuntimeBytecode;
}

// PoolManager simulado. Solo entiende `extsload(bytes32)` (la única lectura
// que el hook hace sobre el PoolManager, vía StateLibrary.getSlot0) y
// devuelve el storage de ESE slot exacto, indexado por lo que venga en
// calldata — no un valor fijo. Cualquier otro selector revierte: una lectura
// nueva que el hook añadiera contra el PoolManager (p.ej. para TWAP) fallaría
// aquí en vez de devolver silenciosamente una palabra cualquiera reinterpretada.
//
// Ensamblado a mano en vez de compilado para no añadir dependencias ni un
// contrato Solidity extra:
//   PUSH1 0; CALLDATALOAD; PUSH1 0xe0; SHR         -- extrae el selector (4 bytes altos)
//   PUSH4 <selector extsload(bytes32)>; EQ; ISZERO
//   PUSH1 <destino>; JUMPI                          -- salta a revertir si no coincide
//   PUSH1 4; CALLDATALOAD; SLOAD                    -- slot = calldata[4:36]; sload(slot)
//   PUSH1 0; MSTORE; PUSH1 0x20; PUSH1 0; RETURN
//   JUMPDEST; PUSH1 0; PUSH1 0; REVERT
function buildPoolManagerMockCode() {
  const selector = Array.from(hexToBytes(id('extsload(bytes32)').slice(0, 10)));
  const push1 = (n) => [0x60, n];

  const header = [...push1(0x00), 0x35, ...push1(0xe0), 0x1c, 0x63, ...selector, 0x14, 0x15];
  const matched = [...push1(0x04), 0x35, 0x54, ...push1(0x00), 0x52, ...push1(0x20), ...push1(0x00), 0xf3];
  const reverted = [0x5b, ...push1(0x00), ...push1(0x00), 0xfd];

  const code = [...header, ...push1(0x00) /* placeholder de destino */, 0x57, ...matched];
  const destIndex = header.length + 1; // byte del PUSH1 que llevará el destino de salto
  const jumpDest = code.length; // el JUMPDEST arranca justo después del bloque "matched"
  code[destIndex] = jumpDest;
  code.push(...reverted);

  return Uint8Array.from(code);
}

const POOL_MANAGER_MOCK_CODE = buildPoolManagerMockCode();

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

// keccak256(abi.encode(key)), tal como lo calcula _beforeSwap para indexar
// tanto el storage del PoolManager como su propio mapping `poolState`.
function computePoolId(key) {
  const encodedKey = AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  );
  return keccak256(encodedKey);
}

// Reproduce StateLibrary._getPoolStateSlot: keccak256(abi.encodePacked(poolId, POOLS_SLOT)).
// Cada PoolKey obtiene así su propio slot en el storage del PoolManager
// simulado — dos pools distintos ya no comparten tarifa.
function computePoolStateSlot(key) {
  return keccak256(concat([computePoolId(key), POOLS_SLOT]));
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

  async function setSlot0({ key, tick, sqrtPriceX96, protocolFee, lpFee }) {
    const slot = computePoolStateSlot(key);
    await stateManager.putStorage(
      POOL_MANAGER_ADDRESS,
      hexToBytes(slot),
      encodeSlot0({ tick, sqrtPriceX96, protocolFee, lpFee }),
    );
  }

  async function call(functionName, args, { caller = createZeroAddress(), timestamp = 0n, to = HOOK_ADDRESS } = {}) {
    const data = iface.encodeFunctionData(functionName, args);
    const result = await evm.runCall({
      to,
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

  async function readHookPermissions() {
    const [permissions] = await call('getHookPermissions', []);
    return permissions;
  }

  // Estado interno que el hook lleva para ese pool, vía el getter público del
  // mapping. Permite observar el acumulador del TWAP directamente, en vez de
  // inferirlo del fee (que satura y esconde la magnitud real de la señal).
  // Los campos se leen por nombre desde la ABI: `readPoolState(key).tickCumulative`.
  async function readPoolState(key) {
    return call('poolState', [computePoolId(key)]);
  }

  // Llama directamente al PoolManager simulado (sin pasar por el hook), para
  // poder probar su comportamiento ante selectores desconocidos.
  async function callPoolManagerMock(rawData, { caller = createZeroAddress() } = {}) {
    const result = await evm.runCall({
      to: POOL_MANAGER_ADDRESS,
      caller,
      data: hexToBytes(rawData),
      gasLimit: 1_000_000n,
      block: makeBlock(0n),
    });
    return result.execResult;
  }

  return {
    hookAddress: HOOK_ADDRESS.toString(),
    poolManagerAddress: POOL_MANAGER_ADDRESS.toString(),
    swapRouterAddress: SWAP_ROUTER_ADDRESS.toString(),
    iface,
    setSlot0,
    beforeSwap,
    readConstant,
    readHookPermissions,
    readPoolState,
    callPoolManagerMock,
  };
}

module.exports = {
  createHookHarness,
  getRawRuntimeBytecode,
  computePoolId,
  computePoolStateSlot,
  HOOK_FLAG_BITS,
  ALL_HOOK_MASK,
  LP_FEE_OVERRIDE_FLAG,
  DEFAULT_SQRT_PRICE_X96,
};
