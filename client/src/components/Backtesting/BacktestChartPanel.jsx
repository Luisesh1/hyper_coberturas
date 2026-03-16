import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts';
import { formatNumber } from '../../utils/formatters';
import styles from './BacktestChartPanel.module.css';

const PANE_PRICE = 0;
const PANE_EQUITY = 1;
const PANE_DRAWDOWN = 2;
const PANE_INDICATOR = 3;
const OVERLAY_COLORS = ['#22c55e', '#38bdf8', '#f59e0b', '#fb7185', '#a78bfa', '#34d399'];

function toChartTime(value) {
  return Math.floor(Number(value) / 1000);
}

function formatLegendValue(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return formatNumber(value, 4);
}

function buildMarkers(trades = []) {
  return trades.flatMap((trade) => {
    const entryShape = trade.side === 'long' ? 'arrowUp' : 'arrowDown';
    const exitShape = trade.pnl >= 0 ? 'circle' : 'square';
    return [
      {
        time: toChartTime(trade.entryTime),
        position: trade.side === 'long' ? 'belowBar' : 'aboveBar',
        color: trade.side === 'long' ? '#22c55e' : '#ef4444',
        shape: entryShape,
        text: `${trade.side.toUpperCase()} $${formatNumber(trade.sizeUsd, 2)}`,
      },
      {
        time: toChartTime(trade.exitTime),
        position: trade.side === 'long' ? 'aboveBar' : 'belowBar',
        color: trade.pnl >= 0 ? '#38bdf8' : '#f97316',
        shape: exitShape,
        text: `${trade.reason} ${formatNumber(trade.pnl, 2)}`,
      },
    ];
  });
}

function getLineValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value.value != null) return Number(value.value);
  return null;
}

