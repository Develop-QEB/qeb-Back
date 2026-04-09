import { Response } from 'express';
import prisma from '../utils/prisma';
import nodemailer from 'nodemailer';
import { AuthRequest } from '../types';
import { getIO, SOCKET_EVENTS } from '../config/socket';

// Configurar transporter de nodemailer
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

// Obtener todos los tickets (para programadores)
export const getAllTickets = async (req: AuthRequest, res: Response) => {
  try {
    const { status, prioridad, search, page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};

    if (status && status !== 'Todos') {
      where.status = status;
    }

    if (prioridad && prioridad !== 'Todos') {
      where.prioridad = prioridad;
    }

    if (search) {
      where.OR = [
        { titulo: { contains: search as string } },
        { descripcion: { contains: search as string } },
        { usuario_nombre: { contains: search as string } },
      ];
    }

    const [tickets, total] = await Promise.all([
      prisma.tickets.findMany({
        where,
        orderBy: [
          { status: 'asc' }, // Nuevos primero
          { prioridad: 'desc' },
          { created_at: 'desc' },
        ],
        skip,
        take: Number(limit),
      }),
      prisma.tickets.count({ where }),
    ]);

    res.json({
      data: tickets,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ message: 'Error al obtener tickets' });
  }
};

// Obtener tickets del usuario actual
export const getMyTickets = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const tickets = await prisma.tickets.findMany({
      where: { usuario_id: userId },
      orderBy: { created_at: 'desc' },
      include: {
        chat: { orderBy: { id: 'desc' }, take: 1 },
        chat_vistas: { where: { usuario_id: userId } },
      },
    });

    const result = tickets.map((t) => {
      const chatVista = t.chat_vistas[0];
      const ultimoChat = t.chat[0];
      const hasChatUnread = ultimoChat ? ultimoChat.id > (chatVista?.ultimo_mensaje_leido_id || 0) : false;
      const { chat, chat_vistas, ...ticketData } = t;
      return { ...ticketData, has_chat_unread: hasChatUnread };
    });

    res.json({ data: result });
  } catch (error) {
    console.error('Error fetching my tickets:', error);
    res.status(500).json({ message: 'Error al obtener tus tickets' });
  }
};

// Obtener un ticket por ID
export const getTicketById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const ticket = await prisma.tickets.findUnique({
      where: { id: Number(id) },
    });

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket no encontrado' });
    }

    res.json(ticket);
  } catch (error) {
    console.error('Error fetching ticket:', error);
    res.status(500).json({ message: 'Error al obtener ticket' });
  }
};

