// Backfill biblioteca_artes desde artes_tradicionales + imagenes_digitales + reservas.archivo.
// Idempotente vía ON DUPLICATE KEY UPDATE.
//
// Usage:
//   node backfill_biblioteca_artes.cjs                # dry-run global (solo conteos)
//   node backfill_biblioteca_artes.cjs --campana 80664           # dry-run 1 campaña
//   node backfill_biblioteca_artes.cjs --campana 80664 --apply   # ejecuta para 80664
//   node backfill_biblioteca_artes.cjs --all --apply             # ejecuta para todas (chunked)
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const all = args.includes('--all');
  const campIdx = args.indexOf('--campana');
  const targetCampana = campIdx >= 0 ? parseInt(args[campIdx + 1]) : null;

  if (!targetCampana && !all) {
    const summary = await prisma.$queryRawUnsafe(`
      SELECT
        (SELECT COUNT(*) FROM artes_tradicionales) as trad,
        (SELECT COUNT(*) FROM imagenes_digitales) as dig,
        (SELECT COUNT(*) FROM reservas WHERE archivo IS NOT NULL AND archivo != '' AND deleted_at IS NULL) as rsv,
        (SELECT COUNT(*) FROM biblioteca_artes) as biblio
    `);
    console.log('Estado actual:', summary[0]);
    console.log('\nUsage: --campana <id> [--apply]  ó  --all --apply');
    await prisma.$disconnect();
    return;
  }

  // Lista de campañas a procesar
  let campanas;
  if (targetCampana) {
    campanas = [{ id: targetCampana }];
  } else {
    campanas = await prisma.$queryRawUnsafe('SELECT id FROM campania ORDER BY id');
    console.log(`Procesando ${campanas.length} campañas...`);
  }

  let totalRows = 0;
  for (const c of campanas) {
    const cid = c.id;
    // Tradicionales por campaña
    const trad = await prisma.$queryRawUnsafe(`
      SELECT
        at.archivo,
        MAX(at.nombre_arte) as nombre_arte,
        MAX(at.nota) as nota,
        MAX(at.estatus_operaciones) as estatus_operaciones
      FROM artes_tradicionales at
      JOIN reservas r ON r.id = at.id_reserva
      JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
      JOIN cotizacion ct ON sc.idquote = CAST(ct.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
      JOIN campania cm ON cm.cotizacion_id = ct.id
      WHERE cm.id = ?
      GROUP BY at.archivo
    `, cid);
    const dig = await prisma.$queryRawUnsafe(`
      SELECT
        imd.archivo,
        MAX(imd.nombre_arte) as nombre_arte,
        MAX(imd.comentario) as nota,
        MAX(imd.estatus_operaciones) as estatus_operaciones
      FROM imagenes_digitales imd
      JOIN reservas r ON r.id = imd.id_reserva
      JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
      JOIN cotizacion ct ON sc.idquote = ct.id_propuesta
      JOIN campania cm ON cm.cotizacion_id = ct.id
      WHERE cm.id = ?
      GROUP BY imd.archivo
    `, cid);
    const rsv = await prisma.$queryRawUnsafe(`
      SELECT r.archivo
      FROM reservas r
      JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
      JOIN cotizacion ct ON sc.idquote = CAST(ct.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
      JOIN campania cm ON cm.cotizacion_id = ct.id
      WHERE cm.id = ? AND r.archivo IS NOT NULL AND r.archivo != '' AND r.deleted_at IS NULL
      GROUP BY r.archivo
    `, cid);

    if (trad.length + dig.length + rsv.length === 0) continue;
    console.log(`Campaña ${cid}: tradicional=${trad.length} digital=${dig.length} reservas=${rsv.length}`);
    totalRows += trad.length + dig.length + rsv.length;

    if (!apply) continue;
    for (const t of trad) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO biblioteca_artes (campania_id, archivo, tipo, nombre_arte, nota, estatus_operaciones)
        VALUES (?, ?, 'tradicional', ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          nombre_arte = COALESCE(VALUES(nombre_arte), nombre_arte),
          nota = COALESCE(VALUES(nota), nota),
          estatus_operaciones = COALESCE(VALUES(estatus_operaciones), estatus_operaciones)
      `, cid, t.archivo, t.nombre_arte, t.nota, t.estatus_operaciones);
    }
    for (const d of dig) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO biblioteca_artes (campania_id, archivo, tipo, nombre_arte, nota, estatus_operaciones)
        VALUES (?, ?, 'digital', ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          nombre_arte = COALESCE(VALUES(nombre_arte), nombre_arte),
          nota = COALESCE(VALUES(nota), nota),
          estatus_operaciones = COALESCE(VALUES(estatus_operaciones), estatus_operaciones)
      `, cid, d.archivo, d.nombre_arte, d.nota, d.estatus_operaciones);
    }
    for (const r of rsv) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO biblioteca_artes (campania_id, archivo, tipo)
        VALUES (?, ?, 'tradicional')
        ON DUPLICATE KEY UPDATE updated_at = NOW()
      `, cid, r.archivo);
    }
  }

  console.log(`\nTotal (archivos, campañas combinadas): ${totalRows}`);
  if (apply) {
    const tot = await prisma.$queryRawUnsafe('SELECT COUNT(*) as c FROM biblioteca_artes');
    console.log(`biblioteca_artes ahora tiene ${Number(tot[0].c)} filas.`);
  } else {
    console.log('(dry-run, no se modificó la BD)');
  }

  await prisma.$disconnect();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
