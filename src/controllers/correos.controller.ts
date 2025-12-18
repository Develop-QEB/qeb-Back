import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';

const prisma = new PrismaClient();

// Configurar transporter de nodemailer
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465', // true para 465, false para otros
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false, // Permitir certificados auto-firmados
  },
});

// Obtener correos del usuario actual (por su email)
export const getCorreos = async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).user?.correo_electronico;

    if (!userEmail) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const { page = 1, limit = 50, search, leido } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {
      destinatario: userEmail,
    };

    if (search) {
      where.OR = [
        { asunto: { contains: search as string } },
        { cuerpo: { contains: search as string } },
        { remitente: { contains: search as string } },
      ];
    }

    if (leido !== undefined && leido !== '') {
      where.leido = leido === 'true';
    }

    const [correos, total] = await Promise.all([
      prisma.correos_enviados.findMany({
        where,
        orderBy: { fecha_envio: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.correos_enviados.count({ where }),
    ]);

    res.json({
      data: correos,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching correos:', error);
    res.status(500).json({ message: 'Error al obtener correos' });
  }
};

// Obtener un correo por ID
export const getCorreoById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userEmail = (req as any).user?.correo_electronico;

    const correo = await prisma.correos_enviados.findFirst({
      where: {
        id: Number(id),
        destinatario: userEmail, // Solo puede ver sus propios correos
      },
    });

    if (!correo) {
      return res.status(404).json({ message: 'Correo no encontrado' });
    }

    // Marcar como leído
    if (!correo.leido) {
      await prisma.correos_enviados.update({
        where: { id: Number(id) },
        data: { leido: true },
      });
    }

    res.json(correo);
  } catch (error) {
    console.error('Error fetching correo:', error);
    res.status(500).json({ message: 'Error al obtener correo' });
  }
};

// Obtener estadísticas de correos
export const getCorreosStats = async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).user?.correo_electronico;

    if (!userEmail) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const [total, noLeidos] = await Promise.all([
      prisma.correos_enviados.count({
        where: { destinatario: userEmail },
      }),
      prisma.correos_enviados.count({
        where: { destinatario: userEmail, leido: false },
      }),
    ]);

    res.json({
      total,
      no_leidos: noLeidos,
    });
  } catch (error) {
    console.error('Error fetching correos stats:', error);
    res.status(500).json({ message: 'Error al obtener estadísticas' });
  }
};

// Marcar correo como leído/no leído
export const toggleLeido = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userEmail = (req as any).user?.correo_electronico;

    const correo = await prisma.correos_enviados.findFirst({
      where: {
        id: Number(id),
        destinatario: userEmail,
      },
    });

    if (!correo) {
      return res.status(404).json({ message: 'Correo no encontrado' });
    }

    const updated = await prisma.correos_enviados.update({
      where: { id: Number(id) },
      data: { leido: !correo.leido },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error toggling leido:', error);
    res.status(500).json({ message: 'Error al actualizar correo' });
  }
};

// Crear un nuevo correo (para uso interno del sistema)
export const createCorreo = async (req: Request, res: Response) => {
  try {
    const { remitente, destinatario, asunto, cuerpo } = req.body;

    if (!destinatario || !asunto || !cuerpo) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }

    const correo = await prisma.correos_enviados.create({
      data: {
        remitente: remitente || 'no-reply@qeb.mx',
        destinatario,
        asunto,
        cuerpo,
      },
    });

    res.status(201).json(correo);
  } catch (error) {
    console.error('Error creating correo:', error);
    res.status(500).json({ message: 'Error al crear correo' });
  }
};

// Enviar PIN de autorización por email
export const sendAuthorizationPIN = async (req: Request, res: Response) => {
  try {
    const { codigo, solicitante, campana } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL || 'Develop@qeb.mx';

    if (!codigo || !solicitante) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }

    const fecha = new Date().toLocaleString('es-MX', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">

      <!-- Header -->
      <div style="text-align: center; background: #8b5cf6; padding: 25px; border-radius: 12px 12px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px;">QEB</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 5px 0 0 0; font-size: 12px;">OOH Management</p>
      </div>

      <!-- Contenido -->
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">

        <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px; text-align: center;">
          Código de Autorización
        </h2>

        <p style="color: #6b7280; font-size: 14px; line-height: 1.6; margin: 0 0 25px 0; text-align: center;">
          <strong>${solicitante}</strong> ha solicitado autorización para realizar una acción en el sistema.
        </p>

        <!-- Código PIN -->
        <div style="background: #f3f4f6; border-radius: 8px; padding: 25px; text-align: center; margin-bottom: 25px;">
          <p style="color: #6b7280; font-size: 12px; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 1px;">
            Código de verificación
          </p>
          <div style="font-size: 40px; font-weight: 700; color: #8b5cf6; letter-spacing: 10px; font-family: 'Courier New', monospace;">
            ${codigo}
          </div>
        </div>

        <!-- Advertencia -->
        <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
          <p style="margin: 0; color: #92400e; font-size: 13px;">
            <strong>Este código expira en 2 minutos.</strong><br>
            Solo compártelo si reconoces al solicitante.
          </p>
        </div>

        <!-- Info adicional -->
        <div style="border-top: 1px solid #e5e7eb; padding-top: 20px;">
          <table style="width: 100%; font-size: 13px; color: #6b7280;">
            <tr>
              <td style="padding: 4px 0;"><strong>Solicitante:</strong></td>
              <td style="text-align: right;">${solicitante}</td>
            </tr>
            <tr>
              <td style="padding: 4px 0;"><strong>Fecha:</strong></td>
              <td style="text-align: right;">${fecha}</td>
            </tr>
            <tr>
              <td style="padding: 4px 0;"><strong>Campaña:</strong></td>
              <td style="text-align: right;">${campana || '-'}</td>
            </tr>
          </table>
        </div>

      </div>

      <!-- Footer -->
      <div style="background: #374151; padding: 15px; border-radius: 0 0 12px 12px; text-align: center;">
        <p style="color: #9ca3af; font-size: 11px; margin: 0;">
          Mensaje automático del sistema QEB. No responda a este correo.
        </p>
      </div>

    </div>
    `;

    // Intentar enviar email real
    try {
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
          to: adminEmail,
          subject: `Código de Autorización QEB - ${solicitante}`,
          html: htmlBody,
        });
        console.log('Email enviado exitosamente a:', adminEmail);
      } else {
        console.log('SMTP no configurado, guardando solo en BD');
      }
    } catch (emailError) {
      console.error('Error enviando email:', emailError);
      // Continuar aunque falle el envío real
    }

    // Guardar en la base de datos
    await prisma.correos_enviados.create({
      data: {
        remitente: 'no-reply@qeb.mx',
        destinatario: adminEmail,
        asunto: `Código de Autorización QEB - ${solicitante}`,
        cuerpo: htmlBody,
      },
    });

    res.json({
      success: true,
      message: 'Código enviado al administrador',
    });
  } catch (error) {
    console.error('Error sending authorization PIN:', error);
    res.status(500).json({ message: 'Error al enviar código de autorización' });
  }
};
