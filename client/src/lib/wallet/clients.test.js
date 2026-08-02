import { describe, it, expect } from 'vitest';
import { SUPPORTED_CHAINS, getChainById, buildRpcUrls, RPC_HOSTS_BLOQUEADOS } from './clients';

// El servidor decide en que redes se puede operar (uniswap/networks.js), pero
// la wallet solo puede firmar en las cadenas declaradas aca. Cuando las dos
// listas se desincronizan, la wallet rechaza la tx con un mensaje generico
// ("Missing or invalid parameters") que no dice nada del origen real — que es
// exactamente lo que paso al agregar Base Sepolia solo del lado servidor.
const CHAIN_IDS_OPERABLES = {
  arbitrum: 42161,
  'base-sepolia': 84532,
};

describe('SUPPORTED_CHAINS', () => {
  it('cubre toda red en la que el orquestador permite operar', () => {
    for (const [nombre, chainId] of Object.entries(CHAIN_IDS_OPERABLES)) {
      expect(
        SUPPORTED_CHAINS.some((c) => Number(c.id) === chainId),
        `falta la cadena de ${nombre} (${chainId}) en SUPPORTED_CHAINS`
      ).toBe(true);
    }
  });

  it('resuelve cada cadena por id', () => {
    for (const chainId of Object.values(CHAIN_IDS_OPERABLES)) {
      expect(getChainById(chainId)?.id).toBe(chainId);
    }
  });

  it('devuelve null para una cadena no soportada', () => {
    expect(getChainById(999999)).toBeNull();
  });
});

// Ankr paso a exigir API key y sus endpoints keyless devuelven -32000. viem
// mapea cualquier -32000 a InvalidInputRpcError, cuyo mensaje fijo es
// "Missing or invalid parameters. Double check you have provided the correct
// parameters." — sin mencionar autenticacion. Como `fallback` rota entre las
// urls, fallaba de a ratos y en cualquier flujo, y el mensaje apuntaba a la
// transaccion en vez de al RPC. Costo horas de diagnostico.
describe('RPC por defecto', () => {
  it('no incluye hosts que exigen API key', () => {
    for (const chain of SUPPORTED_CHAINS) {
      for (const url of buildRpcUrls(Number(chain.id))) {
        for (const bloqueado of RPC_HOSTS_BLOQUEADOS) {
          expect(url, `${chain.name} usa un RPC bloqueado: ${url}`).not.toContain(bloqueado);
        }
      }
    }
  });

  it('toda cadena soportada tiene al menos un RPC', () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(buildRpcUrls(Number(chain.id)).length, `${chain.name} sin RPC`).toBeGreaterThan(0);
    }
  });
});
