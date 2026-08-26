/**
 * Guardia de coherencia del catalogo de hooks. Falla si:
 *  1. el catalogo del servidor difiere del artefacto de `contracts/`;
 *  2. las direcciones de PoolManager difieren de las de `networks.js`.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'contracts', 'artifacts');
const to = join(root, 'server', 'src', 'contracts', 'catalog');

const problems = [];
const files = readdirSync(from).filter((name) => name.endsWith('.json'));

for (const name of files) {
  const target = join(to, name);
  if (!existsSync(target)) {
    problems.push(`${name}: falta en server/src/contracts/catalog — ejecuta \`npm run sync:artifacts\``);
    continue;
  }
  if (readFileSync(join(from, name), 'utf8') !== readFileSync(target, 'utf8')) {
    problems.push(`${name}: el catalogo del servidor esta desincronizado — ejecuta \`npm run sync:artifacts\``);
  }
}

const { POOL_MANAGERS } = require(join(root, 'contracts', 'scripts', 'pool-managers.js'));
const { getNetworkConfig } = require(join(root, 'server', 'src', 'services', 'uniswap', 'networks.js'));
for (const [network, address] of Object.entries(POOL_MANAGERS)) {
  const configured = getNetworkConfig(network)?.deployments?.v4?.eventSource;
  if (String(configured).toLowerCase() !== String(address).toLowerCase()) {
    problems.push(`${network}: pool-managers.js dice ${address} y networks.js dice ${configured}`);
  }
}

if (problems.length > 0) {
  console.error(`Catalogo de hooks incoherente:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Catalogo de hooks coherente (${files.length} artefacto/s).`);
