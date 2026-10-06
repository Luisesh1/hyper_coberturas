/**
 * Planificador de bridges: trae a la red del LP el déficit de cada lado.
 *
 * Por cada lado con déficit cotiza cada origen candidato en todos los
 * proveedores, entregando ya el token de ese lado (USDC al lado estable, el
 * nativo al lado ETH), y llena el déficit del más barato al más caro en costo
 * neto %. Un origen cuyo costo supera el umbral queda fuera con su motivo,
 * salvo que el usuario lo fuerce. El nativo de origen solo cuenta por encima
 * de la reserva de gas que esa red necesita para sus propios envíos.
 *
 * Orden de ejecución: primero la red del envío que lleva gas al destino (si
 * falta), y dentro de cada red los ERC20 antes que el nativo, para que el
 * nativo salga al final con el gas de los demás ya pagado.
 */

const { ethers } = require('ethers');
const { PROFILE_IDS } = require('./fee-profiles');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// Por debajo de esto el resto del déficit no compensa otro envío.
const MIN_REMAINING_USD = 0.5;
// Un envío solo de gas por debajo de esto lo rechazan los bridges.
const GAS_LEG_MIN_USD = 3;
// Colchón sobre el gas que falta en destino.
const GAS_SHORTFALL_NUM = 12n;
const GAS_SHORTFALL_DEN = 10n;
// Reserva de un nativo de origen: hasta dos ERC20 (approve + bridge) y su propio bridge.
const NATIVE_RESERVE_TX_KINDS = ['approval', 'bridge', 'approval', 'bridge', 'bridge'];

function rawToUsd(raw, decimals, priceUsd) {
  if (priceUsd == null) return null;
  return Number(ethers.formatUnits(BigInt(raw || 0), decimals)) * Number(priceUsd);
}

function usdToRaw(usd, decimals, priceUsd) {
  if (!(usd > 0) || !(priceUsd > 0)) return 0n;
  const units = usd / priceUsd;
  if (decimals >= 6) return BigInt(Math.floor(units * 1e6)) * 10n ** BigInt(decimals - 6);
  return BigInt(Math.floor(units * 10 ** decimals));
}

