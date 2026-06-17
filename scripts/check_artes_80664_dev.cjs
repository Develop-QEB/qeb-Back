require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const cid = 80664;

  const trad = await prisma.$queryRawUnsafe(`
    SELECT at.archivo, COUNT(*) as c
    FROM artes_tradicionales at
    JOIN reservas r ON r.id = at.id_reserva
    JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
    JOIN cotizacion ct ON CAST(ct.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci = sc.idquote
    JOIN campania cm ON cm.cotizacion_id = ct.id
    WHERE cm.id = ?
    GROUP BY at.archivo
  `, cid);
  console.log(`artes_tradicionales en campaña ${cid} (dev):`, trad.length);
  trad.forEach(t => console.log(`  ${Number(t.c)} reservas | ${t.archivo.slice(0, 80)}`));

  const dig = await prisma.$queryRawUnsafe(`
    SELECT imd.archivo, COUNT(*) as c
    FROM imagenes_digitales imd
    JOIN reservas r ON r.id = imd.id_reserva
    JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
    JOIN cotizacion ct ON sc.idquote = ct.id_propuesta
    JOIN campania cm ON cm.cotizacion_id = ct.id
    WHERE cm.id = ?
    GROUP BY imd.archivo
  `, cid);
  console.log(`\nimagenes_digitales en campaña ${cid} (dev):`, dig.length);
  dig.forEach(d => console.log(`  ${Number(d.c)} reservas | ${d.archivo.slice(0, 80)}`));

  const rsv = await prisma.$queryRawUnsafe(`
    SELECT r.archivo, COUNT(*) as c
    FROM reservas r
    JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
    JOIN cotizacion ct ON CAST(ct.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci = sc.idquote
    JOIN campania cm ON cm.cotizacion_id = ct.id
    WHERE cm.id = ? AND r.archivo IS NOT NULL AND r.archivo != '' AND r.deleted_at IS NULL
    GROUP BY r.archivo
    LIMIT 10
  `, cid);
  console.log(`\nreservas con archivo en campaña ${cid} (dev):`, rsv.length);
  rsv.forEach(r => console.log(`  ${Number(r.c)} reservas | ${r.archivo.slice(0, 80)}`));

  const biblio = await prisma.$queryRawUnsafe('SELECT COUNT(*) as c FROM biblioteca_artes WHERE campania_id = ?', cid);
  console.log(`\nbiblioteca_artes en campaña ${cid} (dev):`, Number(biblio[0].c));

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
