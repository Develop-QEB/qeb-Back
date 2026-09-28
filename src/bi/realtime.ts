import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
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
/** Tope de conexiones simultáneas (comparten proceso con qeb-Back). */
const MAX_CLIENTES = 50;

export function attachRealtime(server: Server, origenPermitido: (origin: string | undefined) => boolean): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const vivos = new WeakMap<WebSocket, boolean>();
  wss.on('error', (e) => console.error('[BI-WS] error del servidor:', e.message));

  const rechazar = (socket: Duplex, estado: string) => {
    socket.once('finish', () => socket.destroy());
    socket.end(`HTTP/1.1 ${estado}\r\nConnection: close\r\n\r\n`);
  };

  server.on('upgrade', (req, socket, head) => {
    // Se compara la URL CRUDA, igual que engine.io con su prefijo '/socket.io/'. Si se
    // normalizara, algo como /socket.io/%2e%2e/bi/ws/historial lo reclamarían los dos
    // (doble handleUpgrade = excepción = se cae el proceso).
    const url = req.url ?? '';
    if (url !== BI_WS_PATH && !url.startsWith(`${BI_WS_PATH}?`)) return; // /socket.io/ y cualquier otro: NO tocar

    socket.on('error', (e) => console.error('[BI-WS] socket:', e.message));
    if (wss.clients.size >= MAX_CLIENTES) return rechazar(socket, '503 Service Unavailable');
    if (!origenPermitido(req.headers.origin)) return rechazar(socket, '403 Forbidden');
    try {
      // Síncrono: engine.io cierra al segundo los upgrades ajenos que nadie contestó.
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      console.error('[BI-WS] upgrade rechazado:', (e as Error).message);
      socket.destroy();
    }
  });

  let lastId = 0;
  let iniciado = false;
  let enCurso = false;
  let timer: NodeJS.Timeout | null = null;
  /** Cambia en cada arranque: un tick que venía de una sesión anterior descarta su resultado. */
  let generacion = 0;

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  const tick = async () => {
    if (enCurso) return;
    enCurso = true;
    const gen = generacion;
    try {
      if (!iniciado) {
        const max = await getMaxId(); // solo empujamos lo que pase DESPUÉS de conectarse
        if (gen !== generacion) return;
        lastId = max;
        iniciado = true;
        return;
      }
      const nuevos = await getEventosDesdeId(lastId);
      if (gen !== generacion) return;
      if (nuevos.length) {
        lastId = Math.max(lastId, ...nuevos.map((e) => e.id));
        broadcast({ tipo: 'eventos', eventos: nuevos });
      }
    } catch {
      /* silencioso; el siguiente tick reintenta */
    } finally {
      enCurso = false;
      // Si este tick era de una sesión anterior, arrancamos ya el de la nueva (sin esperar 5 s).
      if (gen !== generacion && timer) void tick();
    }
  };

  // El poller solo corre mientras haya al menos un cliente conectado.
  const arrancar = () => {
    if (timer) return;
    generacion++;
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
