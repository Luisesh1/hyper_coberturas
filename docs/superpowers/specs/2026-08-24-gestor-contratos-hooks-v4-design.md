# Gestor de contratos y hooks V4

## Objetivo

Permitir que el propietario registre y versiona contratos de hook, prepare el
despliegue para firmarlo desde su wallet y habilite únicamente una versión cuyo
bytecode y permisos se hayan comprobado en cadena. El orquestador sólo podrá
usar esas versiones verificadas para crear una pool V4 nueva.

## Estados y seguridad

Cada versión es inmutable y tiene exactamente uno de dos estados:

- **En verificación:** nunca seleccionable por el wizard.
- **Verificada:** bytecode desplegado igual al artefacto registrado y permisos
  del hook compatibles con el perfil. Puede aparecer para la misma red.

Una verificación no despliega, no firma y no altera contratos. Es una acción
explícita posterior a pruebas/auditoría. El backend vuelve a leer el bytecode
por RPC y no confía en una dirección aportada por el navegador.

## Hook de tarifa dinámica

`Volatility Shield V1` será un hook V4 `beforeSwap` sin custom accounting ni
callbacks que devuelvan deltas. La política inicial usa únicamente información
on-chain de precio/tick, con tarifa entre 5 y 60 bps, base 30 bps, volatilidad
suavizada, histéresis y un cambio máximo de 5 bps cada cinco minutos. El
contrato no puede impedir retiros, quemas o cierres de LP.

No se usa volumen, profundidad, balance de inventario, datos externos u
oráculos en V1: son mejoras futuras que requieren un modelo de manipulación y
fallback específicos.

## Flujo de usuario

1. Registrar contrato y versión con código/artefacto reproducible.
2. Preparar una transacción de despliegue; la wallet del usuario firma y envía.
3. Guardar la dirección y el hash de la transacción por red.
4. Ejecutar pruebas/auditoría externas y elegir "Marcar verificado".
5. El backend confirma bytecode y permisos. Sólo entonces el wizard muestra la
   versión para esa red.
6. Elegirla crea una PoolKey V4 nueva con flag de fee dinámica, hook y tick
   spacing compatibles. Nunca se adjunta a una pool o posición existente.

## Límites de implementación

- Un hook V4 forma parte de la identidad de la pool; el selector debe explicar
  que es experimental y requiere pool/posición nuevas.
- El flujo no puede presentar una selección si las acciones de creación,
  aumento, rebalanceo, cobro y cierre no admiten expresamente el hook
  allowlisted.
- La integración no activa trading ni despliega nada por sí sola.
- Base Sepolia es el primer entorno de pruebas. No se habilita como preset
  predeterminado de capital real antes del canario y revisión de seguridad.

## Criterios de aceptación

- Registro, versiones, despliegues y estados quedan persistidos y aislados por
  usuario.
- Un hook no verificado o de otra red es rechazado en servidor aunque el
  navegador manipule el payload.
- El selector muestra sólo hooks verificados de la red seleccionada.
- Las pruebas cubren verificación de bytecode/permisos, rechazo y propagación
  al plan de creación.
- La suite completa, lint, build y controles de arquitectura pasan antes de la
  integración Git Flow.
