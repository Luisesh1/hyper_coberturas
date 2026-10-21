import { useEffect, useMemo, useRef, useState } from 'react';
import { marketApi } from '../../../services/api';
import { overlayId } from './overlayModel';
import { formatOverlayPct } from './overlayFormat';
import styles from './OverlayPicker.module.css';

// Navegador de opciones de Deribit: subyacente → vencimiento → strike.
// Escritorio: tres zonas a la vez. Móvil: tres pasos en la misma hoja.

export const DERIBIT_UNDERLYINGS = ['BTC', 'ETH', 'SOL', 'XRP', 'AVAX', 'TRX', 'HYPE'];
const NOT_ON_DERIBIT = new Set(['BNB', 'DOGE']);
const DAY_MS = 86_400_000;
const POLL_MS = 800;
const FULL_TITLE = 'Máximo 6 superposiciones';
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const STEPS = ['Subyacente', 'Vencimiento', 'Strike'];

export function initialUnderlying(base) {
  const b = String(base || '').toUpperCase();
  if (NOT_ON_DERIBIT.has(b)) return { underlying: null, unsupported: true };
  return { underlying: DERIBIT_UNDERLYINGS.includes(b) ? b : 'ETH', unsupported: false };
}

// El vencimiento es a las 08:00 UTC: la fecha que importa es la UTC.
export function expiryLabel(ms, { weekday = true } = {}) {
  const d = new Date(ms);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return weekday ? `${DAYS[d.getUTCDay()]} ${date}` : date;
}

export function relativeDays(ms, now = Date.now()) {
  const days = Math.floor(ms / DAY_MS) - Math.floor(now / DAY_MS);
  if (days === 0) return 'hoy';
  return days > 0 ? `en ${days} d` : `hace ${-days} d`;
}

const formatStrike = (s) => s.toLocaleString('en-US', { maximumFractionDigits: 6 });
const formatSpot = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : v >= 1 ? 2 : 4 });

// Sondea el trabajo de strikes del servidor cada 800 ms mientras corre. Se
// detiene al desmontar o al cambiar de subyacente/vencimiento.
function useStrikesJob(underlying, code) {
  const [job, setJob] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // "Reintentar" relanza un trabajo con error: sólo la primera llamada lleva retry.
  const retryRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // Un reintento conserva la tabla parcial; cambiar de vencimiento la vacía.
    const retry = retryRef.current;
    retryRef.current = false;
    if (!retry) setJob(null);
    setLoadError(null);
    setRetrying(retry);
    if (!underlying || !code) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async (retry) => {
      try {
        const res = await marketApi.getOptionStrikes(underlying, code, { retry });
        if (cancelled) return;
        setJob(res);
        setLoadError(null);
        setRetrying(false);
        if (res?.status === 'running') timer = setTimeout(() => poll(false), POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err?.message || 'No se pudieron cargar los strikes');
        setRetrying(false);
      }
    };
    poll(retry);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [underlying, code, attempt]);

  const retry = () => { retryRef.current = true; setAttempt((n) => n + 1); };
  return { job, loadError, retrying, retry };
}

