import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import { getMexicoDate } from '../utils/dateHelper';
import {
  calcularEstadoAutorizacion,
  verificarCarasPendientes,
  crearTareasAutorizacion,
  obtenerResumenAutorizacion
} from '../services/autorizacion.service';
import { emitToSolicitudes, emitToDashboard, emitToCampanas, emitToAll, SOCKET_EVENTS } from '../config/socket';
import { hasFullVisibility, hasTeamVisibility, getTeamMemberIds } from '../utils/permissions';
import nodemailer from 'nodemailer';
import { uploadBufferToSpaces } from '../config/spaces';
import { serializeBigInt } from '../utils/serialization';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false },
});

async function enviarCorreoTarea(
  tareaId: number,
  titulo: string,
  descripcion: string,
  fechaFin: Date,
  destinatarioEmail: string,
  destinatarioNombre: string,
  datosAdicionales: {
    cliente?: string;
    producto?: string;
    creador?: string;
    periodoInicio?: string;
    periodoFin?: string;
    idSolicitud?: number;
    idPropuesta?: number;
    idCampania?: number;
  } = {},
  linkUrl?: string
): Promise<void> {
  const formatearFecha = (fecha: Date) => fecha.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  const htmlBody = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
      <tr>
        <td align="center">
          <table width="500" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            
            <!-- Header -->
            <tr>
              <td style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">QEB</h1>
                <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">OOH Management</p>
              </td>
            </tr>

            <!-- Main Content -->
            <tr>
              <td style="padding: 40px;">
                
                <!-- Title -->
                <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Nueva Tarea Asignada</h2>
                <p style="color: #6b7280; margin: 0 0 12px 0; font-size: 15px; line-height: 1.5;">
                  Hola <strong style="color: #374151;">${destinatarioNombre}</strong>, se te ha asignado una nueva tarea.
                </p>
                <div style="background-color: #f5f3ff; border-left: 4px solid #8b5cf6; padding: 14px 16px; border-radius: 0 8px 8px 0; margin: 0 0 24px 0;">
                  <p style="color: #6b7280; margin: 0 0 4px 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Tarea</p>
                  <p style="color: #1f2937; margin: 0; font-size: 16px; font-weight: 600;">${descripcion}</p>
                </div>

                <!-- Info Grid -->
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 28px;">
                  ${datosAdicionales.cliente ? `
                  <tr>
                    <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="24" valign="top">
                            <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">🏢</div>
                          </td>
                          <td style="padding-left: 12px;">
                            <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Cliente</p>
                            <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${datosAdicionales.cliente}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ` : ''}
                  
                  ${datosAdicionales.producto ? `
                  <tr>
                    <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="24" valign="top">
                            <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">📦</div>
                          </td>
                          <td style="padding-left: 12px;">
                            <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Producto</p>
                            <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${datosAdicionales.producto}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ` : ''}

                  ${datosAdicionales.creador ? `
                  <tr>
                    <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="24" valign="top">
                            <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">✨</div>
                          </td>
                          <td style="padding-left: 12px;">
                            <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Creado por</p>
                            <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${datosAdicionales.creador}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ` : ''}

                  <tr>
                    <td style="padding: 12px 0;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="24" valign="top">
                            <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">📅</div>
                          </td>
                          <td style="padding-left: 12px;">
                            <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Período</p>
                            <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">
                              ${datosAdicionales.periodoInicio && datosAdicionales.periodoFin 
                                ? `${datosAdicionales.periodoInicio} → ${datosAdicionales.periodoFin}` 
                                : 'Sin período definido'}
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                ${(datosAdicionales.idSolicitud || datosAdicionales.idPropuesta || datosAdicionales.idCampania) ? `
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 10px 14px; background-color: #f9fafb; border-radius: 8px;">
                      <p style="color: #9ca3af; margin: 0 0 4px 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Referencia</p>
                      <p style="color: #374151; margin: 0; font-size: 13px; font-weight: 500;">${[
                        datosAdicionales.idSolicitud ? `Solicitud #${datosAdicionales.idSolicitud}` : '',
                        datosAdicionales.idPropuesta ? `Propuesta #${datosAdicionales.idPropuesta}` : '',
                        datosAdicionales.idCampania ? `Campaña #${datosAdicionales.idCampania}` : '',
                      ].filter(Boolean).join('  ·  ')}</p>
                    </td>
                  </tr>
                </table>
                ` : ''}

                <!-- CTA Button -->
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="${linkUrl || `https://app.qeb.mx/solicitudes?viewId=${tareaId}`}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">${datosAdicionales.idCampania ? 'Ver Campaña' : linkUrl ? 'Ver Propuesta' : 'Ver Solicitud'}</a>
                    </td>
                  </tr>
                </table>

              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color: #1f2937; padding: 24px 40px; text-align: center;">
                <p style="color: #9ca3af; font-size: 12px; margin: 0;">Mensaje automático del sistema QEB.</p>
                <p style="color: #6b7280; font-size: 11px; margin: 8px 0 0 0;">© ${new Date().getFullYear()} QEB OOH Management</p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
      to: destinatarioEmail,
      subject: `Nueva tarea: ${titulo}`,
      html: htmlBody,
    });

    await prisma.correos_enviados.create({
      data: {
        remitente: 'no-reply@qeb.mx',
        destinatario: destinatarioEmail,
        asunto: `Nueva tarea: ${titulo}`,
        cuerpo: htmlBody,
      },
    });
  }
}

async function enviarCorreoNotificacion(
  solicitudId: number,
  titulo: string,
  descripcion: string,
  destinatarioEmail: string,
  destinatarioNombre: string,
  datosAdicionales: {
    accion?: string;
    usuario?: string;
    cliente?: string;
  } = {}
): Promise<void> {
  const htmlBody = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
      <tr>
        <td align="center">
          <table width="500" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            
            <!-- Header -->
            <tr>
              <td style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">QEB</h1>
                <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">OOH Management</p>
              </td>
            </tr>

            <!-- Main Content -->
            <tr>
              <td style="padding: 40px;">
                
                <!-- Title -->
                <div style="display: flex; align-items: center; margin-bottom: 8px;">
                  <span style="display: inline-block; background-color: #fef3c7; color: #92400e; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">🔔 Notificación</span>
                </div>
                <h2 style="color: #1f2937; margin: 12px 0 8px 0; font-size: 20px; font-weight: 600;">${titulo}</h2>
                <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 15px; line-height: 1.5;">
                  Hola <strong style="color: #374151;">${destinatarioNombre}</strong>, tienes una nueva notificación.
                </p>

                <!-- Notification Card -->
                <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fffbeb; border-radius: 12px; border: 1px solid #fde68a; margin-bottom: 24px;">
                  <tr>
                    <td style="padding: 20px;">
                      <p style="color: #92400e; margin: 0; font-size: 14px; line-height: 1.6;">${descripcion}</p>
                    </td>
                  </tr>
                </table>

                <!-- Info Grid -->
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 28px;">
                  ${datosAdicionales.usuario ? `
                  <tr>
                    <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="24" valign="top">
                            <div style="width: 20px; height: 20px; background-color: #fef3c7; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">👤</div>
                          </td>
                          <td style="padding-left: 12px;">
                            <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Realizado por</p>
                            <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${datosAdicionales.usuario}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ` : ''}

                  ${datosAdicionales.cliente ? `
                  <tr>
                    <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="24" valign="top">
                            <div style="width: 20px; height: 20px; background-color: #fef3c7; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">🏢</div>
                          </td>
                          <td style="padding-left: 12px;">
                            <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Cliente</p>
                            <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${datosAdicionales.cliente}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ` : ''}

                  ${datosAdicionales.accion ? `
                  <tr>
                    <td style="padding: 12px 0;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="24" valign="top">
                            <div style="width: 20px; height: 20px; background-color: #fef3c7; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">⚡</div>
                          </td>
                          <td style="padding-left: 12px;">
                            <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Acción</p>
                            <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${datosAdicionales.accion}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ` : ''}
                </table>

                <!-- CTA Button -->
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="https://app.qeb.mx/solicitudes?viewId=${solicitudId}" style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4);">Ver en QEB</a>
                    </td>
                  </tr>
                </table>

              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color: #1f2937; padding: 24px 40px; text-align: center;">
                <p style="color: #9ca3af; font-size: 12px; margin: 0;">Mensaje automático del sistema QEB.</p>
                <p style="color: #6b7280; font-size: 11px; margin: 8px 0 0 0;">© ${new Date().getFullYear()} QEB OOH Management</p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
      to: destinatarioEmail,
      subject: `🔔 ${titulo}`,
      html: htmlBody,
    });

    await prisma.correos_enviados.create({
      data: {
        remitente: 'no-reply@qeb.mx',
        destinatario: destinatarioEmail,
        asunto: `🔔 ${titulo}`,
        cuerpo: htmlBody,
      },
    });
  }
}


