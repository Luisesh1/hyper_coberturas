import { useEffect, useState } from 'react';
import { smartContractRegistryApi } from '../../services/api';
import styles from './SmartContractsPage.module.css';

function statusLabel(status) {
  return status === 'verified' ? 'Verificado' : 'En verificación';
}

async function sourceHash(sourceCode) {
  const payload = new TextEncoder().encode(sourceCode);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', payload);
    return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  // El servidor vuelve a contrastar el bytecode antes de verificar. Este
  // fallback solo conserva una huella de trazabilidad en navegadores antiguos.
  return `source-${sourceCode.length}`;
}

export default function SmartContractsPage() {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ name: '', version: '1.0.0', sourceCode: '', description: '', compilerVersion: '' });
  const [deploymentDraft, setDeploymentDraft] = useState({ versionId: '', network: 'base-sepolia', address: '', txHash: '', artifactBytecodeHash: '' });

  const load = async () => {
    const data = await smartContractRegistryApi.list();
    setVersions(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    let active = true;
    load()
      .then(() => { if (!active) return; })
      .catch((err) => { if (active) setError(err.message || 'No se pudo cargar el registro.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []); // La carga inicial se mantiene aislada para no repetir llamadas al editar el borrador.

  const updateDraft = (field) => (event) => {
    setDraft((current) => ({ ...current, [field]: event.target.value }));
  };

  const registerVersion = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const contract = await smartContractRegistryApi.createContract({
        name: draft.name.trim(),
        contractType: 'uniswap_v4_dynamic_fee_hook',
        description: draft.description.trim() || undefined,
      });
      await smartContractRegistryApi.createVersion(contract.id, {
        version: draft.version.trim(),
        sourceCode: draft.sourceCode,
        sourceHash: await sourceHash(draft.sourceCode),
        compilerVersion: draft.compilerVersion.trim() || undefined,
      });
      setDraft({ name: '', version: '1.0.0', sourceCode: '', description: '', compilerVersion: '' });
      setNotice('Versión registrada en verificación.');
      await load();
    } catch (err) {
      setError(err.message || 'No se pudo registrar la versión.');
    } finally {
      setSaving(false);
    }
  };

  const updateDeployment = (field) => (event) => {
    setDeploymentDraft((current) => ({ ...current, [field]: event.target.value }));
  };

  const registerDeployment = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await smartContractRegistryApi.recordDeployment(Number(deploymentDraft.versionId), {
        network: deploymentDraft.network.trim(),
        address: deploymentDraft.address.trim(),
        txHash: deploymentDraft.txHash.trim(),
        artifactBytecodeHash: deploymentDraft.artifactBytecodeHash.trim() || undefined,
      });
      setNotice('Despliegue registrado. Ya puedes contrastar el bytecode en cadena.');
      setDeploymentDraft((current) => ({ ...current, address: '', txHash: '', artifactBytecodeHash: '' }));
      await load();
    } catch (err) {
      setError(err.message || 'No se pudo registrar el despliegue.');
    } finally {
      setSaving(false);
    }
  };

  const verifyVersion = async (version) => {
    if (saving || !version?.deployment?.network) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await smartContractRegistryApi.verifyVersion(version.id, version.deployment.network);
      setNotice('Bytecode y permisos verificados. El hook ya puede aparecer en el wizard de esa red.');
      await load();
    } catch (err) {
      setError(err.message || 'No se pudo verificar el contrato en cadena.');
    } finally {
      setSaving(false);
    }
  };

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

      <section className={styles.register} aria-labelledby="register-title">
        <div>
          <span className={styles.eyebrow}>Nueva versión</span>
          <h2 id="register-title">Registrar código para verificación</h2>
          <p>El registro conserva el código y la versión. Aún no habilita el hook ni envía una transacción.</p>
        </div>
        <form onSubmit={registerVersion} className={styles.form}>
          <label>Nombre del contrato<input required value={draft.name} onChange={updateDraft('name')} /></label>
          <label>Versión<input required value={draft.version} onChange={updateDraft('version')} /></label>
          <label className={styles.wide}>Descripción<input value={draft.description} onChange={updateDraft('description')} /></label>
          <label>Compilador<input placeholder="solc 0.8.26" value={draft.compilerVersion} onChange={updateDraft('compilerVersion')} /></label>
          <label className={styles.wide}>Código fuente<textarea required rows="7" value={draft.sourceCode} onChange={updateDraft('sourceCode')} /></label>
          <div className={styles.formFooter}>
            <small>Después se registra el despliegue firmado y se contrasta su bytecode on-chain.</small>
            <button type="submit" disabled={saving}>{saving ? 'Registrando…' : 'Registrar versión'}</button>
          </div>
        </form>
      </section>

      {versions.some((version) => version.status === 'verification' && !version.deployment) && (
        <section className={styles.register} aria-labelledby="deployment-title">
          <div>
            <span className={styles.eyebrow}>Despliegue firmado</span>
            <h2 id="deployment-title">Registrar evidencia de despliegue</h2>
            <p>La firma ocurre desde la wallet. Registra después la dirección y el hash de la transacción para iniciar la verificación.</p>
          </div>
          <form onSubmit={registerDeployment} className={styles.form}>
            <label>Versión a desplegar<select required value={deploymentDraft.versionId} onChange={updateDeployment('versionId')}>
              <option value="">Selecciona una versión</option>
              {versions.filter((version) => version.status === 'verification' && !version.deployment).map((version) => (
                <option key={version.id} value={version.id}>{version.name} · {version.version}</option>
              ))}
            </select></label>
            <label>Red de despliegue<input required value={deploymentDraft.network} onChange={updateDeployment('network')} /></label>
            <label className={styles.wide}>Dirección desplegada<input required value={deploymentDraft.address} placeholder="0x…" onChange={updateDeployment('address')} /></label>
            <label>Hash de transacción<input required value={deploymentDraft.txHash} placeholder="0x…" onChange={updateDeployment('txHash')} /></label>
            <label>Hash de bytecode runtime<input required value={deploymentDraft.artifactBytecodeHash} placeholder="0x…" onChange={updateDeployment('artifactBytecodeHash')} /></label>
            <div className={styles.formFooter}>
              <small>La verificación vuelve a leer el bytecode desde el RPC; el navegador no puede aprobarlo por sí mismo.</small>
              <button type="submit" disabled={saving || !deploymentDraft.versionId}>{saving ? 'Registrando…' : 'Registrar despliegue firmado'}</button>
            </div>
          </form>
        </section>
      )}

      {loading && <p className={styles.state}>Cargando versiones registradas…</p>}
      {error && <p className={styles.error}>{error}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}
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
            {version.status === 'verification' && version.deployment && (
              <button className={styles.verifyButton} type="button" disabled={saving} onClick={() => verifyVersion(version)}>
                Verificar bytecode on-chain
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