// Crear un nuevo ticket
export const createTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { titulo, descripcion, imagen, prioridad } = req.body;
    const userId = req.user?.userId;
    const userName = req.user?.nombre || 'Usuario';
    const userEmail = req.user?.email || '';

    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    if (!titulo || !descripcion) {
      return res.status(400).json({ message: 'Titulo y descripcion son requeridos' });
    }

    const ticket = await prisma.tickets.create({
      data: {
        titulo,
        descripcion,
        imagen: imagen || null,
        prioridad: prioridad || 'Normal',
        usuario_id: userId,
        usuario_nombre: userName,
        usuario_email: userEmail,
      },
    });

    // Enviar email de notificacion a los programadores
    const devEmail = process.env.DEV_EMAIL || 'Develop@qeb.mx';

    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; background: linear-gradient(135deg, #8b5cf6, #d946ef); padding: 25px; border-radius: 12px 12px 0 0;">
          <h1 style="color: #ffffff; margin: 0; font-size: 28px;">QEB Tickets</h1>
          <p style="color: rgba(255,255,255,0.9); margin: 5px 0 0 0; font-size: 14px;">Nuevo ticket de soporte</p>
        </div>

        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
          <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
            <p style="margin: 0; color: #92400e; font-size: 14px;">
              <strong>Prioridad: ${prioridad || 'Normal'}</strong>
            </p>
          </div>

          <h2 style="color: #1f2937; margin: 0 0 15px 0; font-size: 20px;">${titulo}</h2>

          <div style="background: #f3f4f6; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin: 0; white-space: pre-wrap;">${descripcion}</p>
          </div>

          ${imagen ? '<p style="color: #6b7280; font-size: 13px;"><em>El ticket incluye una imagen adjunta</em></p>' : ''}

          <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; margin-top: 20px;">
            <table style="width: 100%; font-size: 13px; color: #6b7280;">
              <tr>
                <td style="padding: 4px 0;"><strong>Usuario:</strong></td>
                <td style="text-align: right;">${userName}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0;"><strong>Email:</strong></td>
                <td style="text-align: right;">${userEmail}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0;"><strong>Ticket ID:</strong></td>
                <td style="text-align: right;">#${ticket.id}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; margin-top: 25px;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/dev/tickets"
               style="display: inline-block; background: linear-gradient(135deg, #8b5cf6, #d946ef); color: white; padding: 12px 30px; border-radius: 8px; text-decoration: none; font-weight: 600;">
              Ver Ticket
            </a>
          </div>
        </div>

        <div style="background: #374151; padding: 15px; border-radius: 0 0 12px 12px; text-align: center;">
          <p style="color: #9ca3af; font-size: 11px; margin: 0;">
            Sistema de Tickets QEB - Este es un mensaje automatico
          </p>
        </div>
      </div>
      `;

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || '"QEB Tickets" <no-reply@qeb.mx>',
          to: devEmail,
          subject: `[Ticket #${ticket.id}] ${titulo} - ${prioridad || 'Normal'}`,
          html: htmlBody,
        });
        console.log('Email de ticket enviado a:', devEmail);
      } catch (emailError) {
        console.error('Error enviando email de ticket:', emailError);
        // No fallamos la creacion del ticket si el email falla
      }
    }

    // Emitir evento de socket para actualizar historial y rankings
    try {
      const io = getIO();
      io.to('tickets-historial').emit(SOCKET_EVENTS.TICKET_STATUS_CHANGED, ticket);
    } catch {}

    res.status(201).json(ticket);
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ message: 'Error al crear ticket' });
  }
};

// Actualizar status del ticket (para programadores)
export const updateTicketStatus = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status, respuesta } = req.body;
    const userName = req.user?.nombre || 'Programador';

    const ticket = await prisma.tickets.findUnique({
      where: { id: Number(id) },
    });

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket no encontrado' });
    }

    const updateData: any = {
      status,
      status_cambiado_por: req.body.status_cambiado_por || userName,
    };

    if (respuesta) {
      updateData.respuesta = respuesta;
      updateData.respondido_por = userName;
      updateData.respondido_at = new Date();
    }

    const updatedTicket = await prisma.tickets.update({
      where: { id: Number(id) },
      data: updateData,
    });

    // Emitir evento de socket
    try {
      const io = getIO();
      io.to('tickets-historial').emit(SOCKET_EVENTS.TICKET_STATUS_CHANGED, updatedTicket);
    } catch {}


    // Notificar al usuario si hay respuesta
    if (respuesta && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; background: linear-gradient(135deg, #10b981, #14b8a6); padding: 25px; border-radius: 12px 12px 0 0;">
          <h1 style="color: #ffffff; margin: 0; font-size: 28px;">QEB Tickets</h1>
          <p style="color: rgba(255,255,255,0.9); margin: 5px 0 0 0; font-size: 14px;">Actualizacion de tu ticket</p>
        </div>

        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
          <div style="background: #d1fae5; border-left: 4px solid #10b981; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
            <p style="margin: 0; color: #065f46; font-size: 14px;">
              <strong>Status: ${status}</strong>
            </p>
          </div>

          <h2 style="color: #1f2937; margin: 0 0 15px 0; font-size: 18px;">Ticket #${ticket.id}: ${ticket.titulo}</h2>

          <div style="background: #f3f4f6; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <p style="color: #6b7280; font-size: 12px; margin: 0 0 8px 0; text-transform: uppercase;">Respuesta del equipo:</p>
            <p style="color: #1f2937; font-size: 14px; line-height: 1.6; margin: 0; white-space: pre-wrap;">${respuesta}</p>
          </div>

          <p style="color: #6b7280; font-size: 13px;">Respondido por: <strong>${userName}</strong></p>
        </div>

        <div style="background: #374151; padding: 15px; border-radius: 0 0 12px 12px; text-align: center;">
          <p style="color: #9ca3af; font-size: 11px; margin: 0;">
            Sistema de Tickets QEB
          </p>
        </div>
      </div>
      `;

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || '"QEB Tickets" <no-reply@qeb.mx>',
          to: ticket.usuario_email,
          subject: `[Ticket #${ticket.id}] ${status} - ${ticket.titulo}`,
          html: htmlBody,
        });
        console.log('Email de respuesta enviado a:', ticket.usuario_email);
      } catch (emailError) {
        console.error('Error enviando email de respuesta:', emailError);
      }
    }

    res.json(updatedTicket);
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ message: 'Error al actualizar ticket' });
  }
};

