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

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000; // 5 segundos entre reintentos

async function connectWithRetry(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.$connect();
      console.log('Database connected successfully');
      return;
    } catch (error) {
      console.error(`[DB] Connection attempt ${attempt}/${MAX_RETRIES} failed:`, (error as Error).message);
      if (attempt === MAX_RETRIES) {
        throw error;
      }
      console.log(`[DB] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function main() {
  try {
    await connectWithRetry();

    // Ejecutar limpieza inicial al arrancar
    await limpiarReservasExpiradas();

    // Programar limpieza periódica
    setInterval(limpiarReservasExpiradas, INTERVALO_LIMPIEZA_MS);
    console.log(`[CRON] Limpieza de reservas programada cada ${INTERVALO_LIMPIEZA_MS / 3600000} horas`);

    // Inicializar Socket.io
    initializeSocket(httpServer);
    console.log('[Socket] WebSocket server inicializado');

    httpServer.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to start server after all retries:', error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

main();

