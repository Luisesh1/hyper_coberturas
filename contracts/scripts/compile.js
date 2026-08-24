const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { keccak256 } = require('ethers');

const root = path.resolve(__dirname, '..');
const sourceName = 'VolatilityShieldV1.sol';
const sourcePath = path.join(root, 'src', sourceName);

function findImports(importPath) {
  try {
    return { contents: fs.readFileSync(path.join(root, 'node_modules', importPath), 'utf8') };
  } catch (error) {
    return { error: `No se pudo resolver ${importPath}: ${error.message}` };
  }
}

const input = {
  language: 'Solidity',
  sources: { [sourceName]: { content: fs.readFileSync(sourcePath, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors || []).filter((item) => item.severity === 'error');
if (errors.length > 0) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));

const compiled = output.contracts[sourceName].VolatilityShieldV1;
const creationBytecode = `0x${compiled.evm.bytecode.object}`;
const runtimeBytecode = `0x${compiled.evm.deployedBytecode.object}`;
const artifact = {
  contractName: 'VolatilityShieldV1',
  compiler: `solc ${solc.version()}`,
  abi: compiled.abi,
  creationBytecode,
  runtimeBytecode,
  runtimeBytecodeHash: keccak256(runtimeBytecode),
};

const outputDir = path.join(root, 'artifacts');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'VolatilityShieldV1.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log('VolatilityShieldV1 artifact generated.');
