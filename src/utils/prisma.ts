import { PrismaClient } from '@prisma/client';

// Ensure DATABASE_URL has proper pool and timeout settings
function getDatasourceUrl(): string {
  let url = process.env.DATABASE_URL || '';
  if (!url) return url;

  // Force calibrated pool settings
  if (url.includes('connection_limit')) {
    url = url.replace(/connection_limit=\d+/, 'connection_limit=15');
  } else {
    url += (url.includes('?') ? '&' : '?') + 'connection_limit=15';
  }

  // Pool timeout calibrated for this workload
  if (url.includes('pool_timeout')) {
    url = url.replace(/pool_timeout=\d+/, 'pool_timeout=30');
  } else {
    url += '&pool_timeout=30';
  }

  // TCP-level timeouts
  if (url.includes('connect_timeout')) {
    url = url.replace(/connect_timeout=\d+/, 'connect_timeout=30');
  } else {
    url += '&connect_timeout=30';
  }
  if (url.includes('socket_timeout')) {
    url = url.replace(/socket_timeout=\d+/, 'socket_timeout=30');
  } else {
    url += '&socket_timeout=30';
  }
  if (url.includes('keepalive')) {
    url = url.replace(/keepalive=\d+/, 'keepalive=240');
  } else {
    url += '&keepalive=240';
  }

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
