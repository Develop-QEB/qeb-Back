import type { RequestListener } from 'node:http';

/**
 * Interruptor del MCP de QEB dentro de qeb-Back. Es lo ÚNICO que server.ts importa del MCP.
 * Mismo patrón que el BI (src/bi/index.ts).
 *
 * - Si MCP_ENABLED !== 'true' (p. ej. producción, que no define variables MCP_*):
 *   withMcp(app) devuelve el MISMO `app`. No se carga ningún otro módulo del MCP y
 *   /mcp/* sigue dando el 404 de qeb-Back.
 * - Si MCP_ENABLED === 'true' pero la configuración no es válida, se niega a montar,
 *   lo registra y qeb-Back sigue igual. Nunca lanza.
 * - Si todo está bien, las peticiones a /mcp/* se atienden ANTES de Express de qeb-Back
 *   (sin su CORS, helmet, morgan ni el límite de body de 200mb). El token viaja en la
 *   URL, por eso es importante que morgan no la vea.
 */

const esRutaMcp = (url = '') => url === '/mcp' || url.startsWith('/mcp/') || url.startsWith('/mcp?');

export function withMcp(app: RequestListener): RequestListener {
  if (process.env.MCP_ENABLED !== 'true') {
    if (process.env.MCP_ENABLED !== undefined) {
      console.warn(`[MCP] MCP_ENABLED=${JSON.stringify(process.env.MCP_ENABLED)} (no es 'true'): /mcp apagado`);
    }
    return app;
  }
  try {
    const { cargarAccesos } = require('./auth') as typeof import('./auth');
    const r = cargarAccesos();
    if (!r.ok) {
      console.error(`[MCP] MCP_ENABLED=true pero la configuración no es válida: ${r.error}. /mcp NO se monta.`);
      return app;
    }
    // Acceso por OAuth (MCP_OAUTH_SECRET): URL única /mcp, cada quien entra con su cuenta.
    const { cargarOAuth, esRutaOAuth } = require('./oauth') as typeof import('./oauth');
    const o = cargarOAuth();
    if (!o.ok) {
      console.error(`[MCP] ${o.error}. /mcp NO se monta.`);
      return app;
    }
    if (!o.activo && r.total === 0) {
      console.error('[MCP] MCP_ENABLED=true pero no hay forma de entrar: define MCP_OAUTH_SECRET (OAuth) o MCP_PILOT_TOKENS. /mcp NO se monta.');
      return app;
    }
    const { manejarMcp } = require('./server') as typeof import('./server');
    console.log(`[MCP] montado en /mcp (OAuth: ${o.activo ? 'sí' : 'no'}, accesos de piloto: ${r.total})`);
    const esDelMcp = (url = '') => esRutaMcp(url) || (o.activo && esRutaOAuth(url.split('?')[0]));
    return (req, res) => (esDelMcp(req.url) ? manejarMcp(req, res) : app(req, res));
  } catch (e) {
    console.error('[MCP] error al montar; MCP deshabilitado:', (e as Error).message);
    return app;
  }
}
