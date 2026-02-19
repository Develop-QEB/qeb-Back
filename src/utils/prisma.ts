import { PrismaClient } from '@prisma/client';

// Ensure DATABASE_URL has proper pool and timeout settings
function getDatasourceUrl(): string {
  let url = process.env.DATABASE_URL || '';
  if (!url) return url;

  const separator = url.includes('?') ? '&' : '?';
  const params: string[] = [];

  // Connection pool: 10 connections, 30s wait for available connection
  if (!url.includes('connection_limit')) params.push('connection_limit=10');
  if (!url.includes('pool_timeout')) params.push('pool_timeout=30');
  // TCP-level timeouts for slow/unreachable DB
  if (!url.includes('connect_timeout')) params.push('connect_timeout=30');
  if (!url.includes('socket_timeout')) params.push('socket_timeout=30');

  if (params.length > 0) {
    url += separator + params.join('&');
  }

  return url;
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
        // Only retry on actual DB connection errors, NOT pool exhaustion
        // Retrying pool timeouts makes it worse by adding more demand
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

  return client;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Guardar en global para reutilizar en hot-reloads (nodemon)
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
