# Gestor de contratos y hooks V4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear un flujo verificable de contratos/hook V4 y hacer que el
orquestador use únicamente hooks dinámicos seguros y verificados.

**Architecture:** El registro mantiene metadatos y evidencia de despliegue,
pero el navegador conserva la firma. El wizard consulta únicamente el registro
verificado de la red elegida y el servidor valida de nuevo esa selección al
crear la intención. La creación V4 debe aceptar el PoolKey exacto de una pool
nueva y sus acciones posteriores sólo aceptan hooks allowlisted.

**Tech Stack:** React 18, Vite, Express, PostgreSQL, ethers v6, Uniswap V4.

**Spec:** `docs/superpowers/specs/2026-08-24-gestor-contratos-hooks-v4-design.md`

## Global Constraints

- No se despliega ni se envía una transacción sin firma de la wallet del usuario.
- Una posición V4 existente no puede adquirir un hook dinámico.
- V1 no usa custom accounting, callbacks returns-delta ni oráculos externos.
- Base Sepolia es el primer objetivo de verificación end-to-end.

---

### Task 1: Completar la consola del registro

**Files:**
- Modify: `client/src/pages/SmartContracts/SmartContractsPage.jsx`
- Modify: `client/src/pages/SmartContracts/SmartContractsPage.test.jsx`
- Modify: `client/src/App.jsx`

- [ ] Escribir pruebas de creación de contrato/versión y de que una acción de
  verificación sólo se ofrece para una versión desplegada.
- [ ] Implementar formularios de registro, versiones y despliegue firmado;
  mostrar red, dirección, hash del bytecode y estado.
- [ ] Ejecutar las pruebas de la página y el build del cliente.

### Task 2: Selector de hooks verificadas en el wizard

**Files:**
- Modify: `client/src/features/lp-wizard/useUnifiedLpFlow.js`
- Modify: `client/src/features/lp-wizard/UnifiedLpWizard.jsx`
- Modify: `client/src/features/lp-wizard/useUnifiedLpFlow.test.jsx`

- [ ] Escribir una prueba que cargue sólo hooks verificados de la red y que
  propague versión, dirección, fee dinámica y tick spacing al plan.
- [ ] Implementar carga, selector y aviso de que crea una pool nueva.
- [ ] Ejecutar pruebas del flujo del wizard.

### Task 3: Crear y gestionar una PoolKey V4 con hook allowlisted

**Files:**
- Modify: `server/src/services/smart-pool-creator.service.js`
- Modify: `server/src/services/uniswap/actions/prepare-v4.js`
- Modify: `server/src/services/uniswap/actions/helpers.js`
- Modify: `server/src/services/uniswap-claim-fees.service.js`
- Test: `server/test/*v4*hook*.test.js`

- [ ] Escribir pruebas de creación de pool nueva con hook, flag de fee dinámica
  y rechazo de hooks no verificados/diferentes al PoolKey.
- [ ] Implementar initialize + mint sobre PoolManager y permitir sólo el hook
  verificado en increase/rebalance/claim/close.
- [ ] Ejecutar pruebas unitarias e integración contra Base Sepolia cuando haya
  wallet/contrato de canario autorizados.

### Task 4: Volatility Shield V1 reproducible

**Files:**
- Create: `contracts/VolatilityShieldV1.sol`
- Create: `contracts/test/VolatilityShieldV1.t.sol`
- Create: `contracts/foundry.toml`
- Modify: `package.json`

- [ ] Confirmar API e imports de Uniswap V4 mediante la documentación y el
  paquete oficial actual.
- [ ] Escribir pruebas de límites, cadencia, histéresis, permisos beforeSwap y
  ausencia de custom deltas antes del contrato.
- [ ] Implementar contrato mínimo, artefacto reproducible y preparación de
  despliegue sin clave privada del servidor.
- [ ] Ejecutar fuzz/invariants y pruebas Base Sepolia.

### Task 5: Cobertura V2, presets y cierre Git Flow

**Files:**
- Review: migraciones, formularios y presets de `net_profit_v2`
- Modify: `~/ObsidianVault/proyectos/testbotCobertura.md`

- [ ] Ejecutar las suites completas de servidor y cliente, lint, build, checks
  de arquitectura/hotspots y `git diff --check`.
- [ ] Revisar los diffs y la seguridad de la ruta de firma antes de fusionar.
- [ ] Seguir el protocolo de ramas del repositorio: integrar desarrollo en main
  sólo con verificaciones verdes, y dejar que CI controle el despliegue.
