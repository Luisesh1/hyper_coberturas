const test = require('node:test');
const assert = require('node:assert/strict');

const { computeExtractableSlotSurplusUsd } = require('../src/utils/isolated-margin');

// Regresión de pp24 (2026-09-03 → 09-08): al salirse del rango, el delta del LP
// cayó a ~0 y el hedge se redujo a 0.0001 ETH en vez de cerrarse. En isolated,
// el slot conservó los $18.04 de colateral respaldando $0.25 de notional, y el
// `withdrawable` quedó en $13.28 contra $14.18 requeridos: faltaban $0.90 y la
// cobertura murió 5 días.
//
// La extracción del excedente existía pero se calculaba `rawUsd - marginUsed*1.2`.
// Como HL reporta `rawUsd = marginUsed + positionValue`, con la posición en
// polvo esa resta da negativo y clampa a 0: nunca liberaba nada justo cuando
// TODO el colateral estaba libre.

// Cifras exactas de `clearinghouseState` de 0x1ecC…9fde el 2026-09-08.
function pp24DustSlot() {
  return {
    position: {
      coin: 'ETH',
      szi: '-0.0001',
      positionValue: '0.24851',
      marginUsed: '18.039072',
      leverage: { type: 'isolated', value: 10, rawUsd: '18.287582' },
    },
  };
}

// Cuenta de pp27: posición sana y genuinamente sin margen libre (withdrawable $0.37).
function pp27HealthySlot() {
  return {
    position: {
      coin: 'ETH',
      szi: '-0.0821',
      positionValue: '204.10',
      marginUsed: '24.472',
      leverage: { type: 'isolated', value: 10, rawUsd: '228.572' },
    },
  };
}

test('libera el colateral del slot cuando la posición quedó en polvo', () => {
  const surplus = computeExtractableSlotSurplusUsd(pp24DustSlot(), { leverage: 10 });

  // Casi todo el colateral es extraíble: la dust sólo necesita $0.0249.
  assert.ok(surplus > 17.9, `esperaba >17.9 extraíble, obtuve ${surplus}`);
  assert.ok(surplus < 18.04, `no debe exceder el colateral del slot, obtuve ${surplus}`);

  // Y con eso el incremento bloqueado deja de estar bloqueado.
  const withdrawable = 13.277519;
  const incrementMarginUsd = 14.18;
  assert.ok(
    withdrawable + surplus > incrementMarginUsd,
    'el deadlock de pp24 debe quedar resuelto sin depositar nada',
  );
});

test('la fórmula vieja (rawUsd - marginUsed*1.2) era código muerto en el caso dust', () => {
  const { position } = pp24DustSlot();
  const anterior = Math.max(0, Number(position.leverage.rawUsd) - Number(position.marginUsed) * 1.2);
  assert.equal(anterior, 0, 'la fórmula anterior clampaba a 0 y por eso nunca extraía');
});

test('no inventa excedente sobre una posición sana sin margen libre', () => {
  const surplus = computeExtractableSlotSurplusUsd(pp27HealthySlot(), { leverage: 10 });

  // La fórmula vieja devolvía ~$199 aquí: casi todo el notional, no colateral.
  assert.ok(surplus < 1, `un slot ajustado no debe reportar excedente, obtuve ${surplus}`);
});

test('deja el buffer de seguridad sobre el margen requerido por el tamaño vivo', () => {
  const slot = {
    position: {
      szi: '-1',
      positionValue: '100',
      marginUsed: '30',
      leverage: { type: 'isolated', value: 10, rawUsd: '130' },
    },
  };
  // Requerido = 100/10 = 10; con buffer 1.2 → reserva 12; extraíble = 30 - 12.
  assert.equal(computeExtractableSlotSurplusUsd(slot, { leverage: 10 }), 18);
  assert.equal(
    computeExtractableSlotSurplusUsd(slot, { leverage: 10, safetyBufferFactor: 1 }),
    20,
  );
});

test('cae a |szi| * precio cuando HL no reporta positionValue', () => {
  const slot = {
    position: {
      szi: '-0.05',
      marginUsed: '30',
      leverage: { type: 'isolated', value: 10, rawUsd: '154.2' },
    },
  };
  // notional = 0.05 * 2480 = 124; requerido = 12.4; reserva = 14.88.
  const surplus = computeExtractableSlotSurplusUsd(slot, { leverage: 10, price: 2480 });
  assert.ok(Math.abs(surplus - (30 - 14.88)) < 1e-9, `obtuve ${surplus}`);
});

test('sin posición o sin colateral no hay nada que extraer', () => {
  assert.equal(computeExtractableSlotSurplusUsd(undefined, { leverage: 10 }), 0);
  assert.equal(computeExtractableSlotSurplusUsd({ position: {} }, { leverage: 10 }), 0);
  assert.equal(
    computeExtractableSlotSurplusUsd(
      { position: { marginUsed: '0', positionValue: '0' } },
      { leverage: 10 },
    ),
    0,
  );
});

test('leverage ausente o inválido no produce NaN ni excedente inflado', () => {
  const slot = pp27HealthySlot();
  for (const leverage of [undefined, 0, -5, Number.NaN]) {
    const surplus = computeExtractableSlotSurplusUsd(slot, { leverage });
    assert.ok(Number.isFinite(surplus), `leverage=${leverage} produjo ${surplus}`);
    // Con leverage forzado a 1 el requerido es el notional entero → 0 extraíble.
    assert.equal(surplus, 0);
  }
});
