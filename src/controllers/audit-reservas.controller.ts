import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

// Endpoints SOLO-LECTURA para que el equipo DEV audite la consistencia de las
// reservas en la BD de QEB. Inspirado en el reporte HTML del jefe que cruza
// ODMs contra Inventario Consolidado externo — aquí solo lo que podemos
// detectar desde QEB sin necesidad del Excel. Todos los queries son SELECT.

function isDev(req: AuthRequest): boolean {
  return req.user?.rol === 'DEV';
}

// 1) Resumen — KPIs principales
export const getAuditSummary = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      return res.status(403).json({ success: false, error: 'Acceso denegado' });
    }

    const [totalRow, duplicadasRow, huerfanasRow, sinInventarioRow, clientesDupRow, catorcenasRow] = await Promise.all([
      prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM reservas WHERE deleted_at IS NULL`
      ),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM reservas r
         INNER JOIN calendario cal ON cal.id = r.calendario_id
         WHERE r.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM reservas r2
           INNER JOIN calendario cal2 ON cal2.id = r2.calendario_id
           WHERE r2.deleted_at IS NULL
             AND r2.id <> r.id
             AND r2.inventario_id = r.inventario_id
             AND cal2.fecha_inicio = cal.fecha_inicio
             AND cal2.fecha_fin = cal.fecha_fin
         )`
      ),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM reservas r
         LEFT JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
         LEFT JOIN propuesta p ON p.id = CAST(sc.idquote AS UNSIGNED)
         WHERE r.deleted_at IS NULL
         AND (sc.id IS NULL OR p.id IS NULL OR p.deleted_at IS NOT NULL)`
      ),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM reservas r
         LEFT JOIN inventarios i ON i.id = r.inventario_id
         WHERE r.deleted_at IS NULL AND i.id IS NULL`
      ),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM (
           SELECT r.inventario_id, cal.fecha_inicio, cal.fecha_fin
           FROM reservas r
           INNER JOIN calendario cal ON cal.id = r.calendario_id
           WHERE r.deleted_at IS NULL
           GROUP BY r.inventario_id, cal.fecha_inicio, cal.fecha_fin
           HAVING COUNT(DISTINCT r.cliente_id) > 1
         ) x`
      ),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(DISTINCT cal.fecha_inicio) AS n FROM reservas r
         INNER JOIN calendario cal ON cal.id = r.calendario_id
         WHERE r.deleted_at IS NULL`
      ),
    ]);

    res.json({
      success: true,
      data: {
        total_reservas: Number(totalRow[0]?.n || 0),
        reservas_en_duplicado: Number(duplicadasRow[0]?.n || 0),
        reservas_huerfanas: Number(huerfanasRow[0]?.n || 0),
        reservas_sin_inventario: Number(sinInventarioRow[0]?.n || 0),
        grupos_con_clientes_distintos: Number(clientesDupRow[0]?.n || 0),
        catorcenas_activas: Number(catorcenasRow[0]?.n || 0),
      },
    });
  } catch (error) {
    console.error('Error en getAuditSummary:', error);
    res.status(500).json({ success: false, error: 'Error interno al calcular resumen' });
  }
};

