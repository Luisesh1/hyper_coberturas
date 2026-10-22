# Alertas · UX móvil

Fecha: 2026-10-22
Maquetas aprobadas por el usuario (lienzo de artifacts, tres pantallas):
https://claude.ai/artifact/7grM3AN52XC4tFL8KUQD4x

## Intención

En el teléfono, la página de Alertas (`/alertas`) es incómoda. Hay elementos
que se salen o se cortan: el selector de operador sobresale por la derecha,
la ✕ de borrar regla queda fuera de la tarjeta y la etiqueta de Telegram
aparece truncada. Además, cada regla ocupa varias pantallas y la lista de
alertas se usa mal. El usuario pidió rehacer **toda la página en móvil**:
lista, cabecera del editor, reglas y guardado. En cuanto a las reglas,
eligió que cada una se muestre como una **tarjeta‑resumen que se edita en
una hoja a pantalla completa**.

Éxito: en un teléfono de 360 px de ancho se puede revisar una alerta de un
vistazo, activarla, pausarla o probarla desde la lista, y editar una regla
sin scroll horizontal ni controles cortados.

## Alcance y principio

- **Solo cambia la vista móvil**, cuando `useMediaQuery(MOBILE_QUERY)` es
  verdadero. **Escritorio no cambia.**
- Los datos, la validación, el guardado y la API no cambian. Esto es solo
  presentación. La única lógica nueva es la acción rápida desde la lista
  (activar, pausar o probar sin entrar al editor), que usa los mismos
  `alertsApi.update` y `alertsApi.test` que ya existen.

## Pantalla 1: lista (móvil)

- **Cabecera:** título «Alertas» y la línea «N en total · M activas».
- **Filtros de dirección:** chips de 36 px de alto o más, con su contador:
  «Todas 4», «▲ Alcistas 3», etc. Si no caben, la fila se desplaza en
  horizontal **dentro de sí misma**; la página nunca.
- **Una tarjeta por alerta.** En ella:
  - el nombre, en hasta dos líneas con corte limpio, sin truncar en una sola;
  - la meta: «N activos · N reglas · umbral X %»;
  - un **interruptor Activa/Pausada**, con zona táctil de 44 px;
  - chips de dirección, temporalidad base (la más baja de las reglas) y
    «Usada por N bots» / «Sin bots»;
  - un botón **«Probar»**;
  - la línea «Último disparo: …», que muestra el `lastTriggeredAt` más
    reciente de cualquier activo, o «Nunca» si no hay, o «Pausada» si la
    alerta está inactiva.
- **Tocar la tarjeta** (fuera del interruptor y de «Probar») abre el editor.
- **Interruptor:**
  - Llama a `alertsApi.update(id, payload)` con la alerta completa
    convertida a payload y `isActive` invertido.
  - El cambio se aplica al momento; si la llamada falla, se revierte y sale
    un aviso.
  - Si la alerta la usan bots y pasa a Pausada, no se pide confirmación:
    pausar no cambia la dirección. *Decisión de Claude.*
- **«Probar»** desde la lista:
  - Llama a `alertsApi.test(id, { dryRun: true })`. Nunca envía Telegram.
  - Muestra el resultado en una **hoja inferior** (`BottomSheet`): por activo,
    la puntuación frente al umbral, si dispararía y las reglas ✅/❌. Es el
    mismo contenido que el bloque «Resultado del test» del editor; hay que
    reutilizar ese render y no duplicarlo.
- **Botón flotante «Nueva alerta»:** abajo a la derecha, de 56 px, sin tapar
  la última tarjeta (la lista lleva padding inferior).

## Pantalla 2: editor (móvil)

- **Cabecera fija:**
  - un botón «←» que vuelve a la lista con el comportamiento actual de
    `mobileView`;
  - el nombre de la alerta (o «Nueva alerta»), en una línea con elipsis;
  - debajo, «● Cambios sin guardar» cuando `effectiveDirty`;
  - un menú «⋯» (hoja inferior) con: **Modo JSON / Visual**, **Copiar
    config** y **Eliminar alerta** (esta última solo en una alerta
    guardada, y con la confirmación actual).
- **Plantillas:** solo en una alerta nueva sin tocar, como hoy, y en una
  columna.