// ============================================================
// HISTORIAL DE TICKETS - Endpoints para usuarios autorizados
// ============================================================

// Obtener todos los tickets con info de mensajes no leidos
export const getTicketsHistorial = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { status, prioridad, search } = req.query;

    const where: any = {};
    if (status && status !== 'Todos') where.status = status;
    if (prioridad && prioridad !== 'Todos') where.prioridad = prioridad;
    if (search) {
      where.OR = [
        { titulo: { contains: search as string } },
        { descripcion: { contains: search as string } },
        { usuario_nombre: { contains: search as string } },
      ];
    }

    const tickets = await prisma.tickets.findMany({
      where,
      include: {
        mensajes: { orderBy: { id: 'desc' }, take: 1 },
        vistas: userId ? { where: { usuario_id: userId } } : false,
        chat: { orderBy: { id: 'desc' }, take: 1 },
        chat_vistas: userId ? { where: { usuario_id: userId } } : false,
        _count: { select: { mensajes: true, chat: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    // Obtener area y rol de los usuarios creadores
    const userIds = [...new Set(tickets.map((t) => t.usuario_id))];
    const usuarios = await prisma.usuario.findMany({
      where: { id: { in: userIds } },
      select: { id: true, area: true, user_role: true },
    });
    const usuarioMap = new Map(usuarios.map((u) => [u.id, u]));

    const result = tickets.map((t) => {
      const vista = Array.isArray(t.vistas) ? t.vistas[0] : null;
      const ultimoMensaje = t.mensajes[0] || null;
      const ultimoMensajeLeido = vista?.ultimo_mensaje_leido_id || 0;
      const hasUnread = ultimoMensaje ? ultimoMensaje.id > ultimoMensajeLeido : false;
      const isOpened = !!vista;

      const chatVista = Array.isArray(t.chat_vistas) ? t.chat_vistas[0] : null;
      const ultimoChat = t.chat[0] || null;
      const ultimoChatLeido = chatVista?.ultimo_mensaje_leido_id || 0;
      const hasChatUnread = ultimoChat ? ultimoChat.id > ultimoChatLeido : false;

      const usuarioInfo = usuarioMap.get(t.usuario_id);

      return {
        id: t.id,
        titulo: t.titulo,
        descripcion: t.descripcion,
        imagen: t.imagen,
        status: t.status,
        prioridad: t.prioridad,
        usuario_id: t.usuario_id,
        usuario_nombre: t.usuario_nombre,
        usuario_email: t.usuario_email,
        usuario_area: usuarioInfo?.area || null,
        usuario_role: usuarioInfo?.user_role || null,
        status_cambiado_por: t.status_cambiado_por,
        total_mensajes: t._count.mensajes,
        total_chat: t._count.chat,
        has_unread: hasUnread,
        has_chat_unread: hasChatUnread,
        is_opened: isOpened,
        created_at: t.created_at,
        updated_at: t.updated_at,
      };
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error fetching tickets historial:', error);
    res.status(500).json({ success: false, error: 'Error al obtener historial de tickets' });
  }
};

// Obtener conteo de tickets con mensajes no leidos (para badge sidebar)
// Cuenta tanto notas internas (mensajes) como chat de soporte
export const getTicketsUnreadCount = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });

    const tickets = await prisma.tickets.findMany({
      include: {
        mensajes: { orderBy: { id: 'desc' }, take: 1 },
        vistas: { where: { usuario_id: userId } },
        chat: { orderBy: { id: 'desc' }, take: 1 },
        chat_vistas: { where: { usuario_id: userId } },
      },
    });

    let unreadCount = 0;
    for (const t of tickets) {
      // Check notas internas unread
      const vista = t.vistas[0];
      const ultimoMensaje = t.mensajes[0];
      const notasUnread = ultimoMensaje && ultimoMensaje.id > (vista?.ultimo_mensaje_leido_id || 0);

      // Check chat de soporte unread
      const chatVista = t.chat_vistas[0];
      const ultimoChat = t.chat[0];
      const chatUnread = ultimoChat && ultimoChat.id > (chatVista?.ultimo_mensaje_leido_id || 0);

      if (notasUnread || chatUnread) unreadCount++;
    }

    res.json({ success: true, data: { unreadCount } });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ success: false, error: 'Error al obtener conteo' });
  }
};

