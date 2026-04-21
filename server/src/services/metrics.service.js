/**
 * metrics.service.js
 *
 * Métricas internas muy ligeras en formato Prometheus text exposition.
 * No añadimos la dependencia `prom-client` (evita inflar bundle server);
 * esta implementación cubre counters e histogramas con buckets fijos,
 * que es lo que se necesita para observar latencia/error-rate.
 *
 * API:
 *   const m = require('./metrics.service');
 *   m.counter('hl_requests_total', { endpoint: 'info' }).inc();
 *   const end = m.histogram('hl_request_duration_seconds', { endpoint: 'info' }).startTimer();
 *   ... ;
 *   end();
 *   m.render(); // string con formato text/plain para /metrics
 */

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const counters = new Map();   // key → { name, help, type, labels, value }
const gauges = new Map();     // key → { name, help, type, labels, value }
const histograms = new Map(); // key → { name, help, type, labels, buckets:[], sum, count }

function labelKey(name, labels) {
  if (!labels) return name;
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return name;
  return name + '{' + keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',') + '}';
}

function escapeLabelVal(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelString(labels) {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${escapeLabelVal(labels[k])}"`).join(',') + '}';
}

function counter(name, labels = null, help = '') {
  const key = labelKey(name, labels);
  let c = counters.get(key);
  if (!c) {
    c = { name, help, type: 'counter', labels, value: 0 };
    counters.set(key, c);
  }
  return {
    inc(n = 1) {
      c.value += n;
    },
  };
}

function gauge(name, labels = null, help = '') {
  const key = labelKey(name, labels);
  let g = gauges.get(key);
  if (!g) {
    g = { name, help, type: 'gauge', labels, value: 0 };
    gauges.set(key, g);
  }
  return {
    set(v) {
      g.value = v;
    },
    inc(n = 1) {
      g.value += n;
    },
    dec(n = 1) {
      g.value -= n;
    },
  };
}

function histogram(name, labels = null, { help = '', buckets = DEFAULT_BUCKETS } = {}) {
  const key = labelKey(name, labels);
  let h = histograms.get(key);
  if (!h) {
    h = {
      name, help, type: 'histogram', labels,
      buckets: buckets.map((b) => ({ le: b, count: 0 })),
      inf: 0,
      sum: 0,
      count: 0,
    };
    histograms.set(key, h);
  }
  return {
    observe(seconds) {
      h.count += 1;
      h.sum += seconds;
      let placed = false;
      for (const b of h.buckets) {
        if (seconds <= b.le) { b.count += 1; placed = true; }
      }
      if (!placed) h.inf += 1;
    },
    startTimer() {
      const t0 = process.hrtime.bigint();
      return () => {
        const dt = Number(process.hrtime.bigint() - t0) / 1e9;
        this.observe(dt);
        return dt;
      };
    },
  };
}

function render() {
  const lines = [];
  // Counters
  const counterNames = new Set([...counters.values()].map((c) => c.name));
  for (const name of counterNames) {
    lines.push(`# TYPE ${name} counter`);
    for (const c of counters.values()) {
      if (c.name !== name) continue;
      lines.push(`${c.name}${labelString(c.labels)} ${c.value}`);
    }
  }
  // Gauges
  const gaugeNames = new Set([...gauges.values()].map((g) => g.name));
  for (const name of gaugeNames) {
    lines.push(`# TYPE ${name} gauge`);
    for (const g of gauges.values()) {
      if (g.name !== name) continue;
      lines.push(`${g.name}${labelString(g.labels)} ${g.value}`);
    }
  }
  // Histograms
  const histNames = new Set([...histograms.values()].map((h) => h.name));
  for (const name of histNames) {
    lines.push(`# TYPE ${name} histogram`);
    for (const h of histograms.values()) {
      if (h.name !== name) continue;
      const base = h.labels || {};
      let cumulative = 0;
      for (const b of h.buckets) {
        cumulative += b.count;
        lines.push(`${h.name}_bucket${labelString({ ...base, le: String(b.le) })} ${cumulative}`);
      }
      lines.push(`${h.name}_bucket${labelString({ ...base, le: '+Inf' })} ${h.count}`);
      lines.push(`${h.name}_sum${labelString(base)} ${h.sum}`);
      lines.push(`${h.name}_count${labelString(base)} ${h.count}`);
    }
  }
  return lines.join('\n') + '\n';
}

function reset() {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

module.exports = { counter, gauge, histogram, render, reset };
