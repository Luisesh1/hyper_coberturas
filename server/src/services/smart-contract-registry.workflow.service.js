const { ethers } = require('ethers');
const { ValidationError, NotFoundError } = require('../errors/app-error');
const { getNetworkConfig } = require('./uniswap/networks');
const onChainManager = require('./onchain-manager.service');
const repositoryDefault = require('../repositories/smart-contract-registry.repository');
const { DYNAMIC_FEE_HOOK, canVerifyContractVersion } = require('./smart-contract-registry.service');
const { classifyHook, HOOK_FLAGS } = require('./uniswap/v4-hook-safety');

function defaultProviderForNetwork(network) {
  return onChainManager.getProvider(getNetworkConfig(network), { scope: 'smart-contract-registry' });
}

function hookSafetyFor(address) {
  const classification = classifyHook(address);
  return {
    safe: classification.safe,
    dynamicFee: classification.safe && classification.flags?.BEFORE_SWAP === true,
    flags: classification.flags,
    reason: classification.reason,
  };
}

class SmartContractRegistryService {
  constructor({ repository = repositoryDefault, providerForNetwork = defaultProviderForNetwork } = {}) {
    this.repository = repository;
    this.providerForNetwork = providerForNetwork;
  }

  async verifyVersion({ userId, versionId, network }) {
    const version = await this.repository.getVersionForVerification(userId, versionId, network);
    if (!version) throw new NotFoundError('Versión de contrato no encontrada');
    if (!version.deployment) throw new ValidationError('No existe un despliegue confirmado en esta red');

    const provider = await this.providerForNetwork(network);
    const runtimeBytecode = await provider.getCode(version.deployment.address);
    if (!runtimeBytecode || runtimeBytecode === '0x') {
      throw new ValidationError('La dirección no contiene bytecode desplegado');
    }
    const onchainBytecodeHash = ethers.keccak256(runtimeBytecode);
    const hookSafety = hookSafetyFor(version.deployment.address);
    if (version.contractType === DYNAMIC_FEE_HOOK && !hookSafety.dynamicFee) {
      throw new ValidationError('El hook de tarifa dinámica debe declarar el permiso beforeSwap');
    }

    const deployment = {
      ...version.deployment,
      onchainBytecodeHash,
      hookSafety,
    };
    const check = canVerifyContractVersion({ ...version, deployment });
    if (!check.ok) throw new ValidationError(`No se puede verificar la versión: ${check.reason}`);

    await this.repository.recordDeployment({
      userId,
      contractVersionId: version.id,
      network,
      address: deployment.address,
      txHash: deployment.txHash,
      artifactBytecodeHash: deployment.artifactBytecodeHash || version.artifactBytecodeHash,
      onchainBytecodeHash,
      hookSafety,
    });
    const verifiedId = await this.repository.markVerified(userId, version.id);
    if (!verifiedId) throw new ValidationError('La versión ya no está disponible para verificación');
    return { id: Number(verifiedId), status: 'verified', network, address: deployment.address };
  }
}

module.exports = {
  HOOK_FLAGS,
  SmartContractRegistryService,
  hookSafetyFor,
};
