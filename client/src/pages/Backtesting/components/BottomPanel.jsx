import { useState } from 'react';
import useResizablePanel from '../hooks/useResizablePanel';
import AssumptionChips from './AssumptionChips';
import ComparisonView from './ComparisonView';
import SignalLog from './SignalLog';
import TradeList from './TradeList';
import styles from './BottomPanel.module.css';

const TABS = [
  { id: 'trades', label: 'Trades' },
  { id: 'signals', label: 'Senales' },
  { id: 'assumptions', label: 'Supuestos' },
  { id: 'compare', label: 'Comparar' },
];

function BottomPanel({
  result,
  compareResult,
  visibleTrades,
  tradeFilter,
  setTradeFilter,
  focusedTradeId,
  setFocusedTradeId,
  selectedStrategy,
  runs,
}) {
  const [activeTab, setActiveTab] = useState('trades');
  const { height, handleProps } = useResizablePanel(240, 150, 500);

  const tabs = TABS.filter((t) => t.id !== 'compare' || runs.length >= 2);

  return (
    <div className={styles.panel} style={{ height }}>
      <div className={styles.handle} {...handleProps}>
        <div className={styles.handleBar} />
      </div>

      <div className={styles.tabBar}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'trades' && result?.trades && (
              <span className={styles.badge}>{result.trades.length}</span>
            )}
            {tab.id === 'signals' && result?.signals && (
              <span className={styles.badge}>{result.signals.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className={styles.body}>
        {activeTab === 'trades' && (
          <TradeList
            visibleTrades={visibleTrades}
            tradeFilter={tradeFilter}
            setTradeFilter={setTradeFilter}
            focusedTradeId={focusedTradeId}
            setFocusedTradeId={setFocusedTradeId}
          />
        )}
        {activeTab === 'signals' && <SignalLog signals={result?.signals} />}
        {activeTab === 'assumptions' && (
          <AssumptionChips result={result} selectedStrategy={selectedStrategy} />
        )}
        {activeTab === 'compare' && <ComparisonView runs={runs} />}
      </div>
    </div>
  );
}

export default BottomPanel;
