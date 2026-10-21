import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog';
import { fmtNum, fmtSigned, toneOf } from '../format';
import { useOptionChain } from './hooks/useOptionChain';
import { useOptionsAccount } from './hooks/useOptionsAccount';
import { useOrderActions } from './hooks/useOrderActions';
import { findLeg, useTicket } from './hooks/useTicket';
import { quoteFor } from './ticketMath';
import AccountTabs from './AccountTabs';
import { buildChainMarks } from './chainMarks';
import ExpiryPills from './ExpiryPills';
import GreeksStrip from './GreeksStrip';
import MobileChain from './MobileChain';
import MobilePositionsSheet from './MobilePositionsSheet';
import MobileTicketSheet from './MobileTicketSheet';
import OptionChain from './OptionChain';
import OrderTicket from './OrderTicket';
import styles from './ManualTrading.module.css';

/**
 * Pestaña «Trading manual». La cadena es pública; cuenta, posiciones y
 * envío de órdenes necesitan la API key (`configured`).
 */
export default function ManualTradingTab({ underlying, configured, isMobile }) {
  // El vencimiento elegido vale para un subyacente: al cambiarlo se vuelve
  // al que propone el backend (el más cercano).
  const [expirySel, setExpirySel] = useState({ underlying, code: null });
  const expiry = expirySel.underlying === underlying ? expirySel.code : null;
  const setExpiry = (code) => setExpirySel({ underlying, code });

  const { chain, loading: chainLoading, error: chainError } = useOptionChain(underlying, expiry);
  const activeExpiry = expiry || chain?.expiry || null;

  const [accountTab, setAccountTab] = useState('positions');
  const [sheet, setSheet] = useState(null); // 'ticket' | 'positions' | null
  const [type, setType] = useState('C');

  const historyVisible = isMobile ? sheet === 'positions' && accountTab === 'history' : accountTab === 'history';
  const acct = useOptionsAccount({ enabled: !!configured, withTrades: historyVisible });

  const ticket = useTicket(chain);

  // ★ posiciones y ▲▼ órdenes abiertas sobre la cadena y los vencimientos.
  const marks = useMemo(
    () => (configured ? buildChainMarks(acct.positions, acct.openOrders) : null),
    [configured, acct.positions, acct.openOrders],
  );

  const quoteForSymbol = useCallback((symbol, side) => {
    const found = findLeg(chain, symbol);
    return found ? quoteFor(found.leg, side) : null;
  }, [chain]);

  const actions = useOrderActions({ onDone: acct.refresh, quoteForSymbol });

  const handleSubmit = async (order) => {
    const ok = await actions.submitOrder(order);
    if (ok && isMobile) setSheet(null);
  };

  const pickMobileRow = ({ leg, strike, type: legType }) => {
    ticket.pick({ leg, strike, type: legType, side: ticket.side });
    setSheet('ticket');
  };

  const notConfigured = !configured && (
    <div className={styles.notice} role="status">
      <span>
        Modo solo lectura: la cadena es pública. Para operar, conecta tu API key en{' '}
        <Link to="/config?section=binanceOptions">Configuración › Binance Opciones</Link>.
      </span>
    </div>
  );

  const errorBanner = actions.error && (
    <div className={styles.errorBanner} role="alert">
      <span>{actions.error}</span>
      <button type="button" onClick={actions.clearError} aria-label="Descartar error">Cerrar</button>
    </div>
  );

  // Binance limitó (429) pero hay un snapshot previo: se sigue mostrando.
  const staleNotice = configured && acct.stale && (
    <div className={styles.notice} role="status">
      <span>Binance limitó las peticiones: mostrando el último dato de la cuenta; se actualizará solo.</span>
    </div>
  );

  const confirmDialog = (
    <ConfirmDialog
      open={!!actions.dialog.open}
      title={actions.dialog.title}
      message={actions.dialog.message}
      confirmLabel={actions.dialog.confirmLabel}
      cancelLabel="Volver"
      variant={actions.dialog.variant}
      onConfirm={actions.dialog.onConfirm}
      onCancel={actions.dialog.onCancel}
    />
  );

  if (isMobile) {
    const g = acct.account?.greeks || {};
    const pnl = acct.account?.unrealizedPnlUsdt;
    return (
      <div className={styles.mobileRoot}>
        {notConfigured}
        {errorBanner}
        {staleNotice}
        <ExpiryPills expiries={chain?.expiries} value={activeExpiry} onChange={setExpiry} scroller marks={marks?.byExpiry} />
        {configured && acct.account && (
          <div className={styles.mobileFunds} role="status">
            <span>Fondos de opciones</span>
            <strong className={styles.mono}>
              {acct.account.balanceUsdt != null && Number.isFinite(Number(acct.account.balanceUsdt))
                ? `${fmtNum(acct.account.balanceUsdt, 2)} USDT`
                : '—'}
            </strong>
          </div>
        )}
        <MobileChain
          chain={chain}
          loading={chainLoading}
          error={chainError}
          type={type}
          onType={setType}
          selectedSymbol={sheet === 'ticket' ? ticket.symbol : null}
          onPickRow={pickMobileRow}
          marks={marks}
        />

        <div className={styles.bottomBar}>
          <button type="button" className={styles.barBtn} onClick={() => setSheet('positions')}>
            <span className={styles.barLabel}>Posiciones · {configured ? acct.positions.length : '—'}</span>
            <span className={`${styles.mono} ${styles.barValue} ${styles[toneOf(pnl)]}`}>
              {configured && acct.account ? `${fmtSigned(pnl, 2)} USDT` : '—'}
            </span>
          </button>
          <button type="button" className={styles.barBtn} onClick={() => setSheet('positions')}>
            <span className={styles.barLabel}>Griegas</span>
            <span className={`${styles.mono} ${styles.barValue} ${styles.neutral}`}>
              {configured && acct.account ? `Δ ${fmtSigned(g.delta, 2)} · Θ ${fmtSigned(g.theta, 1)}` : '—'}
            </span>
          </button>
        </div>

        <MobileTicketSheet
          open={sheet === 'ticket' && !!ticket.symbol}
          onClose={() => setSheet(null)}
          ticket={ticket}
          configured={configured}
          pending={actions.pending}
          onSubmit={handleSubmit}
        />
        <MobilePositionsSheet
          open={sheet === 'positions'}
          onClose={() => setSheet(null)}
          section={accountTab}
          onSection={setAccountTab}
          configured={configured}
          account={acct.account}
          positions={acct.positions}
          openOrders={acct.openOrders}
          trades={acct.trades}
          tradesLoading={acct.tradesLoading}
          pending={actions.pending}
          onClosePosition={actions.closePosition}
          onCloseAtPrice={actions.closePositionAtPrice}
          onCancelOrder={actions.cancelOrder}
        />
        {confirmDialog}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {notConfigured}
      <GreeksStrip account={configured ? acct.account : null} limits={acct.limits} />
      {errorBanner}
      {staleNotice}
      {configured && acct.error && (
        <div className={styles.errorBanner} role="alert">
          <span>No se pudo leer la cuenta: {acct.error.message}</span>
        </div>
      )}
      <div className={styles.workArea}>
        <OptionChain
          chain={chain}
          loading={chainLoading}
          error={chainError}
          expiry={activeExpiry}
          onExpiry={setExpiry}
          selection={ticket.symbol ? { symbol: ticket.symbol, side: ticket.side } : null}
          onPick={ticket.pick}
          marks={marks}
        />
        <OrderTicket
          ticket={ticket}
          configured={configured}
          pending={actions.pending}
          onSubmit={handleSubmit}
        />
      </div>
      <AccountTabs
        tab={accountTab}
        onTab={setAccountTab}
        configured={configured}
        positions={acct.positions}
        openOrders={acct.openOrders}
        trades={acct.trades}
        tradesLoading={acct.tradesLoading}
        pending={actions.pending}
        onClose={actions.closePosition}
        onCloseAtPrice={actions.closePositionAtPrice}
        onCancel={actions.cancelOrder}
      />
      {confirmDialog}
    </div>
  );
}
