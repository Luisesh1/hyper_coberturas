/**
 * HidenActionsPage.jsx
 *
 * Ruta oculta `/hidenActions` (no aparece en el navbar). Aloja acciones de
 * recuperación / mantenimiento manual que el usuario administrador puede
 * disparar a mano cuando algo se rompe en el flujo automatizado del bot.
 *
 * Acciones actualmente expuestas:
 *   1. "Recuperar fondos atascados de posición V3"
 *      Para posiciones donde el bot firmó decreaseLiquidity pero el
 *      collect() nunca llegó a ejecutarse → tokens quedan en `tokensOwed`
 *      del PositionManager y la UI nueva de Uniswap los oculta.
 */

import { useState, useCallback } from 'react';
import { devApi } from '../../services/api';
import { useWalletConnection } from '../../hooks/useWalletConnection';
import styles from './HidenActionsPage.module.css';

const DEFAULT_NETWORK = 'arbitrum';

// Pre-poblamos con la posición que sabemos que tiene fondos atascados
// (orquestador 11 / NFT 5412248). El usuario puede cambiarlos a mano si
// necesita recuperar fondos de otra posición.
const DEFAULT_TOKEN_ID = '5412248';

export default function HidenActionsPage() {
  const wallet = useWalletConnection();
  const [network, setNetwork] = useState(DEFAULT_NETWORK);
  const [tokenId, setTokenId] = useState(DEFAULT_TOKEN_ID);
  const [walletInput, setWalletInput] = useState('');
  const [recipientInput, setRecipientInput] = useState('');
  const [step, setStep] = useState('idle'); // idle | simulating | ready | signing | confirming | done | error
  const [simulation, setSimulation] = useState(null);
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState('');
  const [receipt, setReceipt] = useState(null);

  const effectiveWallet = (walletInput || wallet?.address || '').trim();
  const effectiveRecipient = (recipientInput || effectiveWallet || '').trim();

  const handleSimulate = useCallback(async () => {
    setError('');
    setSimulation(null);
    setStep('simulating');
    try {
      if (!tokenId) throw new Error('tokenId requerido');
      if (!effectiveWallet) throw new Error('wallet requerida (conectá la wallet o tipeá la address)');
      const data = await devApi.recoverPositionFees({
        network,
        tokenId: tokenId.trim(),
        walletAddress: effectiveWallet,
        recipient: effectiveRecipient || effectiveWallet,
      });
      setSimulation(data);
      setStep('ready');
    } catch (err) {
      setError(err?.message || 'Error simulando collect()');
      setStep('error');
    }
  }, [network, tokenId, effectiveWallet, effectiveRecipient]);

  const handleSign = useCallback(async () => {
    if (!simulation?.tx) {
      setError('No hay tx preparada. Simulá primero.');
      return;
    }
    if (!wallet?.isConnected) {
      setError('Conectá la wallet antes de firmar.');
      return;
    }
    if (wallet.address?.toLowerCase() !== simulation.walletAddress.toLowerCase()) {
      setError(
        `La wallet conectada (${wallet.address?.slice(0, 10)}…) no coincide con la owner del NFT `
        + `(${simulation.walletAddress.slice(0, 10)}…). Cambiá a la cuenta correcta.`
      );
      return;
    }
    setError('');
    setStep('signing');
    try {
      const hash = await wallet.sendTransaction(simulation.tx);
      if (!hash) throw new Error('La wallet no devolvió hash de transacción.');
      setTxHash(hash);
      setStep('confirming');
      const rec = await wallet.waitForTransactionReceipt(hash, { chainId: simulation.chainId });
      setReceipt(rec);
      setStep('done');
    } catch (err) {
      setError(err?.normalizedError?.message || err?.message || 'Error firmando o confirmando la tx.');
      setStep('error');
    }
  }, [simulation, wallet]);

  const handleReset = useCallback(() => {
    setStep('idle');
    setSimulation(null);
    setError('');
    setTxHash('');
    setReceipt(null);
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.eyebrow}>HIDDEN · ADMIN ONLY</span>
        <h1>Acciones ocultas</h1>
        <p className={styles.lead}>
          Operaciones de recuperación / mantenimiento manual que no aparecen en el menú principal.
          Usalas solo cuando sepas exactamente qué estás haciendo — son irreversibles.
        </p>
      </header>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>1. Recuperar fondos atascados de posición V3</h2>
          <span className={styles.tag}>collect()</span>
        </div>
        <p className={styles.cardDesc}>
          Si el orquestador firmó <code>decreaseLiquidity</code> pero el <code>collect()</code> posterior no se
          ejecutó, los tokens quedan dentro del pool Uniswap V3 con <code>tokensOwed &gt; 0</code> y la UI nueva los
          oculta porque interpreta la posición como "cerrada". Este botón simula el <code>collect()</code> con
          un <code>eth_call</code> (sin firmar) para mostrarte exactamente cuántos tokens se pueden recuperar y
          después arma una tx lista para que vos firmes con tu wallet.
        </p>

        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span>Red</span>
            <select value={network} onChange={(e) => setNetwork(e.target.value)} disabled={step === 'simulating' || step === 'signing' || step === 'confirming'}>
              <option value="arbitrum">arbitrum</option>
              <option value="ethereum">ethereum</option>
              <option value="optimism">optimism</option>
              <option value="base">base</option>
              <option value="polygon">polygon</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Token ID (NFT del LP)</span>
            <input
              type="text"
              value={tokenId}
              onChange={(e) => setTokenId(e.target.value)}
              disabled={step === 'simulating' || step === 'signing' || step === 'confirming'}
              placeholder="ej. 5412248"
            />
          </label>
          <label className={styles.field}>
            <span>Wallet owner del NFT</span>
            <input
              type="text"
              value={walletInput}
              onChange={(e) => setWalletInput(e.target.value)}
              disabled={step === 'simulating' || step === 'signing' || step === 'confirming'}
              placeholder={wallet?.address || '0x...'}
            />
            <small>{wallet?.address ? `Wallet conectada: ${wallet.address}` : 'Conectá la wallet o pegá la address manualmente'}</small>
          </label>
          <label className={styles.field}>
            <span>Recipient (destino de los tokens)</span>
            <input
              type="text"
              value={recipientInput}
              onChange={(e) => setRecipientInput(e.target.value)}
              disabled={step === 'simulating' || step === 'signing' || step === 'confirming'}
              placeholder="Por defecto: la misma wallet owner"
            />
          </label>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleSimulate}
            disabled={step === 'simulating' || step === 'signing' || step === 'confirming'}
          >
            {step === 'simulating' ? 'Simulando…' : '🔍 Simular collect()'}
          </button>
          {(step === 'ready' || step === 'error' || step === 'done') && (
            <button type="button" className={styles.btnGhost} onClick={handleReset}>
              ↻ Resetear
            </button>
          )}
        </div>

        {error && <div className={styles.errorBox}><strong>Error:</strong> {error}</div>}

        {simulation && (
          <div className={styles.simulationBox}>
            <h3>Resultado de la simulación on-chain</h3>
            <div className={styles.kvGrid}>
              <div><span>Owner verificado</span><strong>{simulation.owner}</strong></div>
              <div><span>chainId</span><strong>{simulation.chainId}</strong></div>
              <div><span>Position Manager</span><strong className={styles.mono}>{simulation.positionManager}</strong></div>
              <div><span>Token ID</span><strong>{simulation.tokenId}</strong></div>
              <div><span>token0</span><strong>{simulation.token0.symbol} <span className={styles.mono}>({simulation.token0.address.slice(0, 10)}…)</span></strong></div>
              <div><span>token1</span><strong>{simulation.token1.symbol} <span className={styles.mono}>({simulation.token1.address.slice(0, 10)}…)</span></strong></div>
              <div><span>liquidity actual</span><strong>{simulation.liquidity}</strong></div>
              <div><span>tokensOwed0</span><strong>{simulation.tokensOwed0Formatted} {simulation.token0.symbol}</strong></div>
              <div><span>tokensOwed1</span><strong>{simulation.tokensOwed1Formatted} {simulation.token1.symbol}</strong></div>
            </div>
            <div className={styles.recoverable}>
              <strong>Recuperable confirmado:</strong>{' '}
              {simulation.simulated.amount0} {simulation.token0.symbol} +{' '}
              {simulation.simulated.amount1} {simulation.token1.symbol}
            </div>

            {step === 'ready' && (
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.btnDanger}
                  onClick={handleSign}
                  disabled={!wallet?.isConnected}
                >
                  ✍ Firmar y enviar collect()
                </button>
                {!wallet?.isConnected && <span className={styles.warn}>Conectá la wallet primero</span>}
              </div>
            )}
          </div>
        )}

        {step === 'signing' && (
          <div className={styles.statusBox}>
            <span className={styles.spinner} />
            Firmá la transacción en tu wallet…
          </div>
        )}
        {step === 'confirming' && (
          <div className={styles.statusBox}>
            <span className={styles.spinner} />
            Esperando confirmación on-chain…
            {txHash && <div className={styles.mono}>tx: {txHash}</div>}
          </div>
        )}
        {step === 'done' && receipt && (
          <div className={styles.successBox}>
            <h3>✓ Recuperación exitosa</h3>
            <div className={styles.kvGrid}>
              <div><span>tx hash</span><strong className={styles.mono}>{txHash}</strong></div>
              <div><span>block</span><strong>{Number(receipt.blockNumber)}</strong></div>
              <div><span>gas usado</span><strong>{receipt.gasUsed?.toString?.() || '?'}</strong></div>
              <div><span>status</span><strong>{receipt.status}</strong></div>
            </div>
            <p>
              Los tokens ya fueron transferidos a <code>{simulation.recipient}</code>. Verifícalos en tu wallet
              o en el explorador. Podés correr "Simular collect()" otra vez sobre el mismo tokenId para
              confirmar que <code>tokensOwed0/1</code> ahora están en cero.
            </p>
          </div>
        )}
      </section>

      <footer className={styles.footer}>
        Esta página es <code>/hidenActions</code> y no aparece en el navbar. La acción de recovery solo se monta
        cuando el server corre con <code>NODE_ENV=development</code> (el endpoint <code>/api/dev/recover-position-fees</code>
        no existe en producción).
      </footer>
    </div>
  );
}
