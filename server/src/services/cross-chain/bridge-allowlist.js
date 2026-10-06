/**
 * Contratos a los que el plan cross-chain puede mandar fondos o aprobar.
 *
 * Una tx de bridge la arma un tercero (Li.Fi / Across); el servidor solo la
 * devuelve para firmar si su `to` (y el `spender` de su approve) está aquí.
 * Direcciones leídas de cotizaciones reales el 2026-10-05. Si un proveedor
 * empieza a usar otro contrato, la cotización se rechaza con
 * BRIDGE_TARGET_NOT_ALLOWED y se registra para añadirlo tras revisarlo.
 */

const { AppError } = require('../../errors/app-error');
const logger = require('../logger.service');

const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
// Across usa este contrato para los envíos de ETH nativo en todas las redes.
const ACROSS_NATIVE_HANDLER = '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4';

const ALLOWLIST = {
  lifi: {
    ethereum: [LIFI_DIAMOND],
    arbitrum: [LIFI_DIAMOND],
    base: [LIFI_DIAMOND],
    optimism: [LIFI_DIAMOND],
    polygon: [LIFI_DIAMOND],
    robinhood: ['0xB477751B76CF82d00a686A1232f5fCD772414Af3'],
  },
  across: {
    ethereum: ['0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', ACROSS_NATIVE_HANDLER],
    arbitrum: ['0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A', ACROSS_NATIVE_HANDLER],
    base: ['0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64', ACROSS_NATIVE_HANDLER],
    optimism: ['0x6f26Bf09B1C792e3228e5467807a900A503c0281', ACROSS_NATIVE_HANDLER],
    polygon: ['0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096'],
    robinhood: ['0xD29C85F15DF544bA632C9E25829fd29d767d7978', ACROSS_NATIVE_HANDLER],
  },
};

function isAllowedTarget({ provider, network, to }) {
  const list = ALLOWLIST[provider]?.[network] || [];
  const target = String(to || '').toLowerCase();
  return list.some((address) => address.toLowerCase() === target);
}

function assertAllowedTarget({ provider, network, to, role = 'destino' }) {
  if (isAllowedTarget({ provider, network, to })) return;
  logger.warn('cross_chain_bridge_target_not_allowed', { provider, network, to, role });
  throw new AppError(
    `La ruta de ${provider} en ${network} usa un contrato no revisado (${to}). No se firma.`,
    { status: 502, code: 'BRIDGE_TARGET_NOT_ALLOWED', details: { provider, network, to, role } }
  );
}

module.exports = { ALLOWLIST, isAllowedTarget, assertAllowedTarget };
