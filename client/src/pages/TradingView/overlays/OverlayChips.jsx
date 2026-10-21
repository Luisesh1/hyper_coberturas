import { useEffect, useRef, useState } from 'react';
import {
  AxisLeftIcon, CloseIcon, EyeIcon, EyeOffIcon, MoreIcon, PaletteIcon, PlusIcon, SwapIcon,
} from '../components/icons';
import { MAX_OVERLAYS, OVERLAY_PALETTE, shortLabel } from './overlayModel';
import { formatOverlayPct, formatOverlayValue } from './overlayFormat';
import styles from './OverlayChips.module.css';

const MENU_WIDTH = 268;

function fullName(o) {
  if (o.kind === 'option') return `${o.option.instrument} · Deribit · prima en USD`;
  return `${o.asset.symbol} · ${o.asset.datasource}`;
}

function ChipDetail({ overlay, status, value }) {
  if (status === 'isMain') return <span className={styles.muted}>es el principal</span>;
  if (status === 'hidden' || overlay.hidden) return <span className={styles.muted}>oculto</span>;
  if (status === 'loading') return <span className={styles.spinner} role="status" aria-label="Cargando">↻</span>;
  if (status === 'empty') return <span className={styles.muted}>Sin datos en este rango</span>;
  if (status === 'error') {
    return <span className={styles.error}>Error al cargar ·</span>;
  }
  const pct = formatOverlayPct(value?.changePct);
  return (
    <span className={styles.value}>
      {formatOverlayValue(value?.value, { usd: overlay.kind === 'option' })}
      {pct && <span className={value.changePct >= 0 ? styles.up : styles.down}> {pct}</span>}
    </span>
  );
}

