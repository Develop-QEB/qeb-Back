import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

// =============================================================================
// AUDITORÍA RESERVAS QEB — endpoints SOLO-LECTURA
// =============================================================================
// Detecta anomalías reales en BD QEB sin Excel externo:
// - PATSA-style: mismo (sc + inv) 2+ veces
// - Cross-cam físico: 2+ cams en mismo parabús por inv duplicado en BD
// - Inv duplicados: mismo (codigo+cara+plaza+lat+long) cargado 2+ veces
// - Cod reutilizado: mismo (codigo+cara+plaza) con coords distintas
// - Cliente desalineado: sol/prop/cam con cliente_id distinto
// - APS compartido: mismo APS en cams o clientes distintos
// - Cam inactiva con reservas activas
// - Inv sucio: codigo_unico con espacios/comas, typo Contaflujo
// - Reservas sucias: calendario_id=0, invertido, desincronizado, estatus 'Apartado'
// - Huérfanas: reservas sin solicitudCaras/propuesta válida
// - Zombies: reservas con espacio_inventario inexistente
// - Espacio_inv duplicado
// - Marca con clientes duplicados
// =============================================================================

function isDev(req: AuthRequest): boolean {
  return req.user?.rol === 'DEV';
}

const ESTATUS_BLOQUEAN = "('Reservado','Bonificado','Vendido','Vendido bonificado','Con Arte','Sin Arte')";
const CAM_STATUS_EXCLUIR = "('Cancelada','finalizada','Finalizada')";

