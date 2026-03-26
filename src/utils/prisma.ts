import { PrismaClient } from '@prisma/client';
import { getMexicoDate } from './dateHelper';

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
  // Append connection_limit if not already set — keeps pool small for Hostinger's 500 conn/hour cap
  const hasLimit = url.includes('connection_limit');
  const datasourceUrl = hasLimit ? url : `${url}${url.includes('?') ? '&' : '?'}connection_limit=2`;

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
        // Only retry real connection errors — NOT pool exhaustion (retrying makes it worse)
        const isConnectionError = message.includes("Can't reach database server") ||
          message.includes('Connection refused') ||
          message.includes('ETIMEDOUT') ||
          message.includes('ECONNREFUSED') ||
          message.includes('Connection lost');

        // max_connections_per_hour: wait longer before retrying
        const isRateLimited = message.includes('max_connections_per_hour') || message.includes('1226');

        if (isRateLimited && attempt < MAX_RETRIES) {
          const delay = 30000 * attempt; // 30s, 60s, 90s — wait for connections to free up
          console.warn(`[Prisma] Rate limited (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        if (isConnectionError && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * attempt; // 3s, 6s, 9s
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
  }, 30 * 60 * 1000); // 30 min — ~2 pings/hour to stay within Hostinger's 500 conn/hour cap

  return client;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Cache in global to prevent multiple PrismaClient instances
globalForPrisma.prisma = prisma;

export default prisma;


