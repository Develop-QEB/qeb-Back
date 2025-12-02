import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
        remitente: remitente || 'noreply@qeb.com.mx',
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