// Marcar ticket como abierto/visto
export const markTicketOpened = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const ticketId = Number(req.params.id);
    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });

    await prisma.ticket_vistas.upsert({
      where: { ticket_id_usuario_id: { ticket_id: ticketId, usuario_id: userId } },
      create: { ticket_id: ticketId, usuario_id: userId, opened_at: new Date() },
      update: {},
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking ticket opened:', error);
    res.status(500).json({ success: false, error: 'Error al marcar como visto' });
  }
};

// Obtener mensajes de un ticket
export const getTicketMensajes = async (req: AuthRequest, res: Response) => {
  try {
    const ticketId = Number(req.params.id);

    const mensajes = await prisma.ticket_mensajes.findMany({
      where: { ticket_id: ticketId },
      orderBy: { created_at: 'asc' },
    });

    res.json({ success: true, data: mensajes });
  } catch (error) {
    console.error('Error fetching mensajes:', error);
    res.status(500).json({ success: false, error: 'Error al obtener mensajes' });
  }
};

// Crear mensaje en un ticket
export const createTicketMensaje = async (req: AuthRequest, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    const userId = req.user?.userId;
    const userName = req.user?.nombre || 'Usuario';
    const { mensaje, archivo_url, archivo_nombre, archivo_tipo } = req.body;

    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });
    if (!mensaje && !archivo_url) {
      return res.status(400).json({ success: false, error: 'Mensaje o archivo requerido' });
    }

    const nuevoMensaje = await prisma.ticket_mensajes.create({
      data: {
        ticket_id: ticketId,
        usuario_id: userId,
        usuario_nombre: userName,
        mensaje: mensaje || null,
        archivo_url: archivo_url || null,
        archivo_nombre: archivo_nombre || null,
        archivo_tipo: archivo_tipo || null,
      },
    });

    // Actualizar lectura del autor
    await prisma.ticket_vistas.upsert({
      where: { ticket_id_usuario_id: { ticket_id: ticketId, usuario_id: userId } },
      create: { ticket_id: ticketId, usuario_id: userId, ultimo_mensaje_leido_id: nuevoMensaje.id },
      update: { ultimo_mensaje_leido_id: nuevoMensaje.id },
    });

    // Emitir por socket
    try {
      const io = getIO();
      io.to(`ticket-${ticketId}`).emit(SOCKET_EVENTS.TICKET_MENSAJE_NUEVO, nuevoMensaje);
      io.to('tickets-historial').emit(SOCKET_EVENTS.TICKET_MENSAJE_NUEVO, { ticketId, mensaje: nuevoMensaje });
    } catch {}

    res.status(201).json({ success: true, data: nuevoMensaje });
  } catch (error) {
    console.error('Error creating mensaje:', error);
    res.status(500).json({ success: false, error: 'Error al crear mensaje' });
  }
};

// Marcar mensajes como leidos
export const markTicketMensajesRead = async (req: AuthRequest, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    const userId = req.user?.userId;
    const { ultimo_mensaje_id } = req.body;

    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });

    await prisma.ticket_vistas.upsert({
      where: { ticket_id_usuario_id: { ticket_id: ticketId, usuario_id: userId } },
      create: { ticket_id: ticketId, usuario_id: userId, ultimo_mensaje_leido_id: ultimo_mensaje_id },
      update: { ultimo_mensaje_leido_id: ultimo_mensaje_id },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking messages read:', error);
    res.status(500).json({ success: false, error: 'Error al marcar como leido' });
  }
};

