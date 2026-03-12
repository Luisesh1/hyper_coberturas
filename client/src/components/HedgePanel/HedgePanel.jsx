/**
 * HedgePanel.jsx  —  Coberturas Automaticas (2-column layout)
 * Left: form always visible | Right: hedge list always visible
 * Soporta SHORT y LONG con switch de tipo.
 */

import { useState, useEffect, useRef } from 'react';
import { useTradingContext } from '../../context/TradingContext';
import { useAuth } from '../../context/AuthContext';
import styles from './HedgePanel.module.css';

const STATUS_LABEL = {
  entry_pending:   { text: 'Orden GTC activa', color: '#f59e0b' },
  entry_filled_pending_sl: { text: 'Proteccion pendiente', color: '#f97316' },
  open_protected:  { text: 'Posicion protegida', color: '#22c55e' },
  open:            { text: 'Posicion abierta', color: '#22c55e' },
  closing:         { text: 'Cerrando SL...',   color: '#818cf8' },
  cancel_pending:  { text: 'Cancelando...',    color: '#94a3b8' },
  cancelled:       { text: 'Cancelada',        color: '#64748b' },
  error:           { text: 'Error',            color: '#ef4444' },
  // legacy
  waiting:         { text: 'Esperando',        color: '#f59e0b' },
  executing_open:  { text: 'Abriendo...',      color: '#818cf8' },
  executing_close: { text: 'Cerrando...',      color: '#818cf8' },
};

function loadPct(username)  {
  const raw = localStorage.getItem(`hedge_autoexit_pct_${username}`);
  const n   = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0.05;
}

