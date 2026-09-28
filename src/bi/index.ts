import type { RequestListener, Server } from 'node:http';

/**
 * Interruptor del BI (QEBI) dentro de qeb-Back. Es lo ÚNICO que server.ts importa del BI.
 *
 * - Si BI_ENABLED !== 'true' (p. ej. la app de producción, que no define variables BI_*):
 *   withBi(app) devuelve el MISMO `app` y attachBiRealtime no hace nada. No se carga ningún
 *   otro módulo del BI (ni express/cors/mysql2/ws desde aquí), no hay rutas /bi, ni pools,
 *   ni poller, ni listener de 'upgrade'. /bi/* sigue dando el 404 de qeb-Back.
 * - Si BI_ENABLED === 'true' pero falta configuración, se niega a montar, lo registra y
 *   qeb-Back sigue igual. Nunca lanza.
 * - Si todo está bien, las peticiones a /bi se despachan a la app del BI ANTES de Express de
 *   qeb-Back (así su CORS, helmet, timeouts y 404 no se mezclan con los del BI).
 */

let origenPermitido: ((origin: string | undefined) => boolean) | null = null;

const esRutaBi = (url = '') => url === '/bi' || url.startsWith('/bi/') || url.startsWith('/bi?');

export function withBi(app: RequestListener): RequestListener {
  if (process.env.BI_ENABLED !== 'true') {
    // Sin la variable (p. ej. producción) no se imprime nada; con un valor mal escrito, sí.
    if (process.env.BI_ENABLED !== undefined) console.warn(`[BI] BI_ENABLED=${JSON.stringify(process.env.BI_ENABLED)} (no es 'true'): /bi apagado`);
    return app;
  }
  try {
    const { loadBiConfig, setBiConfig } = require('./config') as typeof import('./config');
    const r = loadBiConfig();
    if (!r.ok) {
      console.error(`[BI] BI_ENABLED=true pero faltan variables: ${r.missing.join(', ')}. /bi NO se monta.`);
      return app;
    }
    // Los tokens del BI y de qeb-Back no deben poder cruzarse (los ids de usuario no cruzan
    // entre bases): si el secreto coincide con uno de qeb-Back, no se monta.
    if ([process.env.JWT_SECRET, process.env.JWT_REFRESH_SECRET].includes(r.cfg.jwtSecret)) {
      console.error('[BI] BI_JWT_SECRET es igual a un secreto de qeb-Back. /bi NO se monta.');
      return app;
    }
    setBiConfig(r.cfg);
    const bi = require('./app') as typeof import('./app');
    const biApp = bi.crearBiApp();
    origenPermitido = bi.origenPermitido;
    console.log('[BI] montado en /bi');
    return (req, res) => (esRutaBi(req.url) ? biApp(req, res) : app(req, res));
  } catch (e) {
    console.error('[BI] error al montar; BI deshabilitado:', (e as Error).message);
    return app;
  }
}

/** WebSocket del historial en vivo (/bi/ws/historial). No hace nada si el BI no se montó. */
export function attachBiRealtime(server: Server): void {
  if (!origenPermitido) return;
  try {
    const { attachRealtime } = require('./realtime') as typeof import('./realtime');
    attachRealtime(server, origenPermitido);
  } catch (e) {
    console.error('[BI] tiempo real no iniciado:', (e as Error).message);
  }
}
