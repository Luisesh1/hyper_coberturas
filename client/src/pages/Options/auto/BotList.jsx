import { useEffect, useRef, useState } from 'react';
import { formatUsdt } from '../strategies/common/format';
import { CloseIcon, PencilIcon } from '../strategies/common/icons';
import { Pnl } from '../strategies/StrategyList';
import DirectionChip from './DirectionChip';
import { BOT_MODE_LABEL, STRUCTURE_INFO, botDirections, budgetSummary, cardPnl, formatCountdown } from './botView';
import Sparkline from './visual/Sparkline';
import { useNow } from './visual/useNow';
import { relativeTime } from './visual/visualModel';
import styles from './AutoTradingTab.module.css';
import v from './visual/visual.module.css';

const underlyingsText = (b) => (b.underlyings?.length ? b.underlyings : [b.underlying]).join(' · ');

// «Presupuesto 1.000 USDT · Entrada 250 USDT»: con qué trabaja el bot.
function BudgetLine({ bot }) {
  const { budget, perEntry } = budgetSummary(bot);
  return (
    <span className={styles.cardBudget}>
      <span>Presupuesto <b>{budget}</b></span>
      <span>Entrada <b>{perEntry}</b></span>
    </span>
  );
}

// Chip de la esquina: lo más urgente del bot (entrada en curso, bloqueo,
// error, posición) o, si no hay nada, su modo.
function StatusChip({ bot, now }) {
  if (bot.pendingEntry) {
    return <span className={`${v.pill} ${v.pill_wait}`}>Entrada {formatCountdown(Math.max(0, bot.pendingEntry.deadlineAt - now))}</span>;
  }
  if (bot.pendingEntryUnknown) return <span className={`${v.pill} ${v.pill_wait}`} title="Estado de la entrada desconocido">Entrada ?</span>;
  if (bot.blocked) return <span className={`${v.pill} ${v.pill_down}`}>Bloqueado</span>;
  if (bot.status === 'error') return <span className={`${v.pill} ${v.pill_down}`}>Con error</span>;
  if (bot.status === 'in_position') return <span className={`${v.pill} ${v.pill_mute}`}>En posición</span>;
  return <span className={`${v.pill} ${v[`pill_${bot.mode}`]}`}>{BOT_MODE_LABEL[bot.mode] || bot.mode}</span>;
}

const CheckIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

// Editor del nombre en la propia tarjeta: Enter o ✓ guarda, Esc o ✕ cancela.
function RenameForm({ bot, onRename, onDone }) {
  const [name, setName] = useState(bot.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);
  useEffect(() => { input.current?.select(); }, []);
  const trimmed = name.trim();
  const submit = async (e) => {
    e.preventDefault();
    if (!trimmed || saving) return;
    if (trimmed === bot.name) { onDone(); return; }
    setSaving(true);
    setError(null);
    try {
      await onRename(bot.id, trimmed);
      onDone();
    } catch (err) {
      setError(err?.message || 'No se pudo renombrar');
      setSaving(false);
    }
  };
  return (
    <form className={styles.renameForm} onSubmit={submit}>
      <span className={styles.renameRow}>
        <input
          ref={input}
          className={styles.renameInput}
          aria-label="Nombre del bot"
          value={name}
          maxLength={120}
          disabled={saving}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }}
        />
        <button type="submit" className={styles.renameBtn} aria-label="Guardar nombre" title="Guardar" disabled={!trimmed || saving}>
          <CheckIcon size={18} />
        </button>
        <button type="button" className={styles.renameBtn} aria-label="Cancelar" title="Cancelar" onClick={onDone} disabled={saving}>
          <CloseIcon size={18} />
        </button>
      </span>
      {error && <span className={styles.renameError} role="alert">{error}</span>}
    </form>
  );
}

