import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { getEventosDesdeId, getMaxId } from './services/historial.service';

/**
 * Tiempo real del historial de acciones.
 *
 * La BD es SOLO LECTURA (no podemos poner triggers/CDC), así que hacemos un
 * polling ligero: cada POLL_MS buscamos filas de `historial` con id mayor al
 * último visto y empujamos SOLO las nuevas a los clientes por WebSocket.
 *
 * Comparte el http.Server de qeb-Back con socket.io, así que el WebSocketServer va en
 * modo noServer: nuestro listener de 'upgrade' SOLO atiende BI_WS_PATH y a todo lo
 * demás le hace `return` sin tocar el socket (lo maneja engine.io). Con {server, path},
 * ws respondería 400 a los upgrades de /socket.io/ y rompería el tiempo real de QEB.
 */
export const BI_WS_PATH = '/bi/ws/historial';
const POLL_MS = 5000;
/** Ping periódico: mantiene viva la conexión a través del proxy de App Platform y limpia clientes muertos. */
const PING_MS = 30000;

export function attachRealtime(server: Server, origenPermitido: (origin: string | undefined) => boolean): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const vivos = new WeakMap<WebSocket, boolean>();
  wss.on('error', (e) => console.error('[BI-WS] error del servidor:', e.message));

  server.on('upgrade', (req, socket, head) => {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return;
    }
    if (path !== BI_WS_PATH) return; // /socket.io/ y cualquier otro: NO tocar

    socket.on('error', (e) => console.error('[BI-WS] socket:', e.message));
    if (!origenPermitido(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    // Síncrono: engine.io cierra al segundo los upgrades ajenos que nadie contestó.
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  let lastId = 0;
  let iniciado = false;
  let enCurso = false;
  let timer: NodeJS.Timeout | null = null;

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  const tick = async () => {
    if (enCurso) return;
    enCurso = true;
    try {
      if (!iniciado) {
        lastId = await getMaxId(); // solo empujamos lo que pase DESPUÉS de conectarse
        iniciado = true;
        return;
      }
      const nuevos = await getEventosDesdeId(lastId);
      if (nuevos.length) {
        lastId = Math.max(lastId, ...nuevos.map((e) => e.id));
        broadcast({ tipo: 'eventos', eventos: nuevos });
      }
    } catch {
      /* silencioso; el siguiente tick reintenta */
    } finally {
      enCurso = false;
    }
  };

  // El poller solo corre mientras haya al menos un cliente conectado.
  const arrancar = () => {
    if (timer) return;
    iniciado = false;
    void tick();
    timer = setInterval(tick, POLL_MS);
    timer.unref();
  };
  const detener = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  wss.on('connection', (ws) => {
    vivos.set(ws, true);
    ws.on('pong', () => vivos.set(ws, true));
    // Sin este listener, un frame inválido de un cliente lanzaría una excepción no capturada
    // y el uncaughtException de qeb-Back tumbaría todo el proceso.
    ws.on('error', (e) => console.error('[BI-WS] error de cliente:', e.message));
    ws.on('close', () => setImmediate(() => { if (wss.clients.size === 0) detener(); }));
    ws.send(JSON.stringify({ tipo: 'conectado', ts: new Date().toISOString() }));
    arrancar();
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!vivos.get(ws)) { ws.terminate(); continue; }
      vivos.set(ws, false);
      ws.ping();
    }
  }, PING_MS);
  ping.unref();

  console.log(`[BI] WebSocket en ${BI_WS_PATH} (poll cada ${POLL_MS / 1000}s mientras haya clientes)`);
}