// ==================== CHAT DE SOPORTE (ticket_chat) ====================

// Obtener mensajes del chat de soporte de un ticket
export const getTicketChat = async (req: AuthRequest, res: Response) => {
  try {
    const ticketId = Number(req.params.id);

    const mensajes = await prisma.ticket_chat.findMany({
      where: { ticket_id: ticketId },
      orderBy: { created_at: 'asc' },
    });

    res.json({ success: true, data: mensajes });
  } catch (error) {
    console.error('Error fetching ticket chat:', error);
    res.status(500).json({ success: false, error: 'Error al obtener chat' });
  }
};

// Crear mensaje en el chat de soporte
export const createTicketChatMessage = async (req: AuthRequest, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    const userId = req.user?.userId;
    const userName = req.user?.nombre || 'Usuario';
    const { mensaje, archivo_url, archivo_nombre, archivo_tipo } = req.body;

    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });
    if (!mensaje && !archivo_url) {
      return res.status(400).json({ success: false, error: 'Mensaje o archivo requerido' });
    }

    const nuevoMensaje = await prisma.ticket_chat.create({
      data: {
        ticket_id: ticketId,
        usuario_id: userId,
        usuario_nombre: userName,
        mensaje: mensaje || null,
        archivo_url: archivo_url || null,
        archivo_nombre: archivo_nombre || null,
        archivo_tipo: archivo_tipo || null,
      },
    });

    // Actualizar lectura del autor
    await prisma.ticket_chat_vistas.upsert({
      where: { ticket_id_usuario_id: { ticket_id: ticketId, usuario_id: userId } },
      create: { ticket_id: ticketId, usuario_id: userId, ultimo_mensaje_leido_id: nuevoMensaje.id },
      update: { ultimo_mensaje_leido_id: nuevoMensaje.id },
    });

    // Emitir por socket
    try {
      const io = getIO();
      io.to(`ticket-chat-${ticketId}`).emit(SOCKET_EVENTS.TICKET_CHAT_NUEVO, nuevoMensaje);
      io.to('tickets-historial').emit(SOCKET_EVENTS.TICKET_CHAT_NUEVO, { ticketId, mensaje: nuevoMensaje });

      // Notificar al creador del ticket (para punto rojo en sidebar)
      const ticket = await prisma.tickets.findUnique({ where: { id: ticketId }, select: { usuario_id: true } });
      if (ticket && ticket.usuario_id !== userId) {
        io.to(`user-notifications-${ticket.usuario_id}`).emit(SOCKET_EVENTS.TICKET_CHAT_NUEVO, { ticketId });
      }
    } catch {}

    res.status(201).json({ success: true, data: nuevoMensaje });
  } catch (error) {
    console.error('Error creating chat message:', error);
    res.status(500).json({ success: false, error: 'Error al crear mensaje de chat' });
  }
};

// Marcar mensajes del chat como leidos
export const markTicketChatRead = async (req: AuthRequest, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    const userId = req.user?.userId;
    const { ultimo_mensaje_id } = req.body;

    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });

    await prisma.ticket_chat_vistas.upsert({
      where: { ticket_id_usuario_id: { ticket_id: ticketId, usuario_id: userId } },
      create: { ticket_id: ticketId, usuario_id: userId, ultimo_mensaje_leido_id: ultimo_mensaje_id },
      update: { ultimo_mensaje_leido_id: ultimo_mensaje_id },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking chat read:', error);
    res.status(500).json({ success: false, error: 'Error al marcar chat como leido' });
  }
};

