import { Server as SocketServer } from 'socket.io';
import { Server as HttpServer } from 'http';

let io: SocketServer | null = null;

// Parse FRONTEND_URL: puede ser un solo URL o múltiples separados por coma
const getAllowedOrigins = (): string[] => {
  const defaultOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'http://localhost:5177',
    'http://localhost:3000',
    'https://front-qeb.vercel.app',
  ];

  const envUrl = process.env.FRONTEND_URL;
  if (!envUrl) {
    return defaultOrigins;
  }
  // Si contiene comas, separar en array
  if (envUrl.includes(',')) {
    const envOrigins = envUrl.split(',').map(url => url.trim());
    return [...new Set([...defaultOrigins, ...envOrigins])];
  }
  return [...new Set([...defaultOrigins, envUrl])];
};

export function initializeSocket(httpServer: HttpServer): SocketServer {
  const allowedOrigins = getAllowedOrigins();
  console.log('[Socket] Orígenes permitidos:', allowedOrigins);

  io = new SocketServer(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] Cliente conectado: ${socket.id}`);

    // Unirse a un room específico de campaña
    socket.on('join-campana', (campanaId: number) => {
      socket.join(`campana-${campanaId}`);
      console.log(`[Socket] ${socket.id} se unió a campana-${campanaId}`);
    });

    // Salir del room de campaña
    socket.on('leave-campana', (campanaId: number) => {
      socket.leave(`campana-${campanaId}`);
      console.log(`[Socket] ${socket.id} salió de campana-${campanaId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Cliente desconectado: ${socket.id}`);
    });
  });

  return io;
}

export function getIO(): SocketServer {
  if (!io) {
    throw new Error('Socket.io no ha sido inicializado');
  }
  return io;
}

// Eventos que se pueden emitir
export const SOCKET_EVENTS = {
  // Tareas
  TAREA_CREADA: 'tarea:creada',
  TAREA_ACTUALIZADA: 'tarea:actualizada',
  TAREA_ELIMINADA: 'tarea:eliminada',

  // Notificaciones
  NOTIFICACION_NUEVA: 'notificacion:nueva',
  NOTIFICACION_LEIDA: 'notificacion:leida',

  // Artes
  ARTE_SUBIDO: 'arte:subido',
  ARTE_APROBADO: 'arte:aprobado',
  ARTE_RECHAZADO: 'arte:rechazado',

  // Inventario
  INVENTARIO_ACTUALIZADO: 'inventario:actualizado',

  // General
  DATOS_ACTUALIZADOS: 'datos:actualizados',
};

// Helper para emitir a una campaña específica
export function emitToCampana(campanaId: number, event: string, data: unknown): void {
  if (io) {
    io.to(`campana-${campanaId}`).emit(event, data);
    console.log(`[Socket] Emitido ${event} a campana-${campanaId}`);
  }
}

// Helper para emitir a todos los clientes
export function emitToAll(event: string, data: unknown): void {
  if (io) {
    io.emit(event, data);
    console.log(`[Socket] Emitido ${event} a todos`);
  }
}
