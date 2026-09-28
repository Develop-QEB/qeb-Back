import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { getEventosDesdeId, getMaxId } from './services/historial.service.js';

/**
 * Tiempo real del historial de acciones.
 *
 * La BD es SOLO LECTURA (no podemos poner triggers/CDC), así que hacemos un
 * polling ligero: cada POLL_MS buscamos filas de `historial` con id mayor al
 * último visto y empujamos SOLO las nuevas a los clientes por WebSocket.
 */
const POLL_MS = 5000;

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws/historial' });
  let lastId = 0;
  let iniciado = false;

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ tipo: 'conectado', ts: new Date().toISOString() }));
  });

  const tick = async () => {
    try {
      if (!iniciado) {
        lastId = await getMaxId(); // solo empujamos lo que pase DESPUÉS de arrancar
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
    }
  };

  setInterval(tick, POLL_MS);
  void tick();
  console.log(`🔴 WebSocket en /ws/historial (poll cada ${POLL_MS / 1000}s)`);
}