function useExpiries(underlying) {
  const [state, setState] = useState({ list: [], loading: false, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!underlying) { setState({ list: [], loading: false, error: null }); return undefined; }
    let cancelled = false;
    setState({ list: [], loading: true, error: null });
    marketApi.getOptionExpiries(underlying)
      .then((list) => { if (!cancelled) setState({ list: Array.isArray(list) ? list : [], loading: false, error: null }); })
      .catch((err) => { if (!cancelled) setState({ list: [], loading: false, error: err?.message || 'Error cargando vencimientos' }); });
    return () => { cancelled = true; };
  }, [underlying, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

function UnderlyingPills({ value, unsupported, onSelect, mobile }) {
  return (
    <div className={mobile ? styles.pillsMobile : styles.pills}>
      {!mobile && <span className={styles.pillsLabel}>Subyacente</span>}
      {DERIBIT_UNDERLYINGS.map((u) => (
        <button
          key={u}
          type="button"
          aria-pressed={value === u}
          className={`${styles.pill} ${value === u ? styles.pillActive : ''}`}
          onClick={() => onSelect(u)}
        >
          {u}
        </button>
      ))}
      {unsupported && <span className={styles.note}>BNB y DOGE no cotizan en Deribit</span>}
    </div>
  );
}

function ExpiryList({ expiries, selected, onSelect, mobile }) {
  const [query, setQuery] = useState('');
  const now = Date.now();
  const q = query.trim().toLowerCase();
  const rows = expiries.list
    .map((e) => ({ ...e, label: expiryLabel(e.expiryMs), rel: relativeDays(e.expiryMs, now) }))
    .filter((e) => !q || e.label.includes(q) || e.code.toLowerCase().includes(q));
  const live = rows.filter((e) => e.live);
  const dead = rows.filter((e) => !e.live);

  const renderRow = (e) => (
    <button
      key={e.code}
      type="button"
      aria-pressed={selected === e.code}
      className={`${styles.expiry} ${selected === e.code ? styles.expiryActive : ''}`}
      onClick={() => onSelect(e)}
    >
      <span>{e.label}</span>
      <span className={styles.expiryRel}>{e.rel}</span>
    </button>
  );

  return (
    <div className={mobile ? styles.expiriesMobile : styles.expiries}>
      <label className={styles.searchBox}>
        <SearchIcon />
        <input
          type="search"
          placeholder="Fecha de vencimiento"
          aria-label="Buscar vencimiento"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
        />
      </label>
      <div className={styles.expiryScroll}>
        {expiries.loading && <div className={styles.empty}>Cargando vencimientos…</div>}
        {expiries.error && (
          <div className={styles.empty}>
            {expiries.error}{' '}
            <button type="button" className={styles.linkBtn} onClick={expiries.reload}>Reintentar</button>
          </div>
        )}
        {!expiries.loading && !expiries.error && rows.length === 0 && (
          <div className={styles.empty}>{q ? 'Sin vencimientos para esa fecha' : 'Sin vencimientos'}</div>
        )}
        {live.length > 0 && <div className={styles.groupLabel}>Vigentes</div>}
        {live.map(renderRow)}
        {dead.length > 0 && <div className={styles.groupLabel}>Vencidos · último año</div>}
        {dead.map(renderRow)}
      </div>
    </div>
  );
}

function SideCell({ instrument, type, strike, expiry, underlying, addedIds, full, onAdd, mobile }) {
  const side = type === 'C' ? 'CALL' : 'PUT';
  if (!instrument) {
    return <span className={styles.noTrades}>{mobile ? `${side} · No listada` : 'No listada'}</span>;
  }
  const spec = { kind: 'option', option: { instrument, underlying, expiryMs: expiry.expiryMs, strike, type } };
  if (addedIds?.has(overlayId(spec))) {
    return (
      <span className={styles.addedBadge} aria-label={`${side} ${formatStrike(strike)} añadida`}>
        <CheckIcon />Añadida
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.addBtn}
      aria-label={`Añadir ${side} ${strike}`}
      disabled={full}
      title={full ? FULL_TITLE : undefined}
      onClick={() => onAdd(spec)}
    >
      {mobile ? `+ ${side}` : '+ Añadir'}
    </button>
  );
}

function StrikePane({ underlying, expiry, addedIds, full, onAdd, mobile }) {
  const { job, loadError, retrying, retry } = useStrikesJob(underlying, expiry?.code);
  const strikes = useMemo(
    () => [...(job?.strikes || [])].sort((a, b) => a.strike - b.strike),
    [job],
  );
  const atm = useMemo(() => {
    let best = null;
    for (const s of strikes) {
      if (s.distancePct == null) continue;
      if (!best || Math.abs(s.distancePct) < Math.abs(best.distancePct)) best = s;
    }
    return best?.strike ?? null;
  }, [strikes]);

  if (!expiry) {
    return <div className={styles.strikePane}><div className={styles.empty}>Elige un vencimiento</div></div>;
  }

  // Si un sondeo falla, el sondeo se detiene: no se deja el progreso congelado.
  const running = job?.status === 'running' && !loadError;
  const pct = running && job.total ? Math.round((job.probed / job.total) * 100) : 0;

  return (
    <div className={styles.strikePane}>
      <div className={styles.strikeHead}>
        {!mobile && <span className={styles.strikeDate}>{expiryLabel(expiry.expiryMs, { weekday: false })}</span>}
        {job?.spotRef != null && (
          <span className={styles.spotRef}>
            <span>{expiry.live ? `${underlying} ahora:` : `${underlying} a 7 días del vencimiento:`}</span>{' '}
            <strong>{formatSpot(job.spotRef)}</strong>
          </span>
        )}
        <span className={styles.grow} />
        {retrying && <span className={styles.progress} role="status">Reintentando…</span>}
        {running && (
          <span className={styles.progress} role="status">
            <span className={styles.progressTrack}><span className={styles.progressFill} style={{ width: `${pct}%` }} /></span>
            <span>{`Buscando strikes · ${job.probed} de ${job.total}`}</span>
          </span>
        )}
      </div>

      {job?.status === 'error' && !retrying && (
        <div className={styles.warn} role="alert">
          <span>No se pudieron revisar todos los strikes</span>
          <span aria-hidden="true"> · </span>
          <button type="button" className={styles.linkBtn} onClick={retry}>Reintentar</button>
        </div>
      )}
      {loadError && (
        <div className={styles.warn} role="alert">
          <span>{loadError}</span>
          <span aria-hidden="true"> · </span>
          <button type="button" className={styles.linkBtn} onClick={retry}>Reintentar</button>
        </div>
      )}
      {!job && !loadError && <div className={styles.empty}>Cargando strikes…</div>}
      {job?.status === 'done' && strikes.length === 0 && (
        <div className={styles.empty}>No hay strikes para este vencimiento</div>
      )}

      {strikes.length > 0 && (
        <div className={mobile ? styles.strikeTableMobile : styles.strikeTable} role="table" aria-label="Strikes">
          <div className={styles.strikeRowHead} role="row">
            <span role="columnheader">Strike</span>
            <span role="columnheader">Distancia</span>
            <span role="columnheader">CALL</span>
            <span role="columnheader">PUT</span>
          </div>
          {strikes.map((s) => {
            const isAtm = s.strike === atm;
            const dim = !s.call && !s.put;
            const cell = { strike: s.strike, expiry, underlying, addedIds, full, onAdd, mobile };
            return (
              <div
                key={s.strike}
                role="row"
                data-strike={s.strike}
                className={`${styles.strikeRow} ${isAtm ? styles.strikeRowAtm : ''} ${dim ? styles.strikeRowDim : ''}`}
              >
                <span role="cell" className={styles.strikeNum}>
                  {formatStrike(s.strike)}
                  {isAtm && <span className={styles.atm}> ATM</span>}
                </span>
                <span role="cell" className={styles.distance}>{s.distancePct == null ? '—' : formatOverlayPct(s.distancePct)}</span>
                <span role="cell" className={styles.sideCell}><SideCell {...cell} instrument={s.call} type="C" /></span>
                <span role="cell" className={styles.sideCell}><SideCell {...cell} instrument={s.put} type="P" /></span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function OptionBrowser({ mobile = false, mainUnderlying, addedIds, full = false, onAdd }) {
  const initial = useMemo(() => initialUnderlying(mainUnderlying), [mainUnderlying]);
  const [underlying, setUnderlying] = useState(initial.underlying);
  const [expiry, setExpiry] = useState(null);
  const [step, setStep] = useState(0);
  const expiries = useExpiries(underlying);

  const selectUnderlying = (u) => {
    if (u !== underlying) setExpiry(null);
    setUnderlying(u);
    if (mobile) setStep(1);
  };
  const selectExpiry = (e) => {
    setExpiry(e);
    if (mobile) setStep(2);
  };

  if (mobile) {
    const crumb = [step >= 1 && underlying, step >= 2 && expiry && expiryLabel(expiry.expiryMs, { weekday: false })]
      .filter(Boolean).join(' · ');
    return (
      <div className={styles.optionMobile}>
        <div className={styles.stepBar}>
          {step > 0 && (
            <button type="button" className={styles.backBtn} aria-label="Atrás" onClick={() => setStep(step - 1)}>
              <BackIcon />
            </button>
          )}
          <span className={styles.stepText}>
            <span className={styles.stepTitle}>{`Paso ${step + 1} de 3 · ${STEPS[step]}`}</span>
            {crumb && <span className={styles.stepCrumb}>{crumb}</span>}
          </span>
        </div>
        {step === 0 && (
          <UnderlyingPills value={underlying} unsupported={initial.unsupported} onSelect={selectUnderlying} mobile />
        )}
        {step === 1 && <ExpiryList expiries={expiries} selected={expiry?.code} onSelect={selectExpiry} mobile />}
        {step === 2 && (
          <StrikePane underlying={underlying} expiry={expiry} addedIds={addedIds} full={full} onAdd={onAdd} mobile />
        )}
      </div>
    );
  }

  return (
    <div className={styles.optionDesktop}>
      <UnderlyingPills value={underlying} unsupported={initial.unsupported} onSelect={selectUnderlying} />
      <div className={styles.optionBody}>
        {underlying ? (
          <>
            <ExpiryList key={underlying} expiries={expiries} selected={expiry?.code} onSelect={selectExpiry} />
            <StrikePane underlying={underlying} expiry={expiry} addedIds={addedIds} full={full} onAdd={onAdd} />
          </>
        ) : (
          <div className={styles.empty}>Elige un subyacente</div>
        )}
      </div>
    </div>
  );
}

export function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
