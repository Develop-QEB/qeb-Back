import { PrismaClient } from '@prisma/client';

// Ensure DATABASE_URL has proper pool and timeout settings
function getDatasourceUrl(): string {
  let url = process.env.DATABASE_URL || '';
  if (!url) return url;

  // Force connection_limit to 5 (safe for shared hosting like Hostinger)
  if (url.includes('connection_limit')) {
    url = url.replace(/connection_limit=\d+/, 'connection_limit=5');
  } else {
    url += (url.includes('?') ? '&' : '?') + 'connection_limit=5';
  }

  // Force pool_timeout to 20s (fail fast instead of hanging 60s)
  if (url.includes('pool_timeout')) {
    url = url.replace(/pool_timeout=\d+/, 'pool_timeout=20');
  } else {
    url += '&pool_timeout=20';
  }

  // TCP-level timeouts
  if (!url.includes('connect_timeout')) url += '&connect_timeout=30';
  if (!url.includes('socket_timeout')) url += '&socket_timeout=30';

  return url;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const createPrismaClient = () => {
  const datasourceUrl = getDatasourceUrl();
  console.log(`[Prisma] Pool config: connection_limit=${datasourceUrl.match(/connection_limit=(\d+)/)?.[1]}, pool_timeout=${datasourceUrl.match(/pool_timeout=(\d+)/)?.[1]}`);

  return new PrismaClient({
    log: ['error'],
    datasourceUrl,
  });
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Cache in global to prevent multiple PrismaClient instances
globalForPrisma.prisma = prisma;

export default prisma;
