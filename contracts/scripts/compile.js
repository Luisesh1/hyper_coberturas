const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { keccak256 } = require('ethers');
const { POOL_MANAGERS } = require('./pool-managers');
const {
  parseHookPermissions, flagsForPermissions, buildInitcode, mineSalt,
} = require('./hook-address');

const root = path.resolve(__dirname, '..');
const sourceName = 'VolatilityShieldV1.sol';
const sourcePath = path.join(root, 'src', sourceName);

// Subela a mano si cambia el codigo: las versiones del registro son inmutables.
const CONTRACT_VERSION = '1.0.0';

function findImports(importPath) {
  try {
    return { contents: fs.readFileSync(path.join(root, 'node_modules', importPath), 'utf8') };
  } catch (error) {
    return { error: `No se pudo resolver ${importPath}: ${error.message}` };
  }
}

const source = fs.readFileSync(sourcePath, 'utf8');

const input = {
  language: 'Solidity',
  sources: { [sourceName]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': {
        '*': [
          'abi',
          'evm.bytecode.object',
          'evm.deployedBytecode.object',
          'evm.deployedBytecode.immutableReferences',
        ],
      },
    },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors || []).filter((item) => item.severity === 'error');
if (errors.length > 0) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));

const compiled = output.contracts[sourceName].VolatilityShieldV1;
const creationBytecode = `0x${compiled.evm.bytecode.object}`;
const runtimeBytecode = `0x${compiled.evm.deployedBytecode.object}`;
const permissions = parseHookPermissions(source);
const hookFlags = flagsForPermissions(permissions);

// La salt se mina AQUI, en build, y se commitea: son ~16.384 intentos de media
// y hacerlo en caliente bloquearia el event loop del servidor varios segundos.
const networks = {};
for (const [network, poolManager] of Object.entries(POOL_MANAGERS)) {
  const initcodeHash = keccak256(buildInitcode(creationBytecode, poolManager));
  const { salt, address, attempts } = mineSalt(initcodeHash, hookFlags);
  networks[network] = { poolManager, salt, initcodeHash, predictedAddress: address };
  console.log(`  ${network}: ${address} (salt minada en ${attempts} intentos)`);
}

const artifact = {
  contractName: 'VolatilityShieldV1',
  version: CONTRACT_VERSION,
  compiler: `solc ${solc.version()}`,
  abi: compiled.abi,
  sourceCode: source,
  sourceHash: keccak256(Buffer.from(source, 'utf8')),
  creationBytecode,
  runtimeBytecode,
  runtimeBytecodeHash: keccak256(runtimeBytecode),
  immutableReferences: compiled.evm.deployedBytecode.immutableReferences || {},
  permissions,
  hookFlags: `0x${hookFlags.toString(16)}`,
  networks,
};

const outputDir = path.join(root, 'artifacts');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'VolatilityShieldV1.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log('VolatilityShieldV1 artifact generated.');
