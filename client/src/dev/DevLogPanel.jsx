/**
 * DevLogPanel.jsx
 *
 * Drawer flotante que muestra los logs de desarrollo (warnings + errores)
 * tanto del server como del cliente, en tiempo real. Solo se monta cuando
 * `import.meta.env.DEV` es true (Vite remueve el componente en build de
 * producción).
 *
 * - FAB en la esquina inferior derecha con un badge del conteo de errores
 *   no leídos. Click → abre/cierra el drawer.
 * - Header con filtros (level + source), búsqueda y acciones (limpiar,
 *   pausar, cerrar).
 * - Lista virtualizada-light: ordenada por timestamp ascendente, con
 *   auto-scroll cuando el usuario está al fondo. Cada entry es expandible.
 * - Persistencia de filtros y "open state" en localStorage.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import styles from './DevLogPanel.module.css';
import { useDevLogStream } from './useDevLogStream';

const STORAGE_KEY = 'devLogPanel.v1';

function loadPersisted() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function persist(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* noop */ }
}

const ALL_LEVELS = ['error', 'warn'];
const KNOWN_SOURCES = [
  { id: 'server', label: 'Server' },
  { id: 'client_window', label: 'window.error' },
  { id: 'client_promise', label: 'Promise' },
  { id: 'client_console', label: 'console.error' },
  { id: 'client_http', label: 'HTTP 4xx/5xx' },
  { id: 'client_error_boundary', label: 'React boundary' },
];

function shortTs(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return ts;
  }
}

function formatStatus(entry) {
  if (entry.status) return `HTTP ${entry.status}`;
  if (entry.code) return entry.code;
  return null;
}

function entryAsJson(entry) {
  return JSON.stringify(entry, null, 2);
}

