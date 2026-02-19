import 'dotenv/config';
import { createServer } from 'http';
import app from './app';
import prisma from './utils/prisma';
import { initializeSocket } from './config/socket';

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

// Verify DB connectivity with a single lightweight query (does NOT pre-allocate the entire pool)
async function verifyDbConnection(): Promise<void> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 3000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log('[DB] Database connected successfully');
      return;
    } catch (error) {
      console.error(`[DB] Connection attempt ${attempt}/${MAX_RETRIES} failed:`, (error as Error).message);
      if (attempt === MAX_RETRIES) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function main() {
  // Inicializar Socket.io
  initializeSocket(httpServer);
  console.log('[Socket] WebSocket server inicializado');

  // Arrancar servidor HTTP primero para responder health checks y CORS
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Verify DB connectivity (lazy - only opens 1 connection, not the whole pool)
  try {
    await verifyDbConnection();

    // Ejecutar limpieza inicial al arrancar
    await limpiarReservasExpiradas();

    // Programar limpieza periódica
    setInterval(limpiarReservasExpiradas, INTERVALO_LIMPIEZA_MS);
    console.log(`[CRON] Limpieza de reservas programada cada ${INTERVALO_LIMPIEZA_MS / 3600000} horas`);
  } catch (error) {
    console.error('[DB] Could not connect to database after all retries:', error);
    console.log('[DB] Server is running but database is unavailable. API requests will fail.');
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

main();
