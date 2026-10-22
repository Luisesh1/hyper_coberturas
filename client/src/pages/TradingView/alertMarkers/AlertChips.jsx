import { useState } from 'react';
import { CloseIcon, EyeIcon, EyeOffIcon, PlusIcon } from '../components/icons';
import BottomSheet from '../components/BottomSheet';
import { DirectionIcon } from '../../Alerts/components/Direction';
import { MAX_ALERT_MARKERS } from './markerModel';
import sheetStyles from '../components/MobileChrome.module.css';
import styles from './AlertChips.module.css';

const dateFmt = (ms) =>
  new Date(ms).toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: 'numeric' });

// Líneas de aviso de un chip según su estado.
function notes(st, chartDatasource) {
  const out = [];
  if (!st) return out;
  if (st.state === 'deleted') out.push('alerta eliminada');
  if (st.partialFromMs != null) out.push(`desde ${dateFmt(st.partialFromMs)}`);
  if (st.sourceMismatch) out.push(`evaluada con ${chartDatasource}; la alerta usa ${st.sourceMismatch}`);
  if (st.insufficient > 0) out.push('sin historia suficiente en parte del rango');
  return out;
}

function Notes({ st, chartDatasource }) {
  const list = notes(st, chartDatasource);
  return (
    <>
      {list.map((t) => <span key={t} className={`${styles.note} ${t === 'alerta eliminada' ? styles.noteBad : ''}`}>{t}</span>)}
      {st?.approx && <span className={styles.approx} title="cooldown aproximado en el borde" aria-label="cooldown aproximado en el borde">≈</span>}
    </>
  );
}

function Spinner() {
  return <span className={styles.spinner} role="status" aria-label="Cargando">↻</span>;
}

function MobileActions({ item, alert, st, chartDatasource, onClose, onToggleHidden, onRemove, onRetry }) {
  const act = (fn) => () => { onClose(); fn?.(item.alertId); };
  return (
    <BottomSheet open title="Acciones" onClose={onClose}>
      <div className={styles.mSheetHead} style={{ '--c': item.color }}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.mSheetName}>{alert?.name ?? 'Alerta'}</span>
        <span className={styles.mSheetSub}><Notes st={st} chartDatasource={chartDatasource} /></span>
      </div>
      <div className={sheetStyles.field}>
        {st?.state === 'error' && (
          <button type="button" className={sheetStyles.rowBtn} onClick={act(onRetry)}>
            <span className={sheetStyles.rowBtnText}>Reintentar</span>
          </button>
        )}
        <button type="button" className={sheetStyles.rowBtn} onClick={act(onToggleHidden)}>
          {item.hidden ? <EyeIcon /> : <EyeOffIcon />}
          <span className={sheetStyles.rowBtnText}>{item.hidden ? 'Mostrar' : 'Ocultar'}</span>
        </button>
        <button type="button" className={`${sheetStyles.rowBtn} ${styles.mDanger}`} onClick={act(onRemove)}>
          <CloseIcon />
          <span className={sheetStyles.rowBtnText}>Quitar alerta</span>
        </button>
      </div>
    </BottomSheet>
  );
}

