# Alertas · UX móvil — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rehacer la página `/alertas` en móvil (lista, editor y regla en una hoja a pantalla completa) siguiendo las maquetas aprobadas, sin cambiar escritorio.

**Architecture:** componentes móviles nuevos en `client/src/pages/Alerts/mobile/`, montados por `AlertsPage.jsx` solo cuando `isMobile`. La lógica de formulario, validación y guardado sigue en `AlertsPage.jsx` y se pasa por props. La edición de condiciones se reutiliza desde `components/AlertRuleRow.jsx`, extrayendo subcomponentes si hace falta.

**Tech Stack:** React 18, CSS Modules, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-alerts-mobile-ux-design.md`

## Global Constraints

- Solo móvil (`useMediaQuery(MOBILE_QUERY)`). El DOM de escritorio no cambia y los tests existentes `client/src/pages/Alerts/*.test.jsx` pasan sin tocarlos.
- Sin cambios en el servidor ni en la API. Se usan `alertsApi.update/test/create/remove` tal como están.
- Zonas táctiles de 44 px o más, y ningún desbordamiento horizontal de la página a 360 y 390 px.
- Sin lógica de condiciones duplicada: la hoja de regla reutiliza la de `AlertRuleRow`.
- Textos en español, con el mismo tono que la página actual.

## Review Focus

1. **Alerta muy larga (22 activos, 5 reglas con 3 condiciones):** las tarjetas‑resumen deben envolver el texto sin desbordar. Lo cubre la E2E de la Task 4.
2. **Fallo de red al alternar Activa desde la lista:** el interruptor vuelve a su estado y sale el aviso. Lo cubre un test de la Task 1.
3. **Cerrar la hoja de regla con ✕ tras editar:** los cambios no llegan a `form`. Si la regla era nueva, desaparece. Lo cubre un test de la Task 3.
4. **Cambios sin guardar y «←»:** se conserva el comportamiento actual (sea el que sea hoy) y el aviso «● Cambios sin guardar» es visible. Lo cubre un test de la Task 2.
5. **Escritorio intacto.** Lo cubren los tests existentes y un test que comprueba que sin `isMobile` no se monta ningún componente de `mobile/` (Task 2).

---

### Task 1: Lista móvil con acciones rápidas

**Files:**
- Create: `client/src/pages/Alerts/mobile/MobileAlertList.jsx` + `.module.css` + `.test.jsx`
- Create: `client/src/pages/Alerts/components/TestResultView.jsx`, extraído del bloque «Resultado del test» de `AlertsPage.jsx`, que pasa a usarlo sin cambiar su DOM en escritorio.
- Create: `client/src/pages/Alerts/lib/alertView.js` + test. Exporta:
  - `alertToPayload(alert)`, que reutiliza la lógica de `formToPayload` (moverla aquí desde `AlertsPage.jsx` y exportarla);
  - `baseTimeframe(rules)`, la temporalidad más baja de las condiciones y de los operandos `series`;
  - `lastTriggeredLabel(alert, now)`, que devuelve «Pausada», «Nunca» o la fecha y hora relativa: «hoy 12:00», «ayer 18:15» o «dd/mm hh:mm».
- Modify: `AlertsPage.jsx`, que en móvil con `mobileView === 'list'` renderiza `MobileAlertList`.

**Interfaces:**
- Produce `MobileAlertList({ alerts, botUsage, directionFilter, onDirectionFilter, onOpen(alert), onNew(), onToggleActive(alert) -> Promise, onTest(alert) -> Promise<testData> })`.
- La página implementa `onToggleActive`:
  - actualización optimista de `alerts`;
  - `alertsApi.update(id, { ...alertToPayload(a), isActive: !a.isActive })`;
  - si falla, revierte y llama a `addNotification('error', …)`.
- La página implementa `onTest`, que llama a `alertsApi.test(id, { dryRun: true })`. La hoja muestra el resultado con `<TestResultView result={data} />`.

- [ ] Tests primero:
  - la tarjeta muestra nombre, meta, chips y «Último disparo»;
  - el interruptor llama a `onToggleActive` y, si la promesa se rechaza, el interruptor vuelve a su estado;
  - «Probar» abre la hoja con «Puntuación»;
  - tocar la tarjeta llama a `onOpen`;
  - los filtros muestran contadores;
  - tests de `alertView` para `baseTimeframe` y `lastTriggeredLabel` (hoy, ayer, otra fecha, nunca, pausada).
- [ ] Implementar.
- [ ] `cd client && npx vitest run src/pages/Alerts`: debe pasar.
- [ ] Commit `feat(alerts): mobile list with quick toggle and test`.

### Task 2: Editor móvil: cabecera, General, Activos, reglas como resumen y barra fija

**Files:**
- Create: `client/src/pages/Alerts/mobile/MobileAlertEditor.jsx` + `.module.css` + `.test.jsx`
- Create: `client/src/pages/Alerts/mobile/RuleSummaryCard.jsx`, que usa `summarizeCondition` de `lib/labels.js`.
- Modify: `AlertsPage.jsx`, que en móvil con `mobileView === 'editor'` renderiza `MobileAlertEditor` y le pasa por props el estado y los handlers actuales: `form`, `updateField`, `addRule`, `removeRule`, `updateRule`, assets, `save`, `remove`, `testNow`, `testResult`, el modo raw, `effectiveDirty`, `validationError`, `usedByBots`, `telegramPreview`, presets y el selector de activos.

**Interfaces:**
- Produce `MobileAlertEditor({ … props de la página …, onOpenRule(index), onBack })`.
- `RuleSummaryCard({ index, rule, onOpen })`.

- [ ] Tests primero:
  - el umbral sube y baja de 5 en 5, dentro de 0–100;
  - «Más opciones» despliega datasource, Telegram y la vista previa;
  - el menú «⋯» ofrece Modo JSON, Copiar config y Eliminar (este solo con `selectedId`);
  - cada regla se muestra como tarjeta con su resumen y «peso N», y al tocarla llama a `onOpenRule(i)`;
  - con `effectiveDirty` se ve el texto «Cambios sin guardar»;
  - «Guardar cambios» queda deshabilitado con un error de validación;
  - sin `isMobile` no se monta ningún componente de `mobile/` (test en `AlertsPage.test.jsx` con `matchMedia` en falso).
- [ ] Implementar.
- [ ] Ejecutar los tests de Alertas: deben pasar.
- [ ] Commit `feat(alerts): mobile editor with rule summary cards and sticky actions`.

### Task 3: Hoja a pantalla completa para editar una regla

**Files:**
- Create: `client/src/pages/Alerts/mobile/MobileRuleSheet.jsx` + `.module.css` + `.test.jsx`
- Modify: `components/AlertRuleRow.jsx`. Extraer, sin cambiar el comportamiento de escritorio, los subcomponentes de condición: indicador, parámetros, serie, operador y operando. Pueden ir en `components/ConditionFields.jsx` o exportarse desde el mismo archivo, y deben aceptar `layout: 'mobile'`.
- Modify: `MobileAlertEditor` y la página, para abrir la hoja con el índice de la regla.

**Interfaces:**
- `MobileRuleSheet({ open, index, rule, isNew, canDelete, onApply(rule), onDiscard(), onDelete() })`.
- La hoja edita un borrador local creado con `structuredClone(rule)` al abrirse.
- La temporalidad se muestra como grupo de botones (5m, 15m, 1h, 4h, 1D y «…» con 1m, 1w y 1M). Los parámetros van plegados, con un resumen de valores formateado desde `indicatorParams`, separados por «·» con los nombres cortos de la definición del indicador.

- [ ] Tests primero:
  - «Aplicar regla» llama a `onApply` con los cambios;
  - la ✕ llama a `onDiscard` y la página no aplica los cambios;
  - en una regla nueva, descartar la quita de `form.rules`;
  - la papelera llama a `onDelete`; si `canDelete` es falso, está deshabilitada;
  - los parámetros empiezan plegados y muestran el resumen;
  - «…» muestra 1m, 1w y 1M;
  - «+ Condición «O»» añade una condición con el joiner `or`;
  - los tests existentes de `AlertRuleRow` siguen pasando.
- [ ] Implementar.
- [ ] `cd client && npm test`: debe pasar.
- [ ] Commit `feat(alerts): full-screen mobile rule editor`.

### Task 4: E2E móvil y verificación

**Files:** Create `e2e/alerts-mobile.spec.js`, con el patrón de `e2e/alerts-direction.spec.js` y la API simulada con `page.route`.

- [ ] Escenario a 360×740:
  - en la lista, comprobar que no hay scroll horizontal y alternar el interruptor (PUT con `isActive` invertido);
  - con «Probar», que aparezca la hoja con «Puntuación»;
  - abrir una alerta larga (22 activos, 5 reglas de 3 condiciones) y comprobar que sigue sin scroll horizontal;
  - abrir la regla 1, cambiar la temporalidad a 4h y aplicar; la tarjeta debe mostrar «4h»;
  - guardar, y el PUT debe llevar el cambio.
- [ ] Escenario de escritorio a 1440: el editor de escritorio sigue igual (sin componentes móviles).
- [ ] Ejecutar contra el Vite del worktree con la API simulada. Comprobar `cd client && npm test && npm run lint && npm run build`.
- [ ] Commit `test(alerts): mobile e2e`.