// =============================================================================
// 1) RESUMEN — KPIs verificados, agrupados por categoría
// =============================================================================
export const getAuditSummary = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });

    const q = await Promise.all([
      // Generales
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM reservas WHERE deleted_at IS NULL`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(DISTINCT sc.inicio_periodo) AS n FROM reservas r INNER JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id WHERE r.deleted_at IS NULL AND sc.inicio_periodo IS NOT NULL`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM inventarios`),
      // Duplicación
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM reservas rv INNER JOIN solicitudCaras sc ON sc.id=rv.solicitudCaras_id
        INNER JOIN inventarios i ON i.id=rv.inventario_id
        LEFT JOIN campania c ON c.id=CAST(sc.idquote AS UNSIGNED)
        WHERE rv.deleted_at IS NULL AND i.tradicional_digital='Tradicional'
          AND rv.inventario_id!=0 AND rv.estatus IN ${ESTATUS_BLOQUEAN}
          AND (c.id IS NULL OR c.status NOT IN ${CAM_STATUS_EXCLUIR})
        GROUP BY rv.solicitudCaras_id, rv.inventario_id, sc.inicio_periodo
        HAVING COUNT(*) > 1
      ) t`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (
        SELECT i.codigo, i.cara, i.plaza, i.latitud, i.longitud, sc.inicio_periodo
        FROM reservas rv INNER JOIN solicitudCaras sc ON sc.id=rv.solicitudCaras_id
        INNER JOIN inventarios i ON i.id=rv.inventario_id
        LEFT JOIN campania c ON c.id=CAST(sc.idquote AS UNSIGNED)
        WHERE rv.deleted_at IS NULL AND i.tradicional_digital='Tradicional'
          AND rv.inventario_id!=0 AND rv.estatus IN ${ESTATUS_BLOQUEAN}
          AND (c.id IS NULL OR c.status NOT IN ${CAM_STATUS_EXCLUIR})
        GROUP BY i.codigo, i.cara, i.plaza, i.latitud, i.longitud, sc.inicio_periodo
        HAVING COUNT(DISTINCT i.id) > 1 AND COUNT(DISTINCT CAST(sc.idquote AS UNSIGNED)) > 1
      ) x`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (
        SELECT codigo, cara, plaza, latitud, longitud FROM inventarios
        WHERE codigo IS NOT NULL AND codigo!=''
        GROUP BY codigo, cara, plaza, latitud, longitud HAVING COUNT(*) > 1
      ) x`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (
        SELECT codigo, cara, plaza FROM inventarios
        WHERE codigo IS NOT NULL AND codigo!='' AND latitud IS NOT NULL
        GROUP BY codigo, cara, plaza HAVING COUNT(DISTINCT CONCAT(latitud,'_',longitud)) > 1
      ) x`),
      // Integridad
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM reservas r
        LEFT JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
        LEFT JOIN propuesta p ON p.id=CAST(sc.idquote AS UNSIGNED)
        WHERE r.deleted_at IS NULL AND (sc.id IS NULL OR p.id IS NULL OR p.deleted_at IS NOT NULL)`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM reservas r
        LEFT JOIN espacio_inventario ei ON ei.id=r.inventario_id
        WHERE r.deleted_at IS NULL AND ei.id IS NULL AND r.inventario_id!=0`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM reservas r
        INNER JOIN calendario c ON c.id=r.calendario_id
        WHERE r.deleted_at IS NULL AND c.fecha_fin < c.fecha_inicio`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM reservas WHERE deleted_at IS NULL AND calendario_id=0`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (
        SELECT inventario_id, numero_espacio FROM espacio_inventario
        GROUP BY inventario_id, numero_espacio HAVING COUNT(*) > 1
      ) x`),
      // Status
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM propuesta p
        LEFT JOIN solicitud s ON s.id=p.solicitud_id
        LEFT JOIN cotizacion ct ON ct.id_propuesta=p.id
        LEFT JOIN campania cm ON cm.cotizacion_id=ct.id
        LEFT JOIN cliente cl ON cl.id=p.cliente_id
        WHERE p.deleted_at IS NULL AND (
          (s.cliente_id IS NOT NULL AND p.cliente_id IS NOT NULL AND s.cliente_id!=p.cliente_id)
          OR (cm.cliente_id IS NOT NULL AND p.cliente_id IS NOT NULL AND p.cliente_id!=cm.cliente_id)
          OR (s.card_code IS NOT NULL AND cl.card_code IS NOT NULL AND s.card_code!=cl.card_code)
        )`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM campania cm
        WHERE cm.status='inactiva' AND EXISTS (
          SELECT 1 FROM reservas rv INNER JOIN solicitudCaras sc ON sc.id=rv.solicitudCaras_id
          WHERE CAST(sc.idquote AS UNSIGNED)=cm.id AND rv.deleted_at IS NULL AND rv.estatus IN ${ESTATUS_BLOQUEAN}
        )`),
      // Inv sucio
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM inventarios
        WHERE codigo_unico LIKE '% \\_%' OR codigo_unico LIKE '%\\_ %' OR codigo_unico LIKE '%,%' OR tipo_de_cara='Contaflujo'
          OR plaza IN ('Zapopan','Boca del Río','San Pedro Tlaquepaque','Tlaquepaque','Tonalá')`),
      // APS
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (
        SELECT r.APS FROM reservas r INNER JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
        WHERE r.deleted_at IS NULL AND r.APS IS NOT NULL AND r.APS!='' AND r.APS!='0'
        GROUP BY r.APS HAVING COUNT(DISTINCT CAST(sc.idquote AS UNSIGNED)) > 1
      ) x`),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (
        SELECT r.APS FROM reservas r
        WHERE r.deleted_at IS NULL AND r.APS IS NOT NULL AND r.APS!='' AND r.APS!='0'
        GROUP BY r.APS HAVING COUNT(DISTINCT r.cliente_id) > 1
      ) x`),
      // Clientes
      prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (
        SELECT T2_U_Marca, T2_U_Producto FROM cliente
        WHERE T2_U_Marca IS NOT NULL AND card_code IS NOT NULL AND card_code!=''
        GROUP BY T2_U_Marca, T2_U_Producto HAVING COUNT(*) > 1
      ) x`),
    ]);

    const n = (i: number) => Number(q[i][0]?.n || 0);

    res.json({
      success: true,
      data: {
        kpis: {
          // Generales
          total_reservas: n(0),
          catorcenas_activas: n(1),
          total_inventarios: n(2),
          // Duplicación
          patsa_style: n(3),
          cross_cam_fisico: n(4),
          inv_duplicados: n(5),
          cod_reutilizado: n(6),
          // Integridad
          huerfanas: n(7),
          zombies_ei: n(8),
          cal_invertido: n(9),
          cal_cero: n(10),
          ei_duplicado: n(11),
          // Status
          cliente_desalineado: n(12),
          cam_inactiva_con_reservas: n(13),
          // Inv sucio
          inv_sucio: n(14),
          // APS
          aps_multi_cam: n(15),
          aps_multi_cliente: n(16),
          // Clientes
          marca_clientes_dup: n(17),
        },
      },
    });
  } catch (error) {
    console.error('Error en getAuditSummary:', error);
    res.status(500).json({ success: false, error: 'Error interno al calcular resumen' });
  }
};