function MobileChips({ items, alertsById, statusByAlert, countsByAlert, chartDatasource, onToggleHidden, onRemove, onAdd, onRetry }) {
  const [openId, setOpenId] = useState(null);
  const full = items.length >= MAX_ALERT_MARKERS;
  const openItem = openId != null && items.find((i) => i.alertId === openId);
  return (
    <div className={styles.mWrap}>
      <div className={styles.mRow} role="group" aria-label="Alertas en el gráfico">
        {items.map((it) => {
          const a = alertsById?.[it.alertId];
          const st = statusByAlert?.[it.alertId];
          const name = a?.name ?? 'Alerta';
          const flags = [it.hidden ? 'oculta' : '', st?.state === 'error' ? 'error' : '', st?.state === 'deleted' ? 'eliminada' : '']
            .filter(Boolean).map((t) => ` · ${t}`).join('');
          return (
            <button
              key={it.alertId}
              type="button"
              className={`${styles.pill} ${it.hidden ? styles.pillHidden : ''}`}
              style={{ '--c': it.color }}
              aria-label={`${name}${flags}`}
              aria-haspopup="dialog"
              onClick={() => setOpenId(it.alertId)}
            >
              <span className={styles.pillInner}>
                <span className={`${styles.dot} ${it.hidden ? styles.dotHollow : ''}`} aria-hidden="true" />
                {a && <DirectionIcon direction={a.direction} size={10} />}
                <span className={styles.pillName}>{name}</span>
                {st?.state === 'loading'
                  ? <Spinner />
                  : <span className={styles.count}>{countsByAlert?.[it.alertId] ?? 0}</span>}
                {st?.state === 'error' && <span className={styles.errorMark} aria-hidden="true">!</span>}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          className={styles.mAdd}
          onClick={onAdd}
          disabled={full}
          aria-label={full ? `Máximo ${MAX_ALERT_MARKERS} alertas` : 'Añadir alerta'}
        >
          <span className={styles.mAddInner}><PlusIcon size={16} /></span>
        </button>
      </div>
      {openItem && (
        <MobileActions
          item={openItem}
          alert={alertsById?.[openItem.alertId]}
          st={statusByAlert?.[openItem.alertId]}
          chartDatasource={chartDatasource}
          onClose={() => setOpenId(null)}
          onToggleHidden={onToggleHidden}
          onRemove={onRemove}
          onRetry={onRetry}
        />
      )}
    </div>
  );
}

function DesktopChips({ items, alertsById, statusByAlert, countsByAlert, chartDatasource, onToggleHidden, onRemove, onAdd, onRetry }) {
  const full = items.length >= MAX_ALERT_MARKERS;
  return (
    <div className={styles.wrap}>
      <div className={styles.row} role="toolbar" aria-label="Alertas en el gráfico">
        {items.map((it) => {
          const a = alertsById?.[it.alertId];
          const st = statusByAlert?.[it.alertId];
          const name = a?.name ?? 'Alerta';
          return (
            <div key={it.alertId} className={`${styles.chip} ${it.hidden ? styles.chipHidden : ''}`} style={{ '--c': it.color }}>
              <span className={styles.body}>
                <span className={`${styles.dot} ${it.hidden ? styles.dotHollow : ''}`} aria-hidden="true" />
                {a && <DirectionIcon direction={a.direction} size={10} />}
                <span className={styles.name}>{name}</span>
                {st?.state === 'loading'
                  ? <Spinner />
                  : <span className={styles.count} title="Disparos en el rango">{countsByAlert?.[it.alertId] ?? 0}</span>}
                <Notes st={st} chartDatasource={chartDatasource} />
              </span>
              {st?.state === 'error' && (
                <button type="button" className={styles.retry} onClick={() => onRetry?.(it.alertId)}>Reintentar</button>
              )}
              <button
                type="button"
                className={styles.iconBtn}
                aria-label={it.hidden ? `Mostrar ${name}` : `Ocultar ${name}`}
                title={it.hidden ? 'Mostrar' : 'Ocultar'}
                onClick={() => onToggleHidden?.(it.alertId)}
              >
                {it.hidden ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label={`Quitar ${name}`}
                title="Quitar"
                onClick={() => onRemove?.(it.alertId)}
              >
                <CloseIcon size={16} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className={styles.add}
          onClick={onAdd}
          disabled={full}
          title={full ? `Máximo ${MAX_ALERT_MARKERS} alertas` : 'Añadir alerta'}
        >
          <PlusIcon size={14} />Añadir
        </button>
      </div>
    </div>
  );
}

// Fila de chips de alertas marcadas en el gráfico (punto de color, nombre,
// disparos, ojo y ✕). En móvil cada chip es un botón de 44 px que abre una hoja.
export default function AlertChips({ mobile = false, items = [], ...rest }) {
  return mobile ? <MobileChips items={items} {...rest} /> : <DesktopChips items={items} {...rest} />;
}