// Obtener conteo de chats no leidos para un ticket (para el creador del ticket)
export const getTicketChatUnreadCount = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });

    // Solo contar para tickets del usuario actual
    const tickets = await prisma.tickets.findMany({
      where: { usuario_id: userId },
      include: {
        chat: { orderBy: { id: 'desc' }, take: 1 },
        chat_vistas: { where: { usuario_id: userId } },
      },
    });

    let unreadCount = 0;
    for (const t of tickets) {
      const vista = t.chat_vistas[0];
      const ultimoChat = t.chat[0];
      if (ultimoChat) {
        const ultimoLeido = vista?.ultimo_mensaje_leido_id || 0;
        if (ultimoChat.id > ultimoLeido) unreadCount++;
      }
    }

    res.json({ success: true, data: { unreadCount } });
  } catch (error) {
    console.error('Error fetching chat unread count:', error);
    res.status(500).json({ success: false, error: 'Error al obtener conteo' });
  }
};

// Obtener rankings de tickets (solo DEV team)
export const getTicketRankings = async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.rol !== 'DEV') {
      return res.status(403).json({ success: false, error: 'Acceso denegado' });
    }

    const allTickets = await prisma.tickets.findMany({
      select: {
        id: true,
        usuario_id: true,
        usuario_nombre: true,
        status: true,
        prioridad: true,
        status_cambiado_por: true,
        created_at: true,
        updated_at: true,
      },
    });

    // Ranking: usuarios que mas tickets crearon
    const creadorMap = new Map<string, { nombre: string; count: number }>();
    for (const t of allTickets) {
      const entry = creadorMap.get(t.usuario_nombre) || { nombre: t.usuario_nombre, count: 0 };
      entry.count++;
      creadorMap.set(t.usuario_nombre, entry);
    }
    const topCreadores = [...creadorMap.values()].sort((a, b) => b.count - a.count);

    // Ranking: tecnicos que mas tickets resolvieron (Resuelto o Cerrado)
    const resueltos = allTickets.filter((t) => ['Resuelto', 'Cerrado'].includes(t.status) && t.status_cambiado_por);
    const tecnicoMap = new Map<string, { nombre: string; count: number }>();
    for (const t of resueltos) {
      const nombre = t.status_cambiado_por!.trim();
      const entry = tecnicoMap.get(nombre) || { nombre, count: 0 };
      entry.count++;
      tecnicoMap.set(nombre, entry);
    }
    const topTecnicos = [...tecnicoMap.values()].sort((a, b) => b.count - a.count);

    // Ranking divertido: tickets mas urgentes por usuario
    const urgenteMap = new Map<string, { nombre: string; count: number }>();
    for (const t of allTickets.filter((t) => t.prioridad === 'Urgente')) {
      const entry = urgenteMap.get(t.usuario_nombre) || { nombre: t.usuario_nombre, count: 0 };
      entry.count++;
      urgenteMap.set(t.usuario_nombre, entry);
    }
    const topUrgentes = [...urgenteMap.values()].sort((a, b) => b.count - a.count);

    // Ranking divertido: tickets por hora del dia
    const horaMap = new Map<number, number>();
    for (const t of allTickets) {
      const hora = new Date(t.created_at).getHours();
      horaMap.set(hora, (horaMap.get(hora) || 0) + 1);
    }
    const ticketsPorHora = [...horaMap.entries()].map(([hora, count]) => ({ hora, count })).sort((a, b) => b.count - a.count);

    // Ranking divertido: dia de la semana con mas tickets
    const diaNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const diaMap = new Map<number, number>();
    for (const t of allTickets) {
      const dia = new Date(t.created_at).getDay();
      diaMap.set(dia, (diaMap.get(dia) || 0) + 1);
    }
    const ticketsPorDia = [...diaMap.entries()].map(([dia, count]) => ({ dia: diaNames[dia], count })).sort((a, b) => b.count - a.count);

    // Ranking: velocidad promedio de resolucion por tecnico (en horas)
    const velocidadMap = new Map<string, { nombre: string; totalHoras: number; count: number }>();
    for (const t of resueltos) {
      const nombre = t.status_cambiado_por!.trim();
      const horas = (new Date(t.updated_at).getTime() - new Date(t.created_at).getTime()) / 3600000;
      const entry = velocidadMap.get(nombre) || { nombre, totalHoras: 0, count: 0 };
      entry.totalHoras += horas;
      entry.count++;
      velocidadMap.set(nombre, entry);
    }
    const velocidadTecnicos = [...velocidadMap.values()]
      .map((v) => ({ nombre: v.nombre, promedio_horas: Math.round(v.totalHoras / v.count * 10) / 10 }))
      .sort((a, b) => a.promedio_horas - b.promedio_horas);

    // Ranking: usuarios reincidentes (mas tickets repetidos en 7 dias)
    const reincidenteMap = new Map<string, { nombre: string; count: number }>();
    const ticketsByUser = new Map<string, Date[]>();
    for (const t of allTickets) {
      const dates = ticketsByUser.get(t.usuario_nombre) || [];
      dates.push(new Date(t.created_at));
      ticketsByUser.set(t.usuario_nombre, dates);
    }
    for (const [nombre, dates] of ticketsByUser) {
      dates.sort((a, b) => a.getTime() - b.getTime());
      let streakCount = 0;
      for (let i = 1; i < dates.length; i++) {
        if (dates[i].getTime() - dates[i - 1].getTime() < 7 * 24 * 3600000) streakCount++;
      }
      if (streakCount > 0) reincidenteMap.set(nombre, { nombre, count: streakCount });
    }
    const topReincidentes = [...reincidenteMap.values()].sort((a, b) => b.count - a.count);

    // Ranking por area
    const userIds = [...new Set(allTickets.map((t) => t.usuario_id))];
    const usuarios = await prisma.usuario.findMany({
      where: { id: { in: userIds } },
      select: { id: true, area: true, user_role: true },
    });
    const usuarioMap = new Map(usuarios.map((u) => [u.id, u]));

    const areaMap = new Map<string, number>();
    const roleMap = new Map<string, number>();
    for (const t of allTickets) {
      const info = usuarioMap.get(t.usuario_id);
      if (info?.area) areaMap.set(info.area, (areaMap.get(info.area) || 0) + 1);
      if (info?.user_role) roleMap.set(info.user_role, (roleMap.get(info.user_role) || 0) + 1);
    }
    const topAreas = [...areaMap.entries()].map(([nombre, count]) => ({ nombre, count })).sort((a, b) => b.count - a.count);
    const topRoles = [...roleMap.entries()].map(([nombre, count]) => ({ nombre, count })).sort((a, b) => b.count - a.count);

    // Empleado del mes: tecnico con mas tickets cerrados, con foto de perfil
    let empleadoDelMes: { nombre: string; count: number; foto_perfil: string | null } | null = null;
    if (topTecnicos.length > 0) {
      const topNombre = topTecnicos[0].nombre;
      const topUsuario = await prisma.usuario.findFirst({
        where: { nombre: { contains: topNombre }, deleted_at: null },
        select: { nombre: true, foto_perfil: true },
      });
      empleadoDelMes = {
        nombre: topTecnicos[0].nombre,
        count: topTecnicos[0].count,
        foto_perfil: topUsuario?.foto_perfil || null,
      };
    }

    res.json({
      success: true,
      data: {
        empleadoDelMes,
        topCreadores,
        topTecnicos,
        topUrgentes,
        ticketsPorHora,
        ticketsPorDia,
        velocidadTecnicos,
        topReincidentes,
        topAreas,
        topRoles,
        totalTickets: allTickets.length,
        totalResueltos: resueltos.length,
      },
    });
  } catch (error) {
    console.error('Error fetching rankings:', error);
    res.status(500).json({ success: false, error: 'Error al obtener rankings' });
  }
};

// Obtener estadisticas de tickets
export const getTicketStats = async (req: AuthRequest, res: Response) => {
  try {
    const [total, nuevo, enProgreso, resuelto, cerrado] = await Promise.all([
      prisma.tickets.count(),
      prisma.tickets.count({ where: { status: 'Nuevo' } }),
      prisma.tickets.count({ where: { status: 'En Progreso' } }),
      prisma.tickets.count({ where: { status: 'Resuelto' } }),
      prisma.tickets.count({ where: { status: 'Cerrado' } }),
    ]);

    res.json({
      total,
      nuevo,
      enProgreso,
      resuelto,
      cerrado,
    });
  } catch (error) {
    console.error('Error fetching ticket stats:', error);
    res.status(500).json({ message: 'Error al obtener estadisticas' });
  }
};
