import { PrismaClient } from '@prisma/client';
import { getMexicoDate } from './dateHelper';

// Ensure DATABASE_URL has sensible pool defaults (without overriding .env values)
function getDatasourceUrl(): string {
  const url = process.env.DATABASE_URL || '';
  if (!url) return url;

  const defaults: Record<string, string> = {
    connection_limit: '10',
    pool_timeout: '30',
    connect_timeout: '15',
    socket_timeout: '15',
  };

  // Parse existing params properly with URLSearchParams
  const [base, queryString] = url.split('?');
  const existing = new URLSearchParams(queryString || '');

  // Always enforce minimum connection_limit and pool_timeout
  for (const [key, value] of Object.entries(defaults)) {
    if (!existing.has(key)) {
      existing.set(key, value);
    } else if (key === 'connection_limit' && parseInt(existing.get(key)!) < 10) {
      existing.set(key, value);
    } else if (key === 'pool_timeout' && parseInt(existing.get(key)!) < 30) {
      existing.set(key, value);
    }
  }

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

  // Retry middleware for transient connection errors
  client.$use(async (params, next) => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000; // 2 seconds

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await next(params);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // Only retry real connection errors — NOT pool exhaustion (retrying makes it worse)
        const isConnectionError = message.includes("Can't reach database server") ||
          message.includes('Connection refused') ||
          message.includes('ETIMEDOUT') ||
          message.includes('ECONNREFUSED');

        if (isConnectionError && attempt < MAX_RETRIES) {
          console.warn(`[Prisma] Connection error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
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

  return client;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Guardar en global para reutilizar en hot-reloads (nodemon)
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
