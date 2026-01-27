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

    // Unirse a un room específico de propuesta
    socket.on('join-propuesta', (propuestaId: number) => {
      socket.join(`propuesta-${propuestaId}`);
      console.log(`[Socket] ${socket.id} se unió a propuesta-${propuestaId}`);
    });

    // Salir del room de propuesta
    socket.on('leave-propuesta', (propuestaId: number) => {
      socket.leave(`propuesta-${propuestaId}`);
      console.log(`[Socket] ${socket.id} salió de propuesta-${propuestaId}`);
    });

    // Unirse a rooms específicos de cada módulo
    socket.on('join-solicitudes', () => {
      socket.join('solicitudes');
      console.log(`[Socket] ${socket.id} se unió a solicitudes`);
    });

    socket.on('leave-solicitudes', () => {
      socket.leave('solicitudes');
      console.log(`[Socket] ${socket.id} salió de solicitudes`);
    });

    socket.on('join-propuestas', () => {
      socket.join('propuestas');
      console.log(`[Socket] ${socket.id} se unió a propuestas`);
    });

    socket.on('leave-propuestas', () => {
      socket.leave('propuestas');
      console.log(`[Socket] ${socket.id} salió de propuestas`);
    });

    socket.on('join-campanas', () => {
      socket.join('campanas');
      console.log(`[Socket] ${socket.id} se unió a campanas`);
    });

    socket.on('leave-campanas', () => {
      socket.leave('campanas');
      console.log(`[Socket] ${socket.id} salió de campanas`);
    });

    socket.on('join-clientes', () => {
      socket.join('clientes');
      console.log(`[Socket] ${socket.id} se unió a clientes`);
    });

    socket.on('leave-clientes', () => {
      socket.leave('clientes');
      console.log(`[Socket] ${socket.id} salió de clientes`);
    });

    socket.on('join-proveedores', () => {
      socket.join('proveedores');
      console.log(`[Socket] ${socket.id} se unió a proveedores`);
    });

    socket.on('leave-proveedores', () => {
      socket.leave('proveedores');
      console.log(`[Socket] ${socket.id} salió de proveedores`);
    });

    socket.on('join-dashboard', () => {
      socket.join('dashboard');
      console.log(`[Socket] ${socket.id} se unió a dashboard`);
    });

    socket.on('leave-dashboard', () => {
      socket.leave('dashboard');
      console.log(`[Socket] ${socket.id} salió de dashboard`);
    });

    socket.on('join-inventario', () => {
      socket.join('inventario');
      console.log(`[Socket] ${socket.id} se unió a inventario`);
    });

    socket.on('leave-inventario', () => {
      socket.leave('inventario');
      console.log(`[Socket] ${socket.id} salió de inventario`);
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
  INVENTARIO_CREADO: 'inventario:creado',
  INVENTARIO_ELIMINADO: 'inventario:eliminado',

  // Reservas y Propuestas
  RESERVA_CREADA: 'reserva:creada',
  RESERVA_ELIMINADA: 'reserva:eliminada',
  PROPUESTA_ACTUALIZADA: 'propuesta:actualizada',
  PROPUESTA_CREADA: 'propuesta:creada',
  PROPUESTA_ELIMINADA: 'propuesta:eliminada',
  PROPUESTA_STATUS_CHANGED: 'propuesta:status:changed',

  // Autorizaciones
  AUTORIZACION_APROBADA: 'autorizacion:aprobada',
  AUTORIZACION_RECHAZADA: 'autorizacion:rechazada',

  // Equipos
  EQUIPO_MIEMBROS_ACTUALIZADO: 'equipo:miembros:actualizado',

  // Solicitudes
  SOLICITUD_CREADA: 'solicitud:creada',
  SOLICITUD_ACTUALIZADA: 'solicitud:actualizada',
  SOLICITUD_ELIMINADA: 'solicitud:eliminada',
  SOLICITUD_STATUS_CHANGED: 'solicitud:status:changed',

  // Campañas
  CAMPANA_CREADA: 'campana:creada',
  CAMPANA_ACTUALIZADA: 'campana:actualizada',
  CAMPANA_ELIMINADA: 'campana:eliminada',
  CAMPANA_STATUS_CHANGED: 'campana:status:changed',
  CAMPANA_COMENTARIO_CREADO: 'campana:comentario:creado',

  // Clientes
  CLIENTE_CREADO: 'cliente:creado',
  CLIENTE_ACTUALIZADO: 'cliente:actualizado',
  CLIENTE_ELIMINADO: 'cliente:eliminado',

  // Proveedores
  PROVEEDOR_CREADO: 'proveedor:creado',
  PROVEEDOR_ACTUALIZADO: 'proveedor:actualizado',
  PROVEEDOR_ELIMINADO: 'proveedor:eliminado',

  // Dashboard
  DASHBOARD_UPDATED: 'dashboard:updated',
  DASHBOARD_STATS_CHANGED: 'dashboard:stats:changed',

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

// Helper para emitir a una propuesta específica
export function emitToPropuesta(propuestaId: number, event: string, data: unknown): void {
  if (io) {
    io.to(`propuesta-${propuestaId}`).emit(event, data);
    console.log(`[Socket] Emitido ${event} a propuesta-${propuestaId}`);
  }
}

// Helper para emitir a todos los que están en el módulo de solicitudes
export function emitToSolicitudes(event: string, data: unknown): void {
  if (io) {
    io.to('solicitudes').emit(event, data);
    console.log(`[Socket] Emitido ${event} a solicitudes`);
  }
}

// Helper para emitir a todos los que están en el módulo de propuestas
export function emitToPropuestas(event: string, data: unknown): void {
  if (io) {
    io.to('propuestas').emit(event, data);
    console.log(`[Socket] Emitido ${event} a propuestas`);
  }
}

// Helper para emitir a todos los que están en el módulo de campañas
export function emitToCampanas(event: string, data: unknown): void {
  if (io) {
    io.to('campanas').emit(event, data);
    console.log(`[Socket] Emitido ${event} a campanas`);
  }
}

// Helper para emitir a todos los que están en el módulo de clientes
export function emitToClientes(event: string, data: unknown): void {
  if (io) {
    io.to('clientes').emit(event, data);
    console.log(`[Socket] Emitido ${event} a clientes`);
  }
}

// Helper para emitir a todos los que están en el módulo de proveedores
export function emitToProveedores(event: string, data: unknown): void {
  if (io) {
    io.to('proveedores').emit(event, data);
    console.log(`[Socket] Emitido ${event} a proveedores`);
  }
}

// Helper para emitir a todos los que están en el dashboard
export function emitToDashboard(event: string, data: unknown): void {
  if (io) {
    io.to('dashboard').emit(event, data);
    console.log(`[Socket] Emitido ${event} a dashboard`);
  }
}

// Helper para emitir a todos los que están en el módulo de inventario
export function emitToInventario(event: string, data: unknown): void {
  if (io) {
    io.to('inventario').emit(event, data);
    console.log(`[Socket] Emitido ${event} a inventario`);
  }
}
