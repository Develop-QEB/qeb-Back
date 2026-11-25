import type { IncomingMessage, ServerResponse } from 'node:http';
import { obtenerUsuario, resolverToken, type UsuarioMcp } from './auth';
import { herramientas } from './tools';
import { autenticarBearer, manejarOAuth, oauthActivo, pedirAutenticacion } from './oauth';

/**
 * Servidor MCP de QEB: transporte "Streamable HTTP" en modo sin estado.
 *
 * Implementado directo sobre http (sin el SDK oficial) para no sumar dependencias a
 * qeb-Back. Cubre lo que usan los conectores de Claude y ChatGPT para herramientas:
 * initialize, ping, tools/list y tools/call. Cada POST trae un mensaje JSON-RPC y se
 * responde con JSON; no hay sesiones ni stream SSE (GET responde 405, permitido por la
 * especificación).
 *
 * URL: POST /mcp/<token>. Un token desconocido responde 404, igual que una ruta inexistente.
 */

const VERSIONES = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const BODY_MAX = 256 * 1024;
const LIMITE_POR_MINUTO = Number(process.env.MCP_RATE_LIMIT_PER_MIN) || 30;

const INSTRUCCIONES =
  'Conector de QEB, plataforma de gestión de publicidad exterior (OOH). ' +
  'Todas las consultas se hacen con la identidad y los permisos del usuario conectado: ' +
  'solo verá lo que puede ver en QEB (mi_perfil dice quién es y qué alcance tiene). ' +
  'Si su visibilidad es total, "mis campañas" o "las que tengo" incluye las de todos: acláralo y ofrece filtrar por asesor o cliente. ' +
  'Los periodos se manejan en catorcenas (14 días, 26 por año); ' +
  'usa catorcena_actual para saber cuál está vigente. Responde en español.';

// ---------- límite de peticiones por token ----------

const ventanas = new Map<string, { n: number; hasta: number }>();

function excedeLimite(hash: string): boolean {
  const ahora = Date.now();
  if (ventanas.size > 1000) {
    for (const [k, v] of ventanas) if (v.hasta <= ahora) ventanas.delete(k);
  }
  const v = ventanas.get(hash);
  if (!v || v.hasta <= ahora) {
    ventanas.set(hash, { n: 1, hasta: ahora + 60_000 });
    return false;
  }
  v.n += 1;
  return v.n > LIMITE_POR_MINUTO;
}

// ---------- utilidades HTTP ----------

function responder(res: ServerResponse, status: number, cuerpo?: unknown, headers: Record<string, string> = {}): void {
  const texto = cuerpo === undefined ? '' : JSON.stringify(cuerpo);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...(texto ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(texto);
}

function leerBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > BODY_MAX) {
        reject(new Error('BODY_MAX'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- JSON-RPC ----------

type Id = string | number | null;
const ok = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fallo = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Atiende un mensaje. Devuelve la respuesta, o null si era una notificación. */
async function atender(msg: any, usuario: UsuarioMcp): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return fallo(null, -32600, 'Petición inválida');
  if (typeof msg.method !== 'string') return null; // respuesta del cliente: se ignora
  const esNotificacion = msg.id === undefined;
  const id: Id = esNotificacion ? null : msg.id;

  switch (msg.method) {
    case 'initialize': {
      const pedida = msg.params?.protocolVersion;
      return ok(id, {
        protocolVersion: VERSIONES.includes(pedida) ? pedida : VERSIONES[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'qeb', title: 'QEB', version: '0.1.0' },
        instructions: INSTRUCCIONES,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: herramientas.map(h => ({
          name: h.name,
          title: h.title,
          description: h.description,
          inputSchema: h.inputSchema,
          annotations: { title: h.title, readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const h = herramientas.find(x => x.name === msg.params?.name);
      if (!h) return fallo(id, -32602, `Herramienta desconocida: ${msg.params?.name}`);
      const t0 = Date.now();
      try {
        const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
        const datos = await h.ejecutar(args, usuario);
        console.log(`[MCP] usuario=${usuario.id} herramienta=${h.name} ok ${Date.now() - t0}ms`);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(datos) }] });
      } catch (e) {
        const mensaje = (e as Error).message || 'Error al consultar QEB';
        console.warn(`[MCP] usuario=${usuario.id} herramienta=${h.name} error ${Date.now() - t0}ms: ${mensaje}`);
        return ok(id, { content: [{ type: 'text', text: mensaje }], isError: true });
      }
    }
    default:
      return esNotificacion ? null : fallo(id, -32601, `Método no soportado: ${msg.method}`);
  }
}

// ---------- entrada ----------

export async function manejarMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const ruta = (req.url || '').split('?')[0];

    // Metadatos, registro, login y tokens de OAuth.
    if (await manejarOAuth(req, res, ruta)) return;

    // Dos formas de entrar:
    //  - /mcp con "Authorization: Bearer" (OAuth): cada quien con su cuenta de QEB.
    //  - /mcp/<token> (piloto): URL secreta ligada a un usuario en MCP_PILOT_TOKENS.
    let acceso: { hash: string; usuarioId: number } | null = null;
    if (ruta === '/mcp' || ruta === '/mcp/') {
      if (!oauthActivo()) return responder(res, 404, { error: 'No encontrado' });
      const b = await autenticarBearer(req);
      if (!b) return pedirAutenticacion(req, res);
      acceso = { hash: `oauth:${b.conexionId}`, usuarioId: b.usuarioId };
    } else {
      const m = /^\/mcp\/([A-Za-z0-9_-]+)\/?$/.exec(ruta);
      acceso = m ? resolverToken(m[1]) : null;
    }
    if (!acceso) return responder(res, 404, { error: 'No encontrado' });

    if (req.method !== 'POST') return responder(res, 405, { error: 'Método no permitido' }, { Allow: 'POST' });
    if (excedeLimite(acceso.hash)) {
      return responder(res, 429, { error: 'Demasiadas peticiones; intenta en un minuto' }, { 'Retry-After': '60' });
    }

    const usuario = await obtenerUsuario(acceso.usuarioId);
    if (!usuario) return responder(res, 404, { error: 'No encontrado' });

    let mensaje: unknown;
    try {
      mensaje = JSON.parse(await leerBody(req));
    } catch (e) {
      const grande = (e as Error).message === 'BODY_MAX';
      return responder(res, grande ? 413 : 400, fallo(null, -32700, grande ? 'Petición demasiado grande' : 'JSON inválido'));
    }

    if (Array.isArray(mensaje)) {
      if (mensaje.length === 0 || mensaje.length > 20) return responder(res, 400, fallo(null, -32600, 'Petición inválida'));
      const respuestas = (await Promise.all(mensaje.map(x => atender(x, usuario)))).filter(Boolean);
      return respuestas.length ? responder(res, 200, respuestas) : responder(res, 202);
    }
    const respuesta = await atender(mensaje, usuario);
    return respuesta ? responder(res, 200, respuesta) : responder(res, 202);
  } catch (e) {
    console.error('[MCP] error inesperado:', (e as Error).message);
    if (!res.headersSent) responder(res, 500, fallo(null, -32603, 'Error interno'));
    else res.end();
  }
}