// Fila superior: punto + nombre (botón que abre el bot y cubre toda la
// tarjeta) + lápiz para renombrar + chip. Sin `onRename` no hay lápiz.
function CardTop({ bot: b, now, selected, onSelect, onRename }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <RenameForm bot={b} onRename={onRename} onDone={() => setEditing(false)} />;
  return (
    <span className={styles.cardTop}>
      <span className={styles.cardTopMain}>
        <span className={`${v.dot} ${v[`dot_${b.mode}`]}`} title={BOT_MODE_LABEL[b.mode]} />
        <button
          type="button"
          className={`${styles.cardName} ${styles.cardHit}`}
          aria-current={selected ? 'true' : undefined}
          onClick={() => onSelect(b.id)}
        >
          {b.name}
        </button>
        {onRename && (
          <button type="button" className={styles.renameBtn} aria-label="Editar nombre" title="Editar nombre" onClick={() => setEditing(true)}>
            <PencilIcon size={15} />
          </button>
        )}
      </span>
      <StatusChip bot={b} now={now} />
    </span>
  );
}

function DesktopCard({ bot: b, selected, onSelect, onRename, now }) {
  const dirs = botDirections(b.alerts);
  const info = STRUCTURE_INFO[b.structure];
  const lastAt = b.lastSignal?.at ?? null;
  return (
    <div className={`${styles.card} ${selected ? styles.cardSelected : ''}`}>
      <CardTop bot={b} now={now} selected={selected} onSelect={onSelect} onRename={onRename} />
      <span className={styles.cardRow}>
        <span className={styles.cardMeta}>
          {underlyingsText(b)}{info ? ` · ${info.shorter}` : ''} · {lastAt !== null ? relativeTime(lastAt, now) : 'sin señales'}
        </span>
        <Sparkline values={b.pnlSeries} />
      </span>
      <BudgetLine bot={b} />
      <span className={styles.cardRow}>
        <span className={styles.chips}>
          {dirs.length
            ? dirs.map((d) => <DirectionChip key={d} direction={d} />)
            : <span className={styles.cardMeta}>Sin alertas vinculadas</span>}
        </span>
        <Pnl value={cardPnl(b)} />
      </span>
    </div>
  );
}

// Tarjeta del teléfono: punto + nombre + chip de lo más urgente; meta y
// sparkline; comisiones del libro activo y P&L.
function MobileCard({ bot: b, onSelect, onRename, now }) {
  const info = STRUCTURE_INFO[b.structure];
  const lastAt = b.lastSignal?.at ?? null;
  return (
    <div className={`${styles.card} ${styles.cardMobile}`}>
      <CardTop bot={b} now={now} onSelect={onSelect} onRename={onRename} />
      <span className={styles.cardRow}>
        <span className={styles.cardMeta}>
          {underlyingsText(b)}{info ? ` · ${info.shorter}` : ''} · {lastAt !== null ? relativeTime(lastAt, now) : 'sin señales'}
        </span>
        <Sparkline values={b.pnlSeries} width={70} height={22} />
      </span>
      <BudgetLine bot={b} />
      <span className={styles.cardRow}>
        <span className={styles.cardMeta}>Comisiones {b.feesUsdt !== null ? formatUsdt(b.feesUsdt) : '—'}</span>
        <Pnl value={cardPnl(b)} className={styles.cardPnlBig} />
      </span>
    </div>
  );
}

// Tarjetas de bots: punto de estado (Real late), chip de lo más urgente con
// la cuenta atrás de la entrada, sparkline de 30 días y P&L. El reloj de 1 s
// solo corre mientras algún bot tiene una entrada pendiente.
export default function BotList({ bots, selectedId, onSelect, onRename, mobile = false }) {
  const now = useNow(bots.some((b) => b.pendingEntry));
  return (
    <ul className={styles.cardList} aria-label="Bots">
      {bots.map((b) => (
        <li key={b.id}>
          {mobile
            ? <MobileCard bot={b} onSelect={onSelect} onRename={onRename} now={now} />
            : <DesktopCard bot={b} selected={b.id === selectedId} onSelect={onSelect} onRename={onRename} now={now} />}
        </li>
      ))}
    </ul>
  );
}