export function HedgePanel({ selectedAsset }) {
  const { prices, hedges, createHedge, cancelHedge, refreshHedges } = useTradingContext();
  const { user } = useAuth();

  const [asset, setAsset]           = useState(selectedAsset || 'BTC');
  const [direction, setDirection]   = useState('short'); // 'short' | 'long'
  const [entryPrice, setEntryPrice] = useState('');
  const [exitPrice, setExitPrice]   = useState('');
  const [size, setSize]             = useState('');
  const [denomination, setDenomination] = useState('USDC');
  const [leverage, setLeverage]     = useState(10);
  const [label, setLabel]           = useState('');
  const [autoExit, setAutoExit]     = useState(true);
  const [autoExitPct, setAutoExitPct] = useState(() => loadPct(user?.username));
  const [showPctModal, setShowPctModal] = useState(false);
  const [pctInput, setPctInput]     = useState('');
  const pctInputRef                 = useRef(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [historyTab, setHistoryTab] = useState(false);

  const isLong = direction === 'long';

  useEffect(() => {
    if (selectedAsset) setAsset(selectedAsset);
  }, [selectedAsset]);

  useEffect(() => { refreshHedges(); }, []);

  // Reload pct from localStorage when user changes
  useEffect(() => {
    setAutoExitPct(loadPct(user?.username));
  }, [user?.username]);

  // Focus input when modal opens
  useEffect(() => {
    if (showPctModal) {
      setPctInput(autoExitPct.toString());
      setTimeout(() => pctInputRef.current?.select(), 50);
    }
  }, [showPctModal, autoExitPct]);

  // Cuando autoExit está activo, recalcula exitPrice como ±X% del entryPrice
  useEffect(() => {
    if (!autoExit) return;
    const entry = parseFloat(entryPrice);
    if (!entry || entry <= 0) return;
    const factor = autoExitPct / 100;
    const auto = isLong
      ? (entry * (1 - factor)).toFixed(2)
      : (entry * (1 + factor)).toFixed(2);
    setExitPrice(auto);
  }, [autoExit, entryPrice, isLong, autoExitPct]);

  const savePct = () => {
    const n = parseFloat(pctInput);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return;
    setAutoExitPct(n);
    localStorage.setItem(`hedge_autoexit_pct_${user?.username}`, n.toString());
    setShowPctModal(false);
  };

  const currentPrice = prices[asset] ? parseFloat(prices[asset]) : null;

  const entryNum    = parseFloat(entryPrice);
  const exitNum     = parseFloat(exitPrice);
  const refPrice    = entryNum > 0 ? entryNum : currentPrice;
  const sizeInAsset = size && refPrice
    ? denomination === 'USDC' ? parseFloat(size) / refPrice : parseFloat(size)
    : null;
  const notional  = sizeInAsset && entryNum ? sizeInAsset * entryNum : null;
  const margin    = notional ? notional / leverage : null;
  const priceValid = entryNum > 0 && exitNum > 0;

  // SHORT: exit > entry (SL arriba); LONG: exit < entry (SL abajo)
  const logicValid = isLong
    ? priceValid && exitNum < entryNum
    : priceValid && exitNum > entryNum;

  const handleCreate = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await createHedge({ asset, entryPrice, exitPrice, size: sizeInAsset, leverage, label, direction });
      setEntryPrice('');
      setExitPrice('');
      setSize('');
      setDenomination('USDC');
      setLabel('');
    } catch {
      // notificado por contexto
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async (id) => { await cancelHedge(id); };

  const activeHedges    = hedges.filter((h) => ['waiting', 'entry_pending', 'entry_filled_pending_sl', 'open', 'open_protected', 'closing', 'cancel_pending', 'executing_open', 'executing_close'].includes(h.status));
  const cancelledHedges = hedges.filter((h) => ['cancelled', 'error'].includes(h.status));
  const completedCycles = hedges
    .flatMap(h => (h.cycles || []).map(c => ({ ...c, asset: h.asset, label: h.label, leverage: h.leverage, direction: h.direction, hedgeId: h.id })))
    .sort((a, b) => b.closedAt - a.closedAt);

  return (
    <div className={styles.container}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Coberturas Automaticas</h2>
          <p className={styles.subtitle}>
            GTC nativo + SL nativo · Isolated · ciclos automaticos
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={refreshHedges} title="Refrescar">↻</button>
      </div>

      {/* ── 2-column body ── */}
      <div className={styles.body}>

        {/* ── LEFT: Formulario ── */}
        <div className={styles.formCol}>
          {/* Section header */}
          <div className={styles.colLabel}>Abrir Cobertura</div>

          {/* Direction selector */}
          <div className={styles.directionBar}>
            <button
              type="button"
              className={`${styles.dirBtn} ${isLong ? styles.dirBtnLongActive : styles.dirBtnInactive}`}
              onClick={() => { setDirection('long'); setExitPrice(''); }}
            >
              ▲ Long
            </button>
            <button
              type="button"
              className={`${styles.dirBtn} ${!isLong ? styles.dirBtnShortActive : styles.dirBtnInactive}`}
              onClick={() => { setDirection('short'); setExitPrice(''); }}
            >
              ▼ Short
            </button>
          </div>

          <form className={styles.form} onSubmit={handleCreate}>
            {/* Par y precio actual */}
            <div className={styles.row2}>
              <div className={styles.field}>
                <label className={styles.label}>Par de futuros</label>
                <input
                  className={styles.input}
                  type="text"
                  placeholder="BTC"
                  value={asset}
                  onChange={(e) => setAsset(e.target.value.toUpperCase())}
                  required
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Precio actual</label>
                <div className={styles.priceDisplay}>
                  {currentPrice
                    ? `$${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                    : '—'}
                </div>
              </div>
            </div>

            {/* Separador: Condiciones de activación */}
            <div className={isLong ? styles.sectionDividerLong : styles.sectionDivider}>
              <span>{isLong ? '▲' : '▼'}</span>
              <span className={styles.sectionTitle}>Condiciones de activación</span>
            </div>

            {/* Entry + Exit en horizontal */}
            <div className={styles.row2}>
              {/* Entry */}
              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>Entrada</label>
                  <span className={styles.hint}>{isLong ? 'precio ≥' : 'precio ≤'}</span>
                </div>
                <div className={styles.inputGroup}>
                  <span className={styles.inputPrefix}>$</span>
                  <input
                    className={`${styles.input} ${styles.inputInner}`}
                    type="number" step="0.01" min="0" placeholder="ej: 95000"
                    value={entryPrice}
                    onChange={(e) => setEntryPrice(e.target.value)}
                    required
                  />
                  {currentPrice && (
                    <button type="button" className={styles.priceBtn}
                      onClick={() => setEntryPrice(currentPrice.toFixed(2))}>Actual</button>
                  )}
                </div>
                {currentPrice && entryNum > 0 && (
                  <span className={styles.fieldHint}>
                    {isLong
                      ? (entryNum > currentPrice
                          ? `+${((entryNum / currentPrice - 1) * 100).toFixed(2)}% del precio actual`
                          : '⚡ Activaría inmediatamente')
                      : (entryNum < currentPrice
                          ? `-${((1 - entryNum / currentPrice) * 100).toFixed(2)}% del precio actual`
                          : '⚡ Activaría inmediatamente')}
                  </span>
                )}
              </div>

              {/* Exit / SL */}
              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>{isLong ? 'Salida SL' : 'Salida'}</label>
                  <span className={styles.autoExitGroup}>
                    <label className={styles.autoExitLabel}>
                      <input
                        type="checkbox"
                        checked={autoExit}
                        onChange={(e) => setAutoExit(e.target.checked)}
                        className={styles.autoExitCheck}
                      />
                      Auto {autoExitPct}%
                    </label>
                    <button
                      type="button"
                      className={styles.pctEditBtn}
                      onClick={() => setShowPctModal(true)}
                      title="Editar porcentaje"
                    >✎</button>
                  </span>
                </div>
                <div className={styles.inputGroup}>
                  <span className={styles.inputPrefix}>$</span>
                  <input
                    className={`${styles.input} ${styles.inputInner}`}
                    type="number" step="0.01" min="0"
                    placeholder={isLong ? 'ej: 90000' : 'ej: 100000'}
                    value={exitPrice}
                    onChange={(e) => { if (!autoExit) setExitPrice(e.target.value); }}
                    disabled={autoExit}
                    required
                  />
                  {currentPrice && !autoExit && (
                    <button type="button" className={styles.priceBtn}
                      onClick={() => setExitPrice(currentPrice.toFixed(2))}>Actual</button>
                  )}
                </div>
                {priceValid && !logicValid && (
                  <span className={styles.fieldError}>
                    {isLong ? 'SL debe ser < entrada' : 'Salida debe ser > entrada'}
                  </span>
                )}
                {isLong && entryNum > 0 && exitNum > 0 && exitNum < entryNum && (
                  <span className={styles.fieldHint}>
                    SL a {((entryNum - exitNum) / entryNum * 100).toFixed(2)}% bajo entrada
                  </span>
                )}
              </div>
            </div>

            {/* Tamano y apalancamiento */}
            <div className={styles.row2}>
              <div className={styles.field}>
                <label className={styles.label}>Cantidad ({denomination})</label>
                <div className={styles.segmented}>
                  {['USDC', asset].map((d) => (
                    <button key={d} type="button"
                      className={`${styles.segBtn} ${denomination === d ? styles.segActive : ''}`}
                      onClick={() => { setDenomination(d); setSize(''); }}>
                      {d}
                    </button>
                  ))}
                </div>
                <input
                  className={styles.input}
                  type="number"
                  step={denomination === 'USDC' ? '0.01' : '0.0001'}
                  min={denomination === 'USDC' ? '0.01' : '0.0001'}
                  placeholder={denomination === 'USDC' ? 'ej: 500' : 'ej: 0.01'}
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  required
                />
                {denomination === 'USDC' && sizeInAsset > 0 && (
                  <span className={styles.fieldHint}>≈ {sizeInAsset.toFixed(6)} {asset}</span>
                )}
              </div>

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>Apalancamiento</label>
                  <span className={isLong ? styles.leverageValLong : styles.leverageVal}>{leverage}x Isolated</span>
                </div>
                <input type="range" min="1" max="50" value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                  className={isLong ? styles.sliderLong : styles.slider} />
                <div className={styles.presets}>
                  {[1, 2, 5, 10, 20, 50].map((v) => (
                    <button key={v} type="button"
                      className={`${styles.preset} ${leverage === v ? (isLong ? styles.presetActiveLong : styles.presetActive) : ''}`}
                      onClick={() => setLeverage(v)}>{v}x</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Etiqueta opcional (inline con monto convertido) */}
            <div className={styles.field}>
              <label className={styles.label}>Etiqueta <span className={styles.hint}>(opcional)</span></label>
              <input className={styles.input} type="text"
                placeholder={`ej: Cobertura ${asset} ${isLong ? 'alcista' : 'bajista'} Q3`}
                value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>

            {/* Resumen */}
            {notional !== null && logicValid && (
              <div className={isLong ? styles.summaryLong : styles.summary}>
                <div className={styles.summaryTitle}>Resumen</div>
                <div className={styles.summaryGrid}>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Tipo</span>
                    <span className={styles.summaryVal}>{isLong ? 'LONG' : 'SHORT'} Isolated {leverage}x</span>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Activa cuando</span>
                    <span className={`${styles.summaryVal} ${isLong ? styles.triggerUp : styles.triggerDown}`}>
                      {isLong ? '≥' : '≤'} ${Number(entryPrice).toLocaleString()}
                    </span>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Cierra SL cuando</span>
                    <span className={`${styles.summaryVal} ${isLong ? styles.triggerDown : styles.triggerUp}`}>
                      {isLong ? '≤' : '≥'} ${Number(exitPrice).toLocaleString()}
                    </span>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Nocional</span>
                    <span className={styles.summaryVal}>${notional.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Margen</span>
                    <span className={styles.summaryVal}>${margin.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Rango</span>
                    <span className={styles.summaryVal}>
                      ${Number(isLong ? exitPrice : entryPrice).toLocaleString()} — ${Number(isLong ? entryPrice : exitPrice).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <button
              type="submit"
              className={isLong ? styles.submitBtnLong : styles.submitBtn}
              disabled={isSubmitting || !logicValid || !sizeInAsset || sizeInAsset <= 0}
            >
              {isSubmitting ? 'Creando...' : (isLong ? '▲ Activar cobertura LONG' : '▼ Activar cobertura SHORT')}
            </button>
          </form>

          {/* ── Modal editar porcentaje ── */}
          {showPctModal && (
            <div className={styles.modalOverlay} onClick={() => setShowPctModal(false)}>
              <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>Diferencial automático</span>
                  <button className={styles.modalClose} onClick={() => setShowPctModal(false)}>✕</button>
                </div>
                <p className={styles.modalDesc}>
                  Porcentaje de separación entre precio de entrada y SL automático.
                </p>
                <div className={styles.modalField}>
                  <label className={styles.modalLabel}>Porcentaje (%)</label>
                  <div className={styles.modalInputGroup}>
                    <input
                      ref={pctInputRef}
                      className={styles.modalInput}
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="100"
                      value={pctInput}
                      onChange={(e) => setPctInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') savePct(); if (e.key === 'Escape') setShowPctModal(false); }}
                    />
                    <span className={styles.modalInputSuffix}>%</span>
                  </div>
                  <span className={styles.modalHint}>
                    Valor actual: {autoExitPct}% · {autoExitPct === 0.05 ? 'valor por defecto' : 'personalizado'}
                  </span>
                </div>
                <div className={styles.modalActions}>
                  <button className={styles.modalCancel} onClick={() => setShowPctModal(false)}>Cancelar</button>
                  <button className={styles.modalSave} onClick={savePct}>Guardar</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Lista de coberturas ── */}
        <div className={styles.listCol}>
          {/* Tab bar */}
          <div className={styles.tabBar} role="tablist" aria-label="Filtro de coberturas">
            <button
              type="button"
              role="tab"
              aria-selected={!historyTab}
              className={`${styles.tabPill} ${!historyTab ? styles.tabPillActive : ''}`}
              onClick={() => setHistoryTab(false)}>
              <span className={styles.tabLabel}>Activas</span>
              <span className={`${styles.tabBadge} ${!historyTab ? styles.tabBadgeActive : ''}`}>
                {activeHedges.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={historyTab}
              className={`${styles.tabPill} ${historyTab ? styles.tabPillActive : ''}`}
              onClick={() => setHistoryTab(true)}>
              <span className={styles.tabLabel}>Historial</span>
              <span className={`${styles.tabBadge} ${historyTab ? styles.tabBadgeActive : ''}`}>
                {completedCycles.length + cancelledHedges.length}
              </span>
            </button>
          </div>

          <div className={styles.hedgeList}>
            {/* Tab: Activas */}
            {!historyTab && (
              <>
                {activeHedges.length === 0 && (
                  <div className={styles.empty}>No hay coberturas activas.</div>
                )}
                {activeHedges.map((h) => (
                  <HedgeCard
                    key={h.id}
                    hedge={h}
                    currentPrice={prices[h.asset] ? parseFloat(prices[h.asset]) : null}
                    onCancel={handleCancel}
                  />
                ))}
              </>
            )}

            {/* Tab: Historial */}
            {historyTab && (
              <>
                {completedCycles.length === 0 && cancelledHedges.length === 0 && (
                  <div className={styles.empty}>No hay historial aun.</div>
                )}
                {completedCycles.map((c, i) => (
                  <CycleRow key={`${c.hedgeId}-${c.cycleId}-${i}`} cycle={c} />
                ))}
                {cancelledHedges.map((h) => (
                  <HedgeCard key={h.id} hedge={h} currentPrice={null} onCancel={null} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Calcula PnL bruto, fees, funding y neto de un ciclo */
function calcCyclePnl(c, hedgeSize, direction) {
  // Preferir closedPnl del exchange (ya incluye slippage real)
  const gross = c.closedPnl != null
    ? c.closedPnl
    : (c.openPrice && c.closePrice
        ? (direction === 'long'
            ? (parseFloat(c.closePrice) - parseFloat(c.openPrice)) * parseFloat(hedgeSize)
            : (parseFloat(c.openPrice)  - parseFloat(c.closePrice)) * parseFloat(hedgeSize))
        : null);
  const fees    = (c.entryFee || 0) + (c.exitFee || 0);
  const funding = c.fundingPaid || 0;                // positivo = recibido
  // Usar netPnl precalculado del backend si está disponible (incluye datos reales del exchange)
  const net = c.netPnl != null ? c.netPnl : (gross != null ? gross - fees + funding : null);
  return { gross, fees, funding, net };
}

function fmt(n, decimals = 4) {
  return (n >= 0 ? '+' : '') + n.toFixed(decimals);
}

/* ── Tarjeta individual de cobertura ── */
function HedgeCard({ hedge, currentPrice, onCancel }) {
  const [showHistory, setShowHistory] = useState(false);

  const isLong  = hedge.direction === 'long';
  const st      = STATUS_LABEL[hedge.status] || { text: hedge.status, color: '#64748b' };
  const pct     = currentPrice && hedge.entryPrice
    ? ((currentPrice - hedge.entryPrice) / hedge.entryPrice * 100).toFixed(2)
    : null;
  const isActive = ['open', 'open_protected', 'entry_filled_pending_sl'].includes(hedge.status);
  const cycles   = hedge.cycles || [];

  // Acumulados de todos los ciclos
  const totals = cycles.reduce((acc, c) => {
    const { gross, fees, funding, net } = calcCyclePnl(c, hedge.size, hedge.direction);
    return {
      net:     acc.net     + (net     ?? 0),
      gross:   acc.gross   + (gross   ?? 0),
      fees:    acc.fees    + fees,
      funding: acc.funding + funding,
      hasData: acc.hasData || net != null,
    };
  }, { net: 0, gross: 0, fees: 0, funding: 0, hasData: false });

  return (
    <div className={`${styles.card} ${isActive ? (isLong ? styles.cardActiveLong : styles.cardActive) : ''}`}>
      {/* Cabecera */}
      <div className={styles.cardHeader}>
        <div className={styles.cardLeft}>
          <span className={styles.cardAsset}>{hedge.asset}</span>
          <span className={isLong ? styles.longTag : styles.shortTag}>
            {isLong ? 'LONG' : 'SHORT'} {hedge.leverage}x
          </span>
          <span className={styles.statusDot} style={{ color: st.color }}>● {st.text}</span>
          {cycles.length > 0 && (
            <span className={styles.cycleCountBadge}>{cycles.length} ciclo{cycles.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        <div className={styles.cardActions}>
          {cycles.length > 0 && (
            <button className={styles.historyBtn}
              onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? '▲' : '▼'} Historial
            </button>
          )}
          {onCancel && ['waiting', 'entry_pending', 'entry_filled_pending_sl', 'open', 'open_protected', 'cancel_pending'].includes(hedge.status) && (
            <button className={styles.cancelBtn} onClick={() => onCancel(hedge.id)}>Cancelar</button>
          )}
        </div>
      </div>

      {hedge.label && <div className={styles.cardLabel}>{hedge.label}</div>}

      {/* Datos en grid 3-col */}
      <div className={styles.cardGrid}>
        <div className={styles.cardItem}>
          <span className={styles.cardItemLabel}>Entrada</span>
          <span className={`${styles.cardItemVal} ${isLong ? styles.triggerUp : styles.triggerDown}`}>
            {isLong ? '≥' : '≤'} ${Number(hedge.entryPrice).toLocaleString()}
          </span>
        </div>
        <div className={styles.cardItem}>
          <span className={styles.cardItemLabel}>Salida SL</span>
          <span className={`${styles.cardItemVal} ${isLong ? styles.triggerDown : styles.triggerUp}`}>
            {isLong ? '≤' : '≥'} ${Number(hedge.exitPrice).toLocaleString()}
          </span>
        </div>
        <div className={styles.cardItem}>
          <span className={styles.cardItemLabel}>Precio actual</span>
          <span className={styles.cardItemVal}>
            {currentPrice
              ? `$${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
              : '—'}
            {pct !== null && (
              <span className={parseFloat(pct) >= 0 ? styles.up : styles.down}>
                {' '}({parseFloat(pct) >= 0 ? '+' : ''}{pct}%)
              </span>
            )}
          </span>
        </div>
        <div className={styles.cardItem}>
          <span className={styles.cardItemLabel}>Tamano</span>
          <span className={styles.cardItemVal}>{parseFloat(hedge.size).toFixed(6)} {hedge.asset}</span>
          {hedge.entryPrice && (
            <span className={styles.cardItemSub}>
              ≈ ${(parseFloat(hedge.size) * parseFloat(hedge.entryPrice)).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC
            </span>
          )}
        </div>
        {hedge.entryOid && hedge.status === 'entry_pending' && (
          <div className={styles.cardItem}>
            <span className={styles.cardItemLabel}>Orden GTC (oid)</span>
            <span className={styles.cardItemVal}>{hedge.entryOid}</span>
          </div>
        )}
        {hedge.openPrice && (
          <div className={styles.cardItem}>
            <span className={styles.cardItemLabel}>Apertura</span>
            <span className={styles.cardItemVal}>${Number(hedge.openPrice).toLocaleString()}</span>
          </div>
        )}
        {hedge.unrealizedPnl != null && ['open', 'open_protected'].includes(hedge.status) && (
          <div className={styles.cardItem}>
            <span className={styles.cardItemLabel}>PnL no realizado</span>
            <span className={hedge.unrealizedPnl >= 0 ? styles.pnlPositive : styles.pnlNegative}>
              {fmt(Number(hedge.unrealizedPnl))} USDC
            </span>
          </div>
        )}
        {cycles.length > 0 && (
          <div className={`${styles.cardItem} ${styles.pnlSummaryItem}`}>
            <span className={styles.cardItemLabel}>PnL neto acum.</span>
            <span className={totals.net >= 0 ? styles.pnlPositive : styles.pnlNegative}>
              {fmt(totals.net)} USDC
            </span>
            <span className={styles.cardItemSub}>
              bruto {fmt(totals.gross, 2)} · fees -{totals.fees.toFixed(4)} · fund {fmt(totals.funding, 4)}
            </span>
          </div>
        )}
      </div>

      {hedge.error && (
        <div className={styles.cardError}>Error: {hedge.error}</div>
      )}

      <div className={styles.cardMeta}>
        <span>Creada: {new Date(hedge.createdAt).toLocaleString()}</span>
        {hedge.openedAt && <span>Abierta: {new Date(hedge.openedAt).toLocaleString()}</span>}
        {hedge.closedAt && <span>Cerrada: {new Date(hedge.closedAt).toLocaleString()}</span>}
      </div>

      {showHistory && cycles.length > 0 && (
        <div className={styles.cycleHistory}>
          <div className={styles.cycleHistoryTitle}>Historial de ciclos ({cycles.length})</div>
          {[...cycles].reverse().map((c) => (
            <CycleRow
              key={c.cycleId}
              cycle={{ ...c, asset: hedge.asset, label: hedge.label, leverage: hedge.leverage, direction: hedge.direction }}
              hedgeSize={hedge.size}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Fila de ciclo completado ── */
function CycleRow({ cycle, hedgeSize }) {
  const isLong = cycle.direction === 'long';
  const sz     = hedgeSize ?? cycle.size ?? 0;
  const { gross, fees, funding, net } = calcCyclePnl(cycle, sz, cycle.direction);
  const openPrice = Number.isFinite(parseFloat(cycle.openPrice)) ? parseFloat(cycle.openPrice) : null;
  const closePrice = Number.isFinite(parseFloat(cycle.closePrice)) ? parseFloat(cycle.closePrice) : null;

  const durationMs = (cycle.closedAt || 0) - (cycle.openedAt || 0);
  const mins  = Math.floor(durationMs / 60000);
  const hours = Math.floor(mins / 60);
  const duration = hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`;

  const hasFeeData = (cycle.entryFee || 0) + (cycle.exitFee || 0) > 0 || cycle.closedPnl != null;

  return (
    <div className={styles.cycleRow}>
      {/* Izquierda: identificación */}
      <div className={styles.cycleLeft}>
        <span className={styles.cycleAsset}>{cycle.asset}</span>
        <span className={`${styles.cycleBadge} ${isLong ? styles.cycleBadgeLong : ''}`}>
          {isLong ? 'LONG' : 'SHORT'} {cycle.leverage}x · #{cycle.cycleId}
        </span>
        {cycle.label && <span className={styles.cycleLabel}>{cycle.label}</span>}
        <span className={styles.cycleDuration}>{duration}</span>
      </div>

      {/* Derecha: PnL detallado */}
      <div className={styles.cycleRight}>
        {net != null && (
          <span className={net >= 0 ? styles.cycleProfit : styles.cycleLoss}>
            {fmt(net, 4)} USDC
          </span>
        )}
        <span className={styles.cyclePrices}>
          {openPrice != null
            ? `$${openPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            : 'N/A'}
          {' → '}
          {closePrice != null
            ? `$${closePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            : 'N/A'}
        </span>
        {hasFeeData && (
          <span className={styles.cycleBreakdown}>
            {gross != null && `bruto ${fmt(gross, 2)}`}
            {fees > 0 && ` · fees -${fees.toFixed(4)}`}
            {funding !== 0 && ` · fund ${fmt(funding, 4)}`}
          </span>
        )}
        {cycle.totalSlippage > 0 && (
          <span className={styles.cycleBreakdown}>
            slip -{cycle.totalSlippage.toFixed(4)} USDC
            {' '}(E:±{(cycle.entrySlippage || 0).toFixed(4)} / S:±{(cycle.exitSlippage || 0).toFixed(4)})
          </span>
        )}
        <span className={styles.cycleDuration}>{new Date(cycle.closedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}