- **Tarjeta General**, compacta:
  - el interruptor Activa en la cabecera de la tarjeta;
  - Nombre;
  - **Umbral** con botones − / + (pasos de 5, entre 0 y 100) y el valor en
    medio;
  - **Cooldown** como selector de los `COOLDOWN_PRESETS`;
  - **Dirección** con 3 botones en rejilla (`DirectionSelector` en
    `mobile`);
  - un enlace **«Más opciones · {datasource} · Telegram {sí/no} ›»** que
    despliega en la propia página: Datasource, Notificación Telegram, la
    vista previa de Telegram y «Usada por N bots».
- **Activos:** chips con ✕ (44 px de zona táctil) y el botón «+ Añadir»,
  que abre el `AssetPickerModal` actual.
- **Reglas:**
  - Título «Reglas (N)» y, debajo, «dispara con ≥ X % del peso».
  - Cada regla es una **tarjeta‑resumen**, un botón que ocupa todo el ancho:
    - el número de la regla;
    - el resumen legible de las condiciones, con indicador y temporalidad,
      unidas por «Y»/«O» (usar `summarizeRule`/`summarizeCondition` de
      `lib/labels.js`, en dos líneas si hace falta);
    - la línea ««etiqueta» · peso N».
  - **Tocarla abre la Pantalla 3.**
  - «+ Añadir regla» crea una regla vacía y abre su hoja directamente.
- **Resultado del test** (si existe): igual que ahora, a una columna.
- **Barra inferior fija:** «Probar», que abre el resultado en la hoja de la
  Pantalla 1, y **«Guardar cambios»** (2/3 del ancho), deshabilitado por la
  validación actual. El contenido lleva padding inferior para que la barra
  no tape nada.

## Pantalla 3: editar regla (móvil, a pantalla completa)

- Se abre como **capa a pantalla completa** sobre el editor, con la misma
  pila de z-index que `BottomSheet`. **Edita una copia de la regla**
  (borrador):
  - «Aplicar regla» guarda la copia en `form.rules[i]`;
  - la «✕» de la cabecera descarta los cambios;
  - en una regla recién añadida, descartar la elimina.
- **Cabecera:** ✕, «Regla N» y una papelera que elimina la regla y cierra.
  No se puede eliminar la última regla si la validación exige al menos una:
  se mantiene la regla actual.
- **Campos, todos a una columna:**
  - Etiqueta de Telegram, a todo el ancho.
  - Peso con − / + (paso 0,5, mínimo 0).
  - Por condición, una tarjeta «Condición N» con:
    - **Indicador**, como selector a todo el ancho;
    - **Temporalidad**, como grupo de botones: 5m, 15m, 1h, 4h, 1D y «…»
      (este último despliega 1m, 1w y 1M);
    - **Serie**, como selector a todo el ancho;
    - **Condición** (operador), como selector a todo el ancho;
    - el operando que haya (constante, rango, serie u offset), con sus
      campos a todo el ancho;
    - **Parámetros del indicador, plegados por defecto**: un botón con el
      resumen de los parámetros (por ejemplo «BB 20/2 · KC 20/1,5 · TR sí ·
      banda 100/2σ») que al tocarlo despliega los campos actuales en 2
      columnas;
    - un enlace «Quitar condición» cuando hay más de una.
  - Botones «+ Condición «Y»» y «+ Condición «O»».
- **Barra inferior fija:** «Aplicar regla».
- **Reutilización:** la edición de condiciones (indicadores, roles,
  operadores, operandos y parámetros) es lógica de `AlertRuleRow`. La hoja
  debe reutilizar esos subcomponentes y helpers, con un modo de presentación
  móvil, y **no copiarlos**. Si hace falta, se extraen de `AlertRuleRow.jsx`
  a un módulo compartido.

## Restricciones

- Zonas táctiles de 44 px o más. Sin scroll horizontal de la página a 360 px
  ni a 390 px. Textos con contraste suficiente. Botones reales (`<button>`),
  y nada de `role` sobre `div`.
- Nada cambia en escritorio. Los tests existentes de `AlertsPage*.test.jsx`
  siguen pasando.
- El botón «Logs» de desarrollo ya sube con `tv-mobile-chrome`. Eso se
  mantiene en las tres pantallas móviles que tienen barra inferior.
- E2E con Playwright a 360×740 contra Docker en `:5174`. Si Docker es de otra
  sesión, contra el Vite del worktree con la API simulada.

## Fuera de alcance

- Cambios en el servidor o la API.
- Rediseño de escritorio.
- Nuevas capacidades de alerta.