export class SolicitudesController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;
      const search = req.query.search as string;
      const yearInicio = req.query.yearInicio as string;
      const yearFin = req.query.yearFin as string;
      const catorcenaInicio = req.query.catorcenaInicio as string;
      const catorcenaFin = req.query.catorcenaFin as string;
      const sortBy = req.query.sortBy as string;
      const sortOrder = (req.query.sortOrder as string) || 'desc';
      const groupBy = req.query.groupBy as string;
      const tipoPeriodo = req.query.tipoPeriodo as string;

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      if (status) {
        where.status = status;
      }

      // Search filter
      if (search) {
        const orConditions: any[] = [
          { razon_social: { contains: search } },
          { descripcion: { contains: search } },
          { marca_nombre: { contains: search } },
          { asignado: { contains: search } },
          { cuic: { contains: search } },
          { nombre_usuario: { contains: search } },
        ];
        const searchAsInt = parseInt(search);
        if (!isNaN(searchAsInt)) {
          orConditions.push({ id: searchAsInt });
        }
        where.OR = orConditions;
      }

      // Year range and catorcena filter — filter by cotizacion period dates, not solicitud.fecha
      let filterFechaInicio: Date | null = null;
      let filterFechaFin: Date | null = null;

      if (yearInicio && yearFin && catorcenaInicio && catorcenaFin) {
        const catorcenasInicioData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearInicio),
            numero_catorcena: parseInt(catorcenaInicio),
          },
        });
        const catorcenasFinData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearFin),
            numero_catorcena: parseInt(catorcenaFin),
          },
        });

        if (catorcenasInicioData && catorcenasFinData) {
          filterFechaInicio = catorcenasInicioData.fecha_inicio;
          filterFechaFin = catorcenasFinData.fecha_fin;
          const periodIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT DISTINCT s.id FROM solicitud s
             INNER JOIN propuesta pr ON pr.solicitud_id = s.id
             INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
             WHERE s.deleted_at IS NULL
               AND ct.fecha_inicio <= ?
               AND ct.fecha_fin >= ?`,
            catorcenasFinData.fecha_fin,
            catorcenasInicioData.fecha_inicio
          );
          if (periodIds.length > 0) {
            where.id = { ...(where.id as any), in: periodIds.map(r => r.id) };
          } else {
            where.id = { in: [] };
          }
        }
      } else if (yearInicio && yearFin) {
        const periodIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
          `SELECT DISTINCT s.id FROM solicitud s
           INNER JOIN propuesta pr ON pr.solicitud_id = s.id
           INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
           WHERE s.deleted_at IS NULL
             AND ct.fecha_inicio <= ?
             AND ct.fecha_fin >= ?`,
          new Date(`${yearFin}-12-31`),
          new Date(`${yearInicio}-01-01`)
        );
        if (periodIds.length > 0) {
          where.id = { ...(where.id as any), in: periodIds.map(r => r.id) };
        } else {
          where.id = { in: [] };
        }
      } else if (yearInicio) {
        const periodIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
          `SELECT DISTINCT s.id FROM solicitud s
           INNER JOIN propuesta pr ON pr.solicitud_id = s.id
           INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
           WHERE s.deleted_at IS NULL
             AND ct.fecha_inicio <= ?
             AND ct.fecha_fin >= ?`,
          new Date(`${yearInicio}-12-31`),
          new Date(`${yearInicio}-01-01`)
        );
        if (periodIds.length > 0) {
          where.id = { ...(where.id as any), in: periodIds.map(r => r.id) };
        } else {
          where.id = { in: [] };
        }
      }

      // Visibility filter: non-leadership roles only see their own records
      const userId = req.user?.userId;
      const userRol = req.user?.rol || '';
      if (userId && !hasFullVisibility(userRol)) {
        let visibleIds: { id: number }[];
        if (hasTeamVisibility(userRol)) {
          // Asesor Analista: ve lo propio + lo de miembros de su red de trabajo
          const teamIds = await getTeamMemberIds(prisma, userId);
          const placeholders = teamIds.map(() => '?').join(',');
          visibleIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT id FROM solicitud
             WHERE deleted_at IS NULL
               AND (usuario_id IN (${placeholders}) OR FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0)`,
            ...teamIds, String(userId)
          );
        } else {
          visibleIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT id FROM solicitud
             WHERE deleted_at IS NULL
               AND (usuario_id = ? OR FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0)`,
            userId, String(userId)
          );
        }
        const visibleSet = new Set(visibleIds.map(r => r.id));
        // Intersect with period filter if both are active
        const existingIn = (where.id as any)?.in as number[] | undefined;
        if (existingIn) {
          where.id = { in: existingIn.filter(id => visibleSet.has(id)) };
        } else {
          where.id = { in: visibleIds.map(r => r.id) };
        }
      }

      // Build orderBy
      let orderBy: Record<string, string> = { fecha: 'desc' };
      if (sortBy) {
        orderBy = { [sortBy]: sortOrder };
      }

      const [solicitudes, total] = await Promise.all([
        prisma.solicitud.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy,
        }),
        prisma.solicitud.count({ where }),
      ]);

      // Enrich solicitudes with cotizacion data (tipo_periodo, dates, catorcenas)
      let enrichedSolicitudes: unknown[] = solicitudes;
      const solicitudIds = solicitudes.map(s => s.id);
      if (solicitudIds.length > 0) {
        const placeholders = solicitudIds.map(() => '?').join(',');
        const enrichmentData = await prisma.$queryRawUnsafe<any[]>(`
          SELECT
            s.id as solicitud_id,
            ct.tipo_periodo,
            ct.nombre_campania,
            COALESCE(MIN(sc.inicio_periodo), ct.fecha_inicio) as periodo_fecha_inicio,
            COALESCE(MAX(sc.inicio_periodo), ct.fecha_inicio) as periodo_fecha_fin,
            cat_ini.numero_catorcena as catorcena_inicio,
            cat_ini.año as anio_inicio,
            cat_fin.numero_catorcena as catorcena_fin,
            cat_fin.año as anio_fin,
            GROUP_CONCAT(DISTINCT NULLIF(sc.formato, '') ORDER BY sc.formato SEPARATOR ', ') as formatos
          FROM solicitud s
          LEFT JOIN propuesta pr ON pr.solicitud_id = s.id
          LEFT JOIN cotizacion ct ON ct.id_propuesta = pr.id
          LEFT JOIN solicitudCaras sc ON CAST(sc.idquote AS UNSIGNED) = pr.id
          LEFT JOIN catorcenas cat_ini ON ct.fecha_inicio BETWEEN cat_ini.fecha_inicio AND cat_ini.fecha_fin
          LEFT JOIN catorcenas cat_fin ON ct.fecha_fin BETWEEN cat_fin.fecha_inicio AND cat_fin.fecha_fin
          WHERE s.id IN (${placeholders})
          GROUP BY s.id
        `, ...solicitudIds);

        const enrichMap = new Map(enrichmentData.map((e: any) => [Number(e.solicitud_id), e]));

        enrichedSolicitudes = solicitudes.map(s => {
          const extra = enrichMap.get(s.id);
          return {
            ...s,
            tipo_periodo: extra?.tipo_periodo || null,
            nombre_campania: extra?.nombre_campania || null,
            periodo_fecha_inicio: extra?.periodo_fecha_inicio || null,
            periodo_fecha_fin: extra?.periodo_fecha_fin || null,
            catorcena_inicio: extra?.catorcena_inicio ? Number(extra.catorcena_inicio) : null,
            anio_inicio: extra?.anio_inicio ? Number(extra.anio_inicio) : null,
            catorcena_fin: extra?.catorcena_fin ? Number(extra.catorcena_fin) : null,
            anio_fin: extra?.anio_fin ? Number(extra.anio_fin) : null,
            formatos: extra?.formatos || null,
          };
        });

        // Filter by tipoPeriodo if requested
        if (tipoPeriodo && tipoPeriodo !== 'todas') {
          enrichedSolicitudes = enrichedSolicitudes.filter((s: any) => {
            const tp = s.tipo_periodo || 'catorcena';
            return tp === tipoPeriodo;
          });
        }

        // Recalculate presupuesto based on catorcena filter (sum only overlapping caras)
        if (filterFechaInicio && filterFechaFin) {
          const presupuestoData = await prisma.$queryRawUnsafe<{ solicitud_id: number; presupuesto_filtrado: number }[]>(`
            SELECT s.id as solicitud_id, COALESCE(SUM(sc.costo), 0) as presupuesto_filtrado
            FROM solicitud s
            LEFT JOIN propuesta pr ON pr.solicitud_id = s.id
            LEFT JOIN solicitudCaras sc ON CAST(sc.idquote AS UNSIGNED) = pr.id
              AND sc.inicio_periodo <= ?
              AND sc.fin_periodo >= ?
            WHERE s.id IN (${placeholders})
            GROUP BY s.id
          `, filterFechaFin, filterFechaInicio, ...solicitudIds);

          const presupuestoMap = new Map(presupuestoData.map((p: any) => [Number(p.solicitud_id), Number(p.presupuesto_filtrado)]));
          enrichedSolicitudes = enrichedSolicitudes.map((s: any) => ({
            ...s,
            presupuesto: presupuestoMap.get(s.id) ?? s.presupuesto,
          }));
        }
      }

      // Group data if requested
      let groupedData = null;
      if (groupBy && ['status', 'marca_nombre', 'asignado', 'razon_social', 'asesor', 'nombre_usuario'].includes(groupBy)) {
        const grouped = await prisma.solicitud.groupBy({
          by: [groupBy as 'status' | 'marca_nombre' | 'asignado' | 'razon_social' | 'asesor' | 'nombre_usuario'],
          where,
          _count: true,
        });
        groupedData = grouped;
      }

      res.json({
        success: true,
        data: enrichedSolicitudes,
        groupedData,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener solicitudes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const solicitud = await prisma.solicitud.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!solicitud) {
        res.status(404).json({
          success: false,
          error: 'Solicitud no encontrada',
        });
        return;
      }

      // Fallback SAP codes from cliente when solicitud has nulls
      if (!solicitud.card_code || !solicitud.salesperson_code || !solicitud.sap_database) {
        const cliente = await prisma.cliente.findUnique({ where: { id: solicitud.cliente_id } });
        if (cliente) {
          (solicitud as any).card_code = solicitud.card_code || cliente.card_code;
          (solicitud as any).salesperson_code = solicitud.salesperson_code || cliente.salesperson_code;
          (solicitud as any).sap_database = solicitud.sap_database || cliente.sap_database;
        }
      }

      // Get related propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });

      // Get related cotizacion
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;

      // Get related campania (exclude posted_aps - column may not exist in production)
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
        select: {
          id: true,
          cliente_id: true,
          nombre: true,
          fecha_inicio: true,
          fecha_fin: true,
          total_caras: true,
          bonificacion: true,
          status: true,
          cotizacion_id: true,
          articulo: true,
          fecha_aprobacion: true,
          posted_to_sap: true,
        },
      }) : null;

      // Get solicitudCaras by propuesta id (idquote)
      const caras = propuesta ? await prisma.solicitudCaras.findMany({
        where: { idquote: propuesta.id.toString() },
      }) : [];

      // Get comentarios
      const comentarios = await prisma.comentarios.findMany({
        where: { solicitud_id: solicitud.id },
        orderBy: { creado_en: 'desc' },
      });

      // Get autor names and photos for comentarios
      const autorIds = [...new Set(comentarios.map(c => c.autor_id))].filter(id => id != null);
      const autores = autorIds.length > 0 ? await prisma.usuario.findMany({
        where: { id: { in: autorIds } },
        select: { id: true, nombre: true, foto_perfil: true },
      }) : [];
      const autoresMap = new Map(autores.map(a => [a.id, { nombre: a.nombre, foto_perfil: a.foto_perfil }]));

      const comentariosWithAuthor = comentarios.map(c => ({
        ...c,
        autor_nombre: c.autor_id ? (autoresMap.get(c.autor_id)?.nombre || 'Usuario desconocido') : 'Sistema',
        autor_foto: c.autor_id ? (autoresMap.get(c.autor_id)?.foto_perfil || null) : null,
      }));

      // Get historial
      const historial = await prisma.historial.findMany({
        where: { ref_id: solicitud.id, tipo: 'Solicitud' },
        orderBy: { fecha_hora: 'desc' },
      });

      res.json(serializeBigInt({
        success: true,
        data: {
          solicitud,
          propuesta,
          cotizacion,
          campania,
          caras,
          comentarios: comentariosWithAuthor,
          historial,
        },
      }));
    } catch (error) {
      console.error('Error in getById:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener solicitud';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async updateStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      // Obtener solicitud antes de actualizar
      const solicitudAnterior = await prisma.solicitud.findUnique({
        where: { id: parseInt(id) },
      });

      if (!solicitudAnterior) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      const statusAnterior = solicitudAnterior.status;

      const solicitud = await prisma.solicitud.update({
        where: { id: parseInt(id) },
        data: { status },
      });

      // Crear notificaciones para los involucrados
      const nombreSolicitud = solicitud.razon_social || solicitud.marca_nombre || 'Sin nombre';
      const tituloNotificacion = `Cambio de estado en solicitud #${solicitud.id}`;
      const descripcionNotificacion = `${userName} cambió el estado de "${statusAnterior}" a "${status}" - ${nombreSolicitud}`;

      // Obtener propuesta y campaña relacionadas
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      // Recopilar involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados
      if (solicitud.id_asignado) {
        solicitud.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      // Agregar creador de la solicitud
      if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
      }

      // Crear notificación para cada involucrado
      const now = new Date();
      const fechaFin = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      for (const responsableId of involucrados) {
        await prisma.tareas.create({
          data: {
            titulo: tituloNotificacion,
            descripcion: descripcionNotificacion,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            responsable: '',
            id_solicitud: solicitud.id.toString(),
            id_propuesta: propuesta?.id?.toString() || '',
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            asignado: userName,
            id_asignado: userId?.toString() || '',
          },
        });
      }

      // Registrar en historial
      await prisma.historial.create({
        data: {
          tipo: 'Solicitud',
          ref_id: solicitud.id,
          accion: 'Cambio de estado',
          fecha_hora: now,
          detalles: `${userName} cambió estado de "${statusAnterior}" a "${status}"`,
        },
      });

      // Enviar correo
      const usuariosNotificar = await prisma.usuario.findMany({
        where: { id: { in: Array.from(involucrados) } },
        select: { id: true, correo_electronico: true, nombre: true },
      });

      for (const usuario of usuariosNotificar) {
        if (usuario.correo_electronico) {
          enviarCorreoNotificacion(
            solicitud.id,
            tituloNotificacion,
            descripcionNotificacion,
            usuario.correo_electronico,
            usuario.nombre,
            {
              accion: 'Cambio de estado',
              usuario: userName,
              cliente: nombreSolicitud,
            }
          ).catch(err => console.error('Error enviando correo notificación:', err));
        }
      }

      res.json({
        success: true,
        data: solicitud,
      });

      // Emitir eventos WebSocket
      emitToSolicitudes(SOCKET_EVENTS.SOLICITUD_STATUS_CHANGED, {
        solicitudId: solicitud.id,
        statusAnterior,
        statusNuevo: status,
        usuario: userName,
      });
      if (campania) {
        emitToCampanas(SOCKET_EVENTS.CAMPANA_STATUS_CHANGED, {
          campaniaId: campania.id,
          usuario: userName,
        });
      }
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'solicitud', accion: 'status_changed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar status';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      // Obtener la solicitud antes de eliminar
      const solicitud = await prisma.solicitud.findFirst({
        where: { id: parseInt(id), deleted_at: null },
      });

      if (!solicitud) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      await prisma.solicitud.update({
        where: { id: parseInt(id) },
        data: { deleted_at: new Date() },
      });

      // Cancelar tareas pendientes asociadas a esta solicitud
      await prisma.tareas.updateMany({
        where: {
          id_solicitud: solicitud.id.toString(),
          estatus: 'Pendiente',
        },
        data: { estatus: 'Atendido' },
      });

      // Crear notificaciones para usuarios involucrados
      const involucrados = new Set<number>();

      if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
      }

      if (solicitud.id_asignado) {
        solicitud.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      const now = new Date();
      for (const responsableId of involucrados) {
        await prisma.tareas.create({
          data: {
            titulo: 'Solicitud eliminada',
            descripcion: `La solicitud "${solicitud.descripcion || solicitud.id}" ha sido eliminada por ${userName}`,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            asignado: userName,
            id_asignado: userId?.toString() || '',
            id_solicitud: solicitud.id.toString(),
            fecha_inicio: now,
            fecha_fin: now,
          },
        });
      }

      // Registrar en historial
      await prisma.historial.create({
        data: {
          tipo: 'Solicitud',
          ref_id: solicitud.id,
          accion: 'Eliminación',
          fecha_hora: now,
          detalles: `Solicitud eliminada por ${userName}`,
        },
      });

      res.json({
        success: true,
        message: 'Solicitud eliminada correctamente',
      });

      // Enviar correo
      const usuariosNotificar = await prisma.usuario.findMany({
        where: { id: { in: Array.from(involucrados) } },
        select: { id: true, correo_electronico: true, nombre: true },
      });

      for (const usuario of usuariosNotificar) {
        if (usuario.correo_electronico) {
          enviarCorreoNotificacion(
            solicitud.id,
            'Solicitud eliminada',
            `La solicitud "${solicitud.descripcion || solicitud.id}" ha sido eliminada por ${userName}`,
            usuario.correo_electronico,
            usuario.nombre,
            {
              accion: 'Eliminación',
              usuario: userName,
            }
          ).catch(err => console.error('Error enviando correo notificación:', err));
        }
      }

      // Emitir eventos WebSocket
      emitToSolicitudes(SOCKET_EVENTS.SOLICITUD_ELIMINADA, {
        solicitudId: solicitud.id,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'solicitud', accion: 'eliminada' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar solicitud';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const yearInicio = req.query.yearInicio as string;
      const yearFin = req.query.yearFin as string;
      const catorcenaInicio = req.query.catorcenaInicio as string;
      const catorcenaFin = req.query.catorcenaFin as string;
      const status = req.query.status as string;
      const search = req.query.search as string;

      const where: Record<string, unknown> = { deleted_at: null };

      if (status) {
        where.status = status;
      }

      if (search) {
        const orConditions: any[] = [
          { razon_social: { contains: search } },
          { descripcion: { contains: search } },
          { marca_nombre: { contains: search } },
          { asignado: { contains: search } },
          { cuic: { contains: search } },
          { nombre_usuario: { contains: search } },
        ];
        const searchAsInt = parseInt(search);
        if (!isNaN(searchAsInt)) {
          orConditions.push({ id: searchAsInt });
        }
        where.OR = orConditions;
      }

      // Visibility filter
      const userId = req.user?.userId;
      const userRol = req.user?.rol || '';
      if (userId && !hasFullVisibility(userRol)) {
        let visibleIds: { id: number }[];
        if (hasTeamVisibility(userRol)) {
          const teamIds = await getTeamMemberIds(prisma, userId);
          const placeholders = teamIds.map(() => '?').join(',');
          visibleIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT id FROM solicitud
             WHERE deleted_at IS NULL
               AND (usuario_id IN (${placeholders}) OR FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0)`,
            ...teamIds, String(userId)
          );
        } else {
          visibleIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT id FROM solicitud
             WHERE deleted_at IS NULL
               AND (usuario_id = ? OR FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0)`,
            userId, String(userId)
          );
        }
        where.id = { in: visibleIds.map(r => r.id) };
      }

      // Apply date filters — filter by cotizacion period dates, not solicitud.fecha
      if (yearInicio && yearFin && catorcenaInicio && catorcenaFin) {
        const catorcenasInicioData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearInicio),
            numero_catorcena: parseInt(catorcenaInicio),
          },
        });
        const catorcenasFinData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearFin),
            numero_catorcena: parseInt(catorcenaFin),
          },
        });

        if (catorcenasInicioData && catorcenasFinData) {
          const periodIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT DISTINCT s.id FROM solicitud s
             INNER JOIN propuesta pr ON pr.solicitud_id = s.id
             INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
             WHERE s.deleted_at IS NULL
               AND ct.fecha_inicio <= ?
               AND ct.fecha_fin >= ?`,
            catorcenasFinData.fecha_fin,
            catorcenasInicioData.fecha_inicio
          );
          const periodIdSet = new Set(periodIds.map(r => r.id));
          const existingIn = (where.id as any)?.in as number[] | undefined;
          if (existingIn) {
            where.id = { in: existingIn.filter(id => periodIdSet.has(id)) };
          } else if (periodIds.length > 0) {
            where.id = { in: periodIds.map(r => r.id) };
          } else {
            where.id = { in: [] };
          }
        }
      } else if (yearInicio && yearFin) {
        const periodIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
          `SELECT DISTINCT s.id FROM solicitud s
           INNER JOIN propuesta pr ON pr.solicitud_id = s.id
           INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
           WHERE s.deleted_at IS NULL
             AND ct.fecha_inicio <= ?
             AND ct.fecha_fin >= ?`,
          new Date(`${yearFin}-12-31`),
          new Date(`${yearInicio}-01-01`)
        );
        const periodIdSet = new Set(periodIds.map(r => r.id));
        const existingIn = (where.id as any)?.in as number[] | undefined;
        if (existingIn) {
          where.id = { in: existingIn.filter(id => periodIdSet.has(id)) };
        } else if (periodIds.length > 0) {
          where.id = { in: periodIds.map(r => r.id) };
        } else {
          where.id = { in: [] };
        }
      }

      // Get all distinct status values
      const statusGroups = await prisma.solicitud.groupBy({
        by: ['status'],
        where,
        _count: true,
      });

      const total = statusGroups.reduce((acc, s) => acc + s._count, 0);
      const byStatus: Record<string, number> = {};
      statusGroups.forEach(s => {
        byStatus[s.status] = s._count;
      });

      res.json({
        success: true,
        data: {
          total,
          byStatus,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener estadisticas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getCatorcenas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const year = req.query.year as string;

      const where: Record<string, unknown> = {};
      if (year) {
        where.a_o = parseInt(year);
      }

      const catorcenas = await prisma.catorcenas.findMany({
        where,
        orderBy: [{ a_o: 'desc' }, { numero_catorcena: 'asc' }],
      });

      // Get distinct years
      const years = await prisma.catorcenas.findMany({
        select: { a_o: true },
        distinct: ['a_o'],
        orderBy: { a_o: 'desc' },
      });

      res.json({
        success: true,
        data: catorcenas,
        years: years.map(y => y.a_o),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener catorcenas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async exportAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const status = req.query.status as string;
      const search = req.query.search as string;
      const yearInicio = req.query.yearInicio as string;
      const yearFin = req.query.yearFin as string;
      const catorcenaInicio = req.query.catorcenaInicio as string;
      const catorcenaFin = req.query.catorcenaFin as string;

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      // Visibility filter
      const userId = req.user?.userId;
      const userRol = req.user?.rol || '';
      if (userId && !hasFullVisibility(userRol)) {
        let visibleIds: { id: number }[];
        if (hasTeamVisibility(userRol)) {
          const teamIds = await getTeamMemberIds(prisma, userId);
          const placeholders = teamIds.map(() => '?').join(',');
          visibleIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT id FROM solicitud
             WHERE deleted_at IS NULL
               AND (usuario_id IN (${placeholders}) OR FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0)`,
            ...teamIds, String(userId)
          );
        } else {
          visibleIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT id FROM solicitud
             WHERE deleted_at IS NULL
               AND (usuario_id = ? OR FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0)`,
            userId, String(userId)
          );
        }
        where.id = { in: visibleIds.map(r => r.id) };
      }

      if (status) {
        where.status = status;
      }

      if (search) {
        where.OR = [
          { razon_social: { contains: search } },
          { descripcion: { contains: search } },
          { marca_nombre: { contains: search } },
          { asignado: { contains: search } },
          { cuic: { contains: search } },
        ];
      }

      // Period filter — filter by cotizacion period dates, not solicitud.fecha
      if (yearInicio && yearFin && catorcenaInicio && catorcenaFin) {
        const catorcenasInicioData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearInicio),
            numero_catorcena: parseInt(catorcenaInicio),
          },
        });
        const catorcenasFinData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearFin),
            numero_catorcena: parseInt(catorcenaFin),
          },
        });

        if (catorcenasInicioData && catorcenasFinData) {
          const periodIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `SELECT DISTINCT s.id FROM solicitud s
             INNER JOIN propuesta pr ON pr.solicitud_id = s.id
             INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
             WHERE s.deleted_at IS NULL
               AND ct.fecha_inicio <= ?
               AND ct.fecha_fin >= ?`,
            catorcenasFinData.fecha_fin,
            catorcenasInicioData.fecha_inicio
          );
          const periodIdSet = new Set(periodIds.map(r => r.id));
          const existingIn = (where.id as any)?.in as number[] | undefined;
          if (existingIn) {
            where.id = { in: existingIn.filter(id => periodIdSet.has(id)) };
          } else if (periodIds.length > 0) {
            where.id = { in: periodIds.map(r => r.id) };
          } else {
            where.id = { in: [] };
          }
        }
      } else if (yearInicio && yearFin) {
        const periodIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
          `SELECT DISTINCT s.id FROM solicitud s
           INNER JOIN propuesta pr ON pr.solicitud_id = s.id
           INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
           WHERE s.deleted_at IS NULL
             AND ct.fecha_inicio <= ?
             AND ct.fecha_fin >= ?`,
          new Date(`${yearFin}-12-31`),
          new Date(`${yearInicio}-01-01`)
        );
        const periodIdSet = new Set(periodIds.map(r => r.id));
        const existingIn = (where.id as any)?.in as number[] | undefined;
        if (existingIn) {
          where.id = { in: existingIn.filter(id => periodIdSet.has(id)) };
        } else if (periodIds.length > 0) {
          where.id = { in: periodIds.map(r => r.id) };
        } else {
          where.id = { in: [] };
        }
      } else if (yearInicio) {
        const periodIds = await prisma.$queryRawUnsafe<{ id: number }[]>(
          `SELECT DISTINCT s.id FROM solicitud s
           INNER JOIN propuesta pr ON pr.solicitud_id = s.id
           INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
           WHERE s.deleted_at IS NULL
             AND ct.fecha_inicio <= ?
             AND ct.fecha_fin >= ?`,
          new Date(`${yearInicio}-12-31`),
          new Date(`${yearInicio}-01-01`)
        );
        const periodIdSet = new Set(periodIds.map(r => r.id));
        const existingIn = (where.id as any)?.in as number[] | undefined;
        if (existingIn) {
          where.id = { in: existingIn.filter(id => periodIdSet.has(id)) };
        } else if (periodIds.length > 0) {
          where.id = { in: periodIds.map(r => r.id) };
        } else {
          where.id = { in: [] };
        }
      }

      const solicitudes = await prisma.solicitud.findMany({
        where,
        orderBy: { fecha: 'desc' },
      });

      res.json({
        success: true,
        data: solicitudes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al exportar solicitudes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getUsers(req: AuthRequest, res: Response): Promise<void> {
    try {
      const area = req.query.area as string;
      const filterByTeam = req.query.filterByTeam === 'true';
      const userId = req.user?.userId;

      let teamMemberIds: number[] = [];

      // Si filterByTeam es true, obtener los compañeros de equipo del usuario actual
      if (filterByTeam && userId) {
        // Obtener los equipos del usuario actual
        const userTeams = await prisma.usuario_equipo.findMany({
          where: {
            usuario_id: userId,
            equipo: {
              deleted_at: null,
            },
          },
          select: {
            equipo_id: true,
          },
        });

        // Si el usuario tiene equipos, obtener todos los miembros de esos equipos
        if (userTeams.length > 0) {
          const teamIds = userTeams.map((t: { equipo_id: number }) => t.equipo_id);
          const teamMembers = await prisma.usuario_equipo.findMany({
            where: {
              equipo_id: { in: teamIds },
              equipo: {
                deleted_at: null,
              },
            },
            select: {
              usuario_id: true,
            },
          });
          teamMemberIds = [...new Set(teamMembers.map((m: { usuario_id: number }) => m.usuario_id))];
        }
      }

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      if (area) {
        where.area = area;
      }

      // Si hay filtro por equipo y el usuario tiene equipos, filtrar por miembros
      if (filterByTeam && teamMemberIds.length > 0) {
        where.id = { in: teamMemberIds };
      }

      const users = await prisma.usuario.findMany({
        where,
        select: {
          id: true,
          nombre: true,
          area: true,
          puesto: true,
          sap_asesor_id: true,
        },
        orderBy: { nombre: 'asc' },
      });

      res.json({
        success: true,
        data: users,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener usuarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getInventarioFilters(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Get distinct estados
      const estados = await prisma.inventarios.findMany({
        select: { estado: true },
        distinct: ['estado'],
        where: { estado: { not: null } },
        orderBy: { estado: 'asc' },
      });

      // Get distinct municipios (ciudades)
      const ciudades = await prisma.inventarios.findMany({
        select: { municipio: true, estado: true },
        distinct: ['municipio'],
        where: { municipio: { not: null } },
        orderBy: { municipio: 'asc' },
      });

      // Get distinct mueble (formatos)
      const formatos = await prisma.inventarios.findMany({
        select: { mueble: true },
        distinct: ['mueble'],
        where: { mueble: { not: null } },
        orderBy: { mueble: 'asc' },
      });

      // Get distinct nivel_socioeconomico
      const nse = await prisma.inventarios.findMany({
        select: { nivel_socioeconomico: true },
        distinct: ['nivel_socioeconomico'],
        where: { nivel_socioeconomico: { not: null } },
        orderBy: { nivel_socioeconomico: 'asc' },
      });

      res.json({
        success: true,
        data: {
          estados: estados.map(e => e.estado).filter(Boolean),
          ciudades: ciudades.map(c => ({ ciudad: c.municipio, estado: c.estado })),
          formatos: formatos.map(f => f.mueble).filter(Boolean),
          nse: nse.map(n => n.nivel_socioeconomico).filter(Boolean),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener filtros de inventario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getFormatosByCiudades(req: AuthRequest, res: Response): Promise<void> {
    try {
      const ciudades = req.query.ciudades as string;

      if (!ciudades) {
        res.json({ success: true, data: [] });
        return;
      }

      const ciudadesArray = ciudades.split(',').map(c => c.trim());

      const formatos = await prisma.inventarios.findMany({
        select: { mueble: true },
        distinct: ['mueble'],
        where: {
          municipio: { in: ciudadesArray },
          mueble: { not: null },
        },
        orderBy: { mueble: 'asc' },
      });

      res.json({
        success: true,
        data: formatos.map(f => f.mueble).filter(Boolean),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener formatos';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getInventarioOptions(req: AuthRequest, res: Response): Promise<void> {
    try {
      const estado = req.query.estado as string | undefined;
      const ciudadesParam = req.query.ciudades as string | undefined;
      const ciudadesArray = ciudadesParam ? ciudadesParam.split(',').map(c => c.trim()).filter(Boolean) : [];

      // Build WHERE condition: filter by estado(s) and/or municipios
      const estadosArray = estado ? (estado as string).split(',').map(e => e.trim()).filter(Boolean) : [];
      const whereCondition: any = {};
      if (estadosArray.length > 0 && ciudadesArray.length > 0) {
        whereCondition.OR = [
          { estado: estadosArray.length === 1 ? estadosArray[0] : { in: estadosArray } },
          { municipio: { in: ciudadesArray } },
        ];
      } else if (estadosArray.length === 1) {
        whereCondition.estado = estadosArray[0];
      } else if (estadosArray.length > 1) {
        whereCondition.estado = { in: estadosArray };
      } else if (ciudadesArray.length > 0) {
        whereCondition.municipio = { in: ciudadesArray };
      }
      // If no filters, return everything (fallback)

      const [formatos, tipos, nse] = await Promise.all([
        prisma.inventarios.findMany({
          select: { mueble: true },
          distinct: ['mueble'],
          where: { ...whereCondition, mueble: { not: null } },
          orderBy: { mueble: 'asc' },
        }),
        prisma.inventarios.findMany({
          select: { tradicional_digital: true },
          distinct: ['tradicional_digital'],
          where: { ...whereCondition, tradicional_digital: { not: null } },
          orderBy: { tradicional_digital: 'asc' },
        }),
        prisma.inventarios.findMany({
          select: { nivel_socioeconomico: true },
          distinct: ['nivel_socioeconomico'],
          where: { ...whereCondition, nivel_socioeconomico: { not: null } },
          orderBy: { nivel_socioeconomico: 'asc' },
        }),
      ]);

      res.json({
        success: true,
        data: {
          formatos: formatos.map(f => f.mueble).filter(Boolean),
          tipos: tipos.map(t => t.tradicional_digital).filter(Boolean),
          nse: nse.map(n => n.nivel_socioeconomico).filter(Boolean),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener opciones de inventario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getNextId(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Get max ID from solicitud, propuesta, cotizacion, campania tables
      const result = await prisma.$queryRaw<{ proximo_id: bigint }[]>`
        SELECT COALESCE(
          GREATEST(
            (SELECT COALESCE(MAX(id), 0) FROM solicitud),
            (SELECT COALESCE(MAX(id), 0) FROM propuesta),
            (SELECT COALESCE(MAX(id), 0) FROM cotizacion),
            (SELECT COALESCE(MAX(id), 0) FROM campania)
          ) + 1,
          1
        ) AS proximo_id
      `;

      const nextId = result[0]?.proximo_id ? Number(result[0].proximo_id) : 1;

      res.json({
        success: true,
        data: { nextId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener próximo ID';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const {
        // Client data
        cliente_id,
        cuic,
        razon_social,
        unidad_negocio,
        marca_id,
        marca_nombre,
        asesor,
        producto_id,
        producto_nombre,
        agencia,
        categoria_id,
        categoria_nombre,
        card_code, // SAP CardCode (ACA_U_SAPCode)
        salesperson_code, // SAP SalesPersonCode (ASESOR_U_SAPCode_Original)
        sap_database, // CIMU, TEST, or TRADE
        // Campaign data
        nombre_campania,
        descripcion,
        notas,
        presupuesto,
        // Articulo
        articulo,
        // Asignados (array of user IDs and names)
        asignados,
        // Date range
        fecha_inicio,
        fecha_fin,
        // File
        archivo,
        tipo_archivo,
        // IMU
        IMU,
        // Tipo de periodo (catorcena o personalizado)
        tipo_periodo,
        // Caras data (array)
        caras,
      } = req.body;

      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      // Calculate totals from caras
      const totalCaras = caras.reduce((acc: number, c: { caras: number; bonificacion: number }) => acc + c.caras + (c.bonificacion || 0), 0);
      const totalBonificacion = caras.reduce((acc: number, c: { bonificacion: number }) => acc + (c.bonificacion || 0), 0);
      const totalInversion = caras.reduce((acc: number, c: { costo: number }) => acc + c.costo, 0);

      // Format asignados string
      const asignadosStr = asignados.map((a: { nombre: string }) => a.nombre).join(', ');
      const asignadosIds = asignados.map((a: { id: number }) => a.id).join(',');

      // Use salesperson_code from request (ASESOR_U_SAPCode_Original from frontend)

      // Use transaction for complex creation with extended timeout
      const result = await prisma.$transaction(async (tx) => {
        // 1. Create solicitud
        const solicitud = await tx.solicitud.create({
          data: {
            fecha: getMexicoDate(),
            descripcion,
            presupuesto: presupuesto || totalInversion,
            notas: notas || '',
            cliente_id,
            usuario_id: userId,
            status: 'Pendiente',
            nombre_usuario: userName,
            asignado: asignadosStr,
            id_asignado: asignadosIds,
            cuic: cuic?.toString(),
            razon_social,
            unidad_negocio,
            marca_id,
            marca_nombre,
            asesor,
            producto_id,
            producto_nombre,
            agencia,
            categoria_id,
            categoria_nombre,
            IMU: IMU ? 1 : 0,
            archivo,
            tipo_archivo,
            card_code: card_code || null,
            salesperson_code,
            sap_database: sap_database || null,
          },
        });

        // 2. Create historial
        await tx.historial.create({
          data: {
            tipo: 'Solicitud',
            ref_id: solicitud.id,
            accion: 'Creacion',
            fecha_hora: getMexicoDate(),
            detalles: `Solicitud creada por ${userName}`,
          },
        });

        // 3. Create propuesta
        const propuesta = await tx.propuesta.create({
          data: {
            cliente_id,
            fecha: getMexicoDate(),
            status: 'Abierto',
            descripcion,
            notas,
            solicitud_id: solicitud.id,
            asignado: asignadosStr,
            id_asignado: asignadosIds,
            inversion: totalInversion,
            precio: totalInversion,
            comentario_cambio_status: '',
            articulo,
          },
        });

        // 4. Create cotizacion
        const cotizacion = await tx.cotizacion.create({
          data: {
            user_id: userId || 0,
            clientes_id: cliente_id,
            nombre_campania,
            numero_caras: totalCaras,
            fecha_inicio: new Date(fecha_inicio),
            fecha_fin: new Date(fecha_fin),
            frontal: caras.reduce((acc: number, c: { caras_flujo: number }) => acc + (c.caras_flujo || 0), 0),
            cruzada: caras.reduce((acc: number, c: { caras_contraflujo: number }) => acc + (c.caras_contraflujo || 0), 0),
            nivel_socioeconomico: caras.map((c: { nivel_socioeconomico: string }) => c.nivel_socioeconomico).join(','),
            observaciones: notas || '',
            bonificacion: totalBonificacion,
            descuento: 0,
            precio: totalInversion,
            contacto: asignadosStr,
            status: 'Pendiente',
            id_propuesta: propuesta.id,
            articulo,
            tipo_periodo: tipo_periodo || 'catorcena',
          },
        });

        // 5. Create campania
        const campania = await tx.campania.create({
          data: {
            cliente_id,
            nombre: nombre_campania,
            fecha_inicio: new Date(fecha_inicio),
            fecha_fin: new Date(fecha_fin),
            total_caras: totalCaras.toString(),
            bonificacion: totalBonificacion,
            status: 'inactiva',
            cotizacion_id: cotizacion.id,
            articulo,
          },
        });

        // 6. Create solicitud_original
        await tx.solicitud_original.create({
          data: {
            fecha: getMexicoDate(),
            descripcion,
            presupuesto: presupuesto || totalInversion,
            notas: notas || '',
            cliente_id,
            usuario_id: userId,
            status: 'Pendiente',
            nombre_usuario: userName,
            propuesta_id: propuesta.id,
            nombre_campania,
            fecha_inicio: new Date(fecha_inicio),
            fecha_fin: new Date(fecha_fin),
            flujo: caras.reduce((acc: number, c: { caras_flujo: number }) => acc + (c.caras_flujo || 0), 0),
            contraflujo: caras.reduce((acc: number, c: { caras_contraflujo: number }) => acc + (c.caras_contraflujo || 0), 0),
            total_flujo: totalCaras,
            bonificacion: totalBonificacion,
            nombre_cliente: razon_social,
            articulo,
          },
        });

        // 7. Crear tareas para cada asignado
        await tx.tareas.create({
          data: {
            tipo: 'Seguimiento Solicitud',
            titulo: 'Seguimiento Solicitud',
            descripcion: nombre_campania, 
            contenido: razon_social, 
            estatus: 'Pendiente',
            id_responsable: userId || 0,
            responsable: userName,
            asignado: userName,
            id_asignado: userId?.toString() || '0',
            id_solicitud: solicitud.id.toString(),
            campania_id: campania.id,
            fecha_inicio: getMexicoDate(), 
            fecha_fin: new Date(fecha_fin), 
          },
        });

        // 8. Create solicitudCaras for each cara entry with authorization status
        // Pre-compute BF bonificacion per grupo_rt_bf so RT rows use total caras for auth
        const bfBonifByGrupo: Record<number, number> = {};
        for (const c of caras) {
          const art = (c.articulo || '').toUpperCase();
          if ((art.startsWith('BF') || art.startsWith('CF')) && c.grupo_rt_bf) {
            bfBonifByGrupo[c.grupo_rt_bf] = (c.bonificacion || c.caras || 0);
          }
        }

        const createdCaras = [];
        for (const cara of caras) {
          const artUpper = (cara.articulo || '').toUpperCase();
          const isRtOfPair = !!cara.grupo_rt_bf && !artUpper.startsWith('BF') && !artUpper.startsWith('CF');
          const bonificacionForAuth = isRtOfPair
            ? (bfBonifByGrupo[cara.grupo_rt_bf] || cara.bonificacion || 0)
            : (cara.bonificacion || 0);

          // Calcular estado de autorización
          const estadoResult = await calcularEstadoAutorizacion({
            ciudad: cara.ciudad,
            estado: cara.estado,
            formato: cara.formato,
            tipo: cara.tipo,
            caras: cara.caras,
            bonificacion: bonificacionForAuth,
            costo: cara.costo,
            tarifa_publica: cara.tarifa_publica || 0,
            articulo: cara.articulo || null
          }, userId);

          const solicitudCara = await tx.solicitudCaras.create({
            data: {
              idquote: propuesta.id.toString(),
              ciudad: cara.ciudad,
              estados: cara.estado,
              tipo: cara.tipo || 'Tradicional',
              flujo: cara.flujo || 'Ambos',
              bonificacion: cara.bonificacion || 0,
              caras: cara.caras,
              nivel_socioeconomico: cara.nivel_socioeconomico,
              formato: cara.formato,
              costo: cara.costo,
              tarifa_publica: cara.tarifa_publica || 0,
              inicio_periodo: new Date(cara.inicio_periodo),
              fin_periodo: new Date(cara.fin_periodo),
              caras_flujo: cara.caras_flujo || 0,
              caras_contraflujo: cara.caras_contraflujo || 0,
              articulo: cara.articulo || articulo,
              descuento: cara.descuento || 0,
              autorizacion_dg: estadoResult.autorizacion_dg,
              autorizacion_dcm: estadoResult.autorizacion_dcm,
              cortesia: (cara.articulo || articulo || '').toUpperCase().startsWith('CT') ? 1 : 0,
              grupo_rt_bf: cara.grupo_rt_bf || null,
            },
          });
          createdCaras.push(solicitudCara);
        }

        // Propagate RT auth state to BF pairs within each grupo_rt_bf
        const gruposProcessed = new Set<number>();
        for (const created of createdCaras) {
          if (!created.grupo_rt_bf || gruposProcessed.has(created.grupo_rt_bf)) continue;
          gruposProcessed.add(created.grupo_rt_bf);
          const artUp = (created.articulo || '').toUpperCase();
          if (!artUp.startsWith('BF') && !artUp.startsWith('CF')) {
            // This is the RT row — propagate its auth to the BF pair
            const bfPair = createdCaras.find(c => c.grupo_rt_bf === created.grupo_rt_bf && c.id !== created.id);
            if (bfPair && (bfPair.autorizacion_dg !== created.autorizacion_dg || bfPair.autorizacion_dcm !== created.autorizacion_dcm)) {
              await tx.solicitudCaras.update({
                where: { id: bfPair.id },
                data: { autorizacion_dg: created.autorizacion_dg, autorizacion_dcm: created.autorizacion_dcm },
              });
              bfPair.autorizacion_dg = created.autorizacion_dg;
              bfPair.autorizacion_dcm = created.autorizacion_dcm;
            }
          }
        }

        // Regla: si el total global de caras es impar, TODAS requieren autorización DG
        const totalCarasGlobal = caras.reduce((acc: number, c: any) => acc + (c.caras || 0) + (c.bonificacion || 0), 0);
        if (totalCarasGlobal % 2 !== 0) {
          for (const createdCara of createdCaras) {
            if (createdCara.autorizacion_dg !== 'pendiente') {
              await tx.solicitudCaras.update({
                where: { id: createdCara.id },
                data: { autorizacion_dg: 'pendiente' },
              });
            }
          }
          console.log(`[create] Total caras impar (${totalCarasGlobal}), todas las caras requieren autorización DG`);
        }

        return {
          solicitud,
          propuesta,
          cotizacion,
          campania,
          caras: createdCaras,
        };
      }, {
        maxWait: 60000, // 60 seconds max wait to acquire transaction
        timeout: 120000, // 2 minutes for the transaction to complete
      });

      // Verificar caras pendientes de autorización (no debe bloquear la respuesta)
      let autorizacionInfo: { tienePendientes: boolean; pendientesDg: any[]; pendientesDcm: any[] } = { tienePendientes: false, pendientesDg: [], pendientesDcm: [] };
      try {
        autorizacionInfo = await verificarCarasPendientes(result.propuesta.id.toString());
        console.log('[create] Verificando pendientes después de transacción:', autorizacionInfo);
      } catch (err) {
        console.error('[create] Error verificando pendientes (no-blocking):', err);
      }

      // Build message with authorization info
      let mensaje = 'Solicitud creada exitosamente';
      if (autorizacionInfo.tienePendientes) {
        const totalPendientes = autorizacionInfo.pendientesDg.length + autorizacionInfo.pendientesDcm.length;
        mensaje = `Solicitud creada. ${totalPendientes} circuito(s) requieren autorización.`;
      }

      // SIEMPRE enviar respuesta exitosa si la transacción commiteó
      res.status(201).json({
        success: true,
        data: result,
        message: mensaje,
        autorizacion: autorizacionInfo,
      });

      // Emitir eventos WebSocket (siempre, independiente de lógica post-transacción)
      emitToSolicitudes(SOCKET_EVENTS.SOLICITUD_CREADA, {
        solicitud: result.solicitud,
        propuesta: result.propuesta,
        campania: result.campania,
        usuario: userName,
      });
      emitToCampanas(SOCKET_EVENTS.CAMPANA_CREADA, {
        campania: result.campania,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'solicitud', accion: 'creada' });
      emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
        solicitudId: result.solicitud.id,
        campanaId: result.campania.id,
        usuario: userName,
      });

      // Lógica post-respuesta: tareas de autorización (no bloquea al usuario)
      try {
        if (autorizacionInfo.tienePendientes && userId) {
          await crearTareasAutorizacion(
            result.solicitud.id,
            result.propuesta.id,
            userId,
            userName,
            autorizacionInfo.pendientesDg,
            autorizacionInfo.pendientesDcm
          );
        }
      } catch (err) {
        console.error('[create] Error creando tareas autorización (no-blocking):', err);
      }

      // Lógica post-respuesta: correo electrónico (no bloquea al usuario)
      try {
        const catorcenaInicio = await prisma.catorcenas.findFirst({
          where: {
            fecha_inicio: { lte: new Date(fecha_inicio) },
            fecha_fin: { gte: new Date(fecha_inicio) },
          },
        });
        const catorcenaFin = await prisma.catorcenas.findFirst({
          where: {
            fecha_inicio: { lte: new Date(fecha_fin) },
            fecha_fin: { gte: new Date(fecha_fin) },
          },
        });

        const periodoInicioStr = catorcenaInicio
          ? `Cat ${catorcenaInicio.numero_catorcena} - ${catorcenaInicio.a_o}`
          : null;
        const periodoFinStr = catorcenaFin
          ? `Cat ${catorcenaFin.numero_catorcena} - ${catorcenaFin.a_o}`
          : null;

        if (userId) {
          const creadorConEmail = await prisma.usuario.findUnique({
            where: { id: userId },
            select: { correo_electronico: true },
          });

          if (creadorConEmail?.correo_electronico) {
            enviarCorreoTarea(
              result.solicitud.id,
              nombre_campania,
              `Dar seguimiento a solicitud: ${nombre_campania}`,
              new Date(fecha_fin),
              creadorConEmail.correo_electronico,
              userName,
              {
                cliente: razon_social,
                producto: producto_nombre,
                creador: userName,
                periodoInicio: periodoInicioStr || undefined,
                periodoFin: periodoFinStr || undefined,
                idSolicitud: result.solicitud.id,
              }
            ).catch(err => console.error('Error enviando correo:', err));
          }
        }
      } catch (err) {
        console.error('[create] Error obteniendo catorcenas/enviando correo (no-blocking):', err);
      }
    } catch (error) {
      console.error('Error creating solicitud:', error);
      const message = error instanceof Error ? error.message : 'Error al crear solicitud';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Add comment to solicitud
  async addComment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { comentario } = req.body;
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      if (!userId) {
        res.status(401).json({ success: false, error: 'No autorizado' });
        return;
      }

      // Get solicitud and its campania_id
      const solicitud = await prisma.solicitud.findFirst({
        where: { id: parseInt(id), deleted_at: null },
      });

      if (!solicitud) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      // Get campania_id from propuesta -> cotizacion -> campania
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      const newComment = await prisma.comentarios.create({
        data: {
          autor_id: userId,
          comentario,
          creado_en: new Date(),
          campania_id: campania?.id || 0,
          solicitud_id: solicitud.id,
          origen: 'solicitud',
        },
      });

      // Crear notificaciones para todos los involucrados (excepto el autor)
      const nombreSolicitud = solicitud.razon_social || solicitud.marca_nombre || 'Sin nombre';
      const tituloNotificacion = `Nuevo comentario en solicitud #${solicitud.id} - ${nombreSolicitud}`;
      const descripcionNotificacion = `${userName} comentó: ${comentario.substring(0, 100)}${comentario.length > 100 ? '...' : ''}`;

      // Recopilar todos los involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados
      if (solicitud.id_asignado) {
        solicitud.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      // Agregar creador de la solicitud
      if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
      }

      // Crear una notificación para cada involucrado
      const now = new Date();
      const fechaFin = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +1 día

      for (const responsableId of involucrados) {
        await prisma.tareas.create({
          data: {
            titulo: tituloNotificacion,
            descripcion: descripcionNotificacion,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            id_solicitud: solicitud.id.toString(),
            id_propuesta: propuesta?.id?.toString() || '',
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            responsable: '',
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      res.json({
        success: true,
        data: {
          ...newComment,
          autor_nombre: userName,
        },
      });
      // Enviar correo
      const usuariosNotificar = await prisma.usuario.findMany({
        where: { id: { in: Array.from(involucrados) } },
        select: { id: true, correo_electronico: true, nombre: true },
      });

      for (const usuario of usuariosNotificar) {
        if (usuario.correo_electronico) {
          enviarCorreoNotificacion(
            solicitud.id,
            tituloNotificacion,
            descripcionNotificacion,
            usuario.correo_electronico,
            usuario.nombre,
            {
              accion: 'Nuevo comentario',
              usuario: userName,
              cliente: nombreSolicitud,
            }
          ).catch(err => console.error('Error enviando correo notificación:', err));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al agregar comentario';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Get comments for solicitud
  async getComments(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const comentarios = await prisma.comentarios.findMany({
        where: { solicitud_id: parseInt(id) },
        orderBy: { creado_en: 'desc' },
      });

      // Get autor names and photos
      const autorIds = [...new Set(comentarios.map(c => c.autor_id))];
      const autores = await prisma.usuario.findMany({
        where: { id: { in: autorIds } },
        select: { id: true, nombre: true, foto_perfil: true },
      });
      const autoresMap = new Map(autores.map(a => [a.id, { nombre: a.nombre, foto_perfil: a.foto_perfil }]));

      const comentariosWithAuthor = comentarios.map(c => ({
        ...c,
        autor_nombre: autoresMap.get(c.autor_id)?.nombre || 'Usuario desconocido',
        autor_foto: autoresMap.get(c.autor_id)?.foto_perfil || null,
      }));

      res.json({
        success: true,
        data: comentariosWithAuthor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener comentarios';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Atender solicitud (change status to Atendida and create tasks)
  async atender(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { asignados } = req.body as { asignados?: { id: number; nombre: string }[] };
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      // Process asignados - convert to strings for storage
      const asignadoNombres = asignados?.map(a => a.nombre).join(', ') || '';
      const asignadoIds = asignados?.map(a => a.id.toString()).join(', ') || '';

      if (!userId) {
        res.status(401).json({ success: false, error: 'No autorizado' });
        return;
      }

      const solicitud = await prisma.solicitud.findFirst({
        where: { id: parseInt(id), deleted_at: null },
      });

      if (!solicitud) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      if (solicitud.status !== 'Aprobada') {
        res.status(400).json({ success: false, error: 'Solo se pueden atender solicitudes aprobadas' });
        return;
      }

      // Get propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });

      // Get cotizacion
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;

      // Declarar involucrados ANTES de la transacción para usarlos después
      const involucrados = new Set<number>();

      // Agregar creador de la solicitud
      if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
      }

      // Agregar usuarios asignados
      if (solicitud.id_asignado) {
        solicitud.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      await prisma.$transaction(async (tx) => {
        // Update solicitud status
        await tx.solicitud.update({
          where: { id: solicitud.id },
          data: { status: 'Atendida' },
        });

        // Update propuesta status and asignados
        if (propuesta) {
          await tx.propuesta.update({
            where: { id: propuesta.id },
            data: {
              status: 'Abierto',
              // Update asignados if provided, otherwise keep existing
              ...(asignados && asignados.length > 0 ? {
                asignado: asignadoNombres,
                id_asignado: asignadoIds,
              } : {}),
            },
          });
        }

        // Update existing tareas to "Atendido"
        await tx.tareas.updateMany({
          where: { id_solicitud: solicitud.id.toString() },
          data: { estatus: 'Atendido' },
        });

        // Create new tareas after attending and seguimiento de propuesta
        if (propuesta) {
          const cotizacionData = await tx.cotizacion.findFirst({
            where: { id_propuesta: propuesta.id },
          });
          const campaniaData = await tx.campania.findFirst({
            where: { cotizacion_id: cotizacionData?.id },
          });
          const ahoraMx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
          const fechaFinMx = new Date(ahoraMx);
          fechaFinMx.setDate(fechaFinMx.getDate() + 7);

          // Seguimiento Propuesta (asignado ORIGINAL )
          const asignadoOriginal = solicitud.usuario_id || userId;
          const nombreAsignadoOriginal = solicitud.nombre_usuario || userName || '';

          await tx.tareas.create({
            data: {
              fecha_inicio: ahoraMx,
              fecha_fin: fechaFinMx,
              tipo: 'Seguimiento Propuesta',
              responsable: nombreAsignadoOriginal,
              id_responsable: asignadoOriginal,
              asignado: nombreAsignadoOriginal,
              id_asignado: asignadoOriginal.toString(),
              estatus: 'Pendiente',
              descripcion: `Dar seguimiento a la propuesta: ${cotizacionData?.nombre_campania || ''}`,
              titulo: `Seguimiento Propuesta`,
              id_propuesta: propuesta.id.toString(),
              id_solicitud: solicitud.id.toString(),
              campania_id: campaniaData?.id || null,
            },
          });

          // Atender Propuesta 
          const nuevosAsignadosIds = asignados && asignados.length > 0 
            ? asignados.map((a: { id: number }) => a.id)
            : [];

          let usuariosTrafico: { id: number; nombre: string; correo_electronico: string | null }[] = [];

          // Construir condición de exclusión solo si hay creador
          const excludeCreator = solicitud.usuario_id ? { not: solicitud.usuario_id } : {};

          if (nuevosAsignadosIds.length === 0) {
            usuariosTrafico = await tx.usuario.findMany({
              where: {
                OR: [
                  { puesto: { contains: 'Tráfico' } },
                  { puesto: { contains: 'Trafico' } },
                  { area: { contains: 'Tráfico' } },
                  { area: { contains: 'Trafico' } }
                ],
                ...(solicitud.usuario_id ? { id: { not: solicitud.usuario_id } } : {}),
                deleted_at: null
              },
              select: { id: true, nombre: true, correo_electronico: true }
            });
          } else {
            // Si hay asignados específicos, filtrar al creador manualmente después del query
            const usuariosTraficoRaw = await tx.usuario.findMany({
              where: {
                id: { in: nuevosAsignadosIds },
                deleted_at: null
              },
              select: { id: true, nombre: true, correo_electronico: true }
            });
            
            // Filtrar al creador si existe
            usuariosTrafico = solicitud.usuario_id 
              ? usuariosTraficoRaw.filter(u => u.id !== solicitud.usuario_id)
              : usuariosTraficoRaw;
          }

          //  tarea para usuario de Tráfico
          for (const usuarioTrafico of usuariosTrafico) {
            await tx.tareas.create({
              data: {
                fecha_inicio: ahoraMx,
                fecha_fin: fechaFinMx,
                tipo: 'Atender Propuesta',
                responsable: usuarioTrafico.nombre,
                id_responsable: usuarioTrafico.id,
                asignado: usuarioTrafico.nombre,
                id_asignado: usuarioTrafico.id.toString(),
                estatus: 'Pendiente',
                descripcion: `Atender propuesta: ${cotizacionData?.nombre_campania || ''}`,
                titulo: `Atender Propuesta`,
                id_propuesta: propuesta.id.toString(),
                id_solicitud: solicitud.id.toString(),
                campania_id: campaniaData?.id || null,
              },
            });
          }
        }

        // Create historial for solicitud
        await tx.historial.create({
          data: {
            tipo: 'Solicitud',
            ref_id: solicitud.id,
            accion: 'Activación',
            fecha_hora: new Date(),
            detalles: 'Se ha atendido la solicitud.',
          },
        });

        // Create historial for propuesta
        if (propuesta) {
          await tx.historial.create({
            data: {
              tipo: 'Propuesta',
              ref_id: propuesta.id,
              accion: 'Inicio',
              fecha_hora: new Date(),
              detalles: 'Se ha creado la propuesta.',
            },
          });
        }

        // Crear notificación para cada involucrado
        const now = new Date();
        for (const responsableId of involucrados) {
          await tx.tareas.create({
            data: {
              titulo: 'Solicitud atendida',
              descripcion: `La solicitud "${solicitud.descripcion || solicitud.id}" ha sido atendida por ${userName}`,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              asignado: userName,
              id_asignado: userId.toString(),
              id_solicitud: solicitud.id.toString(),
              id_propuesta: propuesta?.id.toString() || '',
              fecha_inicio: now,
              fecha_fin: now,
            },
          });
        }
      }, { timeout: 30000 });

      // Obtener catorcenas para el correo
      const cotizacionData = cotizacion || await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta?.id },
      });
      const fechaFin = cotizacionData?.fecha_fin || solicitud.fecha || new Date();

      const catorcenaInicio = cotizacionData?.fecha_inicio ? await prisma.catorcenas.findFirst({
        where: {
          fecha_inicio: { lte: cotizacionData.fecha_inicio },
          fecha_fin: { gte: cotizacionData.fecha_inicio },
        },
      }) : null;

      const catorcenaFin = await prisma.catorcenas.findFirst({
        where: {
          fecha_inicio: { lte: fechaFin },
          fecha_fin: { gte: fechaFin },
        },
      });

      const periodoInicioStr = catorcenaInicio 
        ? `Cat ${catorcenaInicio.numero_catorcena} - ${catorcenaInicio.a_o}` 
        : undefined;
      const periodoFinStr = catorcenaFin 
        ? `Cat ${catorcenaFin.numero_catorcena} - ${catorcenaFin.a_o}` 
        : undefined;

      // Enviar correo al creador (Seguimiento Propuesta)
      const asignadoOriginal = solicitud.usuario_id || userId;
      const nombreAsignadoOriginal = solicitud.nombre_usuario || userName || '';

      if (asignadoOriginal) {
        const creador = await prisma.usuario.findUnique({
          where: { id: asignadoOriginal },
          select: { correo_electronico: true, nombre: true },
        });

        if (creador?.correo_electronico) {
          enviarCorreoTarea(
            solicitud.id,
            cotizacionData?.nombre_campania || '',
            `Dar seguimiento a la propuesta: ${cotizacionData?.nombre_campania || ''}`,
            fechaFin,
            creador.correo_electronico,
            nombreAsignadoOriginal,
            {
              cliente: solicitud?.razon_social || undefined,
              producto: solicitud?.producto_nombre || undefined,
              creador: userName,
              periodoInicio: periodoInicioStr,
              periodoFin: periodoFinStr,
              idPropuesta: propuesta?.id || undefined,
            },
            `https://app.qeb.mx/propuestas?viewId=${propuesta?.id || ''}`
          ).catch(err => console.error('Error enviando correo:', err));
        }
      }

      // Enviar correo a usuarios de Tráfico (Atender Propuesta)
      const nuevosAsignadosIds = asignados && asignados.length > 0 
        ? asignados.map((a: { id: number }) => a.id)
        : [];

      let usuariosTrafico: { id: number; nombre: string; correo_electronico: string | null }[] = [];

      if (nuevosAsignadosIds.length === 0) {
        usuariosTrafico = await prisma.usuario.findMany({
          where: {
            OR: [
              { puesto: { contains: 'Tráfico' } },
              { puesto: { contains: 'Trafico' } },
              { area: { contains: 'Tráfico' } },
              { area: { contains: 'Trafico' } }
            ],
            ...(solicitud.usuario_id ? { id: { not: solicitud.usuario_id } } : {}),
            deleted_at: null
          },
          select: { id: true, nombre: true, correo_electronico: true }
        });
      } else {
        const usuariosTraficoRaw = await prisma.usuario.findMany({
          where: { 
            id: { in: nuevosAsignadosIds },
            deleted_at: null 
          },
          select: { id: true, nombre: true, correo_electronico: true }
        });
        
        // Filtrar al creador si existe
        usuariosTrafico = solicitud.usuario_id 
          ? usuariosTraficoRaw.filter(u => u.id !== solicitud.usuario_id)
          : usuariosTraficoRaw;
      }

      for (const usuarioTrafico of usuariosTrafico) {
        if (usuarioTrafico.correo_electronico) {
          enviarCorreoTarea(
            solicitud.id,
            cotizacionData?.nombre_campania || '',
            `Atender propuesta: ${cotizacionData?.nombre_campania || ''}`,
            fechaFin,
            usuarioTrafico.correo_electronico,
            usuarioTrafico.nombre,
            {
              cliente: solicitud?.razon_social || undefined,
              producto: solicitud?.producto_nombre || undefined,
              creador: userName,
              periodoInicio: periodoInicioStr,
              periodoFin: periodoFinStr,
              idPropuesta: propuesta?.id || undefined,
            },
            `https://app.qeb.mx/propuestas?viewId=${propuesta?.id || ''}`
          ).catch(err => console.error('Error enviando correo:', err));
        }
      }



      res.json({
        success: true,
        message: 'Solicitud atendida exitosamente',
      });
      // Enviar correo
      const usuariosNotificar = await prisma.usuario.findMany({
        where: { id: { in: Array.from(involucrados) } },
        select: { id: true, correo_electronico: true, nombre: true },
      });

      for (const usuario of usuariosNotificar) {
        if (usuario.correo_electronico) {
          enviarCorreoNotificacion(
            solicitud.id,
            'Solicitud atendida',
            `La solicitud "${solicitud.descripcion || solicitud.id}" ha sido atendida por ${userName}`,
            usuario.correo_electronico,
            usuario.nombre,
            {
              accion: 'Atendida',
              usuario: userName,
            }
          ).catch(err => console.error('Error enviando correo notificación:', err));
        }
      }
    } catch (error) {
      console.error('Error atendiendo solicitud:', error);
      const message = error instanceof Error ? error.message : 'Error al atender solicitud';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Update solicitud
  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      const {
        cliente_id,
        cuic,
        razon_social,
        unidad_negocio,
        marca_id,
        marca_nombre,
        asesor,
        producto_id,
        producto_nombre,
        agencia,
        categoria_id,
        categoria_nombre,
        nombre_campania,
        descripcion,
        notas,
        presupuesto,
        articulo,
        asignados,
        fecha_inicio,
        fecha_fin,
        archivo,
        tipo_archivo,
        IMU,
        tipo_periodo,
        caras,
      } = req.body;

      const solicitud = await prisma.solicitud.findFirst({
        where: { id: parseInt(id), deleted_at: null },
      });

      if (!solicitud) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      // Calculate totals from caras
      const totalCaras = caras.reduce((acc: number, c: { caras: number; bonificacion: number }) => acc + c.caras + (c.bonificacion || 0), 0);
      const totalBonificacion = caras.reduce((acc: number, c: { bonificacion: number }) => acc + (c.bonificacion || 0), 0);
      const totalInversion = caras.reduce((acc: number, c: { costo: number }) => acc + c.costo, 0);

      // Format asignados string
      const asignadosStr = asignados.map((a: { nombre: string }) => a.nombre).join(', ');
      const asignadosIds = asignados.map((a: { id: number }) => a.id).join(',');

      // Get existing propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });

      // Get existing cotizacion
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;

      // Get existing campania
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      await prisma.$transaction(async (tx) => {
        // Update solicitud
        await tx.solicitud.update({
          where: { id: solicitud.id },
          data: {
            descripcion,
            presupuesto: presupuesto || totalInversion,
            notas: notas || '',
            cliente_id,
            asignado: asignadosStr,
            id_asignado: asignadosIds,
            cuic: cuic?.toString(),
            razon_social,
            unidad_negocio,
            marca_id,
            marca_nombre,
            asesor,
            producto_id,
            producto_nombre,
            agencia,
            categoria_id,
            categoria_nombre,
            IMU: IMU ? 1 : 0,
            archivo,
            tipo_archivo,
          },
        });

        // Update propuesta if exists
        if (propuesta) {
          await tx.propuesta.update({
            where: { id: propuesta.id },
            data: {
              cliente_id,
              descripcion,
              notas,
              asignado: asignadosStr,
              id_asignado: asignadosIds,
              inversion: totalInversion,
              precio: totalInversion,
              articulo,
            },
          });
        }

        // Update cotizacion if exists
        if (cotizacion) {
          await tx.cotizacion.update({
            where: { id: cotizacion.id },
            data: {
              clientes_id: cliente_id,
              nombre_campania,
              numero_caras: totalCaras,
              fecha_inicio: new Date(fecha_inicio),
              fecha_fin: new Date(fecha_fin),
              frontal: caras.reduce((acc: number, c: { caras_flujo: number }) => acc + (c.caras_flujo || 0), 0),
              cruzada: caras.reduce((acc: number, c: { caras_contraflujo: number }) => acc + (c.caras_contraflujo || 0), 0),
              nivel_socioeconomico: caras.map((c: { nivel_socioeconomico: string }) => c.nivel_socioeconomico).join(','),
              observaciones: notas || '',
              bonificacion: totalBonificacion,
              precio: totalInversion,
              contacto: asignadosStr,
              articulo,
              tipo_periodo: tipo_periodo || 'catorcena',
            },
          });
        }

        // Update campania if exists
        if (campania) {
          await tx.campania.update({
            where: { id: campania.id },
            data: {
              cliente_id,
              nombre: nombre_campania,
              fecha_inicio: new Date(fecha_inicio),
              fecha_fin: new Date(fecha_fin),
              total_caras: totalCaras.toString(),
              bonificacion: totalBonificacion,
              articulo,
            },
          });
        }

        // Delete existing caras and recreate with authorization status
        if (propuesta) {
          await tx.solicitudCaras.deleteMany({
            where: { idquote: propuesta.id.toString() },
          });

          // Pre-compute BF bonificacion per grupo_rt_bf for RT auth evaluation
          const bfBonifByGrupoUpd: Record<number, number> = {};
          for (const c of caras) {
            const art = (c.articulo || '').toUpperCase();
            if ((art.startsWith('BF') || art.startsWith('CF')) && c.grupo_rt_bf) {
              bfBonifByGrupoUpd[c.grupo_rt_bf] = (c.bonificacion || c.caras || 0);
            }
          }

          // Create new caras - use frontend authorization if provided, otherwise recalculate
          const recreatedCaras = [];
          for (const cara of caras) {
            let autorizacion_dg = cara.autorizacion_dg || '';
            let autorizacion_dcm = cara.autorizacion_dcm || '';

            // If frontend didn't send authorization, recalculate
            if (!autorizacion_dg && !autorizacion_dcm) {
              const artUpdUpper = (cara.articulo || '').toUpperCase();
              const isRtUpd = !!cara.grupo_rt_bf && !artUpdUpper.startsWith('BF') && !artUpdUpper.startsWith('CF');
              const bonifForAuthUpd = isRtUpd
                ? (bfBonifByGrupoUpd[cara.grupo_rt_bf] || cara.bonificacion || 0)
                : (cara.bonificacion || 0);

              const estadoResult = await calcularEstadoAutorizacion({
                ciudad: cara.ciudad,
                estado: cara.estado,
                formato: cara.formato,
                tipo: cara.tipo,
                caras: cara.caras,
                bonificacion: bonifForAuthUpd,
                costo: cara.costo,
                tarifa_publica: cara.tarifa_publica || 0,
                articulo: cara.articulo || null
              }, userId);
              autorizacion_dg = estadoResult.autorizacion_dg;
              autorizacion_dcm = estadoResult.autorizacion_dcm;
            }

            const createdCara = await tx.solicitudCaras.create({
              data: {
                idquote: propuesta.id.toString(),
                ciudad: cara.ciudad,
                estados: cara.estado,
                tipo: cara.tipo || 'Tradicional',
                flujo: cara.flujo || 'Ambos',
                bonificacion: cara.bonificacion || 0,
                caras: cara.caras,
                nivel_socioeconomico: cara.nivel_socioeconomico,
                formato: cara.formato,
                costo: cara.costo,
                tarifa_publica: cara.tarifa_publica || 0,
                inicio_periodo: new Date(cara.inicio_periodo),
                fin_periodo: new Date(cara.fin_periodo),
                caras_flujo: cara.caras_flujo || 0,
                caras_contraflujo: cara.caras_contraflujo || 0,
                articulo: cara.articulo || articulo,
                descuento: cara.descuento || 0,
                autorizacion_dg,
                autorizacion_dcm,
                grupo_rt_bf: cara.grupo_rt_bf || null,
              },
            });
            recreatedCaras.push(createdCara);
          }

          // Propagate RT auth state to BF pairs within each grupo_rt_bf
          const gruposUpdProcessed = new Set<number>();
          for (const rc of recreatedCaras) {
            if (!rc.grupo_rt_bf || gruposUpdProcessed.has(rc.grupo_rt_bf)) continue;
            gruposUpdProcessed.add(rc.grupo_rt_bf);
            const artUp = (rc.articulo || '').toUpperCase();
            if (!artUp.startsWith('BF') && !artUp.startsWith('CF')) {
              const bfPair = recreatedCaras.find(c => c.grupo_rt_bf === rc.grupo_rt_bf && c.id !== rc.id);
              if (bfPair && (bfPair.autorizacion_dg !== rc.autorizacion_dg || bfPair.autorizacion_dcm !== rc.autorizacion_dcm)) {
                await tx.solicitudCaras.update({
                  where: { id: bfPair.id },
                  data: { autorizacion_dg: rc.autorizacion_dg, autorizacion_dcm: rc.autorizacion_dcm },
                });
              }
            }
          }
          // Nota: La verificación y creación de tareas de autorización se hace DESPUÉS de la transacción
        }

        // Detectar qué campos cambiaron
        const cambios: string[] = [];
        if (descripcion !== solicitud.descripcion) cambios.push('descripción');
        if (razon_social !== solicitud.razon_social) cambios.push('razón social');
        if (marca_nombre !== solicitud.marca_nombre) cambios.push('marca');
        if (presupuesto !== solicitud.presupuesto) cambios.push('presupuesto');
        if (asignadosStr !== solicitud.asignado) cambios.push('asignados');
        if (nombre_campania && cotizacion && nombre_campania !== cotizacion.nombre_campania) cambios.push('nombre de campaña');
        if (fecha_inicio && cotizacion && new Date(fecha_inicio).getTime() !== cotizacion.fecha_inicio?.getTime()) cambios.push('fecha inicio');
        if (fecha_fin && cotizacion && new Date(fecha_fin).getTime() !== cotizacion.fecha_fin?.getTime()) cambios.push('fecha fin');
        if (notas !== solicitud.notas) cambios.push('notas');
        if (archivo !== solicitud.archivo) cambios.push('archivo');

        const cambiosStr = cambios.length > 0 ? cambios.join(', ') : 'datos generales';

        // Create historial entry
        await tx.historial.create({
          data: {
            tipo: 'Solicitud',
            ref_id: solicitud.id,
            accion: 'Edición',
            fecha_hora: new Date(),
            detalles: `${userName} editó: ${cambiosStr}`,
          },
        });

        // Crear notificaciones para usuarios involucrados
        const nombreSolicitud = razon_social || marca_nombre || solicitud.razon_social || 'Sin nombre';
        const tituloNotificacion = `Solicitud #${solicitud.id} editada - ${nombreSolicitud}`;
        const descripcionNotificacion = `${userName} modificó: ${cambiosStr}`;

        // Recopilar involucrados (sin duplicados, excluyendo al autor)
        const involucrados = new Set<number>();

        // Agregar creador de la solicitud
        if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
          involucrados.add(solicitud.usuario_id);
        }

        // Agregar usuarios asignados anteriores
        if (solicitud.id_asignado) {
          solicitud.id_asignado.split(',').forEach((idStr: string) => {
            const parsed = parseInt(idStr.trim());
            if (!isNaN(parsed) && parsed !== userId) {
              involucrados.add(parsed);
            }
          });
        }

        // Agregar nuevos asignados
        if (asignados && Array.isArray(asignados)) {
          asignados.forEach((a: { id: number }) => {
            if (a.id && a.id !== userId) {
              involucrados.add(a.id);
            }
          });
        }

        // Crear notificación para cada involucrado
        const now = new Date();
        const fechaFin = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        for (const responsableId of involucrados) {
          await tx.tareas.create({
            data: {
              titulo: tituloNotificacion,
              descripcion: descripcionNotificacion,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              responsable: '',
              id_solicitud: solicitud.id.toString(),
              id_propuesta: propuesta?.id?.toString() || '',
              campania_id: campania?.id || null,
              fecha_inicio: now,
              fecha_fin: fechaFin,
              asignado: userName,
              id_asignado: userId?.toString() || '',
            },
          });
        }
      }, {
        maxWait: 60000,
        timeout: 120000,
      });

      // Enviar correo
      const involucradosCorreo = new Set<number>();
      
      if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
        involucradosCorreo.add(solicitud.usuario_id);
      }
      
      if (solicitud.id_asignado) {
        solicitud.id_asignado.split(',').forEach((idStr: string) => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucradosCorreo.add(parsed);
          }
        });
      }
      
      if (asignados && Array.isArray(asignados)) {
        asignados.forEach((a: { id: number }) => {
          if (a.id && a.id !== userId) {
            involucradosCorreo.add(a.id);
          }
        });
      }

      const usuariosNotificarUpdate = await prisma.usuario.findMany({
        where: { id: { in: Array.from(involucradosCorreo) } },
        select: { id: true, correo_electronico: true, nombre: true },
      });

      const nombreSolicitudCorreo = razon_social || marca_nombre || solicitud.razon_social || 'Sin nombre';

      for (const usuario of usuariosNotificarUpdate) {
        if (usuario.correo_electronico) {
          enviarCorreoNotificacion(
            solicitud.id,
            `Solicitud #${solicitud.id} editada`,
            `${userName} realizó cambios en la solicitud`,
            usuario.correo_electronico,
            usuario.nombre,
            {
              accion: 'Edición',
              usuario: userName,
              cliente: nombreSolicitudCorreo,
            }
          ).catch(err => console.error('Error enviando correo notificación:', err));
        }
      }

      // Check for pending authorizations after transaction and create tasks
      let autorizacion = { tienePendientes: false, pendientesDg: [] as number[], pendientesDcm: [] as number[] };
      if (propuesta) {
        autorizacion = await verificarCarasPendientes(propuesta.id.toString());

        // Crear tareas de autorización si hay pendientes
        if (autorizacion.tienePendientes && userId) {
          await crearTareasAutorizacion(
            solicitud.id,
            propuesta.id,
            userId,
            userName,
            autorizacion.pendientesDg,
            autorizacion.pendientesDcm
          );
        }
      }

      // Build message with authorization info
      let mensaje = 'Solicitud actualizada exitosamente';
      if (autorizacion.tienePendientes) {
        const totalPendientes = autorizacion.pendientesDg.length + autorizacion.pendientesDcm.length;
        mensaje = `Solicitud actualizada. ${totalPendientes} circuito(s) requieren autorización.`;
      }

      // Notificar a Tráfico sobre el ajuste de caras si hay propuesta
      if (propuesta && caras && caras.length > 0) {
        const usuariosTrafico = await prisma.usuario.findMany({
          where: {
            OR: [
              { puesto: { contains: 'Tráfico' } },
              { puesto: { contains: 'Trafico' } },
              { area: { contains: 'Tráfico' } },
              { area: { contains: 'Trafico' } }
            ],
            deleted_at: null
          },
          select: { id: true, nombre: true }
        });

        if (usuariosTrafico.length > 0) {
          const fechaFin = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
          fechaFin.setDate(fechaFin.getDate() + 7);

          for (const usuarioTrafico of usuariosTrafico) {
            if (usuarioTrafico.id !== userId) {
              await prisma.tareas.create({
                data: {
                  tipo: 'Ajuste de Caras',
                  titulo: `Solicitud #${solicitud.id} - Ajuste de caras`,
                  descripcion: `${userName} modificó las caras de la solicitud. Total de caras: ${caras.length}`,
                  estatus: 'Pendiente',
                  id_responsable: usuarioTrafico.id,
                  responsable: usuarioTrafico.nombre,
                  id_solicitud: solicitud.id.toString(),
                  id_propuesta: propuesta.id.toString(),
                  id_asignado: usuarioTrafico.id.toString(),
                  asignado: usuarioTrafico.nombre,
                  fecha_fin: fechaFin
                }
              });
            }
          }

          // Emitir notificación via WebSocket
          emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
            tipo: 'Ajuste de Caras',
            solicitudId: solicitud.id
          });
        }
      }

      res.json({
        success: true,
        message: mensaje,
        autorizacion,
      });

      // Emitir eventos WebSocket
      emitToSolicitudes(SOCKET_EVENTS.SOLICITUD_ACTUALIZADA, {
        solicitudId: solicitud.id,
        usuario: userName,
      });
      if (campania) {
        emitToCampanas(SOCKET_EVENTS.CAMPANA_ACTUALIZADA, {
          campaniaId: campania.id,
          usuario: userName,
        });
      }
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'solicitud', accion: 'actualizada' });
    } catch (error) {
      console.error('Error updating solicitud:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar solicitud';
      res.status(500).json({ success: false, error: message });
    }
  }

  async uploadArchivo(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!req.file) {
        res.status(400).json({ success: false, error: 'No se proporcionó archivo' });
        return;
      }

      const uploaded = await uploadBufferToSpaces(req.file.buffer, {
        folder: 'solicitudes',
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });

      await prisma.solicitud.update({
        where: { id: parseInt(id) },
        data: {
          archivo: uploaded.url,
        },
      });

      res.json({ success: true, data: { url: uploaded.url } });
    } catch (error) {
      console.error('Error uploading archivo:', error);
      const message = error instanceof Error ? error.message : 'Error al subir archivo';
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * Evalúa el estado de autorización de una cara sin guardarla
   * Útil para mostrar preview en el frontend antes de crear la solicitud
   */
  async evaluarAutorizacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      console.log('[evaluarAutorizacion] Body recibido:', req.body);
      const userId = req.user?.userId;
      const { ciudad, estado, formato, tipo, caras, bonificacion, costo, tarifa_publica, articulo } = req.body;

      // Validar datos requeridos
      if (!formato || caras === undefined || costo === undefined) {
        res.status(400).json({
          success: false,
          error: 'Faltan datos requeridos: formato, caras y costo son obligatorios'
        });
        return;
      }

      // Calcular estado de autorización
      const resultado = await calcularEstadoAutorizacion({
        ciudad: ciudad || null,
        estado: estado || null,
        formato,
        tipo: tipo || null,
        caras: Number(caras) || 0,
        bonificacion: Number(bonificacion) || 0,
        costo: Number(costo) || 0,
        tarifa_publica: Number(tarifa_publica) || 0,
        articulo: articulo || null
      }, userId);

      res.json({
        success: true,
        data: resultado
      });
    } catch (error) {
      console.error('Error evaluando autorización:', error);
      const message = error instanceof Error ? error.message : 'Error al evaluar autorización';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const solicitudesController = new SolicitudesController();