// =============================================================================
// 2) PATSA-STYLE — mismo (sc + inv) 2+ veces (bug doble click)
// =============================================================================
export const getAuditDuplicados = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT r.inventario_id, i.codigo_unico, i.tipo_de_cara, i.plaza,
         sc.inicio_periodo AS fecha_inicio, sc.fin_periodo AS fecha_fin,
         COUNT(*) AS veces,
         CAST(sc.idquote AS UNSIGNED) AS cam_id, c.nombre AS cam_nombre,
         cl.T0_U_RazonSocial AS cliente, sc.articulo,
         GROUP_CONCAT(r.id ORDER BY r.id SEPARATOR ',') AS rv_ids,
         GROUP_CONCAT(DISTINCT r.APS SEPARATOR ',') AS aps
       FROM reservas r
       INNER JOIN inventarios i ON i.id=r.inventario_id
       INNER JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       LEFT JOIN cliente cl ON cl.id=r.cliente_id
       LEFT JOIN campania c ON c.id=CAST(sc.idquote AS UNSIGNED)
       WHERE r.deleted_at IS NULL AND i.tradicional_digital='Tradicional'
         AND r.inventario_id!=0 AND r.estatus IN ${ESTATUS_BLOQUEAN}
         AND (c.id IS NULL OR c.status NOT IN ${CAM_STATUS_EXCLUIR})
       GROUP BY r.solicitudCaras_id, r.inventario_id, i.codigo_unico, i.tipo_de_cara,
                i.plaza, sc.inicio_periodo, sc.fin_periodo, sc.idquote, c.nombre,
                cl.T0_U_RazonSocial, sc.articulo
       HAVING COUNT(*) > 1
       ORDER BY veces DESC, sc.inicio_periodo DESC
       LIMIT ${limit}`
    );

    const data = rows.map((r: any) => ({
      inventario_id: r.inventario_id, codigo_unico: r.codigo_unico,
      tipo_de_cara: r.tipo_de_cara, plaza: r.plaza,
      fecha_inicio: r.fecha_inicio, fecha_fin: r.fecha_fin,
      veces: Number(r.veces),
      cam_id: r.cam_id ? Number(r.cam_id) : null, cam_nombre: r.cam_nombre,
      cliente: r.cliente, articulo: r.articulo,
      rv_ids: r.rv_ids, aps: r.aps,
    }));
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    console.error('Error en getAuditDuplicados:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 3) HUÉRFANAS — reservas sin sc o propuesta válida
// =============================================================================
export const getAuditHuerfanos = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT r.id AS reserva_id, r.inventario_id, i.codigo_unico, i.plaza,
         r.cliente_id, cl.T0_U_RazonSocial AS cliente_nombre,
         r.solicitudCaras_id, sc.id AS sc_id,
         sc.idquote AS propuesta_id_text, p.id AS propuesta_id_resolved,
         p.status AS propuesta_status, p.deleted_at AS propuesta_deleted,
         sc.inicio_periodo AS fecha_inicio, sc.fin_periodo AS fecha_fin,
         CASE
           WHEN sc.id IS NULL THEN 'solicitudCaras eliminada'
           WHEN p.id IS NULL THEN 'propuesta inexistente'
           WHEN p.deleted_at IS NOT NULL THEN 'propuesta eliminada'
           ELSE 'otro'
         END AS motivo
       FROM reservas r
       LEFT JOIN inventarios i ON i.id=r.inventario_id
       LEFT JOIN cliente cl ON cl.id=r.cliente_id
       LEFT JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       LEFT JOIN propuesta p ON p.id=CAST(sc.idquote AS UNSIGNED)
       WHERE r.deleted_at IS NULL AND (sc.id IS NULL OR p.id IS NULL OR p.deleted_at IS NOT NULL)
       ORDER BY r.id DESC LIMIT ${limit}`
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (error) {
    console.error('Error en getAuditHuerfanos:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 4) POR CATORCENA — agregados
// =============================================================================
export const getAuditPorCatorcena = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT sc.inicio_periodo AS fecha_inicio, sc.fin_periodo AS fecha_fin,
         COUNT(*) AS total_reservas,
         COUNT(DISTINCT r.inventario_id) AS inventarios_unicos,
         COUNT(DISTINCT r.cliente_id) AS clientes_unicos,
         COUNT(DISTINCT sc.idquote) AS propuestas_unicas,
         (SELECT COUNT(*) FROM (
           SELECT r2.inventario_id FROM reservas r2
           INNER JOIN solicitudCaras sc2 ON sc2.id=r2.solicitudCaras_id
           INNER JOIN inventarios i2 ON i2.id=r2.inventario_id
           WHERE r2.deleted_at IS NULL
             AND sc2.inicio_periodo=sc.inicio_periodo AND sc2.fin_periodo=sc.fin_periodo
             AND i2.tradicional_digital='Tradicional' AND r2.inventario_id!=0
           GROUP BY r2.solicitudCaras_id, r2.inventario_id HAVING COUNT(*) > 1
         ) g) AS grupos_duplicados
       FROM reservas r
       INNER JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       WHERE r.deleted_at IS NULL AND sc.inicio_periodo IS NOT NULL
       GROUP BY sc.inicio_periodo, sc.fin_periodo
       ORDER BY sc.inicio_periodo DESC LIMIT 500`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        fecha_inicio: r.fecha_inicio, fecha_fin: r.fecha_fin,
        total_reservas: Number(r.total_reservas),
        inventarios_unicos: Number(r.inventarios_unicos),
        clientes_unicos: Number(r.clientes_unicos),
        propuestas_unicas: Number(r.propuestas_unicas),
        grupos_duplicados: Number(r.grupos_duplicados),
      })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditPorCatorcena:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 5) POR CLIENTE — agregados
// =============================================================================
export const getAuditPorCliente = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT r.cliente_id, cl.T0_U_RazonSocial AS razon_social,
         cl.T2_U_Marca AS marca, cl.T0_U_Asesor AS asesor,
         COUNT(*) AS total_reservas,
         COUNT(DISTINCT r.inventario_id) AS inventarios_unicos,
         COUNT(DISTINCT sc.idquote) AS propuestas_unicas,
         COUNT(DISTINCT cm.id) AS campanias_unicas
       FROM reservas r
       LEFT JOIN cliente cl ON cl.id=r.cliente_id
       LEFT JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       LEFT JOIN cotizacion ct ON ct.id_propuesta=CAST(sc.idquote AS UNSIGNED)
       LEFT JOIN campania cm ON cm.cotizacion_id=ct.id
       WHERE r.deleted_at IS NULL
       GROUP BY r.cliente_id, cl.T0_U_RazonSocial, cl.T2_U_Marca, cl.T0_U_Asesor
       ORDER BY total_reservas DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        cliente_id: r.cliente_id, razon_social: r.razon_social,
        marca: r.marca, asesor: r.asesor,
        total_reservas: Number(r.total_reservas),
        inventarios_unicos: Number(r.inventarios_unicos),
        propuestas_unicas: Number(r.propuestas_unicas),
        campanias_unicas: Number(r.campanias_unicas),
      })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditPorCliente:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 6) INV DUPLICADOS — mismo (codigo+cara+plaza+lat+long) cargado 2+ veces
// =============================================================================
export const getAuditInvDuplicados = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT i.codigo, i.cara, i.plaza, i.latitud, i.longitud,
         COUNT(*) AS n_inv,
         GROUP_CONCAT(i.id ORDER BY i.id SEPARATOR ',') AS inv_ids,
         GROUP_CONCAT(DISTINCT i.codigo_unico SEPARATOR ' | ') AS codigos_unicos,
         GROUP_CONCAT(DISTINCT i.ubicacion SEPARATOR ' | ') AS ubicaciones,
         (SELECT COUNT(*) FROM reservas rv INNER JOIN inventarios i2 ON i2.id=rv.inventario_id
          WHERE rv.deleted_at IS NULL AND i2.codigo=i.codigo AND i2.cara=i.cara
            AND i2.plaza=i.plaza AND i2.latitud=i.latitud AND i2.longitud=i.longitud) AS reservas_totales
       FROM inventarios i
       WHERE i.codigo IS NOT NULL AND i.codigo!=''
       GROUP BY i.codigo, i.cara, i.plaza, i.latitud, i.longitud
       HAVING COUNT(*) > 1
       ORDER BY reservas_totales DESC, n_inv DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        codigo: r.codigo, cara: r.cara, plaza: r.plaza,
        latitud: r.latitud ? Number(r.latitud) : null,
        longitud: r.longitud ? Number(r.longitud) : null,
        n_inv: Number(r.n_inv),
        inv_ids: r.inv_ids, codigos_unicos: r.codigos_unicos, ubicaciones: r.ubicaciones,
        reservas_totales: Number(r.reservas_totales),
      })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditInvDuplicados:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 7) CLIENTE DESALINEADO
// =============================================================================
export const getAuditClienteDesalineado = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT p.id AS propuesta_id, p.status AS propuesta_status,
         cm.id AS cam_id, cm.nombre AS cam_nombre, cm.status AS cam_status,
         s.cliente_id AS solicitud_cliente_id, p.cliente_id AS propuesta_cliente_id,
         cm.cliente_id AS cam_cliente_id,
         s.card_code AS sol_card_code, cl_p.card_code AS cli_card_code,
         s.razon_social AS sol_razon_social, cl_p.T0_U_RazonSocial AS cli_razon_social,
         ct.clientes_id AS cuic_cotizacion, cl_p.CUIC AS cuic_cliente,
         CONCAT_WS(' | ',
           CASE WHEN s.cliente_id!=p.cliente_id THEN 'sol≠prop' END,
           CASE WHEN p.cliente_id!=cm.cliente_id THEN 'prop≠cam' END,
           CASE WHEN s.card_code IS NOT NULL AND cl_p.card_code IS NOT NULL AND s.card_code!=cl_p.card_code THEN 'card_code≠' END
         ) AS motivos
       FROM propuesta p
       LEFT JOIN solicitud s ON s.id=p.solicitud_id
       LEFT JOIN cotizacion ct ON ct.id_propuesta=p.id
       LEFT JOIN campania cm ON cm.cotizacion_id=ct.id
       LEFT JOIN cliente cl_p ON cl_p.id=p.cliente_id
       WHERE p.deleted_at IS NULL AND (
         (s.cliente_id IS NOT NULL AND p.cliente_id IS NOT NULL AND s.cliente_id!=p.cliente_id)
         OR (cm.cliente_id IS NOT NULL AND p.cliente_id IS NOT NULL AND p.cliente_id!=cm.cliente_id)
         OR (s.card_code IS NOT NULL AND cl_p.card_code IS NOT NULL AND s.card_code!=cl_p.card_code)
       )
       ORDER BY p.id DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        ...r,
        cam_id: r.cam_id ? Number(r.cam_id) : null,
        cuic_cotizacion: r.cuic_cotizacion ? Number(r.cuic_cotizacion) : null,
      })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditClienteDesalineado:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 8) STATUS RARO — cam inactiva con reservas activas
// =============================================================================
export const getAuditStatusRaro = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT cm.id AS cam_id, cm.nombre AS cam_nombre, cm.status AS cam_status,
         p.status AS prop_status, p.deleted_at AS prop_deleted,
         (SELECT COUNT(*) FROM reservas rv INNER JOIN solicitudCaras sc ON sc.id=rv.solicitudCaras_id
          WHERE CAST(sc.idquote AS UNSIGNED)=cm.id AND rv.deleted_at IS NULL
            AND rv.estatus IN ${ESTATUS_BLOQUEAN}) AS reservas_activas,
         'cam inactiva con reservas activas' AS motivo
       FROM campania cm
       LEFT JOIN propuesta p ON p.id=cm.id
       WHERE cm.status='inactiva' AND EXISTS (
         SELECT 1 FROM reservas rv2 INNER JOIN solicitudCaras sc2 ON sc2.id=rv2.solicitudCaras_id
         WHERE CAST(sc2.idquote AS UNSIGNED)=cm.id AND rv2.deleted_at IS NULL
           AND rv2.estatus IN ${ESTATUS_BLOQUEAN}
       )
       ORDER BY reservas_activas DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({ ...r, reservas_activas: Number(r.reservas_activas) })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditStatusRaro:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 9) INV SUCIO — codigo_unico con espacios extras, comas, typo Contaflujo
// =============================================================================
export const getAuditInvSucio = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT i.id AS inv_id, i.codigo_unico, i.codigo, i.tipo_de_cara, i.plaza, i.mueble,
         CASE
           WHEN i.codigo_unico LIKE '% \\_%' OR i.codigo_unico LIKE '%\\_ %' THEN 'codigo_unico con espacio extra'
           WHEN i.codigo_unico LIKE '%,%' THEN 'codigo_unico con coma (debe ser underscore)'
           WHEN i.tipo_de_cara='Contaflujo' THEN 'tipo_de_cara typo (Contaflujo sin r)'
           WHEN i.plaza IN ('Zapopan','Boca del Río','San Pedro Tlaquepaque','Tlaquepaque','Tonalá') THEN 'plaza inválida (es ciudad)'
           ELSE 'otro'
         END AS motivo
       FROM inventarios i
       WHERE i.codigo_unico LIKE '% \\_%' OR i.codigo_unico LIKE '%\\_ %'
          OR i.codigo_unico LIKE '%,%'
          OR i.tipo_de_cara='Contaflujo'
          OR i.plaza IN ('Zapopan','Boca del Río','San Pedro Tlaquepaque','Tlaquepaque','Tonalá')
       ORDER BY i.id DESC LIMIT ${limit}`
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (error) {
    console.error('Error en getAuditInvSucio:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 10) RESERVAS SUCIAS — calendario raro, estatus 'Apartado', desincronizado
// =============================================================================
export const getAuditReservasSucias = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT r.id AS reserva_id, r.inventario_id, r.cliente_id,
         cm.nombre AS cam_nombre,
         sc.inicio_periodo AS sc_inicio, sc.fin_periodo AS sc_fin,
         cal.fecha_inicio AS cal_inicio, cal.fecha_fin AS cal_fin,
         r.estatus, r.APS,
         CASE
           WHEN r.calendario_id=0 THEN 'calendario_id=0'
           WHEN cal.id IS NULL AND r.calendario_id!=0 THEN 'calendario inexistente'
           WHEN cal.fecha_fin < cal.fecha_inicio THEN 'calendario invertido (fin<inicio)'
           WHEN cal.fecha_inicio > sc.fin_periodo OR cal.fecha_fin < sc.inicio_periodo THEN 'calendario desincronizado de sc'
           WHEN r.estatus='Apartado' THEN 'estatus Apartado (migrar a Vendido)'
           ELSE 'otro'
         END AS motivo
       FROM reservas r
       INNER JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       LEFT JOIN campania cm ON cm.id=CAST(sc.idquote AS UNSIGNED)
       LEFT JOIN calendario cal ON cal.id=r.calendario_id
       WHERE r.deleted_at IS NULL AND (
         r.calendario_id=0
         OR (cal.id IS NULL AND r.calendario_id!=0)
         OR cal.fecha_fin < cal.fecha_inicio
         OR cal.fecha_inicio > sc.fin_periodo
         OR cal.fecha_fin < sc.inicio_periodo
         OR r.estatus='Apartado'
       )
       ORDER BY r.id DESC LIMIT ${limit}`
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (error) {
    console.error('Error en getAuditReservasSucias:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 11) CROSS-CAM FÍSICO
// =============================================================================
export const getAuditCrossCamFisico = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT i.codigo, i.cara, i.plaza, i.latitud, i.longitud,
         sc.inicio_periodo AS fecha_inicio, sc.fin_periodo AS fecha_fin,
         COUNT(DISTINCT i.id) AS n_inv_ids,
         COUNT(DISTINCT CAST(sc.idquote AS UNSIGNED)) AS n_cams,
         GROUP_CONCAT(DISTINCT i.id ORDER BY i.id SEPARATOR ',') AS inv_ids,
         GROUP_CONCAT(DISTINCT CAST(sc.idquote AS UNSIGNED) ORDER BY sc.idquote SEPARATOR ',') AS cams_ids,
         GROUP_CONCAT(DISTINCT cm.nombre SEPARATOR ' | ') AS cams_nombres,
         GROUP_CONCAT(DISTINCT r.id ORDER BY r.id SEPARATOR ',') AS rv_ids
       FROM reservas r
       INNER JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       INNER JOIN inventarios i ON i.id=r.inventario_id
       LEFT JOIN cotizacion ct ON ct.id_propuesta=CAST(sc.idquote AS UNSIGNED)
       LEFT JOIN campania cm ON cm.cotizacion_id=ct.id
       WHERE r.deleted_at IS NULL AND i.tradicional_digital='Tradicional'
         AND r.inventario_id!=0 AND r.estatus IN ${ESTATUS_BLOQUEAN}
         AND (cm.id IS NULL OR cm.status NOT IN ${CAM_STATUS_EXCLUIR})
       GROUP BY i.codigo, i.cara, i.plaza, i.latitud, i.longitud, sc.inicio_periodo, sc.fin_periodo
       HAVING COUNT(DISTINCT i.id) > 1 AND COUNT(DISTINCT CAST(sc.idquote AS UNSIGNED)) > 1
       ORDER BY n_cams DESC, sc.inicio_periodo LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        codigo: r.codigo, cara: r.cara, plaza: r.plaza,
        latitud: r.latitud ? Number(r.latitud) : null,
        longitud: r.longitud ? Number(r.longitud) : null,
        fecha_inicio: r.fecha_inicio, fecha_fin: r.fecha_fin,
        n_inv_ids: Number(r.n_inv_ids), n_cams: Number(r.n_cams),
        inv_ids: r.inv_ids, cams_ids: r.cams_ids,
        cams_nombres: r.cams_nombres, rv_ids: r.rv_ids,
      })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditCrossCamFisico:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 12) COD REUTILIZADO — mismo (codigo+cara+plaza) con coords distintas
// (caso AC1086 Acapulco con sufijo "2" legítimo, o data sucia)
// =============================================================================
export const getAuditCodReutilizado = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT codigo, cara, plaza,
         COUNT(DISTINCT CONCAT(latitud,'_',longitud)) AS n_ubicaciones,
         GROUP_CONCAT(DISTINCT id ORDER BY id SEPARATOR ',') AS inv_ids,
         GROUP_CONCAT(DISTINCT codigo_unico SEPARATOR ' | ') AS codigos_unicos,
         GROUP_CONCAT(DISTINCT CONCAT(ROUND(latitud,4),',',ROUND(longitud,4)) SEPARATOR ' | ') AS coords,
         GROUP_CONCAT(DISTINCT ubicacion SEPARATOR ' | ') AS ubicaciones
       FROM inventarios
       WHERE codigo IS NOT NULL AND codigo!='' AND latitud IS NOT NULL
       GROUP BY codigo, cara, plaza
       HAVING COUNT(DISTINCT CONCAT(latitud,'_',longitud)) > 1
       ORDER BY n_ubicaciones DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({ ...r, n_ubicaciones: Number(r.n_ubicaciones) })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditCodReutilizado:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 13) APS COMPARTIDO — mismo APS en cams o clientes distintos
// =============================================================================
export const getAuditApsCompartido = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT r.APS,
         COUNT(*) AS n_reservas,
         COUNT(DISTINCT CAST(sc.idquote AS UNSIGNED)) AS n_cams,
         COUNT(DISTINCT r.cliente_id) AS n_clientes,
         GROUP_CONCAT(DISTINCT CAST(sc.idquote AS UNSIGNED) ORDER BY sc.idquote SEPARATOR ',') AS cams_ids,
         GROUP_CONCAT(DISTINCT c.nombre SEPARATOR ' | ') AS cams_nombres,
         GROUP_CONCAT(DISTINCT cl.T0_U_RazonSocial SEPARATOR ' | ') AS clientes,
         CASE
           WHEN COUNT(DISTINCT CAST(sc.idquote AS UNSIGNED)) > 1 AND COUNT(DISTINCT r.cliente_id) > 1 THEN 'CRÍTICO: 2+ cams + 2+ clientes'
           WHEN COUNT(DISTINCT CAST(sc.idquote AS UNSIGNED)) > 1 THEN 'multi-cam (mismo cliente)'
           ELSE 'multi-cliente (misma cam)'
         END AS severidad
       FROM reservas r
       INNER JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       LEFT JOIN cliente cl ON cl.id=r.cliente_id
       LEFT JOIN cotizacion ct ON ct.id_propuesta=CAST(sc.idquote AS UNSIGNED)
       LEFT JOIN campania c ON c.cotizacion_id=ct.id
       WHERE r.deleted_at IS NULL AND r.APS IS NOT NULL AND r.APS!='' AND r.APS!='0'
       GROUP BY r.APS
       HAVING COUNT(DISTINCT CAST(sc.idquote AS UNSIGNED)) > 1 OR COUNT(DISTINCT r.cliente_id) > 1
       ORDER BY n_clientes DESC, n_cams DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        APS: r.APS,
        n_reservas: Number(r.n_reservas),
        n_cams: Number(r.n_cams),
        n_clientes: Number(r.n_clientes),
        cams_ids: r.cams_ids, cams_nombres: r.cams_nombres,
        clientes: r.clientes, severidad: r.severidad,
      })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditApsCompartido:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 14) ZOMBIES — reservas con espacio_inventario inexistente
// =============================================================================
export const getAuditZombies = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT r.id AS reserva_id, r.inventario_id AS ei_id_apuntado,
         r.cliente_id, cl.T0_U_RazonSocial AS cliente_nombre,
         r.solicitudCaras_id, sc.id AS sc_id, sc.articulo,
         CAST(sc.idquote AS UNSIGNED) AS cam_id, cm.nombre AS cam_nombre,
         r.estatus, r.APS, sc.inicio_periodo AS fecha_inicio
       FROM reservas r
       LEFT JOIN espacio_inventario ei ON ei.id=r.inventario_id
       LEFT JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       LEFT JOIN cliente cl ON cl.id=r.cliente_id
       LEFT JOIN campania cm ON cm.id=CAST(sc.idquote AS UNSIGNED)
       WHERE r.deleted_at IS NULL AND ei.id IS NULL AND r.inventario_id!=0
       ORDER BY r.id DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({ ...r, cam_id: r.cam_id ? Number(r.cam_id) : null })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditZombies:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 15) ESPACIO_INVENTARIO DUPLICADO — mismo (inv + numero_espacio) 2+ rows
// =============================================================================
export const getAuditEiDuplicado = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT ei.inventario_id, ei.numero_espacio,
         COUNT(*) AS n_rows,
         GROUP_CONCAT(ei.id ORDER BY ei.id SEPARATOR ',') AS ei_ids,
         i.codigo_unico, i.plaza, i.tradicional_digital
       FROM espacio_inventario ei
       LEFT JOIN inventarios i ON i.id=ei.inventario_id
       GROUP BY ei.inventario_id, ei.numero_espacio, i.codigo_unico, i.plaza, i.tradicional_digital
       HAVING COUNT(*) > 1
       ORDER BY n_rows DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({ ...r, n_rows: Number(r.n_rows) })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditEiDuplicado:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 16) MARCA-CLIENTES DUP — misma marca/producto con varios card_code
// =============================================================================
export const getAuditMarcaClientesDup = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT T2_U_Marca AS marca, T2_U_Producto AS producto,
         COUNT(*) AS n_clientes,
         GROUP_CONCAT(DISTINCT id ORDER BY id SEPARATOR ',') AS cliente_ids,
         GROUP_CONCAT(DISTINCT card_code SEPARATOR ' | ') AS card_codes,
         GROUP_CONCAT(DISTINCT T0_U_RazonSocial SEPARATOR ' | ') AS razones_sociales,
         GROUP_CONCAT(DISTINCT sap_database SEPARATOR ' | ') AS sap_dbs
       FROM cliente
       WHERE T2_U_Marca IS NOT NULL AND card_code IS NOT NULL AND card_code!=''
       GROUP BY T2_U_Marca, T2_U_Producto
       HAVING COUNT(*) > 1
       ORDER BY n_clientes DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({ ...r, n_clientes: Number(r.n_clientes) })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditMarcaClientesDup:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

// =============================================================================
// 17) POR VENDEDOR — agregados por asesor del cliente
// =============================================================================
export const getAuditPorVendedor = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) return res.status(403).json({ success: false, error: 'Acceso denegado' });
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT cl.T0_U_Asesor AS asesor,
         COUNT(*) AS total_reservas,
         COUNT(DISTINCT r.cliente_id) AS clientes_unicos,
         COUNT(DISTINCT sc.idquote) AS propuestas_unicas,
         COUNT(DISTINCT cm.id) AS campanias_unicas
       FROM reservas r
       LEFT JOIN cliente cl ON cl.id=r.cliente_id
       LEFT JOIN solicitudCaras sc ON sc.id=r.solicitudCaras_id
       LEFT JOIN cotizacion ct ON ct.id_propuesta=CAST(sc.idquote AS UNSIGNED)
       LEFT JOIN campania cm ON cm.cotizacion_id=ct.id
       WHERE r.deleted_at IS NULL AND cl.T0_U_Asesor IS NOT NULL AND cl.T0_U_Asesor!=''
       GROUP BY cl.T0_U_Asesor
       ORDER BY total_reservas DESC LIMIT ${limit}`
    );
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        asesor: r.asesor,
        total_reservas: Number(r.total_reservas),
        clientes_unicos: Number(r.clientes_unicos),
        propuestas_unicas: Number(r.propuestas_unicas),
        campanias_unicas: Number(r.campanias_unicas),
      })),
      total: rows.length,
    });
  } catch (error) {
    console.error('Error en getAuditPorVendedor:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};
