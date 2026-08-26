import { useCallback, useEffect, useState } from 'react';
import { smartContractRegistryApi } from '../../../services/api';
import { useWalletConnection } from '../../../hooks/useWalletConnection';
import styles from './ProjectContractsPanel.module.css';

const NETWORKS = [
  { value: 'base-sepolia', label: 'Base Sepolia (pruebas, sin dinero real)' },
  { value: 'base', label: 'Base' },
  { value: 'arbitrum', label: 'Arbitrum' },
  { value: 'optimism', label: 'Optimism' },
  { value: 'polygon', label: 'Polygon' },
  { value: 'ethereum', label: 'Ethereum' },
];

// Cada estado se explica solo: qué significa, si cuesta gas y qué se puede
// hacer. El usuario no debería necesitar saber qué es CREATE2 para operar.
const STATES = {
  deployed: {
    title: 'Ya está en esta red',
    body: 'Alguien lo desplegó antes. Registrarlo en tu panel no cuesta gas: solo se lee la cadena y se comprueba que el código sea exactamente el de este repositorio.',
    tone: 'ok',
  },
  deployable: {
    title: 'Aún no está en esta red',
    body: 'Desplegarlo cuesta gas, y solo hace falta hacerlo una vez: a partir de ahí el mismo contrato sirve para todos tus LPs y para cualquier wallet.',
    tone: 'todo',
  },
  address_taken: {
    title: 'Dirección ocupada por otro código',
    body: 'En esa dirección hay un contrato que no es este. No se sobrescribe nada. Si has cambiado el contrato, recompila el catálogo para recalcular su dirección.',
    tone: 'bad',
  },
  unknown: {
    title: 'No se ha podido consultar la cadena',
    body: 'Sin leer la red no se puede saber si el contrato ya está desplegado.',
    tone: 'bad',
  },
};

export default function ProjectContractsPanel({ onAdopted }) {
  const wallet = useWalletConnection();
  const [network, setNetwork] = useState('base-sepolia');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mainnetAcknowledged, setMainnetAcknowledged] = useState(false);

  const load = useCallback(async (target) => {
    setLoading(true);
    setError('');
    try {
      const data = await smartContractRegistryApi.listCatalog(target);
      setEntries(Array.isArray(data) ? data : []);
    } catch (err) {
      setEntries([]);
      setError(err?.message || 'No se pudo leer el catálogo de contratos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(network);
    // Cambiar de red obliga a reconfirmar el aviso de dinero real.
    setMainnetAcknowledged(false);
  }, [load, network]);

  const finish = async (message) => {
    setNotice(message);
    onAdopted?.();
    await load(network);
  };

  const adopt = async (entry, txHash) => {
    await smartContractRegistryApi.adoptDeployment(entry.contractName, entry.network, txHash);
  };

  const handleAdopt = async (entry) => {
    setBusy(entry.contractName);
    setError('');
    setNotice('');
    try {
      await adopt(entry, undefined);
      await finish(`${entry.contractName} registrado y verificado en ${entry.network}. Ya puedes elegirlo al crear una pool V4.`);
    } catch (err) {
      setError(err?.message || 'No se pudo registrar el contrato.');
    } finally {
      setBusy('');
    }
  };

  const handleDeploy = async (entry) => {
    setBusy(entry.contractName);
    setError('');
    setNotice('');
    try {
      const plan = await smartContractRegistryApi.planDeployment(entry.contractName, entry.network);
      if (wallet.chainId !== plan.chainId) await wallet.switchChain(plan.chainId);
      const txHash = await wallet.sendTransaction(plan.tx);
      const receipt = await wallet.waitForTransactionReceipt(txHash, { chainId: plan.chainId });
      if (receipt?.status && receipt.status !== 'success') {
        throw new Error('La red rechazó la transacción de despliegue. No se ha registrado nada.');
      }
      await adopt(entry, txHash);
      await finish(`${entry.contractName} desplegado en ${plan.predictedAddress} y verificado.`);
    } catch (err) {
      setError(err?.message || 'No se pudo desplegar el contrato.');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="catalogo-title">
      <div className={styles.intro}>
        <span className={styles.eyebrow}>Contratos del proyecto</span>
        <h2 id="catalogo-title">Desplegar o registrar un hook</h2>
        <p>
          Un hook es un contrato que la pool de Uniswap v4 consulta en cada swap. Su dirección no se
          elige: va calculada para que codifique los permisos que el contrato declara, así que aquí ya
          sabes cuál será antes de firmar nada.
        </p>
        <p className={styles.hint}>
          El mismo contrato sirve para todos: un hook no tiene dueño y guarda su estado por pool. Por eso
          basta con un despliegue por red, y a partir de ahí solo hay que registrarlo.
        </p>
      </div>

      <label className={styles.networkPicker}>
        Red
        <select value={network} onChange={(event) => setNetwork(event.target.value)}>
          {NETWORKS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>

      {loading && <p className={styles.state}>Consultando la cadena…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}

      <div className={styles.grid}>
        {entries.map((entry) => {
          const meta = STATES[entry.status] || STATES.unknown;
          const working = busy === entry.contractName;
          const needsAck = entry.isMainnet && !mainnetAcknowledged;
          return (
            <article key={entry.contractName} className={styles.card}>
              <header className={styles.cardHead}>
                <div>
                  <h3>{entry.contractName}</h3>
                  <span className={styles.version}>Versión {entry.version}</span>
                </div>
                <span className={styles[meta.tone]}>{meta.title}</span>
              </header>

              <p className={styles.body}>{meta.body}</p>
              {entry.status === 'unknown' && entry.reason && (
                <p className={styles.reason}>Motivo: {entry.reason}</p>
              )}

              <dl className={styles.facts}>
                <div>
                  <dt>Dirección que tendrá</dt>
                  <dd><code>{entry.predictedAddress}</code></dd>
                </div>
                <div>
                  <dt>Permisos que declara</dt>
                  <dd>{(entry.permissions || []).join(', ') || 'ninguno'}</dd>
                </div>
              </dl>

              {entry.status === 'deployed' && (
                <button type="button" disabled={working} onClick={() => handleAdopt(entry)}>
                  {working ? 'Registrando…' : 'Registrarlo sin gastar gas'}
                </button>
              )}

              {entry.status === 'deployable' && (
                <>
                  {entry.isMainnet && (
                    <label className={styles.ack}>
                      <input
                        type="checkbox"
                        checked={mainnetAcknowledged}
                        onChange={(event) => setMainnetAcknowledged(event.target.checked)}
                      />
                      Entiendo que es dinero real y el despliegue es irreversible
                    </label>
                  )}
                  {!wallet.isConnected && (
                    <p className={styles.hint}>Conecta tu wallet para poder firmar el despliegue.</p>
                  )}
                  <button
                    type="button"
                    disabled={working || needsAck || !wallet.isConnected}
                    onClick={() => handleDeploy(entry)}
                  >
                    {working ? 'Desplegando…' : 'Desplegar y firmar'}
                  </button>
                </>
              )}
            </article>
          );
        })}
      </div>

      {!loading && !error && entries.length === 0 && (
        <p className={styles.state}>El catálogo no cubre esta red todavía.</p>
      )}
    </section>
  );
}