export default function DevLogPanel() {
  const persisted = useMemo(loadPersisted, []);
  const [open, setOpen] = useState(persisted.open === true);
  const [paused, setPausedState] = useState(false);
  const [search, setSearch] = useState('');
  const [activeLevels, setActiveLevels] = useState(persisted.levels || ALL_LEVELS);
  const [activeSources, setActiveSources] = useState(persisted.sources || KNOWN_SOURCES.map((s) => s.id));
  const [unreadErrors, setUnreadErrors] = useState(0);
  const [unreadWarns, setUnreadWarns] = useState(0);
  const [expanded, setExpanded] = useState({});

  const stream = useDevLogStream({ enabled: true });
  const lastSeenIdRef = useRef(0);
  const listRef = useRef(null);
  const stickyBottomRef = useRef(true);

  // Reset unread counts cuando se abre el drawer.
  useEffect(() => {
    if (open) {
      setUnreadErrors(0);
      setUnreadWarns(0);
      lastSeenIdRef.current = stream.entries[stream.entries.length - 1]?.id || 0;
    }
  }, [open, stream.entries]);

  // Tracking de unread cuando llegan entries nuevos y el panel está cerrado.
  useEffect(() => {
    if (open) return;
    let newErrors = 0;
    let newWarns = 0;
    for (const entry of stream.entries) {
      if (!entry?.id || entry.id <= lastSeenIdRef.current) continue;
      if (entry.level === 'error') newErrors += 1;
      else if (entry.level === 'warn') newWarns += 1;
    }
    if (newErrors > 0 || newWarns > 0) {
      setUnreadErrors(newErrors);
      setUnreadWarns(newWarns);
    }
  }, [stream.entries, open]);

  // Sincronizar pausa con el hook.
  useEffect(() => {
    stream.setPaused(paused);
  }, [paused, stream]);

  // Persistir estado.
  useEffect(() => {
    persist({ open, levels: activeLevels, sources: activeSources });
  }, [open, activeLevels, activeSources]);

  // Auto-scroll al final cuando llega una nueva entry y estamos pegados.
  useEffect(() => {
    if (!open) return;
    if (!stickyBottomRef.current) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [stream.entries, open]);

  const toggleLevel = useCallback((level) => {
    setActiveLevels((prev) => prev.includes(level)
      ? prev.filter((l) => l !== level)
      : [...prev, level]);
  }, []);

  const toggleSource = useCallback((source) => {
    setActiveSources((prev) => prev.includes(source)
      ? prev.filter((s) => s !== source)
      : [...prev, source]);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stream.entries.filter((entry) => {
      if (!activeLevels.includes(entry.level)) return false;
      const sourceKey = entry.source || 'server';
      // Si el source viene del server pero no está en la lista conocida,
      // lo agrupamos bajo 'server' para que el toggle lo controle.
      const matchesSource = activeSources.includes(sourceKey)
        || (!KNOWN_SOURCES.some((s) => s.id === sourceKey) && activeSources.includes('server'));
      if (!matchesSource) return false;
      if (!q) return true;
      const haystack = `${entry.message || ''} ${entry.requestId || ''} ${entry.code || ''} ${entry.path || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [stream.entries, activeLevels, activeSources, search]);

  const handleScroll = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickyBottomRef.current = distanceFromBottom < 30;
  }, []);

  const toggleExpanded = useCallback((id) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const copyEntry = useCallback((entry) => {
    try {
      navigator.clipboard.writeText(entryAsJson(entry));
    } catch { /* noop */ }
  }, []);

  const totalUnread = unreadErrors + unreadWarns;

  if (!open) {
    return (
      <button
        type="button"
        className={styles.fab}
        onClick={() => setOpen(true)}
        title="Abrir DevLogPanel"
      >
        <span className={stream.isConnected ? styles.fabConnected : styles.fabDisconnected} />
        Logs
        {unreadErrors > 0 && <span className={styles.fabBadge}>{unreadErrors}</span>}
        {unreadErrors === 0 && unreadWarns > 0 && (
          <span className={`${styles.fabBadge} ${styles.fabBadgeWarn}`}>{unreadWarns}</span>
        )}
        {totalUnread === 0 && stream.entries.length > 0 && (
          <span style={{ color: '#6e7d8e', fontSize: '0.72rem' }}>{stream.entries.length}</span>
        )}
      </button>
    );
  }

  return (
    <>
      <div className={styles.overlay} onClick={() => setOpen(false)} />
      <aside className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerTop}>
            <div>
              <h3 className={styles.headerTitle}>
                <span className={stream.isConnected ? styles.fabConnected : styles.fabDisconnected} />
                {' '}DevLogPanel · {stream.entries.length} / {filtered.length}
              </h3>
              <div className={styles.headerSubtitle}>
                Errores y warnings del server + cliente en tiempo real
              </div>
            </div>
            <button type="button" className={styles.closeBtn} onClick={() => setOpen(false)}>✕</button>
          </div>

          <div className={styles.toolbar}>
            <input
              className={styles.search}
              placeholder="Buscar (mensaje, requestId, code…)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className={`${styles.toolBtn} ${paused ? styles.toolBtnActive : ''}`}
              onClick={() => setPausedState((p) => !p)}
              title="Pausa el agregado de nuevos eventos al panel (no afecta el server)"
            >
              {paused ? '▶ Reanudar' : '⏸ Pausar'}
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => stream.clear()}
              title="Limpia el ring buffer del server y el panel local"
            >
              🗑 Limpiar
            </button>
          </div>

          <div className={styles.filterChips}>
            <button
              type="button"
              className={`${styles.chip} ${activeLevels.includes('error') ? styles.chipError : ''}`}
              onClick={() => toggleLevel('error')}
            >
              error
            </button>
            <button
              type="button"
              className={`${styles.chip} ${activeLevels.includes('warn') ? styles.chipWarn : ''}`}
              onClick={() => toggleLevel('warn')}
            >
              warn
            </button>
            <span style={{ width: '8px' }} />
            {KNOWN_SOURCES.map((src) => (
              <button
                key={src.id}
                type="button"
                className={`${styles.chip} ${activeSources.includes(src.id) ? styles.chipActive : ''}`}
                onClick={() => toggleSource(src.id)}
              >
                {src.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.list} ref={listRef} onScroll={handleScroll}>
          {filtered.length === 0 && (
            <div className={styles.empty}>
              {stream.entries.length === 0
                ? 'Sin logs todavía. Las warnings y errors aparecerán acá automáticamente.'
                : 'Ninguna entry coincide con los filtros activos.'}
            </div>
          )}
          {filtered.map((entry) => {
            const id = entry.id ?? `${entry.ts}-${entry.message?.slice(0, 16)}`;
            const isExpanded = !!expanded[id];
            const status = formatStatus(entry);
            const klass = entry.level === 'error' ? styles.entryError
              : entry.level === 'warn' ? styles.entryWarn
              : styles.entryInfo;
            return (
              <div
                key={id}
                className={`${styles.entry} ${klass}`}
                onClick={() => toggleExpanded(id)}
              >
                <span className={styles.entryTs}>{shortTs(entry.ts)}</span>
                <div className={styles.entryBody}>
                  <div className={styles.entryHeader}>
                    <span className={styles.entrySource}>{entry.source || 'server'}</span>
                    {status && <span className={styles.entryStatus}>{status}</span>}
                    {entry.requestId && (
                      <span className={styles.entryRequestId}>req:{String(entry.requestId).slice(0, 8)}</span>
                    )}
                  </div>
                  <div className={styles.entryMessage}>{entry.message}</div>
                  {isExpanded && (
                    <>
                      <pre className={styles.entryDetails}>{entryAsJson(entry)}</pre>
                      <button
                        type="button"
                        className={styles.copyBtn}
                        onClick={(e) => { e.stopPropagation(); copyEntry(entry); }}
                      >
                        📋 Copiar JSON
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
