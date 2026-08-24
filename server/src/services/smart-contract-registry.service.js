/**
 * Reglas puras del registro de contratos desplegables.
 *
 * El registro no sustituye una auditoría: sólo ofrece una transición
 * verificable entre "en verificación" y "verificado". Las versiones son
 * inmutables; todo cambio de código o parámetros debe crear otra versión.
 */
const CONTRACT_STATUS = Object.freeze({
  VERIFICATION: 'verification',
  VERIFIED: 'verified',
});

const DYNAMIC_FEE_HOOK = 'uniswap_v4_dynamic_fee_hook';

function canVerifyContractVersion(version = {}) {
  if (version.status !== CONTRACT_STATUS.VERIFICATION) {
    return { ok: false, reason: 'invalid_status_transition' };
  }
  const deployment = version.deployment || {};
  if (!deployment.network || !deployment.address || !deployment.txHash) {
    return { ok: false, reason: 'deployment_incomplete' };
  }
  if (!deployment.artifactBytecodeHash || !deployment.onchainBytecodeHash) {
    return { ok: false, reason: 'bytecode_unverified' };
  }
  if (deployment.artifactBytecodeHash !== deployment.onchainBytecodeHash) {
    return { ok: false, reason: 'bytecode_mismatch' };
  }
  if (version.contractType === DYNAMIC_FEE_HOOK) {
    if (deployment.hookSafety?.safe !== true) return { ok: false, reason: 'unsafe_hook' };
    if (deployment.hookSafety?.dynamicFee !== true) return { ok: false, reason: 'not_dynamic_fee_hook' };
  }
  return { ok: true };
}

function selectVerifiedHookVersions(versions = [], { network } = {}) {
  return versions.filter((version) => (
    version?.status === CONTRACT_STATUS.VERIFIED
    && version.contractType === DYNAMIC_FEE_HOOK
    && version.deployment?.network === network
    && version.deployment?.hookSafety?.safe === true
    && version.deployment?.hookSafety?.dynamicFee === true
  ));
}

module.exports = {
  CONTRACT_STATUS,
  DYNAMIC_FEE_HOOK,
  canVerifyContractVersion,
  selectVerifiedHookVersions,
};
