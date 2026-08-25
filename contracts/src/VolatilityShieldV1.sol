// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Fee dinámica conservadora para pools V4, basada únicamente en el TWAP
///         de ticks del propio pool: sin oráculos externos, volumen ni profundidad.
/// @dev Debe desplegarse mediante CREATE2 en una dirección con el flag BEFORE_SWAP.
contract VolatilityShieldV1 is BaseHook {
    using StateLibrary for IPoolManager;

    uint24 public constant FLOOR_FEE = 500; // 5 bps
    uint24 public constant BASE_FEE = 3000; // 30 bps
    uint24 public constant CAP_FEE = 6000; // 60 bps
    uint32 public constant UPDATE_INTERVAL = 5 minutes;
    uint24 public constant MAX_FEE_STEP = 500; // 5 bps

    // EWMA corta y larga sobre el movimiento absoluto de ticks. La diferencia
    // evita reaccionar a una sola observación y limita la subida por intervalo.
    uint64 public constant SHORT_ALPHA_BPS = 3000;
    uint64 public constant LONG_ALPHA_BPS = 800;
    uint64 public constant VOL_THRESHOLD = 12;
    uint64 public constant FEE_PER_TICK = 15;

    struct PoolState {
        // Acumulador del oráculo: suma de tick * segundos que ese tick estuvo
        // vigente. int56 es el mismo ancho que usa el oráculo de Uniswap v3 y
        // le sobra: |tick| <= 887272 (MAX_TICK) por los 2^32 s que representa
        // el reloj de abajo da 3,8e15, frente a los 3,6e16 que caben en int56.
        // Ojo: esa cota no describe una vida útil de 136 años, sino el punto en
        // que el reloj uint32 ya rompió la señal (ver justo debajo).
        int56 tickCumulative;
        int56 checkpointTickCumulative;
        int24 lastTwapTick;
        // Relojes truncados a uint32, heredado de lastUpdatedAt. Pasado 2106
        // uint32(block.timestamp) envuelve mientras block.timestamp no: la resta
        // salta a ~4,3e9 s, que cabe de sobra en int56 pero convierte la ventana
        // y el TWAP en ruido. Es el horizonte real del contrato, no del acumulador.
        uint32 lastObservedAt;
        uint32 lastUpdatedAt;
        uint64 shortEwma;
        uint64 longEwma;
        uint24 fee;
        bool initialized;
        // Falso hasta que cierra la PRIMERA ventana. Distingue "el pool ya vio un
        // swap" de "ya existe un TWAP anterior contra el que medir movimiento".
        bool hasTwapReference;
    }

    mapping(bytes32 poolId => PoolState) public poolState;

    constructor(IPoolManager manager) BaseHook(manager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bytes32 id = keccak256(abi.encode(key));
        (, int24 tick,,) = poolManager.getSlot0(PoolId.wrap(id));
        PoolState storage state = poolState[id];
        uint24 fee = state.fee;

        if (!state.initialized) {
            // Primer swap del pool: sólo abre el acumulador y arranca el reloj.
            // Deliberadamente NO se siembra `lastTwapTick` con el tick actual:
            // ese valor es un punto instantáneo que el primer swapper elige, y
            // usarlo como referencia dejaba que un LP inicializara el pool en un
            // tick extremo y cobrara comisiones infladas sin volatilidad real.
            // El movimiento se mide entre TWAPs de ventanas consecutivas, y aquí
            // todavía no ha cerrado ninguna.
            //
            // Esto ENCARECE ese abuso, no lo elimina: quien sostenga el tick
            // extremo aunque sea un bloque dentro de la primera ventana vuelve a
            // provocar la excursión entera (medido: pico 5500 con 12 s). Lo que
            // se cierra es el caso gratis, el de duración cero. El residuo no es
            // del TWAP sino de la fórmula, que satura a CAP_FEE con ~964 ticks de
            // movimiento y no distingue eso de 887.272.
            state.initialized = true;
            state.lastObservedAt = uint32(block.timestamp);
            state.lastUpdatedAt = uint32(block.timestamp);
            fee = BASE_FEE;
            state.fee = fee;
        } else {
            // Acumulación al estilo del oráculo de Uniswap v3: el tick que se
            // lee aquí es el que dejó el swap anterior, así que ha regido
            // durante todo el hueco hasta ahora y se pondera por ese hueco.
            // Dos swaps en el mismo bloque dan hueco cero: ahí muere la
            // manipulación intra-bloque, porque su tick pesa literalmente nada.
            uint256 sinceObservation = block.timestamp - state.lastObservedAt;
            if (sinceObservation > 0) {
                state.tickCumulative += int56(tick) * int56(uint56(sinceObservation));
                state.lastObservedAt = uint32(block.timestamp);
            }

            if (block.timestamp >= uint256(state.lastUpdatedAt) + UPDATE_INTERVAL) {
                // elapsed >= UPDATE_INTERVAL por la condición de arriba, así que
                // la división nunca ve un divisor cero.
                int56 elapsed = int56(uint56(block.timestamp - state.lastUpdatedAt));
                int56 windowCumulative = state.tickCumulative - state.checkpointTickCumulative;
                int56 twap = windowCumulative / elapsed;
                // La división con signo trunca hacia cero, y eso le da al escalón
                // que rodea al cero el doble de ancho que a todos los demás.
                // Redondear hacia abajo cuantiza uniforme, que es lo que hace
                // OracleLibrary.consult de Uniswap. Se paga con la simetría de
                // reflexión: trunc(-x) = -trunc(x), floor no (+703000/301 da 2335
                // y -703000/301 da -2336). Se prefiere la cuantización uniforme.
                if (windowCumulative < 0 && windowCumulative % elapsed != 0) twap -= 1;
                int24 twapTick = int24(twap);

                // La primera ventana que cierra no mide movimiento: sólo fija la
                // referencia. Medir "movimiento" exige dos TWAPs consecutivos, y
                // aquí sólo hay uno. Alimentar el EWMA contra una referencia
                // inventada era el sesgo de la semilla: como shortEwma/longEwma
                // son estado persistente, una referencia extrema abría una
                // excursión de tarifa que duraba ~10 ventanas. El coste de
                // saltarse esta ventana es que el hook tarda un UPDATE_INTERVAL
                // más en reaccionar tras crear el pool.
                if (state.hasTwapReference) {
                    uint24 absoluteMove = twapTick >= state.lastTwapTick
                        ? uint24(twapTick - state.lastTwapTick)
                        : uint24(state.lastTwapTick - twapTick);

                    state.shortEwma = _ewma(state.shortEwma, absoluteMove, SHORT_ALPHA_BPS);
                    state.longEwma = _ewma(state.longEwma, absoluteMove, LONG_ALPHA_BPS);

                    uint64 signal = state.shortEwma > state.longEwma
                        ? state.shortEwma - state.longEwma
                        : 0;
                    uint256 target = BASE_FEE;
                    if (signal > VOL_THRESHOLD) target += uint256(signal - VOL_THRESHOLD) * FEE_PER_TICK;
                    if (target > CAP_FEE) target = CAP_FEE;

                    fee = _stepToward(fee, uint24(target));
                    state.fee = fee;
                } else {
                    state.hasTwapReference = true;
                }

                state.lastTwapTick = twapTick;
                state.checkpointTickCumulative = state.tickCumulative;
                state.lastUpdatedAt = uint32(block.timestamp);
            }
        }

        // ZERO_DELTA: el hook no modifica el accounting de los swaps.
        // El flag indica a V4 que este pool de fee dinámica puede usar este fee.
        return (this.beforeSwap.selector, BeforeSwapDelta.wrap(0), LPFeeLibrary.OVERRIDE_FEE_FLAG | fee);
    }

    function _ewma(uint64 previous, uint24 sample, uint64 alphaBps) private pure returns (uint64) {
        return uint64((uint256(previous) * (10_000 - alphaBps) + uint256(sample) * alphaBps) / 10_000);
    }

    function _stepToward(uint24 current, uint24 target) private pure returns (uint24) {
        if (target > current + MAX_FEE_STEP) return current + MAX_FEE_STEP;
        if (target + MAX_FEE_STEP < current) return current - MAX_FEE_STEP;
        if (target < FLOOR_FEE) return FLOOR_FEE;
        if (target > CAP_FEE) return CAP_FEE;
        return target;
    }
}
