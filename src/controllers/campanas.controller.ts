import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

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
      const conditions: string[] = ['cm.id IS NOT NULL'];
      const params: (string | number)[] = [];

      if (status) {
        conditions.push('cm.status = ?');
        params.push(status);
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
      let comentarios: { id: number; autor_id: number; autor_nombre: string; contenido: string; fecha: Date; solicitud_id: number }[] = [];
      const solicitudId = propuesta?.solicitud_id;

      const whereComentarios = solicitudId
        ? { solicitud_id: solicitudId }
        : { campania_id: campana.id };

      const rawComentarios = await prisma.comentarios.findMany({
        where: whereComentarios,
        orderBy: { creado_en: 'desc' },
      });

      // Obtener los nombres de los autores
      const autorIds = [...new Set(rawComentarios.map(c => c.autor_id))];
      const autores = await prisma.usuario.findMany({
        where: { id: { in: autorIds } },
        select: { id: true, nombre: true },
      });
      const autoresMap = new Map(autores.map(a => [a.id, a.nombre]));

      comentarios = rawComentarios.map(c => ({
        id: c.id,
        autor_id: c.autor_id,
        autor_nombre: autoresMap.get(c.autor_id) || 'Usuario',
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

      const campana = await prisma.campania.update({
        where: { id: parseInt(id) },
        data: { status },
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

  async getInventarioReservado(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      console.log('Fetching inventario for campana:', campanaId);

      const query = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          MIN(i.id) as id,

          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN CONCAT(
              SUBSTRING_INDEX(MIN(i.codigo_unico), '_', 1),
              '_completo_',
              SUBSTRING_INDEX(MIN(i.codigo_unico), '_', -1)
            )
            ELSE MIN(i.codigo_unico)
          END as codigo_unico,

          MAX(sc.id) AS solicitud_caras_id,
          MIN(i.mueble) as mueble,
          MIN(i.estado) as estado,

          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN 'Completo'
            ELSE MIN(i.tipo_de_cara)
          END as tipo_de_cara,

          COUNT(DISTINCT rsv.id) AS caras_totales,

          MIN(i.latitud) as latitud,
          MIN(i.longitud) as longitud,
          MIN(i.plaza) as plaza,
          MAX(rsv.estatus) as estatus_reserva,
          MAX(sc.articulo) as articulo,
          MAX(sc.tipo) as tipo_medio,
          MAX(sc.inicio_periodo) as inicio_periodo,
          MAX(sc.fin_periodo) as fin_periodo,
          MIN(i.tradicional_digital) as tradicional_digital,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id

        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
        WHERE
          cm.id = ?
          AND (rsv.APS IS NULL OR rsv.APS = 0)
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id)
        ORDER BY MIN(rsv.id) DESC
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
        },
      });

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
      const { reservaIds } = req.body;

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

  async assignAPS(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { inventarioIds } = req.body;

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
}

export const campanasController = new CampanasController();
