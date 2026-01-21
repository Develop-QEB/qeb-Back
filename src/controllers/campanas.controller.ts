import { Response } from 'express';
import prisma from '../utils/prisma';
import { Prisma } from '@prisma/client';
import { AuthRequest } from '../types';
import nodemailer from 'nodemailer';
import {
  calcularEstadoAutorizacion,
  verificarCarasPendientes,
  crearTareasAutorizacion
} from '../services/autorizacion.service';
import { emitToCampana, emitToAll, SOCKET_EVENTS } from '../config/socket';

// Configurar transporter de nodemailer para envío de correos
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

export class CampanasController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;
      const search = req.query.search as string;
      const yearInicio = req.query.yearInicio ? parseInt(req.query.yearInicio as string) : undefined;
      const yearFin = req.query.yearFin ? parseInt(req.query.yearFin as string) : undefined;
      const catorcenaInicio = req.query.catorcenaInicio ? parseInt(req.query.catorcenaInicio as string) : undefined;
      const catorcenaFin = req.query.catorcenaFin ? parseInt(req.query.catorcenaFin as string) : undefined;

      // Build WHERE conditions
      // Excluir campañas 'inactiva' (propuestas no aprobadas) a menos que se filtre explícitamente por ese status
      const conditions: string[] = ['cm.id IS NOT NULL'];
      const params: (string | number)[] = [];

      if (status) {
        conditions.push('cm.status = ?');
        params.push(status);
      } else {
        // Si no se especifica status, excluir las inactivas (propuestas aún no aprobadas)
        conditions.push("cm.status != 'inactiva'");
      }

      if (search) {
        conditions.push('(cm.nombre LIKE ? OR cm.articulo LIKE ? OR cl.T0_U_Cliente LIKE ? OR cl.T0_U_RazonSocial LIKE ?)');
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      // Year/catorcena filters using fecha_inicio
      if (yearInicio && yearFin) {
        if (catorcenaInicio && catorcenaFin) {
          // Get date range from catorcenas
          conditions.push(`
            cm.fecha_inicio >= (
              SELECT fecha_inicio FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1
            )
            AND cm.fecha_fin <= (
              SELECT fecha_fin FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1
            )
          `);
          params.push(yearInicio, catorcenaInicio, yearFin, catorcenaFin);
        } else {
          conditions.push('YEAR(cm.fecha_inicio) >= ? AND YEAR(cm.fecha_fin) <= ?');
          params.push(yearInicio, yearFin);
        }
      }

      const whereClause = conditions.join(' AND ');

      // Query with JOINs to get additional data
      const query = `
        SELECT
          cm.*,
          cl.T0_U_Cliente as cliente_nombre,
          cl.T0_U_RazonSocial as cliente_razon_social,
          cl.T0_U_Asesor as T0_U_Asesor,
          cl.T0_U_Agencia as T0_U_Agencia,
          cl.T1_U_UnidadNegocio as T1_U_UnidadNegocio,
          COALESCE(s.marca_nombre, cl.T2_U_Marca) as T2_U_Marca,
          COALESCE(s.producto_nombre, cl.T2_U_Producto) as T2_U_Producto,
          COALESCE(s.categoria_nombre, cl.T2_U_Categoria) as T2_U_Categoria,
          s.nombre_usuario as creador_nombre,
          cat_ini.numero_catorcena as catorcena_inicio_num,
          cat_ini.año as catorcena_inicio_anio,
          cat_fin.numero_catorcena as catorcena_fin_num,
          cat_fin.año as catorcena_fin_anio,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM cotizacion ct2
              INNER JOIN propuesta pr2 ON pr2.id = ct2.id_propuesta
              INNER JOIN solicitudCaras sc2 ON sc2.idquote = ct2.id_propuesta
              INNER JOIN reservas rsv2 ON rsv2.solicitudCaras_id = sc2.id AND rsv2.deleted_at IS NULL
              WHERE ct2.id = cm.cotizacion_id
                AND rsv2.APS IS NOT NULL
                AND rsv2.APS > 0
            )
            THEN 1 ELSE 0
          END AS has_aps
        FROM campania cm
        LEFT JOIN cliente cl ON cm.cliente_id = cl.id
        LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
        LEFT JOIN propuesta pr ON pr.id = ct.id_propuesta
        LEFT JOIN solicitud s ON s.id = pr.solicitud_id
        LEFT JOIN catorcenas cat_ini ON cm.fecha_inicio BETWEEN cat_ini.fecha_inicio AND cat_ini.fecha_fin
        LEFT JOIN catorcenas cat_fin ON cm.fecha_fin BETWEEN cat_fin.fecha_inicio AND cat_fin.fecha_fin
        WHERE ${whereClause}
        ORDER BY cm.id DESC
        LIMIT ? OFFSET ?
      `;

      const countQuery = `
        SELECT COUNT(*) as total
        FROM campania cm
        LEFT JOIN cliente cl ON cm.cliente_id = cl.id
        WHERE ${whereClause}
      `;

      const offset = (page - 1) * limit;
      const campanas = await prisma.$queryRawUnsafe(query, ...params, limit, offset);
      const countResult = await prisma.$queryRawUnsafe<{ total: bigint }[]>(countQuery, ...params);
      const total = Number(countResult[0]?.total || 0);

      // Convert BigInt to Number for JSON serialization
      const campanasSerializable = JSON.parse(JSON.stringify(campanas, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: campanasSerializable,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('Error en getAll campanas:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener campanas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const campana = await prisma.campania.findUnique({
        where: { id: parseInt(id) },
      });

      if (!campana) {
        res.status(404).json({
          success: false,
          error: 'Campana no encontrada',
        });
        return;
      }

      // Obtener info del cliente
      const cliente = await prisma.cliente.findUnique({
        where: { id: campana.cliente_id },
      });

      // Obtener info de cotizacion si existe
      let cotizacion = null;
      if (campana.cotizacion_id) {
        cotizacion = await prisma.cotizacion.findUnique({
          where: { id: campana.cotizacion_id },
        });
      }

      // Obtener info de propuesta relacionada a la cotizacion
      let propuesta = null;
      if (cotizacion?.id_propuesta) {
        propuesta = await prisma.propuesta.findUnique({
          where: { id: cotizacion.id_propuesta },
        });
      }

      // Obtener info de solicitud relacionada a la propuesta
      let solicitud = null;
      if (propuesta?.solicitud_id) {
        solicitud = await prisma.solicitud.findUnique({
          where: { id: propuesta.solicitud_id },
        });
      }

      // Obtener catorcenas de inicio y fin basadas en las fechas de la campaña
      const catorcenaData = await prisma.$queryRaw<{
        catorcena_inicio_num: number | null;
        catorcena_inicio_anio: number | null;
        catorcena_fin_num: number | null;
        catorcena_fin_anio: number | null;
      }[]>`
        SELECT
          cat_ini.numero_catorcena as catorcena_inicio_num,
          cat_ini.año as catorcena_inicio_anio,
          cat_fin.numero_catorcena as catorcena_fin_num,
          cat_fin.año as catorcena_fin_anio
        FROM campania cm
        LEFT JOIN catorcenas cat_ini ON cm.fecha_inicio BETWEEN cat_ini.fecha_inicio AND cat_ini.fecha_fin
        LEFT JOIN catorcenas cat_fin ON cm.fecha_fin BETWEEN cat_fin.fecha_inicio AND cat_fin.fecha_fin
        WHERE cm.id = ${parseInt(id)}
      `;
      const catorcenas = catorcenaData[0] || {};

      // Obtener comentarios usando solicitud_id de la propuesta o campania_id
      let comentarios: { id: number; autor_id: number; autor_nombre: string; autor_foto: string | null; contenido: string; fecha: Date; solicitud_id: number }[] = [];
      const solicitudId = propuesta?.solicitud_id;

      const whereComentarios = solicitudId
        ? { solicitud_id: solicitudId }
        : { campania_id: campana.id };

      const rawComentarios = await prisma.comentarios.findMany({
        where: whereComentarios,
        orderBy: { creado_en: 'desc' },
      });

      // Obtener los nombres y fotos de los autores
      const autorIds = [...new Set(rawComentarios.map(c => c.autor_id))];
      const autores = await prisma.usuario.findMany({
        where: { id: { in: autorIds } },
        select: { id: true, nombre: true, foto_perfil: true },
      });
      const autoresMap = new Map(autores.map(a => [a.id, { nombre: a.nombre, foto_perfil: a.foto_perfil }]));

      comentarios = rawComentarios.map(c => ({
        id: c.id,
        autor_id: c.autor_id,
        autor_nombre: autoresMap.get(c.autor_id)?.nombre || 'Usuario',
        autor_foto: autoresMap.get(c.autor_id)?.foto_perfil || null,
        contenido: c.comentario,
        fecha: c.creado_en,
        solicitud_id: c.solicitud_id,
      }));

      // Combinar toda la info
      const campanaCompleta = {
        ...campana,
        // Info del cliente - priorizar datos de solicitud sobre cliente
        T0_U_Asesor: solicitud?.asesor || cliente?.T0_U_Asesor || null,
        T0_U_IDAsesor: cliente?.T0_U_IDAsesor || null,
        T0_U_IDAgencia: cliente?.T0_U_IDAgencia || null,
        T0_U_Agencia: solicitud?.agencia || cliente?.T0_U_Agencia || null,
        T0_U_Cliente: cliente?.T0_U_Cliente || null,
        T0_U_RazonSocial: solicitud?.razon_social || cliente?.T0_U_RazonSocial || null,
        T0_U_IDACA: cliente?.T0_U_IDACA || null,
        cuic: solicitud?.cuic ? parseInt(solicitud.cuic) : cliente?.CUIC || null,
        T1_U_Cliente: cliente?.T1_U_Cliente || null,
        T1_U_IDACA: cliente?.T1_U_IDACA || null,
        T1_U_IDCM: cliente?.T1_U_IDCM || null,
        T1_U_IDMarca: cliente?.T1_U_IDMarca || null,
        T1_U_UnidadNegocio: solicitud?.unidad_negocio || cliente?.T1_U_UnidadNegocio || null,
        T1_U_ValidFrom: cliente?.T1_U_ValidFrom || null,
        T1_U_ValidTo: cliente?.T1_U_ValidTo || null,
        T2_U_IDCategoria: cliente?.T2_U_IDCategoria || null,
        T2_U_Categoria: solicitud?.categoria_nombre || cliente?.T2_U_Categoria || null,
        T2_U_IDCM: cliente?.T2_U_IDCM || null,
        T2_U_IDProducto: cliente?.T2_U_IDProducto || null,
        T2_U_Marca: solicitud?.marca_nombre || cliente?.T2_U_Marca || null,
        T2_U_Producto: solicitud?.producto_nombre || cliente?.T2_U_Producto || null,
        T2_U_ValidFrom: cliente?.T2_U_ValidFrom || null,
        T2_U_ValidTo: cliente?.T2_U_ValidTo || null,
        // Info de solicitud
        creador_nombre: solicitud?.nombre_usuario || null,
        cliente_nombre: cliente?.T0_U_Cliente || null,
        cliente_razon_social: cliente?.T0_U_RazonSocial || null,
        // Info de catorcenas
        catorcena_inicio_num: catorcenas.catorcena_inicio_num || null,
        catorcena_inicio_anio: catorcenas.catorcena_inicio_anio || null,
        catorcena_fin_num: catorcenas.catorcena_fin_num || null,
        catorcena_fin_anio: catorcenas.catorcena_fin_anio || null,
        // Info de cotizacion
        user_id: cotizacion?.user_id || null,
        clientes_id: cotizacion?.clientes_id || null,
        nombre_campania: cotizacion?.nombre_campania || null,
        numero_caras: cotizacion?.numero_caras || null,
        frontal: cotizacion?.frontal || null,
        cruzada: cotizacion?.cruzada || null,
        nivel_socioeconomico: cotizacion?.nivel_socioeconomico || null,
        observaciones: cotizacion?.observaciones || null,
        descuento: cotizacion?.descuento || null,
        precio: cotizacion?.precio || null,
        contacto: cotizacion?.contacto || null,
        fecha_expiracion: cotizacion?.fecha_expiracion || null,
        // Info de propuesta
        fecha: propuesta?.fecha || null,
        descripcion: propuesta?.descripcion || null,
        notas: propuesta?.notas || null,
        deleted_at: propuesta?.deleted_at || null,
        solicitud_id: propuesta?.solicitud_id || null,
        precio_simulado: propuesta?.precio_simulado || null,
        asignado: propuesta?.asignado || null,
        id_asignado: propuesta?.id_asignado || null,
        inversion: propuesta?.inversion || null,
        comentario_cambio_status: propuesta?.comentario_cambio_status || null,
        updated_at: propuesta?.updated_at || null,
        // Info de SAP desde solicitud
        card_code: solicitud?.card_code || null,
        salesperson_code: solicitud?.salesperson_code || null,
        // Comentarios
        comentarios,
      };

      // Convertir BigInt a Number para JSON serialization
      const campanaSerializable = JSON.parse(JSON.stringify(campanaCompleta, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: campanaSerializable,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener campana';
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
      const userId = req.user?.userId || 0;
      const userName = req.user?.nombre || 'Usuario';
      const campanaId = parseInt(id);

      // Obtener campaña antes de actualizar
      const campanaAnterior = await prisma.campania.findUnique({
        where: { id: campanaId },
      });

      if (!campanaAnterior) {
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      // Si intenta cambiar a "Activa" o similar status de aprobación, verificar autorizaciones
      if (status === 'Activa' || status === 'En pauta') {
        // Get the propuesta linked to this campana
        if (campanaAnterior.cotizacion_id) {
          const cotizacion = await prisma.cotizacion.findUnique({
            where: { id: campanaAnterior.cotizacion_id },
            select: { id_propuesta: true }
          });
          if (cotizacion?.id_propuesta) {
            const autorizacion = await verificarCarasPendientes(cotizacion.id_propuesta.toString());
            if (autorizacion.tienePendientes) {
              const totalPendientes = autorizacion.pendientesDg.length + autorizacion.pendientesDcm.length;
              res.status(400).json({
                success: false,
                error: `No se puede activar la campaña. ${totalPendientes} cara(s) están pendientes de autorización.`,
                autorizacion: {
                  pendientesDg: autorizacion.pendientesDg.length,
                  pendientesDcm: autorizacion.pendientesDcm.length
                }
              });
              return;
            }
          }
        }
      }

      const statusAnterior = campanaAnterior.status;

      const campana = await prisma.campania.update({
        where: { id: campanaId },
        data: { status },
      });

      // Obtener datos relacionados
      const cotizacion = campana.cotizacion_id
        ? await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } })
        : null;
      const propuesta = cotizacion?.id_propuesta
        ? await prisma.propuesta.findUnique({ where: { id: cotizacion.id_propuesta } })
        : null;
      const solicitud = propuesta?.solicitud_id
        ? await prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } })
        : null;

      // Crear notificaciones para los involucrados
      const nombreCampana = campana.nombre || `Campaña #${campanaId}`;
      const tituloNotificacion = `Cambio de estado en campaña: ${nombreCampana}`;
      const descripcionNotificacion = `${userName} cambió el estado de "${statusAnterior}" a "${status}"`;

      // Recopilar involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados de la propuesta
      if (propuesta?.id_asignado) {
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
            id_solicitud: solicitud?.id?.toString() || '',
            id_propuesta: propuesta?.id?.toString() || '',
            campania_id: campanaId,
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
          tipo: 'Campaña',
          ref_id: propuesta?.id || campanaId,
          accion: 'Cambio de estado',
          fecha_hora: now,
          detalles: `${userName} cambió estado de "${statusAnterior}" a "${status}"`,
        },
      });

      res.json({
        success: true,
        data: campana,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar status';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const {
        nombre,
        status,
        descripcion,
        notas,
        catorcenaInicioNum,
        catorcenaInicioAnio,
        catorcenaFinNum,
        catorcenaFinAnio
      } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      const campanaId = parseInt(id);

      // Obtener la campaña actual para conseguir cotizacion_id
      const campanaActual = await prisma.campania.findUnique({
        where: { id: campanaId },
      });

      if (!campanaActual) {
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      // Obtener fechas de las catorcenas seleccionadas
      let fechaInicio: Date | null = null;
      let fechaFin: Date | null = null;

      if (catorcenaInicioNum && catorcenaInicioAnio) {
        const catIni = await prisma.catorcenas.findFirst({
          where: { numero_catorcena: catorcenaInicioNum, a_o: catorcenaInicioAnio },
        });
        if (catIni) fechaInicio = catIni.fecha_inicio;
      }

      if (catorcenaFinNum && catorcenaFinAnio) {
        const catFin = await prisma.catorcenas.findFirst({
          where: { numero_catorcena: catorcenaFinNum, a_o: catorcenaFinAnio },
        });
        if (catFin) fechaFin = catFin.fecha_fin;
      }

      // Obtener cotizacion_id
      const cotizacionId = campanaActual.cotizacion_id;

      if (cotizacionId) {
        // Obtener propuesta y solicitud relacionadas
        const cotizacion = await prisma.cotizacion.findUnique({
          where: { id: cotizacionId },
        });

        if (cotizacion?.id_propuesta) {
          const propuesta = await prisma.propuesta.findUnique({
            where: { id: cotizacion.id_propuesta },
          });

          // 1. Actualizar solicitud
          if (propuesta?.solicitud_id) {
            await prisma.solicitud.update({
              where: { id: propuesta.solicitud_id },
              data: {
                ...(descripcion !== undefined && { descripcion }),
                ...(notas !== undefined && { notas }),
              },
            });
          }

          // 2. Actualizar propuesta
          await prisma.propuesta.update({
            where: { id: cotizacion.id_propuesta },
            data: {
              ...(descripcion !== undefined && { descripcion }),
              ...(notas !== undefined && { notas }),
            },
          });
        }

        // 3. Actualizar cotizacion
        await prisma.cotizacion.update({
          where: { id: cotizacionId },
          data: {
            ...(fechaInicio && { fecha_inicio: fechaInicio }),
            ...(fechaFin && { fecha_fin: fechaFin }),
          },
        });

        // 4. Actualizar solicitudCaras y calendario si cambian las fechas
        if (fechaInicio && fechaFin && cotizacion?.id_propuesta) {
          await prisma.$executeRaw`
            UPDATE solicitudCaras slc
            INNER JOIN propuesta pr ON pr.id = slc.idquote
            INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
            INNER JOIN reservas rs ON rs.solicitudCaras_id = slc.id
            INNER JOIN calendario cl ON cl.id = rs.calendario_id
            SET
              slc.inicio_periodo = GREATEST(slc.inicio_periodo, ${fechaInicio}),
              slc.fin_periodo = LEAST(slc.fin_periodo, ${fechaFin}),
              cl.fecha_inicio = GREATEST(cl.fecha_inicio, ${fechaInicio}),
              cl.fecha_fin = LEAST(cl.fecha_fin, ${fechaFin})
            WHERE ct.id = ${cotizacionId}
              AND (slc.inicio_periodo < ${fechaInicio} OR slc.fin_periodo > ${fechaFin})
          `;
        }
      }

      // 5. Actualizar campania
      const campana = await prisma.campania.update({
        where: { id: campanaId },
        data: {
          ...(nombre !== undefined && { nombre }),
          ...(status !== undefined && { status }),
          ...(fechaInicio && { fecha_inicio: fechaInicio }),
          ...(fechaFin && { fecha_fin: fechaFin }),
        },
      });

      // Crear notificaciones para usuarios involucrados
      if (cotizacionId) {
        const cotizacion = await prisma.cotizacion.findUnique({
          where: { id: cotizacionId },
        });

        if (cotizacion?.id_propuesta) {
          const propuesta = await prisma.propuesta.findUnique({
            where: { id: cotizacion.id_propuesta },
          });

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
                  titulo: 'Campaña actualizada',
                  descripcion: `${userName} ha actualizado la campaña "${campana.nombre || campanaId}"`,
                  tipo: 'Notificación',
                  estatus: 'Pendiente',
                  id_responsable: responsableId,
                  asignado: userName,
                  id_asignado: userId?.toString() || '',
                  id_solicitud: propuesta.solicitud_id?.toString() || '',
                  id_propuesta: propuesta.id.toString(),
                  campania_id: campanaId,
                  fecha_inicio: now,
                  fecha_fin: now,
                },
              });
            }

            // Registrar en historial
            await prisma.historial.create({
              data: {
                tipo: 'Campaña',
                ref_id: campanaId,
                accion: 'Actualización',
                fecha_hora: now,
                detalles: `Campaña actualizada por ${userName}`,
              },
            });
          }
        }
      }

      res.json({
        success: true,
        data: campana,
      });
    } catch (error) {
      console.error('Error updating campana:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar campaña';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const [total, activas, inactivas] = await Promise.all([
        prisma.campania.count(),
        prisma.campania.count({ where: { status: 'activa' } }),
        prisma.campania.count({ where: { status: 'inactiva' } }),
      ]);

      res.json({
        success: true,
        data: {
          total,
          activas,
          inactivas,
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

  async getCaras(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      // Obtener campaña para conseguir cotizacion_id
      const campana = await prisma.campania.findUnique({
        where: { id: campanaId },
      });

      if (!campana) {
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      if (!campana.cotizacion_id) {
        res.json({ success: true, data: [] });
        return;
      }

      // Obtener cotizacion para conseguir id_propuesta
      const cotizacion = await prisma.cotizacion.findUnique({
        where: { id: campana.cotizacion_id },
      });

      if (!cotizacion?.id_propuesta) {
        res.json({ success: true, data: [] });
        return;
      }

      // Obtener caras de la propuesta
      const caras = await prisma.solicitudCaras.findMany({
        where: { idquote: String(cotizacion.id_propuesta) },
        orderBy: { id: 'asc' },
      });

      // Convertir BigInt a Number
      const carasSerializable = JSON.parse(JSON.stringify(caras, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: carasSerializable,
      });
    } catch (error) {
      console.error('Error en getCaras:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener caras';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getInventarioReservado(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      console.log('Fetching inventario for campana:', campanaId);

      const query = `
        SELECT
          rsv.id as rsv_ids,
          i.id,
          i.codigo_unico,
          i.mueble,
          i.estado,
          i.tipo_de_cara,
          i.latitud,
          i.longitud,
          i.plaza,
          i.tradicional_digital,
          i.tarifa_publica,
          rsv.estatus as estatus_reserva,
          rsv.archivo,
          rsv.calendario_id,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          sc.id AS solicitud_caras_id,
          sc.articulo,
          sc.tipo as tipo_medio,
          sc.inicio_periodo,
          sc.fin_periodo,
          cat.numero_catorcena,
          cat.año as anio_catorcena,
          1 AS caras_totales
        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE
          cm.id = ?
          AND (rsv.APS IS NULL OR rsv.APS = 0)
        ORDER BY rsv.id DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId);

      console.log('Inventario result count:', Array.isArray(inventario) ? inventario.length : 0);

      // Convertir BigInt a Number para que JSON.stringify funcione
      const inventarioSerializable = JSON.parse(JSON.stringify(inventario, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: inventarioSerializable,
      });
    } catch (error) {
      console.error('Error en getInventarioReservado:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventario reservado';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getInventarioConAPS(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      console.log('Fetching inventario con APS for campana:', campanaId);

      const query = `
        SELECT
          rsv.id as rsv_ids,
          i.id,
          i.codigo_unico,
          i.ubicacion,
          i.tipo_de_cara,
          i.cara,
          i.mueble,
          i.latitud,
          i.longitud,
          i.plaza,
          i.estado,
          i.municipio,
          i.tipo_de_mueble,
          i.ancho,
          i.alto,
          i.nivel_socioeconomico,
          i.tarifa_publica,
          i.tradicional_digital,
          rsv.archivo,
          rsv.estatus as estatus_reserva,
          rsv.calendario_id,
          rsv.APS as aps,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          epIn.numero_espacio as espacios,
          sc.id AS solicitud_caras_id,
          sc.articulo,
          sc.tipo as tipo_medio,
          sc.inicio_periodo,
          sc.fin_periodo,
          cat.numero_catorcena,
          cat.año as anio_catorcena,
          1 AS caras_totales
        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE
          cm.id = ?
          AND rsv.APS IS NOT NULL
          AND rsv.APS > 0
        ORDER BY rsv.id DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId);

      console.log('Inventario con APS result count:', Array.isArray(inventario) ? inventario.length : 0);

      res.json({
        success: true,
        data: inventario,
      });
    } catch (error) {
      console.error('Error en getInventarioConAPS:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventario con APS';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async addComment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { contenido } = req.body;
      const userId = req.user?.userId || 0;
      const campanaId = parseInt(id);

      // Obtener la campaña para conseguir el solicitud_id via propuesta
      const campana = await prisma.campania.findUnique({
        where: { id: campanaId },
      });

      if (!campana) {
        res.status(404).json({
          success: false,
          error: 'Campaña no encontrada',
        });
        return;
      }

      // Intentar obtener solicitud_id de la propuesta relacionada
      let solicitudId = 0;
      if (campana.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({
          where: { id: campana.cotizacion_id },
        });
        if (cotizacion?.id_propuesta) {
          const propuesta = await prisma.propuesta.findUnique({
            where: { id: cotizacion.id_propuesta },
          });
          if (propuesta?.solicitud_id) {
            solicitudId = propuesta.solicitud_id;
          }
        }
      }

      const comentario = await prisma.comentarios.create({
        data: {
          autor_id: userId,
          comentario: contenido,
          creado_en: new Date(),
          solicitud_id: solicitudId,
          campania_id: campanaId,
          origen: 'campana',
        },
      });

      // Crear notificaciones para todos los involucrados (excepto el autor)
      const userName = req.user?.nombre || 'Usuario';
      const nombreCampana = campana.nombre || 'Sin nombre';
      const tituloNotificacion = `Nuevo comentario en campaña #${campanaId} - ${nombreCampana}`;
      const descripcionNotificacion = `${userName} comentó: ${contenido.substring(0, 100)}${contenido.length > 100 ? '...' : ''}`;

      // Obtener propuesta y solicitud para los involucrados
      let propuestaData = null;
      let solicitudData = null;
      if (campana.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({
          where: { id: campana.cotizacion_id },
        });
        if (cotizacion?.id_propuesta) {
          propuestaData = await prisma.propuesta.findUnique({
            where: { id: cotizacion.id_propuesta },
          });
          if (propuestaData?.solicitud_id) {
            solicitudData = await prisma.solicitud.findUnique({
              where: { id: propuestaData.solicitud_id },
            });
          }
        }
      }

      // Recopilar todos los involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados de la propuesta
      if (propuestaData?.id_asignado) {
        propuestaData.id_asignado.split(',').forEach(id => {
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
            id_solicitud: solicitudId.toString(),
            id_propuesta: propuestaData?.id?.toString() || '',
            campania_id: campanaId,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            responsable: '',
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      res.status(201).json({
        success: true,
        data: {
          id: comentario.id,
          autor_id: comentario.autor_id,
          contenido: comentario.comentario,
          fecha: comentario.creado_en,
          solicitud_id: comentario.solicitud_id,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al agregar comentario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async removeAPS(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';
      const campanaId = id ? parseInt(id) : null;

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de reservaIds',
        });
        return;
      }

      console.log('removeAPS - reservaIds recibidos:', reservaIds);

      // Obtener los grupo_completo_id de las reservas seleccionadas
      const placeholders = reservaIds.map(() => '?').join(',');

      const gruposQuery = `
        SELECT DISTINCT grupo_completo_id
        FROM reservas
        WHERE id IN (${placeholders})
        AND grupo_completo_id IS NOT NULL
      `;

      const grupos = await prisma.$queryRawUnsafe<{ grupo_completo_id: number }[]>(gruposQuery, ...reservaIds);
      const grupoIds = grupos.map(g => g.grupo_completo_id);
      console.log('removeAPS - grupos encontrados:', grupoIds);

      // Actualizar reservas directamente seleccionadas (poner APS = NULL)
      const updateDirectQuery = `
        UPDATE reservas
        SET APS = NULL
        WHERE id IN (${placeholders})
      `;

      await prisma.$executeRawUnsafe(updateDirectQuery, ...reservaIds);
      console.log('removeAPS - actualizadas reservas directas');

      // Actualizar reservas del mismo grupo_completo (si hay grupos)
      if (grupoIds.length > 0) {
        const grupoPlaceholders = grupoIds.map(() => '?').join(',');
        const updateGruposQuery = `
          UPDATE reservas
          SET APS = NULL
          WHERE grupo_completo_id IN (${grupoPlaceholders})
        `;

        await prisma.$executeRawUnsafe(updateGruposQuery, ...grupoIds);
        console.log('removeAPS - actualizadas reservas de grupos');
      }

      // Crear notificaciones para usuarios involucrados
      if (campanaId) {
        const campana = await prisma.campania.findUnique({
          where: { id: campanaId },
        });

        if (campana?.cotizacion_id) {
          const cotizacion = await prisma.cotizacion.findUnique({
            where: { id: campana.cotizacion_id },
          });

          if (cotizacion?.id_propuesta) {
            const propuesta = await prisma.propuesta.findUnique({
              where: { id: cotizacion.id_propuesta },
            });

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
                    titulo: 'APS removido de reservas',
                    descripcion: `${userName} ha removido APS de ${reservaIds.length} reserva(s) en la campaña "${campana.nombre || campanaId}"`,
                    tipo: 'Notificación',
                    estatus: 'Pendiente',
                    id_responsable: responsableId,
                    asignado: userName,
                    id_asignado: userId?.toString() || '',
                    id_solicitud: propuesta.solicitud_id?.toString() || '',
                    id_propuesta: propuesta.id.toString(),
                    campania_id: campanaId,
                    fecha_inicio: now,
                    fecha_fin: now,
                  },
                });
              }

              // Registrar en historial
              await prisma.historial.create({
                data: {
                  tipo: 'Campaña',
                  ref_id: campanaId,
                  accion: 'Remoción de APS',
                  fecha_hora: now,
                  detalles: `${userName} removió APS de ${reservaIds.length} reserva(s)`,
                },
              });
            }
          }
        }
      }

      res.json({
        success: true,
        data: {
          message: `APS eliminado de ${reservaIds.length} reserva(s)`,
          affected: reservaIds.length,
        },
      });
    } catch (error) {
      console.error('Error en removeAPS:', error);
      const message = error instanceof Error ? error.message : 'Error al quitar APS';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getInventarioConArte(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      console.log('Fetching inventario con arte for campana:', campanaId);

      const query = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,

          inv.id,
          inv.codigo_unico,
          inv.ubicacion,
          inv.tipo_de_cara,
          inv.cara,
          inv.mueble,
          inv.latitud,
          inv.longitud,
          inv.plaza,
          inv.estado,
          inv.municipio,
          inv.tipo_de_mueble,
          inv.ancho,
          inv.alto,
          inv.nivel_socioeconomico,
          inv.tarifa_publica,
          inv.tradicional_digital,

          CASE
            WHEN MAX(rsv.grupo_completo_id) IS NOT NULL
            THEN CONCAT(
              SUBSTRING_INDEX(inv.codigo_unico, '_', 1),
              '_completo_',
              SUBSTRING_INDEX(inv.codigo_unico, '_', -1)
            )
            ELSE inv.codigo_unico
          END as codigo_unico_display,

          CASE
            WHEN MAX(rsv.grupo_completo_id) IS NOT NULL
            THEN 'Completo'
            ELSE inv.tipo_de_cara
          END as tipo_de_cara_display,

          MAX(rsv.archivo) AS archivo,

          GROUP_CONCAT(DISTINCT epIn.id ORDER BY epIn.id SEPARATOR ',') AS epInId,

          MAX(rsv.estatus) AS estatus,
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') AS rsvId,
          MAX(rsv.arte_aprobado) AS arte_aprobado,
          MAX(sc.id) AS solicitudCarasId,
          MAX(sc.id) AS grupo,
          MAX(sc.inicio_periodo) AS inicio_periodo,
          MAX(sc.fin_periodo) AS fin_periodo,
          MAX(rsv.comentario_rechazo) AS comentario_rechazo,
          MAX(rsv.instalado) AS instalado,
          MAX(rsv.APS) AS APS,
          MAX(rsv.tarea) AS tarea,

          MAX(CASE
            WHEN rsv.tarea IS NOT NULL AND rsv.tarea != '' THEN rsv.tarea
            ELSE rsv.estatus
          END) AS status_mostrar,

          COUNT(DISTINCT rsv.id) AS caras_totales,

          (SELECT sol2.IMU FROM propuesta pr2 INNER JOIN solicitud sol2 ON sol2.id = pr2.solicitud_id WHERE pr2.id = sc.idquote LIMIT 1) AS IMU,

          MAX(sc.articulo) AS articulo,
          MAX(sc.tipo) AS tipo_medio,
          MAX(cat.numero_catorcena) AS numero_catorcena,
          MAX(cat.año) AS anio_catorcena,
          COALESCE(MAX(rsv.grupo_completo_id), inv.id) as grupo_completo_id

        FROM inventarios inv
          INNER JOIN espacio_inventario epIn ON inv.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN archivos arc ON inv.archivos_id = arc.id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE
          cm.id = ?
          AND rsv.deleted_at IS NULL
          AND inv.tradicional_digital = 'Tradicional'
          AND rsv.archivo IS NOT NULL
          AND rsv.archivo != ''
        GROUP BY inv.id
        ORDER BY MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId);

      console.log('Inventario con arte result count:', Array.isArray(inventario) ? inventario.length : 0);

      // Convertir BigInt a Number para JSON serialization
      const inventarioSerializable = JSON.parse(JSON.stringify(inventario, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: inventarioSerializable,
      });
    } catch (error) {
      console.error('Error en getInventarioConArte:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventario con arte';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getHistorial(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      // Obtener la campaña para conseguir el id_propuesta
      const campana = await prisma.campania.findUnique({
        where: { id: campanaId },
      });

      if (!campana) {
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      // Obtener id_propuesta desde cotizacion
      let propuestaId: number | null = null;

      if (campana.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({
          where: { id: campana.cotizacion_id },
        });
        if (cotizacion?.id_propuesta) {
          propuestaId = cotizacion.id_propuesta;
        }
      }

      if (!propuestaId) {
        res.json({ success: true, data: [] });
        return;
      }

      // Obtener historial donde ref_id = id_propuesta (como en Retool)
      const historial = await prisma.historial.findMany({
        where: {
          ref_id: propuestaId,
        },
        orderBy: { fecha_hora: 'asc' },
      });

      // Convertir BigInt a Number para JSON serialization
      const historialSerializable = JSON.parse(JSON.stringify(historial, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: historialSerializable,
      });
    } catch (error) {
      console.error('Error en getHistorial:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener historial';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // ============================================================================
  // ENDPOINTS PARA GESTION DE ARTES
  // ============================================================================

  /**
   * Obtener inventario SIN arte asignado (para tab "Subir Artes")
   * Muestra items donde archivo IS NULL
   */
  async getInventarioSinArte(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);
      const formato = req.query.formato as string || 'Tradicional';

      console.log('Fetching inventario sin arte for campana:', campanaId, 'formato:', formato);

      const query = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_id,
          inv.id,
          inv.codigo_unico,
          inv.ubicacion,
          inv.tipo_de_cara,
          inv.cara,
          inv.mueble,
          inv.latitud,
          inv.longitud,
          inv.plaza,
          inv.estado,
          inv.municipio,
          inv.tipo_de_mueble,
          inv.ancho,
          inv.alto,
          inv.nivel_socioeconomico,
          inv.tarifa_publica,
          inv.tradicional_digital,
          CASE
            WHEN MAX(rsv.grupo_completo_id) IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(inv.codigo_unico, '_', 1), '_completo_', SUBSTRING_INDEX(inv.codigo_unico, '_', -1))
            ELSE inv.codigo_unico
          END as codigo_unico_display,
          CASE
            WHEN MAX(rsv.grupo_completo_id) IS NOT NULL THEN 'Completo'
            ELSE inv.tipo_de_cara
          END as tipo_de_cara_display,
          MAX(rsv.archivo) AS archivo,
          GROUP_CONCAT(DISTINCT epIn.id ORDER BY epIn.id SEPARATOR ',') AS epInId,
          MAX(rsv.estatus) AS estatus,
          GROUP_CONCAT(DISTINCT epIn.numero_espacio ORDER BY epIn.numero_espacio SEPARATOR ',') AS espacio,
          MAX(sc.id) AS grupo,
          MAX(sc.inicio_periodo) AS inicio_periodo,
          MAX(sc.fin_periodo) AS fin_periodo,
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') AS rsvId,
          MAX(rsv.APS) AS APS,
          COUNT(DISTINCT rsv.id) AS caras_totales,
          MAX(sc.articulo) AS articulo,
          MAX(sc.tipo) AS tipo_medio,
          MAX(cat.numero_catorcena) AS numero_catorcena,
          MAX(cat.año) AS anio_catorcena,
          COALESCE(MAX(rsv.grupo_completo_id), inv.id) as grupo_completo_id
        FROM inventarios inv
          INNER JOIN espacio_inventario epIn ON inv.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN archivos arc ON inv.archivos_id = arc.id
          LEFT JOIN imagenes_digitales imDig ON imDig.id_reserva = rsv.id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE
          cm.id = ?
          AND rsv.deleted_at IS NULL
          AND rsv.archivo IS NULL
          AND imDig.id_reserva IS NULL
          AND inv.tradicional_digital = ?
          AND rsv.APS IS NOT NULL
          AND rsv.APS > 0
        GROUP BY inv.id
        ORDER BY MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId, formato);

      console.log('Inventario sin arte result count:', Array.isArray(inventario) ? inventario.length : 0);

      const inventarioSerializable = JSON.parse(JSON.stringify(inventario, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: inventarioSerializable,
      });
    } catch (error) {
      console.error('Error en getInventarioSinArte:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventario sin arte';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Obtener inventario para validación de testigos (instalaciones)
   * Muestra items donde arte_aprobado = 'Aprobado' o ya tienen testigo
   */
  async getInventarioTestigos(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);
      const formato = req.query.formato as string || 'Tradicional';

      console.log('Fetching inventario testigos for campana:', campanaId);

      const query = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          inv.id,
          inv.codigo_unico,
          inv.ubicacion,
          inv.tipo_de_cara,
          inv.cara,
          inv.mueble,
          inv.latitud,
          inv.longitud,
          inv.plaza,
          inv.estado,
          inv.municipio,
          inv.ancho,
          inv.alto,
          inv.tarifa_publica,
          inv.tradicional_digital,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(inv.codigo_unico, '_', 1), '_completo_', SUBSTRING_INDEX(inv.codigo_unico, '_', -1))
            ELSE inv.codigo_unico
          END as codigo_unico_display,
          MAX(rsv.archivo) AS archivo,
          MAX(rsv.estatus) AS estatus,
          MAX(rsv.arte_aprobado) AS arte_aprobado,
          MAX(rsv.fecha_testigo) AS fecha_testigo,
          MAX(rsv.imagen_testigo) AS imagen_testigo,
          MAX(rsv.instalado) AS instalado,
          MAX(rsv.tarea) AS tarea,
          MAX(rsv.APS) AS APS,
          sc.articulo,
          sc.tipo as tipo_medio,
          sc.inicio_periodo,
          sc.fin_periodo,
          cat.numero_catorcena,
          cat.año as anio_catorcena,
          COUNT(DISTINCT rsv.id) AS caras_totales,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id
        FROM inventarios inv
          INNER JOIN espacio_inventario epIn ON inv.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE
          cm.id = ?
          AND rsv.deleted_at IS NULL
          AND inv.tradicional_digital = ?
          AND rsv.arte_aprobado = 'Aprobado'
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id)
        ORDER BY MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId, formato);

      console.log('Inventario testigos result count:', Array.isArray(inventario) ? inventario.length : 0);

      const inventarioSerializable = JSON.parse(JSON.stringify(inventario, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: inventarioSerializable,
      });
    } catch (error) {
      console.error('Error en getInventarioTestigos:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventario para testigos';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Asignar arte (archivo) a reservas
   */
  async assignArte(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds, archivo } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';
      const campanaId = parseInt(id);

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de reservaIds',
        });
        return;
      }

      // Si archivo es string vacío, es una operación de limpiar arte
      const isClearing = archivo === '';

      console.log('assignArte - reservaIds:', reservaIds, 'archivo:', archivo, 'isClearing:', isClearing);

      // Obtener los grupo_completo_id de las reservas seleccionadas
      const placeholders = reservaIds.map(() => '?').join(',');

      const gruposQuery = `
        SELECT DISTINCT grupo_completo_id
        FROM reservas
        WHERE id IN (${placeholders})
        AND grupo_completo_id IS NOT NULL
      `;

      const grupos = await prisma.$queryRawUnsafe<{ grupo_completo_id: number }[]>(gruposQuery, ...reservaIds);
      const grupoIds = grupos.map(g => g.grupo_completo_id);

      if (isClearing) {
        // Limpiar arte - poner archivo NULL y resetear estados
        const updateDirectQuery = `
          UPDATE reservas
          SET archivo = NULL, arte_aprobado = NULL, estatus = 'Sin Arte'
          WHERE id IN (${placeholders})
        `;

        await prisma.$executeRawUnsafe(updateDirectQuery, ...reservaIds);

        // Eliminar registros de imagenes_digitales para estas reservas
        const deleteImagenesQuery = `
          DELETE FROM imagenes_digitales
          WHERE id_reserva IN (${placeholders})
        `;
        await prisma.$executeRawUnsafe(deleteImagenesQuery, ...reservaIds);

        // Actualizar reservas del mismo grupo_completo
        if (grupoIds.length > 0) {
          const grupoPlaceholders = grupoIds.map(() => '?').join(',');
          const updateGruposQuery = `
            UPDATE reservas
            SET archivo = NULL, arte_aprobado = NULL, estatus = 'Sin Arte'
            WHERE grupo_completo_id IN (${grupoPlaceholders})
          `;

          await prisma.$executeRawUnsafe(updateGruposQuery, ...grupoIds);

          // También eliminar imagenes_digitales de reservas del mismo grupo
          const deleteImagenesGrupoQuery = `
            DELETE FROM imagenes_digitales
            WHERE id_reserva IN (
              SELECT id FROM reservas WHERE grupo_completo_id IN (${grupoPlaceholders})
            )
          `;
          await prisma.$executeRawUnsafe(deleteImagenesGrupoQuery, ...grupoIds);
        }

        // Eliminar reservas de las tareas asociadas
        // Obtener todas las reservas afectadas (incluyendo las del grupo)
        let allAffectedReservaIds = [...reservaIds];
        if (grupoIds.length > 0) {
          const grupoPlaceholders = grupoIds.map(() => '?').join(',');
          const grupoReservasQuery = `SELECT id FROM reservas WHERE grupo_completo_id IN (${grupoPlaceholders})`;
          const grupoReservas = await prisma.$queryRawUnsafe<{ id: number }[]>(grupoReservasQuery, ...grupoIds);
          allAffectedReservaIds = [...new Set([...allAffectedReservaIds, ...grupoReservas.map(r => r.id)])];
        }

        // Buscar tareas que contengan estas reservas
        const tareasQuery = `
          SELECT id, ids_reservas
          FROM tareas
          WHERE campania_id = ?
          AND ids_reservas IS NOT NULL
          AND ids_reservas != ''
        `;
        const tareas = await prisma.$queryRawUnsafe<{ id: number; ids_reservas: string }[]>(tareasQuery, campanaId);

        for (const tarea of tareas) {
          // Parsear los IDs de reservas de la tarea (pueden estar separados por coma o asterisco)
          const tareaReservaIds = tarea.ids_reservas
            .replace(/\*/g, ',')
            .split(',')
            .map(id => parseInt(id.trim()))
            .filter(id => !isNaN(id));

          // Filtrar los IDs que NO están siendo limpiados
          const remainingIds = tareaReservaIds.filter(id => !allAffectedReservaIds.includes(id));

          if (remainingIds.length === 0) {
            // Si no quedan reservas, eliminar la tarea
            await prisma.tareas.delete({ where: { id: tarea.id } });
            console.log(`Tarea ${tarea.id} eliminada porque ya no tiene reservas asignadas`);
          } else if (remainingIds.length !== tareaReservaIds.length) {
            // Si quedan algunas reservas, actualizar la tarea
            const newIdsReservas = remainingIds.join(',');
            await prisma.tareas.update({
              where: { id: tarea.id },
              data: { ids_reservas: newIdsReservas }
            });
            console.log(`Tarea ${tarea.id} actualizada: ${tareaReservaIds.length} -> ${remainingIds.length} reservas`);
          }
        }

        // Registrar en historial
        const campana = await prisma.campania.findUnique({ where: { id: campanaId } });
        if (campana?.cotizacion_id) {
          const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
          if (cotizacion?.id_propuesta) {
            await prisma.historial.create({
              data: {
                tipo: 'Arte',
                ref_id: cotizacion.id_propuesta,
                accion: 'Limpieza',
                fecha_hora: new Date(),
                detalles: `${userName} limpió el arte de ${reservaIds.length} reserva(s)`,
              },
            });
          }
        }

        res.json({
          success: true,
          data: {
            message: `Arte eliminado de ${reservaIds.length} reserva(s)`,
            affected: reservaIds.length,
          },
        });
        return;
      }

      // Validar archivo si no es limpieza
      if (!archivo) {
        res.status(400).json({
          success: false,
          error: 'Se requiere la URL del archivo',
        });
        return;
      }

      // Actualizar reservas directamente seleccionadas
      const updateDirectQuery = `
        UPDATE reservas
        SET archivo = ?, arte_aprobado = 'Pendiente', estatus = 'Con Arte'
        WHERE id IN (${placeholders})
      `;

      await prisma.$executeRawUnsafe(updateDirectQuery, archivo, ...reservaIds);

      // Actualizar reservas del mismo grupo_completo
      if (grupoIds.length > 0) {
        const grupoPlaceholders = grupoIds.map(() => '?').join(',');
        const updateGruposQuery = `
          UPDATE reservas
          SET archivo = ?, arte_aprobado = 'Pendiente', estatus = 'Con Arte'
          WHERE grupo_completo_id IN (${grupoPlaceholders})
        `;

        await prisma.$executeRawUnsafe(updateGruposQuery, archivo, ...grupoIds);
      }

      // Registrar en historial
      const campana = await prisma.campania.findUnique({ where: { id: campanaId } });
      if (campana?.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
        if (cotizacion?.id_propuesta) {
          await prisma.historial.create({
            data: {
              tipo: 'Arte',
              ref_id: cotizacion.id_propuesta,
              accion: 'Asignación',
              fecha_hora: new Date(),
              detalles: `${userName} asignó arte a ${reservaIds.length} reserva(s)`,
            },
          });
        }
      }

      res.json({
        success: true,
        data: {
          message: `Arte asignado a ${reservaIds.length} reserva(s)`,
          affected: reservaIds.length,
        },
      });

      // Emitir evento WebSocket para actualizar tablas de Gestión de Artes en tiempo real
      emitToCampana(campanaId, SOCKET_EVENTS.ARTE_SUBIDO, {
        campanaId,
        reservaIds,
        tipo: isClearing ? 'limpiar' : 'asignar',
        usuario: userName,
      });
    } catch (error) {
      console.error('Error en assignArte:', error);
      const message = error instanceof Error ? error.message : 'Error al asignar arte';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Actualizar estado de arte (aprobar/rechazar)
   */
  async updateArteStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds, status, comentarioRechazo } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';
      const campanaId = parseInt(id);

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de reservaIds',
        });
        return;
      }

      if (!status || !['Aprobado', 'Rechazado', 'Pendiente'].includes(status)) {
        res.status(400).json({
          success: false,
          error: 'Status debe ser "Aprobado", "Rechazado" o "Pendiente"',
        });
        return;
      }

      console.log('updateArteStatus - reservaIds:', reservaIds, 'status:', status);

      const placeholders = reservaIds.map(() => '?').join(',');

      // Obtener grupo_completo_id
      const gruposQuery = `
        SELECT DISTINCT grupo_completo_id
        FROM reservas
        WHERE id IN (${placeholders})
        AND grupo_completo_id IS NOT NULL
      `;

      const grupos = await prisma.$queryRawUnsafe<{ grupo_completo_id: number }[]>(gruposQuery, ...reservaIds);
      const grupoIds = grupos.map(g => g.grupo_completo_id);

      // Construir query de actualización según el estado
      let updateFields: string;
      let updateParams: (string | number)[];

      if (status === 'Rechazado') {
        if (comentarioRechazo) {
          updateFields = `arte_aprobado = ?, comentario_rechazo = ?, estatus = 'Arte Rechazado'`;
          updateParams = [status, comentarioRechazo, ...reservaIds];
        } else {
          updateFields = `arte_aprobado = ?, estatus = 'Arte Rechazado'`;
          updateParams = [status, ...reservaIds];
        }
      } else if (status === 'Pendiente') {
        updateFields = `arte_aprobado = ?, estatus = 'En Arte'`;
        updateParams = [status, ...reservaIds];
      } else {
        // Aprobado
        updateFields = `arte_aprobado = ?, estatus = 'Arte Aprobado'`;
        updateParams = [status, ...reservaIds];
      }

      // Actualizar reservas directas
      const updateDirectQuery = `
        UPDATE reservas
        SET ${updateFields}
        WHERE id IN (${placeholders})
      `;

      await prisma.$executeRawUnsafe(updateDirectQuery, ...updateParams);

      // Actualizar reservas del mismo grupo
      if (grupoIds.length > 0) {
        const grupoPlaceholders = grupoIds.map(() => '?').join(',');
        let grupoParams: (string | number)[];

        if (status === 'Rechazado') {
          if (comentarioRechazo) {
            grupoParams = [status, comentarioRechazo, ...grupoIds];
          } else {
            grupoParams = [status, ...grupoIds];
          }
        } else {
          grupoParams = [status, ...grupoIds];
        }

        const updateGruposQuery = `
          UPDATE reservas
          SET ${updateFields}
          WHERE grupo_completo_id IN (${grupoPlaceholders})
        `;

        await prisma.$executeRawUnsafe(updateGruposQuery, ...grupoParams);
      }

      // Registrar en historial
      const campana = await prisma.campania.findUnique({ where: { id: campanaId } });
      if (campana?.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
        if (cotizacion?.id_propuesta) {
          await prisma.historial.create({
            data: {
              tipo: 'Arte',
              ref_id: cotizacion.id_propuesta,
              accion: status === 'Aprobado' ? 'Aprobación' : 'Rechazo',
              fecha_hora: new Date(),
              detalles: `${userName} ${status === 'Aprobado' ? 'aprobó' : 'rechazó'} arte de ${reservaIds.length} reserva(s)${comentarioRechazo ? ': ' + comentarioRechazo : ''}`,
            },
          });
        }
      }

      // Si es rechazo, intercambiar creador y asignado en la tarea de Revisión de artes
      console.log('updateArteStatus - Status:', status, '- CampanaId:', campanaId);
      if (status === 'Rechazado') {
        console.log('updateArteStatus - Buscando tareas de Revisión de artes para rotar roles...');
        // Buscar la tarea de Revisión de artes que contiene estas reservas
        const tareasRevision = await prisma.$queryRawUnsafe<{
          id: number;
          ids_reservas: string;
          responsable: string | null;
          id_responsable: number;
          asignado: string | null;
          id_asignado: string | null;
        }[]>(`
          SELECT id, ids_reservas, responsable, id_responsable, asignado, id_asignado
          FROM tareas
          WHERE campania_id = ?
          AND tipo = 'Revisión de artes'
          AND ids_reservas IS NOT NULL
          AND ids_reservas != ''
          AND estatus = 'Activo'
        `, campanaId);

        console.log('updateArteStatus - Tareas encontradas:', tareasRevision.length, tareasRevision);

        // Encontrar la tarea que contiene alguna de las reservas rechazadas
        for (const tarea of tareasRevision) {
          const tareaReservaIds = tarea.ids_reservas
            .replace(/\*/g, ',')
            .split(',')
            .map(id => parseInt(id.trim()))
            .filter(id => !isNaN(id));

          const tieneReservasRechazadas = reservaIds.some(rId => tareaReservaIds.includes(rId));

          if (tieneReservasRechazadas) {
            // Rotar: el asignado original se vuelve creador, el creador original se vuelve asignado
            const nuevoResponsable = tarea.asignado;
            const nuevoIdResponsable = tarea.id_asignado ? parseInt(tarea.id_asignado) : tarea.id_responsable;
            const nuevoAsignado = tarea.responsable;
            const nuevoIdAsignado = String(tarea.id_responsable);

            await prisma.tareas.update({
              where: { id: tarea.id },
              data: {
                responsable: nuevoResponsable,
                id_responsable: nuevoIdResponsable,
                asignado: nuevoAsignado,
                id_asignado: nuevoIdAsignado,
              },
            });

            console.log(`Tarea ${tarea.id} - Roles rotados: Creador ahora es ${nuevoResponsable}, Asignado ahora es ${nuevoAsignado}`);
          }
        }
      }

      res.json({
        success: true,
        data: {
          message: `Arte ${status.toLowerCase()} para ${reservaIds.length} reserva(s)`,
          affected: reservaIds.length,
        },
      });

      // Emitir evento WebSocket para actualizar tablas de Gestión de Artes en tiempo real
      const socketEvent = status === 'Aprobado' ? SOCKET_EVENTS.ARTE_APROBADO : SOCKET_EVENTS.ARTE_RECHAZADO;
      emitToCampana(campanaId, socketEvent, {
        campanaId,
        reservaIds,
        status,
        usuario: userName,
      });
      // También emitir INVENTARIO_ACTUALIZADO para refrescar todas las tablas
      emitToCampana(campanaId, SOCKET_EVENTS.INVENTARIO_ACTUALIZADO, { campanaId });
    } catch (error) {
      console.error('Error en updateArteStatus:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar estado de arte';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Actualizar estado de instalación (testigo)
   */
  async updateInstalado(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds, instalado, imagenTestigo, fechaTestigo } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';
      const campanaId = parseInt(id);

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de reservaIds',
        });
        return;
      }

      console.log('updateInstalado - reservaIds:', reservaIds, 'instalado:', instalado);

      const placeholders = reservaIds.map(() => '?').join(',');

      // Construir campos a actualizar
      const updateFields: string[] = ['instalado = ?'];
      const updateParams: (boolean | string | number)[] = [instalado ? 1 : 0];

      if (imagenTestigo) {
        updateFields.push('imagen_testigo = ?');
        updateParams.push(imagenTestigo);
      }

      if (fechaTestigo) {
        updateFields.push('fecha_testigo = ?');
        updateParams.push(fechaTestigo);
      }

      if (instalado) {
        updateFields.push("estatus = 'Instalado'");
      }

      const updateQuery = `
        UPDATE reservas
        SET ${updateFields.join(', ')}
        WHERE id IN (${placeholders})
      `;

      await prisma.$executeRawUnsafe(updateQuery, ...updateParams, ...reservaIds);

      // Registrar en historial
      const campana = await prisma.campania.findUnique({ where: { id: campanaId } });
      if (campana?.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
        if (cotizacion?.id_propuesta) {
          await prisma.historial.create({
            data: {
              tipo: 'Instalación',
              ref_id: cotizacion.id_propuesta,
              accion: instalado ? 'Validación' : 'Rechazo',
              fecha_hora: new Date(),
              detalles: `${userName} ${instalado ? 'validó' : 'rechazó'} instalación de ${reservaIds.length} reserva(s)`,
            },
          });
        }
      }

      res.json({
        success: true,
        data: {
          message: `Instalación ${instalado ? 'validada' : 'rechazada'} para ${reservaIds.length} reserva(s)`,
          affected: reservaIds.length,
        },
      });
    } catch (error) {
      console.error('Error en updateInstalado:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar estado de instalación';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Verificar si reservas tienen tareas asociadas (para confirmar antes de limpiar arte)
   */
  async checkReservasTareas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds } = req.body;
      const campanaId = parseInt(id);

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.json({ success: true, data: { hasTareas: false, tareas: [] } });
        return;
      }

      // Buscar tareas que contengan estas reservas
      const tareasQuery = `
        SELECT id, titulo, tipo, estatus, ids_reservas, responsable
        FROM tareas
        WHERE campania_id = ?
        AND ids_reservas IS NOT NULL
        AND ids_reservas != ''
        AND estatus NOT IN ('Atendido', 'Cancelado')
      `;
      const tareas = await prisma.$queryRawUnsafe<{
        id: number;
        titulo: string | null;
        tipo: string | null;
        estatus: string | null;
        ids_reservas: string;
        responsable: string | null;
      }[]>(tareasQuery, campanaId);

      // Filtrar solo las tareas que contienen alguna de las reservas
      const tareasAfectadas = tareas.filter(tarea => {
        const tareaReservaIds = tarea.ids_reservas
          .replace(/\*/g, ',')
          .split(',')
          .map(id => parseInt(id.trim()))
          .filter(id => !isNaN(id));
        return reservaIds.some((rid: number) => tareaReservaIds.includes(rid));
      });

      res.json({
        success: true,
        data: {
          hasTareas: tareasAfectadas.length > 0,
          tareas: tareasAfectadas.map(t => ({
            id: t.id,
            titulo: t.titulo,
            tipo: t.tipo,
            estatus: t.estatus,
            responsable: t.responsable
          }))
        }
      });
    } catch (error) {
      console.error('Error en checkReservasTareas:', error);
      res.status(500).json({
        success: false,
        error: 'Error al verificar tareas de reservas'
      });
    }
  }

  /**
   * Obtener tareas de una campaña específica (versión completa con JOINs)
   */
  async getTareas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);
      const estatus = req.query.estatus as string;
      const activas = req.query.activas === 'true';

      console.log('Fetching tareas for campana:', campanaId, 'activas:', activas);

      // Si se piden tareas activas, usar query completa con JOINs
      if (activas) {
        let estatusFilter = '';
        if (estatus) {
          estatusFilter = `AND tr.estatus = '${estatus}'`;
        }

        const tareasActivas = await prisma.$queryRaw<Array<{
          id: number;
          titulo: string | null;
          descripcion: string | null;
          contenido: string | null;
          tipo: string | null;
          estatus: string | null;
          fecha_inicio: Date;
          fecha_fin: Date;
          responsable: string | null;
          id_responsable: number;
          asignado: string | null;
          id_asignado: string | null;
          archivo: string | null;
          evidencia: string | null;
          ids_reservas: string | null;
          listado_inventario: string | null;
          proveedores_id: number | null;
          nombre_proveedores: string | null;
          num_impresiones: number | null;
          archivo_testigo: string | null;
          nombre: string | null;
          correo_electronico: string | null;
          inventario_id: string | null;
          APS: string | null;
          tarea_reserva: string | null;
          Archivo_reserva: string | null;
        }>>`
          SELECT tr.*,
                 us.nombre,
                 us.correo_electronico,
                 GROUP_CONCAT(DISTINCT COALESCE(inv.id, inv2.id) SEPARATOR ', ') as inventario_id,
                 GROUP_CONCAT(DISTINCT COALESCE(sc.id, sc2.id) SEPARATOR ', ') as APS,
                 GROUP_CONCAT(DISTINCT COALESCE(rsv.tarea, rsv2.tarea) SEPARATOR ', ') as tarea_reserva,
                 GROUP_CONCAT(DISTINCT COALESCE(rsv.Archivo, rsv2.Archivo) SEPARATOR ', ') as Archivo_reserva
          FROM tareas tr
          INNER JOIN usuario us ON us.id = tr.id_responsable
          LEFT JOIN reservas rsv ON FIND_IN_SET(rsv.id, REPLACE(tr.ids_reservas, '*', '')) > 0
          LEFT JOIN espacio_inventario epIn ON epIn.id = rsv.inventario_id
          LEFT JOIN inventarios inv ON inv.id = epIn.inventario_id
          LEFT JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          LEFT JOIN reservas rsv2 ON FIND_IN_SET(rsv2.id, tr.listado_inventario) > 0
          LEFT JOIN espacio_inventario epIn2 ON epIn2.id = rsv2.inventario_id
          LEFT JOIN inventarios inv2 ON inv2.id = epIn2.inventario_id
          LEFT JOIN solicitudCaras sc2 ON sc2.id = rsv2.solicitudCaras_id
          WHERE tr.campania_id = ${campanaId}
            AND tr.estatus != 'Atendido'
            AND tr.estatus != 'Pendientes'
            AND tr.estatus != 'Notificación nueva'
            AND (rsv.tarea IS NULL OR rsv.tarea != 'Aprobado')
            AND (rsv2.tarea IS NULL OR rsv2.tarea != 'Aprobado')
            ${estatus ? Prisma.sql`AND tr.estatus = ${estatus}` : Prisma.empty}
          GROUP BY tr.id, us.nombre, us.correo_electronico
          ORDER BY tr.id DESC
        `;

        const tareasFormateadas = tareasActivas.map(t => ({
          id: t.id,
          titulo: t.titulo,
          descripcion: t.descripcion,
          contenido: t.contenido,
          tipo: t.tipo,
          estatus: t.estatus,
          fecha_inicio: t.fecha_inicio,
          fecha_fin: t.fecha_fin,
          responsable: t.responsable,
          id_responsable: t.id_responsable,
          responsable_nombre: t.nombre,
          correo_electronico: t.correo_electronico,
          asignado: t.asignado,
          id_asignado: t.id_asignado,
          archivo: t.archivo,
          evidencia: t.evidencia,
          ids_reservas: t.ids_reservas,
          listado_inventario: t.listado_inventario,
          proveedores_id: t.proveedores_id,
          nombre_proveedores: t.nombre_proveedores,
          num_impresiones: t.num_impresiones,
          archivo_testigo: t.archivo_testigo,
          inventario_id: t.inventario_id,
          APS: t.APS,
          tarea_reserva: t.tarea_reserva,
          Archivo_reserva: t.Archivo_reserva,
        }));

        res.json({
          success: true,
          data: tareasFormateadas,
        });
        return;
      }

      // Query simple para todas las tareas
      const where: Record<string, unknown> = {
        campania_id: campanaId,
        tipo: { not: 'Notificación' },
      };

      if (estatus) {
        where.estatus = estatus;
      }

      const tareas = await prisma.tareas.findMany({
        where,
        orderBy: { fecha_fin: 'asc' },
      });

      // Obtener nombres de responsables
      const responsableIds = [...new Set(tareas.map(t => t.id_responsable).filter(id => id > 0))];
      const usuarios = await prisma.usuario.findMany({
        where: { id: { in: responsableIds } },
        select: { id: true, nombre: true, foto_perfil: true, correo_electronico: true },
      });
      const usuarioMap = new Map(usuarios.map(u => [u.id, u]));

      const tareasConNombres = tareas.map(t => ({
        id: t.id,
        titulo: t.titulo,
        descripcion: t.descripcion,
        contenido: t.contenido,
        tipo: t.tipo,
        estatus: t.estatus,
        fecha_inicio: t.fecha_inicio,
        fecha_fin: t.fecha_fin,
        responsable: t.responsable,
        id_responsable: t.id_responsable,
        responsable_nombre: usuarioMap.get(t.id_responsable)?.nombre || t.responsable,
        responsable_foto: usuarioMap.get(t.id_responsable)?.foto_perfil || null,
        correo_electronico: usuarioMap.get(t.id_responsable)?.correo_electronico || null,
        asignado: t.asignado,
        id_asignado: t.id_asignado,
        archivo: t.archivo,
        evidencia: t.evidencia,
        ids_reservas: t.ids_reservas,
        listado_inventario: t.listado_inventario,
        proveedores_id: t.proveedores_id,
        nombre_proveedores: t.nombre_proveedores,
        num_impresiones: t.num_impresiones,
      }));

      res.json({
        success: true,
        data: tareasConNombres,
      });
    } catch (error) {
      console.error('Error en getTareas:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener tareas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Crear tarea para una campaña
   */
  async createTarea(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const {
        titulo,
        descripcion,
        tipo,
        fecha_fin,
        id_responsable,
        responsable,
        asignado,
        id_asignado,
        ids_reservas,
        proveedores_id,
        nombre_proveedores,
        contenido,
        listado_inventario,
        catorcena_entrega,
        creador,
        impresiones, // Número de impresiones por inventario { inventario_id: cantidad }
        num_impresiones, // Total de impresiones (enviado desde frontend)
        evidencia, // Evidencia para tareas de Recepción Faltantes
      } = req.body;
      const campanaId = parseInt(id);

      // Obtener el ID y nombre del responsable desde el token JWT del usuario logueado
      const responsableId = req.user?.userId || 0;
      const responsableNombre = req.user?.nombre || '';

      // Debug: Ver qué recibimos
      console.log('createTarea - Body recibido:', { asignado, id_asignado, tipo, titulo, id_responsable });
      console.log('createTarea - Token user:', { userId: req.user?.userId, nombre: req.user?.nombre });
      console.log('createTarea - Responsable final:', { responsableId, responsableNombre });

      // Obtener info de la campaña para el id_propuesta
      const campana = await prisma.campania.findUnique({ where: { id: campanaId } });
      let propuestaId = '';
      let solicitudId = '';
      const campanaNombre = campana?.nombre || 'Campaña';

      if (campana?.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
        if (cotizacion?.id_propuesta) {
          propuestaId = cotizacion.id_propuesta.toString();
          const propuesta = await prisma.propuesta.findUnique({ where: { id: cotizacion.id_propuesta } });
          if (propuesta?.solicitud_id) {
            solicitudId = propuesta.solicitud_id.toString();
          }
        }
      }

      // Determinar fecha_fin y estatus según el tipo de tarea
      let fechaFinFinal = fecha_fin ? new Date(fecha_fin) : new Date();
      let estatusFinal = 'Pendiente';

      // Para Revisión de artes e Impresión, estatus siempre es Activo
      if (tipo === 'Revisión de artes' || tipo === 'Impresión') {
        estatusFinal = 'Activo';
        // Si hay catorcena, obtener fecha_fin de la catorcena seleccionada
        if (catorcena_entrega) {
          const match = catorcena_entrega.match(/Catorcena (\d+), (\d+)/);
          if (match) {
            const numCatorcena = parseInt(match[1]);
            const yearCatorcena = parseInt(match[2]);
            const catorcena = await prisma.catorcenas.findFirst({
              where: { numero_catorcena: numCatorcena, a_o: yearCatorcena },
            });
            if (catorcena?.fecha_fin) {
              fechaFinFinal = new Date(catorcena.fecha_fin);
            }
          }
        }
      }

      // Preparar datos de impresiones como JSON para almacenar en evidencia
      let evidenciaData: string | null = null;
      let numImpresionesTotal: number | null = null;

      // DEBUG: Log de todo el body para ver qué llega
      console.log('createTarea - tipo:', tipo, 'num_impresiones:', num_impresiones, 'impresiones:', JSON.stringify(impresiones));

      if (tipo === 'Impresión' && (impresiones || catorcena_entrega)) {
        evidenciaData = JSON.stringify({ impresiones: impresiones || {}, catorcena_entrega });
        // Usar num_impresiones enviado desde el frontend directamente
        if (num_impresiones !== undefined && num_impresiones !== null) {
          numImpresionesTotal = Number(num_impresiones);
          console.log('createTarea - numImpresionesTotal asignado:', numImpresionesTotal);
        } else {
          console.log('createTarea - num_impresiones NO llegó del frontend');
        }
      } else if (evidencia) {
        // Usar evidencia enviada desde el frontend (ej: para Recepción Faltantes)
        evidenciaData = evidencia;
      }

      const tarea = await prisma.tareas.create({
        data: {
          titulo: titulo || 'Nueva tarea',
          descripcion,
          tipo: tipo || 'Producción',
          estatus: estatusFinal,
          fecha_inicio: new Date(),
          fecha_fin: fechaFinFinal,
          id_responsable: responsableId,
          responsable: responsableNombre || null,
          asignado: asignado || responsableNombre || null,
          id_asignado: id_asignado || String(responsableId),
          id_solicitud: solicitudId,
          id_propuesta: propuestaId,
          campania_id: campanaId,
          ids_reservas: ids_reservas || null,
          proveedores_id: proveedores_id || null,
          nombre_proveedores: nombre_proveedores || null,
          contenido: contenido || null,
          listado_inventario: listado_inventario || null,
          evidencia: evidenciaData, // Datos de impresiones para tipo Impresión
          num_impresiones: numImpresionesTotal,
        },
      });

      // Actualizar campo tarea en las reservas si se proporcionaron ids
      if (ids_reservas) {
        const reservaIdArray = ids_reservas.split(',').map((id: string) => parseInt(id.trim())).filter((id: number) => !isNaN(id));
        if (reservaIdArray.length > 0) {
          const placeholders = reservaIdArray.map(() => '?').join(',');
          // Determinar valor de tarea según tipo
          let tareaValue = tipo || 'Producción';
          if (tipo === 'Revisión de artes') {
            tareaValue = 'En revisión';
          } else if (tipo === 'Impresión') {
            tareaValue = 'Pedido Solicitado';
          } else if (tipo === 'Recepción') {
            tareaValue = 'Por Recibir';
          }
          await prisma.$executeRawUnsafe(
            `UPDATE reservas SET tarea = ? WHERE id IN (${placeholders})`,
            tareaValue,
            ...reservaIdArray
          );
        }
      }

      // Enviar respuesta inmediatamente
      res.status(201).json({
        success: true,
        data: {
          id: tarea.id,
          titulo: tarea.titulo,
          descripcion: tarea.descripcion,
          tipo: tarea.tipo,
          estatus: tarea.estatus,
          fecha_inicio: tarea.fecha_inicio,
          fecha_fin: tarea.fecha_fin,
          campania_id: tarea.campania_id,
        },
      });

      // Emitir evento de WebSocket para notificar a otros usuarios
      emitToCampana(campanaId, SOCKET_EVENTS.TAREA_CREADA, {
        tareaId: tarea.id,
        campanaId,
        tipo: tarea.tipo,
        titulo: tarea.titulo,
      });

      // Enviar correo al asignado de forma asíncrona (no bloquea la respuesta)
      if ((tipo === 'Revisión de artes' || tipo === 'Instalación' || tipo === 'Impresión') && id_asignado) {
        const asignadoIdNum = parseInt(id_asignado);
        if (!isNaN(asignadoIdNum)) {
          prisma.usuario.findUnique({
            where: { id: asignadoIdNum },
            select: { correo_electronico: true, nombre: true },
          }).then(usuarioAsignado => {
            if (usuarioAsignado?.correo_electronico && process.env.SMTP_USER && process.env.SMTP_PASS) {
              const htmlBody = `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                <div style="text-align: center; background: #8b5cf6; padding: 25px; border-radius: 12px 12px 0 0;">
                  <h1 style="color: #ffffff; margin: 0; font-size: 28px;">QEB</h1>
                  <p style="color: rgba(255,255,255,0.9); margin: 5px 0 0 0; font-size: 12px;">OOH Management</p>
                </div>
                <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
                  <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px;">Nueva Tarea Asignada</h2>
                  <p style="color: #6b7280; font-size: 14px; line-height: 1.6; margin: 0 0 15px 0;">
                    Se te ha asignado la tarea <strong>${titulo || 'Nueva tarea'}</strong> para <strong>${tipo}</strong>: ${contenido || descripcion || ''}
                  </p>
                  <div style="background: #f3f4f6; border-radius: 8px; padding: 15px; margin: 20px 0;">
                    <p style="margin: 5px 0; font-size: 13px; color: #374151;"><strong>Campaña:</strong> ${campanaNombre}</p>
                    <p style="margin: 5px 0; font-size: 13px; color: #374151;"><strong>Creador:</strong> ${responsableNombre}</p>
                  </div>
                </div>
                <div style="background: #374151; padding: 15px; border-radius: 0 0 12px 12px; text-align: center;">
                  <p style="color: #9ca3af; font-size: 11px; margin: 0;">Mensaje automático del sistema QEB.</p>
                </div>
              </div>
              `;

              transporter.sendMail({
                from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
                to: usuarioAsignado.correo_electronico,
                subject: `Tarea campaña ${campanaNombre}`,
                html: htmlBody,
              }).then(() => {
                console.log('Correo de tarea enviado a:', usuarioAsignado.correo_electronico);
                // Guardar en correos_enviados
                prisma.correos_enviados.create({
                  data: {
                    remitente: 'no-reply@qeb.mx',
                    destinatario: usuarioAsignado.correo_electronico,
                    asunto: `Tarea campaña ${campanaNombre}`,
                    cuerpo: htmlBody,
                  },
                }).catch(err => console.error('Error guardando correo enviado:', err));
              }).catch(emailError => {
                console.error('Error enviando correo de tarea:', emailError);
              });
            }
          }).catch(err => console.error('Error buscando usuario para correo:', err));
        }
      }
    } catch (error) {
      console.error('Error en createTarea:', error);
      const message = error instanceof Error ? error.message : 'Error al crear tarea';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Actualizar tarea
   */
  async updateTarea(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id, tareaId } = req.params;
      const {
        titulo,
        descripcion,
        tipo,
        estatus,
        fecha_fin,
        asignado,
        id_asignado,
        archivo,
        evidencia,
        archivo_testigo,
      } = req.body;

      const updateData: Record<string, unknown> = {};
      if (titulo !== undefined) updateData.titulo = titulo;
      if (descripcion !== undefined) updateData.descripcion = descripcion;
      if (tipo !== undefined) updateData.tipo = tipo;
      if (estatus !== undefined) updateData.estatus = estatus;
      if (fecha_fin !== undefined) updateData.fecha_fin = new Date(fecha_fin);
      if (asignado !== undefined) updateData.asignado = asignado;
      if (id_asignado !== undefined) updateData.id_asignado = id_asignado;
      if (archivo !== undefined) updateData.archivo = archivo;
      if (evidencia !== undefined) updateData.evidencia = evidencia;
      if (archivo_testigo !== undefined) updateData.archivo_testigo = archivo_testigo;

      const tarea = await prisma.tareas.update({
        where: { id: parseInt(tareaId) },
        data: updateData,
      });

      // Si es una tarea de tipo Testigo y se está completando, actualizar el estado de instalación a validado
      if (tipo === 'Testigo' && estatus === 'Completado' && tarea.ids_reservas) {
        const reservaIds = tarea.ids_reservas.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (reservaIds.length > 0) {
          // Actualizar las reservas a instalado = true (validado)
          await prisma.reservas.updateMany({
            where: { id: { in: reservaIds } },
            data: { instalado: true },
          });
          console.log(`Testigo completado: ${reservaIds.length} reservas marcadas como validadas`);
        }
      }

      res.json({
        success: true,
        data: tarea,
      });

      // Emitir evento de WebSocket para notificar a otros usuarios
      if (tarea.campania_id) {
        emitToCampana(tarea.campania_id, SOCKET_EVENTS.TAREA_ACTUALIZADA, {
          tareaId: tarea.id,
          campanaId: tarea.campania_id,
          estatus: tarea.estatus,
        });
      }
    } catch (error) {
      console.error('Error en updateTarea:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar tarea';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Eliminar una tarea
  async deleteTarea(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { tareaId } = req.params;
      const tareaIdNum = parseInt(tareaId);

      // Verificar que la tarea existe
      const tarea = await prisma.tareas.findUnique({
        where: { id: tareaIdNum },
      });

      if (!tarea) {
        res.status(404).json({
          success: false,
          error: 'Tarea no encontrada',
        });
        return;
      }

      // Si la tarea tiene ids_reservas, limpiar el campo tarea de esas reservas
      if (tarea.ids_reservas) {
        const reservaIds = tarea.ids_reservas.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (reservaIds.length > 0) {
          await prisma.$executeRawUnsafe(
            `UPDATE reservas SET tarea = NULL WHERE id IN (${reservaIds.join(',')})`
          );
        }
      }

      // Guardar campanaId antes de eliminar
      const campanaId = tarea.campania_id;

      // Eliminar la tarea
      await prisma.tareas.delete({
        where: { id: tareaIdNum },
      });

      res.json({
        success: true,
        message: 'Tarea eliminada correctamente',
      });

      // Emitir evento de WebSocket para notificar a otros usuarios
      if (campanaId) {
        emitToCampana(campanaId, SOCKET_EVENTS.TAREA_ELIMINADA, {
          tareaId: tareaIdNum,
          campanaId,
        });
      }
    } catch (error) {
      console.error('Error en deleteTarea:', error);
      const message = error instanceof Error ? error.message : 'Error al eliminar tarea';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async assignAPS(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { inventarioIds, campanaId } = req.body;
      const userId = req.user?.userId || 0;
      const userName = req.user?.nombre || 'Usuario';

      if (!inventarioIds || !Array.isArray(inventarioIds) || inventarioIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de inventarioIds',
        });
        return;
      }

      console.log('assignAPS - inventarioIds recibidos:', inventarioIds);

      // Paso 1: Obtener el siguiente número APS
      const maxAPSResult = await prisma.$queryRaw<{ maxAPS: bigint | null }[]>`
        SELECT IFNULL(MAX(CAST(APS AS UNSIGNED)), 0) as maxAPS FROM reservas
      `;
      const newAPS = Number(maxAPSResult[0]?.maxAPS || 0) + 1;
      console.log('assignAPS - nuevo APS:', newAPS);

      // Paso 2: Obtener los grupo_completo_id de las reservas seleccionadas
      const placeholders = inventarioIds.map(() => '?').join(',');

      const gruposQuery = `
        SELECT DISTINCT r.grupo_completo_id
        FROM reservas r
        JOIN espacio_inventario ei ON r.inventario_id = ei.id
        WHERE ei.inventario_id IN (${placeholders})
        AND r.grupo_completo_id IS NOT NULL
      `;

      const grupos = await prisma.$queryRawUnsafe<{ grupo_completo_id: number }[]>(gruposQuery, ...inventarioIds);
      const grupoIds = grupos.map(g => g.grupo_completo_id);
      console.log('assignAPS - grupos encontrados:', grupoIds);

      // Paso 3: Actualizar reservas directamente seleccionadas
      const updateDirectQuery = `
        UPDATE reservas r
        JOIN espacio_inventario ei ON r.inventario_id = ei.id
        SET r.APS = ?
        WHERE ei.inventario_id IN (${placeholders})
        AND (r.APS IS NULL OR r.APS = 0)
      `;

      await prisma.$executeRawUnsafe(updateDirectQuery, newAPS, ...inventarioIds);
      console.log('assignAPS - actualizadas reservas directas');

      // Paso 4: Actualizar reservas del mismo grupo_completo (si hay grupos)
      if (grupoIds.length > 0) {
        const grupoPlaceholders = grupoIds.map(() => '?').join(',');
        const updateGruposQuery = `
          UPDATE reservas
          SET APS = ?
          WHERE grupo_completo_id IN (${grupoPlaceholders})
          AND (APS IS NULL OR APS = 0)
        `;

        await prisma.$executeRawUnsafe(updateGruposQuery, newAPS, ...grupoIds);
        console.log('assignAPS - actualizadas reservas de grupos');
      }

      // Paso 5: Crear notificaciones para los involucrados
      let campana = null;
      let propuesta = null;
      let solicitud = null;

      if (campanaId) {
        campana = await prisma.campania.findUnique({ where: { id: parseInt(campanaId) } });
        if (campana?.cotizacion_id) {
          const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
          if (cotizacion?.id_propuesta) {
            propuesta = await prisma.propuesta.findUnique({ where: { id: cotizacion.id_propuesta } });
            if (propuesta?.solicitud_id) {
              solicitud = await prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } });
            }
          }
        }
      }

      const nombreCampana = campana?.nombre || 'Campaña';
      const tituloNotificacion = `APS #${newAPS} asignado - ${nombreCampana}`;
      const descripcionNotificacion = `${userName} asignó APS #${newAPS} a ${inventarioIds.length} ubicación(es)`;

      // Recopilar involucrados
      const involucrados = new Set<number>();

      if (propuesta?.id_asignado) {
        propuesta.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      if (solicitud?.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
      }

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
            id_solicitud: solicitud?.id?.toString() || '',
            id_propuesta: propuesta?.id?.toString() || '',
            campania_id: campana?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      // Registrar en historial
      if (propuesta) {
        await prisma.historial.create({
          data: {
            tipo: 'Campaña',
            ref_id: propuesta.id,
            accion: 'Asignación APS',
            fecha_hora: now,
            detalles: `${userName} asignó APS #${newAPS} a ${inventarioIds.length} ubicación(es)`,
          },
        });
      }

      res.json({
        success: true,
        data: {
          aps: newAPS,
          message: `APS ${newAPS} asignado correctamente`,
        },
      });
    } catch (error) {
      console.error('Error en assignAPS:', error);
      const message = error instanceof Error ? error.message : 'Error al asignar APS';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Limpiar artes de prueba (archivos con prefijo "arte-" generados con timestamp)
   * ENDPOINT TEMPORAL PARA DESARROLLO
   */
  async limpiarArtesPrueba(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      // Buscar reservas con archivos de prueba (arte-TIMESTAMP)
      const query = `
        UPDATE reservas r
        JOIN solicitudCaras sc ON r.solicitudCaras_id = sc.id
        JOIN cotizacion ct ON sc.idquote = ct.id_propuesta
        JOIN campania cm ON cm.cotizacion_id = ct.id
        SET r.archivo = NULL, r.arte_aprobado = NULL
        WHERE cm.id = ?
          AND r.archivo IS NOT NULL
          AND (r.archivo LIKE '%arte-%' OR r.archivo LIKE '%localhost%')
      `;

      await prisma.$executeRawUnsafe(query, campanaId);

      console.log('Artes de prueba limpiados para campaña:', campanaId);

      res.json({
        success: true,
        message: 'Artes de prueba limpiados correctamente',
      });
    } catch (error) {
      console.error('Error limpiando artes de prueba:', error);
      const message = error instanceof Error ? error.message : 'Error al limpiar artes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Verificar si un arte ya existe en la campaña por nombre de archivo
   * Retorna si existe, cuántas veces se usa y la URL existente
   */
  async verificarArteExistente(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { nombre, url } = req.body;

      // Extraer nombre del archivo de la URL o usar el nombre proporcionado
      let nombreArchivo = nombre;
      if (!nombreArchivo && url) {
        // Extraer nombre del archivo de la URL
        const urlSinParams = url.split('?')[0];
        nombreArchivo = urlSinParams.split('/').pop() || '';
      }

      if (!nombreArchivo) {
        res.status(400).json({
          success: false,
          error: 'Se requiere el nombre del archivo o URL',
        });
        return;
      }

      // Normalizar nombre para comparación
      const nombreNormalizado = nombreArchivo.trim().toLowerCase();

      const query = `
        SELECT
          r.archivo as url,
          SUBSTRING_INDEX(r.archivo, '/', -1) as nombre,
          COUNT(*) as uso_count
        FROM reservas r
        JOIN solicitudCaras sc ON r.solicitudCaras_id = sc.id
        JOIN cotizacion ct ON sc.idquote = ct.id_propuesta
        JOIN campania cm ON cm.cotizacion_id = ct.id
        WHERE cm.id = ?
          AND r.archivo IS NOT NULL
          AND r.archivo != ''
          AND r.deleted_at IS NULL
          AND LOWER(SUBSTRING_INDEX(r.archivo, '/', -1)) = ?
        GROUP BY r.archivo
        LIMIT 1
      `;

      const result = await prisma.$queryRawUnsafe<{ url: string; nombre: string; uso_count: bigint }[]>(
        query,
        parseInt(id),
        nombreNormalizado
      );

      const existe = result.length > 0;

      res.json({
        success: true,
        data: {
          existe,
          nombre: existe ? result[0].nombre : nombreArchivo,
          usos: existe ? Number(result[0].uso_count) : 0,
          url: existe ? result[0].url : null,
        },
      });
    } catch (error) {
      console.error('Error en verificarArteExistente:', error);
      const message = error instanceof Error ? error.message : 'Error al verificar arte';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Obtener artes existentes usados en la campaña
   * Retorna URLs únicas de archivos de arte ya asignados
   */
  async getArtesExistentes(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const query = `
        SELECT DISTINCT
          r.archivo as url,
          SUBSTRING_INDEX(r.archivo, '/', -1) as nombre,
          COUNT(*) as uso_count
        FROM reservas r
        JOIN solicitudCaras sc ON r.solicitudCaras_id = sc.id
        JOIN cotizacion ct ON sc.idquote = ct.id_propuesta
        JOIN campania cm ON cm.cotizacion_id = ct.id
        WHERE cm.id = ?
          AND r.archivo IS NOT NULL
          AND r.archivo != ''
          AND r.deleted_at IS NULL
        GROUP BY r.archivo
        ORDER BY uso_count DESC
      `;

      const artes = await prisma.$queryRawUnsafe<{ url: string; nombre: string; uso_count: bigint }[]>(query, parseInt(id));

      const result = artes.map((arte, index) => ({
        id: `arte-${index + 1}`,
        nombre: arte.nombre || `Arte ${index + 1}`,
        url: arte.url,
        usos: Number(arte.uso_count),
      }));

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('Error en getArtesExistentes:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener artes existentes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

// Obtener lista de usuarios para asignación
  async getUsuarios(req: AuthRequest, res: Response): Promise<void> {
    try {
      const usuarios = await prisma.$queryRaw<{ id: number; nombre: string }[]>`
        SELECT id, nombre
        FROM usuario
        WHERE deleted_at IS NULL
        ORDER BY nombre ASC
      `;

      res.json({
        success: true,
        data: usuarios,
      });
    } catch (error) {
      console.error('Error en getUsuarios:', error);
      res.status(500).json({
        success: false,
        error: 'Error al obtener usuarios',
      });
    }
  }

  // ============================================================================
  // ENDPOINTS PARA ÓRDENES DE MONTAJE
  // ============================================================================

  /**
   * Obtener datos para Orden de Montaje CAT - Ocupación
   * Agrupa por campaña, artículo y tipo (RENTA/BONIFICACIÓN)
   */
  async getOrdenMontajeCAT(req: AuthRequest, res: Response): Promise<void> {
    try {
      const status = req.query.status as string;
      const catorcenaInicio = req.query.catorcenaInicio ? parseInt(req.query.catorcenaInicio as string) : undefined;
      const catorcenaFin = req.query.catorcenaFin ? parseInt(req.query.catorcenaFin as string) : undefined;
      const yearInicio = req.query.yearInicio ? parseInt(req.query.yearInicio as string) : undefined;
      const yearFin = req.query.yearFin ? parseInt(req.query.yearFin as string) : undefined;

      let statusFilter = '';
      const params: (string | number)[] = [];

      if (status) {
        statusFilter = 'AND cm.status = ?';
        params.push(status);
      }

      let dateFilter = '';
      if (yearInicio && catorcenaInicio && yearFin && catorcenaFin) {
        dateFilter = `
          AND sc.inicio_periodo >= (SELECT fecha_inicio FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1)
          AND sc.fin_periodo <= (SELECT fecha_fin FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1)
        `;
        params.push(yearInicio, catorcenaInicio, yearFin, catorcenaFin);
      }

      const query = `
        -- FILA PARA BONIFICACIONES
        SELECT
          MIN(inv.municipio) AS plaza,
          sc.formato AS tipo,
          pr.asignado AS asesor,
          ROUND(AVG(rsv.APS), 0) AS aps_especifico,
          sc.inicio_periodo AS fecha_inicio_periodo,
          sc.fin_periodo AS fecha_fin_periodo,
          (SELECT numero_catorcena FROM catorcenas WHERE sc.inicio_periodo BETWEEN fecha_inicio AND fecha_fin LIMIT 1) AS catorcena_numero,
          (SELECT año FROM catorcenas WHERE sc.inicio_periodo BETWEEN fecha_inicio AND fecha_fin LIMIT 1) AS catorcena_year,
          cliente.T1_U_Cliente AS cliente,
          cliente.T2_U_Marca AS marca,
          sol.unidad_negocio AS unidad_negocio,
          cm.nombre AS campania,
          sc.articulo AS numero_articulo,
          'BONIFICACION' AS negociacion,
          sc.bonificacion AS caras,
          0 AS tarifa,
          0 AS monto_total,
          cm.id AS campania_id,
          sc.id AS grupo_id,
          'bonificacion' AS tipo_fila
        FROM campania cm
          INNER JOIN cliente ON cliente.id = cm.cliente_id
          INNER JOIN cotizacion ct ON ct.id = cm.cotizacion_id
          INNER JOIN propuesta pr ON pr.id = ct.id_propuesta
          INNER JOIN solicitud sol ON sol.id = pr.solicitud_id
          INNER JOIN solicitudCaras sc ON sc.idquote = ct.id_propuesta
          INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id
          INNER JOIN espacio_inventario esInv ON esInv.id = rsv.inventario_id
          INNER JOIN inventarios inv ON inv.id = esInv.inventario_id
        WHERE rsv.deleted_at IS NULL
          AND rsv.estatus <> 'eliminada'
          AND rsv.estatus <> 'vendido'
          AND sc.bonificacion > 0
          ${statusFilter}
          ${dateFilter}
        GROUP BY cm.id, cliente.T1_U_Cliente, cliente.T2_U_Marca, sol.unidad_negocio, cm.nombre,
                 sc.id, sc.formato, sc.articulo, sc.bonificacion, sc.inicio_periodo, sc.fin_periodo,
                 pr.asignado

        UNION ALL

        -- FILA PARA RENTA
        SELECT
          MIN(inv.municipio) AS plaza,
          sc.formato AS tipo,
          pr.asignado AS asesor,
          ROUND(AVG(rsv.APS), 0) AS aps_especifico,
          sc.inicio_periodo AS fecha_inicio_periodo,
          sc.fin_periodo AS fecha_fin_periodo,
          (SELECT numero_catorcena FROM catorcenas WHERE sc.inicio_periodo BETWEEN fecha_inicio AND fecha_fin LIMIT 1) AS catorcena_numero,
          (SELECT año FROM catorcenas WHERE sc.inicio_periodo BETWEEN fecha_inicio AND fecha_fin LIMIT 1) AS catorcena_year,
          cliente.T1_U_Cliente AS cliente,
          cliente.T2_U_Marca AS marca,
          sol.unidad_negocio AS unidad_negocio,
          cm.nombre AS campania,
          sc.articulo AS numero_articulo,
          'RENTA' AS negociacion,
          (sc.caras - sc.bonificacion) AS caras,
          ROUND(AVG(sc.tarifa_publica), 2) AS tarifa,
          ROUND((sc.caras - sc.bonificacion) * AVG(sc.tarifa_publica) * (1 - COALESCE(ct.descuento, 0)), 2) AS monto_total,
          cm.id AS campania_id,
          sc.id AS grupo_id,
          'renta' AS tipo_fila
        FROM campania cm
          INNER JOIN cliente ON cliente.id = cm.cliente_id
          INNER JOIN cotizacion ct ON ct.id = cm.cotizacion_id
          INNER JOIN propuesta pr ON pr.id = ct.id_propuesta
          INNER JOIN solicitud sol ON sol.id = pr.solicitud_id
          INNER JOIN solicitudCaras sc ON sc.idquote = ct.id_propuesta
          INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id
          INNER JOIN espacio_inventario esInv ON esInv.id = rsv.inventario_id
          INNER JOIN inventarios inv ON inv.id = esInv.inventario_id
        WHERE rsv.deleted_at IS NULL
          AND rsv.estatus <> 'eliminada'
          AND rsv.estatus <> 'vendido'
          AND (sc.caras - sc.bonificacion) > 0
          ${statusFilter}
          ${dateFilter}
        GROUP BY cm.id, cliente.T1_U_Cliente, cliente.T2_U_Marca, sol.unidad_negocio, cm.nombre,
                 sc.id, sc.formato, sc.articulo, sc.caras, sc.bonificacion, sc.inicio_periodo, sc.fin_periodo,
                 pr.asignado, ct.descuento

        ORDER BY campania_id, grupo_id, tipo_fila
      `;

      const data = await prisma.$queryRawUnsafe(query, ...params, ...params);

      const dataSerializable = JSON.parse(JSON.stringify(data, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: dataSerializable,
      });
    } catch (error) {
      console.error('Error en getOrdenMontajeCAT:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener orden de montaje CAT';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Obtener datos para Orden de Montaje INVIAN QEB
   * Formato específico para exportación a sistema INVIAN
   */
  async getOrdenMontajeINVIAN(req: AuthRequest, res: Response): Promise<void> {
    try {
      const status = req.query.status as string;
      const catorcenaInicio = req.query.catorcenaInicio ? parseInt(req.query.catorcenaInicio as string) : undefined;
      const catorcenaFin = req.query.catorcenaFin ? parseInt(req.query.catorcenaFin as string) : undefined;
      const yearInicio = req.query.yearInicio ? parseInt(req.query.yearInicio as string) : undefined;
      const yearFin = req.query.yearFin ? parseInt(req.query.yearFin as string) : undefined;

      let statusFilter = '';
      const params: (string | number)[] = [];

      if (status) {
        statusFilter = 'AND cm.status = ?';
        params.push(status);
      }

      let dateFilter = '';
      if (yearInicio && catorcenaInicio && yearFin && catorcenaFin) {
        dateFilter = `
          AND sc.inicio_periodo >= (SELECT fecha_inicio FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1)
          AND sc.fin_periodo <= (SELECT fecha_fin FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1)
        `;
        params.push(yearInicio, catorcenaInicio, yearFin, catorcenaFin);
      }

      const query = `
        SELECT
          cm.nombre AS Campania,
          cliente.T1_U_Cliente AS Anunciante,
          CASE
            WHEN rsv.estatus = 'Vendido bonificado' OR rsv.estatus = 'Bonificado' THEN 'BONIFICACION'
            ELSE 'RENTA'
          END AS Operacion,
          cm.id AS CodigoContrato,
          CASE
            WHEN rsv.estatus = 'Vendido bonificado' OR rsv.estatus = 'Bonificado' THEN 0
            ELSE ROUND(sc.tarifa_publica * (1 - COALESCE(ct.descuento, 0)), 2)
          END AS PrecioPorCara,
          pr.asignado AS Vendedor,
          NULL AS Descripcion,
          CONCAT('Catorcenas ', YEAR(sc.inicio_periodo)) AS InicioPeriodo,
          CONCAT('Catorcena #', LPAD(
            FLOOR((DAYOFYEAR(sc.inicio_periodo) - 1) / 14) + 1,
            2, '0'
          )) AS FinSegmento,
          cliente.T2_U_Marca AS Arte,
          rsv.id AS CodigoArte,
          rsv.archivo AS ArteUrl,
          NULL AS OrigenArte,
          inv.codigo_unico AS Unidad,
          inv.tipo_de_cara AS Cara,
          inv.municipio AS Ciudad,
          CASE
            WHEN rsv.estatus = 'Vendido bonificado' OR rsv.estatus = 'Bonificado' THEN 'BONIFICACION'
            ELSE 'RENTA'
          END AS TipoDistribucion,
          NULL AS Reproducciones,
          sc.inicio_periodo AS fecha_inicio,
          sc.fin_periodo AS fecha_fin,
          cm.status AS status_campania,
          (SELECT numero_catorcena FROM catorcenas WHERE sc.inicio_periodo BETWEEN fecha_inicio AND fecha_fin LIMIT 1) AS catorcena_numero,
          (SELECT año FROM catorcenas WHERE sc.inicio_periodo BETWEEN fecha_inicio AND fecha_fin LIMIT 1) AS catorcena_year
        FROM reservas rsv
          INNER JOIN espacio_inventario esInv ON esInv.id = rsv.inventario_id
          INNER JOIN inventarios inv ON inv.id = esInv.inventario_id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN propuesta pr ON pr.id = sc.idquote
          INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          INNER JOIN cliente ON cliente.id = cm.cliente_id
        WHERE rsv.deleted_at IS NULL
          AND rsv.estatus NOT IN ('eliminada')
          ${statusFilter}
          ${dateFilter}
        ORDER BY cm.id, sc.id, inv.id
      `;

      const data = await prisma.$queryRawUnsafe(query, ...params);

      const dataSerializable = JSON.parse(JSON.stringify(data, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: dataSerializable,
      });
    } catch (error) {
      console.error('Error en getOrdenMontajeINVIAN:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener orden de montaje INVIAN';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Obtener comentarios de revisión de artes por tarea (incluye comentarios de tareas relacionadas)
  async getComentariosRevisionArte(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { tareaId } = req.params;
      const tareaIdInt = parseInt(tareaId);

      // Obtener la tarea actual para saber sus ids_reservas
      const [tareaActual] = await prisma.$queryRaw<{ ids_reservas: string | null; campania_id: number }[]>`
        SELECT ids_reservas, campania_id FROM tareas WHERE id = ${tareaIdInt}
      `;

      if (!tareaActual || !tareaActual.ids_reservas) {
        // Si no tiene ids_reservas, solo buscar comentarios de esta tarea
        const comentarios = await prisma.$queryRaw`
          SELECT id, tarea_id, autor_id, autor_nombre, contenido, fecha
          FROM comentarios_revision_artes
          WHERE tarea_id = ${tareaIdInt}
          ORDER BY fecha ASC
        `;
        res.json({ success: true, data: comentarios });
        return;
      }

      // Parsear los ids de reservas (pueden estar separados por coma o asterisco)
      const reservaIds = tareaActual.ids_reservas
        .replace(/\*/g, ',')
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));

      if (reservaIds.length === 0) {
        const comentarios = await prisma.$queryRaw`
          SELECT id, tarea_id, autor_id, autor_nombre, contenido, fecha
          FROM comentarios_revision_artes
          WHERE tarea_id = ${tareaIdInt}
          ORDER BY fecha ASC
        `;
        res.json({ success: true, data: comentarios });
        return;
      }

      // Buscar todas las tareas de la misma campaña con ids_reservas coincidentes
      const tareasRelacionadas = await prisma.$queryRaw<{ id: number; ids_reservas: string }[]>`
        SELECT id, ids_reservas FROM tareas
        WHERE campania_id = ${tareaActual.campania_id}
        AND ids_reservas IS NOT NULL
        AND ids_reservas != ''
      `;

      // Filtrar tareas que compartan al menos una reserva
      const tareasIds = tareasRelacionadas
        .filter(t => {
          const tReservaIds = t.ids_reservas
            .replace(/\*/g, ',')
            .split(',')
            .map(id => parseInt(id.trim()))
            .filter(id => !isNaN(id));
          // Verificar si hay intersección
          return tReservaIds.some(id => reservaIds.includes(id));
        })
        .map(t => t.id);

      // Si no hay tareas relacionadas, incluir al menos la actual
      if (!tareasIds.includes(tareaIdInt)) {
        tareasIds.push(tareaIdInt);
      }

      // Obtener comentarios de todas las tareas relacionadas
      const placeholders = tareasIds.map(() => '?').join(',');
      const comentarios = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, tarea_id, autor_id, autor_nombre, contenido, fecha
        FROM comentarios_revision_artes
        WHERE tarea_id IN (${placeholders})
        ORDER BY fecha ASC
      `, ...tareasIds);

      res.json({
        success: true,
        data: comentarios,
      });
    } catch (error) {
      console.error('Error en getComentariosRevisionArte:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener comentarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Agregar comentario de revisión de artes
  async addComentarioRevisionArte(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { tareaId } = req.params;
      const { contenido } = req.body;
      const userId = req.user?.userId || 0;

      if (!contenido || !contenido.trim()) {
        res.status(400).json({
          success: false,
          error: 'El contenido del comentario es requerido',
        });
        return;
      }

      // Obtener el nombre del usuario desde la base de datos
      const [userData] = await prisma.$queryRaw<{ nombre: string }[]>`
        SELECT nombre FROM usuario WHERE id = ${userId}
      `;
      const userName = userData?.nombre || 'Usuario';

      await prisma.$executeRaw`
        INSERT INTO comentarios_revision_artes (tarea_id, autor_id, autor_nombre, contenido, fecha)
        VALUES (${parseInt(tareaId)}, ${userId}, ${userName}, ${contenido.trim()}, NOW())
      `;

      // Obtener el comentario recién insertado
      const [comentario] = await prisma.$queryRaw<any[]>`
        SELECT id, tarea_id, autor_id, autor_nombre, contenido, fecha
        FROM comentarios_revision_artes
        WHERE tarea_id = ${parseInt(tareaId)}
        ORDER BY id DESC
        LIMIT 1
      `;

      res.json({
        success: true,
        data: comentario,
      });
    } catch (error) {
      console.error('Error en addComentarioRevisionArte:', error);
      const message = error instanceof Error ? error.message : 'Error al agregar comentario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Eliminar comentario de revisión de artes (solo el autor puede eliminar)
  async deleteComentarioRevisionArte(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { comentarioId } = req.params;
      const userId = req.user?.userId || 0;

      // Verificar que el comentario existe y pertenece al usuario
      const [comentario] = await prisma.$queryRaw<{ id: number; autor_id: number }[]>`
        SELECT id, autor_id FROM comentarios_revision_artes WHERE id = ${parseInt(comentarioId)}
      `;

      if (!comentario) {
        res.status(404).json({
          success: false,
          error: 'Comentario no encontrado',
        });
        return;
      }

      if (comentario.autor_id !== userId) {
        res.status(403).json({
          success: false,
          error: 'No tienes permiso para eliminar este comentario',
        });
        return;
      }

      await prisma.$executeRaw`
        DELETE FROM comentarios_revision_artes WHERE id = ${parseInt(comentarioId)}
      `;

      res.json({
        success: true,
        message: 'Comentario eliminado',
      });
    } catch (error) {
      console.error('Error en deleteComentarioRevisionArte:', error);
      const message = error instanceof Error ? error.message : 'Error al eliminar comentario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // ============================================================================
  // MÉTODOS PARA GESTIÓN DE RESERVAS (copiados de propuestas y adaptados)
  // ============================================================================

  async getReservasForModal(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      // Obtener la campaña para conseguir el cotizacion_id
      const campana = await prisma.campania.findFirst({
        where: { id: campanaId },
        select: { cotizacion_id: true }
      });

      if (!campana || !campana.cotizacion_id) {
        res.json({ success: true, data: [] });
        return;
      }

      // Obtener la propuesta asociada a la cotización
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id: campana.cotizacion_id },
        select: { id_propuesta: true }
      });

      if (!cotizacion || !cotizacion.id_propuesta) {
        res.json({ success: true, data: [] });
        return;
      }

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
          rsv.estatus,
          rsv.grupo_completo_id,
          sc.id as solicitud_cara_id,
          rsv.APS as aps
        FROM reservas rsv
          INNER JOIN espacio_inventario epIn ON rsv.inventario_id = epIn.id
          INNER JOIN inventarios i ON epIn.inventario_id = i.id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
        WHERE sc.idquote = ?
          AND rsv.deleted_at IS NULL
        ORDER BY rsv.id DESC
      `;

      const reservas = await prisma.$queryRawUnsafe(query, String(cotizacion.id_propuesta));

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

  async createReservas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);
      const { reservas, solicitudCaraId, clienteId, fechaInicio, fechaFin, agruparComoCompleto = true } = req.body;

      if (!reservas || !Array.isArray(reservas) || reservas.length === 0) {
        res.status(400).json({ success: false, error: 'No hay reservas para guardar' });
        return;
      }

      // Verificar que la campaña existe
      const campana = await prisma.campania.findFirst({
        where: { id: campanaId },
        select: { cotizacion_id: true }
      });

      if (!campana) {
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      // Check for pending authorizations - block AP assignment if there are pending caras
      if (campana.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({
          where: { id: campana.cotizacion_id },
          select: { id_propuesta: true }
        });
        if (cotizacion?.id_propuesta) {
          const autorizacion = await verificarCarasPendientes(cotizacion.id_propuesta.toString());
          if (autorizacion.tienePendientes) {
            const totalPendientes = autorizacion.pendientesDg.length + autorizacion.pendientesDcm.length;
            res.status(400).json({
              success: false,
              error: `No se pueden asignar APs. ${totalPendientes} cara(s) están pendientes de autorización.`,
              autorizacion: {
                pendientesDg: autorizacion.pendientesDg.length,
                pendientesDcm: autorizacion.pendientesDcm.length
              }
            });
            return;
          }
        }
      }

      // Crear calendario entry
      const calendario = await prisma.calendario.create({
        data: {
          fecha_inicio: new Date(fechaInicio),
          fecha_fin: new Date(fechaFin),
        },
      });

      let reservasCreadas = 0;
      let currentGroupId: number | null = null;

      // Procesar reservas
      for (const reserva of reservas) {
        // Buscar espacio_inventario
        const espacioInventario = await prisma.espacio_inventario.findFirst({
          where: { inventario_id: reserva.inventario_id },
        });

        if (!espacioInventario) {
          console.warn(`No se encontró espacio_inventario para inventario_id: ${reserva.inventario_id}`);
          continue;
        }

        // Determinar si necesita grupo completo
        let grupoCompletoId: number | null = null;
        if (agruparComoCompleto && reserva.tipo !== 'Bonificacion') {
          if (!currentGroupId) {
            // Crear nuevo grupo
            const maxGroup = await prisma.reservas.aggregate({
              _max: { grupo_completo_id: true }
            });
            currentGroupId = (maxGroup._max.grupo_completo_id || 0) + 1;
          }
          grupoCompletoId = currentGroupId;
        }

        // Crear la reserva
        await prisma.reservas.create({
          data: {
            solicitudCaras_id: solicitudCaraId,
            inventario_id: espacioInventario.id,
            calendario_id: calendario.id,
            cliente_id: clienteId || 0,
            estatus: reserva.tipo === 'Bonificacion' ? 'Bonificado' : 'Apartado',
            arte_aprobado: '',
            comentario_rechazo: '',
            estatus_original: '',
            fecha_testigo: new Date(),
            imagen_testigo: '',
            instalado: false,
            tarea: '',
            grupo_completo_id: grupoCompletoId,
          },
        });
        reservasCreadas++;
      }

      res.json({
        success: true,
        data: {
          calendarioId: calendario.id,
          reservasCreadas,
        },
      });
    } catch (error) {
      console.error('Error en createReservas:', error);
      const message = error instanceof Error ? error.message : 'Error al crear reservas';
      res.status(500).json({ success: false, error: message });
    }
  }

  async deleteReservas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { reservaIds } = req.body;

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({ success: false, error: 'No hay reservas para eliminar' });
        return;
      }

      // Soft delete reservas
      await prisma.reservas.updateMany({
        where: { id: { in: reservaIds } },
        data: { deleted_at: new Date() },
      });

      res.json({
        success: true,
        message: `${reservaIds.length} reserva(s) eliminada(s)`,
      });
    } catch (error) {
      console.error('Error en deleteReservas:', error);
      const message = error instanceof Error ? error.message : 'Error al eliminar reservas';
      res.status(500).json({ success: false, error: message });
    }
  }

  // ============================================================================
  // MÉTODOS PARA GESTIÓN DE CARAS
  // ============================================================================

  async updateCara(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { caraId } = req.params;
      const data = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

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
        ciudad: data.ciudad || undefined,
        formato: data.formato || '',
        tipo: data.tipo || undefined,
        caras: data.caras ? parseInt(data.caras) : 0,
        bonificacion: data.bonificacion ? parseFloat(data.bonificacion) : 0,
        costo: data.costo ? parseInt(data.costo) : 0,
        tarifa_publica: data.tarifa_publica ? parseInt(data.tarifa_publica) : 0
      });

      const updateData: any = {
        ciudad: data.ciudad,
        estados: data.estados,
        tipo: data.tipo,
        flujo: data.flujo,
        bonificacion: data.bonificacion,
        caras: data.caras,
        nivel_socioeconomico: data.nivel_socioeconomico,
        formato: data.formato,
        costo: data.costo,
        tarifa_publica: data.tarifa_publica,
        caras_flujo: data.caras_flujo,
        caras_contraflujo: data.caras_contraflujo,
        articulo: data.articulo,
        descuento: data.descuento,
        estado_autorizacion: estadoResult.estado,
      };
      if (data.inicio_periodo) updateData.inicio_periodo = new Date(data.inicio_periodo);
      if (data.fin_periodo) updateData.fin_periodo = new Date(data.fin_periodo);

      const cara = await prisma.solicitudCaras.update({
        where: { id: parseInt(caraId) },
        data: updateData,
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
        data: cara,
        message: mensaje,
        autorizacion: {
          tienePendientes: autorizacion.tienePendientes,
          pendientesDg: autorizacion.pendientesDg.length,
          pendientesDcm: autorizacion.pendientesDcm.length
        }
      });
    } catch (error) {
      console.error('Error en updateCara:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar cara';
      res.status(500).json({ success: false, error: message });
    }
  }

  async createCara(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);
      const data = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      // Obtener la campaña para conseguir el cotizacion_id/propuesta_id
      const campana = await prisma.campania.findFirst({
        where: { id: campanaId },
        select: { cotizacion_id: true }
      });

      if (!campana || !campana.cotizacion_id) {
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      // Obtener la propuesta asociada
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id: campana.cotizacion_id },
        select: { id_propuesta: true }
      });

      if (!cotizacion || !cotizacion.id_propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada para esta campaña' });
        return;
      }

      // Get solicitud_id for task creation
      const propuesta = await prisma.propuesta.findUnique({
        where: { id: cotizacion.id_propuesta },
        select: { solicitud_id: true }
      });

      // Calculate authorization state
      const estadoResult = await calcularEstadoAutorizacion({
        ciudad: data.ciudad,
        formato: data.formato || '',
        tipo: data.tipo,
        caras: data.caras ? parseInt(data.caras) : 0,
        bonificacion: data.bonificacion ? parseFloat(data.bonificacion) : 0,
        costo: data.costo ? parseInt(data.costo) : 0,
        tarifa_publica: data.tarifa_publica ? parseInt(data.tarifa_publica) : 0
      });

      const createData: any = {
        idquote: String(cotizacion.id_propuesta),
        ciudad: data.ciudad,
        estados: data.estados,
        tipo: data.tipo,
        flujo: data.flujo,
        bonificacion: data.bonificacion,
        caras: data.caras,
        nivel_socioeconomico: data.nivel_socioeconomico,
        formato: data.formato,
        costo: data.costo,
        tarifa_publica: data.tarifa_publica,
        caras_flujo: data.caras_flujo,
        caras_contraflujo: data.caras_contraflujo,
        articulo: data.articulo,
        descuento: data.descuento,
        estado_autorizacion: estadoResult.estado,
      };
      if (data.inicio_periodo) createData.inicio_periodo = new Date(data.inicio_periodo);
      if (data.fin_periodo) createData.fin_periodo = new Date(data.fin_periodo);

      const cara = await prisma.solicitudCaras.create({
        data: createData,
      });

      // Check for pending authorizations and create tasks if needed
      const autorizacion = await verificarCarasPendientes(cotizacion.id_propuesta.toString());
      if (autorizacion.tienePendientes && userId && propuesta?.solicitud_id) {
        await crearTareasAutorizacion(
          propuesta.solicitud_id,
          cotizacion.id_propuesta,
          userId,
          userName,
          autorizacion.pendientesDg,
          autorizacion.pendientesDcm
        );
      }

      // Build response message
      let mensaje = 'Cara creada exitosamente';
      if (autorizacion.tienePendientes) {
        const totalPendientes = autorizacion.pendientesDg.length + autorizacion.pendientesDcm.length;
        mensaje = `Cara creada. ${totalPendientes} cara(s) requieren autorización.`;
      }

      res.json({
        success: true,
        data: cara,
        message: mensaje,
        autorizacion: {
          tienePendientes: autorizacion.tienePendientes,
          pendientesDg: autorizacion.pendientesDg.length,
          pendientesDcm: autorizacion.pendientesDcm.length
        }
      });
    } catch (error) {
      console.error('Error en createCara:', error);
      const message = error instanceof Error ? error.message : 'Error al crear cara';
      res.status(500).json({ success: false, error: message });
    }
  }

  async deleteCara(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { caraId } = req.params;

      // Verificar que no tenga reservas
      const reservas = await prisma.reservas.count({
        where: {
          solicitudCaras_id: parseInt(caraId),
          deleted_at: null,
        },
      });

      if (reservas > 0) {
        res.status(400).json({
          success: false,
          error: 'No se puede eliminar una cara que tiene reservas asociadas',
        });
        return;
      }

      await prisma.solicitudCaras.delete({
        where: { id: parseInt(caraId) },
      });

      res.json({ success: true, message: 'Cara eliminada' });
    } catch (error) {
      console.error('Error en deleteCara:', error);
      const message = error instanceof Error ? error.message : 'Error al eliminar cara';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const campanasController = new CampanasController();
// force restart
