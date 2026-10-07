/**
 * Mensaje de error apto para el navegador. Los errores de ethers incluyen la
 * URL del RPC, que puede llevar la API key del proveedor (Alchemy).
 */
function safeErrorMessage(err) {
  const raw = err?.shortMessage || err?.message || String(err);
  return raw.split(' (')[0].replace(/https?:\/\/\S+/g, '[rpc]').slice(0, 160);
}

module.exports = { safeErrorMessage };
