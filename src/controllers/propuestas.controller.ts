import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import {
  calcularEstadoAutorizacion,
  verificarCarasPendientes,
  crearTareasAutorizacion
} from '../services/autorizacion.service';
import { emitToPropuesta, emitToAll, emitToPropuestas, emitToDashboard, SOCKET_EVENTS } from '../config/socket';
import { hasFullVisibility } from '../utils/permissions';
import nodemailer from 'nodemailer';

// transporter
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
                        datosAdicionales.idSolicitud ? `Solicitud ID #${datosAdicionales.idSolicitud}` : '',
                        datosAdicionales.idPropuesta ? `Propuesta ID #${datosAdicionales.idPropuesta}` : '',
                        datosAdicionales.idCampania ? `Campaña ID #${datosAdicionales.idCampania}` : '',
                      ].filter(Boolean).join('  ·  ')}</p>
                    </td>
                  </tr>
                </table>
                ` : ''}

                <!-- CTA Button -->
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="${linkUrl || `https://app.qeb.mx/solicitudes?viewId=${tareaId}`}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">${datosAdicionales.idCampania ? 'Ver Campaña' : 'Ver Propuesta'}</a>
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


export class PropuestasController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;
      const search = req.query.search as string;
      const soloAtendidas = req.query.soloAtendidas === 'true';

      // Build WHERE conditions
      let whereConditions = `pr.deleted_at IS NULL AND pr.status <> 'Sin solicitud activa' AND pr.status <> 'pendiente'`;
      const params: any[] = [];

      // Filter by solicitudes that have been attended
      if (soloAtendidas) {
        whereConditions += ` AND sl.status = 'Atendida'`;
      }

      if (status) {
        whereConditions += ` AND pr.status = ?`;
        params.push(status);
      }

      if (search) {
        whereConditions += ` AND (pr.articulo LIKE ? OR pr.descripcion LIKE ? OR pr.asignado LIKE ? OR cl.T1_U_Cliente LIKE ?)`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      // Visibility filter: non-leadership roles only see records where they participate
      const userId = req.user?.userId;
      const userRol = req.user?.rol || '';
      if (userId && !hasFullVisibility(userRol)) {
        whereConditions += ` AND (
          FIND_IN_SET(?, REPLACE(IFNULL(pr.id_asignado, ''), ' ', '')) > 0
          OR sl.usuario_id = ?
          OR FIND_IN_SET(?, REPLACE(IFNULL(sl.id_asignado, ''), ' ', '')) > 0
        )`;
        params.push(String(userId), userId, String(userId));
      }

      // Get total count
      const countQuery = `
        SELECT COUNT(DISTINCT pr.id) as total
        FROM propuesta pr
        LEFT JOIN solicitud sl ON sl.id = pr.solicitud_id
        LEFT JOIN cliente cl ON cl.id = pr.cliente_id
        WHERE ${whereConditions}
      `;
      const countResult = await prisma.$queryRawUnsafe<[{ total: bigint }]>(countQuery, ...params);
      const total = Number(countResult[0]?.total || 0);

      // Main query inspired by Retool - get propuestas with related data
      const offset = (page - 1) * limit;
      const mainQuery = `
        SELECT
          pr.id,
          pr.cliente_id,
          pr.fecha,
          pr.status,
          pr.descripcion,
          pr.precio,
          pr.notas,
          pr.solicitud_id,
          pr.precio_simulado,
          pr.asignado,
          pr.id_asignado,
          pr.inversion,
          pr.comentario_cambio_status,
          pr.articulo,
          pr.updated_at,
          cm.fecha_inicio,
          cm.fecha_fin,
          cm.nombre AS campana_nombre,
          cl.T1_U_Cliente AS nombre_comercial,
          cl.T0_U_Asesor AS asesor,
          cl.T0_U_Agencia AS agencia,
          cl.T2_U_Marca AS marca,
          cl.T2_U_Producto AS producto,
          cl.CUIC AS cuic,
          sl.nombre_usuario AS creador_nombre,
          sl.archivo AS archivo_solicitud,
          sl.marca_nombre,
          sl.sap_database AS sap_database,
          cat_inicio.numero_catorcena AS catorcena_inicio,
          cat_inicio.año AS anio_inicio,
          cat_fin.numero_catorcena AS catorcena_fin,
          cat_fin.año AS anio_fin,
          ct.tipo_periodo AS tipo_periodo
        FROM propuesta pr
        LEFT JOIN cotizacion ct ON ct.id_propuesta = pr.id
        LEFT JOIN campania cm ON cm.cotizacion_id = ct.id
        LEFT JOIN cliente cl ON cl.id = pr.cliente_id
        LEFT JOIN solicitud sl ON sl.id = pr.solicitud_id
        LEFT JOIN catorcenas cat_inicio ON cm.fecha_inicio BETWEEN cat_inicio.fecha_inicio AND cat_inicio.fecha_fin
        LEFT JOIN catorcenas cat_fin ON cm.fecha_fin BETWEEN cat_fin.fecha_inicio AND cat_fin.fecha_fin
        WHERE ${whereConditions}
        GROUP BY pr.id
        ORDER BY pr.id DESC
        LIMIT ? OFFSET ?
      `;

      const propuestas = await prisma.$queryRawUnsafe<any[]>(mainQuery, ...params, limit, offset);

      // Convert BigInt values and format dates
      const formattedPropuestas = propuestas.map(p => ({
        ...p,
        id: Number(p.id),
        cliente_id: Number(p.cliente_id),
        solicitud_id: Number(p.solicitud_id),
        precio: p.precio ? Number(p.precio) : null,
        precio_simulado: p.precio_simulado ? Number(p.precio_simulado) : null,
        inversion: p.inversion ? Number(p.inversion) : null,
        cuic: p.cuic ? Number(p.cuic) : null,
        marca_nombre: p.marca_nombre || p.marca || p.articulo,
        creador_nombre: p.creador_nombre || 'Sistema',
        catorcena_inicio: p.catorcena_inicio ? Number(p.catorcena_inicio) : null,
        anio_inicio: p.anio_inicio ? Number(p.anio_inicio) : null,
        catorcena_fin: p.catorcena_fin ? Number(p.catorcena_fin) : null,
        anio_fin: p.anio_fin ? Number(p.anio_fin) : null,
        tipo_periodo: p.tipo_periodo || 'catorcena',
      }));

      res.json({
        success: true,
        data: formattedPropuestas,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('Error in getAll propuestas:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener propuestas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const propuesta = await prisma.propuesta.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!propuesta) {
        res.status(404).json({
          success: false,
          error: 'Propuesta no encontrada',
        });
        return;
      }

      res.json({
        success: true,
        data: propuesta,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener propuesta';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getCaras(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const caras = await prisma.solicitudCaras.findMany({
        where: {
          idquote: String(id),
        },
        select: {
          id: true,
          idquote: true,
          ciudad: true,
          estados: true,
          tipo: true,
          flujo: true,
          bonificacion: true,
          caras: true,
          nivel_socioeconomico: true,
          formato: true,
          costo: true,
          tarifa_publica: true,
          inicio_periodo: true,
          fin_periodo: true,
          caras_flujo: true,
          caras_contraflujo: true,
          articulo: true,
          descuento: true,
          autorizacion_dg: true,
          autorizacion_dcm: true,
        },
      });

      res.json({
        success: true,
        data: caras,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener caras de propuesta';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async updateStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, comentario_cambio_status } = req.body;
      const userId = req.user?.userId || 0;
      const userName = req.user?.nombre || 'Usuario';
      const propuestaId = parseInt(id);

      // Obtener propuesta antes de actualizar
      const propuestaAnterior = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
      });

      if (!propuestaAnterior) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Si intenta cambiar a "Aprobada", verificar que no haya caras pendientes de autorización
      if (status === 'Aprobada') {
        const autorizacion = await verificarCarasPendientes(propuestaId.toString());
        if (autorizacion.tienePendientes) {
          const totalPendientes = autorizacion.pendientesDg.length + autorizacion.pendientesDcm.length;
          res.status(400).json({
            success: false,
            error: `No se puede aprobar la propuesta. ${totalPendientes} cara(s) están pendientes de autorización.`,
            autorizacion: {
              pendientesDg: autorizacion.pendientesDg.length,
              pendientesDcm: autorizacion.pendientesDcm.length
            }
          });
          return;
        }
      }

      const statusAnterior = propuestaAnterior.status;

      const propuesta = await prisma.propuesta.update({
        where: { id: propuestaId },
        data: {
          status,
          comentario_cambio_status: comentario_cambio_status || '',
          updated_at: new Date(),
        },
      });

      // Obtener datos relacionados para la notificación
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;
      const solicitud = propuesta.solicitud_id
        ? await prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } })
        : null;

      // Crear notificaciones para los involucrados
      const nombrePropuesta = cotizacion?.nombre_campania || `Propuesta #${propuestaId}`;
      const tituloNotificacion = `Cambio de estado en propuesta: ${nombrePropuesta}`;
      const descripcionNotificacion = `${userName} cambió el estado de "${statusAnterior}" a "${status}"${comentario_cambio_status ? ` - ${comentario_cambio_status}` : ''}`;

      // Recopilar involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados de la propuesta
      if (propuesta.id_asignado) {
        propuesta.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      // Agregar creador de la solicitud
      if (solicitud?.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
      }

      const now = new Date();
      const fechaFin = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Si el cambio es a "Ajuste Cto Cliente", crear tareas específicas para Tráfico
      if (status === 'Ajuste Cto-Cliente') {
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
          select: { id: true, nombre: true, correo_electronico: true }
        });
        
        // Crear tarea para cada usuario de Tráfico
        for (const usuarioTrafico of usuariosTrafico) {
          if (usuarioTrafico.id !== userId) {
            // Crear tarea
            await prisma.tareas.create({
              data: {
                titulo: `Ajustar propuesta: ${nombrePropuesta}`,
                descripcion: `Ajustar propuesta: ${nombrePropuesta}`,
                tipo: 'Ajuste Cto Cliente',
                estatus: 'Pendiente',
                id_responsable: usuarioTrafico.id,
                responsable: usuarioTrafico.nombre,
                asignado: usuarioTrafico.nombre,
                id_asignado: usuarioTrafico.id.toString(),
                id_solicitud: propuesta.solicitud_id?.toString() || '',
                id_propuesta: propuestaId.toString(),
                campania_id: campania?.id || null,
                fecha_inicio: now,
                fecha_fin: fechaFin,
              },
            });
          }
        }

        // Obtener catorcenas para el correo (DESPUÉS de la transacción)
        const catorcenaInicio = cotizacion?.fecha_inicio ? await prisma.catorcenas.findFirst({
          where: {
            fecha_inicio: { lte: cotizacion.fecha_inicio },
            fecha_fin: { gte: cotizacion.fecha_inicio },
          },
        }) : null;

        const catorcenaFin = cotizacion?.fecha_fin ? await prisma.catorcenas.findFirst({
          where: {
            fecha_inicio: { lte: cotizacion.fecha_fin },
            fecha_fin: { gte: cotizacion.fecha_fin },
          },
        }) : null;

        const periodoInicioStr = catorcenaInicio 
          ? `Cat ${catorcenaInicio.numero_catorcena} - ${catorcenaInicio.a_o}` 
          : undefined;
        const periodoFinStr = catorcenaFin 
          ? `Cat ${catorcenaFin.numero_catorcena} - ${catorcenaFin.a_o}` 
          : undefined;

        // Enviar correos a usuarios de Tráfico
        for (const usuarioTrafico of usuariosTrafico) {
          if (usuarioTrafico.id !== userId && usuarioTrafico.correo_electronico) {
            enviarCorreoTarea(
              propuesta.solicitud_id || 0,
              nombrePropuesta,
              `Ajustar propuesta: ${nombrePropuesta}`,
              fechaFin,
              usuarioTrafico.correo_electronico,
              usuarioTrafico.nombre,
              {
                cliente: solicitud?.razon_social || undefined,
                creador: userName,
                periodoInicio: periodoInicioStr,
                periodoFin: periodoFinStr,
                idPropuesta: propuestaId,
              },
              `https://app.qeb.mx/propuestas?viewId=${propuestaId}`
            ).catch(err => console.error('Error enviando correo:', err));
          }
        }
      }

      // Si el cambio es de "Ajuste Cto-Cliente" a otro status, notificar al creador de la solicitud
      if (statusAnterior === 'Ajuste Cto-Cliente' && solicitud?.usuario_id) {
        const creador = await prisma.usuario.findUnique({
          where: { id: solicitud.usuario_id },
          select: { nombre: true, correo_electronico: true }
        });

        if (creador?.correo_electronico) {
          enviarCorreoNotificacion(
            propuesta.solicitud_id || 0,
            `Propuesta atendida: ${nombrePropuesta}`,
            `${userName} cambió el estado de la propuesta "${nombrePropuesta}" de "Ajuste Cto-Cliente" a "${status}"`,
            creador.correo_electronico,
            creador.nombre,
            {
              accion: 'Cambio de estado',
              usuario: userName,
              cliente: solicitud?.razon_social || undefined,
            }
          ).catch(err => console.error('Error enviando correo:', err));
        }
      }

      // Crear notificación estándar para el resto de involucrados
      for (const responsableId of involucrados) {
        await prisma.tareas.create({
          data: {
            titulo: tituloNotificacion,
            descripcion: descripcionNotificacion,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            responsable: '',
            id_solicitud: propuesta.solicitud_id?.toString() || '',
            id_propuesta: propuestaId.toString(),
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      // Registrar en historial
      await prisma.historial.create({
        data: {
          tipo: 'Propuesta',
          ref_id: propuestaId,
          accion: 'Cambio de estado',
          fecha_hora: now,
          detalles: `${userName} cambió estado de "${statusAnterior}" a "${status}"${comentario_cambio_status ? ` - ${comentario_cambio_status}` : ''}`,
        },
      });

      res.json({
        success: true,
        data: propuesta,
      });

      // Emitir eventos WebSocket
      emitToPropuesta(propuestaId, SOCKET_EVENTS.PROPUESTA_STATUS_CHANGED, {
        propuestaId,
        statusAnterior,
        statusNuevo: status,
        usuario: userName,
      });
      emitToPropuestas(SOCKET_EVENTS.PROPUESTA_STATUS_CHANGED, {
        propuestaId,
        statusAnterior,
        statusNuevo: status,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'propuesta', accion: 'status_changed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar status';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async updateAsignados(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { asignados, id_asignados } = req.body;
      const userId = req.user?.userId || 0;
      const userName = req.user?.nombre || 'Usuario';
      const propuestaId = parseInt(id);

      // Obtener propuesta antes de actualizar para comparar asignados
      const propuestaAnterior = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
      });

      if (!propuestaAnterior) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      const asignadosAnteriores = propuestaAnterior.id_asignado?.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) || [];

      const propuesta = await prisma.propuesta.update({
        where: { id: propuestaId },
        data: {
          asignado: asignados,
          id_asignado: id_asignados,
          updated_at: new Date(),
        },
      });

      // Obtener datos relacionados para la notificación
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      const nombrePropuesta = cotizacion?.nombre_campania || `Propuesta #${propuestaId}`;

      // Identificar nuevos asignados (los que no estaban antes)
      const nuevosAsignadosIds = id_asignados?.split(',').map((id: string) => parseInt(id.trim())).filter((id: number) => !isNaN(id)) || [];
      const nuevosAsignados = nuevosAsignadosIds.filter((id: number) => !asignadosAnteriores.includes(id) && id !== userId);

      // Crear notificación para los NUEVOS asignados
      const now = new Date();
      const fechaFin = cotizacion?.fecha_fin || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      for (const responsableId of nuevosAsignados) {
        await prisma.tareas.create({
          data: {
            titulo: `Asignación a propuesta: ${nombrePropuesta}`,
            descripcion: `${userName} te asignó a esta propuesta`,
            tipo: 'Solicitud',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            responsable: '',
            id_solicitud: propuesta.solicitud_id?.toString() || '',
            id_propuesta: propuestaId.toString(),
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      // Notificar a los asignados que fueron removidos
      const removidos = asignadosAnteriores.filter(id => !nuevosAsignadosIds.includes(id) && id !== userId);
      for (const responsableId of removidos) {
        await prisma.tareas.create({
          data: {
            titulo: `Removido de propuesta: ${nombrePropuesta}`,
            descripcion: `${userName} te removió de esta propuesta`,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            responsable: '',
            id_solicitud: propuesta.solicitud_id?.toString() || '',
            id_propuesta: propuestaId.toString(),
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      // Registrar en historial
      await prisma.historial.create({
        data: {
          tipo: 'Propuesta',
          ref_id: propuestaId,
          accion: 'Reasignación',
          fecha_hora: now,
          detalles: `${userName} actualizó asignados a: ${asignados}`,
        },
      });

      res.json({
        success: true,
        data: propuesta,
        message: 'Asignados actualizados correctamente',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar asignados';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Visibility filter
      const userId = req.user?.userId;
      const userRol = req.user?.rol || '';
      let visibilityClause = '';
      const statsParams: (string | number)[] = [];
      if (userId && !hasFullVisibility(userRol)) {
        visibilityClause = `
          AND (
            FIND_IN_SET(?, REPLACE(IFNULL(pr.id_asignado, ''), ' ', '')) > 0
            OR sl.usuario_id = ?
            OR FIND_IN_SET(?, REPLACE(IFNULL(sl.id_asignado, ''), ' ', '')) > 0
          )`;
        statsParams.push(String(userId), userId, String(userId));
      }

      // Count propuestas grouped by status, filtering only those with solicitud.status = 'Atendida'
      // This matches the same filter used by getAll (soloAtendidas: true)
      const statusCounts = await prisma.$queryRawUnsafe<Array<{ status: string; count: bigint }>>(`
        SELECT pr.status, COUNT(*) as count
        FROM propuesta pr
        LEFT JOIN solicitud sl ON sl.id = pr.solicitud_id
        WHERE pr.deleted_at IS NULL
          AND pr.status NOT IN ('pendiente', 'Pendiente', 'Sin solicitud activa')
          AND sl.status = 'Atendida'
          ${visibilityClause}
        GROUP BY pr.status
      `, ...statsParams);

      const byStatus: Record<string, number> = {};
      let total = 0;
      statusCounts.forEach(item => {
        const status = item.status || 'Sin estado';
        const count = Number(item.count);
        byStatus[status] = count;
        total += count;
      });

      res.json({
        success: true,
        data: {
          total,
          byStatus,
          // Keep legacy fields for compatibility
          pendientes: byStatus['Abierto'] || byStatus['Pendiente'] || byStatus['Por aprobar'] || 0,
          aprobadas: byStatus['Atendido'] || byStatus['Aprobada'] || byStatus['Activa'] || 0,
          rechazadas: byStatus['Rechazada'] || 0,
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

  // Get comments for a propuesta (using solicitud_id to share comments with solicitudes)
  async getComments(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      // Get propuesta to find solicitud_id
      const propuesta = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
        select: { solicitud_id: true },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Get comments from 'comentarios' table using solicitud_id (shared with solicitudes)
      const comments = await prisma.comentarios.findMany({
        where: { solicitud_id: propuesta.solicitud_id },
        orderBy: { creado_en: 'desc' },
      });

      // Get user photos by autor_id
      const autorIds = [...new Set(comments.map(c => c.autor_id))];
      const usuarios = autorIds.length > 0 ? await prisma.usuario.findMany({
        where: { id: { in: autorIds } },
        select: { id: true, nombre: true, foto_perfil: true },
      }) : [];
      const usuarioMap = new Map(usuarios.map(u => [u.id, { nombre: u.nombre, foto: u.foto_perfil }]));

      const formattedComments = comments.map(c => ({
        id: c.id,
        comentario: c.comentario,
        creado_en: c.creado_en,
        autor_nombre: usuarioMap.get(c.autor_id)?.nombre || 'Usuario',
        autor_foto: usuarioMap.get(c.autor_id)?.foto || null,
        origen: c.origen,
      }));

      res.json({
        success: true,
        data: formattedComments,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener comentarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Add comment to a propuesta (saves to comentarios table using solicitud_id to share with solicitudes)
  async addComment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { comentario } = req.body;
      const userName = req.user?.nombre || 'Usuario';
      const userId = req.user?.userId || 0;
      const propuestaId = parseInt(id);

      // Obtener la propuesta para conseguir los asignados y solicitud_id
      const propuesta = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Get campania_id from cotizacion -> campania
      const cotizacionForComment = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });
      const campaniaForComment = cotizacionForComment ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacionForComment.id },
      }) : null;

      // Save to comentarios table (shared with solicitudes)
      const newComment = await prisma.comentarios.create({
        data: {
          autor_id: userId,
          comentario,
          creado_en: new Date(),
          campania_id: campaniaForComment?.id || 0,
          solicitud_id: propuesta.solicitud_id,
          origen: 'propuesta',
        },
      });

      // Crear notificaciones para todos los involucrados (excepto el autor)
      // Obtener nombre de la cotización/campaña para el título
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });
      const nombrePropuesta = cotizacion?.nombre_campania || `Propuesta #${propuestaId}`;
      const tituloNotificacion = `Nuevo comentario en propuesta: ${nombrePropuesta}`;
      const descripcionNotificacion = `${userName} comentó: ${comentario.substring(0, 100)}${comentario.length > 100 ? '...' : ''}`;

      // Obtener campaña si existe
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      // Obtener solicitud para el creador
      const solicitudData = propuesta.solicitud_id
        ? await prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } })
        : null;

      // Recopilar todos los involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados de la propuesta
      if (propuesta.id_asignado) {
        propuesta.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      // Agregar creador de la solicitud
      if (solicitudData?.usuario_id && solicitudData.usuario_id !== userId) {
        involucrados.add(solicitudData.usuario_id);
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
            id_solicitud: propuesta.solicitud_id?.toString() || '',
            id_propuesta: propuestaId.toString(),
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
          id: newComment.id,
          comentario: newComment.comentario,
          creado_en: newComment.creado_en,
          autor_nombre: userName,
        },
        message: 'Comentario agregado',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al agregar comentario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Approve propuesta - complex operation
  async approve(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { precio_simulado, asignados, id_asignados } = req.body;
      const propuestaId = parseInt(id);

      // Get propuesta with related data
      const propuesta = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Get solicitud data
      const solicitud = await prisma.solicitud.findUnique({
        where: { id: propuesta.solicitud_id },
      });

      // Get cotizacion
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });

      // Get campania
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      // Start transaction with extended timeout (30s)
      await prisma.$transaction(async (tx) => {
        // 1. Call stored procedure for reservas
        await tx.$executeRaw`CALL actualizar_reservas(${propuestaId})`;

        // 2. Update tareas status
        await tx.tareas.updateMany({
          where: { id_propuesta: String(propuestaId) },
          data: { estatus: 'Aprobada' },
        });

        // 3. Update propuesta
        await tx.propuesta.update({
          where: { id: propuestaId },
          data: {
            status: 'Aprobada',
            precio_simulado: precio_simulado || propuesta.precio_simulado,
            asignado: asignados || propuesta.asignado,
            id_asignado: id_asignados || propuesta.id_asignado,
            updated_at: new Date(),
          },
        });

        // 4. Update cotizacion and campania if exists
        if (cotizacion) {
          await tx.cotizacion.update({
            where: { id: cotizacion.id },
            data: {
              status: 'Activa',
              precio: precio_simulado || cotizacion.precio,
            },
          });

          if (campania) {
            await tx.campania.update({
              where: { id: campania.id },
              data: { status: 'Por iniciar', fecha_aprobacion: new Date() },
            });
          }
        }

        // 5. Create seguimiento task
        // if (solicitud && campania) {
        //   await tx.tareas.create({
        //     data: {
        //       tipo: 'Seguimiento Campaña',
        //       responsable: solicitud.nombre_usuario,
        //       estatus: 'Pendientes',
        //       descripcion: 'Ya se atendió la propuesta pero es necesario darle seguimiento',
        //       titulo: campania.nombre,
        //       id_propuesta: String(propuestaId),
        //       id_responsable: solicitud.usuario_id || 0,
        //       fecha_inicio: propuesta.fecha,
        //       fecha_fin: cotizacion?.fecha_fin || propuesta.fecha,
        //       asignado: asignados || propuesta.asignado,
        //       id_asignado: id_asignados || propuesta.id_asignado,
        //       campania_id: campania.id,
        //       id_solicitud: String(propuesta.solicitud_id),
        //     },
        //   });
        // }

        // 5. Create seguimiento task
        if (campania) {
        // Obtener catorcenas incluidas en la campaña para el contenido de la tarea
        const catorcenasQuery = `
          SELECT DISTINCT
            cat.numero_catorcena,
            cat.año as anio,
            cat.fecha_inicio,
            cat.fecha_fin,
            COUNT(DISTINCT rsv.id) as num_caras
          FROM catorcenas cat
          INNER JOIN solicitudCaras sc ON (
            cat.fecha_inicio <= sc.fin_periodo AND cat.fecha_fin >= sc.inicio_periodo
          )
          LEFT JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id AND rsv.deleted_at IS NULL
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          WHERE ct.id = ?
          GROUP BY cat.numero_catorcena, cat.año, cat.fecha_inicio, cat.fecha_fin
          ORDER BY cat.año, cat.numero_catorcena
        `;
        const catorcenas = await tx.$queryRawUnsafe<{
          numero_catorcena: number;
          anio: number;
          fecha_inicio: Date;
          fecha_fin: Date;
          num_caras: bigint;
        }[]>(catorcenasQuery, cotizacion?.id);

        // contenido HTML con tabla de catorcenas
        console.log('Catorcenas result:', JSON.stringify(catorcenas, (_, v) => typeof v === 'bigint' ? Number(v) : v));
        const tablaCatorcenas = catorcenas && catorcenas.length > 0 ? catorcenas.map(cat =>
          `Cat ${cat.numero_catorcena}, ${new Date(cat.fecha_inicio).toLocaleDateString('es-MX')}, ${new Date(cat.fecha_fin).toLocaleDateString('es-MX')}`
        ).join('\n') : 'Sin catorcenas definidas';
        console.log('tablaCatorcenas:', tablaCatorcenas);

        const contenidoTarea = `
      Cliente: ${solicitud?.razon_social || 'Sin cliente'}
      Campaña: ${campania.nombre}
      Fecha límite: ${cotizacion?.fecha_fin ? new Date(cotizacion.fecha_fin).toLocaleDateString('es-MX') : 'Sin definir'}

      CATORCENAS INCLUIDAS:
      ${tablaCatorcenas}

      Ver campaña: https://app.qeb.mx/campanas/${campania.id}
        `.trim();

        // Obtener usuarios del área de Analista
        const usuariosAnalista = await tx.usuario.findMany({
          where: {
            OR: [
              { puesto: { contains: 'Analista' } },
              { area: { contains: 'Analista' } }
            ],
            deleted_at: null
          },
          select: { id: true, nombre: true, correo_electronico: true }
        });

        // Crear tarea "Seguimiento Campaña" para cada Analista
        for (const usuarioAnalista of usuariosAnalista) {
          await tx.tareas.create({
            data: {
              tipo: 'Seguimiento Campaña',
              titulo: 'Seguimiento Campaña',
              descripcion: `Dar seguimiento a la campaña: ${campania.nombre}`,
              contenido: contenidoTarea, // ← AQUÍ está toda la info
              estatus: 'Pendiente',
              id_responsable: usuarioAnalista.id,
              responsable: usuarioAnalista.nombre,
              asignado: usuarioAnalista.nombre,
              id_asignado: usuarioAnalista.id.toString(),
              id_solicitud: String(propuesta.solicitud_id),
              id_propuesta: String(propuestaId),
              campania_id: campania.id,
              fecha_inicio: new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })),
              fecha_fin: (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })); d.setDate(d.getDate() + 7); return d; })(),
            },
          });
        }

        // Crear notificaciones para asignados de la propuesta (excluyendo Analistas)
        const asignadosPropuesta = propuesta.id_asignado 
          ? propuesta.id_asignado.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) 
          : [];
        const analistaIds = usuariosAnalista.map(u => u.id);
        const asignadosSinAnalistas = asignadosPropuesta.filter(id => !analistaIds.includes(id));

        for (const asignadoId of asignadosSinAnalistas) {
          const usuario = await tx.usuario.findUnique({
            where: { id: asignadoId },
            select: { nombre: true, correo_electronico: true }
          });

          if (usuario) {
            await tx.tareas.create({
              data: {
                tipo: 'Notificación',
                titulo: `Campaña nueva - ${campania.nombre}`,
                descripcion: `Campaña aprobada: ${campania.nombre}. Cliente: ${solicitud?.razon_social || 'Sin nombre'}. Período: ${cotizacion?.fecha_inicio ? new Date(cotizacion.fecha_inicio).toLocaleDateString() : ''} - ${cotizacion?.fecha_fin ? new Date(cotizacion.fecha_fin).toLocaleDateString() : ''}`,
                estatus: 'Pendiente',
                id_responsable: asignadoId,
                responsable: usuario.nombre,
                asignado: usuario.nombre,
                id_asignado: asignadoId.toString(),
                id_solicitud: String(propuesta.solicitud_id),
                id_propuesta: String(propuestaId),
                campania_id: campania.id,
                fecha_inicio: new Date(),
                fecha_fin: new Date(Date.now() + 24 * 60 * 60 * 1000),
              },
            });
          }
        }

        // Crear notificación "Campaña nueva" para Diseñadores
        const usuariosDisenoDB = await tx.usuario.findMany({
          where: { user_role: 'Diseñadores', deleted_at: null },
          select: { id: true, nombre: true }
        });

        for (const disenador of usuariosDisenoDB) {
          await tx.tareas.create({
            data: {
              tipo: 'Notificación',
              titulo: `Campaña nueva - ${campania.nombre}`,
              descripcion: `Campaña aprobada: ${campania.nombre}. Cliente: ${solicitud?.razon_social || 'Sin nombre'}. Período: ${cotizacion?.fecha_inicio ? new Date(cotizacion.fecha_inicio).toLocaleDateString() : ''} - ${cotizacion?.fecha_fin ? new Date(cotizacion.fecha_fin).toLocaleDateString() : ''}`,
              estatus: 'Pendiente',
              id_responsable: disenador.id,
              responsable: disenador.nombre,
              asignado: disenador.nombre,
              id_asignado: disenador.id.toString(),
              id_solicitud: String(propuesta.solicitud_id),
              id_propuesta: String(propuestaId),
              campania_id: campania.id,
              fecha_inicio: new Date(),
              fecha_fin: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
        }
      }

        // 6. Add historial entries
        await tx.historial.createMany({
          data: [
            {
              tipo: 'Propuesta',
              ref_id: propuestaId,
              accion: 'Finalización',
              detalles: 'Propuesta Aprobada',
              fecha_hora: new Date(),
            },
            {
              tipo: 'Campaña',
              ref_id: campania?.id || propuestaId,
              accion: 'Creación',
              detalles: 'Se ha creado la campaña',
              fecha_hora: new Date(),
            },
          ],
        });

        // 7. Create notification for solicitud creator
        if (solicitud) {
          const creador = await tx.usuario.findUnique({
            where: { id: solicitud.usuario_id || 0 },
          });

          if (creador) {
            await tx.tareas.create({
              data: {
                tipo: 'Notificación',
                responsable: creador.nombre,
                id_responsable: creador.id,
                estatus: 'Notificación nueva',
                descripcion: `Se ha aprobado la propuesta con el id: ${propuestaId}`,
                titulo: 'Propuesta aprobada',
                id_propuesta: String(propuestaId),
                asignado: creador.nombre,
                id_asignado: String(creador.id),
                fecha_inicio: propuesta.fecha,
                fecha_fin: cotizacion?.fecha_fin || propuesta.fecha,
                id_solicitud: String(propuesta.solicitud_id),
                campania_id: campania?.id || null,
              },
            });
          }
        }
      }, { timeout: 30000 });

      // Enviar correos a Analistas (Seguimiento Campaña)
      if (campania) {
        const usuariosAnalistaCorreo = await prisma.usuario.findMany({
          where: {
            OR: [
              { puesto: { contains: 'Analista' } },
              { area: { contains: 'Analista' } }
            ],
            deleted_at: null
          },
          select: { id: true, nombre: true, correo_electronico: true }
        });

        // Obtener catorcenas para el correo
        const catorcenaInicio = cotizacion?.fecha_inicio ? await prisma.catorcenas.findFirst({
          where: {
            fecha_inicio: { lte: cotizacion.fecha_inicio },
            fecha_fin: { gte: cotizacion.fecha_inicio },
          },
        }) : null;

        const catorcenaFin = cotizacion?.fecha_fin ? await prisma.catorcenas.findFirst({
          where: {
            fecha_inicio: { lte: cotizacion.fecha_fin },
            fecha_fin: { gte: cotizacion.fecha_fin },
          },
        }) : null;

        const periodoInicioStr = catorcenaInicio 
          ? `Cat ${catorcenaInicio.numero_catorcena} - ${catorcenaInicio.a_o}` 
          : undefined;
        const periodoFinStr = catorcenaFin 
          ? `Cat ${catorcenaFin.numero_catorcena} - ${catorcenaFin.a_o}` 
          : undefined;

        for (const analista of usuariosAnalistaCorreo) {
          if (analista.correo_electronico) {
            enviarCorreoTarea(
              propuesta.solicitud_id || 0,
              campania.nombre,
              `Dar seguimiento a la campaña: ${campania.nombre}`,
              cotizacion?.fecha_fin || new Date(),
              analista.correo_electronico,
              analista.nombre,
              {
                cliente: solicitud?.razon_social || undefined,
                creador: req.user?.nombre || 'Usuario',
                periodoInicio: periodoInicioStr,
                periodoFin: periodoFinStr,
                idCampania: campania.id,
              },
              `https://app.qeb.mx/campanas/${campania.id}`
            ).catch(err => console.error('Error enviando correo:', err));
          }
        }

        // Enviar correos a Diseñadores (Campaña nueva)
        const usuariosDiseno = await prisma.usuario.findMany({
          where: {
            user_role: 'Diseñadores',
            deleted_at: null
          },
          select: { id: true, nombre: true, correo_electronico: true }
        });

        for (const disenador of usuariosDiseno) {
          if (disenador.correo_electronico) {
            enviarCorreoTarea(
              propuesta.solicitud_id || 0,
              campania.nombre,
              `Campaña nueva: ${campania.nombre}`,
              cotizacion?.fecha_fin || new Date(),
              disenador.correo_electronico,
              disenador.nombre,
              {
                cliente: solicitud?.razon_social || undefined,
                creador: req.user?.nombre || 'Usuario',
                periodoInicio: periodoInicioStr,
                periodoFin: periodoFinStr,
                idCampania: campania.id,
              }
            ).catch(err => console.error('Error enviando correo a diseño:', err));
          }
        }

        // Enviar notificaciones a asignados (excluyendo Analistas)
        const asignadosPropuesta = propuesta.id_asignado 
          ? propuesta.id_asignado.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) 
          : [];
        const analistaIds = usuariosAnalistaCorreo.map(u => u.id);
        const asignadosSinAnalistas = asignadosPropuesta.filter(id => !analistaIds.includes(id));

        for (const asignadoId of asignadosSinAnalistas) {
          const usuario = await prisma.usuario.findUnique({
            where: { id: asignadoId },
            select: { nombre: true, correo_electronico: true }
          });

          if (usuario?.correo_electronico) {
            enviarCorreoNotificacion(
              propuesta.solicitud_id || 0,
              `Campaña nueva - ${campania.nombre}`,
              `Campaña aprobada: ${campania.nombre}. Cliente: ${solicitud?.razon_social || 'Sin nombre'}. Período: ${periodoInicioStr || ''} - ${periodoFinStr || ''}`,
              usuario.correo_electronico,
              usuario.nombre,
              {
                accion: 'Campaña aprobada',
                usuario: req.user?.nombre || 'Usuario',
                cliente: solicitud?.razon_social || undefined,
              }
            ).catch(err => console.error('Error enviando correo notificación:', err));
          }
        }
      }

      res.json({
        success: true,
        message: 'Propuesta aprobada exitosamente',
      });
    } catch (error) {
      console.error('Error approving propuesta:', error);
      const message = error instanceof Error ? error.message : 'Error al aprobar propuesta';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Get full details for compartir view
  async getFullDetails(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      // Get propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Get related data
      const [solicitud, cotizacion, campania, caras] = await Promise.all([
        prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } }),
        prisma.cotizacion.findFirst({ where: { id_propuesta: propuestaId } }),
        prisma.campania.findFirst({
          where: {
            cotizacion_id: { in: (await prisma.cotizacion.findMany({ where: { id_propuesta: propuestaId }, select: { id: true } })).map(c => c.id) }
          }
        }),
        prisma.solicitudCaras.findMany({ where: { idquote: String(propuestaId) } }),
      ]);

      res.json({
        success: true,
        data: {
          propuesta,
          solicitud,
          cotizacion,
          campania,
          caras,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener detalles';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Get reserved inventory for propuesta
  async getInventarioReservado(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      const query = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          MIN(i.id) as id,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(MIN(i.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(i.codigo_unico), '_', -1))
            ELSE MIN(i.codigo_unico)
          END as codigo_unico,
          MAX(sc.id) AS solicitud_caras_id,
          MIN(i.mueble) as mueble,
          MIN(i.estado) as estado,
          MIN(i.municipio) as municipio,
          MIN(i.ubicacion) as ubicacion,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL THEN 'Completo'
            ELSE MIN(i.tipo_de_cara)
          END as tipo_de_cara,
          CAST(COUNT(DISTINCT rsv.id) AS UNSIGNED) AS caras_totales,
          MIN(i.latitud) as latitud,
          MIN(i.longitud) as longitud,
          MIN(i.plaza) as plaza,
          MAX(rsv.estatus) as estatus_reserva,
          MAX(sc.articulo) as articulo,
          MAX(sc.tipo) as tipo_medio,
          MAX(sc.inicio_periodo) as inicio_periodo,
          MAX(sc.fin_periodo) as fin_periodo,
          MIN(i.tradicional_digital) as tradicional_digital,
          MIN(i.tipo_de_mueble) as tipo_de_mueble,
          MIN(i.ancho) as ancho,
          MIN(i.alto) as alto,
          MIN(i.nivel_socioeconomico) as nivel_socioeconomico,
          COALESCE(MAX(sc.tarifa_publica), MIN(i.tarifa_publica), 0) as tarifa_publica,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          cat.numero_catorcena,
          cat.año as anio_catorcena
        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE sc.idquote = ?
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), cat.numero_catorcena, cat.año
        ORDER BY cat.año DESC, cat.numero_catorcena DESC, MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, String(propuestaId)) as any[];

      // Convert BigInts to numbers to avoid serialization errors
      const serializedInventario = inventario.map(item => ({
        ...item,
        caras_totales: Number(item.caras_totales),
      }));

      res.json({
        success: true,
        data: serializedInventario,
      });
    } catch (error) {
      console.error('Error en getInventarioReservado propuesta:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventario';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Public endpoint for client view (no auth required)
  async getPublicDetails(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      // Get propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Get related data
      const [solicitud, cotizacion, campania, caras] = await Promise.all([
        prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } }),
        prisma.cotizacion.findFirst({ where: { id_propuesta: propuestaId } }),
        prisma.campania.findFirst({
          where: {
            cotizacion_id: { in: (await prisma.cotizacion.findMany({ where: { id_propuesta: propuestaId }, select: { id: true } })).map(c => c.id) }
          }
        }),
        prisma.solicitudCaras.findMany({ where: { idquote: String(propuestaId) } }),
      ]);

      // Get cliente name
      let clienteNombre = '';
      if (solicitud?.cliente_id) {
        const cliente = await prisma.cliente.findUnique({ where: { id: solicitud.cliente_id } });
        clienteNombre = cliente?.T0_U_Cliente || '';
      }

      // Get catorcena info from campaign dates
      let catorcenaInicio = null;
      let anioInicio = null;
      let catorcenaFin = null;
      let anioFin = null;

      if (campania) {
        // Get catorcena for fecha_inicio
        const catInicio = await prisma.$queryRaw<any[]>`
          SELECT numero_catorcena, año as anio
          FROM catorcenas
          WHERE ${campania.fecha_inicio} BETWEEN fecha_inicio AND fecha_fin
          LIMIT 1
        `;
        if (catInicio.length > 0) {
          catorcenaInicio = Number(catInicio[0].numero_catorcena);
          anioInicio = Number(catInicio[0].anio);
        }

        // Get catorcena for fecha_fin
        const catFin = await prisma.$queryRaw<any[]>`
          SELECT numero_catorcena, año as anio
          FROM catorcenas
          WHERE ${campania.fecha_fin} BETWEEN fecha_inicio AND fecha_fin
          LIMIT 1
        `;
        if (catFin.length > 0) {
          catorcenaFin = Number(catFin[0].numero_catorcena);
          anioFin = Number(catFin[0].anio);
        }
      }

      // Get inventory
      const inventarioQuery = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          MIN(i.id) as id,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(MIN(i.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(i.codigo_unico), '_', -1))
            ELSE MIN(i.codigo_unico)
          END as codigo_unico,
          MAX(sc.id) AS solicitud_caras_id,
          MIN(i.mueble) as mueble,
          MIN(i.estado) as estado,
          MIN(i.municipio) as municipio,
          MIN(i.ubicacion) as ubicacion,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL THEN 'Completo'
            ELSE MIN(i.tipo_de_cara)
          END as tipo_de_cara,
          CAST(COUNT(DISTINCT rsv.id) AS UNSIGNED) AS caras_totales,
          MIN(i.latitud) as latitud,
          MIN(i.longitud) as longitud,
          MIN(i.plaza) as plaza,
          MAX(rsv.estatus) as estatus_reserva,
          MAX(sc.articulo) as articulo,
          MAX(sc.tipo) as tipo_medio,
          MAX(sc.inicio_periodo) as inicio_periodo,
          MAX(sc.fin_periodo) as fin_periodo,
          MIN(i.tradicional_digital) as tradicional_digital,
          MIN(i.tipo_de_mueble) as tipo_de_mueble,
          MIN(i.ancho) as ancho,
          MIN(i.alto) as alto,
          MIN(i.nivel_socioeconomico) as nivel_socioeconomico,
          COALESCE(MAX(sc.tarifa_publica), MIN(i.tarifa_publica), 0) as tarifa_publica,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          cat.numero_catorcena,
          cat.año as anio_catorcena
        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE sc.idquote = ?
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), cat.numero_catorcena, cat.año
        ORDER BY cat.año DESC, cat.numero_catorcena DESC, MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(inventarioQuery, String(propuestaId)) as any[];

      // Convert BigInts to numbers
      const serializedInventario = inventario.map(item => ({
        ...item,
        caras_totales: Number(item.caras_totales),
      }));

      res.json({
        success: true,
        data: {
          propuesta: {
            id: propuesta.id,
            status: propuesta.status,
            descripcion: propuesta.descripcion,
            notas: propuesta.notas,
            fecha: propuesta.fecha,
            catorcena_inicio: catorcenaInicio,
            anio_inicio: anioInicio,
            catorcena_fin: catorcenaFin,
            anio_fin: anioFin,
          },
          solicitud: solicitud ? {
            cuic: solicitud.cuic,
            cliente: clienteNombre,
            razon_social: solicitud.razon_social,
            unidad_negocio: solicitud.unidad_negocio,
            marca_nombre: solicitud.marca_nombre,
            asesor: solicitud.asesor,
            agencia: solicitud.agencia,
            producto_nombre: solicitud.producto_nombre,
            categoria_nombre: solicitud.categoria_nombre,
          } : null,
          cotizacion: cotizacion ? {
            nombre_campania: cotizacion.nombre_campania,
            fecha_inicio: cotizacion.fecha_inicio,
            fecha_fin: cotizacion.fecha_fin,
            numero_caras: cotizacion.numero_caras,
            bonificacion: cotizacion.bonificacion,
            precio: cotizacion.precio,
          } : null,
          campania: campania ? {
            id: campania.id,
            nombre: campania.nombre,
            status: campania.status,
          } : null,
          caras,
          inventario: serializedInventario,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener detalles';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Create reservas for a propuesta
  async createReservas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);
      const { reservas, solicitudCaraId, clienteId, fechaInicio, fechaFin, agruparComoCompleto = true } = req.body;

      if (!reservas || !Array.isArray(reservas) || reservas.length === 0) {
        res.status(400).json({ success: false, error: 'No hay reservas para guardar' });
        return;
      }

      // 0. Get all solicitudCaras IDs for duplicate check
      const proposalCaras = await prisma.solicitudCaras.findMany({
        where: { idquote: String(propuestaId) },
        select: { id: true }
      });
      const proposalCaraIds = proposalCaras.map(p => p.id);

      // Verify propuesta exists
      const propuesta = await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Check for pending authorizations - block inventory assignment if there are pending caras
      const autorizacion = await verificarCarasPendientes(propuestaId.toString());
      if (autorizacion.tienePendientes) {
        const totalPendientes = autorizacion.pendientesDg.length + autorizacion.pendientesDcm.length;
        res.status(400).json({
          success: false,
          error: `No se puede asignar inventario. ${totalPendientes} cara(s) están pendientes de autorización.`,
          autorizacion: {
            pendientesDg: autorizacion.pendientesDg.length,
            pendientesDcm: autorizacion.pendientesDcm.length
          }
        });
        return;
      }

      // Create calendario entry
      const calendario = await prisma.calendario.create({
        data: {
          fecha_inicio: new Date(fechaInicio),
          fecha_fin: new Date(fechaFin),
        },
      });

      // Obtener calendarios que se solapan con el período para validar disponibilidad
      const fechaIni = new Date(fechaInicio);
      const fechaFinDate = new Date(fechaFin);
      const calendariosOverlap = await prisma.calendario.findMany({
        where: {
          deleted_at: null,
          fecha_inicio: { lte: fechaFinDate },
          fecha_fin: { gte: fechaIni },
        },
        select: { id: true },
      });
      const calendarioIdsOverlap = calendariosOverlap.map(c => c.id);

      // Obtener espacios ya reservados en el período (excluyendo los de esta propuesta)
      let espaciosReservadosEnPeriodo: Set<number> = new Set();
      if (calendarioIdsOverlap.length > 0) {
        const reservasExistentes = await prisma.reservas.findMany({
          where: {
            deleted_at: null,
            calendario_id: { in: calendarioIdsOverlap },
            estatus: { in: ['Reservado', 'Bonificado', 'Apartado', 'Vendido'] },
            solicitudCaras_id: { notIn: proposalCaraIds }, // Excluir reservas de esta propuesta
          },
          select: { inventario_id: true },
        });
        espaciosReservadosEnPeriodo = new Set(reservasExistentes.map(r => r.inventario_id));
      }

      // Group reservas by whether they are completo (flujo + contraflujo at same location)
      const gruposCompletos: Map<string, number[]> = new Map();
      let reservasNormales: typeof reservas = [];

      // Only group if agruparComoCompleto is enabled
      if (agruparComoCompleto) {
        // First pass: identify grupos completos by location
        const locationMap: Map<string, typeof reservas> = new Map();
        for (const reserva of reservas) {
          const locationKey = `${reserva.latitud}-${reserva.longitud}`;
          if (!locationMap.has(locationKey)) {
            locationMap.set(locationKey, []);
          }
          locationMap.get(locationKey)!.push(reserva);
        }

        // Get max grupo_completo_id from database to avoid collisions
        const maxGrupoResult = await prisma.$queryRaw<[{ max_grupo: number | null }]>`
          SELECT MAX(grupo_completo_id) as max_grupo FROM reservas WHERE grupo_completo_id IS NOT NULL
        `;
        let nextGrupoCompletoId = (maxGrupoResult[0]?.max_grupo || 0) + 1;

        // Second pass: determine if location has both flujo and contraflujo
        for (const [locationKey, locationReservas] of locationMap) {
          const hasFlujo = locationReservas.some(r => r.tipo === 'Flujo');
          const hasContraflujo = locationReservas.some(r => r.tipo === 'Contraflujo');

          if (hasFlujo && hasContraflujo) {
            // This is a grupo completo - use sequential ID
            const grupoId = nextGrupoCompletoId++;
            for (const reserva of locationReservas) {
              if (reserva.tipo === 'Flujo' || reserva.tipo === 'Contraflujo') {
                if (!gruposCompletos.has(String(grupoId))) {
                  gruposCompletos.set(String(grupoId), []);
                }
                gruposCompletos.get(String(grupoId))!.push(reserva.inventario_id);
              }
            }
          } else {
            reservasNormales.push(...locationReservas);
          }
        }
      } else {
        // No grouping - all reservas are treated as normal
        reservasNormales = [...reservas];
      }

      // Get espacio_inventario ids for the inventario_ids (only for items without espacio_id)
      const inventarioIdsWithoutEspacio = reservas.filter(r => !r.espacio_id).map(r => r.inventario_id);
      const espacios = inventarioIdsWithoutEspacio.length > 0
        ? await prisma.espacio_inventario.findMany({
            where: { inventario_id: { in: inventarioIdsWithoutEspacio } },
            orderBy: { numero_espacio: 'asc' },
          })
        : [];

      // Agrupar espacios por inventario_id para encontrar el primer disponible
      const espaciosPorInventario = new Map<number, number[]>();
      for (const esp of espacios) {
        if (!espaciosPorInventario.has(esp.inventario_id)) {
          espaciosPorInventario.set(esp.inventario_id, []);
        }
        espaciosPorInventario.get(esp.inventario_id)!.push(esp.id);
      }

      // Función helper para encontrar el primer espacio disponible de un inventario
      const encontrarEspacioDisponible = (inventarioId: number): number | null => {
        const espaciosDelInventario = espaciosPorInventario.get(inventarioId);
        if (!espaciosDelInventario) return null;

        for (const espacioId of espaciosDelInventario) {
          if (!espaciosReservadosEnPeriodo.has(espacioId)) {
            return espacioId;
          }
        }
        return null; // Todos los espacios están ocupados
      };

      // Create reservas
      const createdReservas = [];
      const totalReservas = reservas.length;
      let reservasProcesadas = 0;

      // Process grupos completos first
      for (const [grupoId, invIds] of gruposCompletos) {
        for (const invId of invIds) {
          const reserva = reservas.find(r => r.inventario_id === invId);
          if (!reserva) continue;

          // Use espacio_id directly if provided (for digital items), otherwise find available
          let espacioId = reserva.espacio_id || encontrarEspacioDisponible(invId);
          if (!espacioId) {
            console.warn(`No hay espacios disponibles para inventario_id ${invId}`);
            reservasProcesadas++;
            continue;
          }

          // Validar que el espacio no esté reservado en el período (por otra propuesta)
          if (espaciosReservadosEnPeriodo.has(espacioId)) {
            console.warn(`El espacio ${espacioId} ya está reservado en el período`);
            reservasProcesadas++;
            continue;
          }

          const estatus = reserva.tipo === 'Bonificacion' ? 'Bonificado' : 'Reservado';

          // Verificar duplicados en la misma propuesta
          const exists = await prisma.reservas.findFirst({
            where: {
              inventario_id: espacioId,
              solicitudCaras_id: { in: proposalCaraIds },
              deleted_at: null
            }
          });

          if (exists) {
            reservasProcesadas++;
            continue;
          }

          const created = await prisma.reservas.create({
            data: {
              inventario_id: espacioId,
              calendario_id: calendario.id,
              cliente_id: clienteId,
              solicitudCaras_id: solicitudCaraId,
              estatus,
              estatus_original: estatus,
              arte_aprobado: 'Pendiente',
              comentario_rechazo: '',
              fecha_testigo: new Date(),
              imagen_testigo: '',
              instalado: false,
              tarea: '',
              grupo_completo_id: parseInt(grupoId),
            },
          });

          // Marcar espacio como usado para evitar duplicados en este request
          espaciosReservadosEnPeriodo.add(espacioId);
          createdReservas.push(created);
          reservasProcesadas++;

          // Emitir progreso cada 5 reservas o en la última
          if (reservasProcesadas % 5 === 0 || reservasProcesadas === totalReservas) {
            emitToPropuesta(propuestaId, SOCKET_EVENTS.RESERVA_PROGRESO, {
              propuestaId,
              procesadas: reservasProcesadas,
              total: totalReservas,
              creadas: createdReservas.length,
              porcentaje: Math.round((reservasProcesadas / totalReservas) * 100)
            });
          }
        }
      }

      // Process normal reservas
      for (const reserva of reservasNormales) {
        // Use espacio_id directly if provided (for digital items), otherwise find available
        let espacioId = reserva.espacio_id || encontrarEspacioDisponible(reserva.inventario_id);
        if (!espacioId) {
          console.warn(`No hay espacios disponibles para inventario_id ${reserva.inventario_id}`);
          reservasProcesadas++;
          continue;
        }

        // Validar que el espacio no esté reservado en el período (por otra propuesta)
        if (espaciosReservadosEnPeriodo.has(espacioId)) {
          console.warn(`El espacio ${espacioId} ya está reservado en el período`);
          reservasProcesadas++;
          continue;
        }

        const estatus = reserva.tipo === 'Bonificacion' ? 'Bonificado' : 'Reservado';

        // Verificar duplicados en la misma propuesta
        const exists = await prisma.reservas.findFirst({
          where: {
            inventario_id: espacioId,
            solicitudCaras_id: { in: proposalCaraIds },
            deleted_at: null
          }
        });

        if (exists) {
          reservasProcesadas++;
          continue;
        }

        const created = await prisma.reservas.create({
          data: {
            inventario_id: espacioId,
            calendario_id: calendario.id,
            cliente_id: clienteId,
            solicitudCaras_id: solicitudCaraId,
            estatus,
            estatus_original: estatus,
            arte_aprobado: 'Pendiente',
            comentario_rechazo: '',
            fecha_testigo: new Date(),
            imagen_testigo: '',
            instalado: false,
            tarea: '',
            grupo_completo_id: null,
          },
        });

        // Marcar espacio como usado para evitar duplicados en este request
        espaciosReservadosEnPeriodo.add(espacioId);
        createdReservas.push(created);
        reservasProcesadas++;

        // Emitir progreso cada 5 reservas o en la última
        if (reservasProcesadas % 5 === 0 || reservasProcesadas === totalReservas) {
          emitToPropuesta(propuestaId, SOCKET_EVENTS.RESERVA_PROGRESO, {
            propuestaId,
            procesadas: reservasProcesadas,
            total: totalReservas,
            creadas: createdReservas.length,
            porcentaje: Math.round((reservasProcesadas / totalReservas) * 100)
          });
        }
      }

      // Update solicitudCaras totals if needed
      await this.updateSolicitudCarasTotals(solicitudCaraId);

      // Emit socket event for real-time updates
      if (createdReservas.length > 0) {
        emitToPropuesta(propuestaId, SOCKET_EVENTS.RESERVA_CREADA, { propuestaId });
        emitToAll(SOCKET_EVENTS.RESERVA_CREADA, { propuestaId });
      }

      // Crear notificaciones para usuarios asignados a la propuesta
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      if (propuesta.id_asignado && createdReservas.length > 0) {
        const involucrados = new Set<number>();
        propuesta.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });

        const now = new Date();
        for (const responsableId of involucrados) {
          await prisma.tareas.create({
            data: {
              titulo: 'Nuevas reservas creadas',
              descripcion: `${userName} ha creado ${createdReservas.length} reserva(s) en la propuesta`,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              asignado: userName,
              id_asignado: userId?.toString() || '',
              id_solicitud: propuesta.solicitud_id?.toString() || '',
              id_propuesta: propuesta.id.toString(),
              fecha_inicio: now,
              fecha_fin: now,
            },
          });
        }
      }

      res.json({
        success: true,
        data: {
          calendarioId: calendario.id,
          reservasCreadas: createdReservas.length,
        },
      });
    } catch (error) {
      console.error('Error creating reservas:', error);
      const message = error instanceof Error ? error.message : 'Error al crear reservas';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Helper to update solicitudCaras totals after reservas
  private async updateSolicitudCarasTotals(solicitudCaraId: number): Promise<void> {
    try {
      // Count reservas for this solicitudCara
      const reservasCount = await prisma.reservas.count({
        where: {
          solicitudCaras_id: solicitudCaraId,
          deleted_at: null,
        },
      });

      const bonificadasCount = await prisma.reservas.count({
        where: {
          solicitudCaras_id: solicitudCaraId,
          deleted_at: null,
          estatus: 'Bonificado',
        },
      });

      // Update solicitudCaras with new counts
      await prisma.solicitudCaras.update({
        where: { id: solicitudCaraId },
        data: {
          // These fields might need adjustment based on actual schema
        },
      });
    } catch (error) {
      console.error('Error updating solicitudCaras totals:', error);
    }
  }

  // Get reservas for modal (individual, not grouped)
  async getReservasForModal(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      const query = `
        SELECT
          rsv.id as reserva_id,
          rsv.inventario_id as espacio_id,
          i.id as inventario_id,
          i.codigo_unico,
          i.tipo_de_cara,
          i.latitud,
          i.longitud,
          i.plaza,
          i.tipo_de_mueble as formato,
          i.ubicacion,
          i.isla,
          rsv.estatus,
          rsv.grupo_completo_id,
          sc.id as solicitud_cara_id,
          sc.articulo
        FROM reservas rsv
          INNER JOIN espacio_inventario epIn ON rsv.inventario_id = epIn.id
          INNER JOIN inventarios i ON epIn.inventario_id = i.id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
        WHERE sc.idquote = ?
          AND rsv.deleted_at IS NULL
        ORDER BY rsv.id DESC
      `;

      const reservas = await prisma.$queryRawUnsafe(query, String(propuestaId));

      res.json({
        success: true,
        data: reservas,
      });
    } catch (error) {
      console.error('Error en getReservasForModal:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener reservas';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Delete reservas
  async deleteReservas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({ success: false, error: 'No hay reservas para eliminar' });
        return;
      }

      // Obtener propuesta para notificar a usuarios asignados
      const propuestaId = id ? parseInt(id) : null;
      const propuesta = propuestaId ? await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      }) : null;

      // Soft delete reservas
      await prisma.reservas.updateMany({
        where: { id: { in: reservaIds } },
        data: { deleted_at: new Date() },
      });

      // Crear notificaciones para usuarios asignados
      if (propuesta?.id_asignado) {
        const involucrados = new Set<number>();
        propuesta.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });

        const now = new Date();
        for (const responsableId of involucrados) {
          await prisma.tareas.create({
            data: {
              titulo: 'Reservas eliminadas',
              descripcion: `${userName} ha eliminado ${reservaIds.length} reserva(s) de la propuesta`,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              asignado: userName,
              id_asignado: userId?.toString() || '',
              id_solicitud: propuesta.solicitud_id?.toString() || '',
              id_propuesta: propuesta.id.toString(),
              fecha_inicio: now,
              fecha_fin: now,
            },
          });
        }
      }

      // Emitir evento de socket para actualización en tiempo real
      if (propuestaId) {
        emitToPropuesta(propuestaId, SOCKET_EVENTS.RESERVA_ELIMINADA, { propuestaId });
        emitToAll(SOCKET_EVENTS.RESERVA_ELIMINADA, { propuestaId });
      }

      res.json({
        success: true,
        message: `${reservaIds.length} reservas eliminadas`,
      });

      // Emitir eventos WebSocket
      if (propuestaId) {
        emitToPropuesta(propuestaId, SOCKET_EVENTS.RESERVA_ELIMINADA, {
          propuestaId,
          reservaIds,
          usuario: userName,
        });
        emitToPropuestas(SOCKET_EVENTS.PROPUESTA_ACTUALIZADA, {
          propuestaId,
          usuario: userName,
        });
      }
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'reserva', accion: 'eliminada' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar reservas';
      res.status(500).json({ success: false, error: message });
    }
  }


  // Toggle reserva (Immediate Save)
  async toggleReserva(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);
      const { inventarioId, solicitudCaraId, clienteId, tipo, fechaInicio, fechaFin } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      // 0. Get all solicitudCaras IDs for duplicates check
      const proposalCaras = await prisma.solicitudCaras.findMany({
        where: { idquote: String(propuestaId) },
        select: { id: true }
      });
      const proposalCaraIds = proposalCaras.map(p => p.id);

      // 1. Check if ANY active reservation exists for this inventory in this proposal
      const existingReserva = await prisma.reservas.findFirst({
        where: {
          inventario_id: parseInt(inventarioId),
          solicitudCaras_id: { in: proposalCaraIds },
          deleted_at: null
        }
      });

      if (existingReserva) {
        // DELETE (Soft delete)
        await prisma.reservas.update({
          where: { id: existingReserva.id },
          data: { deleted_at: new Date() }
        });

        // Also delete if it's part of a group group_completo_id
        if (existingReserva.grupo_completo_id) {
          await prisma.reservas.updateMany({
            where: {
              grupo_completo_id: existingReserva.grupo_completo_id,
              id: { not: existingReserva.id }
            },
            data: { deleted_at: new Date() }
          });
        }

        // Notificar sobre eliminación de reserva
        const propuestaForDelete = await prisma.propuesta.findFirst({
          where: { id: propuestaId, deleted_at: null },
        });

        if (propuestaForDelete?.id_asignado) {
          const involucrados = new Set<number>();
          propuestaForDelete.id_asignado.split(',').forEach(idStr => {
            const parsed = parseInt(idStr.trim());
            if (!isNaN(parsed) && parsed !== userId) {
              involucrados.add(parsed);
            }
          });

          const now = new Date();
          for (const responsableId of involucrados) {
            await prisma.tareas.create({
              data: {
                titulo: 'Reserva eliminada',
                descripcion: `${userName} ha eliminado una reserva de la propuesta`,
                tipo: 'Notificación',
                estatus: 'Pendiente',
                id_responsable: responsableId,
                asignado: userName,
                id_asignado: userId?.toString() || '',
                id_solicitud: propuestaForDelete.solicitud_id?.toString() || '',
                id_propuesta: propuestaForDelete.id.toString(),
                fecha_inicio: now,
                fecha_fin: now,
              },
            });
          }
        }

        // Emitir evento de socket
        emitToPropuesta(propuestaId, SOCKET_EVENTS.RESERVA_ELIMINADA, { propuestaId });
        emitToAll(SOCKET_EVENTS.RESERVA_ELIMINADA, { propuestaId });

        res.json({
          success: true,
          data: {
            action: 'deleted',
          },
          message: 'Reserva eliminada'
        });
        return;
      }

      // CREATE
      const propuesta = await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      let calendario = await prisma.calendario.findFirst({
        where: {
          fecha_inicio: new Date(fechaInicio),
          fecha_fin: new Date(fechaFin),
          deleted_at: null
        }
      });

      if (!calendario) {
        calendario = await prisma.calendario.create({
          data: {
            fecha_inicio: new Date(fechaInicio),
            fecha_fin: new Date(fechaFin),
          },
        });
      }

      const espacio = await prisma.espacio_inventario.findFirst({
        where: { inventario_id: parseInt(inventarioId) }
      });

      if (!espacio) {
        res.status(400).json({ success: false, error: 'Espacio de inventario no encontrado' });
        return;
      }

      const estatus = tipo === 'Bonificacion' ? 'Bonificado' : 'Reservado';

      const newReserva = await prisma.reservas.create({
        data: {
          inventario_id: espacio.id,
          calendario_id: calendario.id,
          cliente_id: clienteId,
          solicitudCaras_id: solicitudCaraId,
          estatus,
          estatus_original: estatus,
          arte_aprobado: 'Pendiente',
          comentario_rechazo: '',
          fecha_testigo: new Date(),
          imagen_testigo: '',
          instalado: false,
          tarea: '',
          grupo_completo_id: null,
        },
      });

      // Simple implementation for "completo" logic if needed immediately:
      // If user selected a "Completo" item in frontend, frontend sends one request.
      // But if it's "Flujo" and has a "Contraflujo" pair at same location... we might need to handle that.
      // For now, let's stick to 1:1 unless we see the frontend sending special flags.

      // Notificar sobre creación de reserva
      if (propuesta?.id_asignado) {
        const involucrados = new Set<number>();
        propuesta.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });

        const now = new Date();
        for (const responsableId of involucrados) {
          await prisma.tareas.create({
            data: {
              titulo: 'Nueva reserva creada',
              descripcion: `${userName} ha creado una reserva en la propuesta`,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              asignado: userName,
              id_asignado: userId?.toString() || '',
              id_solicitud: propuesta.solicitud_id?.toString() || '',
              id_propuesta: propuesta.id.toString(),
              fecha_inicio: now,
              fecha_fin: now,
            },
          });
        }
      }

      // Emitir evento de socket
      emitToPropuesta(propuestaId, SOCKET_EVENTS.RESERVA_CREADA, { propuestaId });
      emitToAll(SOCKET_EVENTS.RESERVA_CREADA, { propuestaId });

      res.json({
        success: true,
        data: {
          action: 'created',
          reserva: {
            ...newReserva,
            inventario_id: inventarioId // Return original intentario ID for frontend mapping
          }
        }
      });

    } catch (error) {
      console.error('Error toggling reserva:', error);
      const message = error instanceof Error ? error.message : 'Error al cambiar reserva';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Update propuesta general fields
  async updatePropuesta(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { nombre_campania, notas, descripcion, year_inicio, catorcena_inicio, year_fin, catorcena_fin } = req.body;

      // Update propuesta fields
      const updatedPropuesta = await prisma.propuesta.update({
        where: { id: parseInt(id) },
        data: {
          notas: notas !== undefined ? notas : undefined,
          descripcion: descripcion !== undefined ? descripcion : undefined,
          updated_at: new Date(),
        },
      });

      // Update cotizacion nombre_campania if provided
      if (nombre_campania !== undefined) {
        await prisma.cotizacion.updateMany({
          where: { id_propuesta: parseInt(id) },
          data: { nombre_campania },
        });
      }

      // Update campania dates if provided
      if (year_inicio !== undefined || catorcena_inicio !== undefined || year_fin !== undefined || catorcena_fin !== undefined) {
        // Find the cotizacion and campania
        const cotizacion = await prisma.cotizacion.findFirst({
          where: { id_propuesta: parseInt(id) },
        });

        if (cotizacion) {
          // Calculate new dates from catorcenas if provided
          let fechaInicio: Date | undefined;
          let fechaFin: Date | undefined;

          if (year_inicio && catorcena_inicio) {
            const catInicio = await prisma.catorcenas.findFirst({
              where: { a_o: year_inicio, numero_catorcena: catorcena_inicio },
            });
            if (catInicio) {
              fechaInicio = catInicio.fecha_inicio;
            }
          }

          if (year_fin && catorcena_fin) {
            const catFin = await prisma.catorcenas.findFirst({
              where: { a_o: year_fin, numero_catorcena: catorcena_fin },
            });
            if (catFin) {
              fechaFin = catFin.fecha_fin;
            }
          }

          if (fechaInicio || fechaFin) {
            await prisma.campania.updateMany({
              where: { cotizacion_id: cotizacion.id },
              data: {
                ...(fechaInicio && { fecha_inicio: fechaInicio }),
                ...(fechaFin && { fecha_fin: fechaFin }),
              },
            });
          }
        }
      }

      res.json({ success: true, data: updatedPropuesta });

      // Emitir eventos WebSocket
      const userName = req.user?.nombre || 'Usuario';
      const propuestaId = parseInt(id);
      emitToPropuesta(propuestaId, SOCKET_EVENTS.PROPUESTA_ACTUALIZADA, {
        propuestaId,
        usuario: userName,
      });
      emitToPropuestas(SOCKET_EVENTS.PROPUESTA_ACTUALIZADA, {
        propuestaId,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'propuesta', accion: 'actualizada' });
    } catch (error) {
      console.error('Error updating propuesta:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar propuesta';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Upload archivo for propuesta
  async uploadArchivo(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Multer middleware ya procesó el archivo y está en req.file
      if (!req.file) {
        res.status(400).json({ success: false, error: 'No se proporcionó archivo' });
        return;
      }

      const fileUrl = `/uploads/${req.file.filename}`;

      // Update propuesta with file URL in database
      await prisma.propuesta.update({
        where: { id: parseInt(id) },
        data: {
          archivo: fileUrl,
          updated_at: new Date(),
        },
      });

      res.json({ success: true, data: { url: fileUrl } });
    } catch (error) {
      console.error('Error uploading archivo:', error);
      const message = error instanceof Error ? error.message : 'Error al subir archivo';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Update a solicitudCara
  async updateCara(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { caraId } = req.params;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';
      const {
        ciudad,
        estados,
        tipo,
        flujo,
        bonificacion,
        caras,
        nivel_socioeconomico,
        formato,
        costo,
        tarifa_publica,
        inicio_periodo,
        fin_periodo,
        caras_flujo,
        caras_contraflujo,
        articulo,
        descuento,
      } = req.body;

      // Get current cara to get idquote
      const currentCara = await prisma.solicitudCaras.findUnique({
        where: { id: parseInt(caraId) },
        select: { idquote: true }
      });

      if (!currentCara) {
        res.status(404).json({ success: false, error: 'Cara no encontrada' });
        return;
      }

      // Calculate authorization state for updated values
      const estadoResult = await calcularEstadoAutorizacion({
        ciudad: ciudad || undefined,
        estado: estados || undefined,
        formato: formato || '',
        tipo: tipo || undefined,
        caras: caras ? parseInt(caras) : 0,
        bonificacion: bonificacion ? parseFloat(bonificacion) : 0,
        costo: costo ? parseInt(costo) : 0,
        tarifa_publica: tarifa_publica ? parseInt(tarifa_publica) : 0
      });

      const updatedCara = await prisma.solicitudCaras.update({
        where: { id: parseInt(caraId) },
        data: {
          ciudad,
          estados,
          tipo,
          flujo,
          bonificacion: bonificacion !== undefined && bonificacion !== null ? parseFloat(bonificacion) : undefined,
          caras: caras !== undefined && caras !== null ? parseInt(caras) : undefined,
          nivel_socioeconomico,
          formato,
          costo: costo !== undefined && costo !== null ? parseInt(costo) : undefined,
          tarifa_publica: tarifa_publica !== undefined && tarifa_publica !== null ? parseInt(tarifa_publica) : undefined,
          inicio_periodo: inicio_periodo ? new Date(inicio_periodo) : undefined,
          fin_periodo: fin_periodo ? new Date(fin_periodo) : undefined,
          caras_flujo: caras_flujo !== undefined && caras_flujo !== null ? parseInt(caras_flujo) : undefined,
          caras_contraflujo: caras_contraflujo !== undefined && caras_contraflujo !== null ? parseInt(caras_contraflujo) : undefined,
          articulo,
          descuento: descuento !== undefined && descuento !== null ? parseFloat(descuento) : undefined,
          autorizacion_dg: estadoResult.autorizacion_dg,
          autorizacion_dcm: estadoResult.autorizacion_dcm,
        },
      });

      // Check for pending authorizations and create tasks if needed
      const idquote = currentCara.idquote || '';
      const autorizacion = await verificarCarasPendientes(idquote);
      if (autorizacion.tienePendientes && userId) {
        // Get solicitud_id from propuesta
        const propuesta = await prisma.propuesta.findUnique({
          where: { id: parseInt(idquote) },
          select: { solicitud_id: true }
        });

        if (propuesta?.solicitud_id) {
          await crearTareasAutorizacion(
            propuesta.solicitud_id,
            parseInt(idquote),
            userId,
            userName,
            autorizacion.pendientesDg,
            autorizacion.pendientesDcm
          );
        }
      }

      // Build response message
      let mensaje = 'Cara actualizada exitosamente';
      if (autorizacion.tienePendientes) {
        const totalPendientes = autorizacion.pendientesDg.length + autorizacion.pendientesDcm.length;
        mensaje = `Cara actualizada. ${totalPendientes} cara(s) requieren autorización.`;
      }

      res.json({
        success: true,
        data: updatedCara,
        message: mensaje,
        autorizacion: {
          tienePendientes: autorizacion.tienePendientes,
          pendientesDg: autorizacion.pendientesDg.length,
          pendientesDcm: autorizacion.pendientesDcm.length
        }
      });
    } catch (error) {
      console.error('Error updating cara:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar cara';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Create a new solicitudCara
  async createCara(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params; // propuesta id
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';
      const {
        ciudad,
        estados,
        tipo,
        flujo,
        bonificacion,
        caras,
        nivel_socioeconomico,
        formato,
        costo,
        tarifa_publica,
        inicio_periodo,
        fin_periodo,
        caras_flujo,
        caras_contraflujo,
        articulo,
        descuento,
      } = req.body;

      // Calculate authorization state
      const estadoResult = await calcularEstadoAutorizacion({
        ciudad,
        estado: estados,
        formato: formato || '',
        tipo,
        caras: caras ? parseInt(caras) : 0,
        bonificacion: bonificacion ? parseFloat(bonificacion) : 0,
        costo: costo ? parseInt(costo) : 0,
        tarifa_publica: tarifa_publica ? parseInt(tarifa_publica) : 0
      });

      const newCara = await prisma.solicitudCaras.create({
        data: {
          idquote: id, // Link to propuesta
          ciudad,
          estados,
          tipo,
          flujo,
          bonificacion: bonificacion ? parseFloat(bonificacion) : 0,
          caras: caras ? parseInt(caras) : 0,
          nivel_socioeconomico: nivel_socioeconomico || '',
          formato: formato || '',
          costo: costo ? parseInt(costo) : 0,
          tarifa_publica: tarifa_publica ? parseInt(tarifa_publica) : 0,
          inicio_periodo: inicio_periodo ? new Date(inicio_periodo) : new Date(),
          fin_periodo: fin_periodo ? new Date(fin_periodo) : new Date(),
          caras_flujo: caras_flujo ? parseInt(caras_flujo) : 0,
          caras_contraflujo: caras_contraflujo ? parseInt(caras_contraflujo) : 0,
          articulo,
          descuento: descuento ? parseFloat(descuento) : 0,
          autorizacion_dg: estadoResult.autorizacion_dg,
          autorizacion_dcm: estadoResult.autorizacion_dcm,
        },
      });

      // Check for pending authorizations and create tasks if needed
      const autorizacion = await verificarCarasPendientes(id);
      if (autorizacion.tienePendientes && userId) {
        // Get solicitud_id from propuesta
        const propuesta = await prisma.propuesta.findUnique({
          where: { id: parseInt(id) },
          select: { solicitud_id: true }
        });

        if (propuesta?.solicitud_id) {
          await crearTareasAutorizacion(
            propuesta.solicitud_id,
            parseInt(id),
            userId,
            userName,
            autorizacion.pendientesDg,
            autorizacion.pendientesDcm
          );
        }
      }

      // Build response message
      let mensaje = 'Cara creada exitosamente';
      if (autorizacion.tienePendientes) {
        const totalPendientes = autorizacion.pendientesDg.length + autorizacion.pendientesDcm.length;
        mensaje = `Cara creada. ${totalPendientes} cara(s) requieren autorización.`;
      }

      res.json({
        success: true,
        data: newCara,
        message: mensaje,
        autorizacion: {
          tienePendientes: autorizacion.tienePendientes,
          pendientesDg: autorizacion.pendientesDg.length,
          pendientesDcm: autorizacion.pendientesDcm.length
        }
      });
    } catch (error) {
      console.error('Error creating cara:', error);
      const message = error instanceof Error ? error.message : 'Error al crear cara';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Delete a solicitudCara
  async deleteCara(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { caraId } = req.params;

      // First check if the cara has any reservations
      const reservations = await prisma.reservas.findMany({
        where: { solicitudCaras_id: parseInt(caraId) },
      });

      if (reservations.length > 0) {
        res.status(400).json({
          success: false,
          error: 'No se puede eliminar una cara con reservas activas',
        });
        return;
      }

      // Delete the cara
      await prisma.solicitudCaras.delete({
        where: { id: parseInt(caraId) },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting cara:', error);
      const message = error instanceof Error ? error.message : 'Error al eliminar cara';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const propuestasController = new PropuestasController();
