import { describe, it, expect } from 'vitest';
import { SUPPORTED_CHAINS, getChainById } from './clients';

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
