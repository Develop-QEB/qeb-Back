import { Response } from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../utils/prisma';
import { Prisma } from '@prisma/client';
import { AuthRequest } from '../types';
import nodemailer from 'nodemailer';
import {
  calcularEstadoAutorizacion,
  verificarCarasPendientes,
  crearTareasAutorizacion
} from '../services/autorizacion.service';
import { emitToCampana, emitToAll, emitToCampanas, emitToDashboard, SOCKET_EVENTS } from '../config/socket';
import { hasFullVisibility, hasTeamVisibility, getTeamMemberIds } from '../utils/permissions';
import { uploadToCloudinary } from '../config/cloudinary';
import { serializeBigInt } from '../utils/serialization';

// Select seguro para campania - excluye posted_aps que puede no existir en producción
const CAMPANIA_SAFE_SELECT = {
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
} as const;

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

const isPublicFileUrl = (value: string): boolean =>
  value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/uploads/');

const ensureStoredFileUrl = async (
  rawValue: string,
  folder: string,
  resourceType: 'image' | 'video' | 'auto' = 'auto'
): Promise<string> => {
  const value = rawValue.trim();
  if (!value) {
    throw new Error('Archivo vacio');
  }
  if (isPublicFileUrl(value)) {
    return value;
  }

  const uploaded = await uploadToCloudinary(value, folder, resourceType);
  if (!uploaded?.secure_url) {
    throw new Error('No se pudo subir el archivo a Spaces');
  }
  return uploaded.secure_url;
};

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
      const tipoPeriodo = req.query.tipoPeriodo as string;

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

      if (tipoPeriodo && tipoPeriodo !== 'todas') {
        conditions.push("COALESCE(ct.tipo_periodo, 'catorcena') = ?");
        params.push(tipoPeriodo);
      }

      if (search) {
        conditions.push('(CAST(cm.id AS CHAR) LIKE ? OR cm.nombre LIKE ? OR cl.T2_U_Marca LIKE ? OR cl.T0_U_Cliente LIKE ? OR cl.T0_U_RazonSocial LIKE ? OR cl.CUIC LIKE ? OR pr.asignado LIKE ? OR s.nombre_usuario LIKE ?)');
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
      }

      // Year/catorcena filters - overlap logic (campaign active during selected period)
      if (yearInicio && yearFin) {
        if (catorcenaInicio && catorcenaFin) {
          conditions.push(`
            cm.fecha_inicio <= (
              SELECT fecha_fin FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1
            )
            AND cm.fecha_fin >= (
              SELECT fecha_inicio FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1
            )
          `);
          params.push(yearFin, catorcenaFin, yearInicio, catorcenaInicio);
        } else {
          conditions.push('YEAR(cm.fecha_inicio) <= ? AND YEAR(cm.fecha_fin) >= ?');
          params.push(yearFin, yearInicio);
        }
      }

      // Visibility filter: non-leadership roles only see campañas where they have tareas
      const userId = req.user?.userId;
      const userRol = req.user?.rol || '';
      if (userId && !hasFullVisibility(userRol)) {
        if (hasTeamVisibility(userRol)) {
          const teamIds = await getTeamMemberIds(prisma, userId);
          const placeholders = teamIds.map(() => '?').join(',');
          conditions.push(`EXISTS (
            SELECT 1 FROM tareas t
            WHERE t.campania_id = cm.id
              AND (t.id_responsable IN (${placeholders}) OR FIND_IN_SET(?, REPLACE(IFNULL(t.id_asignado, ''), ' ', '')) > 0)
          )`);
          params.push(...teamIds, String(userId));
        } else {
          conditions.push(`EXISTS (
            SELECT 1 FROM tareas t
            WHERE t.campania_id = cm.id
              AND (t.id_responsable = ? OR FIND_IN_SET(?, REPLACE(IFNULL(t.id_asignado, ''), ' ', '')) > 0)
          )`);
          params.push(userId, String(userId));
        }
      }

      const whereClause = conditions.join(' AND ');

      // Query with LEFT JOINs — subqueries pre-aggregated for performance
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
          s.sap_database as sap_database,
          s.card_code as card_code,
          s.salesperson_code as salesperson_code,
          cat_ini.numero_catorcena as catorcena_inicio_num,
          cat_ini.año as catorcena_inicio_anio,
          cat_fin.numero_catorcena as catorcena_fin_num,
          cat_fin.año as catorcena_fin_anio,
          ct.id_propuesta as propuesta_id,
          ct.tipo_periodo as tipo_periodo,
          pr.inversion as propuesta_inversion,
          COALESCE(rsv_agg.has_aps, 0) AS has_aps,
          COALESCE(rsv_agg.reservas_count, 0) AS reservas_count,
          COALESCE(rsv_agg.circuitos, 0) AS circuitos,
          COALESCE(uc_agg.reservas_count_ultima_cat, 0) AS reservas_count_ultima_cat,
          COALESCE(uc_agg.caras_ultima_cat, 0) AS caras_ultima_cat,
          cat_content.catorcenas_con_contenido
        FROM campania cm
        LEFT JOIN cliente cl ON cm.cliente_id = cl.id
        LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
        LEFT JOIN propuesta pr ON pr.id = ct.id_propuesta
        LEFT JOIN solicitud s ON s.id = pr.solicitud_id
        LEFT JOIN catorcenas cat_ini ON cm.fecha_inicio BETWEEN cat_ini.fecha_inicio AND cat_ini.fecha_fin
        LEFT JOIN catorcenas cat_fin ON cm.fecha_fin BETWEEN cat_fin.fecha_inicio AND cat_fin.fecha_fin
        LEFT JOIN (
          SELECT
            ct_a.id AS cotizacion_id,
            COUNT(*) AS reservas_count,
            MAX(CASE WHEN rsv_a.APS IS NOT NULL AND rsv_a.APS > 0 THEN 1 ELSE 0 END) AS has_aps,
            COUNT(DISTINCT rsv_a.solicitudCaras_id) AS circuitos
          FROM reservas rsv_a
          INNER JOIN solicitudCaras sc_a ON sc_a.id = rsv_a.solicitudCaras_id
          INNER JOIN cotizacion ct_a ON ct_a.id_propuesta = sc_a.idquote
          WHERE rsv_a.deleted_at IS NULL
          GROUP BY ct_a.id
        ) rsv_agg ON rsv_agg.cotizacion_id = ct.id
        LEFT JOIN (
          SELECT
            cm_b.id AS campania_id,
            (SELECT COUNT(*) FROM reservas rsv_b2
              INNER JOIN solicitudCaras sc_b2 ON sc_b2.id = rsv_b2.solicitudCaras_id
              INNER JOIN cotizacion ct_b2 ON ct_b2.id_propuesta = sc_b2.idquote
              INNER JOIN catorcenas cat_b2 ON sc_b2.inicio_periodo >= cat_b2.fecha_inicio AND sc_b2.fin_periodo <= cat_b2.fecha_fin
                AND cm_b.fecha_fin BETWEEN cat_b2.fecha_inicio AND cat_b2.fecha_fin
              WHERE ct_b2.id = cm_b.cotizacion_id AND rsv_b2.deleted_at IS NULL
            ) AS reservas_count_ultima_cat,
            (SELECT COALESCE(SUM(sc_b3.caras + sc_b3.bonificacion), 0) FROM solicitudCaras sc_b3
              INNER JOIN cotizacion ct_b3 ON ct_b3.id_propuesta = sc_b3.idquote
              INNER JOIN catorcenas cat_b3 ON sc_b3.inicio_periodo >= cat_b3.fecha_inicio AND sc_b3.fin_periodo <= cat_b3.fecha_fin
                AND cm_b.fecha_fin BETWEEN cat_b3.fecha_inicio AND cat_b3.fecha_fin
              WHERE ct_b3.id = cm_b.cotizacion_id
            ) AS caras_ultima_cat
          FROM campania cm_b
        ) uc_agg ON uc_agg.campania_id = cm.id
        LEFT JOIN (
          SELECT
            ct_c.id AS cotizacion_id,
            GROUP_CONCAT(DISTINCT CONCAT(cat_c.numero_catorcena, ':', cat_c.año) ORDER BY cat_c.año, cat_c.numero_catorcena SEPARATOR ',') AS catorcenas_con_contenido
          FROM solicitudCaras sc_c
          INNER JOIN cotizacion ct_c ON ct_c.id_propuesta = sc_c.idquote
          INNER JOIN catorcenas cat_c ON sc_c.inicio_periodo BETWEEN cat_c.fecha_inicio AND cat_c.fecha_fin
          GROUP BY ct_c.id
        ) cat_content ON cat_content.cotizacion_id = ct.id
        WHERE ${whereClause}
        ORDER BY COALESCE(cm.fecha_aprobacion, cm.fecha_inicio) DESC, cm.id DESC
        LIMIT ? OFFSET ?
      `;

      const countQuery = `
        SELECT COUNT(*) as total
        FROM campania cm
        LEFT JOIN cliente cl ON cm.cliente_id = cl.id
        LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
        LEFT JOIN propuesta pr ON pr.id = ct.id_propuesta
        LEFT JOIN solicitud s ON s.id = pr.solicitud_id
        WHERE ${whereClause}
      `;

      const offset = (page - 1) * limit;
      // Ejecutar ambas queries en paralelo en vez de secuencial
      const [campanas, countResult] = await Promise.all([
        prisma.$queryRawUnsafe<any[]>(query, ...params, limit, offset),
        prisma.$queryRawUnsafe<{ total: bigint }[]>(countQuery, ...params),
      ]);
      const total = Number(countResult[0]?.total || 0);

      // Remap propuesta_inversion → inversion to avoid cm.* column name collision
      // when campania table has its own inversion column (not in Prisma schema)
      campanas.forEach((campana: any) => {
        if ('propuesta_inversion' in campana) {
          campana.inversion = campana.propuesta_inversion ?? campana.inversion ?? null;
          delete campana.propuesta_inversion;
        }
      });

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
        select: CAMPANIA_SAFE_SELECT,
      });

      if (!campana) {
        res.status(404).json({
          success: false,
          error: 'Campana no encontrada',
        });
        return;
      }

      // Obtener posted_aps de forma segura (columna puede no existir en producción)
      let postedAps: string[] = [];
      try {
        const apsResult = await prisma.$queryRawUnsafe<{ posted_aps: string | null }[]>(
          `SELECT posted_aps FROM campania WHERE id = ?`, parseInt(id)
        );
        if (apsResult[0]?.posted_aps) {
          postedAps = JSON.parse(apsResult[0].posted_aps);
        }
      } catch { /* Column may not exist yet */ }

      // Obtener info del cliente - buscar por id, si no tiene datos buscar por CUIC
      let cliente = await prisma.cliente.findUnique({
        where: { id: campana.cliente_id },
      });
      // Si el cliente no tiene datos (campos NULL), intentar buscar por CUIC desde la solicitud
      if (cliente && !cliente.T0_U_RazonSocial && !cliente.T0_U_Cliente) {
        const cuic = cliente.CUIC || campana.cliente_id;
        const clientePorCuic = await prisma.cliente.findFirst({
          where: { CUIC: cuic, T0_U_RazonSocial: { not: null } },
        });
        if (clientePorCuic) cliente = clientePorCuic;
      }

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

      // Contar reservas para detectar campañas incompletas
      let reservasCount = 0;
      let reservasCountUltimaCat = 0;
      let carasUltimaCat = 0;
      if (propuesta?.solicitud_id) {
        const countResult = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
          `SELECT COUNT(*) as cnt FROM reservas r
           INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
           WHERE sc.idquote = ? AND r.deleted_at IS NULL`,
          propuesta.solicitud_id
        );
        reservasCount = Number(countResult[0]?.cnt || 0);

        // Contar solo reservas de la última catorcena
        if (campana.fecha_fin) {
          const ultCatResult = await prisma.$queryRawUnsafe<{ cnt: bigint, caras_esperadas: any }[]>(
            `SELECT
              (SELECT COUNT(*) FROM reservas r2
               INNER JOIN solicitudCaras sc2 ON sc2.id = r2.solicitudCaras_id
               INNER JOIN calendario cal2 ON cal2.id = r2.calendario_id
               INNER JOIN catorcenas cat2 ON cal2.fecha_inicio >= cat2.fecha_inicio AND cal2.fecha_fin <= cat2.fecha_fin
               WHERE sc2.idquote = ? AND r2.deleted_at IS NULL
                 AND ? BETWEEN cat2.fecha_inicio AND cat2.fecha_fin
              ) as cnt,
              (SELECT COALESCE(SUM(sc3.caras + sc3.bonificacion), 0)
               FROM solicitudCaras sc3
               INNER JOIN catorcenas cat3 ON sc3.inicio_periodo >= cat3.fecha_inicio AND sc3.fin_periodo <= cat3.fecha_fin
               WHERE sc3.idquote = ? AND ? BETWEEN cat3.fecha_inicio AND cat3.fecha_fin
              ) as caras_esperadas`,
            propuesta.solicitud_id, campana.fecha_fin,
            propuesta.solicitud_id, campana.fecha_fin
          );
          reservasCountUltimaCat = Number(ultCatResult[0]?.cnt || 0);
          carasUltimaCat = Number(ultCatResult[0]?.caras_esperadas || 0);
        }
      }

      // Desglose de completitud por catorcena - detalle por grupo (solicitudCaras)
      let incompletenessDetail: any[] = [];
      if (propuesta?.solicitud_id) {
        const detailResult = await prisma.$queryRawUnsafe<any[]>(
          `SELECT
            cat.numero_catorcena as catorcena,
            cat.año as anio,
            sc.id as sc_id,
            sc.articulo,
            sc.ciudad,
            sc.caras as caras_renta,
            sc.caras_flujo,
            sc.caras_contraflujo,
            sc.bonificacion as caras_bonif,
            (sc.caras + sc.bonificacion) as caras_esperadas,
            (SELECT COUNT(*) FROM reservas r2
             WHERE r2.solicitudCaras_id = sc.id AND r2.deleted_at IS NULL
            ) as reservas_count
          FROM solicitudCaras sc
          INNER JOIN catorcenas cat ON sc.inicio_periodo >= cat.fecha_inicio AND sc.fin_periodo <= cat.fecha_fin
          WHERE sc.idquote = ?
          ORDER BY cat.año, cat.numero_catorcena, sc.articulo`,
          propuesta.solicitud_id
        );

        // Agrupar por catorcena
        const byCat: Record<string, any> = {};
        for (const r of detailResult) {
          const key = `${r.anio}-${r.catorcena}`;
          if (!byCat[key]) {
            byCat[key] = {
              catorcena: Number(r.catorcena),
              anio: Number(r.anio),
              caras_esperadas: 0,
              reservas_count: 0,
              grupos: [],
            };
          }
          const esperadas = Number(r.caras_esperadas);
          const reservadas = Number(r.reservas_count);
          byCat[key].caras_esperadas += esperadas;
          byCat[key].reservas_count += reservadas;
          if (reservadas < esperadas) {
            byCat[key].grupos.push({
              articulo: r.articulo || 'SIN-ART',
              ciudad: r.ciudad || '',
              caras_esperadas: esperadas,
              reservas_count: reservadas,
              faltantes: esperadas - reservadas,
            });
          }
        }
        incompletenessDetail = Object.values(byCat)
          .map((c: any) => ({
            ...c,
            completa: c.reservas_count >= c.caras_esperadas,
          }))
          .filter((c: any) => c.caras_esperadas > 0);
      }

      // Combinar toda la info
      const campanaCompleta = {
        ...campana,
        // Info del cliente - priorizar datos de solicitud sobre cliente
        T0_U_Asesor: solicitud?.asesor || cliente?.T0_U_Asesor || null,
        T0_U_IDAsesor: cliente?.T0_U_IDAsesor || null,
        T0_U_IDAgencia: cliente?.T0_U_IDAgencia || null,
        T0_U_Agencia: solicitud?.agencia || cliente?.T0_U_Agencia || null,
        T0_U_Cliente: cliente?.T0_U_Cliente || null,
        T0_U_RazonSocial: cliente?.T0_U_RazonSocial || solicitud?.razon_social || null,
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
        tipo_periodo: cotizacion?.tipo_periodo || 'catorcena',
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
        sap_database: solicitud?.sap_database || null,
        posted_to_sap: (campana as any).posted_to_sap ? true : false,
        posted_aps: postedAps,
        // Reservas count para detectar campañas incompletas
        reservas_count: reservasCount,
        reservas_count_ultima_cat: reservasCountUltimaCat,
        caras_ultima_cat: carasUltimaCat,
        // Desglose de completitud por catorcena
        incompleteness_detail: incompletenessDetail,
        // Comentarios
        comentarios,
      };

      const campanaSerializable = serializeBigInt(campanaCompleta);

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
        select: CAMPANIA_SAFE_SELECT,
      });

      if (!campanaAnterior) {
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      // Si intenta cambiar a "Aprobada" o similar status de aprobación, verificar autorizaciones
      if (status === 'Aprobada' || status === 'En pauta') {
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

      // --- Estatus manuales de bitácora ---
      const nombreCampanaStatus = campana.nombre || `Campaña #${campanaId}`;

      if (status === 'Ajuste CTO Cliente') {
        const idsAsignados = propuesta?.id_asignado
          ? propuesta.id_asignado.split(',').map(i => parseInt(i.trim())).filter(i => !isNaN(i) && i !== userId)
          : [];

        const usuariosAsignados = idsAsignados.length > 0
          ? await prisma.usuario.findMany({
              where: { id: { in: idsAsignados }, deleted_at: null },
              select: { id: true, nombre: true, correo_electronico: true },
            })
          : [];

        for (const u of usuariosAsignados) {
          await prisma.tareas.create({
            data: {
              titulo: 'Ajuste de campaña',
              descripcion: `Ajuste CTO Cliente - ${nombreCampanaStatus}`,
              tipo: 'Ajuste Cto Cliente',
              estatus: 'Pendiente',
              fecha_inicio: now,
              fecha_fin: fechaFin,
              id_responsable: u.id,
              responsable: u.nombre,
              asignado: u.nombre,
              id_asignado: u.id.toString(),
              id_solicitud: solicitud?.id?.toString() || '',
              id_propuesta: propuesta?.id?.toString() || '',
              campania_id: campanaId,
            },
          });
        }

        // Tarea de seguimiento para Analista (asignados de la propuesta)
        if (propuesta?.id_asignado) {
          for (const idStr of propuesta.id_asignado.split(',')) {
            const analistaId = parseInt(idStr.trim());
            if (isNaN(analistaId)) continue;
            const analista = await prisma.usuario.findUnique({ where: { id: analistaId }, select: { nombre: true } });
            await prisma.tareas.create({
              data: {
                titulo: 'Seguimiento ajuste de campaña',
                descripcion: `Seguimiento Ajuste CTO Cliente - ${nombreCampanaStatus}`,
                tipo: 'Seguimiento',
                estatus: 'Pendiente',
                fecha_inicio: now,
                fecha_fin: fechaFin,
                id_responsable: analistaId,
                responsable: analista?.nombre || '',
                asignado: analista?.nombre || '',
                id_asignado: analistaId.toString(),
                id_solicitud: solicitud?.id?.toString() || '',
                id_propuesta: propuesta?.id?.toString() || '',
                campania_id: campanaId,
              },
            });
          }
        }
      }

      if (status === 'Ajuste Comercial') {
        // Tarea de ajuste para el asesor (creador de la solicitud)
        if (solicitud?.usuario_id) {
          const asesor = await prisma.usuario.findUnique({ where: { id: solicitud.usuario_id }, select: { nombre: true } });
          await prisma.tareas.create({
            data: {
              titulo: 'Ajuste de campaña',
              descripcion: `Ajuste Comercial - ${nombreCampanaStatus}`,
              tipo: 'Ajuste Comercial',
              estatus: 'Pendiente',
              fecha_inicio: now,
              fecha_fin: fechaFin,
              id_responsable: solicitud.usuario_id,
              responsable: asesor?.nombre || '',
              asignado: asesor?.nombre || '',
              id_asignado: solicitud.usuario_id.toString(),
              id_solicitud: solicitud.id.toString(),
              id_propuesta: propuesta?.id?.toString() || '',
              campania_id: campanaId,
            },
          });
        }

        // Tarea de seguimiento para Analista
        if (propuesta?.id_asignado) {
          for (const idStr of propuesta.id_asignado.split(',')) {
            const analistaId = parseInt(idStr.trim());
            if (isNaN(analistaId)) continue;
            const analista = await prisma.usuario.findUnique({ where: { id: analistaId }, select: { nombre: true } });
            await prisma.tareas.create({
              data: {
                titulo: 'Seguimiento ajuste de campaña',
                descripcion: `Seguimiento Ajuste Comercial - ${nombreCampanaStatus}`,
                tipo: 'Seguimiento',
                estatus: 'Pendiente',
                fecha_inicio: now,
                fecha_fin: fechaFin,
                id_responsable: analistaId,
                responsable: analista?.nombre || '',
                asignado: analista?.nombre || '',
                id_asignado: analistaId.toString(),
                id_solicitud: solicitud?.id?.toString() || '',
                id_propuesta: propuesta?.id?.toString() || '',
                campania_id: campanaId,
              },
            });
          }
        }
      }

      if (status === 'Atendido') {
        // Notificación al Analista asignado
        if (propuesta?.id_asignado) {
          for (const idStr of propuesta.id_asignado.split(',')) {
            const analistaId = parseInt(idStr.trim());
            if (isNaN(analistaId)) continue;
            await prisma.tareas.create({
              data: {
                titulo: `Campaña atendida: ${nombreCampanaStatus}`,
                descripcion: `${userName} marcó la campaña como Atendido`,
                tipo: 'Notificación',
                estatus: 'Pendiente',
                fecha_inicio: now,
                fecha_fin: fechaFin,
                id_responsable: analistaId,
                responsable: '',
                id_solicitud: solicitud?.id?.toString() || '',
                id_propuesta: propuesta?.id?.toString() || '',
                campania_id: campanaId,
                asignado: userName,
                id_asignado: userId.toString(),
              },
            });
          }
        }

      }

      res.json({
        success: true,
        data: campana,
      });

      // Emitir eventos WebSocket
      emitToCampana(campanaId, SOCKET_EVENTS.CAMPANA_STATUS_CHANGED, {
        campanaId,
        statusAnterior,
        statusNuevo: status,
        usuario: userName,
      });
      emitToCampanas(SOCKET_EVENTS.CAMPANA_STATUS_CHANGED, {
        campanaId,
        statusAnterior,
        statusNuevo: status,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'campana', accion: 'status_changed' });
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
        catorcenaFinAnio,
        asignados,
        id_asignado,
      } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      const campanaId = parseInt(id);

      // Obtener la campaña actual para conseguir cotizacion_id
      const campanaActual = await prisma.campania.findUnique({
        where: { id: campanaId },
        select: CAMPANIA_SAFE_SELECT,
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
              ...(asignados !== undefined && { asignado: asignados }),
              ...(id_asignado !== undefined && { id_asignado }),
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

      // Emitir eventos WebSocket
      emitToCampana(campanaId, SOCKET_EVENTS.CAMPANA_ACTUALIZADA, {
        campanaId,
        usuario: userName,
      });
      emitToCampanas(SOCKET_EVENTS.CAMPANA_ACTUALIZADA, {
        campanaId,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'campana', accion: 'actualizada' });
    } catch (error) {
      console.error('Error updating campana:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar campaña';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const status = req.query.status as string;
      const search = req.query.search as string;
      const yearInicio = req.query.yearInicio ? parseInt(req.query.yearInicio as string) : undefined;
      const yearFin = req.query.yearFin ? parseInt(req.query.yearFin as string) : undefined;
      const catorcenaInicio = req.query.catorcenaInicio ? parseInt(req.query.catorcenaInicio as string) : undefined;
      const catorcenaFin = req.query.catorcenaFin ? parseInt(req.query.catorcenaFin as string) : undefined;
      const tipoPeriodo = req.query.tipoPeriodo as string;

      // Build WHERE — same logic as getAll
      const conditions: string[] = ['cm.id IS NOT NULL'];
      const params: (string | number)[] = [];

      if (status) {
        conditions.push('cm.status = ?');
        params.push(status);
      } else {
        conditions.push("cm.status != 'inactiva'");
      }

      if (tipoPeriodo && tipoPeriodo !== 'todas') {
        conditions.push("COALESCE(ct.tipo_periodo, 'catorcena') = ?");
        params.push(tipoPeriodo);
      }

      if (search) {
        conditions.push('(CAST(cm.id AS CHAR) LIKE ? OR cm.nombre LIKE ? OR cl.T2_U_Marca LIKE ? OR cl.T0_U_Cliente LIKE ? OR cl.T0_U_RazonSocial LIKE ? OR cl.CUIC LIKE ? OR pr.asignado LIKE ? OR s.nombre_usuario LIKE ?)');
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
      }

      if (yearInicio && yearFin) {
        if (catorcenaInicio && catorcenaFin) {
          conditions.push(`
            cm.fecha_inicio <= (SELECT fecha_fin FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1)
            AND cm.fecha_fin >= (SELECT fecha_inicio FROM catorcenas WHERE año = ? AND numero_catorcena = ? LIMIT 1)
          `);
          params.push(yearFin, catorcenaFin, yearInicio, catorcenaInicio);
        } else {
          conditions.push('YEAR(cm.fecha_inicio) <= ? AND YEAR(cm.fecha_fin) >= ?');
          params.push(yearFin, yearInicio);
        }
      }

      // Visibility filter
      const userId = req.user?.userId;
      const userRol = req.user?.rol || '';
      if (userId && !hasFullVisibility(userRol)) {
        if (hasTeamVisibility(userRol)) {
          const teamIds = await getTeamMemberIds(prisma, userId);
          const placeholders = teamIds.map(() => '?').join(',');
          conditions.push(`EXISTS (
            SELECT 1 FROM tareas t
            WHERE t.campania_id = cm.id
              AND (t.id_responsable IN (${placeholders}) OR FIND_IN_SET(?, REPLACE(IFNULL(t.id_asignado, ''), ' ', '')) > 0)
          )`);
          params.push(...teamIds, String(userId));
        } else {
          conditions.push(`EXISTS (
            SELECT 1 FROM tareas t
            WHERE t.campania_id = cm.id
              AND (t.id_responsable = ? OR FIND_IN_SET(?, REPLACE(IFNULL(t.id_asignado, ''), ' ', '')) > 0)
          )`);
          params.push(userId, String(userId));
        }
      }

      const whereClause = conditions.join(' AND ');

      // Total + status breakdown + APS count in a single query
      const rows = await prisma.$queryRawUnsafe<Array<{
        status: string | null;
        cnt: bigint;
        con_aps: bigint;
      }>>(`
        SELECT
          cm.status,
          COUNT(*) as cnt,
          SUM(CASE WHEN aps_check.cotizacion_id IS NOT NULL THEN 1 ELSE 0 END) as con_aps
        FROM campania cm
        LEFT JOIN cliente cl ON cm.cliente_id = cl.id
        LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
        LEFT JOIN propuesta pr ON pr.id = ct.id_propuesta
        LEFT JOIN solicitud s ON s.id = pr.solicitud_id
        LEFT JOIN (
          SELECT DISTINCT ct_a.id AS cotizacion_id
          FROM cotizacion ct_a
          INNER JOIN solicitudCaras sc_a ON sc_a.idquote = ct_a.id_propuesta
          INNER JOIN reservas rsv_a ON rsv_a.solicitudCaras_id = sc_a.id AND rsv_a.deleted_at IS NULL
          WHERE rsv_a.APS IS NOT NULL AND rsv_a.APS > 0
        ) aps_check ON aps_check.cotizacion_id = ct.id
        WHERE ${whereClause}
        GROUP BY cm.status
      `, ...params);

      const byStatus: Record<string, number> = {};
      let total = 0;
      let conAps = 0;
      for (const row of rows) {
        const s = row.status || 'Sin status';
        const cnt = Number(row.cnt);
        byStatus[s] = cnt;
        total += cnt;
        conAps += Number(row.con_aps);
      }

      res.json({
        success: true,
        data: {
          total,
          activas: byStatus['Aprobada'] || 0,
          inactivas: byStatus['inactiva'] || 0,
          byStatus,
          conAps,
          sinAps: total - conAps,
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

      console.log('[getCaras Campaña] Buscando caras para campaña:', campanaId);

      // Obtener campaña para conseguir cotizacion_id
      const campana = await prisma.campania.findUnique({
        where: { id: campanaId },
        select: CAMPANIA_SAFE_SELECT,
      });

      if (!campana) {
        console.log('[getCaras Campaña] Campaña no encontrada');
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      console.log('[getCaras Campaña] cotizacion_id:', campana.cotizacion_id);

      if (!campana.cotizacion_id) {
        console.log('[getCaras Campaña] No tiene cotizacion_id, retornando []');
        res.json({ success: true, data: [] });
        return;
      }

      // Obtener cotizacion para conseguir id_propuesta
      const cotizacion = await prisma.cotizacion.findUnique({
        where: { id: campana.cotizacion_id },
      });

      console.log('[getCaras Campaña] cotizacion:', cotizacion?.id, 'id_propuesta:', cotizacion?.id_propuesta);

      if (!cotizacion?.id_propuesta) {
        console.log('[getCaras Campaña] Cotización sin id_propuesta, retornando []');
        res.json({ success: true, data: [] });
        return;
      }

      // Obtener caras de la propuesta
      const caras = await prisma.solicitudCaras.findMany({
        where: { idquote: String(cotizacion.id_propuesta) },
        orderBy: { id: 'asc' },
      });

      console.log('[getCaras Campaña] Encontradas', caras.length, 'caras para idquote:', String(cotizacion.id_propuesta));

      const carasSerializable = serializeBigInt(caras);

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
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          MIN(i.id) as id,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(MIN(i.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(i.codigo_unico), '_', -1))
            ELSE MIN(i.codigo_unico)
          END as codigo_unico,
          MIN(i.mueble) as mueble,
          MIN(i.estado) as estado,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL THEN 'Completo'
            ELSE MIN(i.tipo_de_cara)
          END as tipo_de_cara,
          MIN(i.latitud) as latitud,
          MIN(i.longitud) as longitud,
          MIN(i.ancho) as ancho,
          MIN(i.alto) as alto,
          MIN(i.plaza) as plaza,
          MIN(i.tradicional_digital) as tradicional_digital,
          MIN(i.tarifa_publica) as tarifa_publica,
          MAX(rsv.estatus) as estatus_reserva,
          MAX(rsv.archivo) as archivo,
          MAX(rsv.calendario_id) as calendario_id,
          MAX(rsv.arte_aprobado) as arte_aprobado,
          MIN(rsv.instalado) as instalado,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          MAX(sc.id) AS solicitud_caras_id,
          MAX(sc.articulo) as articulo,
          MAX(sc.tipo) as tipo_medio,
          MAX(sc.inicio_periodo) as inicio_periodo,
          MAX(sc.fin_periodo) as fin_periodo,
          MAX(sc.formato) as formato,
          COALESCE(MAX(sc.tarifa_publica), MIN(i.tarifa_publica), 0) as tarifa_publica_sc,
          MAX(sc.bonificacion) as bonificacion_sc,
          MAX(sc.costo) as renta,
          MAX(sc.cortesia) as cortesia,
          cat.numero_catorcena,
          cat.año as anio_catorcena,
          CAST(COUNT(DISTINCT rsv.id) AS UNSIGNED) AS caras_totales
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
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), cat.numero_catorcena, cat.año
        ORDER BY MIN(rsv.id) DESC
      `;

      const tareasQuery = `
        SELECT id, tipo, estatus, ids_reservas, contenido, evidencia
        FROM tareas
        WHERE campania_id = ?
          AND tipo IN ('Impresión', 'Re-impresión', 'Recepción', 'Programación', 'Instalación', 'Orden de Instalación', 'Orden de Programación')
      `;

      // Query para artículos IM sin reservas (impresión) que pertenecen a esta campaña
      const imQuery = `
        SELECT
          CONCAT('sc_', sc.id) as rsv_ids,
          0 as id,
          sc.articulo as codigo_unico,
          NULL as mueble,
          sc.estados as estado,
          'Impresión' as tipo_de_cara,
          NULL as latitud,
          NULL as longitud,
          NULL as ancho,
          NULL as alto,
          sc.ciudad as plaza,
          NULL as tradicional_digital,
          NULL as tarifa_publica,
          'Impresión' as estatus_reserva,
          NULL as archivo,
          NULL as calendario_id,
          NULL as arte_aprobado,
          0 as instalado,
          CONCAT('sc_', sc.id) as grupo_completo_id,
          sc.id AS solicitud_caras_id,
          sc.articulo as articulo,
          sc.tipo as tipo_medio,
          sc.inicio_periodo as inicio_periodo,
          sc.fin_periodo as fin_periodo,
          sc.formato as formato,
          COALESCE(sc.tarifa_publica, 0) as tarifa_publica_sc,
          sc.bonificacion as bonificacion_sc,
          sc.costo as renta,
          sc.cortesia as cortesia,
          sc.ciudad as ciudad,
          sc.estados as estados,
          sc.nivel_socioeconomico as nivel_socioeconomico,
          cat.numero_catorcena,
          cat.año as anio_catorcena,
          sc.caras AS caras_totales
        FROM solicitudCaras sc
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id AND rsv.deleted_at IS NULL
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE
          cm.id = ?
          AND UPPER(sc.articulo) LIKE 'IM%'
          AND rsv.id IS NULL
      `;

      const [inventario, tareas, imArticulos] = await Promise.all([
        prisma.$queryRawUnsafe(query, campanaId),
        prisma.$queryRawUnsafe(tareasQuery, campanaId),
        prisma.$queryRawUnsafe(imQuery, campanaId),
      ]);

      const inventarioArr = inventario as any[];
      const tareasArr = tareas as any[];
      const imArr = imArticulos as any[];

      // Combinar inventario normal + artículos IM sin reservas
      const combinedArr = [...inventarioArr, ...imArr];

      if (!combinedArr.length) {
        res.json({ success: true, data: [] });
        return;
      }

      // Indexar tareas por reserva_id
      const impresionByReserva = new Map<number, any>();
      const recepcionByReserva = new Map<number, any>();
      const programacionByReserva = new Map<number, any>();
      const instalacionByReserva = new Map<number, any>();

      for (const tarea of tareasArr) {
        if (!tarea.ids_reservas) continue;
        const ids = String(tarea.ids_reservas).split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        const map = (tarea.tipo === 'Impresión' || tarea.tipo === 'Re-impresión') ? impresionByReserva
                  : (tarea.tipo === 'Programación' || tarea.tipo === 'Orden de Programación') ? programacionByReserva
                  : (tarea.tipo === 'Instalación' || tarea.tipo === 'Orden de Instalación') ? instalacionByReserva
                  : recepcionByReserva;
        for (const rsvId of ids) {
          map.set(rsvId, tarea);
        }
      }

      const inventarioConEstatus = combinedArr.map((row: any) => {
        // Los artículos IM no tienen rsv_ids numéricos, skip tarea lookup
        const isIM = String(row.rsv_ids).startsWith('sc_');
        const rsvIds = isIM ? [] : String(row.rsv_ids).split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        const tImpresion = rsvIds.map(id => impresionByReserva.get(id)).find(Boolean);
        const tRecepcion = rsvIds.map(id => recepcionByReserva.get(id)).find(Boolean);

        let estatus_arte: string;
        if (isIM) {
          estatus_arte = 'Impresión';
        } else if (Number(row.instalado) === 1) {
          estatus_arte = 'Instalado';
        } else if (tRecepcion && tRecepcion.estatus === 'Completado') {
          estatus_arte = 'Artes Recibidos';
        } else if (tImpresion && (tImpresion.estatus === 'Activo' || tImpresion.estatus === 'Atendido')) {
          estatus_arte = 'En Impresion';
        } else if (row.arte_aprobado === 'aprobado') {
          estatus_arte = 'Artes Aprobados';
        } else if (row.archivo != null && row.archivo !== '') {
          estatus_arte = 'Revision Artes';
        } else {
          estatus_arte = 'Carga Artes';
        }

        // Indicaciones de programación
        const tProgramacion = rsvIds.map(id => programacionByReserva.get(id)).find(Boolean);
        let indicaciones_programacion: string | null = null;
        if (tProgramacion && tProgramacion.evidencia) {
          try {
            const evidenciaJson = typeof tProgramacion.evidencia === 'string'
              ? JSON.parse(tProgramacion.evidencia)
              : tProgramacion.evidencia;
            indicaciones_programacion = evidenciaJson.indicaciones || evidenciaJson.indicaciones_programacion || null;
          } catch { /* ignore parse errors */ }
        }

        // Indicaciones de instalación
        const tInstalacion = rsvIds.map(id => instalacionByReserva.get(id)).find(Boolean);
        let indicaciones_instalacion: string | null = null;
        if (tInstalacion && tInstalacion.evidencia) {
          try {
            const evidenciaJson = typeof tInstalacion.evidencia === 'string'
              ? JSON.parse(tInstalacion.evidencia)
              : tInstalacion.evidencia;
            indicaciones_instalacion = evidenciaJson.indicaciones || evidenciaJson.indicaciones_instalacion || null;
          } catch { /* ignore parse errors */ }
        }

        return { ...row, estatus_arte, indicaciones_programacion, indicaciones_instalacion, caras_totales: Number(row.caras_totales) };
      });

      // Convertir BigInt a Number para que JSON.stringify funcione
      const inventarioSerializable = JSON.parse(JSON.stringify(inventarioConEstatus, (_, value) =>
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

      // Query principal con subquery para id_propuesta (elimina 1 round trip a DB)
      const query = `
        SELECT /*+ MAX_EXECUTION_TIME(30000) */
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          MIN(i.id) as id,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(MIN(i.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(i.codigo_unico), '_', -1))
            ELSE MIN(i.codigo_unico)
          END as codigo_unico,
          MIN(i.ubicacion) as ubicacion,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL THEN 'Completo'
            ELSE MIN(i.tipo_de_cara)
          END as tipo_de_cara,
          MIN(i.cara) as cara,
          MIN(i.mueble) as mueble,
          MIN(i.latitud) as latitud,
          MIN(i.longitud) as longitud,
          MIN(i.plaza) as plaza,
          MIN(i.estado) as estado,
          MIN(i.municipio) as municipio,
          MIN(i.mueble) as tipo_de_mueble,
          MIN(i.ancho) as ancho,
          MIN(i.alto) as alto,
          MIN(i.nivel_socioeconomico) as nivel_socioeconomico,
          MIN(i.tarifa_publica) as tarifa_publica,
          MIN(i.tradicional_digital) as tradicional_digital,
          MAX(rsv.archivo) as archivo,
          MAX(rsv.estatus) as estatus_reserva,
          MAX(rsv.calendario_id) as calendario_id,
          MAX(rsv.APS) as aps,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          MIN(epIn.numero_espacio) as espacios,
          MAX(sc.id) AS solicitud_caras_id,
          MAX(sc.articulo) as articulo,
          MAX(sc.tipo) as tipo_medio,
          MAX(sc.inicio_periodo) as inicio_periodo,
          MAX(sc.fin_periodo) as fin_periodo,
          CAST(COUNT(DISTINCT rsv.id) AS UNSIGNED) AS caras_totales,
          MAX(rsv.arte_aprobado) as arte_aprobado,
          MIN(rsv.instalado) as instalado,
          MAX(sc.formato) as formato,
          COALESCE(MAX(sc.tarifa_publica), MIN(i.tarifa_publica), 0) as tarifa_publica_sc,
          MAX(sc.bonificacion) as bonificacion_sc,
          MAX(sc.costo) as renta,
          MAX(sc.cortesia) as cortesia
        FROM solicitudCaras sc
          INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id AND rsv.deleted_at IS NULL
          INNER JOIN espacio_inventario epIn ON epIn.id = rsv.inventario_id
          INNER JOIN inventarios i ON i.id = epIn.inventario_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
        WHERE
          cm.id = ?
          AND rsv.APS IS NOT NULL
          AND rsv.APS > 0
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), sc.id
        ORDER BY MIN(rsv.id) DESC
      `;

      const tareasQuery = `
        SELECT id, tipo, estatus, ids_reservas, contenido, evidencia
        FROM tareas
        WHERE campania_id = ?
          AND tipo IN ('Impresión', 'Re-impresión', 'Recepción', 'Programación', 'Instalación', 'Orden de Instalación', 'Orden de Programación')
      `;

      const catorcenasQuery = `
        SELECT numero_catorcena, año as anio_catorcena, fecha_inicio, fecha_fin
        FROM catorcenas
        ORDER BY fecha_inicio
      `;

      // Las 3 queries en paralelo con timeout de 45s para no colgar el servidor
      const QUERY_TIMEOUT = 45000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout: las consultas tardaron más de 45s')), QUERY_TIMEOUT)
      );

      // Query para artículos IM con reservas que ya tienen APS asignado (inventario_id = 0)
      const imAPSQuery = `
        SELECT
          CONCAT('sc_', sc.id) as rsv_ids,
          0 as id,
          sc.articulo as codigo_unico,
          NULL as ubicacion,
          'Impresión' as tipo_de_cara,
          NULL as cara,
          NULL as mueble,
          NULL as latitud,
          NULL as longitud,
          sc.ciudad as plaza,
          sc.estados as estado,
          NULL as municipio,
          NULL as tipo_de_mueble,
          NULL as ancho,
          NULL as alto,
          sc.nivel_socioeconomico as nivel_socioeconomico,
          NULL as tarifa_publica,
          NULL as tradicional_digital,
          NULL as archivo,
          'Impresión' as estatus_reserva,
          NULL as calendario_id,
          MAX(rsv.APS) as aps,
          CONCAT('sc_', sc.id) as grupo_completo_id,
          NULL as espacios,
          sc.id AS solicitud_caras_id,
          sc.articulo as articulo,
          sc.tipo as tipo_medio,
          sc.inicio_periodo as inicio_periodo,
          sc.fin_periodo as fin_periodo,
          sc.caras AS caras_totales,
          NULL as arte_aprobado,
          0 as instalado,
          sc.formato as formato,
          COALESCE(sc.tarifa_publica, 0) as tarifa_publica_sc,
          sc.bonificacion as bonificacion_sc,
          sc.costo as renta,
          sc.cortesia as cortesia,
          sc.ciudad as ciudad,
          sc.estados as estados
        FROM solicitudCaras sc
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id AND rsv.deleted_at IS NULL AND rsv.inventario_id = 0
        WHERE
          cm.id = ?
          AND UPPER(sc.articulo) LIKE 'IM%'
          AND rsv.APS IS NOT NULL
          AND rsv.APS > 0
        GROUP BY sc.id
      `;

      const [inventario, tareas, catorcenas, imAPSArticulos] = await Promise.race([
        Promise.all([
          prisma.$queryRawUnsafe(query, campanaId),
          prisma.$queryRawUnsafe(tareasQuery, campanaId),
          prisma.$queryRawUnsafe(catorcenasQuery),
          prisma.$queryRawUnsafe(imAPSQuery, campanaId),
        ]),
        timeoutPromise as never,
      ]);

      const inventarioArr = inventario as any[];
      const tareasArr = tareas as any[];
      const catorcenasArr = catorcenas as any[];
      const imAPSArr = imAPSArticulos as any[];

      // Combinar inventario normal + artículos IM con APS
      const combinedArr = [...inventarioArr, ...imAPSArr];

      if (!combinedArr.length) {
        res.json({ success: true, data: [] });
        return;
      }

      // Indexar tareas por reserva_id para lookup O(1)
      const impresionByReserva = new Map<number, any>();
      const recepcionByReserva = new Map<number, any>();
      const programacionByReserva = new Map<number, any>();
      const instalacionByReserva = new Map<number, any>();

      for (const tarea of tareasArr) {
        if (!tarea.ids_reservas) continue;
        const ids = String(tarea.ids_reservas).split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        const map = (tarea.tipo === 'Impresión' || tarea.tipo === 'Re-impresión') ? impresionByReserva
                  : (tarea.tipo === 'Programación' || tarea.tipo === 'Orden de Programación') ? programacionByReserva
                  : (tarea.tipo === 'Instalación' || tarea.tipo === 'Orden de Instalación') ? instalacionByReserva
                  : recepcionByReserva;
        for (const rsvId of ids) {
          map.set(rsvId, tarea);
        }
      }

      // Pre-computar timestamps de catorcenas ordenadas para búsqueda binaria O(log n)
      const catorcenaRanges = catorcenasArr.map((cat: any) => ({
        inicio: new Date(cat.fecha_inicio).getTime(),
        fin: new Date(cat.fecha_fin).getTime(),
        numero_catorcena: cat.numero_catorcena,
        anio_catorcena: cat.anio_catorcena,
      }));

      function findCatorcena(fecha: Date) {
        const ts = fecha.getTime();
        let lo = 0, hi = catorcenaRanges.length - 1;
        let result = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (catorcenaRanges[mid].inicio <= ts) {
            result = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (result >= 0 && ts <= catorcenaRanges[result].fin) {
          return catorcenaRanges[result];
        }
        return null;
      }

      // Calcular estatus_arte y catorcena en código
      const inventarioConEstatus = combinedArr.map((row: any) => {
        const isIM = String(row.rsv_ids).startsWith('sc_');
        const rsvIds = isIM ? [] : String(row.rsv_ids).split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        const tImpresion = rsvIds.map(id => impresionByReserva.get(id)).find(Boolean);
        const tRecepcion = rsvIds.map(id => recepcionByReserva.get(id)).find(Boolean);

        // estatus_arte
        let estatus_arte: string;
        if (isIM) {
          estatus_arte = 'Impresión';
        } else if (Number(row.instalado) === 1) {
          estatus_arte = 'Instalado';
        } else if (tRecepcion && tRecepcion.estatus === 'Completado') {
          estatus_arte = 'Artes Recibidos';
        } else if (tImpresion && (tImpresion.estatus === 'Activo' || tImpresion.estatus === 'Atendido')) {
          estatus_arte = 'En Impresion';
        } else if (row.arte_aprobado === 'aprobado') {
          estatus_arte = 'Artes Aprobados';
        } else if (row.archivo != null && row.archivo !== '') {
          estatus_arte = 'Revision Artes';
        } else {
          estatus_arte = 'Carga Artes';
        }

        // catorcena matching con búsqueda binaria
        let numero_catorcena = null;
        let anio_catorcena = null;
        if (row.inicio_periodo) {
          const cat = findCatorcena(new Date(row.inicio_periodo));
          if (cat) {
            numero_catorcena = cat.numero_catorcena;
            anio_catorcena = cat.anio_catorcena;
          }
        }

        // Indicaciones de programación desde la tarea
        const tProgramacion = rsvIds.map(id => programacionByReserva.get(id)).find(Boolean);
        let indicaciones_programacion: string | null = null;
        if (tProgramacion && tProgramacion.evidencia) {
          try {
            const evidenciaJson = typeof tProgramacion.evidencia === 'string'
              ? JSON.parse(tProgramacion.evidencia)
              : tProgramacion.evidencia;
            indicaciones_programacion = evidenciaJson.indicaciones || evidenciaJson.indicaciones_programacion || null;
          } catch { /* ignore parse errors */ }
        }

        // Indicaciones de instalación desde la tarea
        const tInstalacion = rsvIds.map(id => instalacionByReserva.get(id)).find(Boolean);
        let indicaciones_instalacion: string | null = null;
        if (tInstalacion && tInstalacion.evidencia) {
          try {
            const evidenciaJson = typeof tInstalacion.evidencia === 'string'
              ? JSON.parse(tInstalacion.evidencia)
              : tInstalacion.evidencia;
            indicaciones_instalacion = evidenciaJson.indicaciones || evidenciaJson.indicaciones_instalacion || null;
          } catch { /* ignore parse errors */ }
        }

        return { ...row, estatus_arte, numero_catorcena, anio_catorcena, indicaciones_programacion, indicaciones_instalacion, caras_totales: Number(row.caras_totales) };
      });

      // Convertir BigInt a Number para que JSON.stringify funcione
      const inventarioSerializable = JSON.parse(JSON.stringify(inventarioConEstatus, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: inventarioSerializable,
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
      const userName = req.user?.nombre || 'Usuario';
      const campanaId = parseInt(id);

      // UNA SOLA consulta para obtener toda la info necesaria
      const [campanaInfo] = await prisma.$queryRaw<{
        campana_id: number;
        campana_nombre: string | null;
        solicitud_id: number | null;
        propuesta_id: number | null;
        propuesta_id_asignado: string | null;
        solicitud_usuario_id: number | null;
      }[]>`
        SELECT
          cm.id as campana_id,
          cm.nombre as campana_nombre,
          s.id as solicitud_id,
          p.id as propuesta_id,
          p.id_asignado as propuesta_id_asignado,
          s.usuario_id as solicitud_usuario_id
        FROM campania cm
        LEFT JOIN cotizacion c ON cm.cotizacion_id = c.id
        LEFT JOIN propuesta p ON c.id_propuesta = p.id
        LEFT JOIN solicitud s ON p.solicitud_id = s.id
        WHERE cm.id = ${campanaId}
        LIMIT 1
      `;

      if (!campanaInfo) {
        res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        return;
      }

      const solicitudId = campanaInfo.solicitud_id || 0;

      // Crear el comentario
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

      // Emitir evento de socket para actualizar en tiempo real
      emitToCampana(campanaId, SOCKET_EVENTS.CAMPANA_COMENTARIO_CREADO, {
        campanaId,
        comentario: {
          id: comentario.id,
          autor_id: comentario.autor_id,
          autor_nombre: userName,
          autor_foto: null, // Se obtiene del cache del frontend
          contenido: comentario.comentario,
          fecha: comentario.creado_en,
        },
      });

      // Responder inmediatamente al cliente
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

      // Crear notificaciones en background (no bloquea la respuesta)
      setImmediate(async () => {
        try {
          const involucrados = new Set<number>();

          // Agregar usuarios asignados de la propuesta
          if (campanaInfo.propuesta_id_asignado) {
            campanaInfo.propuesta_id_asignado.split(',').forEach(id => {
              const parsed = parseInt(id.trim());
              if (!isNaN(parsed) && parsed !== userId) {
                involucrados.add(parsed);
              }
            });
          }

          // Agregar creador de la solicitud
          if (campanaInfo.solicitud_usuario_id && campanaInfo.solicitud_usuario_id !== userId) {
            involucrados.add(campanaInfo.solicitud_usuario_id);
          }

          if (involucrados.size === 0) return;

          const nombreCampana = campanaInfo.campana_nombre || 'Sin nombre';
          const tituloNotificacion = `Nuevo comentario en campaña #${campanaId} - ${nombreCampana}`;
          const descripcionNotificacion = `${userName} comentó: ${contenido.substring(0, 100)}${contenido.length > 100 ? '...' : ''}`;
          const now = new Date();
          const fechaFin = new Date(now.getTime() + 24 * 60 * 60 * 1000);

          // Crear todas las notificaciones en paralelo
          await Promise.all(
            Array.from(involucrados).map(responsableId =>
              prisma.tareas.create({
                data: {
                  titulo: tituloNotificacion,
                  descripcion: descripcionNotificacion,
                  tipo: 'Notificación',
                  estatus: 'Pendiente',
                  id_responsable: responsableId,
                  id_solicitud: solicitudId.toString(),
                  id_propuesta: campanaInfo.propuesta_id?.toString() || '',
                  campania_id: campanaId,
                  fecha_inicio: now,
                  fecha_fin: fechaFin,
                  responsable: '',
                  asignado: userName,
                  id_asignado: userId.toString(),
                },
              })
            )
          );
        } catch (err) {
          console.error('Error creando notificaciones de comentario:', err);
        }
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
          select: CAMPANIA_SAFE_SELECT,
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

          MIN(inv.id) AS id,
          MIN(inv.codigo_unico) AS codigo_unico,
          MIN(inv.ubicacion) AS ubicacion,
          MIN(inv.tipo_de_cara) AS tipo_de_cara,
          MIN(inv.cara) AS cara,
          MIN(inv.mueble) AS mueble,
          MIN(inv.latitud) AS latitud,
          MIN(inv.longitud) AS longitud,
          MIN(inv.plaza) AS plaza,
          MIN(inv.estado) AS estado,
          MIN(inv.municipio) AS municipio,
          MIN(inv.mueble) AS tipo_de_mueble,
          MIN(inv.ancho) AS ancho,
          MIN(inv.alto) AS alto,
          MIN(inv.nivel_socioeconomico) AS nivel_socioeconomico,
          MIN(inv.tarifa_publica) AS tarifa_publica,
          MIN(inv.tradicional_digital) AS tradicional_digital,

          CASE
            WHEN COUNT(DISTINCT inv.id) > 1 AND MAX(rsv.grupo_completo_id) IS NOT NULL
            THEN CONCAT(
              SUBSTRING_INDEX(MIN(inv.codigo_unico), '_', 1),
              '_completo_',
              SUBSTRING_INDEX(MIN(inv.codigo_unico), '_', -1)
            )
            ELSE MIN(inv.codigo_unico)
          END as codigo_unico_display,

          CASE
            WHEN COUNT(DISTINCT inv.id) > 1 AND MAX(rsv.grupo_completo_id) IS NOT NULL
            THEN 'Completo'
            ELSE MIN(inv.tipo_de_cara)
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

          MAX(sol.IMU) AS IMU,

          MAX(sc.articulo) AS articulo,
          MAX(sc.tipo) AS tipo_medio,
          MAX(cat.numero_catorcena) AS numero_catorcena,
          MAX(cat.año) AS anio_catorcena,
          COALESCE(MAX(rsv.grupo_completo_id), MIN(inv.id)) as grupo_completo_id

        FROM inventarios inv
          INNER JOIN espacio_inventario epIn ON inv.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN propuesta pr ON pr.id = sc.idquote
          LEFT JOIN solicitud sol ON sol.id = pr.solicitud_id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE
          cm.id = ?
          AND rsv.deleted_at IS NULL
          AND sc.inicio_periodo <= cm.fecha_fin
          AND sc.fin_periodo >= cm.fecha_inicio
          AND rsv.APS IS NOT NULL
          AND rsv.APS > 0
          AND (
            (rsv.archivo IS NOT NULL AND rsv.archivo != '')
            OR EXISTS (
              SELECT 1
              FROM imagenes_digitales imDig
              WHERE imDig.id_reserva = rsv.id
              LIMIT 1
            )
          )
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), sc.id
        ORDER BY MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId);

      console.log('Inventario con arte result count:', Array.isArray(inventario) ? inventario.length : 0);

      // Evitar stringify/parse en payloads grandes (puede agotar heap en producción).
      // Solo convertimos BigInt en columnas del resultado.
      const inventarioSerializable = Array.isArray(inventario)
        ? inventario.map((row) => {
            const normalized: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
              normalized[key] = typeof value === 'bigint' ? Number(value) : value;
            }
            return normalized;
          })
        : inventario;

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
        select: CAMPANIA_SAFE_SELECT,
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

      const historialSerializable = serializeBigInt(historial);

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
      console.log('Fetching inventario sin arte for campana:', campanaId);

      const query = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_id,
          MIN(inv.id) AS id,
          MIN(inv.codigo_unico) AS codigo_unico,
          MIN(inv.ubicacion) AS ubicacion,
          MIN(inv.tipo_de_cara) AS tipo_de_cara,
          MIN(inv.cara) AS cara,
          MIN(inv.mueble) AS mueble,
          MIN(inv.latitud) AS latitud,
          MIN(inv.longitud) AS longitud,
          MIN(inv.plaza) AS plaza,
          MIN(inv.estado) AS estado,
          MIN(inv.municipio) AS municipio,
          MIN(inv.mueble) AS tipo_de_mueble,
          MIN(inv.ancho) AS ancho,
          MIN(inv.alto) AS alto,
          MIN(inv.nivel_socioeconomico) AS nivel_socioeconomico,
          MIN(inv.tarifa_publica) AS tarifa_publica,
          MIN(inv.tradicional_digital) AS tradicional_digital,
          CASE
            WHEN COUNT(DISTINCT inv.id) > 1 AND MAX(rsv.grupo_completo_id) IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(MIN(inv.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(inv.codigo_unico), '_', -1))
            ELSE MIN(inv.codigo_unico)
          END as codigo_unico_display,
          CASE
            WHEN COUNT(DISTINCT inv.id) > 1 AND MAX(rsv.grupo_completo_id) IS NOT NULL THEN 'Completo'
            ELSE MIN(inv.tipo_de_cara)
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
          COALESCE(MAX(rsv.grupo_completo_id), MIN(inv.id)) as grupo_completo_id
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
          AND sc.inicio_periodo <= cm.fecha_fin
          AND sc.fin_periodo >= cm.fecha_inicio
          AND rsv.archivo IS NULL
          AND imDig.id_reserva IS NULL
          AND rsv.APS IS NOT NULL
          AND rsv.APS > 0
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), sc.id
        ORDER BY MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId);

      console.log('Inventario sin arte result count:', Array.isArray(inventario) ? inventario.length : 0);

      const inventarioSerializable = serializeBigInt(inventario);

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
   * Obtener inventario para validación de instalaciones
   * Muestra items que forman parte de una tarea de tipo 'Instalación'
   */
  async getInventarioTestigos(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      console.log('Fetching inventario para instalaciones campana:', campanaId);

      const query = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          MIN(inv.id) AS id,
          MIN(inv.codigo_unico) AS codigo_unico,
          MIN(inv.ubicacion) AS ubicacion,
          MIN(inv.tipo_de_cara) AS tipo_de_cara,
          MIN(inv.cara) AS cara,
          MIN(inv.mueble) AS mueble,
          MIN(inv.latitud) AS latitud,
          MIN(inv.longitud) AS longitud,
          MIN(inv.plaza) AS plaza,
          MIN(inv.estado) AS estado,
          MIN(inv.municipio) AS municipio,
          MIN(inv.ancho) AS ancho,
          MIN(inv.alto) AS alto,
          MIN(inv.tarifa_publica) AS tarifa_publica,
          MIN(inv.tradicional_digital) AS tradicional_digital,
          CASE
            WHEN COUNT(DISTINCT inv.id) > 1 AND MAX(rsv.grupo_completo_id) IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(MIN(inv.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(inv.codigo_unico), '_', -1))
            ELSE MIN(inv.codigo_unico)
          END as codigo_unico_display,
          CASE
            WHEN COUNT(DISTINCT inv.id) > 1 AND MAX(rsv.grupo_completo_id) IS NOT NULL THEN 'Completo'
            ELSE MIN(inv.tipo_de_cara)
          END as tipo_de_cara_display,
          MAX(rsv.archivo) AS archivo,
          MAX(rsv.estatus) AS estatus,
          MAX(rsv.arte_aprobado) AS arte_aprobado,
          MAX(rsv.fecha_testigo) AS fecha_testigo,
          MAX(rsv.imagen_testigo) AS imagen_testigo,
          MAX(rsv.instalado) AS instalado,
          MAX(rsv.tarea) AS tarea,
          MAX(rsv.APS) AS APS,
          MAX(rsv.comentario_rechazo) AS comentario_rechazo,
          MAX(sc.id) AS solicitudCarasId,
          MAX(sc.id) AS grupo,
          MAX(sc.articulo) AS articulo,
          MAX(sc.tipo) AS tipo_medio,
          MAX(sc.inicio_periodo) AS inicio_periodo,
          MAX(sc.fin_periodo) AS fin_periodo,
          MAX(cat.numero_catorcena) AS numero_catorcena,
          MAX(cat.año) AS anio_catorcena,
          COUNT(DISTINCT rsv.id) AS caras_totales,
          COALESCE(MAX(rsv.grupo_completo_id), MIN(inv.id)) as grupo_completo_id,
          MAX(tr.id) AS tarea_instalacion_id,
          MAX(tr.titulo) AS tarea_instalacion_titulo,
          MAX(tr.estatus) AS tarea_instalacion_estatus
        FROM inventarios inv
          INNER JOIN espacio_inventario epIn ON inv.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          INNER JOIN tareas tr ON tr.campania_id = cm.id
            AND tr.tipo = 'Instalación'
            AND FIND_IN_SET(rsv.id, REPLACE(tr.ids_reservas, ' ', '')) > 0
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE
          cm.id = ?
          AND rsv.deleted_at IS NULL
          AND sc.inicio_periodo <= cm.fecha_fin
          AND sc.fin_periodo >= cm.fecha_inicio
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), sc.id
        ORDER BY MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, campanaId);

      console.log('Inventario instalaciones result count:', Array.isArray(inventario) ? inventario.length : 0);

      const inventarioSerializable = serializeBigInt(inventario);

      res.json({
        success: true,
        data: inventarioSerializable,
      });
    } catch (error) {
      console.error('Error en getInventarioTestigos:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventario para instalaciones';
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

        // Eliminar registros de artes_tradicionales para estas reservas
        const deleteArtTradQuery = `
          DELETE FROM artes_tradicionales
          WHERE id_reserva IN (${placeholders})
        `;
        await prisma.$executeRawUnsafe(deleteArtTradQuery, ...reservaIds);

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

          // También eliminar artes_tradicionales de reservas del mismo grupo
          const deleteArtTradGrupoQuery = `
            DELETE FROM artes_tradicionales
            WHERE id_reserva IN (
              SELECT id FROM reservas WHERE grupo_completo_id IN (${grupoPlaceholders})
            )
          `;
          await prisma.$executeRawUnsafe(deleteArtTradGrupoQuery, ...grupoIds);
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
        const campana = await prisma.campania.findUnique({ where: { id: campanaId }, select: CAMPANIA_SAFE_SELECT });
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
      if (!archivo || typeof archivo !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Se requiere la URL del archivo',
        });
        return;
      }

      const archivoFinal = await ensureStoredFileUrl(
        archivo,
        `qeb/campana-${campanaId}/artes`,
        'image'
      );

      // Actualizar reservas directamente seleccionadas
      const updateDirectQuery = `
        UPDATE reservas
        SET archivo = ?, arte_aprobado = 'Pendiente', estatus = 'Con Arte'
        WHERE id IN (${placeholders})
      `;

      await prisma.$executeRawUnsafe(updateDirectQuery, archivoFinal, ...reservaIds);

      // Actualizar reservas del mismo grupo_completo
      if (grupoIds.length > 0) {
        const grupoPlaceholders = grupoIds.map(() => '?').join(',');
        const updateGruposQuery = `
          UPDATE reservas
          SET archivo = ?, arte_aprobado = 'Pendiente', estatus = 'Con Arte'
          WHERE grupo_completo_id IN (${grupoPlaceholders})
        `;

        await prisma.$executeRawUnsafe(updateGruposQuery, archivoFinal, ...grupoIds);
      }

      // Registrar en historial
      const campana = await prisma.campania.findUnique({ where: { id: campanaId }, select: CAMPANIA_SAFE_SELECT });
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
   * Asignar arte digital (múltiples archivos para rotación)
   */
  async assignArteDigital(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds, archivos } = req.body;
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

      if (!archivos || !Array.isArray(archivos) || archivos.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de archivos',
        });
        return;
      }

      console.log(`assignArteDigital - campanaId: ${campanaId}, reservaIds: ${reservaIds.length}, archivos: ${archivos.length}`);

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

      // Obtener todas las reservas afectadas (incluyendo las del grupo)
      let allReservaIds = [...reservaIds];
      if (grupoIds.length > 0) {
        const grupoPlaceholders = grupoIds.map(() => '?').join(',');
        const grupoReservasQuery = `SELECT id FROM reservas WHERE grupo_completo_id IN (${grupoPlaceholders})`;
        const grupoReservas = await prisma.$queryRawUnsafe<{ id: number }[]>(grupoReservasQuery, ...grupoIds);
        allReservaIds = [...new Set([...allReservaIds, ...grupoReservas.map(r => r.id)])];
      }

      // Primero, eliminar registros anteriores de imagenes_digitales para estas reservas
      const deleteOldQuery = `DELETE FROM imagenes_digitales WHERE id_reserva IN (${allReservaIds.map(() => '?').join(',')})`;
      await prisma.$executeRawUnsafe(deleteOldQuery, ...allReservaIds);

      // Subir cada archivo (a Cloudinary si está configurado, sino base64 en BD)
      const savedFiles: string[] = [];
      for (const archivo of archivos) {
        const { archivo: base64Data, spot, nombre, tipo } = archivo;

        // Extraer extensión del nombre o del tipo MIME
        let extension = nombre.split('.').pop() || 'jpg';
        if (tipo === 'video' && !['mp4', 'mov', 'webm', 'avi'].includes(extension.toLowerCase())) {
          extension = 'mp4';
        }

        // Generar nombre único para referencia
        const timestamp = Date.now();
        const uniqueFilename = `digital-${campanaId}-${timestamp}-${spot}.${extension}`;

        // Intentar subir a Cloudinary, si falla usar base64 directamente
        const resourceType = tipo === 'video' ? 'video' : 'image';
        const archivoData = await ensureStoredFileUrl(
          base64Data,
          `qeb/campana-${campanaId}/digitales`,
          resourceType
        );

        // Guardar la referencia
        savedFiles.push(archivoData);

        // Insertar registro en imagenes_digitales para cada reserva
        for (const reservaId of allReservaIds) {
          await prisma.$executeRawUnsafe(`
            INSERT INTO imagenes_digitales (id_reserva, archivo, archivo_data, comentario, aprobado_rechazado, respuesta, spot, fecha_testigo, imagen_testigo)
            VALUES (?, ?, ?, '', 'Pendiente', '', ?, CURDATE(), '')
          `, reservaId, uniqueFilename, archivoData, spot);
        }
      }

      // Actualizar el campo archivo en reservas con el primer archivo (para mostrar preview)
      const firstFileUrl = savedFiles[0] || '';
      const updateReservasQuery = `
        UPDATE reservas
        SET archivo = ?, arte_aprobado = 'Pendiente', estatus = 'Con Arte'
        WHERE id IN (${allReservaIds.map(() => '?').join(',')})
      `;
      await prisma.$executeRawUnsafe(updateReservasQuery, firstFileUrl, ...allReservaIds);

      // Registrar en historial
      const campana = await prisma.campania.findUnique({ where: { id: campanaId }, select: CAMPANIA_SAFE_SELECT });
      if (campana?.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
        if (cotizacion?.id_propuesta) {
          await prisma.historial.create({
            data: {
              tipo: 'Arte Digital',
              ref_id: cotizacion.id_propuesta,
              accion: 'Asignación',
              fecha_hora: new Date(),
              detalles: `${userName} asignó ${archivos.length} archivo(s) digital(es) a ${allReservaIds.length} reserva(s)`,
            },
          });
        }
      }

      res.json({
        success: true,
        data: {
          message: `Arte digital asignado: ${archivos.length} archivo(s) a ${allReservaIds.length} reserva(s)`,
          affected: allReservaIds.length,
          files: savedFiles,
        },
      });

      // Emitir evento WebSocket
      emitToCampana(campanaId, SOCKET_EVENTS.ARTE_SUBIDO, {
        campanaId,
        reservaIds: allReservaIds,
        tipo: 'digital',
        usuario: userName,
        archivosCount: archivos.length,
      });
    } catch (error) {
      console.error('Error en assignArteDigital:', error);
      const message = error instanceof Error ? error.message : 'Error al asignar arte digital';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Agregar archivos digitales SIN eliminar los existentes
   * Útil para editar/añadir archivos manteniendo los que ya están
   */
  async addArteDigital(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds, archivos } = req.body;
      const userName = req.user?.nombre || 'Usuario';
      const campanaId = parseInt(id);

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de reservaIds',
        });
        return;
      }

      if (!archivos || !Array.isArray(archivos) || archivos.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de archivos',
        });
        return;
      }

      // Obtener grupos de las reservas para aplicar a todo el grupo
      const placeholders = reservaIds.map(() => '?').join(',');
      const gruposQuery = `SELECT DISTINCT grupo_completo_id FROM reservas WHERE id IN (${placeholders}) AND grupo_completo_id IS NOT NULL`;
      const grupos = await prisma.$queryRawUnsafe<{ grupo_completo_id: number }[]>(gruposQuery, ...reservaIds);
      const grupoIds = grupos.map(g => g.grupo_completo_id);

      let allReservaIds = [...reservaIds];
      if (grupoIds.length > 0) {
        const grupoPlaceholders = grupoIds.map(() => '?').join(',');
        const grupoReservasQuery = `SELECT id FROM reservas WHERE grupo_completo_id IN (${grupoPlaceholders})`;
        const grupoReservas = await prisma.$queryRawUnsafe<{ id: number }[]>(grupoReservasQuery, ...grupoIds);
        allReservaIds = [...new Set([...allReservaIds, ...grupoReservas.map(r => r.id)])];
      }

      // NO eliminamos archivos existentes - solo agregamos nuevos

      // Subir cada archivo (a Cloudinary si está configurado, sino base64 en BD)
      const savedFiles: string[] = [];
      for (const archivo of archivos) {
        const { archivo: base64Data, spot, nombre, tipo } = archivo;

        // Extraer extensión del nombre o del tipo MIME
        let extension = nombre.split('.').pop() || 'jpg';
        if (tipo === 'video' && !['mp4', 'mov', 'webm', 'avi'].includes(extension.toLowerCase())) {
          extension = 'mp4';
        }

        // Generar nombre único para referencia
        const timestamp = Date.now();
        const uniqueFilename = `digital-${campanaId}-${timestamp}-${spot}.${extension}`;

        // Intentar subir a Cloudinary, si falla usar base64 directamente
        const resourceType = tipo === 'video' ? 'video' : 'image';
        const archivoData = await ensureStoredFileUrl(
          base64Data,
          `qeb/campana-${campanaId}/digitales`,
          resourceType
        );

        // Guardar la referencia
        savedFiles.push(archivoData);

        // Insertar registro en imagenes_digitales para cada reserva
        for (const reservaId of allReservaIds) {
          await prisma.$executeRawUnsafe(`
            INSERT INTO imagenes_digitales (id_reserva, archivo, archivo_data, comentario, aprobado_rechazado, respuesta, spot, fecha_testigo, imagen_testigo)
            VALUES (?, ?, ?, '', 'Pendiente', '', ?, CURDATE(), '')
          `, reservaId, uniqueFilename, archivoData, spot);
        }
      }

      // Registrar en historial
      const campana = await prisma.campania.findUnique({ where: { id: campanaId }, select: CAMPANIA_SAFE_SELECT });
      if (campana?.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
        if (cotizacion?.id_propuesta) {
          await prisma.historial.create({
            data: {
              tipo: 'Arte Digital',
              ref_id: cotizacion.id_propuesta,
              accion: 'Adición',
              fecha_hora: new Date(),
              detalles: `${userName} agregó ${archivos.length} archivo(s) digital(es) a ${allReservaIds.length} reserva(s)`,
            },
          });
        }
      }

      res.json({
        success: true,
        data: {
          message: `Arte digital agregado: ${archivos.length} archivo(s) a ${allReservaIds.length} reserva(s)`,
          affected: allReservaIds.length,
          files: savedFiles,
        },
      });

      // Emitir evento WebSocket
      emitToCampana(campanaId, SOCKET_EVENTS.ARTE_SUBIDO, {
        campanaId,
        reservaIds: allReservaIds,
        tipo: 'digital',
        usuario: userName,
        archivosCount: archivos.length,
      });
    } catch (error) {
      console.error('Error en addArteDigital:', error);
      const message = error instanceof Error ? error.message : 'Error al agregar arte digital';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Obtener imágenes digitales de una reserva
   */
  async getImagenesDigitales(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id, reservaId } = req.params;
      const campanaId = parseInt(id);

      // Soportar múltiples reserva IDs separados por coma
      const reservaIds = reservaId.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

      if (reservaIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'ID de reserva inválido',
        });
        return;
      }

      // Obtener imágenes digitales ordenadas por spot para todas las reservas
      // Usar DISTINCT para evitar duplicados si el mismo archivo está asociado a múltiples reservas
      const placeholders = reservaIds.map(() => '?').join(',');
      const imagenes = await prisma.$queryRawUnsafe<{
        id: number;
        id_reserva: number;
        archivo: string;
        archivo_data: string | null;
        comentario: string;
        aprobado_rechazado: string;
        respuesta: string;
        spot: number;
        fecha_testigo: Date;
        imagen_testigo: string;
      }[]>(`
        SELECT DISTINCT archivo, archivo_data, MIN(id) as id, MIN(id_reserva) as id_reserva,
               comentario, aprobado_rechazado, respuesta, spot, fecha_testigo, imagen_testigo
        FROM imagenes_digitales
        WHERE id_reserva IN (${placeholders})
        GROUP BY archivo, archivo_data, comentario, aprobado_rechazado, respuesta, spot, fecha_testigo, imagen_testigo
        ORDER BY spot ASC
      `, ...reservaIds);

      res.json({
        success: true,
        data: imagenes.map(img => ({
          id: img.id,
          idReserva: img.id_reserva,
          archivo: img.archivo,
          archivoData: img.archivo_data, // Base64 data URL
          comentario: img.comentario,
          estado: img.aprobado_rechazado,
          respuesta: img.respuesta,
          spot: img.spot,
          tipo: img.archivo.match(/\.(mp4|mov|webm|avi)$/i) ? 'video' : 'image',
        })),
      });
    } catch (error) {
      console.error('Error en getImagenesDigitales:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener imágenes digitales';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Obtener resumen de archivos digitales por reserva para toda la campaña
   * Devuelve cantidad de imágenes y videos por cada reserva
   */
  async getDigitalFileSummaries(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      if (isNaN(campanaId)) {
        res.status(400).json({
          success: false,
          error: 'ID de campaña inválido',
        });
        return;
      }

      // Obtener todas las reservas digitales de la campaña con conteo de archivos
      // Join path: imagenes_digitales -> reservas -> solicitudCaras -> cotizacion -> campania
      const summaries = await prisma.$queryRaw<{
        id_reserva: number;
        total_archivos: number;
        count_imagenes: number;
        count_videos: number;
      }[]>`
        SELECT
          img.id_reserva,
          COUNT(*) as total_archivos,
          SUM(CASE WHEN LOWER(img.archivo) REGEXP '\\.(jpg|jpeg|png|gif|webp|bmp)$' THEN 1 ELSE 0 END) as count_imagenes,
          SUM(CASE WHEN LOWER(img.archivo) REGEXP '\\.(mp4|mov|avi|webm|mkv|wmv)$' THEN 1 ELSE 0 END) as count_videos
        FROM imagenes_digitales img
        INNER JOIN reservas r ON r.id = img.id_reserva
        INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
        INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
        INNER JOIN campania cm ON cm.cotizacion_id = ct.id
        WHERE cm.id = ${campanaId}
        GROUP BY img.id_reserva
      `;

      res.json({
        success: true,
        data: summaries.map(s => ({
          idReserva: Number(s.id_reserva),
          totalArchivos: Number(s.total_archivos),
          countImagenes: Number(s.count_imagenes),
          countVideos: Number(s.count_videos),
        })),
      });
    } catch (error) {
      console.error('Error en getDigitalFileSummaries:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener resumen de archivos digitales';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Eliminar archivos digitales por IDs o por archivo paths + reservaIds
   * Soporta dos modos:
   * 1. Por imageIds: elimina registros específicos por ID
   * 2. Por archivos + reservaIds: elimina todos los registros que coincidan con esos archivos en esas reservas
   */
  async deleteImagenesDigitales(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { imageIds, archivos, reservaIds } = req.body;

      // Modo 2: Eliminar por archivo paths y reservaIds (para eliminar de múltiples items)
      if (archivos && Array.isArray(archivos) && archivos.length > 0 &&
          reservaIds && Array.isArray(reservaIds) && reservaIds.length > 0) {

        // Construir query para eliminar archivos que coincidan con los paths en las reservas especificadas
        const archivoPlaceholders = archivos.map(() => '?').join(',');
        const reservaPlaceholders = reservaIds.map(() => '?').join(',');
        const deleteQuery = `
          DELETE FROM imagenes_digitales
          WHERE archivo IN (${archivoPlaceholders})
          AND id_reserva IN (${reservaPlaceholders})
        `;
        await prisma.$executeRawUnsafe(deleteQuery, ...archivos, ...reservaIds);

        res.json({
          success: true,
          message: `Se eliminaron archivos digitales de ${reservaIds.length} reserva(s)`,
        });
        return;
      }

      // Modo 1: Eliminar por imageIds (comportamiento original)
      if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de imageIds, o archivos + reservaIds',
        });
        return;
      }

      const placeholders = imageIds.map(() => '?').join(',');
      const deleteQuery = `DELETE FROM imagenes_digitales WHERE id IN (${placeholders})`;
      await prisma.$executeRawUnsafe(deleteQuery, ...imageIds);

      res.json({
        success: true,
        message: `Se eliminaron ${imageIds.length} archivo(s) digital(es)`,
      });
    } catch (error) {
      console.error('Error en deleteImagenesDigitales:', error);
      const message = error instanceof Error ? error.message : 'Error al eliminar archivos digitales';
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
      const campana = await prisma.campania.findUnique({ where: { id: campanaId }, select: CAMPANIA_SAFE_SELECT });
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

      // Si es rechazo, intercambiar creador y asignado en la tarea de Revision de artes
      console.log('updateArteStatus - Status:', status, '- CampanaId:', campanaId);
      if (status === 'Rechazado') {
        console.log('updateArteStatus - Buscando tareas de Revision de artes para rotar roles...');
        // Buscar la tarea de Revision de artes que contiene estas reservas
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
          AND tipo = 'Revision de artes'
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
      // Emitir globalmente para que la página de Notificaciones/Mis Tareas se actualice (roles rotados en rechazo)
      emitToAll(SOCKET_EVENTS.TAREA_ACTUALIZADA, { campanaId, status });
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

      if (imagenTestigo && typeof imagenTestigo === 'string' && imagenTestigo.trim()) {
        const imagenTestigoUrl = await ensureStoredFileUrl(
          imagenTestigo,
          `qeb/campana-${campanaId}/testigos`,
          'image'
        );
        updateFields.push('imagen_testigo = ?');
        updateParams.push(imagenTestigoUrl);
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
      const campana = await prisma.campania.findUnique({ where: { id: campanaId }, select: CAMPANIA_SAFE_SELECT });
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

      // Buscar tareas que contengan estas reservas (excluir completadas, atendidas y canceladas)
      const tareasQuery = `
        SELECT id, titulo, tipo, estatus, ids_reservas, responsable
        FROM tareas
        WHERE campania_id = ?
        AND ids_reservas IS NOT NULL
        AND ids_reservas != ''
        AND estatus NOT IN ('Atendido', 'Cancelado', 'Completado')
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
            responsable: t.responsable,
            ids_reservas: t.ids_reservas,
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
            AND tr.estatus != 'Pendiente'
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
        archivo_testigo: t.archivo_testigo,
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

      // Validación de campos requeridos según tipo de tarea
      if (tipo === 'Impresión') {
        if (num_impresiones === undefined || num_impresiones === null || Number(num_impresiones) <= 0) {
          res.status(400).json({
            success: false,
            error: 'El número de impresiones es requerido para tareas de tipo Impresión',
          });
          return;
        }
        if (!ids_reservas) {
          res.status(400).json({
            success: false,
            error: 'Se requieren IDs de reservas para tareas de tipo Impresión',
          });
          return;
        }
      }

      if (tipo === 'Revision de artes' || tipo === 'Correccion') {
        if (!ids_reservas) {
          res.status(400).json({
            success: false,
            error: 'Se requieren IDs de reservas para tareas de Revision de artes',
          });
          return;
        }
      }

      if (tipo === 'Testigo' || tipo === 'Instalación') {
        if (!ids_reservas) {
          res.status(400).json({
            success: false,
            error: 'Se requieren IDs de reservas para tareas de Testigo/Instalación',
          });
          return;
        }
      }

      // Obtener info de la campaña para el id_propuesta
      const campana = await prisma.campania.findUnique({ where: { id: campanaId }, select: CAMPANIA_SAFE_SELECT });
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
      const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
      const fechaFinFinal = new Date(ahora);
      fechaFinFinal.setDate(fechaFinFinal.getDate() + 7);
      let estatusFinal = 'Pendiente';

      // Para Revision de artes, Impresión, Re-impresión y Programación, estatus siempre es Activo
      if (tipo === 'Revision de artes' || tipo === 'Impresión' || tipo === 'Re-impresión' || tipo === 'Programación') {
        estatusFinal = 'Activo';
      }

      // Preparar datos de impresiones como JSON para almacenar en evidencia
      let evidenciaData: string | null = null;
      let numImpresionesTotal: number | null = null;

      // DEBUG: Log de todo el body para ver qué llega
      console.log('createTarea - tipo:', tipo, 'num_impresiones:', num_impresiones, 'impresiones:', JSON.stringify(impresiones));

      if (tipo === 'Impresión' && impresiones) {
        evidenciaData = JSON.stringify({ impresiones: impresiones || {} });
        // Usar num_impresiones enviado desde el frontend directamente
        if (num_impresiones !== undefined && num_impresiones !== null) {
          numImpresionesTotal = Number(num_impresiones);
          console.log('createTarea - numImpresionesTotal asignado:', numImpresionesTotal);
        } else {
          console.log('createTarea - num_impresiones NO llegó del frontend');
        }
      }

      // Guardar num_impresiones para cualquier tipo de tarea (Recepción, etc.)
      if (numImpresionesTotal === null && num_impresiones !== undefined && num_impresiones !== null && Number(num_impresiones) > 0) {
        numImpresionesTotal = Number(num_impresiones);
      }

      if (evidencia && !evidenciaData) {
        // Usar evidencia enviada desde el frontend (ej: para Recepción Faltantes, Programación)
        // IMPORTANTE: Limpiar archivoData de la evidencia para evitar problemas de memoria y truncamiento
        // Los archivos base64/URLs son muy grandes y deben cargarse desde la API cuando se necesiten
        try {
          const evidenciaObj = JSON.parse(evidencia);
          // Backend guard: si Recepción Faltantes llega sin guia_pdf, heredarla de la última Recepción de la campaña.
          if (
            tipo === 'Recepción' &&
            evidenciaObj?.tipo === 'recepcion_faltantes' &&
            !evidenciaObj?.guia_pdf
          ) {
            try {
              const ultimaRecepcionConGuia = await prisma.tareas.findFirst({
                where: {
                  campania_id: campanaId,
                  tipo: 'Recepción',
                  evidencia: { contains: 'guia_pdf' },
                },
                orderBy: { id: 'desc' },
                select: { evidencia: true },
              });
              if (ultimaRecepcionConGuia?.evidencia) {
                const evidenciaPrev = JSON.parse(ultimaRecepcionConGuia.evidencia);
                if (evidenciaPrev?.guia_pdf) {
                  evidenciaObj.guia_pdf = evidenciaPrev.guia_pdf;
                }
              }
            } catch (inheritErr) {
              console.warn('createTarea - no se pudo heredar guia_pdf para recepcion_faltantes:', inheritErr);
            }
          }
          if (evidenciaObj.archivos && Array.isArray(evidenciaObj.archivos)) {
            // Eliminar archivoData de cada archivo para reducir el tamaño
            evidenciaObj.archivos = evidenciaObj.archivos.map((a: any) => ({
              archivo: a.archivo,
              spot: a.spot,
              tipo: a.tipo,
              // NO incluir archivoData
            }));
            evidenciaData = JSON.stringify(evidenciaObj);
          } else {
            evidenciaData = evidencia;
          }
        } catch (parseError) {
          // Si no es JSON válido, usar como está
          evidenciaData = evidencia;
        }
      }

      const tarea = await prisma.tareas.create({
        data: {
          titulo: titulo || 'Nueva tarea',
          descripcion,
          tipo: tipo || 'Producción',
          estatus: estatusFinal,
          fecha_inicio: ahora,
          fecha_fin: fechaFinFinal,
          id_responsable: responsableId,
          responsable: responsableNombre || null,
          asignado: (tipo === 'Impresión') ? (responsableNombre || null) : (asignado || responsableNombre || null),
          id_asignado: (tipo === 'Impresión') ? String(responsableId) : (id_asignado || String(responsableId)),
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
          if (tipo === 'Revision de artes') {
            tareaValue = 'En revisión';
          } else if (tipo === 'Impresión') {
            tareaValue = 'Pedido Solicitado';
          } else if (tipo === 'Recepción') {
            tareaValue = 'Por Recibir';
          } else if (tipo === 'Correccion') {
            tareaValue = 'En corrección';
          } else if (tipo === 'Testigo') {
            tareaValue = 'Pendiente testigo';
          } else if (tipo === 'Programación') {
            tareaValue = 'En programación';
          } else if (tipo === 'Orden de Programación') {
            tareaValue = 'Orden de programación';
          } else if (tipo === 'Instalación') {
            tareaValue = 'Pendiente instalación';
          } else if (tipo === 'Orden de Instalación') {
            tareaValue = 'Orden de instalación';
          } else if (tipo === 'Re-impresión') {
            tareaValue = 'Re-impresión Solicitada';
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
      // También emitir globalmente para que la página de Notificaciones/Mis Tareas se actualice
      emitToAll(SOCKET_EVENTS.TAREA_CREADA, { tareaId: tarea.id, tipo: tarea.tipo });

      // Enviar correo cuando se crea una Orden de Impresión
      if (tipo === 'Impresión') {
        const destinatarioId = parseInt(tarea.id_asignado || '0');
        if (!isNaN(destinatarioId) && destinatarioId > 0) {
          prisma.usuario.findUnique({
            where: { id: destinatarioId },
            select: { correo_electronico: true, nombre: true },
          }).then(usuarioImpresion => {
            if (usuarioImpresion?.correo_electronico && process.env.SMTP_USER && process.env.SMTP_PASS) {
              const htmlImpresion = `
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
                        <tr>
                          <td style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
                            <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">QEB</h1>
                            <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">OOH Management</p>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding: 40px;">
                            <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Nueva Orden de Impresión</h2>
                            <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 15px; line-height: 1.5;">
                              Hola <strong style="color: #374151;">${usuarioImpresion.nombre}</strong>, se ha creado una nueva orden de impresión.
                            </p>

                            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
                              <tr>
                                <td style="padding: 20px;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td style="padding-bottom: 12px;">
                                        <span style="display: inline-block; background-color: #8b5cf6; color: #ffffff; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">Orden de Impresión</span>
                                      </td>
                                    </tr>
                                    <tr>
                                      <td>
                                        <h3 style="color: #1f2937; margin: 0 0 8px 0; font-size: 18px; font-weight: 600;">${titulo || 'Orden de Impresión'}</h3>
                                        <p style="color: #6b7280; margin: 0; font-size: 14px; line-height: 1.5;">${contenido || descripcion || ''}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>

                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 28px;">
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td width="24" valign="top">
                                        <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">📊</div>
                                      </td>
                                      <td style="padding-left: 12px;">
                                        <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Campaña</p>
                                        <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${campanaNombre}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td width="24" valign="top">
                                        <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">🏢</div>
                                      </td>
                                      <td style="padding-left: 12px;">
                                        <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Proveedor</p>
                                        <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${nombre_proveedores || 'No especificado'}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td width="24" valign="top">
                                        <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">🖨️</div>
                                      </td>
                                      <td style="padding-left: 12px;">
                                        <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Cantidad de Impresiones</p>
                                        <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${numImpresionesTotal || num_impresiones || 0}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td width="24" valign="top">
                                        <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">📅</div>
                                      </td>
                                      <td style="padding-left: 12px;">
                                        <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Fecha Estimada de Entrega</p>
                                        <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${fechaFinFinal.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 12px 0;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td width="24" valign="top">
                                        <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">✨</div>
                                      </td>
                                      <td style="padding-left: 12px;">
                                        <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Creado por</p>
                                        <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${responsableNombre}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>

                            <table width="100%" cellpadding="0" cellspacing="0">
                              <tr>
                                <td align="center">
                                  <a href="https://app.qeb.mx/campanas/${campanaId}/tareas" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">Ver Orden</a>
                                </td>
                              </tr>
                            </table>

                          </td>
                        </tr>
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

              transporter.sendMail({
                from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
                to: usuarioImpresion.correo_electronico,
                subject: `Orden de Impresión - ${campanaNombre}`,
                html: htmlImpresion,
              }).then(() => {
                console.log('Correo de orden de impresión enviado a:', usuarioImpresion.correo_electronico);
                prisma.correos_enviados.create({
                  data: {
                    remitente: 'no-reply@qeb.mx',
                    destinatario: usuarioImpresion.correo_electronico!,
                    asunto: `Orden de Impresión - ${campanaNombre}`,
                    cuerpo: htmlImpresion,
                  },
                }).catch((err: any) => console.error('Error guardando correo de orden de impresión:', err));
              }).catch((emailError: any) => {
                console.error('Error enviando correo de orden de impresión:', emailError);
              });
            }
          }).catch((err: any) => console.error('Error buscando usuario para correo de impresión:', err));
        }
      }

      // Enviar correo al asignado de forma asíncrona (no bloquea la respuesta)
      if ((tipo === 'Revision de artes' || tipo === 'Instalación' || tipo === 'Impresión') && id_asignado) {
        const asignadoIdNum = parseInt(id_asignado);
        if (!isNaN(asignadoIdNum)) {
          prisma.usuario.findUnique({
            where: { id: asignadoIdNum },
            select: { correo_electronico: true, nombre: true },
          }).then(usuarioAsignado => {
            if (usuarioAsignado?.correo_electronico && process.env.SMTP_USER && process.env.SMTP_PASS) {
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

                        <!--Main Content-->
                        <tr>
                          <td style="padding: 40px;">
                            
                            <!-- Title -->
                            <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Nueva Tarea Asignada</h2>
                            <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 15px; line-height: 1.5;">
                              Hola <strong style="color: #374151;">${usuarioAsignado.nombre}</strong>, se te ha asignado una nueva tarea.
                            </p>

                            <!-- Task Card -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
                              <tr>
                                <td style="padding: 20px;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td style="padding-bottom: 12px;">
                                        <span style="display: inline-block; background-color: #8b5cf6; color: #ffffff; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">${tipo}</span>
                                      </td>
                                    </tr>
                                    <tr>
                                      <td>
                                        <h3 style="color: #1f2937; margin: 0 0 8px 0; font-size: 18px; font-weight: 600;">${titulo || 'Nueva tarea'}</h3>
                                        <p style="color: #6b7280; margin: 0; font-size: 14px; line-height: 1.5;">${contenido || descripcion || ''}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>

                            <!-- Info Grid -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 28px;">
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td width="24" valign="top">
                                        <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">📊</div>
                                      </td>
                                      <td style="padding-left: 12px;">
                                        <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Campaña</p>
                                        <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${campanaNombre}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              
                              <tr>
                                <td style="padding: 12px 0;">
                                  <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td width="24" valign="top">
                                        <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">✨</div>
                                      </td>
                                      <td style="padding-left: 12px;">
                                        <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Creado por</p>
                                        <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${responsableNombre}</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>

                            <!-- CTA Button -->
                            <table width="100%" cellpadding="0" cellspacing="0">
                              <tr>
                                <td align="center">
                                  <a href="https://app.qeb.mx/campanas/${campanaId}/tareas" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">Ver Tarea</a>
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

              transporter.sendMail({
                from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
                to: usuarioAsignado.correo_electronico,
                subject: `Nueva tarea: ${titulo || tipo}`,
                html: htmlBody,
              }).then(() => {
                console.log('Correo de tarea enviado a:', usuarioAsignado.correo_electronico);
                // Guardar en correos_enviados
                prisma.correos_enviados.create({
                  data: {
                    remitente: 'no-reply@qeb.mx',
                    destinatario: usuarioAsignado.correo_electronico,
                    asunto: `Nueva tarea: ${titulo || tipo}`,
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
      if (archivo !== undefined) {
        if (typeof archivo === 'string' && archivo.trim()) {
          updateData.archivo = await ensureStoredFileUrl(
            archivo,
            `qeb/campana-${id}/artes`,
            'image'
          );
        } else {
          updateData.archivo = archivo;
        }
      }
      if (evidencia !== undefined) updateData.evidencia = evidencia;
      if (archivo_testigo !== undefined) {
        if (typeof archivo_testigo === 'string' && archivo_testigo.trim()) {
          updateData.archivo_testigo = await ensureStoredFileUrl(
            archivo_testigo,
            `qeb/campana-${id}/testigos`,
            'image'
          );
        } else {
          updateData.archivo_testigo = archivo_testigo;
        }
      }

      const tarea = await prisma.tareas.update({
        where: { id: parseInt(tareaId) },
        data: updateData,
      });

      // Si es una tarea de Programación que se completa y tiene orden padre, auto-finalizar la orden
      if (tarea.tipo === 'Programación' && estatus === 'Completado' && tarea.evidencia) {
        try {
          const ev = JSON.parse(tarea.evidencia);
          if (ev.orden_programacion_id) {
            await prisma.tareas.update({
              where: { id: ev.orden_programacion_id },
              data: { estatus: 'Finalizada' },
            });
            console.log(`Orden de Programación ${ev.orden_programacion_id} auto-finalizada`);

            // Emitir evento WebSocket para la orden actualizadaa
            if (tarea.campania_id) {
              emitToCampana(tarea.campania_id, SOCKET_EVENTS.TAREA_ACTUALIZADA, {
                tareaId: ev.orden_programacion_id,
                campanaId: tarea.campania_id,
                estatus: 'Finalizada',
              });
            }
          }
        } catch (e) {
          console.error('Error auto-finalizando orden de programación:', e);
        }
      }

      // Si es una tarea de Instalación que se completa y tiene orden padre, auto-finalizar la orden
      if (tarea.tipo === 'Instalación' && estatus === 'Completado' && tarea.evidencia) {
        try {
          const ev = JSON.parse(tarea.evidencia);
          if (ev.orden_instalacion_id) {
            await prisma.tareas.update({
              where: { id: ev.orden_instalacion_id },
              data: { estatus: 'Finalizada' },
            });
            console.log(`Orden de Instalación ${ev.orden_instalacion_id} auto-finalizada`);

            // Emitir evento WebSocket para la orden actualizada
            if (tarea.campania_id) {
              emitToCampana(tarea.campania_id, SOCKET_EVENTS.TAREA_ACTUALIZADA, {
                tareaId: ev.orden_instalacion_id,
                campanaId: tarea.campania_id,
                estatus: 'Finalizada',
              });
            }
          }
        } catch (e) {
          console.error('Error auto-finalizando orden de instalación:', e);
        }
      }

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

      // Si es tarea de ajuste y se finaliza, verificar si todas las hermanas ya están finalizadas
      if (
        ['Atendido', 'Completado', 'Finalizada'].includes(tarea.estatus || '') &&
        ['Ajuste Cto Cliente', 'Ajuste de Caras'].includes(tarea.tipo || '') &&
        tarea.id_propuesta
      ) {
        const tareasHermanas = await prisma.tareas.findMany({
          where: {
            id_propuesta: tarea.id_propuesta,
            tipo: tarea.tipo,
          },
          select: { id: true, estatus: true },
        });

        const todasFinalizadas = tareasHermanas.every(t =>
          ['Atendido', 'Completado', 'Cancelado', 'Finalizada'].includes(t.estatus || '')
        );

        if (todasFinalizadas) {
          const { count } = await prisma.propuesta.updateMany({
            where: { id: parseInt(tarea.id_propuesta), status: { not: 'Atendida' } },
            data: { status: 'Atendida', updated_at: new Date() },
          });

          // Si count === 0 ya estaba en "Atendida" (cambio manual previo), no duplicar notificaciónn
          if (count === 0) return;

          const propuestaAtendida = await prisma.propuesta.findUnique({
            where: { id: parseInt(tarea.id_propuesta) },
            select: { solicitud_id: true },
          });

          const cotizacionAjuste = await prisma.cotizacion.findFirst({
            where: { id_propuesta: parseInt(tarea.id_propuesta) },
            select: { nombre_campania: true },
          });
          const nombreCampaniaAjuste = cotizacionAjuste?.nombre_campania || 'Propuesta';

          // Notificar al creador al cambiar el status
          if (propuestaAtendida?.solicitud_id) {
            const solicitudCreador = await prisma.solicitud.findUnique({
              where: { id: propuestaAtendida.solicitud_id },
              select: { usuario_id: true },
            });
            if (solicitudCreador?.usuario_id) {
              const nowNotif = new Date();
              await prisma.tareas.create({
                data: {
                  titulo: `Ajuste completado: ${nombreCampaniaAjuste}`,
                  descripcion: 'Todos los ajustes han sido atendidos. El estado de la propuesta cambió a Atendida.',
                  tipo: 'Notificación',
                  estatus: 'Pendiente',
                  id_responsable: solicitudCreador.usuario_id,
                  responsable: '',
                  id_solicitud: tarea.id_solicitud || '',
                  id_propuesta: tarea.id_propuesta,
                  campania_id: tarea.campania_id,
                  fecha_inicio: nowNotif,
                  fecha_fin: new Date(nowNotif.getTime() + 24 * 60 * 60 * 1000),
                  asignado: req.user?.nombre || 'Usuario',
                  id_asignado: (req.user?.userId || 0).toString(),
                },
              });

              // Enviar correo al creador
              const creador = await prisma.usuario.findUnique({
                where: { id: solicitudCreador.usuario_id },
                select: { nombre: true, correo_electronico: true },
              });
              if (creador?.correo_electronico) {
                const nombrePropuesta = nombreCampaniaAjuste;
                const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
                <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
                    <tr><td align="center">
                      <table width="500" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                        <tr><td style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
                          <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700;">QEB</h1>
                          <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">OOH Management</p>
                        </td></tr>
                        <tr><td style="padding: 40px;">
                          <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Ajuste Completado</h2>
                          <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 15px; line-height: 1.5;">
                            Hola <strong style="color: #374151;">${creador.nombre}</strong>, todos los ajustes de la siguiente propuesta han sido atendidos.
                          </p>
                          <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
                            <tr><td style="padding: 20px;">
                              <span style="display: inline-block; background-color: #10b981; color: #ffffff; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">Atendida</span>
                              <h3 style="color: #1f2937; margin: 8px 0; font-size: 18px; font-weight: 600;">${nombrePropuesta}</h3>
                            </td></tr>
                          </table>
                          <table width="100%" cellpadding="0" cellspacing="0">
                            <tr><td align="center">
                              <a href="https://app.qeb.mx/propuestas?viewId=${tarea.id_propuesta}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">Ver Propuesta</a>
                            </td></tr>
                          </table>
                        </td></tr>
                        <tr><td style="background-color: #1f2937; padding: 24px 40px; text-align: center;">
                          <p style="color: #9ca3af; font-size: 12px; margin: 0;">Mensaje automático del sistema QEB.</p>
                          <p style="color: #6b7280; font-size: 11px; margin: 8px 0 0 0;">© ${new Date().getFullYear()} QEB OOH Management</p>
                        </td></tr>
                      </table>
                    </td></tr>
                  </table>
                </body></html>`;

                transporter.sendMail({
                  from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
                  to: creador.correo_electronico,
                  subject: `Ajuste completado: ${nombrePropuesta}`,
                  html: htmlBody,
                }).then(() => {
                  prisma.correos_enviados.create({
                    data: {
                      remitente: 'no-reply@qeb.mx',
                      destinatario: creador.correo_electronico!,
                      asunto: `Ajuste completado: ${nombrePropuesta}`,
                      cuerpo: htmlBody,
                    },
                  }).catch((err: any) => console.error('Error guardando correo ajuste completado:', err));
                }).catch((err: any) => console.error('Error enviando correo ajuste completado:', err));
              }
            }
          }
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
      // También emitir globalmente para que la página de Notificaciones/Mis Tareas se actualice
      emitToAll(SOCKET_EVENTS.TAREA_ACTUALIZADA, { tareaId: tarea.id });

      // Notificar al asignado por correo cuando la tarea pasa a "Atendido"
      // (excluir tipos de ajuste: su notificación se envía una sola vez al cambiar el status)
      if (['Atendido', 'Finalizada'].includes(estatus || '') && tarea.id_asignado && !['Ajuste Cto Cliente', 'Ajuste de Caras'].includes(tarea.tipo || '')) {
        const userName = req.user?.nombre || 'Usuario';
        const asignadoId = parseInt(tarea.id_asignado);
        if (!isNaN(asignadoId)) prisma.usuario.findUnique({ where: { id: asignadoId } })
          .then((responsable: any) => {
            if (responsable?.correo_electronico) {
              const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
              <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
                  <tr><td align="center">
                    <table width="500" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                      <tr><td style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
                        <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700;">QEB</h1>
                        <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">OOH Management</p>
                      </td></tr>
                      <tr><td style="padding: 40px;">
                        <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Tarea Atendida</h2>
                        <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 15px; line-height: 1.5;">
                          Hola <strong style="color: #374151;">${responsable.nombre}</strong>, la siguiente tarea ha sido marcada como <strong>Atendida</strong> por <strong>${userName}</strong>.
                        </p>
                        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
                          <tr><td style="padding: 20px;">
                            <span style="display: inline-block; background-color: #10b981; color: #ffffff; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">Atendido</span>
                            <h3 style="color: #1f2937; margin: 8px 0; font-size: 18px; font-weight: 600;">${tarea.titulo}</h3>
                            <p style="color: #6b7280; margin: 0; font-size: 14px;">${tarea.tipo || ''}</p>
                          </td></tr>
                        </table>
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr><td align="center">
                            <a href="https://app.qeb.mx/campanas/${tarea.campania_id}/tareas" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">Ver Tarea</a>
                          </td></tr>
                        </table>
                      </td></tr>
                      <tr><td style="background-color: #1f2937; padding: 24px 40px; text-align: center;">
                        <p style="color: #9ca3af; font-size: 12px; margin: 0;">Mensaje automático del sistema QEB.</p>
                        <p style="color: #6b7280; font-size: 11px; margin: 8px 0 0 0;">© ${new Date().getFullYear()} QEB OOH Management</p>
                      </td></tr>
                    </table>
                  </td></tr>
                </table>
              </body></html>`;

              transporter.sendMail({
                from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
                to: responsable.correo_electronico,
                subject: `Tarea atendida: ${tarea.titulo || tarea.tipo}`,
                html: htmlBody,
              }).then(() => {
                console.log('Correo de tarea atendida enviado a:', responsable.correo_electronico);
                prisma.correos_enviados.create({
                  data: {
                    remitente: 'no-reply@qeb.mx',
                    destinatario: responsable.correo_electronico,
                    asunto: `Tarea atendida: ${tarea.titulo || tarea.tipo}`,
                    cuerpo: htmlBody,
                  },
                }).catch((err: any) => console.error('Error guardando correo enviado:', err));
              }).catch((emailError: any) => {
                console.error('Error enviando correo de tarea atendida:', emailError);
              });
            }
          }).catch((err: any) => console.error('Error buscando responsable para correo:', err));
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

  /**
   * Enviar una Orden de Programación: crea tarea hija "Programación" para Operaciones
   */
  async enviarOrdenProgramacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id, tareaId } = req.params;
      const campanaId = parseInt(id);
      const tareaIdNum = parseInt(tareaId);

      // Buscar la orden de programación
      const orden = await prisma.tareas.findUnique({
        where: { id: tareaIdNum },
      });

      if (!orden) {
        res.status(404).json({ success: false, error: 'Orden de Programación no encontrada' });
        return;
      }

      if (orden.tipo !== 'Orden de Programación') {
        res.status(400).json({ success: false, error: 'La tarea no es de tipo Orden de Programación' });
        return;
      }

      if (orden.estatus !== 'Pendiente') {
        res.status(400).json({ success: false, error: 'La orden ya fue enviada' });
        return;
      }

      // Parsear evidencia de la orden
      let evidenciaOrden: any = {};
      try {
        if (orden.evidencia) {
          evidenciaOrden = JSON.parse(orden.evidencia);
        }
      } catch (e) {
        console.error('Error parsing orden evidencia:', e);
      }

      // Crear tarea hija de tipo "Programación"
      const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
      const childEvidencia = JSON.stringify({
        ...evidenciaOrden,
        programados: {},
        orden_programacion_id: tareaIdNum,
      });

      const tareaProgramacion = await prisma.tareas.create({
        data: {
          titulo: orden.titulo || 'Programación',
          descripcion: orden.descripcion || null,
          tipo: 'Programación',
          estatus: 'Activo',
          fecha_inicio: ahora,
          fecha_fin: orden.fecha_fin,
          id_responsable: req.user?.userId || 0,
          responsable: req.user?.nombre || '',
          asignado: orden.asignado || null,
          id_asignado: orden.id_asignado || null,
          id_solicitud: orden.id_solicitud || '',
          id_propuesta: orden.id_propuesta || '',
          campania_id: campanaId,
          ids_reservas: orden.ids_reservas || null,
          listado_inventario: orden.listado_inventario || null,
          evidencia: childEvidencia,
        },
      });

      // Actualizar reservas: tarea = 'En programación'
      if (orden.ids_reservas) {
        const reservaIdArray = orden.ids_reservas.split(',').map((id: string) => parseInt(id.trim())).filter((id: number) => !isNaN(id));
        if (reservaIdArray.length > 0) {
          const placeholders = reservaIdArray.map(() => '?').join(',');
          await prisma.$executeRawUnsafe(
            `UPDATE reservas SET tarea = ? WHERE id IN (${placeholders})`,
            'En programación',
            ...reservaIdArray
          );
        }
      }

      // Actualizar la orden: estatus = 'Enviada', agregar ID de la tarea hija
      const ordenEvidenciaActualizada = JSON.stringify({
        ...evidenciaOrden,
        tarea_programacion_id: tareaProgramacion.id,
      });

      await prisma.tareas.update({
        where: { id: tareaIdNum },
        data: {
          estatus: 'Enviada',
          evidencia: ordenEvidenciaActualizada,
        },
      });

      res.json({
        success: true,
        data: {
          orden: { id: tareaIdNum, estatus: 'Enviada' },
          programacion: { id: tareaProgramacion.id, estatus: 'Activo' },
        },
      });

      // Emitir eventos WebSocket
      emitToCampana(campanaId, SOCKET_EVENTS.TAREA_ACTUALIZADA, {
        tareaId: tareaIdNum,
        campanaId,
        estatus: 'Enviada',
      });
      emitToCampana(campanaId, SOCKET_EVENTS.TAREA_CREADA, {
        tareaId: tareaProgramacion.id,
        campanaId,
        tipo: 'Programación',
        titulo: tareaProgramacion.titulo,
      });
      emitToAll(SOCKET_EVENTS.TAREA_CREADA, { tareaId: tareaProgramacion.id, tipo: 'Programación' });

    } catch (error) {
      console.error('Error en enviarOrdenProgramacion:', error);
      const message = error instanceof Error ? error.message : 'Error al enviar orden de programación';
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * Activar una Orden de Instalación: crea tarea hija "Instalación" para Operaciones
   */
  async activarOrdenInstalacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id, tareaId } = req.params;
      const campanaId = parseInt(id);
      const tareaIdNum = parseInt(tareaId);

      // Buscar la orden de instalación
      const orden = await prisma.tareas.findUnique({
        where: { id: tareaIdNum },
      });

      if (!orden) {
        res.status(404).json({ success: false, error: 'Orden de Instalación no encontrada' });
        return;
      }

      if (orden.tipo !== 'Orden de Instalación') {
        res.status(400).json({ success: false, error: 'La tarea no es de tipo Orden de Instalación' });
        return;
      }

      if (orden.estatus !== 'Pendiente') {
        res.status(400).json({ success: false, error: 'La orden ya fue activada' });
        return;
      }

      // Parsear evidencia de la orden
      let evidenciaOrden: any = {};
      try {
        if (orden.evidencia) {
          evidenciaOrden = JSON.parse(orden.evidencia);
        }
      } catch (e) {
        console.error('Error parsing orden evidencia:', e);
      }

      // Crear tarea hija de tipo "Instalación"
      const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
      const childEvidencia = JSON.stringify({
        ...evidenciaOrden,
        orden_instalacion_id: tareaIdNum,
      });

      const tareaInstalacion = await prisma.tareas.create({
        data: {
          titulo: orden.titulo || 'Instalación',
          descripcion: orden.descripcion || null,
          tipo: 'Instalación',
          estatus: 'Activo',
          fecha_inicio: ahora,
          fecha_fin: orden.fecha_fin,
          id_responsable: req.user?.userId || 0,
          responsable: req.user?.nombre || '',
          asignado: orden.asignado || null,
          id_asignado: orden.id_asignado || null,
          id_solicitud: orden.id_solicitud || '',
          id_propuesta: orden.id_propuesta || '',
          campania_id: campanaId,
          ids_reservas: orden.ids_reservas || null,
          listado_inventario: orden.listado_inventario || null,
          evidencia: childEvidencia,
        },
      });

      // Actualizar reservas: tarea = 'Pendiente instalación'
      if (orden.ids_reservas) {
        const reservaIdArray = orden.ids_reservas.split(',').map((id: string) => parseInt(id.trim())).filter((id: number) => !isNaN(id));
        if (reservaIdArray.length > 0) {
          const placeholders = reservaIdArray.map(() => '?').join(',');
          await prisma.$executeRawUnsafe(
            `UPDATE reservas SET tarea = ? WHERE id IN (${placeholders})`,
            'Pendiente instalación',
            ...reservaIdArray
          );
        }
      }

      // Actualizar la orden: estatus = 'Activada', agregar ID de la tarea hija
      const ordenEvidenciaActualizada = JSON.stringify({
        ...evidenciaOrden,
        tarea_instalacion_id: tareaInstalacion.id,
      });

      await prisma.tareas.update({
        where: { id: tareaIdNum },
        data: {
          estatus: 'Activada',
          evidencia: ordenEvidenciaActualizada,
        },
      });

      res.json({
        success: true,
        data: {
          orden: { id: tareaIdNum, estatus: 'Activada' },
          instalacion: { id: tareaInstalacion.id, estatus: 'Activo' },
        },
      });

      // Emitir eventos WebSocket
      emitToCampana(campanaId, SOCKET_EVENTS.TAREA_ACTUALIZADA, {
        tareaId: tareaIdNum,
        campanaId,
        estatus: 'Activada',
      });
      emitToCampana(campanaId, SOCKET_EVENTS.TAREA_CREADA, {
        tareaId: tareaInstalacion.id,
        campanaId,
        tipo: 'Instalación',
        titulo: tareaInstalacion.titulo,
      });
      emitToAll(SOCKET_EVENTS.TAREA_CREADA, { tareaId: tareaInstalacion.id, tipo: 'Instalación' });

    } catch (error) {
      console.error('Error en activarOrdenInstalacion:', error);
      const message = error instanceof Error ? error.message : 'Error al activar orden de instalación';
      res.status(500).json({ success: false, error: message });
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
          // Usar query parametrizada para evitar SQL injection
          const placeholders = reservaIds.map(() => '?').join(',');
          await prisma.$executeRawUnsafe(
            `UPDATE reservas SET tarea = NULL WHERE id IN (${placeholders})`,
            ...reservaIds
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

  async markPostedToSAP(req: AuthRequest, res: Response): Promise<void> {
    try {
      const campanaId = parseInt(req.params.id);
      await prisma.$queryRawUnsafe('UPDATE campania SET posted_to_sap = 1 WHERE id = ?', campanaId);
      res.json({ success: true });
    } catch (error) {
      console.error('Error en markPostedToSAP:', error);
      res.status(500).json({ success: false, error: 'Error al marcar como enviado a SAP' });
    }
  }

  async markPostedAPS(req: AuthRequest, res: Response): Promise<void> {
    try {
      const campanaId = parseInt(req.params.id);
      const { aps } = req.body as { aps: number[] };

      const current = await prisma.$queryRawUnsafe<any[]>(
        'SELECT posted_aps FROM campania WHERE id = ?', campanaId
      );
      const existing: number[] = JSON.parse(current[0]?.posted_aps || '[]');
      const merged = Array.from(new Set([...existing, ...aps]));

      await prisma.$queryRawUnsafe(
        'UPDATE campania SET posted_aps = ? WHERE id = ?',
        JSON.stringify(merged), campanaId
      );
      emitToCampana(campanaId, SOCKET_EVENTS.CAMPANA_APS_POSTED, { campanaId, posted_aps: merged });
      res.json({ success: true, posted_aps: merged });
    } catch (error) {
      console.error('Error en markPostedAPS:', error);
      res.status(500).json({ success: false, error: 'Error al marcar APS como enviados' });
    }
  }

  async assignAPS(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { inventarioIds, campanaId, solicitudCarasIds, rsvIds } = req.body;
      const userId = req.user?.userId || 0;
      const userName = req.user?.nombre || 'Usuario';

      const hasInventario = inventarioIds && Array.isArray(inventarioIds) && inventarioIds.length > 0;
      const hasIM = solicitudCarasIds && Array.isArray(solicitudCarasIds) && solicitudCarasIds.length > 0;
      const hasRsvIds = rsvIds && Array.isArray(rsvIds) && rsvIds.length > 0;

      if (!hasInventario && !hasIM) {
        res.status(400).json({
          success: false,
          error: 'Se requiere un array de inventarioIds o solicitudCarasIds',
        });
        return;
      }

      console.log('assignAPS - inventarioIds recibidos:', inventarioIds, '| solicitudCarasIds:', solicitudCarasIds);

      // Paso 1: Obtener el siguiente número APS
      const maxAPSResult = await prisma.$queryRaw<{ maxAPS: bigint | null }[]>`
        SELECT IFNULL(MAX(CAST(APS AS UNSIGNED)), 0) as maxAPS FROM reservas
      `;
      const newAPS = Number(maxAPSResult[0]?.maxAPS || 0) + 1;
      console.log('assignAPS - nuevo APS:', newAPS);

      // Paso 2 y 3: Procesar artículos con inventario (flujo normal)
      if (hasInventario) {
        if (hasRsvIds) {
          // Usar rsvIds directos para actualizar solo las reservas seleccionadas
          const rsvPlaceholders = rsvIds.map(() => '?').join(',');

          // Obtener grupo_completo_id de las reservas seleccionadas
          const gruposQuery = `
            SELECT DISTINCT grupo_completo_id
            FROM reservas
            WHERE id IN (${rsvPlaceholders})
            AND grupo_completo_id IS NOT NULL
          `;
          const grupos = await prisma.$queryRawUnsafe<{ grupo_completo_id: number }[]>(gruposQuery, ...rsvIds);
          const grupoIds = grupos.map(g => g.grupo_completo_id);
          console.log('assignAPS - grupos encontrados:', grupoIds);

          // Actualizar solo las reservas seleccionadas
          const updateDirectQuery = `
            UPDATE reservas
            SET APS = ?
            WHERE id IN (${rsvPlaceholders})
            AND (APS IS NULL OR APS = 0)
          `;
          await prisma.$executeRawUnsafe(updateDirectQuery, newAPS, ...rsvIds);
          console.log('assignAPS - actualizadas reservas directas por rsvIds');

          // Actualizar reservas del mismo grupo_completo (si hay grupos)
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
        } else {
          // Fallback: comportamiento original por inventarioIds (compatibilidad)
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
          console.log('assignAPS - grupos encontrados (fallback):', grupoIds);

          const updateDirectQuery = `
            UPDATE reservas r
            JOIN espacio_inventario ei ON r.inventario_id = ei.id
            SET r.APS = ?
            WHERE ei.inventario_id IN (${placeholders})
            AND (r.APS IS NULL OR r.APS = 0)
          `;

          await prisma.$executeRawUnsafe(updateDirectQuery, newAPS, ...inventarioIds);
          console.log('assignAPS - actualizadas reservas directas (fallback)');

          // Actualizar reservas del mismo grupo_completo (si hay grupos)
          if (grupoIds.length > 0) {
            const grupoPlaceholders = grupoIds.map(() => '?').join(',');
            const updateGruposQuery = `
              UPDATE reservas
              SET APS = ?
              WHERE grupo_completo_id IN (${grupoPlaceholders})
              AND (APS IS NULL OR APS = 0)
            `;

            await prisma.$executeRawUnsafe(updateGruposQuery, newAPS, ...grupoIds);
            console.log('assignAPS - actualizadas reservas de grupos (fallback)');
          }
        }
      }

      // Paso 2b: Procesar artículos IM (sin inventario) — crear reservas virtuales con APS
      if (hasIM) {
        // Obtener info de campaña para el calendario_id y cliente_id
        const campanaInfo = await prisma.$queryRawUnsafe<any[]>(`
          SELECT cm.id, ct.id as cotizacion_id, s.cliente_id, s.id as solicitud_id
          FROM campania cm
            INNER JOIN cotizacion ct ON ct.id = cm.cotizacion_id
            INNER JOIN propuesta p ON p.id = ct.id_propuesta
            INNER JOIN solicitud s ON s.id = p.solicitud_id
          WHERE cm.id = ?
        `, parseInt(campanaId));

        const clienteId = campanaInfo[0]?.cliente_id || 0;

        for (const scId of solicitudCarasIds) {
          // Verificar que no exista ya una reserva para este solicitudCaras IM
          const existingReserva = await prisma.$queryRawUnsafe<any[]>(
            'SELECT id FROM reservas WHERE solicitudCaras_id = ? AND deleted_at IS NULL LIMIT 1',
            scId
          );

          if (existingReserva.length === 0) {
            // Crear reserva virtual para artículo IM (inventario_id = 0, sin inventario real)
            await prisma.$executeRawUnsafe(`
              INSERT INTO reservas (inventario_id, calendario_id, cliente_id, fecha_reserva, solicitudCaras_id, estatus, arte_aprobado, comentario_rechazo, estatus_original, fecha_testigo, imagen_testigo, instalado, APS, tarea)
              VALUES (0, 0, ?, NOW(), ?, 'Impresión', '', '', '', '1970-01-01', '', 0, ?, '')
            `, clienteId, scId, newAPS);
            console.log(`assignAPS - creada reserva IM para solicitudCaras ${scId}`);
          } else {
            // Ya existe reserva, solo actualizar APS
            await prisma.$executeRawUnsafe(
              'UPDATE reservas SET APS = ? WHERE solicitudCaras_id = ? AND deleted_at IS NULL AND (APS IS NULL OR APS = 0)',
              newAPS, scId
            );
            console.log(`assignAPS - actualizada reserva existente para solicitudCaras ${scId}`);
          }
        }
      }

      const totalItems = (hasInventario ? inventarioIds.length : 0) + (hasIM ? solicitudCarasIds.length : 0);

      // Paso 5: Crear notificaciones para los involucrados
      let campana = null;
      let propuesta = null;
      let solicitud = null;

      if (campanaId) {
        campana = await prisma.campania.findUnique({ where: { id: parseInt(campanaId) }, select: CAMPANIA_SAFE_SELECT });
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
      const descripcionNotificacion = `${userName} asignó APS #${newAPS} a ${totalItems} ubicación(es)`;

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
            detalles: `${userName} asignó APS #${newAPS} a ${totalItems} ubicación(es)`,
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
        SELECT url, nombre, SUM(uso_count) as uso_count FROM (
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
          UNION ALL
          SELECT DISTINCT
            at2.archivo as url,
            SUBSTRING_INDEX(at2.archivo, '/', -1) as nombre,
            COUNT(*) as uso_count
          FROM artes_tradicionales at2
          JOIN reservas r2 ON r2.id = at2.id_reserva
          JOIN solicitudCaras sc2 ON sc2.id = r2.solicitudCaras_id
          JOIN cotizacion ct2 ON sc2.idquote = ct2.id_propuesta
          JOIN campania cm2 ON cm2.cotizacion_id = ct2.id
          WHERE cm2.id = ?
          GROUP BY at2.archivo
        ) combined
        GROUP BY url, nombre
        ORDER BY uso_count DESC
      `;

      const artes = await prisma.$queryRawUnsafe<{ url: string; nombre: string; uso_count: bigint }[]>(query, parseInt(id), parseInt(id));

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

// Obtener lista de usuarios para asignación (filtrado por equipo)
  async getUsuarios(req: AuthRequest, res: Response): Promise<void> {
    try {
      const filterByTeam = req.query.filterByTeam !== 'false'; // true por defecto
      const userId = req.user?.userId;

      let teamMemberIds: number[] = [];

      // Si filterByTeam es true, obtener los compañeros de equipo del usuario actual
      if (filterByTeam && userId) {
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

      // Si hay filtro por equipo y el usuario tiene equipos, filtrar por miembros
      let usuarios: { id: number; nombre: string }[];
      if (filterByTeam && teamMemberIds.length > 0) {
        usuarios = await prisma.usuario.findMany({
          where: {
            deleted_at: null,
            id: { in: teamMemberIds },
          },
          select: {
            id: true,
            nombre: true,
          },
          orderBy: { nombre: 'asc' },
        });
      } else {
        usuarios = await prisma.usuario.findMany({
          where: {
            deleted_at: null,
          },
          select: {
            id: true,
            nombre: true,
          },
          orderBy: { nombre: 'asc' },
        });
      }

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
          MIN(inv.plaza) AS plaza,
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
          CASE
            WHEN sc.cortesia = 1 THEN 'CORTESIA'
            WHEN sc.articulo LIKE 'IN%' THEN 'INTERCAMBIO'
            ELSE 'BONIFICACION'
          END AS negociacion,
          sc.bonificacion AS caras,
          0 AS tarifa,
          0 AS monto_total,
          cm.id AS campania_id,
          sc.id AS grupo_id,
          'bonificacion' AS tipo_fila,
          MIN(inv.tradicional_digital) AS tradicional_digital
        FROM campania cm
          LEFT JOIN cliente ON cliente.id = cm.cliente_id OR cliente.CUIC = cm.cliente_id
          INNER JOIN cotizacion ct ON ct.id = cm.cotizacion_id
          INNER JOIN propuesta pr ON pr.id = ct.id_propuesta
          INNER JOIN solicitud sol ON sol.id = pr.solicitud_id
          INNER JOIN solicitudCaras sc ON sc.idquote = ct.id_propuesta
          INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id
          INNER JOIN espacio_inventario esInv ON esInv.id = rsv.inventario_id
          INNER JOIN inventarios inv ON inv.id = esInv.inventario_id
        WHERE rsv.deleted_at IS NULL
          AND rsv.estatus NOT IN ('eliminada', 'Eliminada')
          AND sc.bonificacion > 0
          ${statusFilter}
          ${dateFilter}
        GROUP BY cm.id, cliente.T1_U_Cliente, cliente.T2_U_Marca, sol.unidad_negocio, cm.nombre,
                 sc.id, sc.formato, sc.articulo, sc.bonificacion, sc.inicio_periodo, sc.fin_periodo,
                 pr.asignado

        UNION ALL

        -- FILA PARA RENTA
        SELECT
          MIN(inv.plaza) AS plaza,
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
          'renta' AS tipo_fila,
          MIN(inv.tradicional_digital) AS tradicional_digital
        FROM campania cm
          LEFT JOIN cliente ON cliente.id = cm.cliente_id OR cliente.CUIC = cm.cliente_id
          INNER JOIN cotizacion ct ON ct.id = cm.cotizacion_id
          INNER JOIN propuesta pr ON pr.id = ct.id_propuesta
          INNER JOIN solicitud sol ON sol.id = pr.solicitud_id
          INNER JOIN solicitudCaras sc ON sc.idquote = ct.id_propuesta
          INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id
          INNER JOIN espacio_inventario esInv ON esInv.id = rsv.inventario_id
          INNER JOIN inventarios inv ON inv.id = esInv.inventario_id
        WHERE rsv.deleted_at IS NULL
          AND rsv.estatus NOT IN ('eliminada', 'Eliminada')
          AND (sc.caras - sc.bonificacion) > 0
          ${statusFilter}
          ${dateFilter}
        GROUP BY cm.id, cliente.T1_U_Cliente, cliente.T2_U_Marca, sol.unidad_negocio, cm.nombre,
                 sc.id, sc.formato, sc.articulo, sc.caras, sc.bonificacion, sc.inicio_periodo, sc.fin_periodo,
                 pr.asignado, ct.descuento

        ORDER BY campania_id, grupo_id, tipo_fila
      `;

      const data = await prisma.$queryRawUnsafe(query, ...params, ...params);

      const dataSerializable = serializeBigInt(data);

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
            WHEN sc.articulo LIKE 'RT%' THEN 'RENTA'
            WHEN sc.articulo LIKE 'BF%' OR sc.articulo LIKE 'CF%' THEN 'BONIFICACION'
            WHEN sc.articulo LIKE 'CT%' THEN 'CORTESIA'
            WHEN sc.articulo LIKE 'IN%' THEN 'INTERCAMBIO'
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
          CASE WHEN rsv.archivo IS NOT NULL AND rsv.archivo != '' THEN 'HAS_ARTE' ELSE NULL END AS ArteUrl,
          CASE WHEN rsv.archivo IS NOT NULL AND rsv.archivo != '' THEN SUBSTRING_INDEX(rsv.archivo, '/', -1) ELSE NULL END AS ArteFileName,
          NULL AS OrigenArte,
          rsv.id AS rsv_id,
          inv.tradicional_digital AS tradicional_digital,
          CAST(inv.codigo_unico AS CHAR(255)) AS Unidad,
          CAST(inv.tipo_de_cara AS CHAR(255)) AS Cara,
          CAST(inv.municipio AS CHAR(255)) AS Ciudad,
          CASE
            WHEN sc.cortesia = 1 THEN 'CORTESIA'
            WHEN rsv.estatus = 'Vendido bonificado' OR rsv.estatus = 'Bonificado' THEN 'BONIFICACION'
            ELSE 'RENTA'
          END AS TipoDistribucion,
          NULL AS Reproducciones,
          sc.inicio_periodo AS fecha_inicio,
          sc.fin_periodo AS fecha_fin,
          cm.status AS status_campania,
          (SELECT numero_catorcena FROM catorcenas WHERE sc.inicio_periodo BETWEEN fecha_inicio AND fecha_fin LIMIT 1) AS catorcena_numero,
          (SELECT año FROM catorcenas WHERE sc.inicio_periodo BETWEEN fecha_inicio AND fecha_fin LIMIT 1) AS catorcena_year,
          sc.cortesia,
          sc.articulo AS numero_articulo
        FROM reservas rsv
          INNER JOIN espacio_inventario esInv ON esInv.id = rsv.inventario_id
          INNER JOIN inventarios inv ON inv.id = esInv.inventario_id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN propuesta pr ON pr.id = sc.idquote
          INNER JOIN cotizacion ct ON ct.id_propuesta = pr.id
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN cliente ON cliente.id = cm.cliente_id OR cliente.CUIC = cm.cliente_id
        WHERE rsv.deleted_at IS NULL
          AND rsv.estatus NOT IN ('eliminada', 'Eliminada')
          ${statusFilter}
          ${dateFilter}
        ORDER BY cm.id, sc.id, inv.id
      `;

      const data = await prisma.$queryRawUnsafe(query, ...params);

      const dataArr = data as any[];

      // Collect unique campania_ids and rsv_ids from results
      const campaniaIds = [...new Set(dataArr.map((r: any) => Number(r.CodigoContrato)).filter(Boolean))];
      const rsvIds = [...new Set(dataArr.map((r: any) => Number(r.rsv_id)).filter(Boolean))];

      // Query tareas (Programación e Instalación) for these campaigns
      let tareasArr: any[] = [];
      if (campaniaIds.length > 0) {
        const placeholdersCamp = campaniaIds.map(() => '?').join(',');
        const tareasQuery = `
          SELECT id, tipo, evidencia, contenido, ids_reservas, campania_id
          FROM tareas
          WHERE campania_id IN (${placeholdersCamp})
            AND tipo IN ('Programación', 'Instalación')
        `;
        tareasArr = (await prisma.$queryRawUnsafe(tareasQuery, ...campaniaIds)) as any[];
      }

      // Query imagenes_digitales count and filenames per reserva
      let artesCountMap = new Map<number, number>();
      let artesNamesMap = new Map<number, string>();
      if (rsvIds.length > 0) {
        const placeholdersRsv = rsvIds.map(() => '?').join(',');
        const artesCountQuery = `
          SELECT id_reserva, COUNT(*) as total_artes,
                 GROUP_CONCAT(SUBSTRING_INDEX(archivo, '/', -1) ORDER BY spot SEPARATOR ', ') as nombres_artes
          FROM imagenes_digitales
          WHERE id_reserva IN (${placeholdersRsv})
          GROUP BY id_reserva
        `;
        const artesCountArr = (await prisma.$queryRawUnsafe(artesCountQuery, ...rsvIds)) as any[];
        for (const row of artesCountArr) {
          artesCountMap.set(Number(row.id_reserva), Number(row.total_artes));
          if (row.nombres_artes) artesNamesMap.set(Number(row.id_reserva), String(row.nombres_artes));
        }
      }

      // Index tareas by reserva_id
      const programacionByReserva = new Map<number, any>();
      const instalacionByReserva = new Map<number, any>();

      for (const tarea of tareasArr) {
        if (!tarea.ids_reservas) continue;
        const ids = String(tarea.ids_reservas).replace(/\*/g, ',').split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        const map = (tarea.tipo === 'Programación' || tarea.tipo === 'Orden de Programación') ? programacionByReserva
                  : (tarea.tipo === 'Instalación' || tarea.tipo === 'Orden de Instalación') ? instalacionByReserva
                  : instalacionByReserva;
        for (const rsvId of ids) {
          if (!map.has(rsvId)) map.set(rsvId, tarea);
        }
      }

      // Map indicaciones and extra fields to each row
      const enrichedData = dataArr.map((row: any) => {
        const rsvId = Number(row.rsv_id);
        let indicaciones: string | null = null;

        const isDigital = row.tradicional_digital === 'Digital';

        if (isDigital) {
          // Digital: indicaciones from Programación task evidencia JSON
          const tProgramacion = programacionByReserva.get(rsvId);
          if (tProgramacion && tProgramacion.evidencia) {
            try {
              const evidenciaJson = typeof tProgramacion.evidencia === 'string'
                ? JSON.parse(tProgramacion.evidencia)
                : tProgramacion.evidencia;
              if (evidenciaJson.indicaciones && row.ArteUrl) {
                // Try exact match first, then try by filename
                indicaciones = evidenciaJson.indicaciones[row.ArteUrl] || null;
                if (!indicaciones) {
                  // Try matching by path variants
                  for (const [key, val] of Object.entries(evidenciaJson.indicaciones)) {
                    if (key && row.ArteUrl && (key.includes(row.ArteUrl) || row.ArteUrl.includes(key))) {
                      indicaciones = val as string;
                      break;
                    }
                  }
                }
              }
              // Fallback to general indicaciones string
              if (!indicaciones && typeof evidenciaJson.indicaciones === 'string') {
                indicaciones = evidenciaJson.indicaciones;
              }
            } catch { /* ignore parse errors */ }
          }
        } else {
          // Tradicional: indicaciones from Instalación task contenido
          const tInstalacion = instalacionByReserva.get(rsvId);
          if (tInstalacion && tInstalacion.contenido) {
            indicaciones = String(tInstalacion.contenido);
          }
        }

        return {
          ...row,
          indicaciones,
          num_artes_digitales: artesCountMap.get(rsvId) || 0,
          nombres_artes_digitales: artesNamesMap.get(rsvId) || null,
        };
      });

      const dataSerializable = JSON.parse(JSON.stringify(enrichedData, (_, value) =>
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

      // Return all reservas for the propuesta (not just those with APS)
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
          i.mueble as formato,
          i.ubicacion,
          i.isla,
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

      // Obtener espacios ya reservados en el período
      let espaciosReservadosEnPeriodo: Set<number> = new Set();
      if (calendarioIdsOverlap.length > 0) {
        const reservasExistentes = await prisma.reservas.findMany({
          where: {
            deleted_at: null,
            calendario_id: { in: calendarioIdsOverlap },
            estatus: { in: ['Reservado', 'Bonificado', 'Apartado', 'Vendido'] },
          },
          select: { inventario_id: true },
        });
        espaciosReservadosEnPeriodo = new Set(reservasExistentes.map(r => r.inventario_id));
      }

      let reservasCreadas = 0;
      let reservasOmitidas = 0;
      let currentGroupId: number | null = null;

      // Procesar reservas
      for (const reserva of reservas) {
        let espacioId: number;

        // Si viene espacio_id del frontend, usarlo directamente
        if (reserva.espacio_id) {
          espacioId = reserva.espacio_id;
        } else {
          // Buscar todos los espacios del inventario
          const espaciosInventario = await prisma.espacio_inventario.findMany({
            where: { inventario_id: reserva.inventario_id },
            orderBy: { numero_espacio: 'asc' },
          });

          if (espaciosInventario.length === 0) {
            console.warn(`No se encontró espacio_inventario para inventario_id: ${reserva.inventario_id}`);
            continue;
          }

          // Buscar el primer espacio disponible (no reservado en el período)
          let espacioEncontrado: number | null = null;
          for (const espacio of espaciosInventario) {
            if (!espaciosReservadosEnPeriodo.has(espacio.id)) {
              espacioEncontrado = espacio.id;
              break;
            }
          }

          if (!espacioEncontrado) {
            console.warn(`Todos los espacios del inventario ${reserva.inventario_id} están ocupados en el período`);
            reservasOmitidas++;
            continue;
          }

          espacioId = espacioEncontrado;
        }

        // Validar que el espacio no esté ya reservado en el período
        if (espaciosReservadosEnPeriodo.has(espacioId)) {
          console.warn(`El espacio ${espacioId} ya está reservado en el período`);
          reservasOmitidas++;
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
            inventario_id: espacioId,
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

        // Marcar espacio como usado para evitar duplicados en este mismo request
        espaciosReservadosEnPeriodo.add(espacioId);
        reservasCreadas++;
      }

      res.json({
        success: true,
        data: {
          calendarioId: calendario.id,
          reservasCreadas,
          reservasOmitidas,
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
      const { id, caraId } = req.params;
      const campanaId = parseInt(id);
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
        estado: data.estados || undefined,
        formato: data.formato || '',
        tipo: data.tipo || undefined,
        caras: data.caras ? parseInt(data.caras) : 0,
        bonificacion: data.bonificacion ? parseFloat(data.bonificacion) : 0,
        costo: data.costo ? parseInt(data.costo) : 0,
        tarifa_publica: data.tarifa_publica ? parseInt(data.tarifa_publica) : 0,
        articulo: data.articulo || null
      });

      const updateData: any = {
        ciudad: data.ciudad,
        estados: data.estados,
        tipo: data.tipo || 'Tradicional',
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
        autorizacion_dg: estadoResult.autorizacion_dg,
        autorizacion_dcm: estadoResult.autorizacion_dcm,
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
            autorizacion.pendientesDcm,
            'campana',
            campanaId
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
        estado: data.estados,
        formato: data.formato || '',
        tipo: data.tipo,
        caras: data.caras ? parseInt(data.caras) : 0,
        bonificacion: data.bonificacion ? parseFloat(data.bonificacion) : 0,
        costo: data.costo ? parseInt(data.costo) : 0,
        tarifa_publica: data.tarifa_publica ? parseInt(data.tarifa_publica) : 0,
        articulo: data.articulo || null
      });

      const createData: any = {
        idquote: String(cotizacion.id_propuesta),
        ciudad: data.ciudad,
        estados: data.estados,
        tipo: data.tipo || 'Tradicional',
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
        autorizacion_dg: estadoResult.autorizacion_dg,
        autorizacion_dcm: estadoResult.autorizacion_dcm,
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
          autorizacion.pendientesDcm,
          'campana',
          campanaId
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

  /**
   * Obtener el archivo (arte) de una reserva por su ID
   * Devuelve el contenido de rsv.archivo (base64 o URL)
   */
  async getReservaArchivo(req: AuthRequest, res: Response): Promise<void> {
    try {
      const reservaId = parseInt(req.params.reservaId);
      if (isNaN(reservaId)) {
        res.status(400).json({ success: false, error: 'ID de reserva inválido' });
        return;
      }

      const result = await prisma.$queryRawUnsafe<{ archivo: string | null }[]>(
        `SELECT archivo FROM reservas WHERE id = ? LIMIT 1`,
        reservaId
      );

      if (!result || result.length === 0) {
        res.status(404).json({ success: false, error: 'Reserva no encontrada' });
        return;
      }

      res.json({
        success: true,
        data: { archivo: result[0].archivo },
      });
    } catch (error) {
      console.error('Error en getReservaArchivo:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener archivo de reserva';
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * Asignar artes tradicionales (múltiples imágenes con notas obligatorias)
   */
  async assignArteTradicional(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds, archivos } = req.body;
      const userName = req.user?.nombre || 'Usuario';
      const campanaId = parseInt(id);

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({ success: false, error: 'Se requiere un array de reservaIds' });
        return;
      }

      if (!archivos || !Array.isArray(archivos) || archivos.length === 0) {
        res.status(400).json({ success: false, error: 'Se requiere un array de archivos con notas' });
        return;
      }

      // Validar que cada archivo tenga nota
      for (const a of archivos) {
        if (!a.archivo || !a.nota || typeof a.nota !== 'string' || a.nota.trim() === '') {
          res.status(400).json({ success: false, error: 'Cada archivo debe tener una nota obligatoria' });
          return;
        }
      }

      // Obtener grupo_completo_id de las reservas seleccionadas
      const placeholders = reservaIds.map(() => '?').join(',');
      const gruposQuery = `
        SELECT DISTINCT grupo_completo_id
        FROM reservas
        WHERE id IN (${placeholders})
        AND grupo_completo_id IS NOT NULL
      `;
      const grupos = await prisma.$queryRawUnsafe<{ grupo_completo_id: number }[]>(gruposQuery, ...reservaIds);
      const grupoIds = grupos.map(g => g.grupo_completo_id);

      // Expandir a todas las reservas del grupo
      let allReservaIds = [...reservaIds];
      if (grupoIds.length > 0) {
        const grupoPlaceholders = grupoIds.map(() => '?').join(',');
        const grupoReservasQuery = `SELECT id FROM reservas WHERE grupo_completo_id IN (${grupoPlaceholders})`;
        const grupoReservas = await prisma.$queryRawUnsafe<{ id: number }[]>(grupoReservasQuery, ...grupoIds);
        allReservaIds = [...new Set([...allReservaIds, ...grupoReservas.map(r => r.id)])];
      }

      // Eliminar registros anteriores de artes_tradicionales para estas reservas
      const deleteOldQuery = `DELETE FROM artes_tradicionales WHERE id_reserva IN (${allReservaIds.map(() => '?').join(',')})`;
      await prisma.$executeRawUnsafe(deleteOldQuery, ...allReservaIds);

      // Insertar cada archivo con su nota para cada reserva (skip duplicates)
      const savedFiles: string[] = [];
      const insertedPairs = new Set<string>();
      for (const archivo of archivos) {
        const { archivo: archivoUrl, nota, spot } = archivo;

        // Asegurar que el archivo está almacenado
        const archivoFinal = await ensureStoredFileUrl(
          archivoUrl,
          `qeb/campana-${campanaId}/artes`,
          'image'
        );
        savedFiles.push(archivoFinal);

        for (const reservaId of allReservaIds) {
          const pairKey = `${reservaId}:${archivoFinal}`;
          if (insertedPairs.has(pairKey)) continue;
          insertedPairs.add(pairKey);
          await prisma.$executeRawUnsafe(`
            INSERT INTO artes_tradicionales (id_reserva, archivo, nota, spot)
            VALUES (?, ?, ?, ?)
          `, reservaId, archivoFinal, nota.trim(), spot || 1);
        }
      }

      // Actualizar reservas.archivo con la primera imagen (para fallback y preview)
      const firstFileUrl = savedFiles[0] || '';
      const updateReservasQuery = `
        UPDATE reservas
        SET archivo = ?, arte_aprobado = 'Pendiente', estatus = 'Con Arte'
        WHERE id IN (${allReservaIds.map(() => '?').join(',')})
      `;
      await prisma.$executeRawUnsafe(updateReservasQuery, firstFileUrl, ...allReservaIds);

      // Registrar en historial
      const campana = await prisma.campania.findUnique({ where: { id: campanaId }, select: CAMPANIA_SAFE_SELECT });
      if (campana?.cotizacion_id) {
        const cotizacion = await prisma.cotizacion.findUnique({ where: { id: campana.cotizacion_id } });
        if (cotizacion?.id_propuesta) {
          await prisma.historial.create({
            data: {
              tipo: 'Arte Tradicional',
              ref_id: cotizacion.id_propuesta,
              accion: 'Asignación',
              fecha_hora: new Date(),
              detalles: `${userName} asignó ${archivos.length} arte(s) tradicional(es) a ${allReservaIds.length} reserva(s)`,
            },
          });
        }
      }

      res.json({
        success: true,
        data: {
          message: `Arte tradicional asignado: ${archivos.length} archivo(s) a ${allReservaIds.length} reserva(s)`,
          affected: allReservaIds.length,
          files: savedFiles,
        },
      });

      // Emitir evento WebSocket
      emitToCampana(campanaId, SOCKET_EVENTS.ARTE_SUBIDO, {
        campanaId,
        reservaIds: allReservaIds,
        tipo: 'tradicional',
        usuario: userName,
        archivosCount: archivos.length,
      });
    } catch (error) {
      console.error('Error en assignArteTradicional:', error);
      const message = error instanceof Error ? error.message : 'Error al asignar arte tradicional';
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * Obtener artes tradicionales de una o varias reservas
   * Con fallback a reservas.archivo para campañas existentes
   */
  async getArtesTradicionales(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { reservaId } = req.params;

      // Soportar múltiples reserva IDs separados por coma
      const reservaIds = reservaId.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

      if (reservaIds.length === 0) {
        res.status(400).json({ success: false, error: 'ID de reserva inválido' });
        return;
      }

      const placeholders = reservaIds.map(() => '?').join(',');
      const artes = await prisma.$queryRawUnsafe<{
        id: number;
        id_reserva: number;
        archivo: string;
        nota: string;
        spot: number;
        created_at: Date;
      }[]>(`
        SELECT DISTINCT archivo, nota, MIN(id) as id, MIN(id_reserva) as id_reserva, spot, MIN(created_at) as created_at
        FROM artes_tradicionales
        WHERE id_reserva IN (${placeholders})
        GROUP BY archivo, nota, spot
        ORDER BY spot ASC
      `, ...reservaIds);

      if (artes.length > 0) {
        res.json({
          success: true,
          data: artes.map(a => ({
            id: a.id,
            idReserva: a.id_reserva,
            archivo: a.archivo,
            nota: a.nota,
            spot: a.spot,
            createdAt: a.created_at,
          })),
        });
        return;
      }

      // Fallback: si no hay registros en artes_tradicionales, usar reservas.archivo
      const fallback = await prisma.$queryRawUnsafe<{ id: number; archivo: string | null }[]>(
        `SELECT id, archivo FROM reservas WHERE id IN (${placeholders}) AND archivo IS NOT NULL AND archivo != '' LIMIT 1`,
        ...reservaIds
      );

      if (fallback.length > 0 && fallback[0].archivo) {
        res.json({
          success: true,
          data: [{
            id: 0,
            idReserva: fallback[0].id,
            archivo: fallback[0].archivo,
            nota: '',
            spot: 1,
            createdAt: null,
          }],
        });
        return;
      }

      res.json({ success: true, data: [] });
    } catch (error) {
      console.error('Error en getArtesTradicionales:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener artes tradicionales';
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * Obtener resumen de archivos tradicionales por reserva para toda la campaña
   */
  async getTradicionalFileSummaries(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const campanaId = parseInt(id);

      if (isNaN(campanaId)) {
        res.status(400).json({ success: false, error: 'ID de campaña inválido' });
        return;
      }

      const summaries = await prisma.$queryRaw<{
        id_reserva: number;
        total_archivos: number;
        first_nota: string | null;
      }[]>`
        SELECT
          at2.id_reserva,
          COUNT(*) as total_archivos,
          SUBSTRING(MIN(at2.nota), 1, 80) as first_nota
        FROM artes_tradicionales at2
        INNER JOIN reservas r ON r.id = at2.id_reserva
        INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
        INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
        INNER JOIN campania cm ON cm.cotizacion_id = ct.id
        WHERE cm.id = ${campanaId}
        GROUP BY at2.id_reserva
      `;

      res.json({
        success: true,
        data: summaries.map(s => ({
          idReserva: Number(s.id_reserva),
          totalArchivos: Number(s.total_archivos),
          firstNota: s.first_nota || '',
        })),
      });
    } catch (error) {
      console.error('Error en getTradicionalFileSummaries:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener resumen de artes tradicionales';
      res.status(500).json({ success: false, error: message });
    }
  }
  /**
   * Batch: obtener resumen (inversión, circuitos, bonificación, caras netas) por campaña+catorcena.
   * 1 sola query reemplaza 720 requests individuales.
   * POST /campanas/batch-inversiones  body: { ids: number[] }
   */
  async getBatchInversiones(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.json({ success: true, data: {} });
        return;
      }

      const campanaIds = ids.map(Number).filter(id => Number.isFinite(id));
      if (campanaIds.length === 0) {
        res.json({ success: true, data: {} });
        return;
      }

      const placeholders = campanaIds.map(() => '?').join(', ');

      const query = `
        SELECT
          cm.id AS campania_id,
          cat.numero_catorcena,
          cat.año AS anio_catorcena,
          COALESCE(SUM(COALESCE(sc.tarifa_publica, i.tarifa_publica, 0)), 0) AS inversion,
          COUNT(DISTINCT COALESCE(rsv.grupo_completo_id, rsv.id)) AS circuitos,
          SUM(CASE WHEN COALESCE(sc.tarifa_publica, 0) = 0 OR COALESCE(sc.bonificacion, 0) > 0 THEN 1 ELSE 0 END) AS bonificadas,
          COUNT(*) AS total_caras
        FROM campania cm
          INNER JOIN cotizacion ct ON ct.id = cm.cotizacion_id
          INNER JOIN solicitudCaras sc ON sc.idquote = ct.id_propuesta
          INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id AND rsv.deleted_at IS NULL
          INNER JOIN espacio_inventario epIn ON epIn.id = rsv.inventario_id
          INNER JOIN inventarios i ON i.id = epIn.inventario_id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE cm.id IN (${placeholders})
          AND rsv.APS IS NOT NULL
          AND rsv.APS > 0
        GROUP BY cm.id, cat.numero_catorcena, cat.año
      `;

      const rows = await prisma.$queryRawUnsafe<Array<{
        campania_id: number;
        numero_catorcena: number | null;
        anio_catorcena: number | null;
        inversion: bigint | number;
        circuitos: bigint | number;
        bonificadas: bigint | number;
        total_caras: bigint | number;
      }>>(query, ...campanaIds);

      // Agrupar: { campania_id: { "catNum:catAnio": { inversion, circuitos, bonificadas, carasNetas }, total: {...} } }
      const result: Record<number, Record<string, { inversion: number; circuitos: number; bonificadas: number; carasNetas: number }>> = {};
      for (const row of rows) {
        const cid = Number(row.campania_id);
        if (!result[cid]) result[cid] = {};
        const inv = Number(row.inversion || 0);
        const circ = Number(row.circuitos || 0);
        const bonif = Number(row.bonificadas || 0);
        const total = Number(row.total_caras || 0);
        const netas = Math.max(total - bonif, 0);

        const entry = { inversion: inv, circuitos: circ, bonificadas: bonif, carasNetas: netas };

        if (row.numero_catorcena != null && row.anio_catorcena != null) {
          const catKey = `${row.numero_catorcena}:${row.anio_catorcena}`;
          if (!result[cid][catKey]) {
            result[cid][catKey] = { inversion: 0, circuitos: 0, bonificadas: 0, carasNetas: 0 };
          }
          result[cid][catKey].inversion += inv;
          result[cid][catKey].circuitos += circ;
          result[cid][catKey].bonificadas += bonif;
          result[cid][catKey].carasNetas += netas;
        }

        if (!result[cid]['total']) {
          result[cid]['total'] = { inversion: 0, circuitos: 0, bonificadas: 0, carasNetas: 0 };
        }
        result[cid]['total'].inversion += inv;
        result[cid]['total'].circuitos += circ;
        result[cid]['total'].bonificadas += bonif;
        result[cid]['total'].carasNetas += netas;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error en getBatchInversiones:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inversiones batch';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const campanasController = new CampanasController();
// force restart

