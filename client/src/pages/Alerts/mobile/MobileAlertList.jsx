import { useMemo, useState } from 'react';
import BottomSheet from '../../TradingView/components/BottomSheet';
import { DirectionChip, DirectionIcon } from '../components/Direction';
import TestResultView from '../components/TestResultView';
import { baseTimeframe, lastTriggeredLabel } from '../lib/alertView';
import { DIRECTION_FILTERS, matchesDirectionFilter } from '../lib/direction';
import styles from './MobileAlertList.module.css';

const NO_BOTS = [];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function AlertCard({ alert, bots, showBots, onOpen, onToggleActive, onTest }) {
  // Valor optimista del interruptor mientras la promesa está pendiente.
  const [override, setOverride] = useState(null);
  const [testing, setTesting] = useState(false);
  const isActive = override ?? alert.isActive;
  const shown = { ...alert, isActive };
  const tf = baseTimeframe(alert.rules);

  const toggle = async () => {
    if (override !== null) return;
    setOverride(!alert.isActive);
    try {
      await onToggleActive(alert);
    } catch {
      // La página avisa del error; aquí solo se revierte el interruptor.
    } finally {
      setOverride(null);
    }
  };

  const test = async () => {
    if (testing) return;
    setTesting(true);
    try {
      await onTest(alert);
    } finally {
      setTesting(false);
    }
  };

  return (
    <article className={`${styles.card} ${isActive ? '' : styles.cardPaused}`}>
      <button type="button" className={styles.open} onClick={() => onOpen(alert)}>
        <span className={styles.name}>{alert.name}</span>
        <span className={styles.meta}>
          {plural(alert.assetList?.length || 0, 'activo', 'activos')} · {plural(alert.rules?.length || 0, 'regla', 'reglas')} · umbral {alert.thresholdPercent} %
        </span>
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={isActive}
        aria-label={`${isActive ? 'Pausar' : 'Activar'} ${alert.name}`}
        className={`${styles.switchBtn} ${isActive ? styles.switchOn : ''}`}
        onClick={toggle}
      >
        <span className={styles.switchTrack}><span className={styles.switchThumb} /></span>
        <span className={styles.switchText}>{isActive ? 'Activa' : 'Pausada'}</span>
      </button>
      <div className={styles.chips}>
        <DirectionChip direction={alert.direction} />
        {tf && <span className={styles.chip}>{tf}</span>}
        {showBots && (
          <span className={styles.chip}>
            {bots.length > 0 ? `Usada por ${bots.length} bot${bots.length === 1 ? '' : 's'}` : 'Sin bots'}
          </span>
        )}
      </div>
      <button type="button" className={styles.testBtn} onClick={test} disabled={testing}>
        {testing ? 'Probando…' : 'Probar'}
      </button>
      <div className={styles.last}>Último disparo: {lastTriggeredLabel(shown)}</div>
    </article>
  );
}

export default function MobileAlertList({
  alerts,
  botUsage,
  directionFilter,
  onDirectionFilter,
  onOpen,
  onNew,
  onToggleActive,
  onTest,
  isLoading = false,
}) {
  const [sheet, setSheet] = useState(null); // { name, data }

  const counts = useMemo(() => {
    const out = {};
    for (const f of DIRECTION_FILTERS) out[f.key] = alerts.filter((a) => matchesDirectionFilter(a, f.key)).length;
    return out;
  }, [alerts]);
  const visible = useMemo(
    () => alerts.filter((a) => matchesDirectionFilter(a, directionFilter)),
    [alerts, directionFilter],
  );
  const active = alerts.filter((a) => a.isActive).length;

  const runTest = async (alert) => {
    try {
      const data = await onTest(alert);
      if (data?.results) setSheet({ name: alert.name, data });
    } catch {
      // La página ya avisó del error.
    }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Alertas</h1>
        <p className={styles.subtitle}>{alerts.length} en total · {active} activas</p>
      </header>

      <div role="group" aria-label="Filtrar por dirección" className={styles.filters}>
        {DIRECTION_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={directionFilter === f.key}
            className={`${styles.filter} ${directionFilter === f.key ? styles.filterActive : ''}`}
            onClick={() => onDirectionFilter(f.key)}
          >
            {f.key !== 'all' && <DirectionIcon direction={f.key} size={10} />}
            {f.label}
            <span className={styles.count}>{counts[f.key]}</span>
          </button>
        ))}
      </div>

      <div className={styles.list}>
        {isLoading && <div className={styles.empty}>Cargando…</div>}
        {!isLoading && alerts.length === 0 && (
          <div className={styles.empty}>Aún no tienes alertas. Crea la primera.</div>
        )}
        {!isLoading && alerts.length > 0 && visible.length === 0 && (
          <div className={styles.empty}>No hay alertas con esta dirección.</div>
        )}
        {visible.map((a) => (
          <AlertCard
            key={a.id}
            alert={a}
            bots={botUsage?.get(Number(a.id)) || NO_BOTS}
            showBots={!!botUsage}
            onOpen={onOpen}
            onToggleActive={onToggleActive}
            onTest={runTest}
          />
        ))}
      </div>

      <button type="button" className={styles.fab} onClick={onNew}>+ Nueva alerta</button>

      <BottomSheet open={!!sheet} title={sheet ? `Prueba · ${sheet.name}` : ''} onClose={() => setSheet(null)}>
        {sheet && (
          <>
            <p className={styles.sheetNote}>Prueba sin enviar a Telegram.</p>
            <TestResultView result={sheet.data} />
          </>
        )}
      </BottomSheet>
    </div>
  );
}
