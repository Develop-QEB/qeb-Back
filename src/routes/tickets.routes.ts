import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  getAllTickets,
  getMyTickets,
  getTicketById,
  createTicket,
  updateTicketStatus,
  getTicketStats,
} from '../controllers/tickets.controller';

const router = Router();

// Todas las rutas requieren autenticacion
router.use(authMiddleware);

// Rutas para usuarios normales
router.get('/my', getMyTickets);
router.post('/', createTicket);

// Rutas para ver tickets (accesibles por todos para ver su propio ticket)
router.get('/stats', getTicketStats);
router.get('/:id', getTicketById);

// Rutas para programadores/admin (obtener todos, actualizar status)
router.get('/', getAllTickets);
router.patch('/:id/status', updateTicketStatus);

export default router;
