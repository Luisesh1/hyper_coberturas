import { useEffect, useState } from 'react';
import { smartContractRegistryApi } from '../../services/api';
import styles from './SmartContractsPage.module.css';

function statusLabel(status) {
  return status === 'verified' ? 'Verificado' : 'En verificación';
}

export default function SmartContractsPage() {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    smartContractRegistryApi.list()
      .then((data) => { if (active) setVersions(Array.isArray(data) ? data : []); })
      .catch((err) => { if (active) setError(err.message || 'No se pudo cargar el registro.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Control de contratos</span>
          <h1>Hooks y versiones</h1>
          <p>Un hook no llega al orquestador hasta que su bytecode desplegado quede verificado.</p>
        </div>
        <div className={styles.guardrail}>Solo versiones verificadas aparecen al crear un LP V4.</div>
      </header>

      <section className={styles.flow} aria-label="Flujo de seguridad">
        <span>Código</span><b>→</b><span>Firma y despliegue</span><b>→</b><span>Verificación on-chain</span><b>→</b><span>Uso en orquestador</span>
      </section>

      {loading && <p className={styles.state}>Cargando versiones registradas…</p>}
      {error && <p className={styles.error}>{error}</p>}
      {!loading && !error && versions.length === 0 && (
        <div className={styles.empty}>
          <strong>Aún no hay contratos registrados.</strong>
          <p>Registra una versión de hook, despliega desde tu wallet y verifica el bytecode antes de habilitarla.</p>
        </div>
      )}
      <div className={styles.grid}>
        {versions.map((version) => (
          <article key={version.id} className={styles.card}>
            <div className={styles.cardTop}>
              <div><h2>{version.name}</h2><span>Versión {version.version}</span></div>
              <span className={version.status === 'verified' ? styles.verified : styles.verification}>{statusLabel(version.status)}</span>
            </div>
            <dl>
              <div><dt>Tipo</dt><dd>Hook V4 de tarifa dinámica</dd></div>
              <div><dt>Red</dt><dd>{version.deployment?.network || 'Sin despliegue confirmado'}</dd></div>
              <div><dt>Dirección</dt><dd>{version.deployment?.address || 'Pendiente'}</dd></div>
            </dl>
            <p className={styles.cardNote}>
              {version.status === 'verified'
                ? 'Apto para ser elegido al crear una pool V4 nueva en esta red.'
                : 'No se puede seleccionar ni operar hasta comprobar bytecode y permisos del hook.'}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