function BacktestChartPanel({ result, focusedTrade }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const legendRefs = useRef([]);
  const [legend, setLegend] = useState([]);

  const chartPayload = useMemo(() => {
    if (!result?.candles?.length) return null;

    const candles = result.candles.map((candle) => ({
      time: toChartTime(candle.closeTime || candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }));

    const priceOverlays = [];
    const indicatorOverlays = [];
    let colorIndex = 0;

    for (const overlay of result.overlays || []) {
      const target = overlay.pane === 'separate' ? indicatorOverlays : priceOverlays;
      for (const series of overlay.series || []) {
        target.push({
          id: series.id,
          label: series.label,
          color: OVERLAY_COLORS[colorIndex % OVERLAY_COLORS.length],
          points: (series.points || [])
            .filter((point) => point.value != null && point.time != null)
            .map((point) => ({ time: toChartTime(point.time), value: Number(point.value) })),
        });
        colorIndex += 1;
      }
    }

    const positionSegments = (result.positionSegments || []).map((segment, index) => ({
      id: `segment-${index}`,
      label: `${segment.side} ${segment.reason}`,
      color: segment.side === 'long' ? '#16a34a' : '#dc2626',
      points: [
        { time: toChartTime(segment.entryTime), value: Number(segment.entryPrice) },
        { time: toChartTime(segment.exitTime), value: Number(segment.exitPrice) },
      ],
    }));

    const equity = (result.equitySeries || []).map((point) => ({
      time: toChartTime(point.time),
      value: Number(point.value),
    }));
    const drawdown = (result.drawdownSeries || []).map((point) => ({
      time: toChartTime(point.time),
      value: Number(point.value),
    }));

    return {
      candles,
      priceOverlays,
      indicatorOverlays,
      positionSegments,
      equity,
      drawdown,
      markers: buildMarkers(result.trades),
    };
  }, [result]);

  useEffect(() => {
    if (!containerRef.current || !chartPayload) return undefined;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      height: 620,
      layout: {
        background: { type: ColorType.Solid, color: '#07111f' },
        textColor: '#cbd5e1',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.18)',
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.18)',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;
    legendRefs.current = [];

    const priceSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      priceLineVisible: false,
      lastValueVisible: true,
    }, PANE_PRICE);
    priceSeries.setData(chartPayload.candles);
    legendRefs.current.push({ series: priceSeries, label: 'Precio' });

    createSeriesMarkers(priceSeries, chartPayload.markers);

    for (const overlay of chartPayload.priceOverlays) {
      const series = chart.addSeries(LineSeries, {
        color: overlay.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }, PANE_PRICE);
      series.setData(overlay.points);
      legendRefs.current.push({ series, label: overlay.label });
    }

    for (const segment of chartPayload.positionSegments) {
      const series = chart.addSeries(LineSeries, {
        color: segment.color,
        lineWidth: 2,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }, PANE_PRICE);
      series.setData(segment.points);
    }

    const equitySeries = chart.addSeries(LineSeries, {
      color: '#38bdf8',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    }, PANE_EQUITY);
    equitySeries.setData(chartPayload.equity);
    legendRefs.current.push({ series: equitySeries, label: 'Equity' });

    const drawdownSeries = chart.addSeries(AreaSeries, {
      lineColor: '#fb7185',
      topColor: 'rgba(251, 113, 133, 0.35)',
      bottomColor: 'rgba(251, 113, 133, 0.02)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    }, PANE_DRAWDOWN);
    drawdownSeries.setData(chartPayload.drawdown);
    legendRefs.current.push({ series: drawdownSeries, label: 'Drawdown' });

    for (const overlay of chartPayload.indicatorOverlays) {
      const series = chart.addSeries(LineSeries, {
        color: overlay.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }, PANE_INDICATOR);
      series.setData(overlay.points);
      legendRefs.current.push({ series, label: overlay.label });
    }

    const panes = chart.panes?.() || [];
    panes[PANE_PRICE]?.setHeight?.(340);
    panes[PANE_EQUITY]?.setHeight?.(130);
    panes[PANE_DRAWDOWN]?.setHeight?.(110);
    if (chartPayload.indicatorOverlays.length) {
      panes[PANE_INDICATOR]?.setHeight?.(150);
    }

    chart.subscribeCrosshairMove((param) => {
      if (!param?.point || param.point.x < 0 || param.point.y < 0) {
        setLegend([]);
        return;
      }
      const rows = legendRefs.current.map(({ series, label }) => {
        const data = param.seriesData.get(series);
        const value = data?.close ?? getLineValue(data);
        return { label, value };
      });
      setLegend(rows.filter((row) => row.value != null));
    });

    chart.timeScale().fitContent();

    let cleanupResize = () => {};
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry?.contentRect) return;
        chart.applyOptions({ width: Math.max(320, Math.floor(entry.contentRect.width)) });
      });
      observer.observe(containerRef.current);
      cleanupResize = () => observer.disconnect();
    } else {
      const handleResize = () => {
        const width = containerRef.current?.clientWidth || 960;
        chart.applyOptions({ width });
      };
      window.addEventListener('resize', handleResize);
      cleanupResize = () => window.removeEventListener('resize', handleResize);
    }

    return () => {
      cleanupResize();
      chart.remove();
      chartRef.current = null;
      legendRefs.current = [];
    };
  }, [chartPayload]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !result?.candles?.length) return;

    if (!focusedTrade) {
      chart.timeScale().fitContent();
      return;
    }

    const from = Math.max(0, toChartTime(focusedTrade.entryTime) - 10 * 60);
    const to = toChartTime(focusedTrade.exitTime) + (10 * 60);
    chart.timeScale().setVisibleRange({ from, to });
  }, [focusedTrade, result]);

  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Suite de graficas</span>
          <h2>Velas, equity, drawdown e indicadores en un mismo timeline</h2>
        </div>
        <div className={styles.legend}>
          {legend.length ? legend.map((item) => (
            <span key={item.label}>{item.label}: <strong>{formatLegendValue(item.value)}</strong></span>
          )) : (
            <span>Mueve el cursor para inspeccionar valores</span>
          )}
        </div>
      </div>
      <div ref={containerRef} className={styles.chart} data-testid="backtest-chart" />
    </section>
  );
}

export default BacktestChartPanel;
