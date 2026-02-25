import { PrismaClient } from '@prisma/client';
import { getMexicoDate } from './dateHelper';

// Build datasource URL with forced pool settings (tuned for Hostinger shared hosting)
function getDatasourceUrl(): string {
  const url = process.env.DATABASE_URL || '';
  if (!url) return url;

  const [base, queryString] = url.split('?');
  const existing = new URLSearchParams(queryString || '');

  // FORCE these values — Hostinger shared hosting needs conservative limits
  existing.set('connection_limit', '5');
  existing.set('pool_timeout', '30');
  existing.set('connect_timeout', '30');
  existing.set('socket_timeout', '30');

  const finalUrl = `${base}?${existing.toString()}`;
  const safeUrl = finalUrl.replace(/\/\/[^@]+@/, '//***@');
  console.log('[Prisma] Using datasource URL:', safeUrl);
  return finalUrl;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const createPrismaClient = () => {
  const client = new PrismaClient({
    log: ['error'],
    datasourceUrl: getDatasourceUrl(),
  });

  // Retry middleware for transient connection errors (Hostinger drops connections frequently)
  client.$use(async (params, next) => {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 3000; // 3 seconds

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await next(params);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // Only retry real connection errors — NOT pool exhaustion (retrying makes it worse)
        const isConnectionError = message.includes("Can't reach database server") ||
          message.includes('Connection refused') ||
          message.includes('ETIMEDOUT') ||
          message.includes('ECONNREFUSED') ||
          message.includes('Connection lost');

        if (isConnectionError && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * attempt; // 3s, 6s, 9s, 12s
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

  // Keepalive: ping DB every 4 minutes to prevent Hostinger from dropping idle connections
  setInterval(async () => {
    try {
      await client.$queryRaw`SELECT 1`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Prisma] Keepalive ping failed:', msg);
    }
  }, 4 * 60 * 1000);

  return client;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Guardar en global para reutilizar en hot-reloads (nodemon)
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
