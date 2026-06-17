// Llama el endpoint getArtesExistentes con la lógica idéntica del back para ver
// qué devuelve. Sin pasar por HTTP.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const id = 80664;
  const query = `
    SELECT
      url,
      MIN(nombre) as nombre,
      SUM(uso_count) as uso_count,
      MAX(nombre_arte) as nombre_arte,
      MAX(nota) as nota,
      MAX(estatus_operaciones) as estatus_operaciones,
      MAX(estatus) as estatus,
      MAX(tiene_instalado) as tiene_instalado
    FROM (
      SELECT
        r.archivo as url,
        SUBSTRING_INDEX(r.archivo, '/', -1) as nombre,
        COUNT(DISTINCT r.id) as uso_count,
        NULL as nombre_arte,
        NULL as nota,
        NULL as estatus_operaciones,
        MAX(r.arte_aprobado) as estatus,
        MAX(CASE
          WHEN r.instalado = 1 THEN 1
          WHEN tr.tipo = 'Instalación' AND tr.estatus IN ('Atendido','Completado') THEN 1
          ELSE 0
        END) as tiene_instalado
      FROM reservas r
      JOIN solicitudCaras sc ON r.solicitudCaras_id = sc.id
      JOIN cotizacion ct ON sc.idquote = CAST(ct.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
      JOIN campania cm ON cm.cotizacion_id = ct.id
      LEFT JOIN tareas tr ON tr.campania_id = cm.id
        AND tr.tipo = 'Instalación'
        AND FIND_IN_SET(r.id, REPLACE(tr.ids_reservas, ' ', '')) > 0
      WHERE cm.id = ?
        AND r.archivo IS NOT NULL
        AND r.archivo != ''
        AND r.deleted_at IS NULL
      GROUP BY r.archivo
      UNION ALL
      SELECT
        at2.archivo as url,
        SUBSTRING_INDEX(at2.archivo, '/', -1) as nombre,
        COUNT(DISTINCT at2.id) as uso_count,
        MAX(at2.nombre_arte) as nombre_arte,
        MAX(at2.nota) as nota,
        MAX(at2.estatus_operaciones) as estatus_operaciones,
        MAX(r2.arte_aprobado) as estatus,
        MAX(CASE
          WHEN r2.instalado = 1 THEN 1
          WHEN tr2.tipo = 'Instalación' AND tr2.estatus IN ('Atendido','Completado') THEN 1
          ELSE 0
        END) as tiene_instalado
      FROM artes_tradicionales at2
      JOIN reservas r2 ON r2.id = at2.id_reserva
      JOIN solicitudCaras sc2 ON sc2.id = r2.solicitudCaras_id
      JOIN cotizacion ct2 ON sc2.idquote = ct2.id_propuesta
      JOIN campania cm2 ON cm2.cotizacion_id = ct2.id
      LEFT JOIN tareas tr2 ON tr2.campania_id = cm2.id
        AND tr2.tipo = 'Instalación'
        AND FIND_IN_SET(r2.id, REPLACE(tr2.ids_reservas, ' ', '')) > 0
      WHERE cm2.id = ?
      GROUP BY at2.archivo
      UNION ALL
      SELECT
        imd.archivo as url,
        SUBSTRING_INDEX(imd.archivo, '/', -1) as nombre,
        COUNT(DISTINCT imd.id) as uso_count,
        MAX(imd.nombre_arte) as nombre_arte,
        MAX(imd.comentario) as nota,
        MAX(imd.estatus_operaciones) as estatus_operaciones,
        MAX(r3.arte_aprobado) as estatus,
        MAX(CASE
          WHEN r3.instalado = 1 THEN 1
          WHEN tr3.tipo = 'Instalación' AND tr3.estatus IN ('Atendido','Completado') THEN 1
          ELSE 0
        END) as tiene_instalado
      FROM imagenes_digitales imd
      JOIN reservas r3 ON r3.id = imd.id_reserva
      JOIN solicitudCaras sc3 ON sc3.id = r3.solicitudCaras_id
      JOIN cotizacion ct3 ON sc3.idquote = ct3.id_propuesta
      JOIN campania cm3 ON cm3.cotizacion_id = ct3.id
      LEFT JOIN tareas tr3 ON tr3.campania_id = cm3.id
        AND tr3.tipo = 'Instalación'
        AND FIND_IN_SET(r3.id, REPLACE(tr3.ids_reservas, ' ', '')) > 0
      WHERE cm3.id = ?
      GROUP BY imd.archivo
      UNION ALL
      SELECT
        ba.archivo as url,
        SUBSTRING_INDEX(ba.archivo, '/', -1) as nombre,
        0 as uso_count,
        MAX(ba.nombre_arte) as nombre_arte,
        MAX(ba.nota) as nota,
        MAX(ba.estatus_operaciones) as estatus_operaciones,
        NULL as estatus,
        0 as tiene_instalado
      FROM biblioteca_artes ba
      WHERE ba.campania_id = ?
      GROUP BY ba.archivo
    ) combined
    GROUP BY url
    ORDER BY uso_count DESC
  `;
  try {
    const rows = await prisma.$queryRawUnsafe(query, id, id, id, id);
    console.log(`getArtesExistentes(${id}) → ${rows.length} artes:`);
    rows.forEach(r => console.log(`  uso=${Number(r.uso_count)} | ${r.url.slice(0, 70)}`));
  } catch (e) {
    console.error('ERROR endpoint:', e.message);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
