import { PrismaClient } from '@prisma/client';
import { getMexicoDate } from './dateHelper';
import { emitTareaCreadaPopup } from '../config/socket';

// Use DATABASE_URL exactly as provided by environment
function getDatasourceUrl(): string {
  const url = process.env.DATABASE_URL || '';
  if (!url) return url;

  const safeUrl = url.replace(/\/\/[^@]+@/, '//***@');
  console.log('[Prisma] Using datasource URL:', safeUrl);
  return url;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const createPrismaClient = () => {
  const url = getDatasourceUrl();
  // Ensure connection pool has reasonable limits — override if too low
  let datasourceUrl = url;
  // connection_limit: 30 — queries optimizados liberan conexiones rápido,
  // no acaparar el max_connections del servidor MySQL
  if (!url.includes('connection_limit')) {
    datasourceUrl += `${url.includes('?') ? '&' : '?'}connection_limit=30`;
  } else {
    datasourceUrl = datasourceUrl.replace(/connection_limit=\d+/, 'connection_limit=30');
  }
  // pool_timeout: 60s para esperar conexión disponible del pool
  if (!url.includes('pool_timeout')) {
    datasourceUrl += '&pool_timeout=60';
  } else {
    datasourceUrl = datasourceUrl.replace(/pool_timeout=\d+/, 'pool_timeout=60');
  }
  // socket_timeout: 120s para queries pesados contra BD remota
  if (!url.includes('socket_timeout')) {
    datasourceUrl += '&socket_timeout=120';
  } else if (parseInt(url.match(/socket_timeout=(\d+)/)?.[1] || '0') < 120) {
    datasourceUrl = datasourceUrl.replace(/socket_timeout=\d+/, 'socket_timeout=120');
  }

  const client = new PrismaClient({
    log: ['error'],
    datasourceUrl,
  });

  // Retry middleware for transient connection errors (Hostinger drops connections frequently)
  client.$use(async (params, next) => {
    const MAX_RETRIES = 3;
    const BASE_DELAY = 3000; // 3 seconds

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await next(params);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const isConnectionError = message.includes("Can't reach database server") ||
          message.includes('Connection refused') ||
          message.includes('ETIMEDOUT') ||
          message.includes('ECONNREFUSED') ||
          message.includes('Connection lost');

        const isRateLimited = message.includes('max_connections_per_hour') || message.includes('1226');

        const isPoolExhausted = message.includes('Too many connections') || message.includes('1040');

        if (isPoolExhausted) {
          if (attempt === 1) {
            console.warn(`[Prisma] Pool exhausted (attempt 1/${MAX_RETRIES}), waiting 5s...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          }
          throw error;
        }

        if (isRateLimited && attempt < MAX_RETRIES) {
          const delay = 30000 * attempt;
          console.warn(`[Prisma] Rate limited (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        if (isConnectionError && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * attempt;
          console.warn(`[Prisma] Connection error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  });

  // Middleware: fechas de México y fecha_fin +7 días en tareas
  client.$use(async (params, next) => {
    if (params.model === 'tareas' && params.action === 'create') {
      const now = getMexicoDate();
      const fin = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      params.args.data.fecha_inicio = params.args.data.fecha_inicio || now;
      params.args.data.created_at = params.args.data.created_at || now;
      params.args.data.fecha_fin = fin;
    }
    return next(params);
  });

  // Cache corto (5 min) de la supervisión de Diseño: qué usuarios son
  // Diseñadores y quiénes son Coordinadores de Diseño. Sirve para que el popup
  // llegue también al Coordinador cuando la tarea/notificación va a un Diseñador
  // (igual que la lista, que ya muestra al Coordinador lo de sus Diseñadores).
  let disenoCache: { disenadores: Set<number>; coordinadores: number[]; ts: number } | null = null;
  const getSupervisionDiseno = async () => {
    const now = Date.now();
    if (disenoCache && now - disenoCache.ts < 5 * 60 * 1000) return disenoCache;
    const [dis, coord] = await Promise.all([
      client.usuario.findMany({ where: { user_role: 'Diseñadores', deleted_at: null }, select: { id: true } }),
      client.usuario.findMany({ where: { user_role: 'Coordinador de Diseño', deleted_at: null }, select: { id: true } }),
    ]);
    disenoCache = { disenadores: new Set(dis.map((r) => r.id)), coordinadores: coord.map((r) => r.id), ts: now };
    return disenoCache;
  };

  // Middleware: al crear una TAREA real, notificar (popup) a sus asignados.
  // Punto único para todos los tipos de tarea (autorización, revisión de artes,
  // instalación, etc.). No rompe la creación si el socket falla.
  client.$use(async (params, next) => {
    const result = await next(params);
    if (params.model === 'tareas' && params.action === 'create' && result) {
      try {
        const t = result as Parameters<typeof emitTareaCreadaPopup>[0];
        // Destinatarios reales de la fila (igual criterio que emitTareaCreadaPopup).
        const targetIds: number[] = [];
        if (t.id_responsable) targetIds.push(t.id_responsable);
        if (t.tipo !== 'Notificación' && t.id_asignado) {
          for (const s of String(t.id_asignado).split(',')) {
            const n = parseInt(s.trim(), 10);
            if (!isNaN(n)) targetIds.push(n);
          }
        }
        // Si algún destinatario es Diseñador, sumar a los Coordinadores de Diseño.
        let extra: number[] | undefined;
        if (targetIds.length > 0) {
          const sup = await getSupervisionDiseno();
          if (targetIds.some((id) => sup.disenadores.has(id))) extra = sup.coordinadores;
        }
        emitTareaCreadaPopup(t, extra);
      } catch (err) {
        console.warn('[Prisma] emitTareaCreadaPopup falló:', err instanceof Error ? err.message : err);
      }
    }
    return result;
  });

  // Keepalive: ping DB every 4 minutes to prevent Hostinger from dropping idle connections
  setInterval(async () => {
    try {
      await client.$queryRaw`SELECT 1`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Prisma] Keepalive ping failed:', msg);
    }
  }, 30 * 60 * 1000); // 30 min — ~2 pings/hour to stay within Hostinger's 500 conn/hour cap

  return client;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Cache in global to prevent multiple PrismaClient instances
globalForPrisma.prisma = prisma;

export default prisma;


