import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class CampanasController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;

      const where: Record<string, unknown> = {};

      if (status) {
        where.status = status;
      }

      const [campanas, total] = await Promise.all([
        prisma.campania.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { fecha_inicio: 'desc' },
        }),
        prisma.campania.count({ where }),
      ]);

      res.json({
        success: true,
        data: campanas,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
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
        // Info del cliente
        T0_U_Asesor: cliente?.T0_U_Asesor || null,
        T0_U_IDAsesor: cliente?.T0_U_IDAsesor || null,
        T0_U_IDAgencia: cliente?.T0_U_IDAgencia || null,
        T0_U_Agencia: cliente?.T0_U_Agencia || null,
        T0_U_Cliente: cliente?.T0_U_Cliente || null,
        T0_U_RazonSocial: cliente?.T0_U_RazonSocial || null,
        T0_U_IDACA: cliente?.T0_U_IDACA || null,
        cuic: cliente?.CUIC || null,
        T1_U_Cliente: cliente?.T1_U_Cliente || null,
        T1_U_IDACA: cliente?.T1_U_IDACA || null,
        T1_U_IDCM: cliente?.T1_U_IDCM || null,
        T1_U_IDMarca: cliente?.T1_U_IDMarca || null,
        T1_U_UnidadNegocio: cliente?.T1_U_UnidadNegocio || null,
        T1_U_ValidFrom: cliente?.T1_U_ValidFrom || null,
        T1_U_ValidTo: cliente?.T1_U_ValidTo || null,
        T2_U_IDCategoria: cliente?.T2_U_IDCategoria || null,
        T2_U_Categoria: cliente?.T2_U_Categoria || null,
        T2_U_IDCM: cliente?.T2_U_IDCM || null,
        T2_U_IDProducto: cliente?.T2_U_IDProducto || null,
        T2_U_Marca: cliente?.T2_U_Marca || null,
        T2_U_Producto: cliente?.T2_U_Producto || null,
        T2_U_ValidFrom: cliente?.T2_U_ValidFrom || null,
        T2_U_ValidTo: cliente?.T2_U_ValidTo || null,
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

      res.json({
        success: true,
        data: campanaCompleta,
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
          rsv.archivo,
          rsv.estatus as estatus_reserva,
          rsv.calendario_id,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          epIn.numero_espacio as espacios,
          sc.id AS solicitud_caras_id,
          sc.articulo,
          sc.inicio_periodo,
          sc.fin_periodo,
          1 AS caras_totales
        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
        WHERE
          cm.id = ?
          AND (rsv.APS IS NULL OR rsv.APS = 0)
        ORDER BY rsv.id DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId);

      console.log('Inventario result count:', Array.isArray(inventario) ? inventario.length : 0);

      res.json({
        success: true,
        data: inventario,
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
          rsv.archivo,
          rsv.estatus as estatus_reserva,
          rsv.calendario_id,
          rsv.APS as aps,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          epIn.numero_espacio as espacios,
          sc.id AS solicitud_caras_id,
          sc.articulo,
          sc.inicio_periodo,
          sc.fin_periodo,
          1 AS caras_totales
        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
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
