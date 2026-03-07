import { PrismaClient } from '@prisma/client';

const PRISMA_TUNING = {
  connection_limit: '15',
  pool_timeout: '30',
  connect_timeout: '30',
  socket_timeout: '30',
  keepalive: '240',
} as const;

// Ensure DATABASE_URL uses the calibrated pool and timeout settings.
function getDatasourceUrl(): string {
  const rawUrl = process.env.DATABASE_URL || '';
  if (!rawUrl) return rawUrl;

  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set('connection_limit', PRISMA_TUNING.connection_limit);
    parsed.searchParams.set('pool_timeout', PRISMA_TUNING.pool_timeout);
    parsed.searchParams.set('connect_timeout', PRISMA_TUNING.connect_timeout);
    parsed.searchParams.set('socket_timeout', PRISMA_TUNING.socket_timeout);
    parsed.searchParams.set('keepalive', PRISMA_TUNING.keepalive);
    return parsed.toString();
  } catch {
    // Fallback for malformed URLs: enforce keys with string replacement.
    let url = rawUrl;
    const forceParam = (key: string, value: string) => {
      const regex = new RegExp(`([?&])${key}=[^&]*`);
      if (regex.test(url)) {
        url = url.replace(regex, `$1${key}=${value}`);
      } else {
        url += (url.includes('?') ? '&' : '?') + `${key}=${value}`;
      }
    };

    forceParam('connection_limit', PRISMA_TUNING.connection_limit);
    forceParam('pool_timeout', PRISMA_TUNING.pool_timeout);
    forceParam('connect_timeout', PRISMA_TUNING.connect_timeout);
    forceParam('socket_timeout', PRISMA_TUNING.socket_timeout);
    forceParam('keepalive', PRISMA_TUNING.keepalive);
    return url;
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const createPrismaClient = () => {
  const datasourceUrl = getDatasourceUrl();
  try {
    const safeUrl = new URL(datasourceUrl);
    console.log(
      `[Prisma] Pool config: connection_limit=${safeUrl.searchParams.get('connection_limit')}, pool_timeout=${safeUrl.searchParams.get('pool_timeout')}`,
    );
  } catch {
    console.log('[Prisma] Pool config: unable to parse DATABASE_URL');
  }

  return new PrismaClient({
    log: ['error'],
    datasourceUrl,
  });
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Cache in global to prevent multiple PrismaClient instances
globalForPrisma.prisma = prisma;

export default prisma;
