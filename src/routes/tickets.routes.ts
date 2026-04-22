import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  getAllTickets,
  getMyTickets,
  getTicketById,
  createTicket,
  updateTicketStatus,
  getTicketStats,
  getTicketsHistorial,
  getTicketsUnreadCount,
  markTicketOpened,
  getTicketMensajes,
  createTicketMensaje,
  markTicketMensajesRead,
  getTicketChat,
  createTicketChatMessage,
  markTicketChatRead,
  getTicketChatUnreadCount,
  deleteTicketChatMessage,
  getTicketRankings,
  getReportesEspeciales,
  getReportesDetalle,
} from '../controllers/tickets.controller';

const router = Router();

// Todas las rutas requieren autenticacion
router.use(authMiddleware);

// Rutas para usuarios normales
router.get('/my', getMyTickets);
router.post('/', createTicket);

// Rankings de tickets (solo equipo DEV)
router.get('/rankings', getTicketRankings);

// Reportes especiales (métricas del día)
router.get('/reportes-especiales', getReportesEspeciales);
router.get('/reportes-especiales/detalle', getReportesDetalle);

// Historial de tickets (usuarios autorizados)
router.get('/historial', getTicketsHistorial);
router.get('/unread-count', getTicketsUnreadCount);
router.post('/:id/opened', markTicketOpened);
router.get('/:id/mensajes', getTicketMensajes);
router.post('/:id/mensajes', createTicketMensaje);
router.post('/:id/mensajes/read', markTicketMensajesRead);

// Chat de soporte (comunicacion entre creador y admins)
router.get('/chat/unread-count', getTicketChatUnreadCount);
router.get('/:id/chat', getTicketChat);
router.post('/:id/chat', createTicketChatMessage);
router.post('/:id/chat/read', markTicketChatRead);
router.delete('/chat/:messageId', deleteTicketChatMessage);

// Rutas para ver tickets (accesibles por todos para ver su propio ticket)
router.get('/stats', getTicketStats);
router.get('/:id', getTicketById);

// Rutas para programadores/admin (obtener todos, actualizar status)
router.get('/', getAllTickets);
router.patch('/:id/status', updateTicketStatus);

export default router;