function ChipMenu({ overlay, overlays, status, focused, mainLabel, position, menuRef, onClose, onFocus, onSwap, onColor, onRemove }) {
  const drawable = status !== 'isMain' && status !== 'hidden' && !overlay.hidden;
  const used = new Set(overlays.filter((o) => o.id !== overlay.id).map((o) => o.color));
  const colors = OVERLAY_PALETTE.filter((c) => !used.has(c));
  const act = (fn) => () => { fn(); onClose(); };

  useEffect(() => {
    menuRef.current?.querySelector('button:not(:disabled)')?.focus();
  }, [menuRef]);

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label={`Acciones de ${shortLabel(overlay)}`}
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
    >
      <button type="button" role="menuitem" className={styles.menuItem} disabled={focused || !drawable} onClick={act(() => onFocus(overlay.id))}>
        <AxisLeftIcon size={16} />Usar el eje izquierdo
      </button>
      {overlay.kind === 'asset' && status !== 'isMain' && (
        <button type="button" role="menuitem" className={styles.menuItem} onClick={act(() => onSwap(overlay.id))}>
          <SwapIcon size={16} />Intercambiar con {mainLabel}
        </button>
      )}
      <div className={styles.menuColor}>
        <PaletteIcon size={16} />Color
        <span className={styles.swatches} role="group" aria-label="Color">
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              role="menuitemradio"
              aria-checked={c === overlay.color}
              aria-label={`Color ${c}`}
              className={`${styles.swatch} ${c === overlay.color ? styles.swatchOn : ''}`}
              style={{ background: c }}
              onClick={act(() => { if (c !== overlay.color) onColor(overlay.id, c); })}
            />
          ))}
        </span>
      </div>
      <div className={styles.menuSep} role="separator" />
      <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.menuDanger}`} onClick={act(() => onRemove(overlay.id))}>
        <CloseIcon size={16} />Quitar superposición
      </button>
    </div>
  );
}

// Fila de chips de superposición (escritorio). Un chip por superposición:
// clic en el cuerpo la enfoca (eje izquierdo); ojo para ocultar; "⋯" abre
// el menú. Al final, "Añadir". La fila hace scroll horizontal.
export default function OverlayChips({
  overlays = [], focusedId, status = {}, values = [], mainLabel,
  onFocus, onToggleHidden, onRemove, onSwap, onColor, onAdd, onRetry, max = MAX_OVERLAYS,
}) {
  const [menu, setMenu] = useState(null); // { id, left, top }
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const valueById = new Map(values.map((v) => [v.id, v]));
  const full = overlays.length >= max;

  const closeMenu = () => setMenu(null);

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || e.target.closest?.('[data-chip-more]')) return;
      setMenu(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // El menú vive fuera de la fila (que recorta por el scroll horizontal).
  const toggleMenu = (id, btn) => {
    if (menu?.id === id) { setMenu(null); return; }
    const wrap = wrapRef.current?.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    const maxLeft = Math.max(0, (wrap?.width ?? 0) - MENU_WIDTH);
    const left = Math.min(Math.max(0, r.left - (wrap?.left ?? 0)), maxLeft);
    setMenu({ id, left, top: r.bottom - (wrap?.top ?? 0) + 4 });
  };

  const menuOverlay = menu && overlays.find((o) => o.id === menu.id);

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <div className={styles.row} role="toolbar" aria-label="Superposiciones" onScroll={closeMenu}>
        {overlays.map((o) => {
          const st = status[o.id];
          const focused = o.id === focusedId;
          const hiddenLook = o.hidden || st === 'hidden';
          const drawable = st !== 'isMain' && !hiddenLook;
          const label = shortLabel(o);
          const cls = [
            styles.chip,
            focused && drawable ? styles.chipFocused : '',
            hiddenLook ? styles.chipHidden : '',
            st === 'isMain' ? styles.chipMain : '',
            menu?.id === o.id ? styles.chipMenuOpen : '',
          ].join(' ');
          return (
            <div key={o.id} className={cls} style={{ '--c': o.color }}>
              <button
                type="button"
                className={styles.body}
                aria-label={label}
                aria-pressed={focused && drawable}
                title={fullName(o)}
                onClick={() => { if (!focused && drawable) onFocus?.(o.id); }}
              >
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.name}>{label}</span>
                <ChipDetail overlay={o} status={st} value={valueById.get(o.id)} />
                {focused && drawable && <span className={styles.badge}>eje izq.</span>}
              </button>
              {st === 'error' && (
                <button type="button" className={styles.retry} onClick={() => onRetry?.(o.id)}>Reintentar</button>
              )}
              <button
                type="button"
                className={styles.iconBtn}
                aria-label={o.hidden ? `Mostrar ${label}` : `Ocultar ${label}`}
                title={o.hidden ? 'Mostrar' : 'Ocultar'}
                onClick={() => onToggleHidden?.(o.id)}
              >
                {o.hidden ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
              <button
                type="button"
                data-chip-more=""
                className={`${styles.iconBtn} ${menu?.id === o.id ? styles.iconBtnOn : ''}`}
                aria-label={`Más acciones de ${label}`}
                aria-haspopup="menu"
                aria-expanded={menu?.id === o.id}
                onClick={(e) => toggleMenu(o.id, e.currentTarget)}
              >
                <MoreIcon size={16} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className={styles.add}
          onClick={onAdd}
          disabled={full}
          title={full ? `Máximo ${max} superposiciones` : 'Añadir superposición'}
        >
          <PlusIcon size={14} />Añadir
        </button>
      </div>
      {menuOverlay && (
        <ChipMenu
          overlay={menuOverlay}
          overlays={overlays}
          status={status[menuOverlay.id]}
          focused={menuOverlay.id === focusedId}
          mainLabel={mainLabel}
          position={menu}
          menuRef={menuRef}
          onClose={closeMenu}
          onFocus={(id) => onFocus?.(id)}
          onSwap={(id) => onSwap?.(id)}
          onColor={(id, c) => onColor?.(id, c)}
          onRemove={(id) => onRemove?.(id)}
        />
      )}
    </div>
  );
}
