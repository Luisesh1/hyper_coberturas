/**
 * Despliegue y adopcion de los hooks del catalogo del proyecto.
 *
 * Dos caminos, y el barato es el habitual:
 *
 *  - ADOPTAR (sin gas): un hook V4 no tiene dueno y su estado va por `poolId`,
 *    asi que un unico despliegue por red sirve para todos los usuarios y todos
 *    los LPs. Si en la direccion predicha ya esta el bytecode esperado, basta
 *    con registrarlo y verificarlo.
 *  - DESPLEGAR (con gas): solo la primera vez en cada red. El servidor arma la
 *    calldata del proxy CREATE2 y la wallet del usuario firma.
 *
 * No hay conciliacion en segundo plano a proposito: la direccion es
 * determinista y la cadena es la fuente de verdad, asi que si el usuario cierra
 * el navegador a mitad de camino solo tiene que volver y pulsar «adoptar».
 */
const { ethers } = require('ethers');
const { ValidationError, NotFoundError } = require('../errors/app-error');
const { getNetworkConfig } = require('./uniswap/networks');
const onChainManager = require('./onchain-manager.service');
const repositoryDefault = require('../repositories/smart-contract-registry.repository');
const {
  SmartContractRegistryService, hookSafetyFor,
} = require('./smart-contract-registry.workflow.service');
const { DYNAMIC_FEE_HOOK } = require('./smart-contract-registry.service');
const {
  CREATE2_PROXY, listCatalog, getCatalogEntry, networkEntry,
  expectedRuntimeHash, buildDeploymentCalldata, classifyOnchainCode,
} = require('./hook-catalog.service');

const TESTNETS = new Set(['base-sepolia']);

function defaultProviderForNetwork(network) {
  return onChainManager.getProvider(getNetworkConfig(network), { scope: 'hook-deployment' });
}

class HookDeploymentService {
  constructor({
    repository = repositoryDefault,
    providerForNetwork = defaultProviderForNetwork,
    registryService = null,
  } = {}) {
    this.repository = repository;
    this.providerForNetwork = providerForNetwork;
    this.registryService = registryService || new SmartContractRegistryService();
  }

  async _statusOf(entry, network) {
    const provider = await this.providerForNetwork(network);
    const { predictedAddress } = networkEntry(entry, network);
    const code = await provider.getCode(predictedAddress);
    return { status: classifyOnchainCode(entry, network, code), code, predictedAddress };
  }

  async describeCatalog({ network }) {
    const isMainnet = !TESTNETS.has(network);
    const entries = listCatalog().filter((entry) => Boolean(entry.networks?.[network]));
    return Promise.all(entries.map(async (entry) => {
      const base = {
        contractName: entry.contractName,
        version: entry.version,
        permissions: entry.permissions,
        network,
        isMainnet,
        predictedAddress: entry.networks[network].predictedAddress,
      };
      try {
        const { status } = await this._statusOf(entry, network);
        return { ...base, status };
      } catch (error) {
        return { ...base, status: 'unknown', reason: error.message };
      }
    }));
  }

  _entryOrThrow(name, network) {
    const entry = getCatalogEntry(name);
    if (!entry) throw new NotFoundError(`El contrato ${name} no esta en el catalogo del proyecto`);
    if (!entry.networks?.[network]) throw new ValidationError(`El catalogo no cubre la red ${network}`);
    return entry;
  }

  async buildDeploymentPlan({ name, network }) {
    const entry = this._entryOrThrow(name, network);
    const config = getNetworkConfig(network);
    if (!config?.deployments?.v4) throw new ValidationError(`La red ${network} no tiene PoolManager de Uniswap v4`);

    const provider = await this.providerForNetwork(network);
    const proxyCode = await provider.getCode(CREATE2_PROXY);
    if (!proxyCode || proxyCode === '0x') {
      throw new ValidationError(`La red ${network} no tiene el proxy CREATE2 determinista, asi que no se puede fijar la direccion del hook`);
    }

    const { status, predictedAddress } = await this._statusOf(entry, network);
    if (status === 'deployed') {
      throw new ValidationError(`${name} ya esta desplegado en ${network} (${predictedAddress}): registralo sin gas en lugar de desplegarlo`);
    }
    if (status === 'address_taken') {
      throw new ValidationError(`La direccion ${predictedAddress} esta ocupada por otro codigo en ${network}. No se sobrescribe nada`);
    }

    return {
      contractName: entry.contractName,
      version: entry.version,
      network,
      chainId: config.chainId,
      isMainnet: !TESTNETS.has(network),
      predictedAddress,
      tx: {
        to: CREATE2_PROXY,
        data: buildDeploymentCalldata(entry, network),
        value: '0x0',
        chainId: config.chainId,
        kind: 'hook_deployment',
        label: `Desplegar ${entry.contractName} ${entry.version}`,
      },
    };
  }

  async _findRegistered({ userId, entry, network }) {
    const contracts = await this.repository.listContracts(userId);
    const expected = String(entry.networks[network].predictedAddress).toLowerCase();
    return (contracts || []).find((item) => (
      item.name === entry.contractName
      && item.version === entry.version
      && item.deployment?.network === network
      && String(item.deployment?.address || '').toLowerCase() === expected
    )) || null;
  }

  async adopt({ userId, name, network, txHash = null }) {
    const entry = this._entryOrThrow(name, network);
    const { status, code, predictedAddress } = await this._statusOf(entry, network);

    if (status === 'deployable') {
      throw new ValidationError(`En ${predictedAddress} no hay ningun contrato desplegado todavia`);
    }
    if (status === 'address_taken') {
      throw new ValidationError(`El codigo en ${predictedAddress} no es el de ${name}: no se registra`);
    }

    const existing = await this._findRegistered({ userId, entry, network });
    if (existing) {
      return { versionId: existing.id, address: predictedAddress, status: 'already_registered' };
    }

    const artifactBytecodeHash = expectedRuntimeHash(entry, network);
    const contractId = await this.repository.createContract({
      userId,
      name: entry.contractName,
      contractType: DYNAMIC_FEE_HOOK,
      description: `Hook V4 de tarifa dinamica del proyecto, compilado con ${entry.compiler}`,
    });
    const versionId = await this.repository.createVersion({
      userId,
      contractId,
      version: entry.version,
      sourceCode: entry.sourceCode,
      sourceHash: entry.sourceHash,
      compilerVersion: entry.compiler,
      abiJson: entry.abi,
      artifactBytecodeHash,
    });
    await this.repository.recordDeployment({
      userId,
      contractVersionId: versionId,
      network,
      address: predictedAddress,
      txHash: txHash || null,
      artifactBytecodeHash,
      onchainBytecodeHash: ethers.keccak256(code),
      hookSafety: hookSafetyFor(predictedAddress),
    });
    await this.registryService.verifyVersion({ userId, versionId, network });

    return { versionId, address: predictedAddress, status: 'registered' };
  }
}

module.exports = { HookDeploymentService, TESTNETS };
