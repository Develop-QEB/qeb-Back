import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';

const prisma = new PrismaClient();

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

interface AuthRequest extends Request {
  user?: {
    id: number;
    nombre: string;
    correo_electronico: string;
    rol: string;
  };
}

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
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const tickets = await prisma.tickets.findMany({
      where: { usuario_id: userId },
      orderBy: { created_at: 'desc' },
    });

    res.json({ data: tickets });
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
    const userId = req.user?.id;
    const userName = req.user?.nombre || 'Usuario';
    const userEmail = req.user?.correo_electronico || '';

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
