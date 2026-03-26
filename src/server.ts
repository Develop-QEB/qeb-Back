import 'dotenv/config';
import { createServer } from 'http';
import app from './app';
import prisma from './utils/prisma';
import { initializeSocket } from './config/socket';

if (process.env.NODE_ENV !== 'production') {
  console.warn(`[Config] NODE_ENV=${process.env.NODE_ENV || 'undefined'}; forcing production mode`);
  process.env.NODE_ENV = 'production';
} 
 
const PORT = process.env.PORT || 3000;

// Crear servidor HTTP para Socket.io
const httpServer = createServer(app);

// Constante para días de expiración de reservas
const DIAS_EXPIRACION_RESERVA = 20;

/**
 * Función para liberar reservas que llevan más de 20 días sin convertirse en vendido
 * Las reservas con estatus 'Reservado' o 'Bonificado' que tengan fecha_reserva > 20 días
 * serán eliminadas (soft delete) para que el inventario vuelva a estar disponible
 */
async function limpiarReservasExpiradas(): Promise<void> {
  try {
    const fechaLimite = new Date();
    fechaLimite.setDate(fechaLimite.getDate() - DIAS_EXPIRACION_RESERVA);

    // Eliminar reservas expiradas (soft delete) - el inventario queda disponible nuevamente
    const result = await prisma.$executeRaw`
      UPDATE reservas
      SET deleted_at = NOW()
      WHERE deleted_at IS NULL
        AND estatus IN ('Reservado', 'Bonificado')
        AND fecha_reserva < ${fechaLimite}
    `;

    if (result > 0) {
      console.log(`[CRON] ${result} reservas liberadas por exceder ${DIAS_EXPIRACION_RESERVA} días - inventario disponible nuevamente`);
    }
  } catch (error) {
    console.error('[CRON] Error al liberar reservas expiradas:', error);
  }
}

// Intervalo para ejecutar la limpieza (cada 6 horas = 21600000 ms)
const INTERVALO_LIMPIEZA_MS = 6 * 60 * 60 * 1000;

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 2000;

async function connectWithRetry(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.$connect();
      console.log('[DB] Connected successfully');
      return;
    } catch (error) {
      const msg = (error as Error).message?.split('\n')[0] || 'Unknown error';
      console.error(`[DB] Attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
      if (attempt === MAX_RETRIES) {
        throw error;
      }
      // Exponential backoff: 2s, 4s, 6s, 8s... capped at 15s
      const delay = Math.min(BASE_DELAY_MS * attempt, 15000);
      console.log(`[DB] Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function main() {
  // Inicializar Socket.io
  initializeSocket(httpServer);
  console.log('[Socket] WebSocket server inicializado');

  // Arrancar servidor HTTP PRIMERO para pasar health checks
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Conectar a DB en background (no bloquea el health check)
  try {
    await connectWithRetry();

    // Ejecutar limpieza inicial al arrancar
    await limpiarReservasExpiradas();

    // Programar limpieza periódica
    setInterval(limpiarReservasExpiradas, INTERVALO_LIMPIEZA_MS);
    console.log(`[CRON] Limpieza de reservas programada cada ${INTERVALO_LIMPIEZA_MS / 3600000} horas`);
  } catch (error) {
    console.error('[DB] Could not connect to database after all retries:', error);
    console.log('[DB] Server running without DB — requests will retry on demand.');
  }
}

// Graceful shutdown: disconnect DB immediately, then close HTTP
async function gracefulShutdown(signal: string) {
  console.log(`[Shutdown] ${signal} received, closing gracefully...`);
  // 1. Disconnect Prisma FIRST to release DB connections immediately
  try {
    await prisma.$disconnect();
    console.log('[Shutdown] Prisma disconnected');
  } catch (err) {
    console.error('[Shutdown] Error disconnecting Prisma:', err);
  }
  // 2. Close HTTP server
  httpServer.close(() => {
    console.log('[Shutdown] HTTP server closed');
  });
  // 3. Force exit after 3s if still hanging
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
  console.error('[FATAL] Promise:', promise);
});

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  // Dar tiempo para loguear y luego salir con código de error
  setTimeout(() => process.exit(1), 1000);
});

main();