function minBig(a, b) {
  return a < b ? a : b;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function formatPct(value) {
  return `${value.toFixed(1).replace('.', ',')} %`;
}

function orderSteps(steps) {
  const carrier = steps.find((step) => step.carriesDestinationGas);
  const networks = [];
  if (carrier) networks.push(carrier.sourceNetwork);
  for (const step of steps) {
    if (!networks.includes(step.sourceNetwork)) networks.push(step.sourceNetwork);
  }
  const ordered = [];
  for (const network of networks) {
    const inNetwork = steps.filter((step) => step.sourceNetwork === network);
    ordered.push(...inNetwork.filter((step) => !step.token.isNative));
    ordered.push(...inNetwork.filter((step) => step.token.isNative));
  }
  return ordered.map((step, index) => ({ ...step, order: index + 1 }));
}

function bridgeTxsFor(quote, symbol) {
  return [
    ...quote.approvalTxs.map((approval) => ({
      kind: 'approval',
      label: `Aprobar ${symbol}`,
      to: approval.to,
      data: approval.data,
      value: '0',
    })),
    {
      kind: 'bridge',
      label: `Enviar ${symbol}`,
      to: quote.tx.to,
      data: quote.tx.data,
      value: quote.tx.value,
      providerGasLimit: quote.tx.gasLimit,
    },
  ];
}

async function buildBridgePlan({
  walletAddress,
  destination,
  sources = [],
  profile,
  thresholdPct = 3,
  forcedSources = [],
  disabledSources = [],
  maxSlippageBps = 50,
  providers,
  feeOracle,
  nativePrices = {},
}) {
  const forced = new Set(forcedSources);
  const disabled = new Set(disabledSources);
  const reserveCache = new Map();

  async function nativeReserveRaw(network) {
    if (!reserveCache.has(network)) {
      reserveCache.set(network, feeOracle.estimateTxCosts({
        network,
        profile,
        txs: NATIVE_RESERVE_TX_KINDS.map((kind) => ({ kind })),
        nativeUsdPrice: nativePrices[network] ?? null,
      }).then((costs) => BigInt(costs.totalMaxWei || 0)));
    }
    return reserveCache.get(network);
  }

  // Estado de cada origen y la fila que verá el usuario.
  const state = new Map();
  const sourcesView = [];
  for (const source of sources) {
    const view = {
      id: source.id,
      network: source.network,
      symbol: source.symbol,
      address: source.address,
      isNative: source.isNative === true,
      balanceRaw: String(source.balanceRaw),
      decimals: source.decimals,
      usd: rawToUsd(source.balanceRaw, source.decimals, source.priceUsd),
      role: 'not_needed',
      reason: 'El déficit se cubre con orígenes más baratos',
      usedAmountRaw: '0',
      forced: forced.has(source.id),
    };
    let availableRaw = BigInt(source.balanceRaw || 0);
    if (disabled.has(source.id)) {
      view.role = 'disabled';
      view.reason = 'Desactivado por el usuario';
      availableRaw = 0n;
    } else if (source.priceUsd == null) {
      view.role = 'no_price';
      view.reason = 'Sin precio: no se puede valorar';
      availableRaw = 0n;
    } else if (source.isNative) {
      const reserve = await nativeReserveRaw(source.network);
      availableRaw = availableRaw > reserve ? availableRaw - reserve : 0n;
      if (availableRaw === 0n) {
        view.role = 'gas_reserve';
        view.reason = 'Por debajo de la reserva de gas del perfil';
      }
    }
    state.set(source.id, { source, view, availableRaw });
    sourcesView.push(view);
  }

  async function evaluate(entry, side, needUsd) {
    const { source } = entry;
    const amountRaw = minBig(entry.availableRaw, usdToRaw(needUsd, source.decimals, source.priceUsd));
    if (amountRaw <= 0n) return null;
    const fromUsd = rawToUsd(amountRaw, source.decimals, source.priceUsd);
    const settled = await Promise.allSettled(providers.map((provider) => provider.quote({
      fromNetwork: source.network,
      toNetwork: destination.network,
      fromToken: source.isNative ? ZERO_ADDRESS : source.address,
      toToken: side.deliveryToken.address,
      fromAmountRaw: amountRaw.toString(),
      walletAddress,
      slippageBps: maxSlippageBps,
    })));

    const options = [];
    const errors = [];
    for (const result of settled) {
      if (result.status === 'rejected') {
        errors.push(result.reason?.message || String(result.reason));
        continue;
      }
      const quote = result.value;
      const gas = await feeOracle.estimateTxCosts({
        network: source.network,
        profile,
        from: walletAddress,
        nativeUsdPrice: nativePrices[source.network] ?? null,
        txs: bridgeTxsFor(quote, source.symbol),
      });
      const toUsd = rawToUsd(quote.toAmountRaw, side.deliveryToken.decimals, side.deliveryToken.priceUsd);
      const extraFeesUsd = quote.feeCosts.filter((fee) => !fee.included).reduce((acc, fee) => acc + fee.amountUsd, 0);
      const bridgeCostUsd = Math.max(0, fromUsd - toUsd) + extraFeesUsd;
      const gasExpectedUsd = gas.totalExpectedUsd ?? 0;
      const gasMaxUsd = gas.totalMaxUsd ?? 0;
      const costUsd = bridgeCostUsd + gasExpectedUsd;
      options.push({
        quote,
        gas,
        amountRaw,
        fromUsd,
        toUsd,
        bridgeCostUsd,
        gasExpectedUsd,
        gasMaxUsd,
        costUsd,
        costPct: fromUsd > 0 ? (costUsd / fromUsd) * 100 : Infinity,
      });
    }
    options.sort((a, b) => a.costUsd - b.costUsd);
    return { entry, options, errors };
  }

  // Gas en destino: si falta, lo lleva el lado nativo o un envío propio.
  const sides = destination.sides.filter((side) => side.deficitUsd > 0).map((side) => ({ ...side }));
  const destNative = BigInt(destination.nativeBalanceRaw || 0);
  const gasNeeded = BigInt(destination.gasNeededRaw || 0);
  let gasSideName = null;
  if (destNative < gasNeeded) {
    const shortfallRaw = ((gasNeeded - destNative) * GAS_SHORTFALL_NUM) / GAS_SHORTFALL_DEN;
    const shortfallUsd = rawToUsd(shortfallRaw, 18, destination.nativePriceUsd) || 0;
    const nativeSide = sides.find((side) => side.deliveryToken.isNative);
    if (nativeSide) {
      nativeSide.deficitUsd += shortfallUsd;
      gasSideName = nativeSide.side;
    } else {
      sides.push({
        side: 'gas',
        deficitUsd: Math.max(shortfallUsd, GAS_LEG_MIN_USD),
        deliveryToken: {
          address: ZERO_ADDRESS,
          symbol: destination.nativeSymbol || 'ETH',
          decimals: 18,
          isNative: true,
          priceUsd: destination.nativePriceUsd,
        },
      });
      gasSideName = 'gas';
    }
  }
  sides.sort((a, b) => (a.side === gasSideName ? -1 : b.side === gasSideName ? 1 : b.deficitUsd - a.deficitUsd));

  const steps = [];
  let uncoveredUsd = 0;
  for (const side of sides) {
    let remaining = side.deficitUsd;
    const skipped = new Set();
    while (remaining > MIN_REMAINING_USD) {
      const candidates = [...state.values()].filter((entry) => entry.availableRaw > 0n && !skipped.has(entry.source.id));
      if (!candidates.length) break;
      const evaluations = (await Promise.all(candidates.map((entry) => evaluate(entry, side, remaining)))).filter(Boolean);

      let pick = null;
      const ranked = evaluations
        .filter((evaluation) => evaluation.options.length)
        .sort((a, b) => a.options[0].costPct - b.options[0].costPct);
      for (const evaluation of evaluations.filter((e) => !e.options.length)) {
        skipped.add(evaluation.entry.source.id);
        if (evaluation.entry.view.role !== 'used') {
          evaluation.entry.view.role = 'no_route';
          evaluation.entry.view.reason = `Sin ruta: ${evaluation.errors[0] || 'ningún proveedor cotizó'}`;
        }
      }
      for (const evaluation of ranked) {
        const best = evaluation.options[0];
        const isForced = forced.has(evaluation.entry.source.id);
        if (best.costPct <= thresholdPct || isForced) {
          pick = evaluation;
          break;
        }
        skipped.add(evaluation.entry.source.id);
        if (evaluation.entry.view.role !== 'used') {
          evaluation.entry.view.role = 'excluded';
          evaluation.entry.view.reason = `Costo $${best.costUsd.toFixed(2)} = ${formatPct(best.costPct)} > umbral ${thresholdPct} %`;
        }
      }
      if (!pick) break;

      const best = pick.options[0];
      const alternative = pick.options[1]
        ? { provider: pick.options[1].quote.provider, costUsd: round(pick.options[1].costUsd) }
        : null;
      const { source } = pick.entry;
      steps.push({
        sourceId: source.id,
        sourceNetwork: source.network,
        token: { address: source.isNative ? ZERO_ADDRESS : source.address, symbol: source.symbol, decimals: source.decimals, isNative: source.isNative === true },
        amountRaw: best.amountRaw.toString(),
        amountUsd: round(best.fromUsd),
        side: side.side,
        deliveryToken: side.deliveryToken,
        provider: best.quote.provider,
        quote: best.quote,
        txs: bridgeTxsFor(best.quote, source.symbol),
        receivedRaw: best.quote.toAmountRaw,
        receivedUsd: round(best.toUsd),
        carriesDestinationGas: false,
        forced: forced.has(source.id),
        etaSec: best.quote.etaSec,
        alternative,
        costs: {
          gasOrigin: {
            expectedUsd: round(best.gasExpectedUsd),
            maxUsd: round(best.gasMaxUsd),
            l1Usd: round(best.gas.txs.reduce((acc, tx) => acc + (tx.l1Usd || 0), 0)),
            profilesMatter: best.gas.profilesMatter !== false,
            txs: best.gas.txs,
          },
          bridgeFees: best.quote.feeCosts,
          bridgeCostUsd: round(best.bridgeCostUsd),
          expectedUsd: round(best.costUsd),
          maxUsd: round(best.bridgeCostUsd + best.gasMaxUsd),
          costPct: round(best.costPct, 4),
        },
      });
      pick.entry.availableRaw -= best.amountRaw;
      const view = pick.entry.view;
      view.role = 'used';
      view.usedAmountRaw = (BigInt(view.usedAmountRaw) + best.amountRaw).toString();
      view.reason = `Costo ${formatPct(best.costPct)}`;
      remaining -= best.toUsd;
    }
    // Un resto menor que un envío lo absorbe el colchón del 5 % de cada lado.
    if (remaining > MIN_REMAINING_USD) uncoveredUsd += remaining;
  }

  // El envío que lleva el gas: uno que entregue nativo, mejor si sale de un ERC20.
  if (gasSideName) {
    const delivering = steps.filter((step) => step.side === gasSideName);
    const carrier = delivering.find((step) => !step.token.isNative) || delivering[0];
    if (carrier) carrier.carriesDestinationGas = true;
  }

  // Mismo bridge, gas de origen con cada perfil: la comparación de perfiles.
  for (const step of steps) {
    step.costsByProfile = {};
    for (const id of PROFILE_IDS) {
      const gas = id === profile
        ? { totalExpectedUsd: step.costs.gasOrigin.expectedUsd, totalMaxUsd: step.costs.gasOrigin.maxUsd }
        : await feeOracle.estimateTxCosts({
          network: step.sourceNetwork,
          profile: id,
          from: walletAddress,
          nativeUsdPrice: nativePrices[step.sourceNetwork] ?? null,
          txs: step.txs,
        });
      step.costsByProfile[id] = {
        gasOriginExpectedUsd: round(gas.totalExpectedUsd ?? 0),
        gasOriginMaxUsd: round(gas.totalMaxUsd ?? 0),
        expectedUsd: round(step.costs.bridgeCostUsd + (gas.totalExpectedUsd ?? 0)),
        maxUsd: round(step.costs.bridgeCostUsd + (gas.totalMaxUsd ?? 0)),
      };
    }
  }

  const costsByProfile = Object.fromEntries(PROFILE_IDS.map((id) => [id, {
    gasOriginExpectedUsd: round(steps.reduce((acc, step) => acc + step.costsByProfile[id].gasOriginExpectedUsd, 0)),
    gasOriginMaxUsd: round(steps.reduce((acc, step) => acc + step.costsByProfile[id].gasOriginMaxUsd, 0)),
    bridgeCostUsd: round(steps.reduce((acc, step) => acc + step.costs.bridgeCostUsd, 0)),
  }]));

  return {
    steps: orderSteps(steps),
    sourcesView,
    deliveredUsd: round(steps.reduce((acc, step) => acc + step.receivedUsd, 0)),
    uncoveredUsd: round(uncoveredUsd),
    costsByProfile,
  };
}

module.exports = { buildBridgePlan, orderSteps, rawToUsd, usdToRaw, ZERO_ADDRESS };
