import { PrismaClient } from '@prisma/client';
import { getMexicoDate } from './dateHelper';

// Build datasource URL with forced pool settings
function getDatasourceUrl(): string {
  const url = process.env.DATABASE_URL || '';
  if (!url) return url;

  const [base, queryString] = url.split('?');
  const existing = new URLSearchParams(queryString || '');

  // FORCE these values — always override whatever is in the URL
  existing.set('connection_limit', '5');
  existing.set('pool_timeout', '20');
  existing.set('connect_timeout', '10');
  existing.set('socket_timeout', '10');

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

  // Test connection on startup
  client.$connect()
    .then(() => console.log('[Prisma] Connected to database successfully'))
    .catch((err: Error) => console.error('[Prisma] Failed to connect:', err.message));

  return client;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Guardar en global para reutilizar en hot-reloads (nodemon)
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
