// Debe reflejar el defaults del backend (server/src/services/settings.service.js).
// Cuando el usuario nunca ha guardado nada, se muestra SQZMOM activo.

export function getDefaultChartIndicators() {
  return {
    version: 1,
    indicators: [
      {
        uid: 'sqzmom-default',
        type: 'sqzmom',
        params: { length: 20, mult: 2.0, lengthKC: 20, multKC: 1.5, useTrueRange: true },
        style: {},
        visible: true,
      },
    ],
  };
}
