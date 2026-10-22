import LineChart from './LineChart';
import { formatDateTime, formatUsdt } from './format';

// Curva de P&L acumulado: sombra y, si la hay, real. `equity` viene de buildEquity.
export default function PnlChart({ equity, height }) {
  const series = [
    { key: 'shadow', label: 'Sombra', values: equity.shadow, variant: 'primary' },
    ...(equity.hasLive ? [{ key: 'live', label: 'Real', values: equity.live, variant: 'live', dashed: true }] : []),
  ];
  const markers = equity.hasLive && equity.liveStartIndex > 0
    ? [{ index: equity.liveStartIndex, label: 'Pasa a real' }]
    : [];
  return (
    <LineChart
      times={equity.times}
      series={series}
      markers={markers}
      height={height}
      zeroLine
      formatValue={(v) => formatUsdt(v, { decimals: Math.abs(v) >= 100 ? 0 : 2, sign: true })}
      formatTime={formatDateTime}
      ariaLabel="Curva de P&L de la estrategia en modo sombra y en real"
      emptyText="La curva aparecerá cuando la estrategia complete su primera evaluación."
    />
  );
}
