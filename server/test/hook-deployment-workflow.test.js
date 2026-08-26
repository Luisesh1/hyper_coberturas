const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { HookDeploymentService } = require('../src/services/hook-deployment.workflow.service');
const { expectedRuntimeBytecode, getCatalogEntry } = require('../src/services/hook-catalog.service');

const ENTRY = getCatalogEntry('VolatilityShieldV1');
const NETWORK = 'base-sepolia';

const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
// Bytecode cualquiera: solo importa que el proxy NO este vacio, que es lo que
// `buildDeploymentPlan` comprueba antes de armar nada.
const PROXY_CODE = `0x${'60'.repeat(69)}`;

function serviceWith({
  code = '0x', proxyCode = PROXY_CODE, repository = {}, verifyVersion = async () => ({}),
} = {}) {
  return new HookDeploymentService({
    providerForNetwork: async () => ({
      getCode: async (address) => (address === CREATE2_PROXY ? proxyCode : code),
    }),
    repository: {
      createContract: async () => 1,
      createVersion: async () => 2,
      recordDeployment: async () => 3,
      listContracts: async () => [],
      ...repository,
    },
    registryService: { verifyVersion },
  });
}

test('describeCatalog marca desplegable cuando la direccion esta vacia', async () => {
  const data = await serviceWith({ code: '0x' }).describeCatalog({ network: NETWORK });
  assert.equal(data.length, 1);
  assert.equal(data[0].contractName, 'VolatilityShieldV1');
  assert.equal(data[0].status, 'deployable');
  assert.equal(data[0].predictedAddress, ENTRY.networks[NETWORK].predictedAddress);
  assert.equal(data[0].isMainnet, false);
});

test('describeCatalog marca desplegado cuando el codigo coincide', async () => {
  const code = expectedRuntimeBytecode(ENTRY, NETWORK);
  const data = await serviceWith({ code }).describeCatalog({ network: NETWORK });
  assert.equal(data[0].status, 'deployed');
});

test('describeCatalog marca direccion ocupada cuando el codigo no coincide', async () => {
  const data = await serviceWith({ code: '0xdeadbeef' }).describeCatalog({ network: NETWORK });
  assert.equal(data[0].status, 'address_taken');
});

test('describeCatalog senala las redes de dinero real', async () => {
  const data = await serviceWith({ code: '0x' }).describeCatalog({ network: 'base' });
  assert.equal(data[0].isMainnet, true);
});

test('buildDeploymentPlan devuelve una tx hacia el proxy CREATE2', async () => {
  const plan = await serviceWith({ code: '0x' }).buildDeploymentPlan({ name: 'VolatilityShieldV1', network: NETWORK });
  assert.equal(plan.tx.to, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
  assert.equal(plan.tx.value, '0x0');
  assert.equal(plan.tx.kind, 'hook_deployment');
  assert.equal(plan.chainId, 84532);
  assert.ok(plan.tx.data.startsWith(ENTRY.networks[NETWORK].salt));
  assert.equal(plan.predictedAddress, ENTRY.networks[NETWORK].predictedAddress);
  assert.equal(plan.isMainnet, false);
});

test('buildDeploymentPlan se niega si la direccion ya tiene el hook', async () => {
  const code = expectedRuntimeBytecode(ENTRY, NETWORK);
  await assert.rejects(
    () => serviceWith({ code }).buildDeploymentPlan({ name: 'VolatilityShieldV1', network: NETWORK }),
    /ya esta desplegado/
  );
});

test('buildDeploymentPlan se niega si la direccion esta ocupada por otro codigo', async () => {
  await assert.rejects(
    () => serviceWith({ code: '0xdeadbeef' }).buildDeploymentPlan({ name: 'VolatilityShieldV1', network: NETWORK }),
    /ocupada/
  );
});

test('buildDeploymentPlan se niega si la red no tiene el proxy CREATE2', async () => {
  await assert.rejects(
    () => serviceWith({ code: '0x', proxyCode: '0x' }).buildDeploymentPlan({ name: 'VolatilityShieldV1', network: NETWORK }),
    /proxy CREATE2 determinista/
  );
});

test('buildDeploymentPlan rechaza un contrato que no esta en el catalogo', async () => {
  await assert.rejects(
    () => serviceWith().buildDeploymentPlan({ name: 'Inventado', network: NETWORK }),
    /no esta en el catalogo/
  );
});

test('adopt registra y verifica cuando el codigo en cadena es el esperado', async () => {
  const calls = [];
  const code = expectedRuntimeBytecode(ENTRY, NETWORK);
  const service = serviceWith({
    code,
    repository: {
      createContract: async (args) => { calls.push(['contract', args.name]); return 11; },
      createVersion: async (args) => { calls.push(['version', args.artifactBytecodeHash]); return 22; },
      recordDeployment: async (args) => { calls.push(['deployment', args.address]); return 33; },
    },
    verifyVersion: async (args) => { calls.push(['verify', args.versionId]); return { status: 'verified' }; },
  });

  const result = await service.adopt({ userId: 5, name: 'VolatilityShieldV1', network: NETWORK, txHash: null });

  assert.equal(result.versionId, 22);
  assert.equal(result.address, ENTRY.networks[NETWORK].predictedAddress);
  assert.deepEqual(calls[0], ['contract', 'VolatilityShieldV1']);
  assert.equal(calls[1][0], 'version');
  // El hash lo calcula el servidor, no lo teclea el usuario: ahi esta el arreglo
  // de la verificacion circular.
  assert.equal(calls[1][1], ethers.keccak256(code));
  assert.deepEqual(calls[2], ['deployment', ENTRY.networks[NETWORK].predictedAddress]);
  assert.deepEqual(calls[3], ['verify', 22]);
});

test('adopt se niega si en la direccion no hay nada', async () => {
  await assert.rejects(
    () => serviceWith({ code: '0x' }).adopt({ userId: 5, name: 'VolatilityShieldV1', network: NETWORK }),
    /no hay ningun contrato/
  );
});

test('adopt es idempotente: si ya esta registrado no duplica', async () => {
  const code = expectedRuntimeBytecode(ENTRY, NETWORK);
  let created = 0;
  const service = serviceWith({
    code,
    repository: {
      createContract: async () => { created += 1; return 1; },
      listContracts: async () => ([{
        id: 99, name: 'VolatilityShieldV1', version: ENTRY.version, status: 'verified',
        deployment: { network: NETWORK, address: ENTRY.networks[NETWORK].predictedAddress },
      }]),
    },
  });

  const result = await service.adopt({ userId: 5, name: 'VolatilityShieldV1', network: NETWORK });
  assert.equal(result.versionId, 99);
  assert.equal(result.status, 'already_registered');
  assert.equal(created, 0);
});
