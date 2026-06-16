require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const r = await prisma.$queryRawUnsafe(`
    SELECT cm.id, cm.nombre, COUNT(DISTINCT rsv.id) as reservas_trad
    FROM campania cm
    JOIN cotizacion ct ON ct.id = cm.cotizacion_id
    JOIN solicitudCaras sc ON sc.idquote = CAST(ct.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
    JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id AND rsv.deleted_at IS NULL
    JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
    JOIN inventarios inv ON inv.id = ei.inventario_id
    WHERE LOWER(inv.tradicional_digital) = 'tradicional'
      AND cm.status NOT IN ('Cancelada', 'Rechazada', 'finalizada')
    GROUP BY cm.id, cm.nombre
    HAVING reservas_trad > 5
    ORDER BY cm.id DESC
    LIMIT 5
  `);
  console.log('Campañas activas con inventario tradicional (dev):');
  r.forEach(c => console.log(`  id=${c.id} | ${c.nombre} | ${Number(c.reservas_trad)} reservas`));
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