// 2) Duplicados (grupos)
// Detecta combos (inventario_id, periodo) con varias reservas activas.
// Clase:
//   ENTRE_CLIENTES = > 1 cliente_id distinto
//   MISMO_CLIENTE_CAMP = mismo cliente_id, > 1 propuesta_id
//   FILA_REPETIDA = mismo cliente + propuesta (literalmente duplicado)
export const getAuditDuplicados = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      return res.status(403).json({ success: false, error: 'Acceso denegado' });
    }
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    type Row = {
      inventario_id: number;
      codigo_unico: string | null;
      tipo_de_cara: string | null;
      plaza: string | null;
      fecha_inicio: Date;
      fecha_fin: Date;
      veces: bigint;
      clientes_distintos: bigint;
      propuestas_distintas: bigint;
      clientes: string | null;
      propuesta_ids: string | null;
      campania_ids: string | null;
      articulos: string | null;
    };

    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT
         r.inventario_id,
         i.codigo_unico,
         i.tipo_de_cara,
         i.plaza,
         cal.fecha_inicio,
         cal.fecha_fin,
         COUNT(*) AS veces,
         COUNT(DISTINCT r.cliente_id) AS clientes_distintos,
         COUNT(DISTINCT sc.idquote) AS propuestas_distintas,
         GROUP_CONCAT(DISTINCT COALESCE(cl.T0_U_RazonSocial, CONCAT('cliente_id=', r.cliente_id)) SEPARATOR ' | ') AS clientes,
         GROUP_CONCAT(DISTINCT sc.idquote SEPARATOR ',') AS propuesta_ids,
         GROUP_CONCAT(DISTINCT cm.id SEPARATOR ',') AS campania_ids,
         GROUP_CONCAT(DISTINCT sc.articulo SEPARATOR ',') AS articulos
       FROM reservas r
       INNER JOIN inventarios i ON i.id = r.inventario_id
       INNER JOIN calendario cal ON cal.id = r.calendario_id
       LEFT JOIN cliente cl ON cl.id = r.cliente_id
       LEFT JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
       LEFT JOIN cotizacion ct ON ct.id_propuesta = CAST(sc.idquote AS UNSIGNED)
       LEFT JOIN campania cm ON cm.cotizacion_id = ct.id
       WHERE r.deleted_at IS NULL
       GROUP BY r.inventario_id, i.codigo_unico, i.tipo_de_cara, i.plaza, cal.fecha_inicio, cal.fecha_fin
       HAVING COUNT(*) > 1
       ORDER BY clientes_distintos DESC, veces DESC
       LIMIT ${limit}`
    );

    const data = rows.map(r => {
      const veces = Number(r.veces);
      const clientesDistintos = Number(r.clientes_distintos);
      const propuestasDistintas = Number(r.propuestas_distintas);
      let clase: 'ENTRE_CLIENTES' | 'MISMO_CLIENTE_CAMP' | 'FILA_REPETIDA';
      if (clientesDistintos > 1) clase = 'ENTRE_CLIENTES';
      else if (propuestasDistintas > 1) clase = 'MISMO_CLIENTE_CAMP';
      else clase = 'FILA_REPETIDA';
      return {
        inventario_id: r.inventario_id,
        codigo_unico: r.codigo_unico,
        tipo_de_cara: r.tipo_de_cara,
        plaza: r.plaza,
        fecha_inicio: r.fecha_inicio,
        fecha_fin: r.fecha_fin,
        veces,
        clientes_distintos: clientesDistintos,
        propuestas_distintas: propuestasDistintas,
        clase,
        clientes: r.clientes,
        propuesta_ids: r.propuesta_ids,
        campania_ids: r.campania_ids,
        articulos: r.articulos,
      };
    });

    res.json({ success: true, data, total: data.length });
  } catch (error) {
    console.error('Error en getAuditDuplicados:', error);
    res.status(500).json({ success: false, error: 'Error interno al calcular duplicados' });
  }
};

// 3) Huérfanos — reservas activas cuya propuesta/solicitudCaras ya no existe
export const getAuditHuerfanos = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      return res.status(403).json({ success: false, error: 'Acceso denegado' });
    }
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    type Row = {
      reserva_id: number;
      inventario_id: number;
      codigo_unico: string | null;
      plaza: string | null;
      cliente_id: number;
      cliente_nombre: string | null;
      solicitudCaras_id: number;
      sc_id: number | null;
      propuesta_id_text: string | null;
      propuesta_id_resolved: number | null;
      propuesta_status: string | null;
      propuesta_deleted: Date | null;
      fecha_inicio: Date | null;
      fecha_fin: Date | null;
      motivo: string;
    };

    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT
         r.id AS reserva_id,
         r.inventario_id,
         i.codigo_unico,
         i.plaza,
         r.cliente_id,
         cl.T0_U_RazonSocial AS cliente_nombre,
         r.solicitudCaras_id,
         sc.id AS sc_id,
         sc.idquote AS propuesta_id_text,
         p.id AS propuesta_id_resolved,
         p.status AS propuesta_status,
         p.deleted_at AS propuesta_deleted,
         cal.fecha_inicio,
         cal.fecha_fin,
         CASE
           WHEN sc.id IS NULL THEN 'solicitudCaras eliminada'
           WHEN p.id IS NULL THEN 'propuesta inexistente'
           WHEN p.deleted_at IS NOT NULL THEN 'propuesta eliminada'
           ELSE 'otro'
         END AS motivo
       FROM reservas r
       LEFT JOIN inventarios i ON i.id = r.inventario_id
       LEFT JOIN cliente cl ON cl.id = r.cliente_id
       LEFT JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
       LEFT JOIN propuesta p ON p.id = CAST(sc.idquote AS UNSIGNED)
       LEFT JOIN calendario cal ON cal.id = r.calendario_id
       WHERE r.deleted_at IS NULL
         AND (sc.id IS NULL OR p.id IS NULL OR p.deleted_at IS NOT NULL)
       ORDER BY r.id DESC
       LIMIT ${limit}`
    );

    res.json({ success: true, data: rows, total: rows.length });
  } catch (error) {
    console.error('Error en getAuditHuerfanos:', error);
    res.status(500).json({ success: false, error: 'Error interno al calcular huerfanos' });
  }
};

