const test = require('node:test');
const assert = require('node:assert/strict');

const { OptionsIvRecorder } = require('../src/services/options/options-iv-recorder.service');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');

const NOW = Date.UTC(2026, 9, 16, 9, 17);
const silent = { info() {}, warn() {}, error() {} };

test('captura vencimientos cercanos alineados a la hora y aplica la retención', async () => {
  const inserted = [];
  let cutoff = null;
  const expiries = syntheticExpiries(NOW);
  const calls = [];
  const recorder = new OptionsIvRecorder({
    underlyings: ['BTC', 'XRP'],
    now: () => NOW,
    logger: silent,
    repo: {
      async insertMany(rows) { inserted.push(...rows); return rows.length; },
      async deleteOlderThan(ms) { cutoff = ms; return 3; },
    },
    async getChain(underlying, expiry) {
      calls.push([underlying, expiry]);
      if (underlying === 'XRP') throw new Error('caído');
      const e = expiries.find((x) => x.code === expiry) || expiries[0];
      return { ...buildSyntheticChain({ underlying, spot: 60000, now: NOW, expiry: e, atmIv: 0.5, spreadPct: 2 }), expiries };
    },
  });

  const result = await recorder.capture();
  const hour = Date.UTC(2026, 9, 16, 9);
  assert.equal(result.capturedAt, hour);
  assert.ok(inserted.length > 0);
  assert.ok(inserted.every((r) => r.capturedAt === hour && r.underlying === 'BTC' && r.spot === 60000));
  assert.ok(inserted.every((r) => Math.abs(r.strike / 60000 - 1) <= 0.35));
  const codes = new Set(inserted.map((r) => r.expiry));
  assert.ok(codes.size > 1 && codes.size <= 8);
  assert.ok(inserted.some((r) => r.type === 'C') && inserted.some((r) => r.type === 'P'));
  assert.equal(cutoff, hour - 400 * 24 * 3600 * 1000);
  // Un subyacente caído no frena a los demás; misma hora → no se repite.
  assert.ok(calls.some(([u]) => u === 'XRP'));
  assert.deepEqual(await recorder.capture(), { skipped: true });
});
