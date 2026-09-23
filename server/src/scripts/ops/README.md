# Scripts de operación

Herramientas de intervención manual sobre coberturas vivas. Nacieron durante el
incidente del 2026-09-22/23 y estaban sólo dentro del contenedor, en `/app`;
**cuatro de los cinco los borró un despliegue** antes de que llegaran aquí.

Se ejecutan desde el contenedor de producción:

```bash
docker exec -w /app testbot-server-prod node src/scripts/ops/<script>.js <args>
```

## Qué hace cada uno

| script | mueve capital | para qué |
|---|---|---|
| `margin-probe.js` | **no** | estado del margen aislado: tamaño, liquidación, distancia, saldo libre |
| `margin-topup.js` | **sí** | depositar margen aislado cuando la recarga automática no puede actuar |
| `recreate-step1.js` | **sí** | solicitar la desactivación de una protección (cierra el hedge) |
| `recreate-step1b.js` | **sí** | desvincular la protección inactiva y recrearla leyendo la config del orquestador |
| `reanclar.js` | **sí** | forzar un rebalanceo para re-anclar `range_exit_v1` al delta actual |

Todos validan sus argumentos y **fallan sin tocar nada** si se invocan mal.

## Reglas

**Ninguno se ejecuta sin que el usuario lo pida.** Mueven capital real en
cuentas de Hyperliquid.

**Empezar siempre por `margin-probe.js`.** Es de sólo lectura y da los números
con los que decidir. Los umbrales de riesgo reales viven en
`settings.delta_neutral_risk_controls` (hoy: pausa 5%, recarga 7%), **no** en
los defaults del código, que son 7% y 10% y llevan a conclusiones equivocadas.

**`recreate-step1` y `recreate-step1b` van juntos y en ese orden**, esperando
entre medias a que el short llegue a cero. La desactivación de una protección
`delta_neutral` es asíncrona: marca `deactivating` y el lazo desarma la
posición en los ticks siguientes.

Recrear es la única vía de cambiar el apalancamiento: `updateConfig` se niega a
propagarlo en caliente a propósito —*"no se puede cambiar bajo una cobertura
viva y se informa como pendiente en vez de aplicarse a medias"*— así que editar
el orquestador sólo afecta a la **próxima** protección que se cree.