// 4) Por catorcena — agregados
export const getAuditPorCatorcena = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      return res.status(403).json({ success: false, error: 'Acceso denegado' });
    }

    type Row = {
      fecha_inicio: Date;
      fecha_fin: Date;
      total_reservas: bigint;
      inventarios_unicos: bigint;
      clientes_unicos: bigint;
      propuestas_unicas: bigint;
      grupos_duplicados: bigint;
    };

    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT
         cal.fecha_inicio,
         cal.fecha_fin,
         COUNT(*) AS total_reservas,
         COUNT(DISTINCT r.inventario_id) AS inventarios_unicos,
         COUNT(DISTINCT r.cliente_id) AS clientes_unicos,
         COUNT(DISTINCT sc.idquote) AS propuestas_unicas,
         (
           SELECT COUNT(*) FROM (
             SELECT r2.inventario_id
             FROM reservas r2
             INNER JOIN calendario cal2 ON cal2.id = r2.calendario_id
             WHERE r2.deleted_at IS NULL
               AND cal2.fecha_inicio = cal.fecha_inicio
               AND cal2.fecha_fin = cal.fecha_fin
             GROUP BY r2.inventario_id
             HAVING COUNT(*) > 1
           ) g
         ) AS grupos_duplicados
       FROM reservas r
       INNER JOIN calendario cal ON cal.id = r.calendario_id
       LEFT JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
       WHERE r.deleted_at IS NULL
       GROUP BY cal.fecha_inicio, cal.fecha_fin
       ORDER BY cal.fecha_inicio DESC
       LIMIT 500`
    );

    const data = rows.map(r => ({
      fecha_inicio: r.fecha_inicio,
      fecha_fin: r.fecha_fin,
      total_reservas: Number(r.total_reservas),
      inventarios_unicos: Number(r.inventarios_unicos),
      clientes_unicos: Number(r.clientes_unicos),
      propuestas_unicas: Number(r.propuestas_unicas),
      grupos_duplicados: Number(r.grupos_duplicados),
    }));

    res.json({ success: true, data, total: data.length });
  } catch (error) {
    console.error('Error en getAuditPorCatorcena:', error);
    res.status(500).json({ success: false, error: 'Error interno al agrupar por catorcena' });
  }
};

// 5) Por cliente — agregados
export const getAuditPorCliente = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      return res.status(403).json({ success: false, error: 'Acceso denegado' });
    }
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    type Row = {
      cliente_id: number;
      razon_social: string | null;
      marca: string | null;
      asesor: string | null;
      total_reservas: bigint;
      inventarios_unicos: bigint;
      propuestas_unicas: bigint;
      campanias_unicas: bigint;
    };

    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT
         r.cliente_id,
         cl.T0_U_RazonSocial AS razon_social,
         cl.T2_U_Marca AS marca,
         cl.T0_U_Asesor AS asesor,
         COUNT(*) AS total_reservas,
         COUNT(DISTINCT r.inventario_id) AS inventarios_unicos,
         COUNT(DISTINCT sc.idquote) AS propuestas_unicas,
         COUNT(DISTINCT cm.id) AS campanias_unicas
       FROM reservas r
       LEFT JOIN cliente cl ON cl.id = r.cliente_id
       LEFT JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
       LEFT JOIN cotizacion ct ON ct.id_propuesta = CAST(sc.idquote AS UNSIGNED)
       LEFT JOIN campania cm ON cm.cotizacion_id = ct.id
       WHERE r.deleted_at IS NULL
       GROUP BY r.cliente_id, cl.T0_U_RazonSocial, cl.T2_U_Marca, cl.T0_U_Asesor
       ORDER BY total_reservas DESC
       LIMIT ${limit}`
    );

    const data = rows.map(r => ({
      cliente_id: r.cliente_id,
      razon_social: r.razon_social,
      marca: r.marca,
      asesor: r.asesor,
      total_reservas: Number(r.total_reservas),
      inventarios_unicos: Number(r.inventarios_unicos),
      propuestas_unicas: Number(r.propuestas_unicas),
      campanias_unicas: Number(r.campanias_unicas),
    }));

    res.json({ success: true, data, total: data.length });
  } catch (error) {
    console.error('Error en getAuditPorCliente:', error);
    res.status(500).json({ success: false, error: 'Error interno al agrupar por cliente' });
  }
};
